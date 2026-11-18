import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, loadSettings, loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createNotifier, createTelegramApi, formatEventHtml, eventPayload } from '../src/notify.js';
import { UptimeMonitor } from '../src/monitor.js';
import { handleUpdate } from '../src/bot.js';
import { startFakeServices, startFakeTelegram } from '../src/demo.js';

let svc; let tg;
before(async () => { svc = await startFakeServices(); tg = await startFakeTelegram(); });
after(async () => { await svc.close(); await tg.close(); });
beforeEach(() => { tg.calls.length = 0; svc.mode.api = 'ok'; svc.mode.web = 'ok'; svc.mode.checkoutDelayMs = 20; });

function setup({ monitors, canary = async () => true, extraSettings = {}, store = openStore(':memory:') } = {}) {
  let clock = Date.parse('2026-11-18T10:00:00Z');
  const config = normalizeConfig({ defaults: { timeoutMs: 1000, retries: 0, remindEveryMin: 0, escalateAfterMin: 0, sslWarnDays: 0 }, monitors });
  assert.deepEqual(config.errors, []);
  const settings = { ...loadSettings({}), timezone: 'UTC', canaryUrls: [], telegram: { token: 'T', chatIds: ['-1001'], escalationChatIds: ['-1002'], adminIds: [], apiBase: tg.url, commands: true }, ...extraSettings };
  const notifier = createNotifier(settings, { store, now: () => clock, log: { error() {} } });
  const monitor = new UptimeMonitor({ config, settings, store, notifier, canary, now: () => clock });
  return { monitor, store, settings, advance: (ms = 60000) => { clock += ms; }, now: () => clock };
}

test('API outage: DOWN with buttons -> ack via Telegram button -> RECOVERED, all persisted', async () => {
  const { monitor, store, advance } = setup({ monitors: [
    { name: 'Website', url: `${svc.url}/`, keyword: 'Welcome' },
    { name: 'API', url: `${svc.url}/api/health`, json: { path: 'status', equals: 'ok' }, owner: '@dev' },
  ] });
  await monitor.tick();
  assert.equal(tg.messages().length, 0, 'healthy startup is silent');

  svc.mode.api = 'error'; advance();
  await monitor.tick();
  const [down] = tg.messages();
  assert.match(down.text, /DOWN<\/b> — <b>API<\/b>/);
  assert.match(down.text, /HTTP 502/);
  assert.match(down.text, /Owner: @dev/);
  assert.equal(down.chat_id, '-1001');
  const ackData = down.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(ackData, /^ack:\d+$/);

  // unauthorized chat can't ack
  const api = createTelegramApi({ token: 'T', apiBase: tg.url });
  const allowed = new Set(['-1001']);
  await handleUpdate({ update_id: 1, callback_query: { id: 'x', from: { id: 9 }, data: ackData, message: { message_id: 5, chat: { id: '-999' } } } }, { monitor, api, allowed });
  assert.equal(monitor.states.get('api').ackedBy, null);

  const reply = await handleUpdate({ update_id: 2, callback_query: { id: 'y', from: { id: 7, username: 'alice' }, data: ackData, message: { message_id: 5, chat: { id: '-1001' } } } }, { monitor, api, allowed });
  assert.match(reply, /acknowledged by @alice/);
  assert.ok(tg.calls.some((c) => c.method === 'editMessageReplyMarkup'));
  const incId = Number(ackData.split(':')[1]);
  assert.equal(store.getIncident(incId).acked_by, '@alice');

  svc.mode.api = 'ok'; advance(); advance();
  await monitor.tick();
  const rec = tg.messages().at(-1);
  assert.match(rec.text, /RECOVERED/);
  assert.match(rec.text, /2m/);
  assert.ok(store.getIncident(incId).ended_at);
  const stats = store.stats('api', 0, Date.now() + 1e12);
  assert.equal(stats.checks, 3);
  assert.equal(stats.downChecks, 1);
  assert.equal(stats.incidents, 1);
  assert.ok(store.alertCount() >= 2);
});

test('state survives a restart: no duplicate DOWN alert after reboot', async () => {
  const file = path.join(os.tmpdir(), `uptime-test-${process.pid}-${Date.now()}.db`);
  const monitors = [{ name: 'API', url: `${svc.url}/api/health` }];
  svc.mode.api = 'error';
  let s = setup({ monitors, store: openStore(file) });
  await s.monitor.tick();
  assert.equal(tg.messages().length, 1);
  s.store.close();
  tg.calls.length = 0;
  s = setup({ monitors, store: openStore(file) });
  s.advance();
  await s.monitor.tick();
  assert.equal(tg.messages().length, 0, 'already notified before restart');
  svc.mode.api = 'ok'; s.advance();
  await s.monitor.tick();
  assert.match(tg.messages()[0].text, /RECOVERED/);
  s.store.close();
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
});

