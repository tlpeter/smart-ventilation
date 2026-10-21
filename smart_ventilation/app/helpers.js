'use strict';

// Dashboard controls as Home Assistant helpers, made in a YAML package.
//
// The app writes ONE file of its own: <config>/<packages dir>/smart_ventilation.yaml
// with per zone an input_select (Auto / Off), an input_button (Boost now) and
// input_numbers for the main settings. It never edits configuration.yaml and
// never calls an action: it only reads the helpers. When a helper changes,
// the app takes the new value and writes it as the helper's "initial" value,
// so it is still there after Home Assistant restarts.
//
// This module only makes text and reads text: no files, no network.

const FILE_NAME = 'smart_ventilation.yaml';
const HEADER = '# Made by the Smart Ventilation app. Do not edit: the app writes this file again.';

// The settings that get a helper. field = the zone setting in settings.json.
const NUMBERS = [
  { key: 'rise_trigger', field: 'riseThreshold', name: 'rise trigger', min: 1, max: 50, step: 0.5, unit: 'points', icon: 'mdi:trending-up' },
  { key: 'safety_net', field: 'absoluteTrigger', name: 'safety net', min: 40, max: 100, step: 1, unit: '%', icon: 'mdi:water-percent-alert' },
  { key: 'stop_margin', field: 'stopMargin', name: 'stop margin', min: 0, max: 20, step: 0.5, unit: 'points', icon: 'mdi:arrow-collapse-down' },
  { key: 'max_boost', field: 'maxBoostMin', name: 'max boost', min: 5, max: 240, step: 1, unit: 'min', icon: 'mdi:timer-outline' },
  { key: 'afterrun', field: 'afterrunMin', name: 'afterrun', min: 0, max: 60, step: 1, unit: 'min', icon: 'mdi:timer-sand' },
];

const MODE_OPTIONS = ['Auto', 'Off'];

function objectId(zoneId, key) {
  return `smart_ventilation_${zoneId}_${key}`;
}

// All helper entity ids of one zone, by kind.
function zoneEntities(zoneId) {
  return {
    mode: `input_select.${objectId(zoneId, 'mode')}`,
    boost: `input_button.${objectId(zoneId, 'boost')}`,
    numbers: NUMBERS.map((n) => ({ ...n, entity_id: `input_number.${objectId(zoneId, n.key)}` })),
  };
}

function allEntityIds(zones) {
  return zones.flatMap((z) => {
    const e = zoneEntities(z.id);
    return [e.mode, e.boost, ...e.numbers.map((n) => n.entity_id)];
  });
}

// A YAML string in double quotes (names may contain anything).
function q(text) {
  return JSON.stringify(String(text));
}

function clampToStep(v, n) {
  const x = Math.min(n.max, Math.max(n.min, Number(v)));
  return Math.round((x - n.min) / n.step) * n.step + n.min;
}

function num(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

// The package file for these zones. modes: { zoneId: 'auto' | 'off' }.
function packageYaml(zones, modes = {}) {
  const lines = [HEADER, '# Dashboard controls for each zone. Turn this off in the app: Settings › General.', ''];
  if (!zones.length) return `${lines.join('\n')}\n`;
  lines.push('input_select:');
  for (const z of zones) {
    lines.push(`  ${objectId(z.id, 'mode')}:`);
    lines.push(`    name: ${q(`${z.name} ventilation mode`)}`);
    lines.push(`    options: [${MODE_OPTIONS.map(q).join(', ')}]`);
    lines.push(`    initial: ${q(modes[z.id] === 'off' ? 'Off' : 'Auto')}`);
    lines.push('    icon: mdi:fan');
  }
  lines.push('', 'input_button:');
  for (const z of zones) {
    lines.push(`  ${objectId(z.id, 'boost')}:`);
    lines.push(`    name: ${q(`${z.name} boost now`)}`);
    lines.push('    icon: mdi:fan-plus');
  }
  lines.push('', 'input_number:');
  for (const z of zones) {
    for (const n of NUMBERS) {
      lines.push(`  ${objectId(z.id, n.key)}:`);
      lines.push(`    name: ${q(`${z.name} ${n.name}`)}`);
      lines.push(`    min: ${num(n.min)}`);
      lines.push(`    max: ${num(n.max)}`);
      lines.push(`    step: ${num(n.step)}`);
      lines.push(`    initial: ${num(clampToStep(z[n.field], n))}`);
      lines.push(`    unit_of_measurement: ${q(n.unit)}`);
      lines.push('    mode: box');
      lines.push(`    icon: ${n.icon}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function isOurFile(text) {
  return typeof text === 'string' && text.startsWith(HEADER);
}

// Where packages are loaded from, read from configuration.yaml.
// Returns { enabled, dir } (dir relative to the config folder), or
// { enabled: false } when there is no packages line we can use.
function packagesDir(configurationYaml) {
  const text = String(configurationYaml || '');
  const m = text.match(/^[ \t]+packages[ \t]*:[ \t]*!include_dir_(?:merge_)?named[ \t]+["']?([^\s"'#]+)["']?/m);
  if (m) return { enabled: true, dir: m[1].replace(/\/+$/, '') };
  if (/^[ \t]+packages[ \t]*:/m.test(text)) return { enabled: false, other: true };
  return { enabled: false };
}

const SNIPPET = 'homeassistant:\n  packages: !include_dir_named packages';

// A helper's state as a value for the app. Returns null when it is unknown.
function numberValue(state, n) {
  const v = Number(state && state.state);
  if (!state || state.state === '' || !Number.isFinite(v)) return null;
  return Math.min(n.max, Math.max(n.min, v));
}

function modeValue(state) {
  if (!state) return null;
  if (state.state === 'Off') return 'off';
  if (state.state === 'Auto') return 'auto';
  return null;
}

module.exports = { FILE_NAME, HEADER, NUMBERS, SNIPPET, zoneEntities, allEntityIds, packageYaml, isOurFile, packagesDir, numberValue, modeValue };
