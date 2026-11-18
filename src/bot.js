// Telegram commands + inline buttons via long polling (no public URL needed).
// Only chats/users listed in TELEGRAM_CHAT_ID / TELEGRAM_ESCALATION_CHAT_ID / TELEGRAM_ADMIN_IDS are served.
import { escapeHtml as h, fmtDuration, fmtLatency, fmtTime, sleep } from './util.js';

export const HELP = [
  '<b>Uptime monitor commands</b>',
  '/status — all monitors',
  '/down — only failing monitors',
  '/incidents — recent incidents',
  '/uptime [hours] — uptime summary (default 24h)',
  '/check &lt;name&gt; — run a check now',
  '/ack &lt;incident# or name&gt; — acknowledge, stops reminders',
  '/mute &lt;name|all&gt; [minutes] — silence alerts (default 60)',
  '/unmute &lt;name|all&gt;',
].join('\n');

const ICON = { up: '🟢', down: '🔴', degraded: '🟡', unknown: '⚪' };

export function statusHtml(monitor, { onlyProblems = false } = {}) {
  const tz = monitor.settings.timezone;
  const rows = monitor.snapshot().filter((s) => !onlyProblems || s.status === 'down' || s.status === 'degraded');
  if (!rows.length) return onlyProblems ? '🟢 All monitors are up.' : 'No monitors configured.';
  const lines = rows.map((s) => {
    let line = `${ICON[s.status] || '⚪'} <b>${h(s.name)}</b> — ${s.status.toUpperCase()}`;
    if (s.status === 'down') line += ` for ${fmtDuration(monitor.now() - s.downSince)}\n    ${h(s.error || '')}${s.incidentId ? ` · #${s.incidentId}` : ''}${s.ackedBy ? ` · ack ${h(s.ackedBy)}` : ''}`;
    else if (s.latencyMs != null) line += ` · ${fmtLatency(s.latencyMs)}`;
    if (s.maintenance) line += ` · 🛠 ${h(s.maintenance)}`;
    if (s.mutedUntil) line += ` · 🔕 until ${h(fmtTime(s.mutedUntil, tz).slice(11, 16))}`;
    return line;
  });
  const down = rows.filter((r) => r.status === 'down').length;
  const head = onlyProblems ? '<b>Failing monitors</b>' : `<b>Status</b> · ${rows.length - down}/${rows.length} up`;
  const net = monitor.network.down ? '\n⚠️ Monitoring host has no internet — verdicts paused.' : '';
  return `${head}${net}\n\n${lines.join('\n')}`;
}

