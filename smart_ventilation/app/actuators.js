'use strict';

// Actuators: the things that move air (a fan) or steer where it comes from
// (a valve). Each actuator has a value per level: idle, boost, afterrun,
// restricted (while another zone boosts), an optional "more zones boost"
// value (numbers and fan percentage) and an optional night maximum.
//
// This module works out the value every actuator should have, and the Home
// Assistant action that sets it. With Live control off the app only shows
// that action as advice; with Live control on server.js sends it.

const TYPES = ['fan', 'number', 'select', 'switch'];
const LEVEL_RANK = { idle: 0, restricted: 0, afterrun: 1, boost: 2 };

// Fan feature flags from Home Assistant.
const FAN_SET_SPEED = 1;
const FAN_PRESET_MODE = 8;

function isNumeric(act) {
  return act.type === 'number' || (act.type === 'fan' && act.fanMode !== 'preset');
}

// What the settings page needs to know about an entity.
function describeEntity(s) {
  const a = (s && s.attributes) || {};
  const domain = String(s.entity_id).split('.')[0];
  const out = { entity_id: s.entity_id, name: a.friendly_name || s.entity_id, domain, state: s.state };
  if (domain === 'sensor') {
    out.device_class = a.device_class || null;
    out.unit = a.unit_of_measurement || null;
  } else if (domain === 'fan') {
    const f = Number(a.supported_features) || 0;
    out.percentage = (f & FAN_SET_SPEED) !== 0;
    out.presets = (f & FAN_PRESET_MODE) !== 0 && Array.isArray(a.preset_modes) ? a.preset_modes.filter((p) => typeof p === 'string') : [];
    out.step = Number(a.percentage_step) || 1;
    out.min = 0;
    out.max = 100;
  } else if (domain === 'number') {
    out.min = Number.isFinite(Number(a.min)) ? Number(a.min) : 0;
    out.max = Number.isFinite(Number(a.max)) ? Number(a.max) : 100;
    out.step = Number(a.step) || 1;
    out.unit = a.unit_of_measurement || null;
  } else if (domain === 'select') {
    out.options = Array.isArray(a.options) ? a.options.filter((o) => typeof o === 'string') : [];
  }
  return out;
}

// Check one actuator against its entity. Returns a list of problems (empty = ok).
function validateActuator(act, meta) {
  const errors = [];
  const label = act.name || act.entity || 'Actuator';
  if (!TYPES.includes(act.type)) errors.push(`${label}: unknown type "${act.type}"`);
  if (!act.entity) { errors.push(`${label}: choose an entity`); return errors; }
  if (String(act.entity).split('.')[0] !== act.type) errors.push(`${label}: ${act.entity} is not a ${act.type} entity`);
  if (!meta) { errors.push(`${label}: ${act.entity} was not found in Home Assistant`); return errors; }
  const levels = ['idle', 'boost', 'afterrun'];
  if (act.restricted !== null && act.restricted !== undefined && act.restricted !== '') levels.push('restricted');
  if (act.type === 'fan' && act.fanMode === 'preset') {
    if (!meta.presets || !meta.presets.length) errors.push(`${label}: this fan has no presets, use percentage`);
    for (const l of levels) {
      if (!meta.presets.includes(act[l])) errors.push(`${label}: "${act[l]}" is not a preset of this fan (${l})`);
    }
  } else if (isNumeric(act)) {
    if (act.type === 'fan' && meta.percentage === false) errors.push(`${label}: this fan does not support a speed percentage`);
    const lv = [...levels];
    if (act.nightMax !== null && act.nightMax !== undefined && act.nightMax !== '') lv.push('nightMax');
    if (hasMulti(act)) lv.push('multiBoost');
    for (const l of lv) {
      const v = Number(act[l]);
      if (act[l] === '' || act[l] === null || act[l] === undefined || !Number.isFinite(v)) errors.push(`${label}: ${l} needs a number`);
      else if (v < meta.min || v > meta.max) errors.push(`${label}: ${l} ${v} is outside ${meta.min}–${meta.max}`);
    }
    if (hasMulti(act) && Number(act.multiBoost) < Number(act.boost)) errors.push(`${label}: "when more zones boost" (${act.multiBoost}) is lower than boost (${act.boost})`);
  } else if (act.type === 'select') {
    for (const l of levels) {
      if (!meta.options.includes(act[l])) errors.push(`${label}: "${act[l]}" is not an option of ${act.entity} (${l})`);
    }
  } else if (act.type === 'switch') {
    for (const l of levels) {
      if (act[l] !== 'on' && act[l] !== 'off') errors.push(`${label}: ${l} must be on or off`);
    }
  }
  return errors;
}

