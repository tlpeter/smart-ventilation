'use strict';

// Compatibility test against a real Home Assistant Core container.
// GitHub Actions starts the container (.github/workflows/ha-core-compat.yml,
// pinned to HA_CORE_VERSION) with tests/ha-core/configuration.yaml: demo fans
// and numbers (the ventilation unit and the valves) and humidity sensors that
// follow input_number helpers, so the test can simulate a shower.
// The test makes a throw-away owner account and starts the real app.
//
// Skipped unless HA_CORE_TEST=1 (set by the workflow), so
// `node --test tests/*.test.js` works without Home Assistant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HA_URL = process.env.HA_URL || 'http://127.0.0.1:8123';
const APP = path.join(__dirname, '..', 'smart_ventilation', 'app');
const APP_PORT = Number(process.env.SV_TEST_PORT) || 18399;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${url} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForCore() {
  let last = 'not started';
  for (let i = 0; i < 180; i++) {
    try { return await json(`${HA_URL}/api/onboarding`); } catch (err) { last = err.message; await sleep(1000); }
  }
  throw new Error(`Home Assistant did not become ready: ${last}`);
}

async function onboard() {
  const clientId = `${HA_URL}/`;
  const user = await json(`${HA_URL}/api/onboarding/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, name: 'Compatibility test', username: 'sv_compat', password: 'sv-compatibility-only', language: 'en' }),
  });
  const token = await json(`${HA_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: user.auth_code, client_id: clientId }),
  });
  return token.access_token;
}

