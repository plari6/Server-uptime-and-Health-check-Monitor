import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseStatusSpec, statusMatches, activeMaintenance, loadSettings } from '../src/config.js';
import { interpolateEnv, fmtDuration } from '../src/util.js';

test('parseStatusSpec handles ranges, classes and lists', () => {
  assert.deepEqual(parseStatusSpec('200-299'), [[200, 299]]);
  assert.deepEqual(parseStatusSpec('2xx,301'), [[200, 299], [301, 301]]);
  assert.deepEqual(parseStatusSpec([200, '4xx']), [[200, 200], [400, 499]]);
  assert.ok(statusMatches(204, parseStatusSpec('2xx')));
  assert.ok(!statusMatches(500, parseStatusSpec('200-399')));
  assert.throws(() => parseStatusSpec('abc'));
});

test('normalizeConfig applies defaults, ids and types', () => {
  const cfg = normalizeConfig({
    defaults: { interval: 30 },
    monitors: [
      { name: 'Main Site', url: 'https://example.com' },
      { name: 'DB', host: 'db.local', port: 5432 },
    ],
  });
  assert.deepEqual(cfg.errors, []);
  const [web, db] = cfg.monitors;
  assert.equal(web.id, 'main-site');
  assert.equal(web.type, 'http');
  assert.equal(web.interval, 30);
  assert.equal(web.host, 'example.com');
  assert.equal(web.sslWarnDays, 14);
  assert.equal(db.type, 'tcp');
  assert.equal(db.sslWarnDays, 0);
});

test('normalizeConfig reports every problem', () => {
  const cfg = normalizeConfig({
    monitors: [
      { url: 'https://a.com' },
      { name: 'Bad URL', url: 'ftp://x' },
      { name: 'Bad TCP', type: 'tcp', host: 'x', port: 99999 },
      { name: 'Dup', url: 'https://a.com' },
      { name: 'dup', url: 'https://b.com', interval: 1, sla: 120 },
    ],
    maintenance: [{ start: 'nope' }],
  });
  const all = cfg.errors.join('\n');
  assert.match(all, /"name" is required/);
  assert.match(all, /valid http\(s\) URL/);
  assert.match(all, /valid "port"/);
  assert.match(all, /duplicate/);
  assert.match(all, /at least 5 seconds/);
  assert.match(all, /"sla"/);
  assert.match(all, /maintenance\[0\]/);
});

test('URL with ${ENV} placeholders validates', () => {
  const cfg = normalizeConfig({ monitors: [{ name: 'x', url: 'https://${HOST}/health' }] });
  assert.deepEqual(cfg.errors, []);
});

test('interpolateEnv replaces placeholders deeply', () => {
  const env = { TOKEN: 'abc' };
  assert.deepEqual(interpolateEnv({ Authorization: 'Bearer ${TOKEN}', list: ['${TOKEN}'] }, env), { Authorization: 'Bearer abc', list: ['abc'] });
  assert.equal(interpolateEnv('${MISSING}', env), '');
});

test('maintenance windows: fixed, weekly, over midnight, by tag', () => {
  const cfg = normalizeConfig({
    monitors: [{ name: 'API', url: 'https://a.com', tags: ['internal'] }, { name: 'Web', url: 'https://b.com' }],
    maintenance: [
      { monitors: ['API'], start: '2026-11-20T01:00:00Z', end: '2026-11-20T03:00:00Z' },
      { tags: ['internal'], weekly: { days: ['sun'], from: '23:00', to: '01:00' } },
    ],
  });
  assert.deepEqual(cfg.errors, []);
  const [api, web] = cfg.monitors;
  const at = (iso) => Date.parse(iso);
  assert.ok(activeMaintenance(api, cfg.maintenance, at('2026-11-20T02:00:00Z'), 'UTC'));
  assert.equal(activeMaintenance(web, cfg.maintenance, at('2026-11-20T02:00:00Z'), 'UTC'), null);
  assert.equal(activeMaintenance(api, cfg.maintenance, at('2026-11-20T04:00:00Z'), 'UTC'), null);
  // 2026-11-22 is a Sunday
  assert.ok(activeMaintenance(api, cfg.maintenance, at('2026-11-22T23:30:00Z'), 'UTC'));
  assert.ok(activeMaintenance(api, cfg.maintenance, at('2026-11-23T00:30:00Z'), 'UTC'), 'Monday 00:30 belongs to Sunday window');
  assert.equal(activeMaintenance(api, cfg.maintenance, at('2026-11-23T01:30:00Z'), 'UTC'), null);
  assert.equal(activeMaintenance(api, cfg.maintenance, at('2026-11-21T23:30:00Z'), 'UTC'), null, 'Saturday is not in window');
});

test('loadSettings validates env', () => {
  const s = loadSettings({ TELEGRAM_BOT_TOKEN: 'x', TICK_CRON: 'nope', TIMEZONE: 'Mars/Base' });
  assert.equal(s.errors.length, 3);
  const ok = loadSettings({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '-100, 42', CANARY_URLS: '' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.telegram.chatIds, ['-100', '42']);
  assert.deepEqual(ok.canaryUrls, []);
});

test('fmtDuration is human friendly', () => {
  assert.equal(fmtDuration(500), '500 ms');
  assert.equal(fmtDuration(45000), '45s');
  assert.equal(fmtDuration(252000), '4m 12s');
  assert.equal(fmtDuration(3840000), '1h 4m');
  assert.equal(fmtDuration(2 * 86400000 + 3600000), '2d 1h');
});
