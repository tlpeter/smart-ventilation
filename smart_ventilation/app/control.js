'use strict';

// Live control: when to send a value to a fan or valve. Pure functions, no
// Home Assistant here; server.js does the sending.
//
// The rules:
// - A value is sent when the advice changes, and only when the device is not
//   at that value already.
// - Did the device not follow? Then the app tries again after a while, at
//   most a few times, and then stops and writes that in the Activity log.
// - Once the device has the value, the app leaves it alone until the advice
//   changes. So a change by hand (or by another automation) stays, until the
//   next shower or the end of one.
// - A device that was unavailable (a restart, a lost wifi connection) often
//   comes back at its own start value. Then the app sends the advice again,
//   as if the advice were new. While a device is unavailable no tries count.

const RETRY_MS = Math.max(50, Number(process.env.SV_RETRY_MS) || 2 * 60 * 1000); // SV_RETRY_MS: tests only
const MAX_TRIES = 3;

// How close counts as "at this value". A fan with fixed speed steps (for
// example 33 %, 67 %, 100 %) lands on the nearest step.
function tolerance(act, meta) {
  if (act.type !== 'number' && !(act.type === 'fan' && act.fanMode !== 'preset')) return 0;
  const step = Number(meta && meta.step) || 1;
  return step / 2;
}

function reached(current, target, tol) {
  if (current === null || current === undefined) return false;
  if (typeof target === 'number') {
    const c = Number(current);
    return Number.isFinite(c) && Math.abs(c - target) <= tol;
  }
  return String(current) === String(target);
}

// items: [{ id, target, current, tol, available }] (available: false when
// the entity is unavailable, unknown or missing; left out means available)
// memory: { [id]: { target, tries, at, done, gaveUp, away } }
// Returns { memory, send: [id], gaveUp: [id], back: [id] }. memory is a new
// object. back: devices that came back and get the advice again.
function plan(items, memory, now) {
  const next = {};
  const send = [];
  const gaveUp = [];
  const back = [];
  for (const it of items) {
    const m = memory[it.id];
    if (it.available === false) {
      // Nothing to send to: remember that it was away, and wait.
      if (m) next[it.id] = { ...m, away: true };
      continue;
    }
    const atTarget = reached(it.current, it.target, it.tol);
    if (m && m.away && String(m.target) === String(it.target)) {
      // Back after being unavailable: send the advice again if needed.
      if (atTarget) next[it.id] = { target: it.target, tries: m.tries, at: now, done: true, gaveUp: false };
      else {
        next[it.id] = { target: it.target, tries: 1, at: now, done: false, gaveUp: false };
        send.push(it.id);
        back.push(it.id);
      }
      continue;
    }
    if (!m || String(m.target) !== String(it.target)) {
      // New advice.
      if (atTarget) next[it.id] = { target: it.target, tries: 0, at: now, done: true, gaveUp: false };
      else {
        next[it.id] = { target: it.target, tries: 1, at: now, done: false, gaveUp: false };
        send.push(it.id);
      }
      continue;
    }
    const n = { ...m };
    if (n.done || n.gaveUp) { next[it.id] = n; continue; }
    if (atTarget) n.done = true;
    else if (n.tries < MAX_TRIES && now - n.at >= RETRY_MS) {
      n.tries += 1;
      n.at = now;
      send.push(it.id);
    } else if (n.tries >= MAX_TRIES && now - n.at >= RETRY_MS) {
      n.gaveUp = true;
      gaveUp.push(it.id);
    }
    next[it.id] = n;
  }
  return { memory: next, send, gaveUp, back };
}

// Hand back at rest: the actuators the app has moved away from rest, and
// which are not at their rest value now. A value set by hand while the app
// asked for rest is left alone. items: [{ id, rest, current, tol }]
// Is the entity there to send to? A missing state, unavailable or unknown
// is not.
function available(st) {
  return !!st && st.state !== 'unavailable' && st.state !== 'unknown';
}

function handBack(items, memory) {
  return items.filter((it) => {
    const m = memory[it.id];
    return m && m.tries > 0 && String(m.target) !== String(it.rest) && !reached(it.current, it.rest, it.tol);
  }).map((it) => it.id);
}

module.exports = { RETRY_MS, MAX_TRIES, tolerance, reached, plan, handBack, available };
