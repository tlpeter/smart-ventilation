'use strict';

// Dashboard controls: the YAML package text and reading configuration.yaml.

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../smart_ventilation/app/helpers');

const zones = [
  { id: 'shower', name: 'Douche "1"', riseThreshold: 8, absoluteTrigger: 85, stopMargin: 3, maxBoostMin: 60, afterrunMin: 5 },
  { id: 'bathroom', name: 'Badkamer', riseThreshold: 7.3, absoluteTrigger: 120, stopMargin: 2.5, maxBoostMin: 30, afterrunMin: 0 },
];

test('the package has a mode, a boost button and five numbers per zone', () => {
  const y = helpers.packageYaml(zones, { bathroom: 'off' });
  assert.ok(y.startsWith(helpers.HEADER));
  assert.ok(helpers.isOurFile(y));
  assert.match(y, /^input_select:\n {2}smart_ventilation_shower_mode:/m);
  assert.match(y, /options: \["Auto", "Off"\]/, '"Off" is quoted, or YAML reads it as false');
  assert.match(y, /smart_ventilation_bathroom_mode:\n {4}name: "Badkamer ventilation mode"\n {4}options: \["Auto", "Off"\]\n {4}initial: "Off"/);
  assert.match(y, /smart_ventilation_shower_mode:[\s\S]*?initial: "Auto"/);
  assert.match(y, /^input_button:\n {2}smart_ventilation_shower_boost:/m);
  assert.match(y, /name: "Douche \\"1\\" ventilation mode"/, 'names are quoted safely');
  for (const key of ['rise_trigger', 'safety_net', 'stop_margin', 'max_boost', 'afterrun']) {
    assert.match(y, new RegExp(`smart_ventilation_shower_${key}:`));
  }
  assert.match(y, /smart_ventilation_shower_safety_net:[\s\S]*?initial: 85\n/);
  assert.match(y, /smart_ventilation_bathroom_safety_net:[\s\S]*?initial: 100\n/, 'kept within its range');
  assert.match(y, /smart_ventilation_bathroom_rise_trigger:[\s\S]*?initial: 7.5\n/, 'on its step of 0.5');
  assert.match(y, /smart_ventilation_bathroom_stop_margin:[\s\S]*?initial: 2.5\n/);
  assert.equal(helpers.allEntityIds(zones).length, 14);
});

test('no zones: a file with only the header', () => {
  assert.equal(helpers.packageYaml([]).trim().split('\n').length, 2);
});

test('the packages folder is read from configuration.yaml', () => {
  assert.deepEqual(helpers.packagesDir('homeassistant:\n  packages: !include_dir_named packages\n'), { enabled: true, dir: 'packages' });
  assert.deepEqual(helpers.packagesDir('homeassistant:\n  name: Thuis\n  packages: !include_dir_merge_named "my/packages/"  # comment\n'), { enabled: true, dir: 'my/packages' });
  assert.deepEqual(helpers.packagesDir('default_config:\nhomeassistant:\n  name: Thuis\n'), { enabled: false });
  assert.deepEqual(helpers.packagesDir('homeassistant:\n  packages:\n    mine: !include mine.yaml\n'), { enabled: false, other: true });
  assert.deepEqual(helpers.packagesDir('# packages: !include_dir_named packages\n'), { enabled: false }, 'a comment does not count');
});

test('reading helper states', () => {
  const n = helpers.NUMBERS.find((x) => x.key === 'safety_net');
  assert.equal(helpers.numberValue({ state: '87.0' }, n), 87);
  assert.equal(helpers.numberValue({ state: 'unavailable' }, n), null);
  assert.equal(helpers.numberValue({ state: '150' }, n), 100);
  assert.equal(helpers.modeValue({ state: 'Off' }), 'off');
  assert.equal(helpers.modeValue({ state: 'Auto' }), 'auto');
  assert.equal(helpers.modeValue({ state: 'unknown' }), null);
});
