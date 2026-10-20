'use strict';

// The control logic of one zone: detection, baseline, stopping, afterrun.

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../smart_ventilation/app/engine');

const MIN = engine.MIN;
const T0 = Date.parse('2026-10-20T06:00:00Z');

// A history at a steady level for the last hour, then optional extra samples.
function steady(level, extra = []) {
  const h = [];
  for (let m = -90; m <= 0; m += 10) engine.addSample(h, T0 + m * MIN, level, T0);
  for (const [m, v] of extra) engine.addSample(h, T0 + m * MIN, v, T0 + m * MIN);
  return h;
}

function input(history, minutes, extra = {}) {
  return { now: T0 + minutes * MIN, humidity: { history, ok: true }, temperature: null, reference: null, ...extra };
}

test('a fast rise starts a boost and freezes the baseline', () => {
  const h = steady(55, [[1, 58], [3, 64]]);
  const st = engine.newZoneState(T0);
  const { change } = engine.evaluateZone({}, st, input(h, 3));
  assert.equal(st.state, 'boost');
  assert.equal(change.to, 'boost');
  assert.match(st.reason, /Shower detected: \+9/);
  assert.equal(st.baseline, 55);
});

test('a slow rise does not count as a shower', () => {
  const h = steady(55, [[2, 57], [10, 59], [20, 61], [30, 63]]);
  const st = engine.newZoneState(T0);
  for (const m of [2, 10, 20, 30]) engine.evaluateZone({}, st, input(h, m));
  assert.equal(st.state, 'idle');
});

test('the boost stops at baseline + margin, but not before the minimum time', () => {
  const h = steady(55, [[1, 70], [3, 57]]);
  const st = engine.newZoneState(T0);
  engine.evaluateZone({}, st, input(h, 1));
  assert.equal(st.state, 'boost');
  engine.evaluateZone({}, st, input(h, 3)); // 57 ≤ 58, but only 2 of 5 minutes
  assert.equal(st.state, 'boost');
  engine.evaluateZone({}, st, input(h, 6));
  assert.equal(st.state, 'afterrun');
  assert.match(st.reason, /baseline 55/);
});

test('afterrun ends after its time; a new rise during afterrun boosts again', () => {
  const h = steady(55, [[1, 70], [6, 57]]);
  const st = engine.newZoneState(T0);
  engine.evaluateZone({}, st, input(h, 1));
  engine.evaluateZone({}, st, input(h, 6));
  assert.equal(st.state, 'afterrun');
  engine.evaluateZone({}, st, input(h, 10));
  assert.equal(st.state, 'afterrun');
  engine.evaluateZone({}, st, input(h, 11));
  assert.equal(st.state, 'idle');
  assert.equal(st.baseline, null);

  const h2 = steady(55, [[1, 70], [6, 57], [8, 66]]);
  const st2 = engine.newZoneState(T0);
  engine.evaluateZone({}, st2, input(h2, 1));
  engine.evaluateZone({}, st2, input(h2, 6));
  engine.evaluateZone({}, st2, input(h2, 8));
  assert.equal(st2.state, 'boost');
  assert.equal(st2.baseline, 55, 'the original baseline is kept');
});

test('the maximum boost time ends a boost, and the absolute trigger then waits', () => {
  const h = steady(80, [[1, 90]]);
  const st = engine.newZoneState(T0);
  const cfg = { maxBoostMin: 20, afterrunMin: 5 };
  engine.evaluateZone(cfg, st, input(h, 1));
  assert.equal(st.state, 'boost');
  engine.evaluateZone(cfg, st, input(h, 21));
  assert.equal(st.state, 'afterrun');
  assert.match(st.reason, /Maximum boost time/);
  engine.evaluateZone(cfg, st, input(h, 27));
  assert.equal(st.state, 'idle', 'still 90%, but no new boost from the absolute trigger');
  engine.addSample(h, T0 + 40 * MIN, 70, T0 + 40 * MIN);
  engine.evaluateZone(cfg, st, input(h, 40));
  assert.equal(st.absLatch, false, 'clearly below the trigger again');
});

