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

// items: [{ id, target, current, tol }]
// memory: { [id]: { target, tries, at, done, gaveUp } }
// Returns { memory, send: [id], gaveUp: [id] }. memory is a new object.
function plan(items, memory, now) {
  const next = {};
  const send = [];
  const gaveUp = [];
  for (const it of items) {
    const m = memory[it.id];
    const atTarget = reached(it.current, it.target, it.tol);
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
  return { memory: next, send, gaveUp };
}

// Hand back at rest: the actuators the app has moved away from rest, and
// which are not at their rest value now. A value set by hand while the app
// asked for rest is left alone. items: [{ id, rest, current, tol }]
function handBack(items, memory) {
  return items.filter((it) => {
    const m = memory[it.id];
    return m && m.tries > 0 && String(m.target) !== String(it.rest) && !reached(it.current, it.rest, it.tol);
  }).map((it) => it.id);
}

module.exports = { RETRY_MS, MAX_TRIES, tolerance, reached, plan, handBack };
