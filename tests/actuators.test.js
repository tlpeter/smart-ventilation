'use strict';

// Fan and valves: shared actuators, restricted valves, night maximum,
// validation against the entity, and the actions the app would send.

const test = require('node:test');
const assert = require('node:assert/strict');
const act = require('../smart_ventilation/app/actuators');

const fan = { id: 'fan', name: 'Unit', type: 'fan', entity: 'fan.open_air_mini', fanMode: 'percentage', idle: 10, boost: 75, afterrun: 50, restricted: '', nightMax: 40 };
const vShower = { id: 'v_shower', name: 'Shower valve', type: 'number', entity: 'number.shower_valve_capacity', idle: 50, boost: 100, afterrun: 75, restricted: 10, nightMax: '' };
const vBath = { id: 'v_bath', name: 'Bathroom valve', type: 'number', entity: 'number.bath_valve_capacity', idle: 50, boost: 100, afterrun: 75, restricted: 10, nightMax: '' };
const zones = [
  { id: 'shower', name: 'Shower', actuators: ['fan', 'v_shower'] },
  { id: 'bathroom', name: 'Bathroom', actuators: ['fan', 'v_bath'] },
];
const all = [fan, vShower, vBath];

test('all at rest when no zone is active', () => {
  const d = act.decide(all, zones, { shower: 'idle', bathroom: 'idle' }, false);
  assert.equal(d.fan.value, 10);
  assert.equal(d.v_shower.value, 50);
  assert.equal(d.v_bath.value, 50);
});

test('shower boosts: fan and shower valve to boost, bathroom valve restricted', () => {
  const d = act.decide(all, zones, { shower: 'boost', bathroom: 'idle' }, false);
  assert.equal(d.fan.value, 75);
  assert.equal(d.v_shower.value, 100);
  assert.equal(d.v_bath.value, 10);
  assert.equal(d.v_bath.level, 'restricted');
  assert.match(d.v_bath.why, /Shower is boosting/);
});

test('a shared fan gets the highest demand', () => {
  const d = act.decide(all, zones, { shower: 'boost', bathroom: 'afterrun' }, false);
  assert.equal(d.fan.value, 75);
  assert.equal(d.fan.level, 'boost');
  assert.match(d.fan.why, /highest of Shower, Bathroom/);
  assert.equal(d.v_bath.value, 75, 'own afterrun beats restricted');
});

test('both zones boost: both valves open', () => {
  const d = act.decide(all, zones, { shower: 'boost', bathroom: 'boost' }, false);
  assert.equal(d.v_shower.value, 100);
  assert.equal(d.v_bath.value, 100);
});

test('more zones boost: the shared fan goes to its "more zones" value', () => {
  const f = { ...fan, multiBoost: 80 };
  const both = act.decide([f, vShower, vBath], zones, { shower: 'boost', bathroom: 'boost' }, false);
  assert.equal(both.fan.value, 80);
  assert.equal(both.fan.level, 'boost');
  assert.match(both.fan.why, /Shower, Bathroom: boost \(more zones\)/);
  assert.equal(both.v_shower.value, 100, 'valves keep their own boost');
  assert.equal(act.decide([f], zones, { shower: 'boost', bathroom: 'idle' }, false).fan.value, 75, 'one zone: boost');
  assert.equal(act.decide([f], zones, { shower: 'boost', bathroom: 'afterrun' }, false).fan.value, 75, 'boost + afterrun: boost');
  assert.equal(act.decide([fan], zones, { shower: 'boost', bathroom: 'boost' }, false).fan.value, 75, 'empty: boost, as before');
  assert.equal(act.decide([f], zones, { shower: 'boost', bathroom: 'boost' }, true).fan.value, 40, 'the night maximum still caps it');
  const off = [{ ...zones[0] }, { ...zones[1], enabled: false }];
  assert.equal(act.decide([f], off, { shower: 'boost', bathroom: 'boost' }, false).fan.value, 75, 'a zone that is off does not count');
});

test('more zones boost: checked against the entity and boost', () => {
  const meta = act.describeEntity({ entity_id: 'fan.open_air_mini', state: 'on', attributes: { percentage: 10, percentage_step: 1, supported_features: 49 } });
  const ok = { ...fan, nightMax: '', multiBoost: 80 };
  assert.deepEqual(act.validateActuator(ok, meta), []);
  assert.ok(act.validateActuator({ ...ok, multiBoost: 70 }, meta).some((e) => /lower than boost/.test(e)));
  assert.ok(act.validateActuator({ ...ok, multiBoost: 120 }, meta).some((e) => /outside 0–100/.test(e)));
  assert.equal(act.hasMulti({ ...ok, fanMode: 'preset' }), false, 'not for a preset fan');
});

