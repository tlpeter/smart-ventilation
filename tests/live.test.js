'use strict';

// Live control: the whole app against a fake Home Assistant that carries out
// the actions. A shower sets the fan and valve, a change by hand stays, a
// device that does not follow gets a few tries, errors are noted, and turning
// Live control off or stopping the app sets things back to rest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeHa } = require('./fake-ha');

const APP_DIR = path.join(__dirname, '..', 'smart_ventilation', 'app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_MS = 300;

function entity(entity_id, state, attributes) {
  const iso = new Date().toISOString();
  return { entity_id, state: String(state), attributes, last_updated: iso, last_reported: iso, last_changed: iso };
}

const FAN = 'fan.open_air_mini';
const V_SHOWER = 'number.shower_valve_capacity';
const V_BATH = 'number.bath_valve_capacity';

const STATES = [
  entity('sensor.shower_humidity', 55, { device_class: 'humidity', unit_of_measurement: '%' }),
  entity('sensor.bath_humidity', 54, { device_class: 'humidity', unit_of_measurement: '%' }),
  entity(FAN, 'on', { percentage: 10, percentage_step: 1, supported_features: 49 }),
  entity(V_SHOWER, 50, { min: 0, max: 100, step: 1 }),
  entity(V_BATH, 50, { min: 0, max: 100, step: 1 }),
  entity('switch.kitchen', 'off', {}),
];

const lu = (agoMin) => (Date.now() - agoMin * 60000) / 1000;
const HISTORY = {
  'sensor.shower_humidity': [{ s: '55', lu: lu(90) }, { s: '55.5', lu: lu(40) }, { s: '55', lu: lu(10) }],
  'sensor.bath_humidity': [{ s: '54', lu: lu(90) }],
};

const SETUP = {
  actuators: [
    { id: 'unit', name: 'Ventilation unit', type: 'fan', entity: FAN, fanMode: 'percentage', idle: 10, boost: 75, afterrun: 50 },
    { id: 'v_shower', name: 'Shower valve', type: 'number', entity: V_SHOWER, idle: 50, boost: 100, afterrun: 75, restricted: 10 },
    { id: 'v_bath', name: 'Bathroom valve', type: 'number', entity: V_BATH, idle: 50, boost: 100, afterrun: 75, restricted: 10, live: false },
  ],
  zones: [
    { name: 'Shower', humidity: 'sensor.shower_humidity', actuators: ['unit', 'v_shower'], minBoostMin: 0, afterrunMin: 0 },
    { name: 'Bathroom', humidity: 'sensor.bath_humidity', actuators: ['unit', 'v_bath'] },
  ],
  general: { references: [], liveControl: false },
};

test('live control against a fake Home Assistant', async (t) => {
  const ha = await startFakeHa({ states: STATES, history: HISTORY });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-live-'));
  fs.writeFileSync(path.join(dataDir, 'options.json'), JSON.stringify({ publish_sensors: true, log_level: 'debug' }));
  const port = 20000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: dataDir, SV_PORT: String(port), SV_TICK_MS: '100', SV_RETRY_MS: String(RETRY_MS), HA_WS_URL: ha.wsUrl, HA_REST_URL: ha.restUrl, SUPERVISOR_TOKEN: ha.token, SV_RECONNECT_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((r) => child.on('exit', r));
  t.after(async () => { child.kill('SIGKILL'); await ha.close(); });

  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  async function until(fn, what, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
      await sleep(50);
    }
    assert.fail(`Timed out waiting for: ${what}\n${JSON.stringify(ha.actions())}\n${output.slice(-2000)}`);
  }
  const fanPct = () => Number(ha.state(FAN).attributes.percentage);
  const valve = (id) => Number(ha.state(id).state);
  const sends = (entityId, value) => ha.actions().filter((a) => a.entity_id === entityId && (value === undefined || Object.values(a.data)[0] === value)).length;
  const setLive = async (on) => {
    const s = await get('/api/settings');
    s.general.liveControl = on;
    const r = await post('/api/settings', s);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const mode = async (m) => assert.equal((await post('/api/mode', { zone: 'shower', mode: m })).status, 200);

  await until(async () => (await get('/api/status')).connected, 'connected');

  await t.test('off by default: nothing is sent', async () => {
    const r = await post('/api/settings', { ...SETUP, general: { references: [] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.settings.general.liveControl, false);
    await mode('boost');
    await until(async () => (await get('/api/status')).actuators[0].advised === 75, 'advice 75');
    await sleep(300);
    assert.deepEqual(ha.actions(), []);
    const st = await get('/api/status');
    assert.equal(st.mode, 'dry-run');
    assert.equal(st.actuators[0].live, false);
    await mode('auto');
    await until(async () => (await get('/api/status')).zones[0].state === 'idle', 'back to idle');
  });

  await t.test('turned on at rest: nothing to send yet', async () => {
    await setLive(true);
    const st = await until(async () => { const s = await get('/api/status'); return s.actuators[0].control && s; }, 'live status');
    assert.equal(st.mode, 'live');
    assert.equal(st.actuators[0].live, true);
    assert.equal(st.actuators[2].live, false, 'the bathroom valve is advice only');
    assert.equal(st.actuators[0].control.done, true);
    assert.equal(st.actuators[0].control.tries, 0, 'already at rest');
    assert.deepEqual(ha.actions(), []);
    const log = await get('/api/log');
    assert.ok(log.some((e) => /Live control on/.test(e.reason || '')));
  });

  await t.test('a shower sets the fan and the valve, then back to rest', async () => {
    ha.setState('sensor.shower_humidity', 59);
    await sleep(150);
    ha.setState('sensor.shower_humidity', 67);
    await until(() => fanPct() === 75 && valve(V_SHOWER) === 100, 'fan 75 and shower valve 100');
    assert.deepEqual(ha.actions().slice(0, 2).map((a) => a.service).sort(), ['fan.set_percentage', 'number.set_value']);
    assert.equal(valve(V_BATH), 50, 'the bathroom valve is not live: not set to 10');
    const st = await until(async () => { const s = await get('/api/status'); return s.actuators[0].control.done && s; }, 'done');
    assert.equal(st.actuators[2].advised, 10, 'but its advice is there');
    const log = await get('/api/log');
    assert.ok(log.some((e) => e.type === 'sent' && e.ok && e.actuator === 'unit' && e.value === 75));
    const sinceLive = log.slice(0, log.findIndex((e) => /Live control on/.test(e.reason || ''))); // newest first
    assert.ok(!sinceLive.some((e) => e.type === 'advice' && e.actuator === 'unit'), 'a live actuator gets a sent line, not an advice line');
    assert.ok(sinceLive.some((e) => e.type === 'advice' && e.actuator === 'v_bath' && e.value === 10));
    const sensor = ha.written.filter((w) => w.entity_id === 'sensor.smart_ventilation_unit_advised_level').at(-1);
    assert.equal(sensor.attributes.dry_run, false);
  });

  await t.test('a change by hand stays until the next change', async () => {
    const before = ha.actions().length;
    ha.setState(FAN, 'on', { percentage: 60 });
    await sleep(RETRY_MS * 3);
    assert.equal(ha.actions().length, before, 'not set back');
    assert.equal(fanPct(), 60);
    ha.setState('sensor.shower_humidity', 57);
    await until(() => fanPct() === 10 && valve(V_SHOWER) === 50, 'back to rest after the shower');
  });

  await t.test('a device that does not follow: three tries, then a note', async () => {
    ha.stuck.add(V_SHOWER);
    const before = sends(V_SHOWER, 100);
    await mode('boost');
    await until(async () => (await get('/api/log')).some((e) => e.type === 'gave-up' && e.actuator === 'v_shower'), 'gave up');
    assert.equal(sends(V_SHOWER, 100) - before, 3);
    await sleep(RETRY_MS * 2);
    assert.equal(sends(V_SHOWER, 100) - before, 3, 'no more tries');
    const st = await get('/api/status');
    assert.equal(st.actuators[1].control.gaveUp, true);
    assert.equal(fanPct(), 75, 'the fan did follow');
    ha.stuck.delete(V_SHOWER);
    await mode('off');
    await until(() => fanPct() === 10, 'fan back to rest');
    assert.equal(valve(V_SHOWER), 50, 'the valve never left rest');
  });

  await t.test('an error is noted and tried again', async () => {
    ha.failing.add(FAN);
    await mode('boost');
    const st = await until(async () => { const s = await get('/api/status'); return s.actuators[0].control && s.actuators[0].control.error && s; }, 'error shown');
    assert.match(st.actuators[0].control.error, /Device not responding/);
    const log = await get('/api/log');
    assert.ok(log.some((e) => e.type === 'sent' && !e.ok && e.actuator === 'unit' && /Device not responding/.test(e.error)));
    ha.failing.delete(FAN);
    await until(() => fanPct() === 75, 'fan 75 on a later try');
  });

  await t.test('turning Live control off sets it back to rest', async () => {
    await until(() => valve(V_SHOWER) === 100, 'valve boosting');
    await setLive(false);
    await until(() => fanPct() === 10 && valve(V_SHOWER) === 50, 'back to rest');
    const st = await get('/api/status');
    assert.equal(st.mode, 'dry-run');
    assert.equal(st.zones[0].state, 'boost', 'the zone still boosts, as advice');
    const n = ha.actions().length;
    await sleep(RETRY_MS * 2);
    assert.equal(ha.actions().length, n, 'nothing more is sent');
    const log = await get('/api/log');
    assert.ok(log.some((e) => /Live control off/.test(e.reason || '')));
  });

  await t.test('unticking Live on one actuator sets it back to rest', async () => {
    await setLive(true);
    await until(() => fanPct() === 75 && valve(V_SHOWER) === 100, 'boosting again');
    const s = await get('/api/settings');
    s.actuators.find((a) => a.id === 'v_shower').live = false;
    assert.equal((await post('/api/settings', s)).status, 200);
    await until(() => valve(V_SHOWER) === 50, 'shower valve back to rest');
    assert.equal(fanPct(), 75, 'the fan stays live');
    s.actuators.find((a) => a.id === 'v_shower').live = true;
    assert.equal((await post('/api/settings', s)).status, 200);
    await until(() => valve(V_SHOWER) === 100, 'live again');
  });

  await t.test('safety: only the six actions, only on live actuators', async () => {
    for (const a of ha.actions()) {
      assert.ok(['fan.set_percentage', 'number.set_value'].includes(a.service), a.service);
      assert.ok([FAN, V_SHOWER].includes(a.entity_id), a.entity_id);
    }
    assert.equal(sends(V_BATH), 0);
    for (const w of ha.written) assert.match(w.entity_id, /^(sensor|binary_sensor)\.smart_ventilation_/);
  });

  await t.test('stopping the app sets it back to rest', async () => {
    assert.equal(fanPct(), 75);
    child.kill('SIGTERM');
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')]);
    assert.equal(code, 0, 'stopped cleanly');
    assert.equal(fanPct(), 10);
    assert.equal(valve(V_SHOWER), 50);
    assert.match(output, /The app is stopping: back to rest/);
  });
});
