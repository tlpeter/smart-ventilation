'use strict';

// Smart Ventilation: the web server and the loop that follows the sensors.
//
// DRY-RUN ONLY: this version works out what the fan and valves should do and
// shows it as advice. It never sends anything to them.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ha = require('./ha');
const { options, DATA_DIR } = require('./options');
const settings = require('./settings');
const engine = require('./engine');
const chart = require('./chart');
const actuators = require('./actuators');
const { readJson, writeJsonAtomic } = require('./jsonstore');
const { createDashboard } = require('./dashboard');

const PORT = Number(process.env.SV_PORT) || 8099; // SV_PORT: tests only
const TICK_MS = Math.max(50, Number(process.env.SV_TICK_MS) || 30000);
const PUBLISH_EVERY_MS = 5 * 60 * 1000;
const LOG_MAX = 500;
const APP_VERSION = require('./package.json').version;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/unsaved.js', ['unsaved.js', 'application/javascript; charset=utf-8']],
  ['/logo.svg', ['logo.svg', 'image/svg+xml']],
]);
const LOG_FILE = path.join(DATA_DIR, 'log.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');

// ---------------------------------------------------------------------------
// What the app knows
// ---------------------------------------------------------------------------

const entityStates = new Map(); // entity_id -> HA state object
const histories = new Map(); // entity_id -> [{ t, v }]
let referenceHistory = []; // median of the reference sensors over time
let zoneStates = {}; // zone id -> engine state
let advice = {}; // actuator id -> { level, value, why, night, command }
let logEntries = readJson(LOG_FILE, []);
if (!Array.isArray(logEntries)) logEntries = [];
const lastPublished = new Map(); // entity_id -> { value, at }
let started = false;

function now() { return Date.now(); }

function restoreRuntime() {
  const saved = readJson(RUNTIME_FILE, null);
  const s = settings.get();
  zoneStates = {};
  for (const z of s.zones) {
    const old = saved && saved.zones && saved.zones[z.id];
    // A boost that was running when the app stopped continues, if it is
    // not older than the maximum boost time.
    const fresh = old && Number.isFinite(old.since) && now() - old.since < z.maxBoostMin * engine.MIN;
    zoneStates[z.id] = fresh && ['boost', 'afterrun'].includes(old.state) ? { ...engine.newZoneState(now()), ...old } : engine.newZoneState(now());
    // Keep the safety-net lock: after a boost that ran its maximum time, the
    // absolute trigger waits until the room is clearly drier. A restart (for
    // example an update) must not start a new boost because of it.
    if (old && old.absLatch === true) zoneStates[z.id].absLatch = true;
    // Keep Off, and a boost by hand that is still running.
    if (old && old.mode === 'off') zoneStates[z.id].mode = 'off';
    else if (old && old.mode === 'boost' && fresh && old.state === 'boost') zoneStates[z.id].mode = 'boost';
    else zoneStates[z.id].mode = 'auto';
  }
}

function saveRuntime() {
  try { writeJsonAtomic(RUNTIME_FILE, { savedAt: now(), zones: zoneStates }); } catch (err) { ha.warn('Could not save state:', err.message); }
}

function addLog(entry) {
  logEntries.push({ t: now(), ...entry });
  if (logEntries.length > LOG_MAX) logEntries.splice(0, logEntries.length - LOG_MAX);
  try { writeJsonAtomic(LOG_FILE, logEntries); } catch (err) { ha.warn('Could not save log:', err.message); }
}

// Entities the app follows: zone sensors and reference sensors.
function trackedEntities() {
  const s = settings.get();
  const set = new Set();
  for (const z of s.zones) {
    if (z.humidity) set.add(z.humidity);
    if (z.temperature) set.add(z.temperature);
  }
  for (const r of s.general.references) set.add(r);
  return set;
}

function sampleTime(st) {
  const iso = st && (st.last_reported || st.last_updated);
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : now();
}

