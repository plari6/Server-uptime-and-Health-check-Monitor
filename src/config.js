// Loads monitors.json + environment settings and validates them.
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { slugify, splitList } from './util.js';

export const MONITOR_DEFAULTS = Object.freeze({
  interval: 60,            // seconds between checks
  timeoutMs: 10000,        // per attempt
  retries: 1,              // immediate re-tries before a check counts as failed
  retryDelayMs: 3000,
  failThreshold: 1,        // failed checks in a row before DOWN is declared
  recoverThreshold: 1,     // good checks in a row before RECOVERED
  maxLatencyMs: 0,         // > 0: slower responses count as "slow"
  degradedAfter: 3,        // slow checks in a row before DEGRADED
  sslWarnDays: 14,         // warn when the TLS certificate expires within N days (0 = off)
  remindEveryMin: 30,      // repeat "still down" every N minutes until acknowledged (0 = off)
  escalateAfterMin: 15,    // escalate unacknowledged incidents after N minutes (0 = off)
  method: 'GET',
  expectStatus: '200-399',
  followRedirects: true,
  ignoreTls: false,
  public: true,            // show on the status page
});

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "200-299,301" | "2xx" | 200 | [200, "3xx"] -> [[lo, hi], ...] */
export function parseStatusSpec(spec) {
  const items = Array.isArray(spec) ? spec : String(spec).split(',');
  const ranges = [];
  for (const raw of items) {
    const s = String(raw).trim().toLowerCase();
    if (!s) continue;
    let m;
    if ((m = s.match(/^([1-5])xx$/))) ranges.push([+m[1] * 100, +m[1] * 100 + 99]);
    else if ((m = s.match(/^(\d{3})\s*-\s*(\d{3})$/))) ranges.push([+m[1], +m[2]]);
    else if (/^\d{3}$/.test(s)) ranges.push([+s, +s]);
    else throw new Error(`invalid expectStatus "${raw}"`);
  }
  if (!ranges.length) throw new Error('expectStatus is empty');
  return ranges;
}

export const statusMatches = (code, ranges) => ranges.some(([lo, hi]) => code >= lo && code <= hi);

function normalizeMonitor(raw, defaults, index, errors) {
  const where = `monitors[${index}]${raw?.name ? ` "${raw.name}"` : ''}`;
  if (!raw || typeof raw !== 'object') { errors.push(`${where}: must be an object`); return null; }
  const m = { ...MONITOR_DEFAULTS, ...defaults, ...raw };
  if (!m.name) { errors.push(`${where}: "name" is required`); return null; }
  m.name = String(m.name).trim();
  m.id = raw.id ? slugify(raw.id) : slugify(m.name);
  m.type = m.type || (m.url ? 'http' : m.port ? 'tcp' : 'http');
  m.tags = splitList(m.tags);

  if (m.type === 'http') {
    try {
      const u = new URL(m.url.replace(/\$\{[A-Z0-9_]+\}/gi, 'x'));
      if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
      m.host = m.host || u.hostname;
    } catch { errors.push(`${where}: "url" must be a valid http(s) URL`); }
    try { m.expectRanges = parseStatusSpec(m.expectStatus); } catch (e) { errors.push(`${where}: ${e.message}`); }
    m.method = String(m.method).toUpperCase();
    if (m.json) {
      m.json = (Array.isArray(m.json) ? m.json : [m.json]);
      if (m.json.some((r) => !r || typeof r.path !== 'string')) errors.push(`${where}: each "json" rule needs a "path"`);
    }
  } else if (m.type === 'tcp') {
    m.port = Number(m.port);
    if (!m.host) errors.push(`${where}: tcp monitor needs "host"`);
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) errors.push(`${where}: tcp monitor needs a valid "port"`);
    m.sslWarnDays = raw.sslWarnDays ?? 0; // TLS check only when asked for on raw TCP
  } else {
    errors.push(`${where}: unknown type "${m.type}" (use http or tcp)`);
  }

  for (const k of ['interval', 'timeoutMs', 'retries', 'retryDelayMs', 'failThreshold', 'recoverThreshold', 'maxLatencyMs', 'degradedAfter', 'sslWarnDays', 'remindEveryMin', 'escalateAfterMin']) {
    m[k] = Number(m[k]);
    if (!Number.isFinite(m[k]) || m[k] < 0) errors.push(`${where}: "${k}" must be a number >= 0`);
  }
  if (m.interval < 5) errors.push(`${where}: "interval" must be at least 5 seconds`);
  if (m.timeoutMs < 100) errors.push(`${where}: "timeoutMs" must be at least 100`);
  m.failThreshold = Math.max(1, m.failThreshold);
  m.recoverThreshold = Math.max(1, m.recoverThreshold);
  m.degradedAfter = Math.max(1, m.degradedAfter);
  if (m.sla != null) {
    m.sla = Number(m.sla);
    if (!(m.sla > 0 && m.sla <= 100)) errors.push(`${where}: "sla" must be a percentage like 99.9`);
  }
  m.telegramChatIds = splitList(m.telegramChatId ?? m.telegramChatIds);
  return m;
}

