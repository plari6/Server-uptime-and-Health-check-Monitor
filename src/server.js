// Built-in HTTP server: public status page, JSON API, Prometheus metrics, liveness.
import http from 'node:http';
import crypto from 'node:crypto';
import { escapeHtml as h, fmtDuration, fmtLatency, fmtTime } from './util.js';

const LABEL = { up: 'Operational', degraded: 'Degraded performance', down: 'Outage', unknown: 'No data yet' };

export function renderStatusPage(monitor, { title, days = 30 } = {}) {
  const now = monitor.now();
  const tz = monitor.settings.timezone;
  const rows = monitor.snapshot().filter((s) => s.public !== false);
  const down = rows.filter((r) => r.status === 'down').length;
  const slow = rows.filter((r) => r.status === 'degraded').length;
  const overall = down ? { cls: 'down', text: `${down} service${down > 1 ? 's' : ''} down` } : slow ? { cls: 'degraded', text: 'Some services are slow' } : { cls: 'up', text: 'All systems operational' };
  const cards = rows.map((s) => {
    const st = monitor.store.stats(s.id, now - days * 86400000, now);
    const bars = monitor.store.dailyBars(s.id, days, now).map((b) => {
      const cls = b.uptimePct == null ? 'none' : b.uptimePct >= 99.9 ? 'up' : b.uptimePct >= 98 ? 'degraded' : 'down';
      return `<i class="${cls}" title="${h(b.day)}: ${b.uptimePct == null ? 'no data' : `${b.uptimePct.toFixed(2)}%`}"></i>`;
    }).join('');
    const extra = s.maintenance ? `<span class="pill maint">🛠 ${h(s.maintenance)}</span>` : '';
    return `<section class="card">
      <div class="row"><span class="dot ${s.status}"></span><h2>${h(s.name)}</h2>${extra}<span class="state ${s.status}">${LABEL[s.status] || s.status}</span></div>
      <div class="bars">${bars}</div>
      <div class="meta"><span>${days} days ago</span><span>${st.uptimePct == null ? '-' : `${st.uptimePct.toFixed(3)}%`} uptime · avg ${fmtLatency(st.avgLatencyMs)}${s.status === 'down' ? ` · down for ${fmtDuration(now - s.downSince)}` : ''}</span><span>today</span></div>
    </section>`;
  }).join('\n');
  const incidents = monitor.store.listIncidents({ limit: 10, since: now - 14 * 86400000 })
    .filter((i) => rows.some((r) => r.id === i.monitor) && !i.maintenance)
    .map((i) => `<li><b>${h(rows.find((r) => r.id === i.monitor)?.name)}</b> — ${i.ended_at ? `resolved, ${fmtDuration(i.ended_at - i.started_at)}` : '<span class="state down">ongoing</span>'}<br><small>${h(fmtTime(i.started_at, tz))}</small></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>${h(title)}</title><style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#6b7280;--line:#e5e7eb;--up:#16a34a;--degraded:#d97706;--down:#dc2626;--none:#d1d5db}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--fg:#e6e8ec;--muted:#9aa3b2;--line:#262c38;--none:#343b48}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px}h1{font-size:26px;margin:0 0 16px}
.banner{padding:16px 20px;border-radius:10px;color:#fff;font-weight:600;margin-bottom:24px}.banner.up{background:var(--up)}.banner.degraded{background:var(--degraded)}.banner.down{background:var(--down)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 20px;margin-bottom:12px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.row h2{font-size:16px;margin:0;flex:1}
.dot{width:10px;height:10px;border-radius:50%;background:var(--none)}.dot.up{background:var(--up)}.dot.degraded{background:var(--degraded)}.dot.down{background:var(--down)}
.state{font-size:13px;color:var(--muted)}.state.down{color:var(--down);font-weight:600}.state.degraded{color:var(--degraded)}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:var(--line)}
.bars{display:flex;gap:2px;margin:12px 0 6px;height:30px}.bars i{flex:1;border-radius:2px;background:var(--none)}
.bars i.up{background:var(--up)}.bars i.degraded{background:var(--degraded)}.bars i.down{background:var(--down)}
.meta{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);gap:8px}
ul{padding-left:18px}li{margin-bottom:8px}footer{color:var(--muted);font-size:12px;margin-top:24px}
@media (max-width:520px){.meta span:first-child,.meta span:last-child{display:none}}
</style></head><body><main>
<h1>${h(title)}</h1>
<div class="banner ${overall.cls}">${overall.text}</div>
${cards || '<p>No public monitors.</p>'}
<h2 style="font-size:18px;margin-top:28px">Recent incidents (14 days)</h2>
${incidents ? `<ul>${incidents}</ul>` : '<p>No incidents. 🎉</p>'}
<footer>Updated ${h(fmtTime(now, tz))} (${h(tz)}) · refreshes every 30 s</footer>
</main></body></html>`;
}

export function renderMetrics(monitor) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
  const lines = [
    '# HELP uptime_monitor_up 1 if the monitor is up or degraded, 0 if down, -1 if unknown',
    '# TYPE uptime_monitor_up gauge',
  ];
  const snap = monitor.snapshot();
  for (const s of snap) lines.push(`uptime_monitor_up{monitor="${esc(s.id)}",name="${esc(s.name)}"} ${s.status === 'down' ? 0 : s.status === 'unknown' ? -1 : 1}`);
  lines.push('# HELP uptime_monitor_latency_ms Last response time in milliseconds', '# TYPE uptime_monitor_latency_ms gauge');
  for (const s of snap) if (s.latencyMs != null) lines.push(`uptime_monitor_latency_ms{monitor="${esc(s.id)}"} ${s.latencyMs}`);
  lines.push('# HELP uptime_monitor_degraded 1 if responses are slower than maxLatencyMs', '# TYPE uptime_monitor_degraded gauge');
  for (const s of snap) lines.push(`uptime_monitor_degraded{monitor="${esc(s.id)}"} ${s.status === 'degraded' ? 1 : 0}`);
  lines.push('# HELP uptime_monitor_uptime_ratio_24h Share of good checks in the last 24h', '# TYPE uptime_monitor_uptime_ratio_24h gauge');
  const now = monitor.now();
  for (const s of snap) { const st = monitor.store.stats(s.id, now - 86400000, now); if (st.uptimePct != null) lines.push(`uptime_monitor_uptime_ratio_24h{monitor="${esc(s.id)}"} ${(st.uptimePct / 100).toFixed(5)}`); }
  lines.push('# HELP uptime_monitor_network_down 1 if the monitoring host itself is offline', '# TYPE uptime_monitor_network_down gauge', `uptime_monitor_network_down ${monitor.network.down ? 1 : 0}`);
  return `${lines.join('\n')}\n`;
}

