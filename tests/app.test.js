'use strict';

// The whole app against a fake Home Assistant: set-up through the API, a
// simulated shower, and a check that nothing is ever sent to a device while
// Live control is off (the default). Live control: tests/live.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeHa } = require('./fake-ha');

const APP_DIR = path.join(__dirname, '..', 'smart_ventilation', 'app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function entity(entity_id, state, attributes, agoMin = 0) {
  const iso = new Date(Date.now() - agoMin * 60000).toISOString();
  return { entity_id, state: String(state), attributes, last_updated: iso, last_reported: iso, last_changed: iso };
}

const STATES = [
  entity('sensor.shower_humidity', 55, { device_class: 'humidity', unit_of_measurement: '%', friendly_name: 'Shower humidity' }),
  entity('sensor.bath_humidity', 54, { device_class: 'humidity', unit_of_measurement: '%', friendly_name: 'Bathroom humidity' }),
  entity('sensor.hall_humidity', 52, { device_class: 'humidity', unit_of_measurement: '%', friendly_name: 'Hall humidity' }),
  entity('sensor.shower_temperature', 21, { device_class: 'temperature', unit_of_measurement: '°C' }),
  entity('fan.open_air_mini', 'on', { friendly_name: 'Open AIR Mini', percentage: 10, percentage_step: 1, preset_modes: null, supported_features: 49 }),
  entity('number.shower_valve_capacity', 50, { min: 0, max: 100, step: 1, unit_of_measurement: '%' }),
  entity('number.bath_valve_capacity', 50, { min: 0, max: 100, step: 1, unit_of_measurement: '%' }),
  entity('switch.kitchen', 'off', {}),
];

const lu = (agoMin) => (Date.now() - agoMin * 60000) / 1000;
const HISTORY = {
  'sensor.shower_humidity': [{ s: '58', lu: lu(30 * 60) }, { s: '80', lu: lu(29 * 60) }, { s: '56', lu: lu(28 * 60) }, { s: '55', lu: lu(90) }, { s: '55.5', lu: lu(40) }, { s: '55', lu: lu(10) }],
  'sensor.bath_humidity': [{ s: '54', lu: lu(90) }],
  'sensor.hall_humidity': [{ s: '52', lu: lu(90) }],
};

const SETUP = {
  actuators: [
    { id: 'unit', name: 'Ventilation unit', type: 'fan', entity: 'fan.open_air_mini', fanMode: 'percentage', idle: 10, boost: 75, afterrun: 50 },
    { id: 'v_shower', name: 'Shower valve', type: 'number', entity: 'number.shower_valve_capacity', idle: 50, boost: 100, afterrun: 75, restricted: 10 },
    { id: 'v_bath', name: 'Bathroom valve', type: 'number', entity: 'number.bath_valve_capacity', idle: 50, boost: 100, afterrun: 75, restricted: 10 },
  ],
  zones: [
    { name: 'Shower', humidity: 'sensor.shower_humidity', temperature: 'sensor.shower_temperature', actuators: ['unit', 'v_shower'], minBoostMin: 0, afterrunMin: 0 },
    { name: 'Bathroom', humidity: 'sensor.bath_humidity', actuators: ['unit', 'v_bath'] },
  ],
  general: { references: ['sensor.hall_humidity'] },
};