function normalizeWindow(w, i, errors) {
  const where = `maintenance[${i}]`;
  const out = { reason: w.reason || 'maintenance', monitors: splitList(w.monitors), tags: splitList(w.tags) };
  if (w.weekly) {
    const days = splitList(w.weekly.days ?? w.weekly.day).map((d) => d.toLowerCase().slice(0, 3));
    if (!days.length || days.some((d) => !DAYS.includes(d))) errors.push(`${where}: weekly.days must be like ["sun"]`);
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!re.test(w.weekly.from || '') || !re.test(w.weekly.to || '')) errors.push(`${where}: weekly.from/to must be "HH:MM"`);
    out.weekly = { days, from: w.weekly.from, to: w.weekly.to };
  } else {
    out.start = Date.parse(w.start);
    out.end = Date.parse(w.end);
    if (!Number.isFinite(out.start) || !Number.isFinite(out.end) || out.end <= out.start) errors.push(`${where}: needs ISO "start" before "end" (or "weekly")`);
  }
  return out;
}

export function normalizeConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { monitors: [], maintenance: [], errors: ['config must be a JSON object'] };
  const list = Array.isArray(raw) ? raw : raw.monitors;
  if (!Array.isArray(list) || !list.length) errors.push('"monitors" must be a non-empty array');
  const defaults = raw.defaults || {};
  const monitors = (list || []).map((m, i) => normalizeMonitor(m, defaults, i, errors)).filter(Boolean);
  const seen = new Set();
  for (const m of monitors) {
    if (seen.has(m.id)) errors.push(`duplicate monitor name/id "${m.name}"`);
    seen.add(m.id);
  }
  const maintenance = (raw.maintenance || []).map((w, i) => normalizeWindow(w, i, errors));
  return { monitors, maintenance, errors };
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new ConfigError([`config file not found: ${abs} (run "uptime-monitor init")`]);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new ConfigError([`${abs}: invalid JSON - ${e.message}`]); }
  const cfg = normalizeConfig(raw);
  if (cfg.errors.length) throw new ConfigError(cfg.errors);
  cfg.file = abs;
  cfg.mtimeMs = fs.statSync(abs).mtimeMs;
  return cfg;
}

export class ConfigError extends Error {
  constructor(errors) { super(`Invalid configuration:\n  - ${errors.join('\n  - ')}`); this.errors = errors; }
}

/** Local weekday + "HH:MM" in the given time zone. */
function localParts(ts, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { day: p.weekday.toLowerCase().slice(0, 3), hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

/** Returns the active maintenance window for a monitor, or null. */
export function activeMaintenance(monitor, windows, now, timeZone) {
  for (const w of windows || []) {
    const applies = (!w.monitors.length && !w.tags.length)
      || w.monitors.some((n) => n === monitor.name || n === monitor.id)
      || w.tags.some((t) => monitor.tags.includes(t));
    if (!applies) continue;
    if (w.weekly) {
      const { day, hm } = localParts(now, timeZone);
      const { from, to } = w.weekly;
      if (from <= to) { if (w.weekly.days.includes(day) && hm >= from && hm < to) return w; }
      else {
        // window over midnight, e.g. 23:00-01:00: the "from" day owns the evening part
        const prev = DAYS[(DAYS.indexOf(day) + 6) % 7];
        if ((w.weekly.days.includes(day) && hm >= from) || (w.weekly.days.includes(prev) && hm < to)) return w;
      }
    } else if (now >= w.start && now < w.end) return w;
  }
  return null;
}

/** Process-wide settings from environment variables. */
export function loadSettings(env = process.env) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const s = {
    dbFile: env.DB_FILE || 'data/uptime.db',
    tickCron: env.TICK_CRON || '*/5 * * * * *',
    concurrency: num(env.CONCURRENCY, 10),
    timezone: env.TIMEZONE || env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    retentionDays: num(env.RETENTION_DAYS, 90),
    canaryUrls: env.CANARY_URLS === undefined ? ['https://www.google.com/generate_204', 'https://1.1.1.1/'] : splitList(env.CANARY_URLS),
    heartbeatUrl: env.HEARTBEAT_URL || '',
    dailySummaryCron: env.DAILY_SUMMARY_CRON || '',
    statusTitle: env.STATUS_PAGE_TITLE || 'Service Status',
    statusToken: env.STATUS_API_TOKEN || '',
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN || '',
      chatIds: splitList(env.TELEGRAM_CHAT_ID),
      escalationChatIds: splitList(env.TELEGRAM_ESCALATION_CHAT_ID),
      adminIds: splitList(env.TELEGRAM_ADMIN_IDS),
      apiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
      commands: env.TELEGRAM_COMMANDS !== 'false',
    },
    slackWebhookUrl: env.SLACK_WEBHOOK_URL || '',
    webhookUrl: env.ALERT_WEBHOOK_URL || '',
    webhookSecret: env.ALERT_WEBHOOK_SECRET || '',
  };
  const errors = [];
  if (!cron.validate(s.tickCron)) errors.push(`TICK_CRON "${s.tickCron}" is not a valid cron expression`);
  if (s.dailySummaryCron && !cron.validate(s.dailySummaryCron)) errors.push(`DAILY_SUMMARY_CRON "${s.dailySummaryCron}" is not valid`);
  if (!(s.concurrency >= 1)) errors.push('CONCURRENCY must be >= 1');
  if (s.telegram.token && !s.telegram.chatIds.length) errors.push('TELEGRAM_CHAT_ID is required when TELEGRAM_BOT_TOKEN is set');
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.timezone }); } catch { errors.push(`TIMEZONE "${s.timezone}" is unknown`); }
  s.errors = errors;
  return s;
}
