'use strict';

// Dashboard controls (optional, Settings › General): the app's own helpers
// in a YAML package, read by the app.
//
// Files: the app reads <config>/configuration.yaml to find the packages
// folder, and writes only <config>/<packages>/smart_ventilation.yaml (a file
// that starts with its own header). It never touches another file.
// Home Assistant: the app only reads the helpers. It never sets them.

const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const CONFIG_DIR = process.env.SV_HA_CONFIG_DIR || '/homeassistant';

function createDashboard({ getSettings, getMode, onNumber, onMode, onBoost, log, warn }) {
  const lastSelect = new Map(); // entity_id -> last state seen
  const lastButton = new Map();
  let lastWrite = { at: null, error: null, path: null, removed: false };

  function enabled() {
    return getSettings().general.dashboardHelpers === true;
  }

  // Where the package file goes, from configuration.yaml.
  function location() {
    let text;
    try {
      text = fs.readFileSync(path.join(CONFIG_DIR, 'configuration.yaml'), 'utf8');
    } catch (err) {
      return { ok: false, problem: 'no-config', detail: `Cannot read configuration.yaml (${err.code || err.message}). Is the app allowed to use the Home Assistant config folder?` };
    }
    const p = helpers.packagesDir(text);
    if (!p.enabled) {
      return { ok: false, problem: p.other ? 'packages-other' : 'no-packages', detail: p.other
        ? 'configuration.yaml has packages, but not as a folder (!include_dir_named). Add this file to your packages yourself.'
        : 'Packages are not on in configuration.yaml yet.' };
    }
    const dir = path.resolve(CONFIG_DIR, p.dir);
    if (!dir.startsWith(path.resolve(CONFIG_DIR) + path.sep)) return { ok: false, problem: 'packages-outside', detail: 'The packages folder is outside the config folder.' };
    return { ok: true, dir: p.dir, file: path.join(dir, helpers.FILE_NAME) };
  }

  function modes() {
    const out = {};
    for (const z of getSettings().zones) out[z.id] = getMode(z.id) === 'off' ? 'off' : 'auto';
    return out;
  }

  // Write (or remove) the package file. Only when its text changes.
  function sync() {
    const loc = location();
    if (!loc.ok) {
      if (enabled()) lastWrite = { ...lastWrite, error: loc.detail };
      return;
    }
    let existing = null;
    try { existing = fs.readFileSync(loc.file, 'utf8'); } catch { /* not there */ }
    if (existing !== null && !helpers.isOurFile(existing)) {
      lastWrite = { ...lastWrite, error: `${loc.file} exists but was not made by this app: left alone.` };
      return;
    }
    try {
      if (!enabled()) {
        if (existing !== null) {
          fs.unlinkSync(loc.file);
          lastWrite = { at: Date.now(), error: null, path: loc.file, removed: true };
          log('Dashboard controls off: removed', loc.file);
        }
        return;
      }
      const text = helpers.packageYaml(getSettings().zones.filter((z) => z.enabled !== false), modes());
      if (text === existing) { lastWrite = { ...lastWrite, error: null, path: loc.file }; return; }
      fs.mkdirSync(path.dirname(loc.file), { recursive: true });
      const tmp = `${loc.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, loc.file);
      lastWrite = { at: Date.now(), error: null, path: loc.file, removed: false };
      log('Dashboard controls: wrote', loc.file);
    } catch (err) {
      lastWrite = { ...lastWrite, error: `Could not write ${loc.file}: ${err.message}` };
      warn(lastWrite.error);
    }
  }

  // Which zone and setting an entity belongs to.
  function lookup(entityId) {
    for (const z of getSettings().zones) {
      const e = helpers.zoneEntities(z.id);
      if (entityId === e.mode) return { zone: z, kind: 'mode' };
      if (entityId === e.boost) return { zone: z, kind: 'boost' };
      const n = e.numbers.find((x) => x.entity_id === entityId);
      if (n) return { zone: z, kind: 'number', n };
    }
    return null;
  }

  // A helper changed (or was read at start: initial = true).
  function onState(entityId, st, initial = false) {
    if (!enabled() || !entityId.includes('smart_ventilation_')) return;
    const hit = lookup(entityId);
    if (!hit || !st) return;
    if (hit.kind === 'number') {
      const v = helpers.numberValue(st, hit.n);
      if (v !== null && v !== hit.zone[hit.n.field]) onNumber(hit.zone.id, hit.n.field, v, hit.n.name);
    } else if (hit.kind === 'mode') {
      const prev = lastSelect.get(entityId);
      lastSelect.set(entityId, st.state);
      const m = helpers.modeValue(st);
      // Follow the dashboard when it changes (this also stops a boost by
      // hand), and once at start (then a running boost by hand stays).
      const changed = !initial && prev !== undefined && prev !== st.state;
      const atStart = initial && getMode(hit.zone.id) !== 'boost';
      if (m && (changed || atStart) && getMode(hit.zone.id) !== m) onMode(hit.zone.id, m);
    } else if (hit.kind === 'boost') {
      const prev = lastButton.get(entityId);
      lastButton.set(entityId, st.state);
      const pressed = !initial && prev !== undefined && st.state !== prev && !['unknown', 'unavailable', ''].includes(st.state);
      if (pressed) onBoost(hit.zone.id);
    }
  }

  // Someone chose an option on a mode helper (input_select.select_option).
  // Also when it is the same option as before: Home Assistant then sends no
  // state change. Example: the helper says Off, Boost now was pressed, and
  // Off is chosen again to stop the boost.
  function onSelectCall(entityId, option) {
    if (!enabled() || typeof entityId !== 'string' || !entityId.includes('smart_ventilation_')) return;
    const hit = lookup(entityId);
    if (!hit || hit.kind !== 'mode') return;
    const m = helpers.modeValue({ state: String(option) });
    if (m && getMode(hit.zone.id) !== m) onMode(hit.zone.id, m);
  }

  // For the Settings page: is it set up, which helpers exist.
  function status(stateOf) {
    const zones = getSettings().zones.filter((z) => z.enabled !== false);
    const expected = helpers.allEntityIds(zones);
    const missing = expected.filter((id) => !stateOf(id));
    const locked = {};
    for (const z of zones) {
      locked[z.id] = helpers.zoneEntities(z.id).numbers.filter((n) => stateOf(n.entity_id)).map((n) => ({ field: n.field, entity_id: n.entity_id }));
    }
    const loc = location();
    return {
      enabled: enabled(),
      configDir: CONFIG_DIR,
      location: loc,
      snippet: helpers.SNIPPET,
      file: lastWrite,
      expected: expected.length,
      found: expected.length - missing.length,
      missing,
      locked: enabled() ? locked : {},
      entities: zones.map((z) => ({ zone: z.id, name: z.name, ...helpers.zoneEntities(z.id) })),
    };
  }

  return { sync, onState, onSelectCall, status, enabled };
}

module.exports = { createDashboard, CONFIG_DIR };
