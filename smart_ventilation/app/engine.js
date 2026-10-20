'use strict';

// The control logic for one zone (a room with a humidity sensor).
// Pure functions: no Home Assistant, no timers, no files. The server feeds
// in readings and the time; this module says what state the zone is in.
//
// States:
//   idle      nothing going on, actuators at their rest level
//   boost     a shower was detected, actuators at their boost level
//   afterrun  the room is dry again, actuators run a little longer
//   fault     the humidity sensor gives no usable value

const MIN = 60 * 1000;
const HISTORY_KEEP_MS = 3 * 60 * MIN;

const ZONE_DEFAULTS = {
  riseThreshold: 8, // percentage points
  riseWindowMin: 5,
  absoluteTrigger: 85, // % RH
  stopMargin: 3, // percentage points above the baseline
  minBoostMin: 5,
  maxBoostMin: 60,
  afterrunMin: 5,
  baselineWindowMin: 60,
  confirmWithTemperature: false,
  temperatureRise: 1, // °C within the rise window
};

// ---------------------------------------------------------------------------
// History helpers. A history is a list of { t, v } sorted by time. Sensors
// often only report when the value changes, so a value counts until the next
// sample.
// ---------------------------------------------------------------------------

function addSample(history, t, v, now = t) {
  if (!Number.isFinite(v) || !Number.isFinite(t)) return history;
  const last = history[history.length - 1];
  if (last && t < last.t) return history; // out of order: ignore
  if (last && t === last.t) last.v = v;
  else history.push({ t, v });
  const cutoff = now - HISTORY_KEEP_MS;
  // Keep one sample before the cutoff: its value still counts.
  let drop = 0;
  while (drop < history.length - 1 && history[drop + 1].t <= cutoff) drop++;
  if (drop > 0) history.splice(0, drop);
  return history;
}

// The value that counted at time t (the last sample at or before t).
function valueAt(history, t) {
  let v = null;
  for (const s of history) {
    if (s.t <= t) v = s.v;
    else break;
  }
  return v;
}

function lastValue(history) {
  return history.length ? history[history.length - 1].v : null;
}

// Values that counted during [from, to].
function valuesBetween(history, from, to) {
  const out = [];
  const start = valueAt(history, from);
  if (start !== null) out.push(start);
  for (const s of history) {
    if (s.t > from && s.t <= to) out.push(s.v);
  }
  return out;
}