function numericState(st) {
  if (!st) return null;
  const v = Number(st.state);
  return st.state !== '' && st.state !== null && Number.isFinite(v) ? v : null;
}

function history(id) {
  if (!histories.has(id)) histories.set(id, []);
  return histories.get(id);
}

function addReferenceSample(t) {
  const values = settings.get().general.references
    .map((r) => engine.valueAt(history(r), t))
    .filter((v) => v !== null);
  const m = engine.median(values);
  if (m !== null) engine.addSample(referenceHistory, t, Math.round(m * 10) / 10, now());
}

// Rebuild the reference history from the separate sensor histories.
function rebuildReference() {
  referenceHistory = [];
  const refs = settings.get().general.references;
  const times = [...new Set(refs.flatMap((r) => history(r).map((x) => x.t)))].sort((a, b) => a - b);
  for (const t of times) addReferenceSample(t);
}

function onState(entityId, st) {
  if (st) entityStates.set(entityId, st);
  else entityStates.delete(entityId);
  if (started) dashboard.onState(entityId, st);
  if (!trackedEntities().has(entityId)) return;
  const v = numericState(st);
  if (v !== null) {
    const t = sampleTime(st);
    engine.addSample(history(entityId), t, v, now());
    if (settings.get().general.references.includes(entityId)) addReferenceSample(t);
  }
  evaluate();
}

async function loadHistory() {
  const ids = [...trackedEntities()];
  if (!ids.length) return;
  const start = new Date(now() - 3 * 60 * engine.MIN).toISOString();
  try {
    const result = await ha.getHistory(ids, start);
    for (const id of ids) {
      const h = [];
      for (const row of (result && result[id]) || []) {
        const v = Number(row.s !== undefined ? row.s : row.state);
        const tRaw = row.lu !== undefined ? row.lu * 1000 : Date.parse(row.last_updated || '');
        if (Number.isFinite(v) && Number.isFinite(tRaw)) engine.addSample(h, Math.round(tRaw), v, now());
      }
      // Live samples received meanwhile come after the history.
      for (const s of history(id)) engine.addSample(h, s.t, s.v, now());
      histories.set(id, h);
    }
    rebuildReference();
    ha.log('Loaded recent history for', ids.length, 'sensors');
  } catch (err) {
    ha.warn('Could not read history:', err.message);
  }
}

async function loadStates() {
  const list = await ha.getStates();
  entityStates.clear();
  for (const st of list || []) entityStates.set(st.entity_id, st);
  for (const id of trackedEntities()) {
    const st = entityStates.get(id);
    const v = numericState(st);
    if (v !== null) engine.addSample(history(id), sampleTime(st), v, now());
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function localMinutes(t) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: ha.state.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
    const get = (k) => Number(parts.find((p) => p.type === k).value);
    return get('hour') * 60 + get('minute');
  } catch {
    const d = new Date(t);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

function localDay(t) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: ha.state.timeZone }).format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

