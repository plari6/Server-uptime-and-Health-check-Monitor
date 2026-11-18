// Small shared helpers. No dependencies.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "1h 4m", "4m 12s", "45s", "850 ms" */
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  let s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  if (s && !d && !h) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

export function fmtLatency(ms) {
  if (ms == null) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)} ms`;
}

/** Time in the configured timezone, e.g. "2026-11-18 14:02:10". */
export function fmtTime(ts, timeZone) {
  if (!ts) return '-';
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'monitor';
}

/** Replace ${VAR} with process.env.VAR so secrets stay out of monitors.json. */
export function interpolateEnv(value, env = process.env) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k) => env[k] ?? '');
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env)]));
  }
  return value;
}

/** Concurrency limiter: limit(fn) runs at most n fns at once. */
export function createLimiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

export function splitList(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
export function createLogger(level = process.env.LOG_LEVEL || 'info', out = console) {
  const min = LEVELS[level] ?? 20;
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const make = (lvl, fn) => (...args) => { if (LEVELS[lvl] >= min) fn.call(out, `[${stamp()}] ${lvl.toUpperCase().padEnd(5)}`, ...args); };
  return { debug: make('debug', out.log), info: make('info', out.log), warn: make('warn', out.warn), error: make('error', out.error) };
}
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
