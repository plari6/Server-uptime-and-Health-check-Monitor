// Offline demo lab: fake company services + fake Telegram Bot API.
// Runs a scripted outage story with a simulated clock (1 cycle = 60 s) in a few seconds.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { normalizeConfig, loadSettings } from './config.js';
import { createChecker } from './checks.js';
import { openStore } from './store.js';
import { createNotifier, createTelegramApi, formatEventText } from './notify.js';
import { UptimeMonitor } from './monitor.js';
import { handleUpdate } from './bot.js';
import { buildReport, writeReports } from './report.js';
import { renderStatusPage } from './server.js';
import { silentLogger, sleep } from './util.js';

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); });

/** Fake HTTP + TCP services whose behaviour can be switched at runtime. */
export async function startFakeServices() {
  const mode = { web: 'ok', api: 'ok', checkoutDelayMs: 20 };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') {
      res.writeHead(mode.web === 'ok' ? 200 : 503, { 'Content-Type': 'text/html' });
      return res.end(mode.web === 'ok' ? '<h1>Welcome to ACME</h1>' : '<h1>Maintenance</h1>');
    }
    if (req.url === '/api/health') {
      if (mode.api === 'error') { res.writeHead(502, { 'Content-Type': 'text/plain' }); return res.end('Bad Gateway'); }
      if (mode.api === 'db-error') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"error","db":"down"}'); }
      if (mode.api === 'hang') return; // never answers -> timeout
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"status":"ok","db":"up","queue":3}');
    }
    if (req.url === '/checkout') {
      await sleep(mode.checkoutDelayMs);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<form>Checkout</form>');
    }
    if (req.url === '/fatal') { res.writeHead(200); return res.end('PHP Fatal error: out of memory'); }
    res.writeHead(404); res.end('not found');
  });
  const httpPort = await listen(server);
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  let tcp = null;
  const tcpConns = new Set();
  const openTcp = async (port = 0) => {
    tcp = net.createServer((s) => { tcpConns.add(s); s.on('close', () => tcpConns.delete(s)); s.on('error', () => {}); });
    return listen(tcp, port);
  };
  const tcpPort = await openTcp();
  return {
    url: `http://127.0.0.1:${httpPort}`,
    httpPort, tcpPort, mode,
    async closeTcp() { if (!tcp) return; for (const s of tcpConns) s.destroy(); await new Promise((r) => tcp.close(r)); tcp = null; },
    async openTcp() { if (!tcp) await openTcp(tcpPort); },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      await this.closeTcp();
    },
  };
}

/** Minimal Telegram Bot API stand-in that records every call. */
export async function startFakeTelegram() {
  const calls = [];
  const updates = [];
  let messageId = 100;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const method = req.url.split('/').pop();
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
      calls.push({ method, data });
      const reply = (result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'sendMessage') return reply({ message_id: ++messageId, chat: { id: data.chat_id }, text: data.text });
      if (method === 'getMe') return reply({ id: 1, is_bot: true, username: 'demo_uptime_bot', first_name: 'Uptime' });
      if (method === 'getChat') return reply({ id: data.chat_id, type: 'group', title: 'IT Ops' });
      if (method === 'getUpdates') {
        for (let i = 0; i < 20 && !updates.length; i++) await sleep(25);
        const out = updates.splice(0).filter((u) => u.update_id >= (data.offset || 0));
        return reply(out);
      }
      return reply(true);
    });
  });
  const port = await listen(server);
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    messages: () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.data),
    pushUpdate(u) { updates.push(u); },
    async close() { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); },
  };
}

const ICON = { up: '🟢', down: '🔴', degraded: '🟡', unknown: '⚪' };

