'use strict';

// Dashboard controls against the fake Home Assistant and a temporary config
// folder: the app writes only its own package file, reads the helpers, takes
// changes from the dashboard, and never sends anything to Home Assistant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeHa } = require('./fake-ha');

const APP_DIR = path.join(__dirname, '..', 'smart_ventilation', 'app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const entity = (entity_id, state, attributes) => ({ entity_id, state: String(state), attributes, last_updated: iso(), last_reported: iso() });

const SETUP = {
  actuators: [{ id: 'unit', name: 'Unit', type: 'fan', entity: 'fan.unit', fanMode: 'percentage', idle: 10, boost: 75, afterrun: 50 }],
  zones: [{ name: 'Shower', humidity: 'sensor.shower_humidity', actuators: ['unit'] }],
  general: { dashboardHelpers: true },
};

async function startApp(t, configYaml, extraFiles = {}) {
  const ha = await startFakeHa({
    states: [
      entity('sensor.shower_humidity', 55, { device_class: 'humidity', unit_of_measurement: '%' }),
      entity('fan.unit', 'on', { percentage: 10, percentage_step: 1, supported_features: 49 }),
    ],
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-dash-data-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-dash-config-'));
  if (configYaml !== null) fs.writeFileSync(path.join(configDir, 'configuration.yaml'), configYaml);
  for (const [name, text] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(configDir, name)), { recursive: true });
    fs.writeFileSync(path.join(configDir, name), text);
  }
  const port = 22000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: dataDir, SV_HA_CONFIG_DIR: configDir, SV_PORT: String(port), SV_TICK_MS: '100', HA_WS_URL: ha.wsUrl, HA_REST_URL: ha.restUrl, SUPERVISOR_TOKEN: ha.token },
    stdio: 'ignore',
  });
  t.after(async () => { child.kill(); await ha.close(); });
  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  for (let i = 0; i < 50; i++) { try { if ((await get('/api/status')).connected) break; } catch { /* starting */ } await sleep(100); }
  const until = async (fn, what) => {
    for (let i = 0; i < 50; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    assert.fail(`timed out: ${what}`);
  };
  return { ha, configDir, get, post, until };
}

const PACKAGES = 'default_config:\n\nhomeassistant:\n  name: Thuis\n  packages: !include_dir_named packages\n';
const FILE = (dir) => path.join(dir, 'packages', 'smart_ventilation.yaml');
const read = (f) => fs.readFileSync(f, 'utf8');