test('a fault counts as rest', () => {
  const d = act.decide(all, zones, { shower: 'fault', bathroom: 'idle' }, false);
  assert.equal(d.fan.value, 10);
});

test('a zone that is switched off asks for nothing', () => {
  const z = [{ ...zones[0], enabled: false }, zones[1]];
  const d = act.decide(all, z, { shower: 'boost', bathroom: 'idle' }, false);
  assert.equal(d.fan.value, 10);
  assert.equal(d.v_bath.value, 50);
});

test('night maximum caps numeric values', () => {
  const d = act.decide(all, zones, { shower: 'boost', bathroom: 'idle' }, true);
  assert.equal(d.fan.value, 40);
  assert.equal(d.fan.night, true);
  assert.equal(d.v_shower.value, 100, 'no night maximum set');
});

test('select and switch actuators use the level order', () => {
  const sel = { id: 's', name: 'Box', type: 'select', entity: 'select.box', idle: 'low', boost: 'high', afterrun: 'medium', restricted: '' };
  const sw = { id: 'w', name: 'Fan', type: 'switch', entity: 'switch.fan', idle: 'off', boost: 'on', afterrun: 'on', restricted: '' };
  const z = [{ id: 'a', name: 'A', actuators: ['s', 'w'] }, { id: 'b', name: 'B', actuators: ['s'] }];
  const d = act.decide([sel, sw], z, { a: 'afterrun', b: 'boost' }, false);
  assert.equal(d.s.value, 'high');
  assert.equal(d.w.value, 'on');
});

test('commands for every type', () => {
  assert.deepEqual(act.commandFor(fan, 75), { service: 'fan.set_percentage', data: { percentage: 75 }, target: { entity_id: 'fan.open_air_mini' } });
  assert.equal(act.commandFor({ ...fan, fanMode: 'preset' }, 'high').service, 'fan.set_preset_mode');
  assert.deepEqual(act.commandFor(vShower, 100).data, { value: 100 });
  assert.equal(act.commandFor({ type: 'select', entity: 'select.x' }, 'high').data.option, 'high');
  assert.equal(act.commandFor({ type: 'switch', entity: 'switch.x' }, 'off').service, 'switch.turn_off');
});

// The Open AIR Mini as Home Assistant reports it: percentage only.
const fanState = { entity_id: 'fan.open_air_mini', state: 'on', attributes: { friendly_name: 'Open AIR Mini', percentage: 10, percentage_step: 1, preset_modes: null, supported_features: 49 } };
const valveState = { entity_id: 'number.shower_valve_capacity', state: '50', attributes: { min: 0, max: 100, step: 1, unit_of_measurement: '%' } };

test('describeEntity reads fan features and number ranges', () => {
  const f = act.describeEntity(fanState);
  assert.equal(f.percentage, true);
  assert.deepEqual(f.presets, []);
  assert.equal(f.step, 1);
  const v = act.describeEntity(valveState);
  assert.equal(v.min, 0);
  assert.equal(v.max, 100);
  assert.equal(act.currentValue(fan, fanState), 10);
  assert.equal(act.currentValue(fan, { ...fanState, state: 'off' }), 0);
  assert.equal(act.currentValue(vShower, valveState), 50);
});

test('validation against the entity', () => {
  assert.deepEqual(act.validateActuator(fan, act.describeEntity(fanState)), []);
  const presetErrors = act.validateActuator({ ...fan, fanMode: 'preset', idle: 'low', boost: 'high', afterrun: 'medium' }, act.describeEntity(fanState));
  assert.ok(presetErrors.some((e) => /no presets/.test(e)));
  const out = act.validateActuator({ ...vShower, boost: 120 }, act.describeEntity(valveState));
  assert.ok(out.some((e) => /outside 0–100/.test(e)));
  const empty = act.validateActuator({ ...vShower, idle: '' }, act.describeEntity(valveState));
  assert.ok(empty.some((e) => /idle needs a number/.test(e)));
  assert.ok(act.validateActuator({ ...vShower, entity: 'fan.open_air_mini' }, act.describeEntity(fanState)).some((e) => /not a number entity/.test(e)));
  assert.ok(act.validateActuator(vShower, undefined).some((e) => /not found/.test(e)));
});