test('the app against a fake Home Assistant', async (t) => {
  const ha = await startFakeHa({ states: STATES, history: HISTORY });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-app-'));
  fs.writeFileSync(path.join(dataDir, 'options.json'), JSON.stringify({ publish_sensors: true, log_level: 'debug' }));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: dataDir, SV_PORT: String(port), SV_TICK_MS: '150', HA_WS_URL: ha.wsUrl, HA_REST_URL: ha.restUrl, SUPERVISOR_TOKEN: ha.token, SV_RECONNECT_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => { child.kill(); await ha.close(); });

  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  async function until(fn, what, ms = 5000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      try { last = await fn(); if (last) return last; } catch { /* not up yet */ }
      await sleep(100);
    }
    assert.fail(`Timed out waiting for: ${what}\n${output.slice(-2000)}`);
  }

  await until(async () => (await get('/api/status')).connected, 'connected');

  await t.test('the page and its files are served', async () => {
    for (const f of ['/', '/app.js', '/styles.css', '/logo.svg', '/unsaved.js']) assert.equal((await fetch(base + f)).status, 200, f);
    const st = await get('/api/status');
    assert.equal(st.mode, 'dry-run', 'Live control is off by default');
    assert.equal(st.configured, false);
  });

  await t.test('entity pickers offer the right entities', async () => {
    const e = await get('/api/entities');
    assert.deepEqual(e.humidity.map((x) => x.entity_id).sort(), ['sensor.bath_humidity', 'sensor.hall_humidity', 'sensor.shower_humidity']);
    assert.deepEqual(e.temperature.map((x) => x.entity_id), ['sensor.shower_temperature']);
    assert.equal(e.fan[0].percentage, true);
    assert.deepEqual(e.fan[0].presets, []);
    assert.equal(e.number.length, 2);
    assert.equal(e.switch[0].entity_id, 'switch.kitchen');
    assert.equal(e.sensor.length, 4, 'all sensors, for the "Other sensors" part of the search list');
  });

  await t.test('a suggested set-up from the entities, valid as it is', async () => {
    const { settings: s, notes } = await get('/api/suggest');
    const byName = Object.fromEntries(s.actuators.map((a) => [a.name, a]));
    assert.equal(byName['Ventilation unit'].entity, 'fan.open_air_mini');
    assert.equal(byName['Ventilation unit'].fanMode, 'percentage');
    assert.deepEqual([byName['Ventilation unit'].idle, byName['Ventilation unit'].boost, byName['Ventilation unit'].afterrun], [10, 75, 50]);
    const sv = byName['Shower valve'];
    assert.equal(sv.entity, 'number.shower_valve_capacity');
    assert.deepEqual([sv.idle, sv.boost, sv.afterrun, sv.restricted], [50, 100, 75, 10], 'rest = its value now');
    assert.equal(byName['Bathroom valve'].entity, 'number.bath_valve_capacity');
    const zones = Object.fromEntries(s.zones.map((z) => [z.name, z]));
    assert.equal(zones.Shower.humidity, 'sensor.shower_humidity');
    assert.deepEqual(zones.Shower.actuators, ['unit', sv.id]);
    assert.equal(zones.Bathroom.humidity, 'sensor.bath_humidity');
    assert.deepEqual(s.general.references, ['sensor.hall_humidity']);
    assert.ok(notes.length >= 2);
    assert.equal((await get('/api/status')).configured, false, 'a proposal is not saved');
    const r = await post('/api/settings', s);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  await t.test('wrong settings are refused with reasons', async () => {
    const bad = JSON.parse(JSON.stringify(SETUP));
    bad.actuators[1].boost = 150;
    bad.actuators[0].fanMode = 'preset';
    const r = await post('/api/settings', bad);
    assert.equal(r.status, 400);
    assert.ok(r.body.errors.some((e) => /outside 0–100/.test(e)));
    assert.ok(r.body.errors.some((e) => /no presets/.test(e)));
  });

  await t.test('a good set-up is saved', async () => {
    const r = await post('/api/settings', SETUP);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.warnings, [], 'no warnings for a good set-up');
    const st = await get('/api/status');
    assert.equal(st.configured, true);
    assert.equal(st.zones[0].state, 'idle');
    assert.equal(st.zones[0].figures.baseline, 55, 'baseline from the loaded history');
    assert.equal(st.zones[0].figures.reference, 52);
    const unit = st.actuators.find((a) => a.id === 'unit');
    assert.equal(unit.advised, 10);
    assert.equal(unit.current, 10);
  });

  await t.test('a shower: boost, then back to normal', async () => {
    ha.setState('sensor.shower_humidity', 59);
    await sleep(200);
    ha.setState('sensor.shower_humidity', 67);
    const st = await until(async () => {
      const s = await get('/api/status');
      return s.zones[0].state === 'boost' && s;
    }, 'shower zone boosting');
    assert.match(st.zones[0].reason, /Shower detected/);
    assert.equal(st.zones[0].figures.baseline, 55);
    assert.equal(st.zones[1].state, 'idle');
    const adv = Object.fromEntries(st.actuators.map((a) => [a.id, a]));
    assert.equal(adv.unit.advised, 75);
    assert.deepEqual(adv.unit.command, { service: 'fan.set_percentage', data: { percentage: 75 }, target: { entity_id: 'fan.open_air_mini' } });
    assert.equal(adv.v_shower.advised, 100);
    assert.equal(adv.v_bath.advised, 10, 'the other valve is restricted');
    // Each zone card on Home shows its own fan and valves (issue #4).
    const dev = (zi) => Object.fromEntries(st.zones[zi].devices.map((d) => [d.id, d]));
    assert.deepEqual(Object.keys(dev(0)).sort(), [...SETUP.zones[0].actuators].sort());
    assert.equal(dev(0).v_shower.advised, 100);
    assert.equal(dev(0).v_shower.level, 'boost');
    assert.equal(dev(0).v_shower.unit, '%');
    assert.ok('current' in dev(0).v_shower);
    assert.equal(dev(0).v_bath, undefined, 'the bathroom valve is not in the shower card');
    assert.equal(dev(1).v_bath.advised, 10);
    assert.equal(dev(1).v_bath.level, 'restricted');
    // The entities behind the tiles, for their history in Home Assistant (issue #8).
    assert.equal(st.zones[0].entities.humidity, 'sensor.shower_humidity');
    assert.equal(st.zones[0].entities.temperature, 'sensor.shower_temperature');
    assert.deepEqual(st.zones[0].entities.references, ['sensor.hall_humidity']);
    assert.equal(st.zones[1].entities.temperature, null);
    assert.equal(dev(0).v_shower.entity, 'number.shower_valve_capacity');
    assert.equal(dev(0).unit.entity, 'fan.open_air_mini');

    const chart = await get('/api/chart?zone=shower');
    assert.ok(chart.humidity.length >= 3);
    assert.ok(chart.spans.some((s) => s.state === 'boost'));
    assert.equal(chart.hours, 3);
    assert.ok(!chart.humidity.some((p) => p[1] === 80), 'the shower of yesterday is not in the last 3 hours');

    // Further back: from Home Assistant's history (only reading).
    const before = ha.received.filter((m) => m.type === 'history/history_during_period').length;
    const day = await get('/api/chart?zone=shower&hours=72');
    assert.equal(day.hours, 72);
    assert.ok(Math.abs(day.to - day.from - 72 * 3600000) < 5000);
    assert.ok(day.humidity.some((p) => p[1] === 80), 'the shower of yesterday is in the last 3 days');
    assert.ok(day.reference.length >= 1, 'the reference line is there');
    assert.equal(day.baseline, null, 'no baseline over days');
    assert.ok(day.spans.some((s) => s.state === 'boost'), 'boost band from the log');
    const asked = ha.received.filter((m) => m.type === 'history/history_during_period');
    assert.equal(asked.length, before + 1);
    assert.ok(Date.now() - Date.parse(asked.at(-1).start_time) > 71 * 3600000, 'asked for 3 days');
    await get('/api/chart?zone=shower&hours=72');
    assert.equal(ha.received.filter((m) => m.type === 'history/history_during_period').length, before + 1, 'kept for a minute');
    assert.equal((await get('/api/chart?zone=shower&hours=999')).hours, 3, 'anything else: 3 hours');

    ha.setState('sensor.shower_humidity', 57);
    await until(async () => (await get('/api/status')).zones[0].state === 'idle', 'shower zone back to idle');
    const back = await get('/api/status');
    assert.equal(back.zones[0].showersToday, 1);
    assert.equal(back.actuators.find((a) => a.id === 'unit').advised, 10);

    const log = await get('/api/log');
    const changes = log.filter((e) => e.type === 'zone' && e.zone === 'shower').map((e) => e.to).reverse();
    assert.deepEqual(changes, ['boost', 'afterrun', 'idle']);
    assert.ok(log.some((e) => e.type === 'advice' && e.actuator === 'unit' && e.value === 75));
  });

  await t.test('a valve in two zones is saved, with a warning (issue #7)', async () => {
    const wrong = JSON.parse(JSON.stringify(SETUP));
    wrong.zones[1].actuators = ['unit', 'v_shower'];
    const r = await post('/api/settings', wrong);
    assert.equal(r.status, 200, 'a warning does not stop saving');
    assert.equal(r.body.warnings.length, 1);
    assert.match(r.body.warnings[0], /Shower valve is in more than one zone/);
    const back = await post('/api/settings', SETUP);
    assert.deepEqual(back.body.warnings, []);
  });

  await t.test('a humid house is not a shower', async () => {
    ha.setState('sensor.bath_humidity', 58);
    ha.setState('sensor.hall_humidity', 58);
    await sleep(200);
    ha.setState('sensor.bath_humidity', 64);
    ha.setState('sensor.hall_humidity', 63);
    await sleep(500);
    assert.equal((await get('/api/status')).zones[1].state, 'idle');
  });

  await t.test('an unavailable sensor is a sensor problem', async () => {
    ha.setState('sensor.bath_humidity', 'unavailable');
    await until(async () => (await get('/api/status')).zones[1].state === 'fault', 'bathroom fault');
    ha.setState('sensor.bath_humidity', 60);
    await until(async () => (await get('/api/status')).zones[1].state !== 'fault', 'bathroom recovered');
  });

  await t.test('diagnostics download', async () => {
    const r = await fetch(base + '/api/diagnostics');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /smart-ventilation-diagnostics/);
    const d = await r.json();
    assert.equal(d.settings.zones.length, 2);
    assert.ok(!JSON.stringify(d).includes(ha.token), 'no token in diagnostics');
  });

  await t.test('safety: only reads, and only its own sensors are written', async () => {
    const types = new Set(ha.received.map((m) => m.type));
    for (const type of types) assert.ok(['get_config', 'get_states', 'subscribe_events', 'history/history_during_period'].includes(type), `unexpected command ${type}`);
    assert.ok(!ha.received.some((m) => m.type === 'call_service'), 'no action was ever called');
    assert.deepEqual([...new Set(ha.received.filter((m) => m.type === 'subscribe_events').map((m) => m.event_type))].sort(), ['call_service', 'state_changed'], 'only follows these events');
    assert.ok(ha.written.length > 0, 'own sensors were published');
    for (const w of ha.written) assert.match(w.entity_id, /^(sensor|binary_sensor)\.smart_ventilation_/);
    assert.ok(ha.written.some((w) => w.entity_id === 'binary_sensor.smart_ventilation_shower_shower_detected' && w.state === 'on'));
    assert.ok(ha.written.some((w) => w.entity_id === 'sensor.smart_ventilation_unit_advised_level' && w.state === '75'));
    // The sensors behind the Baseline, Rise and Showers today tiles (issue #9),
    // as numbers Home Assistant can draw.
    const last = (id) => ha.written.filter((w) => w.entity_id === id).at(-1);
    const rise = last('sensor.smart_ventilation_shower_rise');
    assert.ok(rise && Number.isFinite(Number(rise.state)), 'rise is a number');
    assert.equal(rise.attributes.state_class, 'measurement');
    assert.ok(ha.written.some((w) => w.entity_id === 'sensor.smart_ventilation_shower_rise' && Number(w.state) >= 8), 'the shower rise was published');
    assert.equal(last('sensor.smart_ventilation_shower_baseline').attributes.state_class, 'measurement');
    const showers = last('sensor.smart_ventilation_shower_showers_today');
    assert.equal(showers.state, '1');
    assert.equal(showers.attributes.unit_of_measurement, 'showers');
    const st = await get('/api/status');
    assert.deepEqual(st.zones[0].entities, { humidity: 'sensor.shower_humidity', temperature: 'sensor.shower_temperature', references: ['sensor.hall_humidity'], baseline: 'sensor.smart_ventilation_shower_baseline', rise: 'sensor.smart_ventilation_shower_rise', showers: 'sensor.smart_ventilation_shower_showers_today', reference: 'sensor.smart_ventilation_reference' });
    // The reference the app uses (issue #10).
    const ref = last('sensor.smart_ventilation_reference');
    assert.equal(Number(ref.state), st.zones[0].figures.reference);
    assert.equal(ref.attributes.unit_of_measurement, '%');
    assert.deepEqual(ref.attributes.sensors, ['sensor.hall_humidity']);
  });

  await t.test('state survives a restart of the app', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(saved.zones.length, 2);
    assert.ok(fs.existsSync(path.join(dataDir, 'log.json')));
    assert.ok(fs.existsSync(path.join(dataDir, 'runtime.json')));
  });
});
