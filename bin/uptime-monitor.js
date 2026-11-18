#!/usr/bin/env node
// Server Uptime & Health Check Monitor - CLI
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.UPTIME_SKIP_DOTENV !== '1' && fs.existsSync('.env')) process.loadEnvFile('.env');

const { loadConfig, loadSettings, ConfigError } = await import('../src/config.js');
const { createChecker, createCanary } = await import('../src/checks.js');
const { openStore } = await import('../src/store.js');
const { createNotifier, createTelegramApi } = await import('../src/notify.js');
const { UptimeMonitor } = await import('../src/monitor.js');
const { startBot } = await import('../src/bot.js');
const { createStatusServer } = await import('../src/server.js');
const { buildReport, writeReports } = await import('../src/report.js');
const { createLimiter, createLogger, fmtDuration, fmtLatency, fmtTime } = await import('../src/util.js');

const HELP = `Server Uptime & Health Check Monitor

Usage: uptime-monitor <command> [options]

Commands
  init                      create monitors.json and .env from the examples
  validate                  check monitors.json and .env settings
  check [--only <name>]     run every check once, print a table, exit 1 if any fails (CI / cron friendly)
  start [--port 8080]       run the monitor daemon (node-cron), Telegram alerts + bot commands, status page
  status                    last known state of every monitor (from the database)
  incidents [--open]        recent incidents  [--limit 20]
  report [--days 30]        SLA report  [--format html,csv,json] [--out reports]
  notify-test               send a test alert to every configured channel
  doctor                    check config, database, Telegram token/chat access and internet canaries
  demo [--telegram]         offline demo: fake outage story with Telegram messages and reports
                            (--telegram also sends the demo alerts to your real Telegram chat)

Global options
  --config <file>           monitors file (default: monitors.json, env MONITORS_FILE)
  --db <file>               SQLite database (default: data/uptime.db, env DB_FILE)
  --json                    machine-readable output (check, status, incidents)
  -h, --help
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' }, db: { type: 'string' }, only: { type: 'string' }, port: { type: 'string' },
      json: { type: 'boolean' }, open: { type: 'boolean' }, limit: { type: 'string' }, days: { type: 'string' },
      format: { type: 'string' }, out: { type: 'string' }, telegram: { type: 'boolean' }, 'no-bot': { type: 'boolean' },
      force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}
const { values: opt, positionals } = parsed;
const cmd = positionals[0];
const settings = loadSettings();
if (opt.db) settings.dbFile = opt.db;
const configFile = opt.config || process.env.MONITORS_FILE || 'monitors.json';
const log = createLogger();

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, Math.max(n, 1));
function table(rows, cols) {
  const widths = cols.map((c) => Math.min(c.max || 60, Math.max(c.title.length, ...rows.map((r) => String(r[c.key] ?? '').length))));
  console.log(cols.map((c, i) => pad(c.title, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => pad(r[c.key], widths[i])).join('  '));
}
const ICON = { up: '🟢', down: '🔴', degraded: '🟡', unknown: '⚪' };

function config() {
  try { return loadConfig(configFile); } catch (err) {
    console.error(err instanceof ConfigError ? err.message : `Config error: ${err.message}`);
    process.exit(2);
  }
}
function requireSettings() {
  if (settings.errors.length) { console.error(`Invalid settings:\n  - ${settings.errors.join('\n  - ')}`); process.exit(2); }
}

const commands = {
  async init() {
    for (const [src, dst] of [['monitors.example.json', 'monitors.json'], ['.env.example', '.env']]) {
      if (fs.existsSync(dst) && !opt.force) { console.log(`= ${dst} already exists (use --force to overwrite)`); continue; }
      fs.copyFileSync(path.join(ROOT, src), dst);
      console.log(`+ created ${dst}`);
    }
    console.log('\nNext: edit monitors.json (your endpoints) and .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID),\nthen run: uptime-monitor doctor  ->  uptime-monitor check  ->  uptime-monitor start --port 8080');
  },

  async validate() {
    const cfg = config();
    requireSettings();
    console.log(`✓ ${cfg.monitors.length} monitors, ${cfg.maintenance.length} maintenance window(s) in ${cfg.file}`);
    for (const m of cfg.monitors) console.log(`  - ${m.name} [${m.type}] every ${m.interval}s ${m.type === 'tcp' ? `${m.host}:${m.port}` : m.url}`);
    const ch = [settings.telegram.token && 'telegram', settings.slackWebhookUrl && 'slack', settings.webhookUrl && 'webhook'].filter(Boolean);
    console.log(ch.length ? `✓ alert channels: ${ch.join(', ')}` : '! no alert channel configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env)');
  },

  async check() {
    const cfg = config();
    let monitors = cfg.monitors;
    if (opt.only) {
      const q = opt.only.toLowerCase();
      monitors = monitors.filter((m) => m.id === q || m.name.toLowerCase().includes(q));
      if (!monitors.length) { console.error(`No monitor matches "${opt.only}"`); process.exit(2); }
    }
    const run = createChecker();
    const limit = createLimiter(settings.concurrency);
    const results = await Promise.all(monitors.map((m) => limit(() => run(m))));
    const rows = monitors.map((m, i) => {
      const r = results[i];
      const status = !r.ok ? 'down' : r.slow ? 'degraded' : 'up';
      return {
        icon: ICON[status], name: m.name, status, target: m.type === 'tcp' ? `${m.host}:${m.port}` : m.url,
        code: r.code ?? '', latency: fmtLatency(r.latencyMs), latencyMs: r.latencyMs,
        ssl: r.cert ? `${r.cert.daysLeft}d` : '', detail: r.error || (r.slow ? `slower than ${m.maxLatencyMs} ms` : 'ok'),
        attempts: r.attempts,
      };
    });
    if (opt.json) console.log(JSON.stringify(rows.map(({ icon, latency, ...r }) => r), null, 2));
    else {
      table(rows, [{ key: 'icon', title: '' }, { key: 'name', title: 'Monitor', max: 28 }, { key: 'code', title: 'HTTP' }, { key: 'latency', title: 'Time' }, { key: 'ssl', title: 'SSL' }, { key: 'detail', title: 'Result', max: 70 }]);
      const down = rows.filter((r) => r.status === 'down').length;
      console.log(`\n${rows.length - down}/${rows.length} up`);
    }
    process.exitCode = rows.some((r) => r.status === 'down') ? 1 : 0;
  },

  async status() {
    const cfg = config();
    const store = openStore(settings.dbFile);
    const states = store.loadStates();
    const now = Date.now();
    const rows = cfg.monitors.map((m) => {
      const st = states.get(m.id) || {};
      const s24 = store.stats(m.id, now - 86400000, now);
      return {
        icon: ICON[st.status || 'unknown'], name: m.name, status: st.status || 'unknown',
        since: st.status === 'down' ? fmtDuration(now - st.downSince) : '',
        last: st.lastCheckAt ? `${fmtDuration(now - st.lastCheckAt)} ago` : 'never',
        latency: fmtLatency(st.lastResult?.latencyMs), uptime24h: s24.uptimePct == null ? '-' : `${s24.uptimePct.toFixed(2)}%`,
        incident: st.incidentId ? `#${st.incidentId}${st.ackedBy ? ` ack ${st.ackedBy}` : ''}` : '',
        error: st.lastResult && !st.lastResult.ok ? st.lastResult.error : '',
      };
    });
    store.close();
    if (opt.json) return console.log(JSON.stringify(rows.map(({ icon, ...r }) => r), null, 2));
    table(rows, [{ key: 'icon', title: '' }, { key: 'name', title: 'Monitor', max: 28 }, { key: 'status', title: 'Status' }, { key: 'since', title: 'Down for' }, { key: 'uptime24h', title: '24h' }, { key: 'latency', title: 'Time' }, { key: 'last', title: 'Last check' }, { key: 'incident', title: 'Incident' }, { key: 'error', title: 'Error', max: 50 }]);
  },

  async incidents() {
    const cfg = fs.existsSync(configFile) ? config() : { monitors: [] };
    const store = openStore(settings.dbFile);
    const list = store.listIncidents({ open: opt.open, limit: Number(opt.limit) || 20 });
    store.close();
    const name = (id) => cfg.monitors.find((m) => m.id === id)?.name || id;
    const now = Date.now();
    const rows = list.map((i) => ({ id: `#${i.id}`, monitor: name(i.monitor), started: fmtTime(i.started_at, settings.timezone), duration: fmtDuration((i.ended_at ?? now) - i.started_at), state: i.ended_at ? 'resolved' : 'OPEN', ack: i.acked_by || '', cause: i.cause || '' }));
    if (opt.json) return console.log(JSON.stringify(list, null, 2));
    if (!rows.length) return console.log('No incidents recorded.');
    table(rows, [{ key: 'id', title: '#' }, { key: 'monitor', title: 'Monitor', max: 28 }, { key: 'started', title: 'Started' }, { key: 'duration', title: 'Duration' }, { key: 'state', title: 'State' }, { key: 'ack', title: 'Ack by' }, { key: 'cause', title: 'Cause', max: 60 }]);
  },

  async report() {
    const cfg = config();
    const store = openStore(settings.dbFile);
    const report = buildReport(store, cfg.monitors, { days: Number(opt.days) || 30, timezone: settings.timezone });
    store.close();
    const files = writeReports(report, { outDir: opt.out || 'reports', formats: (opt.format || 'html,csv,json').split(',').map((s) => s.trim()) });
    for (const m of report.monitors) console.log(`${(m.slaMet === false ? '✗' : '✓')} ${m.name.padEnd(28)} ${m.uptimePct == null ? '     -' : `${m.uptimePct.toFixed(3)}%`}  ${m.incidents} incident(s)  downtime ${fmtDuration(m.downtimeMs)}`);
    console.log(`\nWritten: ${files.join(', ')}`);
  },

  async 'notify-test'() {
    requireSettings();
    const notifier = createNotifier(settings, { log });
    if (!notifier.channels.length) { console.error('No alert channel configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env'); process.exit(2); }
    const res = await notifier.sendText('🧪 <b>Test alert</b> from the uptime monitor.\nIf you can read this, alerts will reach this chat.');
    for (const r of res) console.log(`${r.ok ? '✓' : '✗'} ${r.channel}${r.error ? `: ${r.error}` : ''}`);
    process.exitCode = res.every((r) => r.ok) ? 0 : 1;
  },

  async doctor() {
    let ok = true;
    const say = (good, text) => { console.log(`${good ? '✓' : '✗'} ${text}`); if (!good) ok = false; };
    try { const c = loadConfig(configFile); say(true, `config: ${c.monitors.length} monitors in ${c.file}`); } catch (err) { say(false, err.message); }
    say(!settings.errors.length, settings.errors.length ? `settings: ${settings.errors.join('; ')}` : `settings ok (timezone ${settings.timezone}, tick "${settings.tickCron}")`);
    try { const s = openStore(settings.dbFile); s.setMeta('doctor', Date.now()); s.close(); say(true, `database writable: ${settings.dbFile}`); } catch (err) { say(false, `database: ${err.message}`); }
    const online = await createCanary(settings.canaryUrls)();
    say(online, settings.canaryUrls.length ? `internet canary ${online ? 'reachable' : 'UNREACHABLE'} (${settings.canaryUrls.join(', ')})` : 'internet canary disabled (CANARY_URLS empty)');
    const tg = settings.telegram;
    if (!tg.token) console.log('! Telegram not configured (TELEGRAM_BOT_TOKEN) - alerts will only be logged');
    else {
      const api = createTelegramApi({ token: tg.token, apiBase: tg.apiBase });
      try {
        const me = await api.call('getMe', {});
        say(true, `Telegram bot @${me.username}`);
        for (const chat of [...tg.chatIds, ...tg.escalationChatIds]) {
          try { const c = await api.call('getChat', { chat_id: chat }); say(true, `chat ${chat}: ${c.title || c.username || c.first_name || c.type}`); } catch (err) { say(false, `chat ${chat}: ${err.message} (add the bot to the group / send it /start first)`); }
        }
      } catch (err) { say(false, `Telegram token rejected: ${err.message}`); }
    }
    if (settings.slackWebhookUrl) console.log('• Slack webhook configured');
    if (settings.webhookUrl) console.log(`• JSON webhook configured${settings.webhookSecret ? ' (HMAC signed)' : ''}`);
    if (settings.heartbeatUrl) console.log('• heartbeat (dead-man switch) configured');
    process.exitCode = ok ? 0 : 1;
  },

  async demo() {
    const { runDemo } = await import('../src/demo.js');
    let realSettings = null;
    if (opt.telegram) {
      if (!settings.telegram.token || !settings.telegram.chatIds.length) { console.error('--telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env'); process.exit(2); }
      realSettings = { ...settings, slackWebhookUrl: '', webhookUrl: '' };
    }
    await runDemo({ outDir: opt.out || 'data', realSettings });
  },

  async start() {
    const cfg = config();
    requireSettings();
    const store = openStore(settings.dbFile);
    const notifier = createNotifier(settings, { store, log });
    const monitor = new UptimeMonitor({ config: cfg, settings, store, notifier, log });
    const port = Number(opt.port || process.env.PORT || 0);
    let server = null;
    if (port) {
      server = createStatusServer(monitor, { title: settings.statusTitle, token: settings.statusToken });
      server.listen(port, () => log.info(`[http] status page http://localhost:${port}/  · /api/status · /metrics · /health`));
    }
    const bot = settings.telegram.token && settings.telegram.commands && !opt['no-bot'] ? startBot({ monitor, api: notifier.telegram, settings, log }) : null;
    if (!notifier.channels.length) log.warn('no alert channel configured - alerts are only logged (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)');
    log.info(`[start] watching ${cfg.monitors.length} endpoints · tick "${settings.tickCron}" · ${settings.timezone} · db ${settings.dbFile}`);
    const intervals = [...new Set(cfg.monitors.map((m) => m.interval))].join('/');
    await notifier.sendText(`🟢 <b>Uptime monitor started</b>\nWatching ${cfg.monitors.length} endpoints every ${intervals}s.${bot ? '\nSend /status to see them.' : ''}`);
    await monitor.start();
    const down = monitor.snapshot().filter((s) => s.status === 'down');
    log.info(`[start] first round done: ${cfg.monitors.length - down.length}/${cfg.monitors.length} up`);

    let stopping = false;
    const shutdown = async (sig) => {
      if (stopping) return;
      stopping = true;
      log.info(`[stop] ${sig} received, shutting down`);
      await monitor.stop();
      await bot?.stop();
      server?.close();
      await Promise.race([notifier.sendText(`⏸ <b>Uptime monitor stopped</b> (${sig}). No alerts until it restarts.`), new Promise((r) => setTimeout(r, 5000))]);
      store.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  },
};

if (opt.help || !cmd || cmd === 'help') { console.log(HELP); process.exit(cmd || opt.help ? 0 : 1); }
const fn = commands[cmd];
if (!fn) { console.error(`Unknown command "${cmd}"\n\n${HELP}`); process.exit(2); }
try { await fn(); } catch (err) { console.error(`Error: ${err.stack || err.message}`); process.exit(1); }
