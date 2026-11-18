// SLA / uptime report: per-monitor uptime %, SLA met or breached, downtime, MTTR, latency, incidents.
import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml as h, fmtDuration, fmtLatency, fmtTime } from './util.js';

/** Allowed downtime for an SLA over a period, e.g. 99.9% over 30 days = 43m 12s. */
export const allowedDowntimeMs = (slaPct, periodMs) => (slaPct == null ? null : Math.round(periodMs * (1 - slaPct / 100)));

export function buildReport(store, monitors, { days = 30, now = Date.now(), timezone } = {}) {
  const from = now - days * 86400000;
  const rows = monitors.map((m) => {
    const s = store.stats(m.id, from, now);
    const budget = allowedDowntimeMs(m.sla, now - from);
    return {
      id: m.id, name: m.name, target: m.type === 'tcp' ? `${m.host}:${m.port}` : m.url.replace(/\$\{[A-Z0-9_]+\}/gi, '***'),
      sla: m.sla ?? null,
      uptimePct: s.uptimePct,
      slaMet: m.sla == null || s.uptimePct == null ? null : s.uptimePct >= m.sla,
      downtimeMs: s.downtimeMs,
      errorBudgetMs: budget,
      errorBudgetLeftMs: budget == null ? null : budget - s.downtimeMs,
      incidents: s.incidents,
      mttrMs: s.mttrMs,
      avgLatencyMs: s.avgLatencyMs,
      p95LatencyMs: s.p95LatencyMs,
      checks: s.checks,
      incidentList: s.incidentList.filter((i) => !i.maintenance).map((i) => ({
        id: i.id, startedAt: i.started_at, endedAt: i.ended_at, durationMs: (i.ended_at ?? now) - i.started_at, cause: i.cause, ackedBy: i.acked_by,
        ackAfterMs: i.acked_at ? i.acked_at - i.started_at : null,
      })),
    };
  });
  const measured = rows.filter((r) => r.uptimePct != null);
  return {
    generatedAt: now, from, to: now, days, timezone,
    overall: {
      monitors: rows.length,
      avgUptimePct: measured.length ? measured.reduce((s, r) => s + r.uptimePct, 0) / measured.length : null,
      incidents: rows.reduce((s, r) => s + r.incidents, 0),
      downtimeMs: rows.reduce((s, r) => s + r.downtimeMs, 0),
      slaBreaches: rows.filter((r) => r.slaMet === false).length,
    },
    monitors: rows,
  };
}

const pct = (v, d = 3) => (v == null ? '-' : `${v.toFixed(d)}%`);

