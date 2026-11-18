// Check engines: HTTP(S) with expectations, raw TCP port, TLS certificate expiry.
import axios from 'axios';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { statusMatches } from './config.js';
import { interpolateEnv, sleep } from './util.js';

const USER_AGENT = 'UptimeMonitor/1.0 (+health-check)';
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/** Error codes that usually mean OUR network is broken, not the target. */
export const LOCAL_NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH']);

/** Human-readable cause for the IT team, not a stack trace. */
export function describeError(err, timeoutMs) {
  const code = err?.code || err?.cause?.code;
  const map = {
    ECONNREFUSED: 'Connection refused (service not listening / server down)',
    ECONNRESET: 'Connection reset by server',
    ENOTFOUND: 'DNS lookup failed (domain does not resolve)',
    EAI_AGAIN: 'DNS lookup timed out',
    ENETUNREACH: 'Network unreachable',
    EHOSTUNREACH: 'Host unreachable',
    EPIPE: 'Connection closed unexpectedly',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the host name',
    CERT_HAS_EXPIRED: 'TLS certificate has EXPIRED',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate chain is incomplete',
    SELF_SIGNED_CERT_IN_CHAIN: 'Self-signed certificate in chain',
    ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED: 'Response too large',
    ERR_FR_TOO_MANY_REDIRECTS: 'Too many redirects',
  };
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_CANCELED' || err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout/i.test(err?.message || '')) {
    return { code: 'TIMEOUT', message: `Timed out after ${timeoutMs} ms (no response)` };
  }
  return { code: code || 'ERROR', message: map[code] || err?.message || String(err) };
}

/** Reads "a.b[0].c" from an object. */
export function getPath(obj, p) {
  return p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function checkJsonRules(body, rules) {
  let data;
  try { data = JSON.parse(body); } catch { return ['response is not valid JSON']; }
  const problems = [];
  for (const r of rules) {
    const v = getPath(data, r.path);
    if ('equals' in r) { if (v !== r.equals && String(v) !== String(r.equals)) problems.push(`JSON ${r.path} = ${JSON.stringify(v)} (expected ${JSON.stringify(r.equals)})`); }
    else if (Array.isArray(r.in)) { if (!r.in.map(String).includes(String(v))) problems.push(`JSON ${r.path} = ${JSON.stringify(v)} (expected one of ${r.in.join(', ')})`); }
    else if (r.exists === false) { if (v !== undefined) problems.push(`JSON ${r.path} should not exist`); }
    else if (v === undefined || v === null) problems.push(`JSON ${r.path} is missing`);
    if (r.max != null && Number(v) > Number(r.max)) problems.push(`JSON ${r.path} = ${v} (max ${r.max})`);
    if (r.min != null && Number(v) < Number(r.min)) problems.push(`JSON ${r.path} = ${v} (min ${r.min})`);
  }
  return problems;
}

export async function httpCheck(m, { client = axios, env = process.env } = {}) {
  const started = performance.now();
  const url = interpolateEnv(m.url, env);
  try {
    const res = await client.request({
      url,
      method: m.method,
      headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache', ...interpolateEnv(m.headers || {}, env) },
      data: m.body === undefined ? undefined : interpolateEnv(m.body, env),
      auth: m.basicAuth ? interpolateEnv(m.basicAuth, env) : undefined,
      timeout: m.timeoutMs,
      signal: AbortSignal.timeout(m.timeoutMs + 500),
      maxRedirects: m.followRedirects ? 5 : 0,
      maxContentLength: 5 * 1024 * 1024,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(d) => d],
      httpsAgent: m.ignoreTls ? insecureAgent : undefined,
      proxy: false,
    });
    const latencyMs = Math.round(performance.now() - started);
    const body = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    const problems = [];
    if (!statusMatches(res.status, m.expectRanges)) problems.push(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    if (m.keyword && !body.includes(m.keyword)) problems.push(`keyword "${m.keyword}" not found on page`);
    if (m.notKeyword && body.includes(m.notKeyword)) problems.push(`error text "${m.notKeyword}" found on page`);
    if (m.json && !problems.length) problems.push(...checkJsonRules(body, m.json));
    return { ok: problems.length === 0, latencyMs, code: res.status, error: problems.join('; ') || null, errorCode: problems.length ? 'ASSERTION' : null };
  } catch (err) {
    const d = describeError(err, m.timeoutMs);
    return { ok: false, latencyMs: Math.round(performance.now() - started), code: null, error: d.message, errorCode: d.code };
  }
}

export function tcpCheck(m) {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: m.host, port: m.port });
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve({ latencyMs: Math.round(performance.now() - started), code: null, ...r }); };
    const timer = setTimeout(() => finish({ ok: false, error: `Timed out after ${m.timeoutMs} ms connecting to port ${m.port}`, errorCode: 'TIMEOUT' }), m.timeoutMs);
    socket.once('connect', () => finish({ ok: true, error: null, errorCode: null }));
    socket.once('error', (err) => { const d = describeError(err, m.timeoutMs); finish({ ok: false, error: d.message, errorCode: d.code }); });
  });
}