export function createStatusServer(monitor, { title = 'Service Status', token = '', tickEveryMs = 5000 } = {}) {
  const authorized = (req) => {
    if (!token) return true;
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || new URL(req.url, 'http://x').searchParams.get('token') || '';
    const a = Buffer.from(got); const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'method not allowed');
      if (url.pathname === '/health') {
        const age = monitor.lastTickAt ? monitor.now() - monitor.lastTickAt : null;
        const alive = age != null && age < Math.max(3 * tickEveryMs, 60000);
        return send(alive ? 200 : 503, 'application/json', JSON.stringify({ ok: alive, lastTickAgoMs: age, monitors: monitor.monitors.length, networkDown: monitor.network.down }));
      }
      if (url.pathname === '/' || url.pathname === '/status') return send(200, 'text/html; charset=utf-8', renderStatusPage(monitor, { title }));
      if (url.pathname === '/api/status') {
        const rows = authorized(req) ? monitor.snapshot() : monitor.snapshot().filter((s) => s.public !== false).map(({ id, name, status, latencyMs, lastCheckAt }) => ({ id, name, status, latencyMs, lastCheckAt }));
        return send(200, 'application/json', JSON.stringify({ generatedAt: new Date(monitor.now()).toISOString(), networkDown: monitor.network.down, monitors: rows }, null, 2));
      }
      if (url.pathname === '/metrics') {
        if (!authorized(req)) return send(401, 'text/plain', 'unauthorized');
        return send(200, 'text/plain; version=0.0.4', renderMetrics(monitor));
      }
      if (url.pathname === '/api/incidents') {
        if (!authorized(req)) return send(401, 'application/json', '{"error":"unauthorized"}');
        return send(200, 'application/json', JSON.stringify(monitor.store.listIncidents({ limit: Math.min(Number(url.searchParams.get('limit')) || 50, 500) }), null, 2));
      }
      return send(404, 'text/plain', 'not found');
    } catch (err) {
      return send(500, 'text/plain', `error: ${err.message}`);
    }
  });
}
