// The running service: node-cron tick -> due checks (parallel, limited) -> network guard
// -> state machine -> SQLite -> alerts. Also ack / mute / check-now for the Telegram bot.
import fs from 'node:fs';
import axios from 'axios';
import cron from 'node-cron';
import { activeMaintenance, loadConfig } from './config.js';
import { createCanary, createChecker, LOCAL_NETWORK_CODES } from './checks.js';
import { evaluate, initialState } from './engine.js';
import { createLimiter, escapeHtml as h, fmtDuration, fmtLatency, silentLogger } from './util.js';

export class UptimeMonitor {
  constructor({ config, settings, store, notifier, runCheck, canary, client = axios, now = () => Date.now(), log = silentLogger }) {
    this.settings = settings;
    this.store = store;
    this.notifier = notifier;
    this.now = now;
    this.log = log;
    this.client = client;
    this.runCheck = runCheck || createChecker({ client, now });
    this.canary = canary || createCanary(settings.canaryUrls || [], { client, now });
    this.limit = createLimiter(settings.concurrency || 10);
    this.inFlight = new Set();
    this.lastRun = new Map();
    this.pending = new Set();
    this.tasks = [];
    this.network = { down: false, since: null };
    this.lastTickAt = null;
    this.lastHeartbeatAt = 0;
    this.startedAt = now();
    this.setConfig(config);
    const saved = store.loadStates();
    this.states = new Map(this.monitors.map((m) => [m.id, { ...initialState(), ...(saved.get(m.id) || {}) }]));
  }

  setConfig(config) {
    this.config = config;
    this.monitors = config.monitors;
    this.maintenance = config.maintenance || [];
    if (this.states) for (const m of this.monitors) if (!this.states.has(m.id)) this.states.set(m.id, initialState());
  }

  findMonitor(q) {
    const s = String(q || '').toLowerCase().trim();
    return this.monitors.find((m) => m.id === s || m.name.toLowerCase() === s)
      || this.monitors.find((m) => m.name.toLowerCase().includes(s) || m.id.includes(s)) || null;
  }

  maintenanceFor(m, now = this.now()) { return activeMaintenance(m, this.maintenance, now, this.settings.timezone); }