function isNight(t) {
  const g = settings.get().general;
  if (!g.nightEnabled) return false;
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const m = localMinutes(t);
  const a = toMin(g.nightStart);
  const b = toMin(g.nightEnd);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

function humidityInput(z, t) {
  const g = settings.get().general;
  const st = z.humidity ? entityStates.get(z.humidity) : null;
  let ok = true;
  let problem = null;
  if (!z.humidity) { ok = false; problem = 'No humidity sensor chosen'; }
  else if (!st) { ok = false; problem = `${z.humidity} not found`; }
  else if (numericState(st) === null) { ok = false; problem = `${z.humidity} is ${st.state}`; }
  else if (t - sampleTime(st) > g.sensorTimeoutMin * engine.MIN) {
    ok = false;
    problem = `No reading from ${z.humidity} for more than ${g.sensorTimeoutMin} min`;
  }
  return { history: z.humidity ? history(z.humidity) : [], ok, problem };
}

function zoneInput(z, t) {
  return {
    now: t,
    humidity: humidityInput(z, t),
    temperature: z.temperature ? { history: history(z.temperature) } : null,
    reference: settings.get().general.references.length ? { history: referenceHistory } : null,
  };
}

const MODES = ['auto', 'off', 'boost'];

// Dashboard controls: the app's own helpers in a YAML package (optional).
const dashboard = createDashboard({
  getSettings: () => settings.get(),
  getMode: (zoneId) => (zoneStates[zoneId] && zoneStates[zoneId].mode) || 'auto',
  onNumber: (zoneId, field, value, label) => setFromDashboard(zoneId, field, value, label),
  onMode: (zoneId, mode) => setMode(zoneId, mode, 'Home Assistant'),
  onBoost: (zoneId) => setMode(zoneId, 'boost', 'Home Assistant'),
  log: (...a) => ha.log(...a),
  warn: (...a) => ha.warn(...a),
});

// A setting changed on the dashboard (an input_number helper).
function setFromDashboard(zoneId, field, value, label) {
  const s = JSON.parse(JSON.stringify(settings.get()));
  const z = s.zones.find((x) => x.id === zoneId);
  if (!z || z[field] === value) return;
  z[field] = value;
  if (field === 'maxBoostMin' && z.minBoostMin > value) z.minBoostMin = value;
  settings.save(s);
  addLog({ type: 'settings', zone: zoneId, reason: `${z.name}: ${label} ${value} (from Home Assistant)` });
  ha.log(`${z.name}: ${label} ${value} (from Home Assistant)`);
  dashboard.sync(); // the new value becomes the helper's starting value
  evaluate();
}

// Read the helpers once (at start, or when dashboard controls are turned on).
function readDashboardHelpers() {
  for (const [id, st] of entityStates) if (id.includes('smart_ventilation_')) dashboard.onState(id, st, true);
}

// Set a zone to Auto, Off or Boost (by hand). source: 'app' or 'Home Assistant'.
function setMode(zoneId, mode, source) {
  const z = settings.get().zones.find((x) => x.id === zoneId);
  if (!z) throw Object.assign(new Error('Unknown zone'), { status: 404 });
  if (!MODES.includes(mode)) throw Object.assign(new Error('Mode must be auto, off or boost'), { status: 400 });
  if (!zoneStates[zoneId]) zoneStates[zoneId] = engine.newZoneState(now());
  if (zoneStates[zoneId].mode === mode) return;
  zoneStates[zoneId].mode = mode;
  addLog({ type: 'mode', zone: zoneId, name: z.name, mode, reason: `${z.name}: mode ${mode} (from ${source})` });
  ha.log(`${z.name}: mode ${mode} (from ${source})`);
  saveRuntime();
  if (mode !== 'boost') dashboard.sync(); // Off / Auto becomes the helper's starting value
  evaluate();
}

function evaluate() {
  if (!started) return;
  const s = settings.get();
  const t = now();
  let changed = false;
  for (const z of s.zones) {
    if (!zoneStates[z.id]) zoneStates[z.id] = engine.newZoneState(t);
    if (z.enabled === false) continue;
    const input = zoneInput(z, t);
    const { change } = engine.evaluateZone(z, zoneStates[z.id], input);
    if (change) {
      changed = true;
      const fig = engine.zoneFigures(z, zoneStates[z.id], input);
      ha.log(`${z.name}: ${change.from} → ${change.to} (${change.reason})`);
      addLog({ type: 'zone', zone: z.id, name: z.name, from: change.from, to: change.to, reason: change.reason, trigger: change.trigger || null, humidity: fig.humidity, baseline: zoneStates[z.id].baseline });
    }
  }
  if (changed) saveRuntime();

  const states = Object.fromEntries(Object.entries(zoneStates).map(([id, st]) => [id, st.state]));
  const decided = actuators.decide(s.actuators, s.zones, states, isNight(t));
  const next = {};
  for (const a of s.actuators) {
    const d = decided[a.id];
    if (!d) continue;
    const command = a.entity ? actuators.commandFor(a, d.value) : null;
    next[a.id] = { ...d, command };
    const prev = advice[a.id];
    if (!prev || prev.value !== d.value) {
      addLog({ type: 'advice', actuator: a.id, name: a.name, value: d.value, level: d.level, why: d.why, command });
    }
  }
  advice = next;
  publish(t).catch((err) => ha.debug('Publishing sensors failed:', err.message));
}

async function publish(t) {
  if (options.publish_sensors !== true || !ha.state.connected) return;
  const s = settings.get();
  const items = [];
  for (const z of s.zones) {
    const st = zoneStates[z.id];
    if (!st) continue;
    const fig = engine.zoneFigures(z, st, zoneInput(z, t));
    items.push([`sensor.smart_ventilation_${z.id}_state`, st.state, { friendly_name: `${z.name} ventilation state`, reason: st.reason, icon: 'mdi:fan' }]);
    items.push([`sensor.smart_ventilation_${z.id}_baseline`, fig.baseline ?? 'unknown', { friendly_name: `${z.name} humidity baseline`, unit_of_measurement: '%', frozen: fig.baselineFrozen }]);
    items.push([`binary_sensor.smart_ventilation_${z.id}_shower_detected`, st.state === 'boost' ? 'on' : 'off', { friendly_name: `${z.name} shower detected`, device_class: 'moisture' }]);
  }
  for (const a of s.actuators) {
    const d = advice[a.id];
    if (!d) continue;
    items.push([`sensor.smart_ventilation_${a.id}_advised_level`, d.value, { friendly_name: `${a.name} advised level`, level: d.level, why: d.why, dry_run: true }]);
  }
  for (const [id, value, attrs] of items) {
    const key = JSON.stringify([value, attrs]);
    const prev = lastPublished.get(id);
    if (prev && prev.key === key && t - prev.at < PUBLISH_EVERY_MS) continue;
    await ha.setState(id, value, attrs);
    lastPublished.set(id, { key, at: t });
  }
}

// ---------------------------------------------------------------------------
// Views for the page
// ---------------------------------------------------------------------------

function entityMeta() {
  const map = new Map();
  for (const st of entityStates.values()) map.set(st.entity_id, actuators.describeEntity(st));
  return map;
}

function status() {
  const s = settings.get();
  const t = now();
  const today = localDay(t);
  const zones = s.zones.map((z) => {
    const st = zoneStates[z.id] || engine.newZoneState(t);
    const fig = engine.zoneFigures(z, st, zoneInput(z, t));
    // Only a boost started by a fast rise is a shower; the safety net
    // (humidity above the absolute trigger) is not. Older log lines have no
    // trigger: their reason tells.
    const isShower = (e) => e.trigger ? e.trigger === 'shower' : /^Shower detected/.test(e.reason || '');
    const showersToday = logEntries.filter((e) => e.type === 'zone' && e.zone === z.id && e.to === 'boost' && e.from === 'idle' && isShower(e) && localDay(e.t) === today).length;
    return { id: z.id, name: z.name, enabled: z.enabled, mode: st.mode || 'auto', state: z.enabled ? st.state : 'off', since: st.since, reason: z.enabled ? st.reason : 'Zone is switched off', boostStart: st.boostStart, figures: fig, showersToday, actuators: z.actuators };
  });
  const acts = s.actuators.map((a) => {
    const d = advice[a.id] || {};
    return { id: a.id, name: a.name, type: a.type, entity: a.entity, unit: actuators.isNumeric(a) ? '%' : '', advised: d.value ?? null, level: d.level || null, why: d.why || '', night: !!d.night, command: d.command || null, current: actuators.currentValue(a, entityStates.get(a.entity)) };
  });
  return {
    version: APP_VERSION,
    mode: 'dry-run',
    connected: ha.state.connected,
    haVersion: ha.state.version,
    error: ha.state.lastError,
    night: isNight(t),
    configured: s.zones.length > 0 && s.actuators.length > 0,
    dashboard: dashboard.status((id) => entityStates.get(id)),
    zones,
    actuators: acts,
    now: t,
  };
}

const ENTITY_KINDS = {
  humidity: (m) => m.domain === 'sensor' && (m.device_class === 'humidity' || m.unit === '%' && /humid|vocht|rv/i.test(m.entity_id + m.name)),
  temperature: (m) => m.domain === 'sensor' && (m.device_class === 'temperature' || /°C|°F/.test(m.unit || '')),
  sensor: (m) => m.domain === 'sensor',
  fan: (m) => m.domain === 'fan',
  number: (m) => m.domain === 'number',
  select: (m) => m.domain === 'select',
  switch: (m) => m.domain === 'switch',
};

function entities() {
  const out = {};
  const all = [...entityMeta().values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const [kind, fn] of Object.entries(ENTITY_KINDS)) out[kind] = all.filter(fn);
  return out;
}

// A suggested set-up, made from the entities in Home Assistant. Nothing is
// saved: the page shows it, the user checks it and presses Save.
const SHOWER_WORDS = /douche|shower/i;
const BATH_WORDS = /badkamer|bathroom|\bbad\b|\bbath\b/i;

function suggestSetup() {
  const e = entities();
  const text = (m) => `${m.entity_id} ${m.name}`.replace(/_/g, ' ');
  const notes = [];
  const actuatorsList = [];

  let fan = e.fan.length === 1 ? e.fan[0] : e.fan.find((f) => /air|ventil|duco|wtw|mvhr|itho|zehnder|brink/i.test(text(f))) || null;
  if (fan) {
    const presetOnly = !fan.percentage && fan.presets.length;
    actuatorsList.push({ id: 'unit', name: 'Ventilation unit', type: 'fan', entity: fan.entity_id, fanMode: presetOnly ? 'preset' : 'percentage', idle: presetOnly ? fan.presets[0] : 10, boost: presetOnly ? fan.presets.at(-1) : 75, afterrun: presetOnly ? fan.presets.at(-1) : 50, restricted: '', nightMax: '' });
    notes.push(`Fan: ${fan.name}. Rest 10%, boost 75%, afterrun 50% are starting values.`);
  } else {
    notes.push(e.fan.length ? 'More than one fan found: choose the ventilation unit yourself.' : 'No fan found: add your ventilation unit yourself.');
  }

  const valves = e.number.filter((n) => /valve|klep/i.test(text(n)));
  valves.forEach((v, i) => {
    const now = Number(v.state);
    const rest = Number.isFinite(now) ? Math.min(v.max, Math.max(v.min, Math.round(now))) : Math.round((v.min + v.max) / 2);
    const name = SHOWER_WORDS.test(text(v)) ? 'Shower valve' : BATH_WORDS.test(text(v)) ? 'Bathroom valve' : `Valve ${i + 1}`;
    actuatorsList.push({ id: `valve_${i + 1}`, name, type: 'number', entity: v.entity_id, fanMode: 'percentage', idle: rest, boost: v.max, afterrun: Math.round((rest + v.max) / 2), restricted: Math.min(v.max, Math.max(v.min, 10)), nightMax: '' });
  });
  if (valves.length) notes.push(`${valves.length} valve(s) found. Rest = their value now; check boost, afterrun and "while another zone boosts".`);

  const humidity = e.humidity;
  const pickSensor = (words) => humidity.find((h) => words.test(text(h))) || null;
  const zonesList = [];
  const fanIds = fan ? ['unit'] : [];
  const valveActs = actuatorsList.filter((a) => a.type === 'number');
  if (valveActs.length) {
    for (const a of valveActs) {
      const zoneName = a.name.replace(/ valve$/, '');
      const words = zoneName === 'Shower' ? SHOWER_WORDS : zoneName === 'Bathroom' ? BATH_WORDS : null;
      const sensor = words ? pickSensor(words) : null;
      zonesList.push({ name: zoneName, humidity: sensor ? sensor.entity_id : null, actuators: [...fanIds, a.id] });
    }
  } else {
    for (const [zoneName, words] of [['Shower', SHOWER_WORDS], ['Bathroom', BATH_WORDS]]) {
      const sensor = pickSensor(words);
      zonesList.push({ name: zoneName, humidity: sensor ? sensor.entity_id : null, actuators: [...fanIds] });
    }
  }
  const missing = zonesList.filter((z) => !z.humidity).map((z) => z.name);
  if (missing.length) notes.push(`Choose the humidity sensor for: ${missing.join(', ')}.`);

  const used = new Set(zonesList.map((z) => z.humidity).filter(Boolean));
  const references = humidity.filter((h) => !used.has(h.entity_id) && !SHOWER_WORDS.test(text(h)) && !BATH_WORDS.test(text(h))).slice(0, 3).map((h) => h.entity_id);
  if (references.length) notes.push(`Reference sensors (Settings › General): ${references.length} other humidity sensor(s). Remove any that are outside or in a wet room.`);

  return { settings: settings.normalise({ actuators: actuatorsList, zones: zonesList, general: { ...settings.get().general, references } }), notes };
}

// The chart of one zone. 3 hours: the app's own readings. Longer (24 hours,
// 3 or 7 days): Home Assistant's history, kept for a minute.
const chartCache = new Map(); // key -> { at, data }
const CHART_CACHE_MS = 60 * 1000;

async function zoneChart(zoneId, hoursRaw) {
  const s = settings.get();
  const z = s.zones.find((x) => x.id === zoneId);
  if (!z) return null;
  const hours = chart.hoursOf(hoursRaw);
  const t = now();
  const from = t - hours * 3600 * 1000;
  const refs = s.general.references;
  const entries = logEntries.filter((e) => e.type === 'zone' && e.zone === z.id);
  const base = { from, to: t, hours, spans: chart.spans(entries, from, t) };
  if (hours === chart.DEFAULT_HOURS) {
    return {
      ...base,
      humidity: z.humidity ? chart.line(history(z.humidity), from, t) : [],
      reference: refs.length ? chart.line(referenceHistory, from, t) : [],
      baseline: zoneStates[z.id] ? zoneStates[z.id].baseline : null,
    };
  }
  const ids = [z.humidity, ...refs].filter(Boolean);
  const key = JSON.stringify([z.id, hours, ids]);
  const hit = chartCache.get(key);
  let lines = hit && t - hit.at < CHART_CACHE_MS ? hit.data : null;
  if (!lines) {
    const result = ids.length ? await ha.getHistory(ids, new Date(from).toISOString()) : {};
    const parsed = Object.fromEntries(ids.map((id) => [id, chart.parseRows(result && result[id])]));
    lines = {
      humidity: z.humidity ? parsed[z.humidity] : [],
      reference: refs.length ? chart.referenceLine(refs.map((r) => parsed[r])) : [],
    };
    chartCache.set(key, { at: t, data: lines });
  }
  return {
    ...base,
    humidity: chart.line(lines.humidity, from, t),
    reference: chart.line(lines.reference, from, t),
    baseline: null, // the baseline moves; it is only drawn for the last 3 hours
  };
}

function diagnostics() {
  const s = settings.get();
  return {
    app: 'Smart Ventilation',
    version: APP_VERSION,
    created: new Date().toISOString(),
    options,
    homeAssistant: { connected: ha.state.connected, version: ha.state.version, timeZone: ha.state.timeZone, error: ha.state.lastError },
    settings: s,
    status: status(),
    entities: [...trackedEntities(), ...s.actuators.map((a) => a.entity).filter(Boolean)].map((id) => {
      const st = entityStates.get(id);
      return st ? { entity_id: id, state: st.state, attributes: st.attributes, last_updated: st.last_updated, last_reported: st.last_reported } : { entity_id: id, missing: true };
    }),
    histories: Object.fromEntries([...trackedEntities()].map((id) => [id, history(id).slice(-60)])),
    dashboard: dashboard.status((id) => entityStates.get(id)),
    log: logEntries.slice(-200),
    appLog: ha.recentLog(),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 100000;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an object');
        resolve(v);
      } catch (err) {
        reject(Object.assign(err, { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/status') return sendJson(res, 200, status());
  if (req.method === 'GET' && p === '/api/settings') return sendJson(res, 200, settings.get());
  if (req.method === 'GET' && p === '/api/entities') return sendJson(res, 200, entities());
  if (req.method === 'GET' && p === '/api/suggest') return sendJson(res, 200, suggestSetup());
  if (req.method === 'POST' && p === '/api/mode') {
    const body = await readBody(req);
    setMode(String(body.zone || ''), String(body.mode || ''), 'app');
    return sendJson(res, 200, { ok: true, status: status() });
  }
  if (req.method === 'GET' && p === '/api/log') return sendJson(res, 200, logEntries.slice(-200).reverse());
  if (req.method === 'GET' && p === '/api/chart') {
    let c;
    try {
      c = await zoneChart(url.searchParams.get('zone') || '', url.searchParams.get('hours'));
    } catch (err) {
      return sendJson(res, 502, { error: `Could not read the history from Home Assistant: ${err.message}` });
    }
    return c ? sendJson(res, 200, c) : sendJson(res, 404, { error: 'Unknown zone' });
  }
  if (req.method === 'GET' && p === '/api/diagnostics') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="smart-ventilation-diagnostics-${APP_VERSION}.json"` });
    return res.end(JSON.stringify(diagnostics(), null, 2));
  }
  if (req.method === 'POST' && p === '/api/settings') {
    const body = await readBody(req);
    const next = settings.normalise(body);
    if (ha.state.connected) {
      const errors = settings.validate(next, entityMeta());
      if (errors.length) return sendJson(res, 400, { error: 'Not saved', errors });
    }
    const before = trackedEntities();
    settings.save(next);
    // New zones start fresh; removed zones are forgotten.
    const ids = new Set(next.zones.map((z) => z.id));
    for (const id of Object.keys(zoneStates)) if (!ids.has(id)) delete zoneStates[id];
    for (const z of next.zones) if (!zoneStates[z.id]) zoneStates[z.id] = engine.newZoneState(now());
    advice = {};
    addLog({ type: 'settings', reason: 'Settings saved' });
    const after = trackedEntities();
    if ([...after].some((id) => !before.has(id)) && ha.state.connected) {
      for (const id of after) {
        const st = entityStates.get(id);
        const v = numericState(st);
        if (v !== null) engine.addSample(history(id), sampleTime(st), v, now());
      }
      await loadHistory();
    } else {
      rebuildReference();
    }
    saveRuntime();
    dashboard.sync();
    readDashboardHelpers();
    evaluate();
    return sendJson(res, 200, { ok: true, settings: settings.get() });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const file = STATIC_FILES.get(url.pathname);
    if (req.method === 'GET' && file) {
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, file[0])));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    ha.warn('Request failed:', err.message);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    else res.end();
  }
});

ha.onConnect(async () => {
  await loadStates();
  await loadHistory();
  if (!started) restoreRuntime();
  started = true;
  readDashboardHelpers();
  dashboard.sync();
  evaluate();
});
ha.onStateChanged(onState);

server.listen(PORT, () => {
  ha.log(`Smart Ventilation ${APP_VERSION} on port ${PORT} (dry-run: advice only, nothing is sent)`);
  ha.connect();
});
setInterval(evaluate, TICK_MS);

module.exports = { server };