export function incidentsHtml(monitor, limit = 10) {
  const tz = monitor.settings.timezone;
  const list = monitor.store.listIncidents({ limit });
  if (!list.length) return 'No incidents recorded yet. 🎉';
  const name = (id) => monitor.monitors.find((m) => m.id === id)?.name || id;
  return `<b>Recent incidents</b>\n\n${list.map((i) => {
    const dur = (i.ended_at ?? monitor.now()) - i.started_at;
    const state = i.ended_at ? `resolved after ${fmtDuration(dur)}` : `🔴 OPEN ${fmtDuration(dur)}`;
    return `#${i.id} <b>${h(name(i.monitor))}</b> — ${state}\n    ${h(fmtTime(i.started_at, tz))} · ${h(i.cause || '')}${i.acked_by ? ` · ack ${h(i.acked_by)}` : ''}${i.maintenance ? ' · 🛠' : ''}`;
  }).join('\n')}`;
}

/** Handles one Telegram update. Returns the reply text (also sent) for tests. */
export async function handleUpdate(update, { monitor, api, allowed }) {
  const who = (u) => (u?.username ? `@${u.username}` : [u?.first_name, u?.last_name].filter(Boolean).join(' ') || `user ${u?.id}`);
  const isAllowed = (chatId, userId) => allowed.has(String(chatId)) || allowed.has(String(userId));

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    if (!isAllowed(chatId, cq.from?.id)) { await api.call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not authorized' }).catch(() => {}); return null; }
    const [action, a, b] = String(cq.data || '').split(':');
    let res;
    if (action === 'ack') res = monitor.ack(a, who(cq.from));
    else if (action === 'mute') res = monitor.mute(a, Number(b) || 60);
    else res = { ok: false, message: 'Unknown action' };
    await api.call('answerCallbackQuery', { callback_query_id: cq.id, text: res.message.slice(0, 190) }).catch(() => {});
    if (res.ok && cq.message) {
      await api.call('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await api.sendMessage(chatId, `${action === 'ack' ? '✅' : '🔕'} ${h(res.message)}`, { reply_to_message_id: cq.message.message_id }).catch(() => {});
    }
    return res.message;
  }

  const msg = update.message;
  if (!msg?.text || !msg.text.startsWith('/')) return null;
  if (!isAllowed(msg.chat.id, msg.from?.id)) return null; // silent: don't confirm the bot exists
  const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.slice(1).split('@')[0].toLowerCase();
  const arg = args.join(' ');
  let reply;
  switch (cmd) {
    case 'start': case 'help': reply = HELP; break;
    case 'status': reply = statusHtml(monitor); break;
    case 'down': reply = statusHtml(monitor, { onlyProblems: true }); break;
    case 'incidents': reply = incidentsHtml(monitor, Number(args[0]) || 10); break;
    case 'uptime': reply = monitor.summaryHtml(Math.min(Number(args[0]) || 24, 24 * 90)); break;
    case 'ack': reply = h(arg ? monitor.ack(arg, who(msg.from)).message : 'Usage: /ack <incident# or monitor name>'); break;
    case 'mute': {
      if (!args.length) { reply = 'Usage: /mute &lt;name|all&gt; [minutes]'; break; }
      const last = args[args.length - 1];
      const minutes = args.length > 1 && /^\d+$/.test(last) ? Number(last) : 60;
      const target = args.length > 1 && /^\d+$/.test(last) ? args.slice(0, -1).join(' ') : arg;
      reply = h(monitor.mute(target, Math.min(minutes, 7 * 24 * 60)).message);
      break;
    }
    case 'unmute': reply = h(arg ? monitor.unmute(arg).message : 'Usage: /unmute <name|all>'); break;
    case 'check': {
      if (!arg) { reply = 'Usage: /check &lt;monitor name&gt;'; break; }
      const r = await monitor.checkNow(arg);
      if (!r) reply = `Unknown monitor "${h(arg)}".`;
      else if (r.busy) reply = `${h(r.monitor.name)} is being checked right now.`;
      else reply = r.result.ok ? `🟢 <b>${h(r.monitor.name)}</b> OK — ${r.result.code ? `HTTP ${r.result.code}, ` : ''}${fmtLatency(r.result.latencyMs)}` : `🔴 <b>${h(r.monitor.name)}</b> FAILED — ${h(r.result.error)}`;
      break;
    }
    default: reply = `Unknown command. ${HELP}`;
  }
  await api.sendMessage(msg.chat.id, reply);
  return reply;
}

/** Long-polling loop. Returns { stop() }. */
export function startBot({ monitor, api, settings, log }) {
  const allowed = new Set([...settings.telegram.chatIds, ...settings.telegram.escalationChatIds, ...settings.telegram.adminIds].map(String));
  let running = true;
  let offset = 0;
  const loop = async () => {
    await api.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    await api.call('setMyCommands', { commands: [
      { command: 'status', description: 'All monitors' }, { command: 'down', description: 'Failing monitors' },
      { command: 'incidents', description: 'Recent incidents' }, { command: 'uptime', description: 'Uptime summary' },
      { command: 'check', description: 'Run a check now' }, { command: 'ack', description: 'Acknowledge an incident' },
      { command: 'mute', description: 'Mute alerts' }, { command: 'unmute', description: 'Unmute alerts' },
    ] }).catch(() => {});
    while (running) {
      try {
        const updates = await api.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { timeout: 35000, retry: false });
        for (const u of updates || []) {
          offset = u.update_id + 1;
          handleUpdate(u, { monitor, api, allowed }).catch((err) => log.warn(`[bot] ${err.message}`));
        }
      } catch (err) {
        if (!running) break;
        log.warn(`[bot] polling error: ${err.message}${err.status === 409 ? ' (another bot instance or webhook is using this token)' : ''}`);
        await sleep(err.status === 409 ? 30000 : 5000);
      }
    }
  };
  const done = loop();
  return { stop: () => { running = false; return Promise.race([done, sleep(1000)]); } };
}
