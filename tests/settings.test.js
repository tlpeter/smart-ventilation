'use strict';

// Cleaning up and checking the settings sent from the page.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-settings-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../smart_ventilation/app/settings');
const { describeEntity } = require('../smart_ventilation/app/actuators');

const meta = new Map([
  ['sensor.shower_humidity', describeEntity({ entity_id: 'sensor.shower_humidity', state: '55', attributes: { device_class: 'humidity', unit_of_measurement: '%' } })],
  ['sensor.hall_humidity', describeEntity({ entity_id: 'sensor.hall_humidity', state: '52', attributes: { device_class: 'humidity', unit_of_measurement: '%' } })],
  ['fan.open_air_mini', describeEntity({ entity_id: 'fan.open_air_mini', state: 'on', attributes: { percentage: 10, percentage_step: 1, supported_features: 49 } })],
]);

test('normalise: ids, defaults, bounds and unknown actuators', () => {
  const s = settings.normalise({
    actuators: [{ name: 'Ventilation unit', type: 'fan', entity: 'fan.open_air_mini', idle: '10', boost: 75, afterrun: 50 }],
    zones: [
      { name: 'Shower', humidity: 'sensor.shower_humidity', actuators: ['ventilation_unit', 'nope'], riseThreshold: 500 },
      { name: 'Shower', humidity: 'not an entity' },
    ],
    general: { references: ['sensor.hall_humidity', 'sensor.hall_humidity'], nightStart: '25:00', sensorTimeoutMin: 1 },
    extra: 'ignored',
  });
  assert.equal(s.actuators[0].id, 'ventilation_unit');
  assert.equal(s.actuators[0].idle, 10, 'number strings become numbers');
  assert.deepEqual(s.zones[0].actuators, ['ventilation_unit']);
  assert.equal(s.zones[0].riseThreshold, 50);
  assert.equal(s.zones[0].stopMargin, 3);
  assert.equal(s.zones[1].id, 'shower_2');
  assert.equal(s.zones[1].humidity, null);
  assert.deepEqual(s.general.references, ['sensor.hall_humidity']);
  assert.equal(s.general.nightStart, '23:00');
  assert.equal(s.general.sensorTimeoutMin, 5);
  assert.equal(s.extra, undefined);
});

test('validate: a good set-up has no problems', () => {
  const s = settings.normalise({
    actuators: [{ id: 'unit', name: 'Unit', type: 'fan', entity: 'fan.open_air_mini', idle: 10, boost: 75, afterrun: 50 }],
    zones: [{ name: 'Shower', humidity: 'sensor.shower_humidity', actuators: ['unit'] }],
    general: { references: ['sensor.hall_humidity'] },
  });
  assert.deepEqual(settings.validate(s, meta), []);
});

test('validate: missing pieces are explained', () => {
  const s = settings.normalise({
    actuators: [{ id: 'unit', name: 'Unit', type: 'fan', entity: 'fan.gone', idle: 10, boost: 75, afterrun: 50 }],
    zones: [
      { name: 'Shower', humidity: 'sensor.shower_humidity', actuators: [], minBoostMin: 30, maxBoostMin: 10 },
      { name: 'Bath', actuators: ['unit'] },
    ],
    general: { references: ['sensor.shower_humidity'] },
  });
  const errors = settings.validate(s, meta).join('\n');
  assert.match(errors, /Shower: choose at least one actuator/);
  assert.match(errors, /minimum boost time is longer/);
  assert.match(errors, /Bath: choose a humidity sensor/);
  assert.match(errors, /fan.gone was not found/);
  assert.match(errors, /also a zone sensor/);
});

test('save writes settings.json', () => {
  settings.save({ zones: [{ name: 'Shower' }] });
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(onDisk.zones[0].name, 'Shower');
  assert.equal(settings.get().zones[0].id, 'shower');
});
