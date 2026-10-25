'use strict';

// Live control: when the app sends a value (control.js), and what ha.js
// allows.

const test = require('node:test');
const assert = require('node:assert/strict');
const control = require('../smart_ventilation/app/control');

const R = control.RETRY_MS;

test('a value is sent when the advice changes, not again while it stays', () => {
  let r = control.plan([{ id: 'fan', target: 75, current: 10, tol: 0.5 }], {}, 0);
  assert.deepEqual(r.send, ['fan']);
  assert.equal(r.memory.fan.tries, 1);
  r = control.plan([{ id: 'fan', target: 75, current: 10, tol: 0.5 }], r.memory, 1000);
  assert.deepEqual(r.send, [], 'not again right away');
  r = control.plan([{ id: 'fan', target: 75, current: 75, tol: 0.5 }], r.memory, 2000);
  assert.deepEqual(r.send, []);
  assert.equal(r.memory.fan.done, true);
});

test('nothing is sent when the device already has the value', () => {
  const r = control.plan([{ id: 'v', target: 50, current: 50, tol: 0.5 }], {}, 0);
  assert.deepEqual(r.send, []);
  assert.equal(r.memory.v.done, true);
  assert.equal(r.memory.v.tries, 0);
});

test('a change by hand stays until the next change of the advice', () => {
  let r = control.plan([{ id: 'fan', target: 10, current: 10, tol: 0.5 }], {}, 0);
  r = control.plan([{ id: 'fan', target: 10, current: 40, tol: 0.5 }], r.memory, R * 5);
  assert.deepEqual(r.send, [], 'the 40 set by hand is left alone');
  r = control.plan([{ id: 'fan', target: 75, current: 40, tol: 0.5 }], r.memory, R * 6);
  assert.deepEqual(r.send, ['fan'], 'a shower: the app sets it again');
});

test('a device that does not follow: a few tries, then the app stops', () => {
  let mem = {};
  let sent = 0;
  let gaveUp = 0;
  for (let i = 0; i <= 10; i++) {
    const r = control.plan([{ id: 'v', target: 100, current: 50, tol: 0.5 }], mem, i * R);
    sent += r.send.length;
    gaveUp += r.gaveUp.length;
    mem = r.memory;
  }
  assert.equal(sent, control.MAX_TRIES);
  assert.equal(gaveUp, 1, 'noted once');
  assert.equal(mem.v.gaveUp, true);
  const r = control.plan([{ id: 'v', target: 50, current: 50, tol: 0.5 }], mem, 20 * R);
  assert.equal(r.memory.v.gaveUp, false, 'a new advice starts over');
});

test('a fan with speed steps counts as there within half a step', () => {
  const tol = control.tolerance({ type: 'fan', fanMode: 'percentage' }, { step: 33.33 });
  assert.ok(control.reached(66.67, 75, tol));
  assert.ok(!control.reached(33.33, 75, tol));
  assert.equal(control.tolerance({ type: 'number' }, { step: 1 }), 0.5);
  assert.equal(control.tolerance({ type: 'select' }, null), 0);
  assert.ok(control.reached('High', 'High', 0));
  assert.ok(!control.reached(null, 10, 0.5), 'unknown is not there');
});

test('hand back at rest: only what the app moved away from rest', () => {
  const mem = {
    fan: { target: 75, tries: 1, done: true },
    v1: { target: 50, tries: 1, done: true }, // the app asked rest; a hand-set 70 stays
    v2: { target: 100, tries: 0, done: true }, // was already there: not moved by the app
  };
  const items = [
    { id: 'fan', rest: 10, current: 75, tol: 0.5 },
    { id: 'v1', rest: 50, current: 70, tol: 0.5 },
    { id: 'v2', rest: 50, current: 100, tol: 0.5 },
    { id: 'v3', rest: 50, current: 100, tol: 0.5 },
  ];
  assert.deepEqual(control.handBack(items, mem), ['fan']);
  assert.deepEqual(control.handBack([{ id: 'fan', rest: 10, current: 10, tol: 0.5 }], mem), [], 'already at rest');
});

test('ha.js: only the six actions, only on allowed entities', async () => {
  const ha = require('../smart_ventilation/app/ha');
  assert.deepEqual([...ha.ACTIONS].sort(), ['fan.set_percentage', 'fan.set_preset_mode', 'number.set_value', 'select.select_option', 'switch.turn_off', 'switch.turn_on']);
  await assert.rejects(ha.callAction({ service: 'fan.set_percentage', data: { percentage: 50 }, target: { entity_id: 'fan.x' } }), /may not be changed/, 'nothing allowed before the policy is set');
  ha.setActionPolicy((e) => e === 'fan.x');
  await assert.rejects(ha.callAction({ service: 'light.turn_on', data: {}, target: { entity_id: 'light.x' } }), /not allowed/);
  await assert.rejects(ha.callAction({ service: 'homeassistant.restart', data: {}, target: { entity_id: 'fan.x' } }), /not allowed/);
  await assert.rejects(ha.callAction({ service: 'number.set_value', data: { value: 1 }, target: { entity_id: 'fan.x' } }), /needs one number entity/);
  await assert.rejects(ha.callAction({ service: 'fan.set_percentage', data: {}, target: { entity_id: ['fan.x', 'fan.y'] } }), /needs one fan entity/);
  await assert.rejects(ha.callAction({ service: 'fan.set_percentage', data: {}, target: { entity_id: 'fan.y' } }), /may not be changed/);
  await assert.rejects(ha.callAction({ service: 'fan.set_percentage', data: { percentage: 50 }, target: { entity_id: 'fan.x' } }), /Not connected/, 'allowed, but not connected here');
});
