import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, loadSettings } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createNotifier } from '../src/notify.js';
import { UptimeMonitor } from '../src/monitor.js';
import { createStatusServer } from '../src/server.js';
import { buildReport, writeReports, allowedDowntimeMs } from '../src/report.js';
import { startFakeServices, startFakeTelegram } from '../src/demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'uptime-monitor.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-cli-'));
let svc;
before(async () => { svc = await startFakeServices(); });
after(async () => { await svc.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const env = { ...process.env, UPTIME_SKIP_DOTENV: '1', CANARY_URLS: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', LOG_LEVEL: 'warn' };
const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: tmp, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000 });
// async variant: needed when the CLI talks to fake servers living in this process
const cliAsync = (args, extraEnv = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: tmp, env: { ...env, ...extraEnv } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

function monitorWithHistory() {
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  let clock = t0;
  const config = normalizeConfig({ monitors: [
    { name: 'Website', url: `${svc.url}/`, sla: 99.9 },
    { name: 'Secret admin', url: `${svc.url}/api/health`, public: false, sla: 99 },
  ] });
  const store = openStore(':memory:');
  const settings = { ...loadSettings({}), timezone: 'UTC', canaryUrls: [], telegram: { token: '', chatIds: [], escalationChatIds: [], adminIds: [] } };
  const monitor = new UptimeMonitor({ config, settings, store, notifier: createNotifier(settings), now: () => clock });
  // 100 checks: website down for 10 of them (one incident)
  for (let i = 0; i < 100; i++) {
    const down = i >= 40 && i < 50;
    monitor.apply(config.monitors[0], down ? { ok: false, error: 'HTTP 500', code: 500, latencyMs: 30 } : { ok: true, code: 200, latencyMs: 100 + i }, clock, []);
    monitor.apply(config.monitors[1], { ok: true, code: 200, latencyMs: 50 }, clock, []);
    clock += 60000;
  }
  monitor.lastTickAt = clock;
  return { monitor, store, config, now: () => clock };
}

test('report: uptime, SLA breach, downtime, MTTR, error budget', () => {
  const { store, config, now } = monitorWithHistory();
  const r = buildReport(store, config.monitors, { days: 1, now: now(), timezone: 'UTC' });
  const web = r.monitors[0];
  assert.equal(web.uptimePct, 90);
  assert.equal(web.slaMet, false);
  assert.equal(web.incidents, 1);
  assert.equal(web.downtimeMs, 10 * 60000);
  assert.equal(web.mttrMs, 10 * 60000);
  assert.ok(web.errorBudgetLeftMs < 0);
  assert.equal(r.overall.slaBreaches, 1);
  assert.equal(allowedDowntimeMs(99.9, 30 * 86400000), 2592000);
  const files = writeReports(r, { outDir: tmp, basename: 'r' });
  assert.equal(files.length, 3);
  const html = fs.readFileSync(path.join(tmp, 'r.html'), 'utf8');
  assert.match(html, /BREACHED/);
  const csv = fs.readFileSync(path.join(tmp, 'r.csv'), 'utf8');
  assert.ok(csv.startsWith('﻿monitor,'));
  assert.match(csv, /Website,.*,90\.0000,99\.9,NO,10\.0/);
});

test('status server: page, api, metrics, health, private monitors hidden', async () => {
  const { monitor } = monitorWithHistory();
  const server = createStatusServer(monitor, { title: 'ACME <Status>', token: 'tok' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /ACME &lt;Status&gt;/);
    assert.match(page, /Website/);
    assert.ok(!page.includes('Secret admin'), 'private monitor not on public page');

    const pub = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(pub.monitors.map((m) => m.name), ['Website']);
    assert.equal(pub.monitors[0].target, undefined, 'public api hides targets');
    const full = await (await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer tok' } })).json();
    assert.equal(full.monitors.length, 2);

    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    const metrics = await (await fetch(`${base}/metrics?token=tok`)).text();
    assert.match(metrics, /uptime_monitor_up\{monitor="website",name="Website"\} 1/);
    assert.match(metrics, /uptime_monitor_uptime_ratio_24h\{monitor="website"\} 0\.9/);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    monitor.lastTickAt = monitor.now() - 10 * 60000;
    assert.equal((await fetch(`${base}/health`)).status, 503, 'stalled scheduler reports unhealthy');
    assert.equal((await fetch(`${base}/api/incidents`, { headers: { Authorization: 'Bearer tok' } })).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});

test('CLI: help, init, validate, check exit codes and JSON', async () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Commands/);
  assert.equal(cli(['bogus']).status, 2);

  const init = cli(['init']);
  assert.equal(init.status, 0, init.stderr);
  assert.ok(fs.existsSync(path.join(tmp, 'monitors.json')));
  assert.ok(fs.existsSync(path.join(tmp, '.env')));
  assert.equal(cli(['validate']).status, 0);

  const cfg = path.join(tmp, 'local.json');
  fs.writeFileSync(cfg, JSON.stringify({ defaults: { retries: 0, timeoutMs: 1000 }, monitors: [{ name: 'Website', url: `${svc.url}/`, keyword: 'Welcome' }, { name: 'DB', type: 'tcp', host: '127.0.0.1', port: svc.tcpPort }] }));
  const ok = await cliAsync(['check', '--config', cfg]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /2\/2 up/);

  svc.mode.web = 'down';
  const bad = await cliAsync(['check', '--config', cfg, '--json']);
  svc.mode.web = 'ok';
  assert.equal(bad.status, 1);
  const rows = JSON.parse(bad.stdout);
  assert.equal(rows.find((r) => r.name === 'Website').status, 'down');
  assert.match(rows.find((r) => r.name === 'Website').detail, /HTTP 503/);

  const only = await cliAsync(['check', '--config', cfg, '--only', 'db']);
  assert.match(only.stdout, /1\/1 up/);

  fs.writeFileSync(path.join(tmp, 'bad.json'), JSON.stringify({ monitors: [{ name: 'x', url: 'nope' }] }));
  const invalid = cli(['validate', '--config', 'bad.json']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /valid http\(s\) URL/);
});

test('CLI: start daemon end-to-end with fake Telegram, then status/incidents/report', async () => {
  const tg = await startFakeTelegram();
  const cfg = path.join(tmp, 'daemon.json');
  const db = path.join(tmp, 'daemon.db');
  fs.writeFileSync(cfg, JSON.stringify({ defaults: { retries: 0, timeoutMs: 1000, interval: 5 }, monitors: [{ name: 'API', url: `${svc.url}/api/health` }] }));
  svc.mode.api = 'error';
  const child = spawn(process.execPath, [CLI, 'start', '--config', cfg, '--db', db, '--port', '0'], {
    cwd: tmp,
    env: { ...env, TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_API_BASE: tg.url, TICK_CRON: '* * * * * *', LOG_LEVEL: 'info' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !tg.messages().some((m) => /DOWN/.test(m.text))) await new Promise((r) => setTimeout(r, 100));
    const texts = tg.messages().map((m) => m.text);
    assert.ok(texts.some((t) => /monitor started/.test(t)), out);
    assert.ok(texts.some((t) => /DOWN<\/b> — <b>API/.test(t)), out);
    assert.ok(tg.calls.some((c) => c.method === 'getUpdates'), 'bot polling started');

    tg.pushUpdate({ update_id: 10, message: { text: '/status', chat: { id: '-1001' }, from: { id: 1 } } });
    const d2 = Date.now() + 5000;
    while (Date.now() < d2 && !tg.messages().some((m) => /Status<\/b>/.test(m.text))) await new Promise((r) => setTimeout(r, 100));
    assert.ok(tg.messages().some((m) => /Status<\/b> · 0\/1 up/.test(m.text)), '/status answered');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
    svc.mode.api = 'ok';
    await tg.close();
  }
  const status = cli(['status', '--config', cfg, '--db', db, '--json']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout)[0].status, 'down');
  const inc = cli(['incidents', '--config', cfg, '--db', db]);
  assert.match(inc.stdout, /#1\s+API/);
  const rep = cli(['report', '--config', cfg, '--db', db, '--days', '1', '--out', path.join(tmp, 'rep')]);
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /Written:/);
});

test('CLI demo runs offline and writes reports', () => {
  const r = cli(['demo', '--out', path.join(tmp, 'demo')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ESCALATION/);
  assert.match(r.stdout, /RECOVERED/);
  assert.match(r.stdout, /false alarms during internet outage: 0/);
  assert.ok(fs.existsSync(path.join(tmp, 'demo', 'demo-report.html')));
  assert.ok(fs.existsSync(path.join(tmp, 'demo', 'demo-status.html')));
});