test('network guard: all checks fail + canary down -> no alerts, then "connectivity restored"', async () => {
  let online = true;
  const { monitor, advance, store } = setup({
    canary: async () => online,
    monitors: [{ name: 'A', url: 'http://127.0.0.1:1/' }, { name: 'B', url: 'http://127.0.0.1:2/' }],
  });
  online = false;
  await monitor.tick();
  assert.equal(tg.messages().length, 0);
  assert.equal(monitor.network.down, true);
  assert.equal(monitor.states.get('a').status, 'unknown');
  assert.equal(store.stats('a', 0, Date.now() + 1e12).checks, 0, 'unknown checks do not count against uptime');
  online = true; advance();
  await monitor.tick();
  const texts = tg.messages().map((m) => m.text).join('\n');
  assert.match(texts, /connectivity restored/);
  assert.match(texts, /DOWN/); // the targets really are down once internet is back
});

test('canary up: real outage of every service still alerts', async () => {
  const { monitor } = setup({ canary: async () => true, monitors: [{ name: 'A', url: 'http://127.0.0.1:1/' }, { name: 'B', url: 'http://127.0.0.1:2/' }] });
  await monitor.tick();
  assert.equal(tg.messages().filter((m) => /DOWN/.test(m.text)).length, 2);
});

test('more than 3 events for one chat become one digest message', async () => {
  const monitors = [1, 2, 3, 4, 5].map((i) => ({ name: `S${i}`, url: `http://127.0.0.1:${i}/` }));
  const { monitor } = setup({ monitors });
  await monitor.tick();
  const msgs = tg.messages();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /5 monitor updates/);
});

test('per-monitor interval: due checks only', async () => {
  const { monitor, advance } = setup({ monitors: [{ name: 'Fast', url: `${svc.url}/`, interval: 30 }, { name: 'Slow', url: `${svc.url}/`, interval: 120 }] });
  await monitor.tick();
  advance(30000); const r1 = await monitor.tick();
  assert.deepEqual(r1.map((r) => r.monitor.name), ['Fast']);
  advance(90000); const r2 = await monitor.tick();
  assert.deepEqual(r2.map((r) => r.monitor.name).sort(), ['Fast', 'Slow']);
});

test('bot commands: /status /down /mute /unmute /check /ack /incidents, unauthorized ignored', async () => {
  const { monitor, advance } = setup({ monitors: [{ name: 'Website', url: `${svc.url}/` }, { name: 'API', url: `${svc.url}/api/health` }] });
  const api = createTelegramApi({ token: 'T', apiBase: tg.url });
  const allowed = new Set(['-1001']);
  const say = (text, chat = '-1001') => handleUpdate({ update_id: 1, message: { text, chat: { id: chat }, from: { id: 5, username: 'bob' } } }, { monitor, api, allowed });

  await monitor.tick();
  assert.match(await say('/status'), /2\/2 up/);
  assert.match(await say('/down@MyBot'), /All monitors are up/);
  assert.equal(await say('/status', '-555'), null);

  assert.match(await say('/mute api 30'), /Muted API for 30m/);
  svc.mode.api = 'error'; advance();
  await monitor.tick();
  assert.equal(tg.messages().filter((m) => /DOWN/.test(m.text)).length, 0, 'muted');
  assert.match(await say('/status'), /🔕/);
  assert.match(await say('/unmute api'), /Unmuted API/);
  advance(); await monitor.tick();
  assert.equal(tg.messages().filter((m) => /DOWN<\/b>/.test(m.text)).length, 1, 'alert once unmuted');

  assert.match(await say('/down'), /API<\/b> — DOWN/);
  assert.match(await say('/check website'), /Website<\/b> OK/);
  assert.match(await say('/check api'), /FAILED/);
  assert.match(await say('/check nope'), /Unknown monitor/);
  assert.match(await say('/ack api'), /acknowledged by @bob/);
  assert.match(await say('/ack api'), /already acknowledged/);
  assert.match(await say('/incidents'), /#\d+ <b>API<\/b> — 🔴 OPEN/);
  assert.match(await say('/uptime'), /Uptime summary/);
  assert.match(await say('/help'), /\/ack/);
});

test('maintenance window from config suppresses alerts and is excluded from uptime', async () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  const { monitor, store } = setup({ monitors: [{ name: 'API', url: `${svc.url}/api/health` }] });
  monitor.maintenance = normalizeConfig({ monitors: [{ name: 'x', url: 'https://a.b' }], maintenance: [{ monitors: ['API'], start: new Date(now - 1000).toISOString(), end: new Date(now + 3600000).toISOString(), reason: 'DB upgrade' }] }).maintenance;
  svc.mode.api = 'error';
  await monitor.tick();
  assert.equal(tg.messages().length, 0);
  assert.equal(monitor.snapshot()[0].maintenance, 'DB upgrade');
  assert.equal(store.stats('api', 0, Date.now() + 1e12).checks, 0);
  assert.equal(store.listIncidents()[0].maintenance, 1);
});

