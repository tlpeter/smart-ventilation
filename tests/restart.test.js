'use strict';

// A restart of the app (for example an update) keeps what it must keep:
// - the safety-net lock: after a boost that ran its maximum time, a room that
//   is still humid does not get a new boost just because the app restarted;
// - "Showers today" counts only boosts started by a fast rise.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeHa } = require('./fake-ha');

const APP_DIR = path.join(__dirname, '..', 'smart_ventilation', 'app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (agoMin = 0) => new Date(Date.now() - agoMin * 60000).toISOString();
const entity = (entity_id, state, attributes) => ({ entity_id, state: String(state), attributes, last_updated: iso(), last_reported: iso() });

const SETTINGS = {
  version: 1,
  actuators: [{ id: 'unit', name: 'Unit', type: 'fan', entity: 'fan.unit', fanMode: 'percentage', idle: 10, boost: 75, afterrun: 50, restricted: '', nightMax: '' }],
  zones: [{ id: 'shower', name: 'Shower', enabled: true, humidity: 'sensor.shower_humidity', temperature: null, actuators: ['unit'], riseThreshold: 8, riseWindowMin: 5, absoluteTrigger: 85, stopMargin: 3, minBoostMin: 5, maxBoostMin: 60, afterrunMin: 5, baselineWindowMin: 60, confirmWithTemperature: false, temperatureRise: 1 }],
  general: { references: [], nightEnabled: false, nightStart: '23:00', nightEnd: '07:00', sensorTimeoutMin: 60 },
};

async function startWith(runtime, log, { level = 90, then = null } = {}) {
  const ha = await startFakeHa({
    states: [
      entity('sensor.shower_humidity', level, { device_class: 'humidity', unit_of_measurement: '%' }),
      entity('fan.unit', 'on', { percentage: 10, percentage_step: 1, supported_features: 49 }),
    ],
    history: { 'sensor.shower_humidity': [{ s: String(then ? then.before : level), lu: (Date.now() - 50 * 60000) / 1000 }] },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-restart-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(SETTINGS));
  if (runtime) fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify(runtime));
  if (log) fs.writeFileSync(path.join(dataDir, 'log.json'), JSON.stringify(log));
  const port = 20000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: dataDir, SV_PORT: String(port), SV_TICK_MS: '100', HA_WS_URL: ha.wsUrl, HA_REST_URL: ha.restUrl, SUPERVISOR_TOKEN: ha.token },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let st;
  for (let i = 0; i < 50; i++) {
    try { st = await (await fetch(`${base}/api/status`)).json(); if (st.connected && st.zones[0].figures.humidity === level) break; } catch { /* starting */ }
    await sleep(100);
  }
  await sleep(500); // a few evaluations
  if (then) {
    for (const v of then.values) { ha.setState('sensor.shower_humidity', v); await sleep(300); }
  }
  st = await (await fetch(`${base}/api/status`)).json();
  st.log = await (await fetch(`${base}/api/log`)).json();
  child.kill();
  await ha.close();
  return st;
}

const savedAt = Date.now() - 10 * 60000;

test('after a restart, a room still at 90 % after a maximum-time boost gets no new boost', async () => {
  const st = await startWith({ savedAt, zones: { shower: { state: 'idle', since: savedAt, baseline: null, boostStart: null, reason: 'Afterrun done', absLatch: true } } });
  assert.equal(st.zones[0].state, 'idle', st.zones[0].reason);
});

test('without that lock, 90 % does start the safety net (so the test above means something)', async () => {
  const st = await startWith({ savedAt, zones: { shower: { state: 'idle', since: savedAt, baseline: null, boostStart: null, reason: 'Normal', absLatch: false } } });
  assert.equal(st.zones[0].state, 'boost');
  assert.match(st.zones[0].reason, /above 85%/);
  assert.equal(st.zones[0].showersToday, 0, 'the safety net is not a shower');
});

test('"Showers today" counts showers, not safety-net boosts (also old log lines without a trigger)', async () => {
  const t = Date.now() - 5 * 60000;
  const st = await startWith({ savedAt, zones: { shower: { state: 'idle', since: savedAt, absLatch: true } } }, [
    { t: t - 60000, type: 'zone', zone: 'shower', name: 'Shower', from: 'idle', to: 'boost', reason: 'Shower detected: +10 points in 5 min' },
    { t: t - 30000, type: 'zone', zone: 'shower', name: 'Shower', from: 'boost', to: 'afterrun', reason: 'Maximum boost time of 60 min reached' },
    { t: t - 20000, type: 'zone', zone: 'shower', name: 'Shower', from: 'afterrun', to: 'idle', reason: 'Afterrun done' },
    { t, type: 'zone', zone: 'shower', name: 'Shower', from: 'idle', to: 'boost', reason: 'Humidity 89.7% is above 85%' },
  ]);
  assert.equal(st.zones[0].showersToday, 1);
});

test('a shower that starts on the safety net still counts as a shower (issue #6)', async () => {
  // The numbers from a real shower: the room rests at 82.8 %, one jump to
  // 88.9 % (+6.1, above the 85 % safety net), then 92.6 % (+9.8).
  const st = await startWith({ savedAt, zones: { shower: { state: 'idle', since: savedAt, absLatch: false } } }, null,
    { level: 88.9, then: { before: 82.8, values: [92.6] } });
  assert.equal(st.zones[0].state, 'boost');
  assert.match(st.zones[0].reason, /Shower detected/);
  assert.equal(st.zones[0].showersToday, 1);
  const start = st.log.find((e) => e.type === 'zone' && e.to === 'boost');
  assert.equal(start.trigger, 'shower');
  assert.match(start.reason, /above 85%, then shower detected/);
  assert.equal(st.log.filter((e) => e.type === 'zone' && e.to === 'boost').length, 1, 'still one boost');
  // Publish sensors is off here: no own sensors behind the tiles (issue #9).
  assert.equal(st.zones[0].entities.baseline, null);
  assert.equal(st.zones[0].entities.rise, null);
  assert.equal(st.zones[0].entities.showers, null);
  assert.equal(st.zones[0].entities.reference, null);
});
