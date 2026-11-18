import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { evaluate, initialState } from '../src/engine.js';

const MIN = 60000;
const mk = (over = {}) => normalizeConfig({ monitors: [{ name: 'API', url: 'https://a.com', remindEveryMin: 0, escalateAfterMin: 0, ...over }] }).monitors[0];
const OK = { ok: true, latencyMs: 100, code: 200 };
const FAIL = { ok: false, latencyMs: 50, code: 502, error: 'HTTP 502' };
const SLOW = { ok: true, latencyMs: 5000, code: 200, slow: true };

/** Runs a sequence of results one minute apart; returns all events. */
function run(m, results, { start = 0, state = initialState(), muted = () => false } = {}) {
  let st = state;
  const events = [];
  results.forEach((r, i) => {
    const out = evaluate(m, st, r, start + i * MIN, { muted: muted(i) });
    st = out.state;
    events.push(...out.events.map((e) => ({ ...e, i, open: !!out.openIncident, close: !!out.closeIncident })));
  });
  return { st, events, types: events.map((e) => e.type) };
}

test('startup up is silent; first failure alerts DOWN, recovery reports downtime', () => {
  const { types, events, st } = run(mk(), [OK, FAIL, FAIL, FAIL, OK]);
  assert.deepEqual(types, ['DOWN', 'RECOVERED']);
  assert.equal(events[0].cause, 'HTTP 502');
  assert.ok(events[0].open);
  assert.equal(events[1].downtimeMs, 3 * MIN);
  assert.ok(events[1].close);
  assert.equal(st.status, 'up');
});

test('failThreshold delays DOWN; single blips are ignored', () => {
  const m = mk({ failThreshold: 3 });
  assert.deepEqual(run(m, [OK, FAIL, OK, FAIL, FAIL, OK]).types, []);
  const r = run(m, [OK, FAIL, FAIL, FAIL]);
  assert.deepEqual(r.types, ['DOWN']);
  assert.equal(r.events[0].i, 3);
});

test('recoverThreshold needs several good checks', () => {
  const r = run(mk({ recoverThreshold: 2 }), [OK, FAIL, OK, FAIL, OK, OK]);
  assert.deepEqual(r.types, ['DOWN', 'RECOVERED']);
  assert.equal(r.events[1].i, 5);
});

test('down at startup alerts immediately', () => {
  assert.deepEqual(run(mk(), [FAIL]).types, ['DOWN']);
});

test('reminders repeat until acknowledged; escalation fires once', () => {
  const m = mk({ remindEveryMin: 2, escalateAfterMin: 3 });
  const r = run(m, [FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL]);
  // DOWN@0, STILL_DOWN@2, ESCALATE@3, STILL_DOWN@5 (2 min after escalation)
  assert.deepEqual(r.events.map((e) => `${e.type}@${e.i}`), ['DOWN@0', 'STILL_DOWN@2', 'ESCALATE@3', 'STILL_DOWN@5']);

  const acked = run(m, [FAIL, FAIL], {}).st;
  acked.ackedBy = '@ops';
  const after = run(m, [FAIL, FAIL, FAIL, FAIL, FAIL], { state: acked, start: 2 * MIN });
  assert.deepEqual(after.types, [], 'no reminders/escalation after ack');
});

test('degraded after N slow checks and back after 2 fast ones', () => {
  const m = mk({ maxLatencyMs: 1000, degradedAfter: 3 });
  const r = run(m, [OK, SLOW, SLOW, SLOW, SLOW, OK, OK]);
  assert.deepEqual(r.events.map((e) => `${e.type}@${e.i}`), ['DEGRADED@3', 'PERF_RECOVERED@6']);
});

test('mute/maintenance: down + up inside the window never pages', () => {
  const r = run(mk(), [OK, FAIL, FAIL, OK, OK], { muted: (i) => i >= 1 && i <= 3 });
  assert.deepEqual(r.types, []);
  assert.ok(r.events.length === 0);
});

test('still down after the window ends -> DOWN alert then', () => {
  const r = run(mk(), [OK, FAIL, FAIL, FAIL], { muted: (i) => i <= 2 });
  assert.deepEqual(r.events.map((e) => `${e.type}@${e.i}`), ['DOWN@3']);
});

test('recovery is reported even while muted when the team was told it was down', () => {
  const r = run(mk(), [FAIL, FAIL, OK], { muted: (i) => i >= 1 });
  assert.deepEqual(r.types, ['DOWN', 'RECOVERED']);
});

test('unknown results (no internet) change nothing', () => {
  const r = run(mk(), [OK, { ok: false, unknown: true, error: 'DNS' }, { ok: false, unknown: true }, OK]);
  assert.deepEqual(r.types, []);
  assert.equal(r.st.failStreak, 0);
});

test('SSL warnings once per bucket (14, 7, 3, 1, 0 days)', () => {
  const m = mk({ sslWarnDays: 14 });
  const validTo = Date.parse('2026-12-01');
  const at = (d) => ({ ...OK, cert: { daysLeft: d, validTo, issuer: 'LE', subject: 'a.com' } });
  const r = run(m, [at(20), at(13), at(12), at(6), at(5), at(2), at(0)]);
  assert.deepEqual(r.events.map((e) => `${e.type}:${e.cert.daysLeft}`), ['SSL_EXPIRING:13', 'SSL_EXPIRING:6', 'SSL_EXPIRING:2', 'SSL_EXPIRING:0']);
  // renewed certificate resets warnings
  const renewed = run(m, [{ ...OK, cert: { daysLeft: 89, validTo: validTo + 90 * 86400000, issuer: 'LE', subject: 'a.com' } }], { state: r.st });
  assert.deepEqual(renewed.types, []);
});