let app;
let dataDir;
let token;
const appApi = (p, opts) => json(`http://127.0.0.1:${APP_PORT}${p}`, opts);
const haGet = (p) => json(`${HA_URL}/api/${p}`, { headers: { Authorization: `Bearer ${token}` } });
const haService = (domain, service, data) => json(`${HA_URL}/api/services/${domain}/${service}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});
const post = (p, body) => appApi(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function until(fn, what, tries = 60, ms = 500) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { last = await fn(); if (last) return last; } catch { /* not yet */ }
    await sleep(ms);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

test.after(() => {
  if (app) app.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the app works against a real Home Assistant Core', { skip: process.env.HA_CORE_TEST !== '1' && 'set HA_CORE_TEST=1 (GitHub Actions does)' }, async () => {
  try {
    await run();
  } catch (err) {
    // A failure also shows as a note on the GitHub run.
    console.log(`::error::${String(err.message).split('\n').slice(0, 3).join(' ')}`);
    throw err;
  }
});

async function run() {
  await waitForCore();
  token = await onboard();
  assert.ok(token, 'no access token');

  // Wait for the demo fans and numbers and the template humidity sensors.
  const states = await until(async () => {
    const s = await haGet('states');
    const ok = s.some((x) => x.entity_id === 'sensor.shower_humidity' && Number(x.state) === 55)
      && s.some((x) => x.entity_id.startsWith('fan.')) && s.some((x) => x.entity_id.startsWith('number.'));
    return ok && s;
  }, 'demo entities and humidity sensors', 120, 1000);
  const fanState = states.find((s) => s.entity_id.startsWith('fan.') && (Number(s.attributes.supported_features) & 1));
  assert.ok(fanState, 'no demo fan with a speed percentage');
  const numbers = states.filter((s) => s.entity_id.startsWith('number.') && Number.isFinite(Number(s.attributes.min)) && Number.isFinite(Number(s.attributes.max)));
  assert.ok(numbers.length >= 2, 'need two demo numbers as valves');
  const [v1, v2] = numbers;
  const before = { fan: fanState.attributes.percentage, v1: v1.state, v2: v2.state };

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-core-'));
  fs.writeFileSync(path.join(dataDir, 'options.json'), JSON.stringify({ publish_sensors: true, log_level: 'debug' }));
  app = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      SV_PORT: String(APP_PORT),
      SV_TICK_MS: '500',
      HA_WS_URL: HA_URL.replace(/^http/, 'ws') + '/api/websocket',
      HA_REST_URL: `${HA_URL}/api`,
      HA_TOKEN: token,
    },
    stdio: 'inherit',
  });
  await until(async () => (await appApi('/api/status')).connected, 'the app connected to Home Assistant');

  // Entity pickers: Home Assistant's real attributes are read correctly.
  const ents = await appApi('/api/entities');
  for (const id of ['sensor.shower_humidity', 'sensor.bathroom_humidity', 'sensor.hall_humidity']) {
    assert.ok(ents.humidity.some((m) => m.entity_id === id), `${id} not offered as a humidity sensor`);
  }
  const fanMeta = ents.fan.find((m) => m.entity_id === fanState.entity_id);
  assert.equal(fanMeta.percentage, true, 'fan speed percentage not recognised');
  const n1 = ents.number.find((m) => m.entity_id === v1.entity_id);
  assert.equal(n1.min, Number(v1.attributes.min));
  assert.equal(n1.max, Number(v1.attributes.max));

  // The proposal from real entities can be made.
  const proposal = await appApi('/api/suggest');
  assert.ok(Array.isArray(proposal.settings.zones));

  // Set up: the demo fan, two numbers as valves, two zones, a reference.
  const valve = (id, name, n) => ({ id, name, type: 'number', entity: n.entity_id, idle: Number(n.attributes.min), boost: Number(n.attributes.max), afterrun: Number(n.attributes.max), restricted: Number(n.attributes.min) });
  const saved = await post('/api/settings', {
    actuators: [
      { id: 'unit', name: 'Ventilation unit', type: 'fan', entity: fanState.entity_id, fanMode: 'percentage', idle: 10, boost: 75, afterrun: 50 },
      valve('v_shower', 'Shower valve', v1),
      valve('v_bath', 'Bathroom valve', v2),
    ],
    zones: [
      { name: 'Shower', humidity: 'sensor.shower_humidity', actuators: ['unit', 'v_shower'], minBoostMin: 0, afterrunMin: 0 },
      { name: 'Bathroom', humidity: 'sensor.bathroom_humidity', actuators: ['unit', 'v_bath'] },
    ],
    general: { references: ['sensor.hall_humidity'] },
  });
  assert.equal(saved.ok, true);

  let st = await until(async () => { const s = await appApi('/api/status'); return s.zones.length === 2 && s.zones[0].figures.humidity === 55 && s; }, 'the shower zone reads 55 %');
  assert.equal(st.zones[0].state, 'idle');
  assert.equal(st.zones[0].figures.reference, 52);

  // A shower: the humidity rises fast.
  await haService('input_number', 'set_value', { entity_id: 'input_number.shower_rh', value: 59 });
  await sleep(1000);
  await haService('input_number', 'set_value', { entity_id: 'input_number.shower_rh', value: 67 });
  st = await until(async () => { const s = await appApi('/api/status'); return s.zones[0].state === 'boost' && s; }, 'the shower zone boosts');
  const unit = st.actuators.find((a) => a.id === 'unit');
  assert.equal(unit.advised, 75);
  assert.deepEqual(unit.command, { service: 'fan.set_percentage', data: { percentage: 75 }, target: { entity_id: fanState.entity_id } });
  assert.equal(st.actuators.find((a) => a.id === 'v_bath').level, 'restricted');

  // Its own sensors are written to Home Assistant (Publish sensors on).
  const detected = await until(async () => { const s = await haGet('states/binary_sensor.smart_ventilation_shower_shower_detected'); return s.state === 'on' && s; }, 'the shower_detected sensor in Home Assistant');
  assert.equal(detected.state, 'on');
  const advised = await haGet('states/sensor.smart_ventilation_unit_advised_level');
  assert.equal(advised.state, '75');

  // Back to normal.
  await haService('input_number', 'set_value', { entity_id: 'input_number.shower_rh', value: 56 });
  await until(async () => (await appApi('/api/status')).zones[0].state === 'idle', 'the shower zone back to idle');

  // History from Home Assistant's recorder: the chart has the readings.
  const chart = await appApi('/api/chart?zone=shower');
  assert.ok(chart.humidity.length >= 3, `chart has ${chart.humidity.length} points`);

  // SAFETY: dry-run. Nothing was sent to the fan or the valves.
  const fanAfter = await haGet(`states/${fanState.entity_id}`);
  assert.equal(fanAfter.attributes.percentage, before.fan, 'the fan was changed');
  assert.equal((await haGet(`states/${v1.entity_id}`)).state, before.v1, 'a valve was changed');
  assert.equal((await haGet(`states/${v2.entity_id}`)).state, before.v2, 'a valve was changed');
}