  /** Re-read monitors.json when it changed on disk (edit config without restarting). */
  maybeReload() {
    const file = this.config.file;
    if (!file) return false;
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return false; }
    if (mtime === this.config.mtimeMs) return false;
    try {
      const next = loadConfig(file);
      this.setConfig(next);
      this.log.info(`[config] reloaded ${file}: ${next.monitors.length} monitors`);
      return true;
    } catch (err) {
      this.config.mtimeMs = mtime; // don't spam the log every tick
      this.log.error(`[config] reload failed, keeping previous config. ${err.message}`);
      return false;
    }
  }

  /** One scheduler tick: run every monitor whose interval elapsed. */
  async tick() {
    const now = this.now();
    this.lastTickAt = now;
    this.maybeReload();
    const due = this.monitors.filter((m) => !this.inFlight.has(m.id) && (!this.lastRun.has(m.id) || now - this.lastRun.get(m.id) >= m.interval * 1000 - 1000));
    const p = due.length ? this.runBatch(due) : Promise.resolve([]);
    this.pending.add(p);
    try { return await p; } finally { this.pending.delete(p); this.heartbeat(); }
  }

  async runBatch(list) {
    const startedAt = this.now();
    for (const m of list) { this.inFlight.add(m.id); this.lastRun.set(m.id, startedAt); }
    try {
      const results = await Promise.all(list.map((m) => this.limit(() => this.runCheck(m).catch((err) => ({ ok: false, error: err.message, errorCode: 'ERROR', latencyMs: null, code: null })))));
      const now = this.now();
      const events = [];
      await this.networkGuard(results, now, events);
      list.forEach((m, i) => this.apply(m, results[i], now, events));
      if (events.length) await this.notifier.dispatch(events);
      for (const [i, m] of list.entries()) {
        const r = results[i];
        this.log.debug(`[check] ${m.name}: ${r.unknown ? 'SKIPPED (no internet)' : r.ok ? `ok ${fmtLatency(r.latencyMs)}` : `FAIL ${r.error}`}`);
      }
      for (const e of events) this.log.info(`[alert] ${e.type} ${e.monitor?.name ?? ''}${e.cause ? ` - ${e.cause}` : ''}`);
      return list.map((m, i) => ({ monitor: m, result: results[i], state: this.states.get(m.id) }));
    } finally {
      for (const m of list) this.inFlight.delete(m.id);
    }
  }

  /** If failures look like OUR internet is down, ask the canary before blaming servers. */
  async networkGuard(results, now, events) {
    const failed = results.filter((r) => !r.ok);
    const suspicious = failed.length > 0 && (
      (failed.length === results.length && results.length >= 2)
      || failed.some((r) => LOCAL_NETWORK_CODES.has(r.errorCode))
      || this.network.down);
    if (suspicious) {
      const online = await this.canary();
      if (!online) {
        for (const r of failed) r.unknown = true;
        if (!this.network.down) {
          this.network = { down: true, since: now };
          this.log.warn('[network] monitoring host appears offline (canaries unreachable) - pausing verdicts');
        }
        return;
      }
    }
    if (this.network.down && (results.some((r) => r.ok) || suspicious)) {
      events.push({ type: 'NETWORK_RESTORED', at: now, downtimeMs: now - this.network.since });
      this.log.info(`[network] connectivity restored after ${fmtDuration(now - this.network.since)}`);
      this.network = { down: false, since: null };
    }
  }

  apply(m, result, now, events) {
    const prev = this.states.get(m.id) || initialState();
    const maint = this.maintenanceFor(m, now);
    const muted = Boolean(maint) || Boolean(prev.mutedUntil && prev.mutedUntil > now);
    const res = evaluate(m, prev, result, now, { muted });
    const st = res.state;
    let closedId = null;
    if (res.openIncident) st.incidentId = this.store.openIncident(m.id, now, res.openIncident.cause, Boolean(maint));
    if (res.closeIncident && prev.incidentId) { closedId = prev.incidentId; this.store.closeIncident(prev.incidentId, now); st.incidentId = null; st.ackedBy = null; }
    if (st.mutedUntil && st.mutedUntil <= now) st.mutedUntil = null;
    for (const e of res.events) {
      e.incidentId = e.type === 'RECOVERED' ? closedId : st.incidentId;
      events.push(e);
    }
    this.store.recordCheck(m.id, now, result.unknown ? 'unknown' : st.status, result, Boolean(maint));
    this.store.saveState(m.id, st);
    this.states.set(m.id, st);
  }

  /** Acknowledge by incident number or monitor name. Stops reminders and escalation. */
  ack(target, by = 'someone') {
    const now = this.now();
    let m = null;
    const id = Number(String(target).replace(/^#/, ''));
    if (Number.isInteger(id) && id > 0) m = this.monitors.find((x) => this.states.get(x.id)?.incidentId === id) || null;
    else m = this.findMonitor(target);
    if (!m) {
      const inc = Number.isInteger(id) ? this.store.getIncident(id) : null;
      return inc ? { ok: false, message: `Incident #${id} is already closed.` } : { ok: false, message: `No open incident found for "${target}".` };
    }
    const st = this.states.get(m.id);
    if (!st?.incidentId) return { ok: false, message: `${m.name} has no open incident.` };
    if (st.ackedBy) return { ok: true, monitor: m, incidentId: st.incidentId, message: `Incident #${st.incidentId} (${m.name}) was already acknowledged by ${st.ackedBy}.` };
    st.ackedBy = by;
    this.store.ackIncident(st.incidentId, by, now);
    this.store.saveState(m.id, st);
    return { ok: true, monitor: m, incidentId: st.incidentId, message: `Incident #${st.incidentId} (${m.name}) acknowledged by ${by}. Reminders and escalation stopped.` };
  }

  mute(target, minutes) {
    const until = this.now() + minutes * 60000;
    const list = String(target).toLowerCase() === 'all' ? this.monitors : [this.findMonitor(target)].filter(Boolean);
    if (!list.length) return { ok: false, message: `Unknown monitor "${target}".` };
    for (const m of list) { const st = this.states.get(m.id); st.mutedUntil = until; this.store.saveState(m.id, st); }
    return { ok: true, until, message: `Muted ${list.length === 1 ? list[0].name : `${list.length} monitors`} for ${fmtDuration(minutes * 60000)}.` };
  }

  unmute(target) {
    const list = String(target).toLowerCase() === 'all' ? this.monitors : [this.findMonitor(target)].filter(Boolean);
    if (!list.length) return { ok: false, message: `Unknown monitor "${target}".` };
    for (const m of list) { const st = this.states.get(m.id); st.mutedUntil = null; this.store.saveState(m.id, st); }
    return { ok: true, message: `Unmuted ${list.length === 1 ? list[0].name : `${list.length} monitors`}.` };
  }

  async checkNow(target) {
    const m = this.findMonitor(target);
    if (!m) return null;
    if (this.inFlight.has(m.id)) return { monitor: m, busy: true };
    const [r] = await this.runBatch([m]);
    return r;
  }

  snapshot() {
    const now = this.now();
    return this.monitors.map((m) => {
      const st = this.states.get(m.id) || initialState();
      const maint = this.maintenanceFor(m, now);
      return {
        id: m.id, name: m.name, type: m.type, tags: m.tags, public: m.public, sla: m.sla ?? null,
        target: m.type === 'tcp' ? `${m.host}:${m.port}` : m.url.replace(/\$\{[A-Z0-9_]+\}/gi, '***'),
        status: st.status, interval: m.interval,
        lastCheckAt: st.lastCheckAt, latencyMs: st.lastResult?.latencyMs ?? null, httpStatus: st.lastResult?.code ?? null,
        error: st.lastResult && !st.lastResult.ok ? st.lastResult.error : null,
        downSince: st.status === 'down' ? st.downSince : null, incidentId: st.incidentId, ackedBy: st.ackedBy,
        mutedUntil: st.mutedUntil && st.mutedUntil > now ? st.mutedUntil : null,
        maintenance: maint ? maint.reason : null,
      };
    });
  }

  summaryHtml(hours = 24) {
    const now = this.now();
    const from = now - hours * 3600000;
    const lines = this.monitors.map((m) => {
      const s = this.store.stats(m.id, from, now);
      const st = this.states.get(m.id);
      const icon = st?.status === 'down' ? '🔴' : st?.status === 'degraded' ? '🟡' : st?.status === 'up' ? '🟢' : '⚪';
      const up = s.uptimePct == null ? 'n/a' : `${s.uptimePct.toFixed(2)}%`;
      const sla = m.sla && s.uptimePct != null && s.uptimePct < m.sla ? ` ⚠️ below SLA ${m.sla}%` : '';
      return `${icon} <b>${h(m.name)}</b> — ${up}${sla} · ${s.incidents} incident(s) · avg ${fmtLatency(s.avgLatencyMs)}`;
    });
    return `📊 <b>Uptime summary — last ${hours}h</b>\n\n${lines.join('\n')}`;
  }

  heartbeat() {
    const url = this.settings.heartbeatUrl;
    const now = this.now();
    if (!url || now - this.lastHeartbeatAt < 55000 || this.network.down) return;
    this.lastHeartbeatAt = now;
    this.client.get(url, { timeout: 10000, proxy: false }).catch((err) => this.log.warn(`[heartbeat] ${err.message}`));
  }

  start() {
    const tz = this.settings.timezone;
    this.tasks.push(cron.schedule(this.settings.tickCron, () => { this.tick().catch((err) => this.log.error(`[tick] ${err.stack || err.message}`)); }, { timezone: tz, name: 'uptime-tick' }));
    this.tasks.push(cron.schedule('17 3 * * *', () => {
      const n = this.store.prune(this.settings.retentionDays, this.now());
      this.log.info(`[prune] removed ${n} checks older than ${this.settings.retentionDays} days`);
    }, { timezone: tz, name: 'uptime-prune' }));
    if (this.settings.dailySummaryCron) {
      this.tasks.push(cron.schedule(this.settings.dailySummaryCron, () => {
        this.notifier.sendText(this.summaryHtml(24)).catch(() => {});
      }, { timezone: tz, name: 'uptime-summary' }));
    }
    return this.tick();
  }

  async stop() {
    for (const t of this.tasks) { try { t.stop(); } catch { /* ignore */ } }
    this.tasks = [];
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, 15000))]);
  }
}