/** TLS certificate info for host:port. Never throws. */
export function tlsInfo(host, port = 443, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const c = socket.getPeerCertificate();
      socket.end();
      if (!c || !c.valid_to) return resolve(null);
      const validTo = Date.parse(c.valid_to);
      resolve({
        validTo,
        daysLeft: Math.floor((validTo - Date.now()) / 86400000),
        issuer: c.issuer?.O || c.issuer?.CN || 'unknown',
        subject: c.subject?.CN || host,
        authorized: socket.authorized,
        authError: socket.authorizationError ? String(socket.authorizationError) : null,
      });
    });
    socket.once('error', () => { clearTimeout(timer); resolve(null); });
  });
}

/**
 * Creates the check runner used by the monitor. Handles retries, slow flag and a
 * cached TLS lookup (certificates are checked every `sslEveryMs`, not every minute).
 */
export function createChecker({ client = axios, env = process.env, sslEveryMs = 6 * 3600 * 1000, tlsLookup = tlsInfo, now = () => Date.now() } = {}) {
  const certCache = new Map();

  async function certFor(m) {
    const port = m.type === 'tcp' ? m.port : Number(new URL(interpolateEnv(m.url, env)).port) || 443;
    const key = `${m.host}:${port}`;
    const hit = certCache.get(key);
    if (hit && now() - hit.at < sslEveryMs) return hit.cert;
    const cert = await tlsLookup(m.host, port, m.timeoutMs);
    certCache.set(key, { at: now(), cert });
    return cert;
  }

  return async function runCheck(m) {
    const once = () => (m.type === 'tcp' ? tcpCheck(m) : httpCheck(m, { client, env }));
    let result = await once();
    let attempts = 1;
    while (!result.ok && attempts <= m.retries) {
      await sleep(m.retryDelayMs);
      result = await once();
      attempts++;
    }
    result.attempts = attempts;
    result.slow = Boolean(result.ok && m.maxLatencyMs > 0 && result.latencyMs > m.maxLatencyMs);
    const wantsTls = m.sslWarnDays > 0 && (m.type === 'tcp' || m.url.startsWith('https:'));
    if (wantsTls && result.ok) result.cert = await certFor(m).catch(() => null);
    return result;
  };
}

/** Returns true if the internet is reachable from this host (any canary answers). */
export function createCanary(urls, { client = axios, cacheMs = 30000, now = () => Date.now() } = {}) {
  let last = null;
  return async function canaryOk() {
    if (!urls.length) return true;
    if (last && now() - last.at < cacheMs) return last.ok;
    const tries = urls.map((url) => client.get(url, { timeout: 5000, validateStatus: () => true, proxy: false, signal: AbortSignal.timeout(6000) }).then(() => true));
    const ok = await Promise.any(tries).catch(() => false);
    last = { at: now(), ok };
    return ok;
  };
}
