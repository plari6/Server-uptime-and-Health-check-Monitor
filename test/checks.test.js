import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { createChecker, httpCheck, tcpCheck, createCanary, getPath } from '../src/checks.js';
import { startFakeServices } from '../src/demo.js';

let svc;
before(async () => { svc = await startFakeServices(); });
after(async () => { await svc.close(); });

const mon = (m) => {
  const cfg = normalizeConfig({ defaults: { timeoutMs: 800, retries: 0, retryDelayMs: 10 }, monitors: [m] });
  assert.deepEqual(cfg.errors, []);
  return cfg.monitors[0];
};

test('http ok with keyword and json rules', async () => {
  const r1 = await httpCheck(mon({ name: 'w', url: `${svc.url}/`, keyword: 'Welcome' }));
  assert.equal(r1.ok, true);
  assert.equal(r1.code, 200);
  assert.ok(r1.latencyMs >= 0);
  const r2 = await httpCheck(mon({ name: 'a', url: `${svc.url}/api/health`, json: [{ path: 'status', equals: 'ok' }, { path: 'queue', max: 10 }] }));
  assert.equal(r2.ok, true, r2.error);
});

test('http failures are explained for humans', async () => {
  svc.mode.api = 'error';
  const r = await httpCheck(mon({ name: 'a', url: `${svc.url}/api/health` }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 502);
  assert.match(r.error, /HTTP 502/);

  svc.mode.api = 'db-error';
  const j = await httpCheck(mon({ name: 'a', url: `${svc.url}/api/health`, json: { path: 'status', equals: 'ok' } }));
  assert.match(j.error, /JSON status = "error"/);

  const k = await httpCheck(mon({ name: 'w', url: `${svc.url}/`, keyword: 'Goodbye' }));
  assert.match(k.error, /keyword "Goodbye" not found/);

  const f = await httpCheck(mon({ name: 'f', url: `${svc.url}/fatal`, notKeyword: 'Fatal error' }));
  assert.match(f.error, /error text "Fatal error" found/);

  svc.mode.api = 'hang';
  const t = await httpCheck(mon({ name: 'a', url: `${svc.url}/api/health`, timeoutMs: 300 }));
  assert.equal(t.errorCode, 'TIMEOUT');
  assert.match(t.error, /Timed out after 300 ms/);
  svc.mode.api = 'ok';

  const refused = await httpCheck(mon({ name: 'r', url: 'http://127.0.0.1:1/' }));
  assert.equal(refused.errorCode, 'ECONNREFUSED');
  assert.match(refused.error, /Connection refused/);
});

test('expectStatus can accept non-2xx codes', async () => {
  const r = await httpCheck(mon({ name: 'n', url: `${svc.url}/missing`, expectStatus: '404' }));
  assert.equal(r.ok, true);
});

test('tcp check open and closed port', async () => {
  const ok = await tcpCheck(mon({ name: 'db', type: 'tcp', host: '127.0.0.1', port: svc.tcpPort }));
  assert.equal(ok.ok, true);
  await svc.closeTcp();
  const bad = await tcpCheck(mon({ name: 'db', type: 'tcp', host: '127.0.0.1', port: svc.tcpPort }));
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, 'ECONNREFUSED');
  await svc.openTcp();
});

test('checker retries and flags slow responses', async () => {
  let calls = 0;
  const client = { request: async () => { calls++; if (calls === 1) { const e = new Error('reset'); e.code = 'ECONNRESET'; throw e; } return { status: 200, data: 'ok' }; } };
  const run = createChecker({ client });
  const r = await run(mon({ name: 'x', url: 'http://flaky.test/', retries: 1, retryDelayMs: 1, sslWarnDays: 0 }));
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);

  svc.mode.checkoutDelayMs = 150;
  const slow = await createChecker()(mon({ name: 'c', url: `${svc.url}/checkout`, maxLatencyMs: 50 }));
  assert.equal(slow.ok, true);
  assert.equal(slow.slow, true);
  svc.mode.checkoutDelayMs = 20;
});

test('checker attaches cached TLS info for https monitors', async () => {
  let lookups = 0;
  const cert = { daysLeft: 5, validTo: Date.now() + 5 * 86400000, issuer: 'Test CA', subject: 'example.com' };
  const run = createChecker({ client: { request: async () => ({ status: 200, data: '' }) }, tlsLookup: async () => { lookups++; return cert; } });
  const m = mon({ name: 's', url: 'https://example.com/' });
  assert.equal((await run(m)).cert.daysLeft, 5);
  await run(m);
  assert.equal(lookups, 1, 'certificate is cached between checks');
});

test('canary: any reachable url means online; empty list = assume online', async () => {
  assert.equal(await createCanary([])(), true);
  assert.equal(await createCanary(['http://127.0.0.1:1/', `${svc.url}/`])(), true);
  assert.equal(await createCanary(['http://127.0.0.1:1/'])(), false);
});

test('getPath reads nested values', () => {
  assert.equal(getPath({ a: { b: [{ c: 3 }] } }, 'a.b[0].c'), 3);
  assert.equal(getPath({}, 'x.y'), undefined);
});