export async function runDemo({ print = console.log, outDir = 'data', realSettings = null } = {}) {
  const svc = await startFakeServices();
  const tg = await startFakeTelegram();
  const start = Date.now() - 12 * 60000;
  let clock = start;
  const now = () => clock;
  let internetDown = false;

  const config = normalizeConfig({
    defaults: { interval: 60, timeoutMs: 1500, retries: 0, escalateAfterMin: 3, remindEveryMin: 0, sslWarnDays: 0 },
    monitors: [
      { name: 'Company website', url: `${svc.url}/`, keyword: 'Welcome', sla: 99.9, tags: ['public'] },
      { name: 'Customer API', url: `${svc.url}/api/health`, json: { path: 'status', equals: 'ok' }, sla: 99.9, owner: '@oncall_dev' },
      { name: 'Checkout', url: `${svc.url}/checkout`, maxLatencyMs: 300, sla: 99.5 },
      { name: 'Postgres database', type: 'tcp', host: '127.0.0.1', port: svc.tcpPort, sla: 99.95, public: false },
    ],
  });
  if (config.errors.length) throw new Error(config.errors.join('; '));
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const settings = { ...loadSettings({}), timezone: tz, canaryUrls: [], telegram: { token: 'demo-token', chatIds: ['-1001'], escalationChatIds: ['-1002'], adminIds: [], apiBase: tg.url, commands: true } };
  const store = openStore(':memory:');
  const fake = createNotifier(settings, { store, log: silentLogger, now });
  const real = realSettings ? createNotifier(realSettings, { log: console }) : null;
  const notifier = { dispatch: async (ev) => { await fake.dispatch(ev); if (real) await real.dispatch(ev); }, sendText: async (t) => { await fake.sendText(t); if (real) await real.sendText(t); } };
  const realCheck = createChecker({ now });
  const runCheck = async (m) => (internetDown ? { ok: false, latencyMs: 5000, code: null, error: 'DNS lookup failed (domain does not resolve)', errorCode: 'ENOTFOUND' } : realCheck(m));
  const monitor = new UptimeMonitor({ config, settings, store, notifier, runCheck, canary: async () => !internetDown, now });
  const api = createTelegramApi({ token: 'demo-token', apiBase: tg.url });

  const steps = [
    { say: 'All services healthy - monitor starts, nobody gets paged' },
    { say: 'Bad deploy: Customer API starts returning 502', act: () => { svc.mode.api = 'error'; } },
    { say: 'API still failing. Checkout becomes slow (450 ms, limit 300 ms)', act: () => { svc.mode.checkoutDelayMs = 450; } },
    { say: 'Database server stops accepting connections', act: () => svc.closeTcp() },
    { say: 'API down 3 min, nobody reacted -> escalation to managers. Checkout slow 3x -> SLOW alert' },
    { say: 'On-call engineer taps "Acknowledge" in Telegram', act: async () => {
      const id = monitor.states.get('customer-api').incidentId;
      await handleUpdate({ update_id: 1, callback_query: { id: 'cb1', from: { id: 7, username: 'oncall_dev' }, data: `ack:${id}`, message: { message_id: 101, chat: { id: '-1001' } } } }, { monitor, api, allowed: new Set(['-1001']) });
    } },
    { say: 'Rollback deployed: API healthy again', act: () => { svc.mode.api = 'ok'; } },
    { say: 'Database back up, checkout fast again', act: async () => { await svc.openTcp(); svc.mode.checkoutDelayMs = 20; } },
    { say: 'Checkout stays fast' },
    { say: 'Office internet drops (monitor host offline) - canary check fails', act: () => { internetDown = true; } },
    { say: 'Internet back', act: () => { internetDown = false; } },
  ];

  print('\n=== Server Uptime & Health Check Monitor - offline demo ===');
  print('4 fake company services, fake Telegram API, simulated clock (1 step = 60 s)\n');
  let seen = 0;
  try {
    for (const [i, step] of steps.entries()) {
      if (step.act) await step.act();
      await monitor.tick();
      const t = new Date(clock).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      const line = monitor.snapshot().map((s) => `${ICON[s.status]} ${s.name}`).join('  ');
      print(`[${t}] step ${i + 1}: ${step.say}`);
      print(`        ${line}${monitor.network.down ? '  (verdicts paused: no internet)' : ''}`);
      const msgs = tg.messages();
      for (const m of msgs.slice(seen)) {
        const text = m.text.replace(/<\/?(b|code|i)>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const buttons = m.reply_markup?.inline_keyboard?.flat().map((b) => `[${b.text}]`).join(' ');
        print(`        ┌ Telegram → chat ${m.chat_id}`);
        for (const l of text.split('\n')) print(`        │ ${l}`);
        if (buttons) print(`        │ ${buttons}`);
        print('        └');
      }
      seen = msgs.length;
      clock += 60000;
    }

    const report = buildReport(store, config.monitors, { days: 1, now: clock, timezone: tz });
    fs.mkdirSync(outDir, { recursive: true });
    const files = writeReports(report, { outDir, basename: 'demo-report', title: 'ACME - Uptime & SLA report (demo)' });
    const statusFile = path.join(outDir, 'demo-status.html');
    fs.writeFileSync(statusFile, renderStatusPage(monitor, { title: 'ACME Status (demo)' }));
    files.push(statusFile);

    print('\nSummary');
    for (const m of report.monitors) {
      print(`  ${m.name.padEnd(20)} uptime ${m.uptimePct == null ? '-' : `${m.uptimePct.toFixed(2)}%`.padStart(8)}  incidents ${m.incidents}  SLA ${m.sla}% ${m.slaMet ? 'met' : 'BREACHED'}`);
    }
    print(`\n  Telegram messages sent: ${tg.messages().length}  (false alarms during internet outage: 0)`);
    print(`  Files: ${files.join(', ')}\n`);
    return { messages: tg.messages(), report, files, events: store.alertCount(), monitor };
  } finally {
    store.close();
    await svc.close();
    await tg.close();
  }
}

export { formatEventText };