export function reportToCsv(r) {
  const cols = ['monitor', 'target', 'uptime_pct', 'sla_pct', 'sla_met', 'downtime_min', 'error_budget_left_min', 'incidents', 'mttr_min', 'avg_latency_ms', 'p95_latency_ms', 'checks'];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const min = (ms) => (ms == null ? '' : (ms / 60000).toFixed(1));
  const lines = [cols.join(',')];
  for (const m of r.monitors) {
    lines.push([m.name, m.target, m.uptimePct?.toFixed(4) ?? '', m.sla ?? '', m.slaMet == null ? '' : m.slaMet ? 'yes' : 'NO', min(m.downtimeMs), min(m.errorBudgetLeftMs), m.incidents, min(m.mttrMs), m.avgLatencyMs ?? '', m.p95LatencyMs ?? '', m.checks].map(esc).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function reportToHtml(r, { title = 'Uptime & SLA report' } = {}) {
  const tz = r.timezone;
  const period = `${fmtTime(r.from, tz).slice(0, 10)} → ${fmtTime(r.to, tz).slice(0, 10)}`;
  const rows = r.monitors.map((m) => `<tr>
    <td><b>${h(m.name)}</b><br><small>${h(m.target)}</small></td>
    <td class="num ${m.uptimePct != null && m.uptimePct < (m.sla ?? 99) ? 'bad' : 'good'}">${pct(m.uptimePct)}</td>
    <td class="num">${m.sla == null ? '-' : `${m.sla}%`}</td>
    <td>${m.slaMet == null ? '-' : m.slaMet ? '<span class="ok">met</span>' : '<span class="bad">BREACHED</span>'}</td>
    <td class="num">${fmtDuration(m.downtimeMs)}</td>
    <td class="num">${m.errorBudgetLeftMs == null ? '-' : m.errorBudgetLeftMs < 0 ? `<span class="bad">-${fmtDuration(-m.errorBudgetLeftMs)}</span>` : fmtDuration(m.errorBudgetLeftMs)}</td>
    <td class="num">${m.incidents}</td>
    <td class="num">${m.mttrMs == null ? '-' : fmtDuration(m.mttrMs)}</td>
    <td class="num">${fmtLatency(m.avgLatencyMs)} / ${fmtLatency(m.p95LatencyMs)}</td>
  </tr>`).join('');
  const incidents = r.monitors.flatMap((m) => m.incidentList.map((i) => ({ ...i, name: m.name }))).sort((a, b) => b.startedAt - a.startedAt);
  const incRows = incidents.map((i) => `<tr><td>#${i.id}</td><td>${h(i.name)}</td><td>${h(fmtTime(i.startedAt, tz))}</td><td class="num">${i.endedAt ? fmtDuration(i.durationMs) : '<span class="bad">ongoing</span>'}</td><td>${h(i.cause || '')}</td><td>${i.ackedBy ? `${h(i.ackedBy)} (${fmtDuration(i.ackAfterMs)})` : '-'}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title><style>
:root{--bg:#fff;--fg:#1d2330;--muted:#6b7280;--line:#e5e7eb;--good:#15803d;--bad:#dc2626;--head:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--fg:#e6e8ec;--muted:#9aa3b2;--line:#262c38;--good:#4ade80;--bad:#f87171;--head:#171b23}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:1100px;margin:0 auto;padding:28px 16px}
h1{margin:0 0 4px}.sub{color:var(--muted);margin-bottom:20px}.kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.kpi{border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:150px}.kpi b{display:block;font-size:22px}.kpi span{color:var(--muted);font-size:12px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;margin-bottom:28px}th,td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--head);font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}.num{text-align:right;white-space:nowrap}
small{color:var(--muted)}.good{color:var(--good)}.bad{color:var(--bad);font-weight:600}.ok{color:var(--good);font-weight:600}
</style></head><body><main>
<h1>${h(title)}</h1><div class="sub">${h(period)} (${r.days} days, ${h(tz || 'UTC')})</div>
<div class="kpis">
  <div class="kpi"><b>${pct(r.overall.avgUptimePct)}</b><span>average uptime</span></div>
  <div class="kpi"><b>${r.overall.incidents}</b><span>incidents</span></div>
  <div class="kpi"><b>${fmtDuration(r.overall.downtimeMs)}</b><span>total downtime</span></div>
  <div class="kpi"><b class="${r.overall.slaBreaches ? 'bad' : 'good'}">${r.overall.slaBreaches}</b><span>SLA breaches</span></div>
</div>
<div class="wrap"><table><thead><tr><th>Monitor</th><th>Uptime</th><th>SLA</th><th>Status</th><th>Downtime</th><th>Error budget left</th><th>Incidents</th><th>MTTR</th><th>Avg / p95 latency</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Incidents</h2>
${incRows ? `<div class="wrap"><table><thead><tr><th>#</th><th>Monitor</th><th>Started</th><th>Duration</th><th>Cause</th><th>Acknowledged by</th></tr></thead><tbody>${incRows}</tbody></table></div>` : '<p>No incidents in this period. 🎉</p>'}
<small>Generated ${h(fmtTime(r.generatedAt, tz))}. Uptime = good checks / all checks, excluding maintenance windows and periods where the monitoring host was offline.</small>
</main></body></html>`;
}

export function writeReports(report, { outDir = 'reports', formats = ['html', 'csv', 'json'], basename, title } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const name = basename || `uptime-report-${new Date(report.generatedAt).toISOString().slice(0, 10)}`;
  const files = [];
  for (const f of formats) {
    const file = path.join(outDir, `${name}.${f}`);
    if (f === 'html') fs.writeFileSync(file, reportToHtml(report, { title }));
    else if (f === 'csv') fs.writeFileSync(file, reportToCsv(report));
    else if (f === 'json') fs.writeFileSync(file, JSON.stringify(report, null, 2));
    else throw new Error(`unknown report format "${f}" (html, csv, json)`);
    files.push(file);
  }
  return files;
}