test('helpers: the file is written, the helpers are read, changes are taken, nothing is sent', async (t) => {
  const { ha, configDir, get, post, until } = await startApp(t, PACKAGES);
  const before = read(path.join(configDir, 'configuration.yaml'));

  const r = await post('/api/settings', SETUP);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const file = FILE(configDir);
  assert.ok(fs.existsSync(file), 'package file written');
  assert.match(read(file), /smart_ventilation_shower_safety_net:[\s\S]*?initial: 85\n/);
  assert.equal(read(path.join(configDir, 'configuration.yaml')), before, 'configuration.yaml is not changed');

  let st = await get('/api/status');
  assert.equal(st.dashboard.location.ok, true);
  assert.equal(st.dashboard.expected, 7);
  assert.equal(st.dashboard.found, 0, 'not loaded in Home Assistant yet');

  // The owner reloads the YAML: the helpers appear in Home Assistant.
  ha.setState('input_select.smart_ventilation_shower_mode', 'Auto', { options: ['Auto', 'Off'] });
  ha.setState('input_button.smart_ventilation_shower_boost', 'unknown', {});
  for (const [k, v] of [['rise_trigger', 8], ['safety_net', 85], ['stop_margin', 3], ['max_boost', 60], ['afterrun', 5]]) {
    ha.setState(`input_number.smart_ventilation_shower_${k}`, `${v}.0`, { min: 0, max: 100 });
  }
  st = await until(async () => { const s = await get('/api/status'); return s.dashboard.found === 7 && s; }, 'all helpers found');
  assert.deepEqual(st.dashboard.locked.shower.map((x) => x.field).sort(), ['absoluteTrigger', 'afterrunMin', 'maxBoostMin', 'riseThreshold', 'stopMargin']);

  // A change on the dashboard: used right away and kept as the starting value.
  ha.setState('input_number.smart_ventilation_shower_safety_net', '87.0');
  await until(async () => (await get('/api/settings')).zones[0].absoluteTrigger === 87, 'safety net 87 taken');
  await until(async () => /smart_ventilation_shower_safety_net:[\s\S]*?initial: 87\n/.test(read(file)), 'initial 87 in the file');

  // Mode Off and back to Auto.
  ha.setState('input_select.smart_ventilation_shower_mode', 'Off');
  await until(async () => (await get('/api/status')).zones[0].state === 'off', 'zone off');
  assert.match(read(file), /smart_ventilation_shower_mode:[\s\S]*?initial: "Off"/);
  ha.setState('input_select.smart_ventilation_shower_mode', 'Auto');
  await until(async () => (await get('/api/status')).zones[0].state === 'idle', 'zone back on');

  // Boost now.
  ha.setState('input_button.smart_ventilation_shower_boost', iso());
  st = await until(async () => { const s = await get('/api/status'); return s.zones[0].state === 'boost' && s; }, 'boost by hand');
  assert.match(st.zones[0].reason, /Boost by hand/);
  assert.equal(st.actuators[0].advised, 75);
  // Off stops it.
  ha.setState('input_select.smart_ventilation_shower_mode', 'Off');
  await until(async () => (await get('/api/status')).zones[0].state === 'off', 'Off stops the boost');

  // #2: the helper still says Off. Boost now, then Off again: for Home
  // Assistant that is no change (no state_changed), but the call is seen.
  ha.setState('input_button.smart_ventilation_shower_boost', iso());
  await until(async () => (await get('/api/status')).zones[0].state === 'boost', 'boost by hand from Off');
  ha.callService('input_select', 'select_option', { entity_id: 'input_select.smart_ventilation_shower_mode', option: 'Off' });
  await until(async () => (await get('/api/status')).zones[0].state === 'off', 'Off again stops the boost');
  // Another helper or another option does nothing odd.
  ha.callService('input_select', 'select_option', { entity_id: 'input_select.something_else', option: 'Auto' });
  ha.callService('input_select', 'select_option', { entity_id: ['input_select.smart_ventilation_shower_mode'], option: 'Auto' });
  await until(async () => (await get('/api/status')).zones[0].mode === 'auto', 'a list of entities works too');

  const log = await get('/api/log');
  assert.ok(log.some((e) => /safety net 87 \(from Home Assistant\)/.test(e.reason || '')));

  // SAFETY: only reads; the helpers were never set by the app.
  assert.ok(!ha.received.some((m) => m.type === 'call_service'), 'no action was called');

  // Turning it off removes the file (and only that file).
  const s2 = await get('/api/settings');
  s2.general.dashboardHelpers = false;
  assert.equal((await post('/api/settings', s2)).status, 200);
  assert.ok(!fs.existsSync(file), 'file removed');
  assert.equal(read(path.join(configDir, 'configuration.yaml')), before);
});

test('no packages in configuration.yaml: no file, and the page says what to add', async (t) => {
  const { configDir, get, post } = await startApp(t, 'default_config:\n');
  assert.equal((await post('/api/settings', SETUP)).status, 200);
  assert.ok(!fs.existsSync(FILE(configDir)));
  const st = await get('/api/status');
  assert.equal(st.dashboard.location.problem, 'no-packages');
  assert.match(st.dashboard.snippet, /packages: !include_dir_named packages/);
});

test('a file with that name that the app did not make is left alone', async (t) => {
  const own = '# my own helpers\ninput_boolean:\n  test:\n';
  const { configDir, get, post } = await startApp(t, PACKAGES, { 'packages/smart_ventilation.yaml': own });
  assert.equal((await post('/api/settings', SETUP)).status, 200);
  assert.equal(read(FILE(configDir)), own);
  const st = await get('/api/status');
  assert.match(st.dashboard.file.error, /not made by this app/);
});

test('dashboard controls off (the default): nothing is written', async (t) => {
  const { configDir, post } = await startApp(t, PACKAGES);
  const off = JSON.parse(JSON.stringify(SETUP));
  delete off.general;
  assert.equal((await post('/api/settings', off)).status, 200);
  await sleep(300);
  assert.ok(!fs.existsSync(path.join(configDir, 'packages')), 'no packages folder made');
});