test('escalation goes to the escalation chat too', async () => {
  const { monitor, advance } = setup({ monitors: [{ name: 'API', url: `${svc.url}/api/health`, escalateAfterMin: 2 }] });
  svc.mode.api = 'error';
  await monitor.tick(); advance(); await monitor.tick(); advance(); await monitor.tick();
  const esc = tg.messages().filter((m) => /ESCALATION/.test(m.text));
  assert.deepEqual(esc.map((m) => m.chat_id).sort(), ['-1001', '-1002']);
});

test('config hot reload picks up new monitors and keeps old config on errors', async () => {
  const file = path.join(os.tmpdir(), `uptime-cfg-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ monitors: [{ name: 'Website', url: `${svc.url}/` }] }));
  const cfg = loadConfig(file);
  const store = openStore(':memory:');
  const settings = { ...loadSettings({}), canaryUrls: [], telegram: { token: '', chatIds: [], escalationChatIds: [], adminIds: [] } };
  const monitor = new UptimeMonitor({ config: cfg, settings, store, notifier: createNotifier(settings) });
  fs.writeFileSync(file, JSON.stringify({ monitors: [{ name: 'Website', url: `${svc.url}/` }, { name: 'API', url: `${svc.url}/api/health` }] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(monitor.maybeReload(), true);
  assert.equal(monitor.monitors.length, 2);
  fs.writeFileSync(file, '{ broken');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
  assert.equal(monitor.maybeReload(), false);
  assert.equal(monitor.monitors.length, 2);
  fs.rmSync(file, { force: true });
});

test('webhook payload is HMAC signed; one failing channel does not block Telegram', async () => {
  let got = null;
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got = { headers: req.headers, body: b }; res.end('ok'); }); });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const { monitor } = setup({
    monitors: [{ name: 'API', url: `${svc.url}/api/health` }],
    extraSettings: { webhookUrl: `http://127.0.0.1:${hook.address().port}/hook`, webhookSecret: 's3cret', slackWebhookUrl: 'http://127.0.0.1:1/slack' },
  });
  svc.mode.api = 'error';
  await monitor.tick();
  assert.equal(tg.messages().length, 1, 'telegram still delivered although slack failed');
  const ts = got.headers['x-uptime-timestamp'];
  const expected = `sha256=${crypto.createHmac('sha256', 's3cret').update(`${ts}.${got.body}`).digest('hex')}`;
  assert.equal(got.headers['x-uptime-signature'], expected);
  const payload = JSON.parse(got.body);
  assert.equal(payload.type, 'DOWN');
  assert.equal(payload.monitor.name, 'API');
  assert.equal(payload.http_status, 502);
  await new Promise((r) => hook.close(r));
});

test('alert text escapes HTML and hides ${SECRETS} in URLs', () => {
  const m = normalizeConfig({ monitors: [{ name: '<script>', url: 'https://a.com/?key=${API_KEY}' }] }).monitors[0];
  const html = formatEventHtml({ type: 'DOWN', monitor: m, cause: 'bad <b>', since: 0, incidentId: 1 }, 'UTC');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /key=\*\*\*/);
  assert.match(eventPayload({ type: 'DOWN', monitor: m }).monitor.target, /key=\*\*\*/);
});

test('telegram 429 is retried after retry_after', async () => {
  let n = 0;
  const client = { post: async () => (++n === 1 ? { status: 429, data: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 0.01 } } } : { status: 200, data: { ok: true, result: { message_id: 1 } } }) };
  const api = createTelegramApi({ token: 'T', client });
  const r = await api.sendMessage('-1', 'hi');
  assert.equal(r.message_id, 1);
  assert.equal(n, 2);
});
