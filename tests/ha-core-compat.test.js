'use strict';

// Compatibility test against a real Home Assistant Core container.
// GitHub Actions starts the container (.github/workflows/ha-core-compat.yml,
// pinned to HA_CORE_VERSION) with tests/ha-core/configuration.yaml: demo fans
// and numbers (the ventilation unit and the valves) and humidity sensors that
// follow input_number helpers, so the test can simulate a shower.
// The test makes a throw-away owner account and starts the real app.
// First in dry-run (nothing may change), then with Live control on (the
// demo fan and numbers must really change, and go back to rest).
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

test.after(async () => {
  // The app saves its state when it stops: wait for that before cleaning up.
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    await Promise.race([exited, sleep(8000)]);
  }
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

  // Dashboard controls: the app writes its YAML package, and this real Home
  // Assistant loads it (so the YAML is valid). The test reloads the helpers,
  // as the owner does once by hand.
  const current = await appApi('/api/settings');
  current.general.dashboardHelpers = true;
  await post('/api/settings', current);
  for (const domain of ['input_number', 'input_select', 'input_button']) await haService(domain, 'reload', {});
  const safety = await until(() => haGet('states/input_number.smart_ventilation_shower_safety_net'), 'the helpers loaded in Home Assistant', 40, 500);
  assert.equal(Number(safety.state), Number(current.zones[0].absoluteTrigger));
  await until(async () => { const d = (await appApi('/api/status')).dashboard; return d.found === d.expected && d.expected === 14; }, 'the app sees all 14 helpers');
  // A change on the dashboard is used by the app.
  await haService('input_number', 'set_value', { entity_id: 'input_number.smart_ventilation_shower_safety_net', value: 88 });
  await until(async () => (await appApi('/api/settings')).zones[0].absoluteTrigger === 88, 'safety net 88 from the dashboard');
  // Boost now, then Off.
  await haService('input_button', 'press', { entity_id: 'input_button.smart_ventilation_shower_boost' });
  await until(async () => { const z = (await appApi('/api/status')).zones[0]; return z.state === 'boost' && /Boost by hand/.test(z.reason); }, 'boost by hand from the button');
  await haService('input_select', 'select_option', { entity_id: 'input_select.smart_ventilation_shower_mode', option: 'Off' });
  await until(async () => (await appApi('/api/status')).zones[0].state === 'off', 'mode Off from the dashboard');

  // SAFETY: dry-run. Nothing was sent to the fan or the valves.
  const fanAfter = await haGet(`states/${fanState.entity_id}`);
  assert.equal(fanAfter.attributes.percentage, before.fan, 'the fan was changed');
  assert.equal((await haGet(`states/${v1.entity_id}`)).state, before.v1, 'a valve was changed');
  assert.equal((await haGet(`states/${v2.entity_id}`)).state, before.v2, 'a valve was changed');

  // LIVE CONTROL: now the app really sets the demo fan and numbers.
  const near = (v, target, step) => Math.abs(Number(v) - Number(target)) <= Number(step || 1) / 2 + 1e-9;
  const fanStep = Number(fanState.attributes.percentage_step) || 1;
  const fanAt = async (target) => near((await haGet(`states/${fanState.entity_id}`)).attributes.percentage, target, fanStep);
  const numAt = async (n, target) => near((await haGet(`states/${n.entity_id}`)).state, target, n.attributes.step);
  const min1 = Number(v1.attributes.min);
  const max1 = Number(v1.attributes.max);
  const min2 = Number(v2.attributes.min);

  const setLive = async (on) => {
    const s = await appApi('/api/settings');
    s.general.liveControl = on;
    assert.equal((await post('/api/settings', s)).ok, true);
  };
  // Back to Auto first. The mode helper still says Off from above, and the
  // app only sees a change of a helper: choosing Off again later would not
  // be a change.
  await haService('input_select', 'select_option', { entity_id: 'input_select.smart_ventilation_shower_mode', option: 'Auto' });
  await until(async () => (await appApi('/api/status')).zones[0].mode === 'auto', 'mode Auto from the dashboard');
  // Turning Live control on sets everything to rest.
  await setLive(true);
  assert.equal((await appApi('/api/status')).mode, 'live');
  await until(async () => await fanAt(10) && await numAt(v1, min1) && await numAt(v2, min2), 'rest values set in Home Assistant');

  // Boost now: the fan and the shower valve go up; the bathroom valve is
  // restricted (its minimum here).
  await haService('input_button', 'press', { entity_id: 'input_button.smart_ventilation_shower_boost' });
  await until(async () => await fanAt(75) && await numAt(v1, max1), 'fan 75 and shower valve at its maximum in Home Assistant');
  assert.ok(await numAt(v2, min2), 'bathroom valve restricted');
  const st2 = await until(async () => { const s = await appApi('/api/status'); return s.actuators[0].control && s.actuators[0].control.done && s; }, 'the app sees the fan at 75');
  assert.equal(st2.actuators[0].control.tries, 1, 'sent once');

  // Off: back to rest.
  await haService('input_select', 'select_option', { entity_id: 'input_select.smart_ventilation_shower_mode', option: 'Off' });
  await until(async () => await fanAt(10) && await numAt(v1, min1), 'back to rest after Off');

  // #2: the helper says Off. Boost now, then Off again: Home Assistant sends
  // no state change, but the app sees the choice and stops the boost.
  await haService('input_button', 'press', { entity_id: 'input_button.smart_ventilation_shower_boost' });
  await until(async () => await fanAt(75), 'boost by hand while the helper says Off');
  await haService('input_select', 'select_option', { entity_id: 'input_select.smart_ventilation_shower_mode', option: 'Off' });
  await until(async () => (await appApi('/api/status')).zones[0].state === 'off' && await fanAt(10), 'Off again stops the boost (#2)');

  // Boost again, then turn Live control off: the app sets it back to rest.
  await haService('input_select', 'select_option', { entity_id: 'input_select.smart_ventilation_shower_mode', option: 'Auto' });
  await until(async () => (await appApi('/api/status')).zones[0].mode === 'auto', 'mode Auto again');
  await haService('input_button', 'press', { entity_id: 'input_button.smart_ventilation_shower_boost' });
  await until(async () => await fanAt(75) && await numAt(v1, max1), 'boosting again');
  await setLive(false);
  await until(async () => await fanAt(10) && await numAt(v1, min1), 'back to rest after Live control off');
  assert.equal((await appApi('/api/status')).mode, 'dry-run');
  const log = await appApi('/api/log');
  assert.ok(log.some((e) => e.type === 'sent' && e.ok && e.actuator === 'unit' && e.value === 75), 'sent lines in the Activity log');
  assert.ok(!log.some((e) => e.type === 'sent' && !e.ok), `no failed actions: ${JSON.stringify(log.filter((e) => e.type === 'sent' && !e.ok))}`);
}
