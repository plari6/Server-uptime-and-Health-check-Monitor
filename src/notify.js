// Alert formatting and delivery: Telegram (HTML + inline buttons), Slack, signed JSON webhook.
// A failing channel never blocks the others.
import axios from 'axios';
import crypto from 'node:crypto';
import { escapeHtml as h, fmtDuration, fmtLatency, fmtTime, sleep } from './util.js';

const ICON = { DOWN: '🔴', RECOVERED: '✅', DEGRADED: '🟡', PERF_RECOVERED: '🟢', STILL_DOWN: '🔴', ESCALATE: '🚨', SSL_EXPIRING: '🔐', NETWORK_RESTORED: '📡', INFO: 'ℹ️' };

function target(m) {
  return m.type === 'tcp' ? `${m.host}:${m.port} (TCP)` : `${m.method !== 'GET' ? `${m.method} ` : ''}${m.url.replace(/\$\{[A-Z0-9_]+\}/gi, '***')}`;
}

/** Telegram HTML text for one event. */
export function formatEventHtml(e, tz) {
  const m = e.monitor;
  const name = `<b>${h(m?.name ?? 'Uptime monitor')}</b>`;
  const owner = m?.owner ? `\nOwner: ${h(m.owner)}` : '';
  const inc = e.incidentId ? `Incident #${e.incidentId}` : '';
  switch (e.type) {
    case 'DOWN':
      return `${ICON.DOWN} <b>DOWN</b> — ${name}\n<code>${h(target(m))}</code>\nCause: ${h(e.cause)}\nSince: ${h(fmtTime(e.since, tz))}\n${inc} · checked every ${m.interval}s${owner}`;
    case 'RECOVERED':
      return `${ICON.RECOVERED} <b>RECOVERED</b> — ${name}\nWas down for <b>${h(fmtDuration(e.downtimeMs))}</b> (since ${h(fmtTime(e.since, tz))})\nNow: ${e.code ? `HTTP ${e.code} in ` : ''}${h(fmtLatency(e.latencyMs))}${inc ? `\n${inc} closed` : ''}`;
    case 'DEGRADED':
      return `${ICON.DEGRADED} <b>SLOW</b> — ${name}\nResponse time ${h(fmtLatency(e.latencyMs))} (limit ${h(fmtLatency(e.limitMs))}) for ${e.streak} checks in a row\n<code>${h(target(m))}</code>${owner}`;
    case 'PERF_RECOVERED':
      return `${ICON.PERF_RECOVERED} <b>Speed back to normal</b> — ${name}\nResponse time ${h(fmtLatency(e.latencyMs))}`;
    case 'STILL_DOWN':
      return `${ICON.STILL_DOWN} <b>STILL DOWN</b> — ${name} for ${h(fmtDuration(e.downtimeMs))}\nCause: ${h(e.cause)}\n${inc} is not acknowledged yet${owner}`;
    case 'ESCALATE':
      return `${ICON.ESCALATE} <b>ESCALATION</b> — ${name} down for ${h(fmtDuration(e.downtimeMs))} and nobody acknowledged it\nCause: ${h(e.cause)}\n<code>${h(target(m))}</code>\n${inc}${owner}`;
    case 'SSL_EXPIRING': {
      const c = e.cert;
      const when = c.daysLeft < 0 ? `<b>EXPIRED</b> ${-c.daysLeft} days ago` : c.daysLeft === 0 ? '<b>expires TODAY</b>' : `expires in <b>${c.daysLeft} days</b>`;
      return `${ICON.SSL_EXPIRING} <b>SSL certificate</b> — ${name}\n${h(c.subject)} ${when} (${h(fmtTime(c.validTo, tz).slice(0, 10))})\nIssuer: ${h(c.issuer)}${owner}`;
    }
    case 'NETWORK_RESTORED':
      return `${ICON.NETWORK_RESTORED} <b>Monitor connectivity restored</b>\nThe monitoring host itself had no internet for ${h(fmtDuration(e.downtimeMs))}. Checks were paused instead of sending false alerts.`;
    default:
      return `${ICON.INFO} ${h(e.text ?? e.type)}`;
  }
}

