// SQLite persistence (node:sqlite, built into Node 22.13+). No native modules.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { percentile } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY,
  monitor TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,          -- up | down | degraded | unknown
  ok INTEGER NOT NULL,
  latency_ms INTEGER,
  code INTEGER,
  error TEXT,
  maintenance INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON checks(monitor, ts);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  monitor TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  cause TEXT,
  acked_by TEXT,
  acked_at INTEGER,
  maintenance INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents(monitor, started_at);
CREATE TABLE IF NOT EXISTS state (
  monitor TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  monitor TEXT,
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openStore(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const q = {
    insCheck: db.prepare('INSERT INTO checks (monitor, ts, status, ok, latency_ms, code, error, maintenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    openInc: db.prepare('INSERT INTO incidents (monitor, started_at, cause, maintenance) VALUES (?, ?, ?, ?)'),
    closeInc: db.prepare('UPDATE incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL'),
    ackInc: db.prepare('UPDATE incidents SET acked_by = ?, acked_at = ? WHERE id = ?'),
    getInc: db.prepare('SELECT * FROM incidents WHERE id = ?'),
    saveState: db.prepare('INSERT INTO state (monitor, json) VALUES (?, ?) ON CONFLICT(monitor) DO UPDATE SET json = excluded.json'),
    loadStates: db.prepare('SELECT monitor, json FROM state'),
    insAlert: db.prepare('INSERT INTO alerts (ts, monitor, type, channel, ok, error) VALUES (?, ?, ?, ?, ?, ?)'),
    counts: db.prepare(`SELECT
        SUM(CASE WHEN status IN ('up','degraded') THEN 1 ELSE 0 END) AS up,
        SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down,
        SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
        AVG(CASE WHEN ok = 1 THEN latency_ms END) AS avg_latency,
        COUNT(*) AS total
      FROM checks WHERE monitor = ? AND ts >= ? AND ts < ? AND maintenance = 0 AND status != 'unknown'`),
    latencies: db.prepare("SELECT latency_ms FROM checks WHERE monitor = ? AND ts >= ? AND ts < ? AND ok = 1 AND latency_ms IS NOT NULL AND status != 'unknown' ORDER BY latency_ms"),
    incidentsIn: db.prepare('SELECT * FROM incidents WHERE monitor = ? AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at'),
    pruneChecks: db.prepare('DELETE FROM checks WHERE ts < ?'),
    pruneAlerts: db.prepare('DELETE FROM alerts WHERE ts < ?'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  const store = {
    db,
    recordCheck(monitor, ts, status, r, maintenance = false) {
      q.insCheck.run(monitor, ts, status, r.ok ? 1 : 0, r.latencyMs ?? null, r.code ?? null, r.error ?? null, maintenance ? 1 : 0);
    },
    openIncident(monitor, ts, cause, maintenance = false) {
      return Number(q.openInc.run(monitor, ts, cause ?? null, maintenance ? 1 : 0).lastInsertRowid);
    },
    closeIncident(id, ts) { q.closeInc.run(ts, id); },
    ackIncident(id, by, ts) { q.ackInc.run(by, ts, id); return store.getIncident(id); },
    getIncident(id) { return q.getInc.get(id) || null; },
    listIncidents({ monitor, open, limit = 20, since } = {}) {
      const where = []; const args = [];
      if (monitor) { where.push('monitor = ?'); args.push(monitor); }
      if (open) where.push('ended_at IS NULL');
      if (since) { where.push('(ended_at IS NULL OR ended_at >= ?)'); args.push(since); }
      const sql = `SELECT * FROM incidents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
      return db.prepare(sql).all(...args, limit);
    },
    saveState(monitor, state) { q.saveState.run(monitor, JSON.stringify(state)); },
    loadStates() {
      const map = new Map();
      for (const row of q.loadStates.all()) { try { map.set(row.monitor, JSON.parse(row.json)); } catch { /* ignore */ } }
      return map;
    },
    recordAlert(ts, monitor, type, channel, ok, error) { q.insAlert.run(ts, monitor ?? null, type, channel, ok ? 1 : 0, error ?? null); },
    alertCount() { return db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n; },

    /** Uptime %, latency and incident stats for one monitor in [from, to). */
    stats(monitor, from, to = Date.now()) {
      const c = q.counts.get(monitor, from, to);
      const total = Number(c.up || 0) + Number(c.down || 0);
      const lat = q.latencies.all(monitor, from, to).map((r) => r.latency_ms);
      const incidents = q.incidentsIn.all(monitor, to, from);
      const closed = incidents.filter((i) => i.ended_at && !i.maintenance);
      const downtimeMs = incidents.filter((i) => !i.maintenance)
        .reduce((sum, i) => sum + (Math.min(i.ended_at ?? to, to) - Math.max(i.started_at, from)), 0);
      return {
        checks: total,
        upChecks: Number(c.up || 0),
        downChecks: Number(c.down || 0),
        degradedChecks: Number(c.degraded || 0),
        uptimePct: total ? (Number(c.up) / total) * 100 : null,
        avgLatencyMs: c.avg_latency == null ? null : Math.round(c.avg_latency),
        p95LatencyMs: percentile(lat, 95),
        incidents: incidents.filter((i) => !i.maintenance).length,
        downtimeMs,
        mttrMs: closed.length ? Math.round(closed.reduce((s, i) => s + (i.ended_at - i.started_at), 0) / closed.length) : null,
        incidentList: incidents,
      };
    },
    /** Daily uptime bars for the status page (oldest first). */
    dailyBars(monitor, days, now = Date.now()) {
      const dayMs = 86400000;
      const end = Math.floor(now / dayMs) * dayMs + dayMs;
      const rows = db.prepare(`SELECT CAST(ts / ${dayMs} AS INTEGER) AS d,
          SUM(CASE WHEN status IN ('up','degraded') THEN 1 ELSE 0 END) AS up, COUNT(*) AS total
        FROM checks WHERE monitor = ? AND ts >= ? AND maintenance = 0 AND status != 'unknown' GROUP BY d`).all(monitor, end - days * dayMs);
      const byDay = new Map(rows.map((r) => [Number(r.d), r]));
      const out = [];
      for (let i = days; i >= 1; i--) {
        const day = Math.floor((end - i * dayMs) / dayMs);
        const r = byDay.get(day);
        out.push({ day: new Date(day * dayMs).toISOString().slice(0, 10), uptimePct: r && r.total ? (r.up / r.total) * 100 : null });
      }
      return out;
    },
    prune(retentionDays, now = Date.now()) {
      const cutoff = now - retentionDays * 86400000;
      const a = q.pruneChecks.run(cutoff).changes;
      q.pruneAlerts.run(cutoff);
      return Number(a);
    },
    getMeta(key) { return q.getMeta.get(key)?.value ?? null; },
    setMeta(key, value) { q.setMeta.run(key, String(value)); },
    close() { try { db.close(); } catch { /* already closed */ } },
  };
  return store;
}
