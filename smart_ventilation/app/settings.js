'use strict';

// The settings made in the app (zones, actuators, reference sensors, night
// window). Stored in /data/settings.json. Nothing here is hardcoded to one
// brand: every entity is chosen on the Settings page.

const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonstore');
const { DATA_DIR } = require('./options');
const { ZONE_DEFAULTS } = require('./engine');
const { TYPES, validateActuator } = require('./actuators');

const FILE = path.join(DATA_DIR, 'settings.json');
const MAX_ZONES = 8;
const MAX_ACTUATORS = 16;
const MAX_REFERENCES = 10;

const GENERAL_DEFAULTS = {
  references: [],
  nightEnabled: false,
  nightStart: '23:00',
  nightEnd: '07:00',
  sensorTimeoutMin: 60,
  dashboardHelpers: false,
  liveControl: false,
};

function slug(text, used) {
  let base = String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'item';
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
function entityOrNull(v) {
  const s = String(v || '').trim();
  return ENTITY_RE.test(s) ? s : null;
}

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function time(v, fallback) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : fallback;
}

// A value for one level: a number for numeric actuators, else a string.
function levelValue(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return v;
  const s = String(v).trim().slice(0, 64);
  return s !== '' && Number.isFinite(Number(s)) ? Number(s) : s;
}

// Clean up settings sent from the page: right types, known keys only.
function normalise(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const usedA = new Set();
  const actuators = (Array.isArray(src.actuators) ? src.actuators : []).slice(0, MAX_ACTUATORS).map((a) => {
    const type = TYPES.includes(a && a.type) ? a.type : 'fan';
    const id = a && /^[a-z0-9_]{1,40}$/.test(a.id || '') && !usedA.has(a.id) ? (usedA.add(a.id), a.id) : slug(a && a.name, usedA);
    return {
      id,
      name: String((a && a.name) || 'Actuator').slice(0, 40),
      type,
      entity: entityOrNull(a && a.entity),
      fanMode: type === 'fan' && a && a.fanMode === 'preset' ? 'preset' : 'percentage',
      idle: levelValue(a && a.idle),
      boost: levelValue(a && a.boost),
      afterrun: levelValue(a && a.afterrun),
      restricted: levelValue(a && a.restricted),
      nightMax: levelValue(a && a.nightMax),
      // Optional: the value when two or more of its zones boost at once.
      multiBoost: levelValue(a && a.multiBoost),
      // With Live control on: may the app set this one? (Off = advice only.)
      live: !(a && a.live === false),
    };
  });
  const actuatorIds = new Set(actuators.map((a) => a.id));
  const usedZ = new Set();
  const zones = (Array.isArray(src.zones) ? src.zones : []).slice(0, MAX_ZONES).map((z) => {
    const id = z && /^[a-z0-9_]{1,40}$/.test(z.id || '') && !usedZ.has(z.id) ? (usedZ.add(z.id), z.id) : slug(z && z.name, usedZ);
    const d = ZONE_DEFAULTS;
    return {
      id,
      name: String((z && z.name) || 'Zone').slice(0, 40),
      enabled: !(z && z.enabled === false),
      humidity: entityOrNull(z && z.humidity),
      temperature: entityOrNull(z && z.temperature),
      actuators: [...new Set((Array.isArray(z && z.actuators) ? z.actuators : []).filter((x) => actuatorIds.has(x)))],
      riseThreshold: num(z && z.riseThreshold, d.riseThreshold, 1, 50),
      riseWindowMin: num(z && z.riseWindowMin, d.riseWindowMin, 1, 30),
      absoluteTrigger: num(z && z.absoluteTrigger, d.absoluteTrigger, 40, 100),
      stopMargin: num(z && z.stopMargin, d.stopMargin, 0, 20),
      minBoostMin: num(z && z.minBoostMin, d.minBoostMin, 0, 60),
      maxBoostMin: num(z && z.maxBoostMin, d.maxBoostMin, 5, 240),
      afterrunMin: num(z && z.afterrunMin, d.afterrunMin, 0, 60),
      baselineWindowMin: num(z && z.baselineWindowMin, d.baselineWindowMin, 15, 120),
      confirmWithTemperature: !!(z && z.confirmWithTemperature),
      temperatureRise: num(z && z.temperatureRise, d.temperatureRise, 0.1, 10),
    };
  });
  const g = src.general && typeof src.general === 'object' ? src.general : {};
  const general = {
    references: [...new Set((Array.isArray(g.references) ? g.references : []).map(entityOrNull).filter(Boolean))].slice(0, MAX_REFERENCES),
    nightEnabled: g.nightEnabled === true,
    nightStart: time(g.nightStart, GENERAL_DEFAULTS.nightStart),
    nightEnd: time(g.nightEnd, GENERAL_DEFAULTS.nightEnd),
    sensorTimeoutMin: num(g.sensorTimeoutMin, GENERAL_DEFAULTS.sensorTimeoutMin, 5, 720),
    dashboardHelpers: g.dashboardHelpers === true,
    // Off by default: the app only shows what it would set.
    liveControl: g.liveControl === true,
  };
  return { version: 1, zones, actuators, general };
}

// Check settings against the entities in Home Assistant.
// meta: Map entity_id -> describeEntity(). Returns a list of problems.
function validate(s, meta) {
  const errors = [];
  for (const z of s.zones) {
    if (z.minBoostMin > z.maxBoostMin) errors.push(`${z.name}: minimum boost time is longer than the maximum`);
    if (!z.humidity) { errors.push(`${z.name}: choose a humidity sensor`); continue; }
    const m = meta.get(z.humidity);
    if (!m) errors.push(`${z.name}: ${z.humidity} was not found in Home Assistant`);
    else if (m.domain !== 'sensor') errors.push(`${z.name}: ${z.humidity} is not a sensor`);
    if (z.temperature && !meta.get(z.temperature)) errors.push(`${z.name}: ${z.temperature} was not found in Home Assistant`);
    if (!z.actuators.length) errors.push(`${z.name}: choose at least one actuator`);
  }
  for (const a of s.actuators) errors.push(...validateActuator(a, meta.get(a.entity)));
  for (const r of s.general.references) {
    if (!meta.get(r)) errors.push(`Reference ${r} was not found in Home Assistant`);
    if (s.zones.some((z) => z.humidity === r)) errors.push(`Reference ${r} is also a zone sensor; choose sensors in other rooms`);
  }
  return errors;
}

let current = normalise(readJson(FILE, {}));

function get() { return current; }

function save(next) {
  current = normalise(next);
  writeJsonAtomic(FILE, current);
  return current;
}

module.exports = { get, save, normalise, validate, GENERAL_DEFAULTS };