/** Plain text version (Slack, logs, demo). */
export function formatEventText(e, tz) {
  return formatEventHtml(e, tz)
    .replace(/<\/?(b|code|i)>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** JSON payload for webhooks / n8n / Make. */
export function eventPayload(e) {
  const m = e.monitor;
  return {
    type: e.type,
    at: new Date(e.at ?? Date.now()).toISOString(),
    monitor: m ? { id: m.id, name: m.name, type: m.type, target: target(m), tags: m.tags, owner: m.owner ?? null } : null,
    incident_id: e.incidentId ?? null,
    cause: e.cause ?? null,
    http_status: e.code ?? null,
    latency_ms: e.latencyMs ?? null,
    downtime_ms: e.downtimeMs ?? null,
    since: e.since ? new Date(e.since).toISOString() : null,
    cert: e.cert ? { days_left: e.cert.daysLeft, valid_to: new Date(e.cert.validTo).toISOString(), issuer: e.cert.issuer } : null,
    text: e.text ?? null,
  };
}

function telegramButtons(e) {
  if ((e.type === 'DOWN' || e.type === 'STILL_DOWN' || e.type === 'ESCALATE') && e.incidentId) {
    return { inline_keyboard: [[
      { text: '✅ Acknowledge', callback_data: `ack:${e.incidentId}` },
      { text: '🔕 Mute 1h', callback_data: `mute:${e.monitor.id}:60` },
    ]] };
  }
  return undefined;
}

export function createTelegramApi({ token, apiBase = 'https://api.telegram.org', client = axios }) {
  const base = `${apiBase}/bot${token}`;
  async function call(method, body, { timeout = 15000, retry = true } = {}) {
    try {
      const res = await client.post(`${base}/${method}`, body, { timeout, validateStatus: () => true, proxy: false });
      if (res.data?.ok) return res.data.result;
      const retryAfter = res.data?.parameters?.retry_after;
      if (res.status === 429 && retry && retryAfter) {
        await sleep(Math.min(retryAfter, 30) * 1000);
        return call(method, body, { timeout, retry: false });
      }
      const err = new Error(`Telegram ${method}: ${res.data?.description || `HTTP ${res.status}`}`);
      err.status = res.status;
      throw err;
    } catch (err) {
      if (err.status || !retry) throw err;
      await sleep(2000); // network blip: one retry
      return call(method, body, { timeout, retry: false });
    }
  }
  return {
    call,
    sendMessage: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
  };
}

export function createNotifier(settings, { client = axios, store = null, log = console, now = () => Date.now() } = {}) {
  const tz = settings.timezone;
  const channels = [];
  const tg = settings.telegram;

  if (tg?.token && tg.chatIds.length) {
    const api = createTelegramApi({ token: tg.token, apiBase: tg.apiBase, client });
    channels.push({
      name: 'telegram',
      api,
      async send(events) {
        // group by destination chat; >3 events for one chat in one round become one digest
        const perChat = new Map();
        for (const e of events) {
          const own = e.monitor?.telegramChatIds?.length ? e.monitor.telegramChatIds : tg.chatIds;
          const chats = new Set(own);
          if (e.type === 'ESCALATE') for (const c of tg.escalationChatIds) chats.add(c);
          for (const c of chats) { if (!perChat.has(c)) perChat.set(c, []); perChat.get(c).push(e); }
        }
        const errors = [];
        for (const [chat, list] of perChat) {
          try {
            if (list.length > 3) {
              const down = list.filter((e) => e.type === 'DOWN').length;
              const head = `<b>${list.length} monitor updates</b>${down ? ` · ${ICON.DOWN} ${down} DOWN` : ''}\n\n`;
              const body = list.map((e) => formatEventHtml(e, tz)).join('\n\n— — —\n\n');
              for (const part of chunk(head + body, 4000)) await api.sendMessage(chat, part);
            } else {
              for (const e of list) await api.sendMessage(chat, formatEventHtml(e, tz), { reply_markup: telegramButtons(e) });
            }
          } catch (err) { errors.push(`chat ${chat}: ${err.message}`); }
        }
        if (errors.length) throw new Error(errors.join('; '));
      },
      async sendText(html) { for (const c of tg.chatIds) await api.sendMessage(c, html); },
    });
  }

  if (settings.slackWebhookUrl) {
    channels.push({
      name: 'slack',
      async send(events) {
        const text = events.map((e) => formatEventText(e, tz)).join('\n\n');
        await client.post(settings.slackWebhookUrl, { text }, { timeout: 10000, proxy: false });
      },
      async sendText(html) { await client.post(settings.slackWebhookUrl, { text: formatEventText({ type: 'INFO', text: stripHtml(html) }, tz) }, { timeout: 10000, proxy: false }); },
    });
  }

  if (settings.webhookUrl) {
    const post = async (payload) => {
      const body = JSON.stringify(payload);
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'UptimeMonitor/1.0' };
      if (settings.webhookSecret) {
        const ts = Math.floor(now() / 1000);
        headers['X-Uptime-Timestamp'] = String(ts);
        headers['X-Uptime-Signature'] = `sha256=${crypto.createHmac('sha256', settings.webhookSecret).update(`${ts}.${body}`).digest('hex')}`;
      }
      await client.post(settings.webhookUrl, body, { headers, timeout: 10000, proxy: false });
    };
    channels.push({
      name: 'webhook',
      async send(events) { for (const e of events) await post(eventPayload(e)); },
      async sendText(html) { await post({ type: 'INFO', at: new Date(now()).toISOString(), text: stripHtml(html) }); },
    });
  }

  return {
    channels,
    get telegram() { return channels.find((c) => c.name === 'telegram')?.api ?? null; },
    async dispatch(events) {
      if (!events.length) return [];
      const results = await Promise.all(channels.map(async (ch) => {
        try {
          await ch.send(events);
          for (const e of events) store?.recordAlert(now(), e.monitor?.name, e.type, ch.name, true);
          return { channel: ch.name, ok: true };
        } catch (err) {
          log.error(`[notify] ${ch.name} failed: ${err.message}`);
          for (const e of events) store?.recordAlert(now(), e.monitor?.name, e.type, ch.name, false, err.message);
          return { channel: ch.name, ok: false, error: err.message };
        }
      }));
      return results;
    },
    async sendText(html) {
      return Promise.all(channels.map(async (ch) => {
        try { await ch.sendText(html); return { channel: ch.name, ok: true }; } catch (err) { log.error(`[notify] ${ch.name} failed: ${err.message}`); return { channel: ch.name, ok: false, error: err.message }; }
      }));
    },
  };
}

function stripHtml(s) { return String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }

function chunk(s, size) {
  const out = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}