// Is the "when more zones boost" value set? Only for numeric actuators.
function hasMulti(act) {
  return isNumeric(act) && act.multiBoost !== null && act.multiBoost !== undefined && act.multiBoost !== '';
}

function valueOf(act, level) {
  const v = act[level];
  return isNumeric(act) ? Number(v) : v;
}

// Decide the value of every actuator.
// zones: [{ id, name, actuators: [ids] }]; zoneStates: { [zoneId]: 'idle'|'boost'|... }
// Returns { [actuatorId]: { level, value, why, night } }.
function decide(actuators, zones, zoneStates, isNight) {
  const out = {};
  const levelOfZone = (st) => (st === 'boost' ? 'boost' : st === 'afterrun' ? 'afterrun' : 'idle');
  const activeZones = zones.filter((z) => z.enabled !== false && ['boost', 'afterrun'].includes(zoneStates[z.id]));
  for (const act of actuators) {
    const mine = zones.filter((z) => z.enabled !== false && (z.actuators || []).includes(act.id));
    const demands = mine.map((z) => ({ zone: z, level: levelOfZone(zoneStates[z.id]) })).filter((d) => d.level !== 'idle');
    let level = 'idle';
    let value = valueOf(act, 'idle');
    let why = 'No zone needs it';
    if (demands.length) {
      // Shared actuator: the highest demand wins.
      let best = null;
      for (const d of demands) {
        const v = valueOf(act, d.level);
        const better = !best || (isNumeric(act) ? v > best.value : LEVEL_RANK[d.level] > LEVEL_RANK[best.level]);
        if (better) best = { level: d.level, value: v, zone: d.zone };
      }
      level = best.level;
      value = best.value;
      why = `${best.zone.name}: ${best.level}`;
      if (demands.length > 1) why += ` (highest of ${demands.map((d) => d.zone.name).join(', ')})`;
      // Two or more of its zones boost at the same time: the higher value.
      const boosting = demands.filter((d) => d.level === 'boost');
      if (boosting.length > 1 && hasMulti(act) && Number(act.multiBoost) > value) {
        value = Number(act.multiBoost);
        why = `${boosting.map((d) => d.zone.name).join(', ')}: boost (more zones)`;
      }
    } else if (act.restricted !== null && act.restricted !== undefined && act.restricted !== '' && mine.length) {
      const others = activeZones.filter((z) => !mine.includes(z));
      if (others.length) {
        level = 'restricted';
        value = valueOf(act, 'restricted');
        why = `${others.map((z) => z.name).join(', ')} is boosting`;
      }
    }
    let night = false;
    const cap = act.nightMax;
    if (isNight && isNumeric(act) && cap !== null && cap !== undefined && cap !== '' && value > Number(cap)) {
      value = Number(cap);
      night = true;
      why += `, capped at ${cap} at night`;
    }
    out[act.id] = { level, value, why, night };
  }
  return out;
}

// The Home Assistant action that would set this value.
function commandFor(act, value) {
  const target = { entity_id: act.entity };
  if (act.type === 'fan') {
    if (act.fanMode === 'preset') return { service: 'fan.set_preset_mode', data: { preset_mode: value }, target };
    return { service: 'fan.set_percentage', data: { percentage: Number(value) }, target };
  }
  if (act.type === 'number') return { service: 'number.set_value', data: { value: Number(value) }, target };
  if (act.type === 'select') return { service: 'select.select_option', data: { option: value }, target };
  if (act.type === 'switch') return { service: value === 'on' ? 'switch.turn_on' : 'switch.turn_off', data: {}, target };
  return null;
}

// The value the actuator has now, read from its Home Assistant state.
function currentValue(act, s) {
  if (!s) return null;
  const a = s.attributes || {};
  if (act.type === 'fan') {
    if (act.fanMode === 'preset') return a.preset_mode || null;
    if (s.state === 'off') return 0;
    return Number.isFinite(Number(a.percentage)) ? Number(a.percentage) : null;
  }
  if (act.type === 'number') return Number.isFinite(Number(s.state)) ? Number(s.state) : null;
  if (act.type === 'select') return s.state;
  if (act.type === 'switch') return s.state === 'on' || s.state === 'off' ? s.state : null;
  return null;
}

module.exports = { TYPES, describeEntity, validateActuator, decide, commandFor, currentValue, isNumeric, valueOf, hasMulti };