// How much the value went up within the window: now minus the lowest value.
function riseInWindow(history, now, windowMs) {
  const current = valueAt(history, now);
  if (current === null) return 0;
  const values = valuesBetween(history, now - windowMs, now);
  if (!values.length) return 0;
  return current - Math.min(...values);
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// The normal level of the room: the median over the baseline window, leaving
// out the last rise window (that is where the shower starts).
function baselineAt(history, now, windowMs, excludeMs) {
  const values = valuesBetween(history, now - windowMs, now - excludeMs);
  const m = median(values);
  return m === null ? valueAt(history, now) : m;
}

function round1(x) {
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : null;
}

// ---------------------------------------------------------------------------
// The zone itself
// ---------------------------------------------------------------------------

function newZoneState(now) {
  return { state: 'idle', since: now, baseline: null, boostStart: null, reason: 'Waiting for readings', absLatch: false, trigger: null };
}

// cfg: zone settings. st: the zone's state (changed in place and returned).
// input: {
//   now,
//   humidity: { history, ok, problem } — ok = false when the sensor is
//             unavailable or silent for too long; problem says why,
//   temperature: { history } or null,
//   reference: { history } or null — median of the reference sensors,
// }
// Returns { st, change } where change is null or { from, to, reason }.
function evaluateZone(cfgIn, st, input) {
  const cfg = { ...ZONE_DEFAULTS, ...cfgIn };
  const now = input.now;
  const before = st.state;
  const hum = input.humidity || { history: [], ok: false, problem: 'No humidity sensor' };
  const h = valueAt(hum.history, now);
  const ref = input.reference && input.reference.history.length ? valueAt(input.reference.history, now) : null;
  const windowMs = cfg.riseWindowMin * MIN;

  const go = (to, reason) => {
    if (st.state !== to) st.since = now;
    st.state = to;
    st.reason = reason;
  };

  // 1. A sensor problem always wins: back to rest, and say why.
  if (!hum.ok || h === null) {
    go('fault', hum.problem || 'No humidity reading');
    st.boostStart = null;
    st.baseline = null;
    return result(st, before);
  }
  if (st.state === 'fault') go('idle', 'Sensor is back');

  // The absolute trigger stays off after a boost that ended on time, until
  // the room is clearly below the trigger again. Otherwise a humid day would
  // keep restarting the boost.
  if (st.absLatch && h < cfg.absoluteTrigger - cfg.stopMargin) st.absLatch = false;

  // 2. Look for a shower (in idle and in afterrun).
  if (st.state === 'idle' || st.state === 'afterrun') {
    const trigger = detect(cfg, st, input, h, ref, now, windowMs);
    if (trigger) {
      if (st.state === 'idle' || st.baseline === null) {
        st.baseline = round1(baselineAt(hum.history, now, cfg.baselineWindowMin * MIN, windowMs));
      }
      st.boostStart = now;
      // What started it: 'shower' (a fast rise) or 'humid' (the safety net).
      st.trigger = trigger.kind;
      go('boost', trigger.reason);
      return result(st, before);
    }
  }

  // 3. Boosting: stop when the room is back to normal, or at the maximum time.
  if (st.state === 'boost') {
    const ran = now - (st.boostStart || now);
    if (ran >= cfg.maxBoostMin * MIN) {
      st.absLatch = h >= cfg.absoluteTrigger;
      go('afterrun', `Maximum boost time of ${cfg.maxBoostMin} min reached`);
    } else if (ran >= cfg.minBoostMin * MIN) {
      if (st.baseline !== null && h <= st.baseline + cfg.stopMargin) {
        go('afterrun', `Back to normal: ${round1(h)}% ≤ baseline ${st.baseline}% + ${cfg.stopMargin}`);
      } else if (ref !== null && h <= ref + cfg.stopMargin) {
        go('afterrun', `Back to normal: ${round1(h)}% ≤ reference ${round1(ref)}% + ${cfg.stopMargin}`);
      }
    }
    return result(st, before);
  }

  // 4. Afterrun ends after its time.
  if (st.state === 'afterrun' && now - st.since >= cfg.afterrunMin * MIN) {
    go('idle', 'Afterrun done');
    st.boostStart = null;
    st.baseline = null;
    return result(st, before);
  }

  if (st.state === 'idle' && st.reason === 'Waiting for readings') st.reason = 'Normal';
  return result(st, before);
}

function detect(cfg, st, input, h, ref, now, windowMs) {
  const rise = riseInWindow(input.humidity.history, now, windowMs);
  const refRise = input.reference && input.reference.history.length
    ? Math.max(0, riseInWindow(input.reference.history, now, windowMs)) : 0;
  const ownRise = rise - refRise;
  let tempOk = true;
  if (cfg.confirmWithTemperature && input.temperature && input.temperature.history.length) {
    tempOk = riseInWindow(input.temperature.history, now, windowMs) >= cfg.temperatureRise;
  }
  if (ownRise >= cfg.riseThreshold && tempOk) {
    const extra = refRise > 0 ? ` (house rose ${round1(refRise)})` : '';
    return { kind: 'shower', reason: `Shower detected: +${round1(ownRise)} points in ${cfg.riseWindowMin} min${extra}` };
  }
  if (h >= cfg.absoluteTrigger && !st.absLatch && (ref === null || h - ref >= cfg.stopMargin)) {
    return { kind: 'humid', reason: `Humidity ${round1(h)}% is above ${cfg.absoluteTrigger}%` };
  }
  return null;
}

function result(st, before) {
  const change = st.state !== before ? { from: before, to: st.state, reason: st.reason } : null;
  if (change && change.to === 'boost') change.trigger = st.trigger;
  return { st, change };
}

// Numbers for the UI: what the zone sees right now.
function zoneFigures(cfgIn, st, input) {
  const cfg = { ...ZONE_DEFAULTS, ...cfgIn };
  const now = input.now;
  const windowMs = cfg.riseWindowMin * MIN;
  const hist = (input.humidity && input.humidity.history) || [];
  const refHist = input.reference && input.reference.history.length ? input.reference.history : null;
  return {
    humidity: round1(valueAt(hist, now)),
    temperature: input.temperature ? round1(valueAt(input.temperature.history, now)) : null,
    reference: refHist ? round1(valueAt(refHist, now)) : null,
    rise: round1(riseInWindow(hist, now, windowMs)),
    referenceRise: refHist ? round1(riseInWindow(refHist, now, windowMs)) : null,
    baseline: st.baseline !== null ? st.baseline : round1(baselineAt(hist, now, cfg.baselineWindowMin * MIN, windowMs)),
    baselineFrozen: st.baseline !== null,
  };
}

module.exports = {
  ZONE_DEFAULTS,
  MIN,
  addSample,
  valueAt,
  lastValue,
  riseInWindow,
  baselineAt,
  median,
  newZoneState,
  evaluateZone,
  zoneFigures,
};
