'use strict';

// Constant humidity, identical HA reports, and ventilation during a timeout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeHa } = require('./fake-ha');

const MIN = 60000;
const APP_DIR = path.join(__dirname, '..', 'smart_ventilation', 'app');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(t, { humidity = 99.7, agoMin = 65, timeout = 60, runtime = null } = {}) {
  const at = Date.now();
  const iso = new Date(at - agoMin * MIN).toISOString();
  const ha = await startFakeHa({
    states: [
      { entity_id: 'sensor.bath_humidity', state: String(humidity), attributes: { device_class: 'humidity' }, last_changed: iso, last_updated: iso, last_reported: iso },
      { entity_id: 'fan.unit', state: 'on', attributes: { percentage: 10, percentage_step: 1 } },
    ],
    history: { 'sensor.bath_humidity': [{ s: '75', lu: (at - 170 * MIN) / 1000 }, { s: String(humidity), lu: (at - agoMin * MIN) / 1000 }] },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-reports-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    general: timeout === null ? {} : { sensorTimeoutMin: timeout },
    actuators: [{ id: 'unit', name: 'Unit', type: 'fan', entity: 'fan.unit', idle: 10, boost: 75, afterrun: 50 }],
    zones: [{ id: 'bath', name: 'Bathroom', humidity: 'sensor.bath_humidity', actuators: ['unit'] }],
  }));
  if (runtime) fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ savedAt: at, zones: { bath: runtime } }));
  const port = 33000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: dataDir, SV_PORT: String(port), SV_TICK_MS: '50', SV_STATE_REFRESH_MS: '100', HA_WS_URL: ha.wsUrl, HA_REST_URL: ha.restUrl, SUPERVISOR_TOKEN: ha.token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => { child.kill(); await ha.close(); });
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  const until = async (fn) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      try { const result = await fn(); if (result) return result; } catch { /* starting */ }
      await sleep(30);
    }
    assert.fail(`Timed out waiting for sensor reports\n${output}`);
  };
  await until(async () => (await get('/api/status')).connected);
  return { ha, get, until, at };
}

test('an identical report without a state_changed event refreshes last_reported (#11)', async (t) => {
  const since = Date.now() - MIN;
  const app = await start(t, { runtime: { state: 'boost', since, boostStart: since, baseline: 75, trigger: 'shower' } });
  let st = await app.get('/api/status');
  assert.equal(st.zones[0].state, 'boost', 'old high reading keeps ventilation on');
  assert.match(st.zones[0].reason, /keeping boost/);
  const before = app.ha.state('sensor.bath_humidity');
  app.ha.reportState('sensor.bath_humidity'); // No state_changed event.
  const stamp = app.ha.state('sensor.bath_humidity').last_reported;
  assert.equal(app.ha.state('sensor.bath_humidity').last_updated, before.last_updated);
  await app.until(async () => (await app.get('/api/diagnostics')).entities.find((s) => s.entity_id === 'sensor.bath_humidity').last_reported === stamp);
  st = await app.get('/api/status');
  assert.equal(st.zones[0].state, 'boost');
  assert.doesNotMatch(st.zones[0].reason, /No reading/);
  assert.equal(st.zones[0].figures.baseline, 75);
  assert.ok(app.ha.reportRequests.length >= 2);
  assert.deepEqual(app.ha.reportRequests.at(-1).variables.entity_ids, ['sensor.bath_humidity']);
  assert.deepEqual(app.ha.actions(), [], 'dry-run still sends no commands');
});

test('a constant 99.7% for 90 min is not stale with the new default (#11)', async (t) => {
  const app = await start(t, { agoMin: 90, timeout: null });
  const st = await app.get('/api/status');
  assert.equal(st.zones[0].state, 'boost');
  assert.doesNotMatch(st.zones[0].reason, /No reading/);
  assert.equal(st.zones[0].showersToday, 0, 'a safety-net boost is not a detected shower');
});

test('a sensor hold and its frozen baseline survive a restart beyond the boost limit (#11)', async (t) => {
  const since = Date.now() - 150 * MIN;
  const app = await start(t, { agoMin: 130, timeout: 120, runtime: {
    state: 'boost', since, boostStart: since, baseline: 75, trigger: 'shower', sensorProblem: 'No reading for 120 min',
  } });
  await app.until(async () => app.ha.reportRequests.length >= 3);
  const st = await app.get('/api/status');
  assert.equal(st.zones[0].state, 'boost');
  assert.equal(st.zones[0].figures.baseline, 75);
  assert.equal(st.zones[0].figures.baselineFrozen, true);
  assert.equal(st.actuators[0].advised, 75);
  assert.match(st.zones[0].reason, /No reading.*keeping boost/);
});

test('polling is not a heartbeat: an old low reading still faults (#11)', async (t) => {
  const app = await start(t, { humidity: 55, agoMin: 130, timeout: 120 });
  await app.until(async () => app.ha.reportRequests.length >= 3);
  const st = await app.get('/api/status');
  assert.equal(st.zones[0].state, 'fault');
  assert.match(st.zones[0].reason, /No reading.*120 min/);
  assert.equal(st.actuators[0].advised, 10);
});

test('a shower detected while recovering from a fault counts at its start (#11)', async (t) => {
  const app = await start(t, { humidity: 75, agoMin: 130, timeout: 120 });
  assert.equal((await app.get('/api/status')).zones[0].state, 'fault');
  app.ha.setState('sensor.bath_humidity', 75);
  await app.until(async () => (await app.get('/api/status')).zones[0].state === 'idle');
  app.ha.setState('sensor.bath_humidity', 'unavailable');
  await app.until(async () => (await app.get('/api/status')).zones[0].state === 'fault');
  app.ha.setState('sensor.bath_humidity', 99.7);
  await app.until(async () => (await app.get('/api/status')).zones[0].state === 'boost');
  const st = await app.get('/api/status');
  assert.equal(st.zones[0].showersToday, 1, 'does not wait for afterrun or completion');
  assert.equal(st.zones[0].figures.baseline, 75);
  await sleep(250);
  assert.equal((await app.get('/api/status')).zones[0].showersToday, 1, 'not counted twice');
});
