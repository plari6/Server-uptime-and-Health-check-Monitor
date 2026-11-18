// Pure state machine: (monitor, state, check result, now) -> new state + events.
// "status" is the truth after thresholds; "notified" is what the IT team was last told.
// Alerts fire when the two differ, so muting/maintenance only delays bad news and
// a monitor that goes down and comes back during maintenance never pages anyone.

export const SSL_BUCKETS = [0, 1, 3, 7, 14, 30];

export function initialState() {
  return {
    status: 'unknown', notified: 'unknown',
    failStreak: 0, okStreak: 0, slowStreak: 0, fastStreak: 0,
    incidentId: null, downSince: null, cause: null,
    lastAlertAt: null, escalated: false, ackedBy: null,
    lastDownAt: null, lastDowntimeMs: null,
    mutedUntil: null, sslWarned: null,
    lastCheckAt: null, lastResult: null,
  };
}

/**
 * @returns {{ state, events: object[], openIncident?: {cause:string}, closeIncident?: boolean }}
 * Events: DOWN, RECOVERED, DEGRADED, PERF_RECOVERED, STILL_DOWN, ESCALATE, SSL_EXPIRING
 */
export function evaluate(monitor, prev, result, now, { muted = false } = {}) {
  const st = { ...prev };
  const out = { state: st, events: [] };
  st.lastCheckAt = now;
  st.lastResult = { ok: result.ok, latencyMs: result.latencyMs, code: result.code, error: result.error, slow: !!result.slow, unknown: !!result.unknown };
  if (result.unknown) return out; // monitor's own network was down: no verdict

  if (result.ok) {
    st.okStreak++; st.failStreak = 0;
    if (result.slow) { st.slowStreak++; st.fastStreak = 0; } else { st.fastStreak++; st.slowStreak = 0; }
  } else {
    st.failStreak++; st.okStreak = 0; st.slowStreak = 0; st.fastStreak = 0;
  }

  const was = st.status;
  let next = was;
  if (!result.ok) {
    if (was === 'down' || st.failStreak >= monitor.failThreshold) next = 'down';
  } else if (was === 'down') {
    if (st.okStreak >= monitor.recoverThreshold) next = 'up';
  } else if (was === 'degraded') {
    next = st.fastStreak >= 2 ? 'up' : 'degraded';
  } else {
    next = result.slow && st.slowStreak >= monitor.degradedAfter ? 'degraded' : 'up';
  }

  if (next === 'down' && was !== 'down') {
    st.downSince = now; st.cause = result.error || 'check failed';
    st.escalated = false; st.ackedBy = null;
    out.openIncident = { cause: st.cause };
  } else if (next === 'down') {
    if (result.error) st.cause = result.error;
  }
  if (was === 'down' && next !== 'down') {
    st.lastDownAt = st.downSince; st.lastDowntimeMs = now - st.downSince;
    out.closeIncident = true;
  }
  st.status = next;

  const base = { monitor, latencyMs: result.latencyMs, code: result.code, at: now };
  const told = st.notified;

  if (next !== told) {
    // Good news about something the team knows is broken is never muted.
    const isRecovery = told === 'down' && next !== 'down';
    if (!muted || isRecovery) {
      if (next === 'down') {
        out.events.push({ ...base, type: 'DOWN', cause: st.cause, since: st.downSince });
        st.lastAlertAt = now;
      } else if (isRecovery) {
        out.events.push({ ...base, type: 'RECOVERED', downtimeMs: st.lastDowntimeMs ?? (st.downSince ? now - st.downSince : null), since: st.lastDownAt ?? st.downSince });
      } else if (next === 'degraded') {
        out.events.push({ ...base, type: 'DEGRADED', limitMs: monitor.maxLatencyMs, streak: st.slowStreak });
      } else if (next === 'up' && told === 'degraded') {
        out.events.push({ ...base, type: 'PERF_RECOVERED' });
      }
      // unknown -> up at startup: silent
      st.notified = next;
    }
  } else if (next === 'down' && !muted && !st.ackedBy) {
    const downFor = now - st.downSince;
    if (monitor.escalateAfterMin > 0 && !st.escalated && downFor >= monitor.escalateAfterMin * 60000) {
      st.escalated = true; st.lastAlertAt = now;
      out.events.push({ ...base, type: 'ESCALATE', cause: st.cause, since: st.downSince, downtimeMs: downFor });
    } else if (monitor.remindEveryMin > 0 && now - (st.lastAlertAt ?? st.downSince) >= monitor.remindEveryMin * 60000) {
      st.lastAlertAt = now;
      out.events.push({ ...base, type: 'STILL_DOWN', cause: st.cause, since: st.downSince, downtimeMs: downFor });
    }
  }

  const cert = result.cert;
  if (cert && monitor.sslWarnDays > 0 && cert.daysLeft <= monitor.sslWarnDays && !muted) {
    const bucket = SSL_BUCKETS.find((b) => cert.daysLeft <= b && b <= Math.max(monitor.sslWarnDays, 0)) ?? monitor.sslWarnDays;
    const key = `${cert.validTo}:${bucket}`;
    if (st.sslWarned !== key) {
      st.sslWarned = key;
      out.events.push({ ...base, type: 'SSL_EXPIRING', cert });
    }
  }
  return out;
}