test('the absolute trigger is a safety net', () => {
  const h = steady(84, [[20, 86]]);
  const st = engine.newZoneState(T0);
  engine.evaluateZone({ riseThreshold: 20 }, st, input(h, 20));
  assert.equal(st.state, 'boost');
  assert.match(st.reason, /above 85%/);
});

test('a rise in the whole house (reference) is not a shower', () => {
  const h = steady(55, [[1, 60], [3, 64]]);
  const ref = steady(50, [[1, 54], [3, 58]]);
  const st = engine.newZoneState(T0);
  engine.evaluateZone({}, st, input(h, 3, { reference: { history: ref } }));
  assert.equal(st.state, 'idle', '+9 in the room, +8 in the house: only +1 own rise');
});

test('a boost also stops near the reference', () => {
  // Humid day: the house went up to 60% during the shower, the room was at 50%.
  const h = steady(50, [[1, 75], [10, 62]]);
  const ref = steady(50, [[5, 60]]);
  const st = engine.newZoneState(T0);
  engine.evaluateZone({}, st, input(h, 1, { reference: { history: ref } }));
  assert.equal(st.state, 'boost');
  engine.evaluateZone({}, st, input(h, 10, { reference: { history: ref } }));
  assert.equal(st.state, 'afterrun');
  assert.match(st.reason, /reference 60/);
});

test('with the temperature check on, a rise without warmth is ignored', () => {
  const h = steady(55, [[3, 65]]);
  const temp = steady(21, [[3, 21.3]]);
  const st = engine.newZoneState(T0);
  engine.evaluateZone({ confirmWithTemperature: true }, st, input(h, 3, { temperature: { history: temp } }));
  assert.equal(st.state, 'idle');
  const warm = steady(21, [[3, 22.5]]);
  engine.evaluateZone({ confirmWithTemperature: true }, st, input(h, 3, { temperature: { history: warm } }));
  assert.equal(st.state, 'boost');
});

test('a sensor problem sends the zone back to rest, and it recovers', () => {
  const h = steady(55, [[1, 70]]);
  const st = engine.newZoneState(T0);
  engine.evaluateZone({}, st, input(h, 1));
  assert.equal(st.state, 'boost');
  engine.evaluateZone({}, st, { now: T0 + 2 * MIN, humidity: { history: h, ok: false, problem: 'sensor.x is unavailable' } });
  assert.equal(st.state, 'fault');
  assert.equal(st.reason, 'sensor.x is unavailable');
  engine.evaluateZone({}, st, input(h, 3));
  assert.notEqual(st.state, 'fault');
});

test('history helpers: a value counts until the next sample, old samples are dropped', () => {
  const h = [];
  engine.addSample(h, 0, 50, 0);
  engine.addSample(h, 10 * MIN, 60, 10 * MIN);
  assert.equal(engine.valueAt(h, 5 * MIN), 50);
  assert.equal(engine.riseInWindow(h, 12 * MIN, 1 * MIN), 0, '60 held through the whole window');
  assert.equal(engine.riseInWindow(h, 12 * MIN, 5 * MIN), 10);
  engine.addSample(h, 5 * 60 * MIN, 55, 5 * 60 * MIN);
  assert.equal(h.length, 2, 'keeps one sample before the 3-hour cutoff');
  assert.equal(engine.median([3, 1, 2]), 2);
  assert.equal(engine.median([1, 2, 3, 4]), 2.5);
});

test('a boost knows what started it: a shower (fast rise) or the safety net (humid)', () => {
  const h = steady(55, [[3, 65]]);
  const st = engine.newZoneState(T0);
  const { change } = engine.evaluateZone({}, st, input(h, 3));
  assert.equal(st.trigger, 'shower');
  assert.equal(change.trigger, 'shower');
  const h2 = steady(84, [[20, 86]]);
  const st2 = engine.newZoneState(T0);
  const r2 = engine.evaluateZone({ riseThreshold: 20 }, st2, input(h2, 20));
  assert.equal(st2.trigger, 'humid');
  assert.equal(r2.change.trigger, 'humid');
});
