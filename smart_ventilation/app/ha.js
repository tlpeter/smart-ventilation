'use strict';

// Home Assistant WebSocket client.
// Connects through the Supervisor and lets the app read states, follow state
// changes and read recent history.
//
// SAFETY: the app mostly reads. It writes in two ways only:
// - the state of its own sensors (sensor.smart_ventilation_*), only when
//   "Publish sensors" is on;
// - with Live control on: one of six actions that set a fan, valve, select
//   or switch (ACTIONS below), and only on an entity that server.js allows
//   (an actuator chosen in the app). Everything else is refused here.

const WebSocket = require('ws');
const { options } = require('./options');

const HA_WS_URL = process.env.HA_WS_URL || 'ws://supervisor/core/websocket';
const REST_URL = process.env.HA_REST_URL || 'http://supervisor/core/api';
const TOKEN = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';
const RECONNECT_MS = Math.max(50, Number(process.env.SV_RECONNECT_MS) || 10000);

const state = { connected: false, version: null, timeZone: 'UTC', lastError: null };

let socket = null;
let nextId = 1;
const pending = new Map();
const connectListeners = [];
const stateListeners = [];
const serviceListeners = [];
let subscriptionId = null;
let serviceSubscriptionId = null;

const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 };
const threshold = LEVELS[options.log_level] || LEVELS.info;
const recentLines = [];
function recentLog() { return recentLines.slice(); }

function logAt(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = [new Date().toISOString(), level.toUpperCase(), ...args];
  recentLines.push(line.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  if (recentLines.length > 300) recentLines.shift();
  (level === 'error' || level === 'warning' ? console.error : console.log)(...line);
}
function log(...args) { logAt('info', args); }
function debug(...args) { logAt('debug', args); }
function warn(...args) { logAt('warning', args); }

// SAFETY: the only WebSocket commands the app may send. All of them read.
const READ_ONLY_COMMANDS = new Set([
  'get_states',
  'get_config',
  'subscribe_events', // only for state_changed and call_service, see below
  'history/history_during_period',
]);

// Events the app may follow (reading only). call_service: to see a dashboard
// choice that is the same as before (Home Assistant then sends no
// state_changed), see dashboard.onSelectCall.
const SUBSCRIBE_EVENTS = new Set(['state_changed', 'call_service']);

// SAFETY: the only actions the app may call (Live control), each on its own
// kind of entity.
const ACTIONS = new Set([
  'fan.set_percentage',
  'fan.set_preset_mode',
  'number.set_value',
  'select.select_option',
  'switch.turn_on',
  'switch.turn_off',
]);

// Set by server.js: may the app change this entity now? Nothing is allowed
// until it is set.
let actionPolicy = () => false;
function setActionPolicy(fn) { actionPolicy = fn; }

function send(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!state.connected) { reject(new Error('Not connected to Home Assistant')); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, ...message }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Timeout waiting for Home Assistant'));
      }
    }, timeoutMs);
  });
}

// Call one action on one entity: { service: 'fan.set_percentage', data, target: { entity_id } }.
async function callAction(command, timeoutMs = 10000) {
  const service = String((command && command.service) || '');
  const entity = command && command.target && command.target.entity_id;
  const [domain, name] = service.split('.');
  if (!ACTIONS.has(service)) throw new Error(`Action ${service} is not allowed`);
  if (typeof entity !== 'string' || entity.split('.')[0] !== domain) throw new Error(`${service} needs one ${domain} entity`);
  if (!actionPolicy(entity)) {
    warn('Refused action', service, 'on', entity, '- not allowed now');
    throw new Error(`${entity} may not be changed now`);
  }
  return send({ type: 'call_service', domain, service: name, service_data: (command && command.data) || {}, target: { entity_id: entity } }, timeoutMs);
}

function call(message, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ok = READ_ONLY_COMMANDS.has(message.type) &&
      (message.type !== 'subscribe_events' || SUBSCRIBE_EVENTS.has(message.event_type));
    if (!ok) {
      warn('Refused command', message.type, '- not a read command');
      reject(new Error(`Command ${message.type} is not allowed here: only reads go through call()`));
      return;
    }
    send(message, timeoutMs).then(resolve, reject);
  });
}

async function getStates() {
  return call({ type: 'get_states' });
}

// Recent history for a few entities: { entity_id: [{ s, lu }] } (compact form).
async function getHistory(entityIds, startIso) {
  if (!entityIds.length) return {};
  return call({
    type: 'history/history_during_period',
    start_time: startIso,
    entity_ids: entityIds,
    minimal_response: true,
    no_attributes: true,
    significant_changes_only: false,
  }, 30000);
}

const OWN_SENSOR = /^(sensor|binary_sensor)\.smart_ventilation_[a-z0-9_]+$/;

async function setState(entityId, value, attributes) {
  if (options.publish_sensors !== true) throw new Error('Publish sensors is off');
  if (!OWN_SENSOR.test(entityId)) {
    warn('Refused to write', entityId, '- not one of the app\'s own sensors');
    throw new Error(`${entityId} is not one of the app's own sensors`);
  }
  const res = await fetch(`${REST_URL}/states/${entityId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: String(value), attributes: attributes || {} }),
  });
  if (!res.ok) throw new Error(`Writing ${entityId} failed: HTTP ${res.status}`);
  return true;
}

function onConnect(fn) { connectListeners.push(fn); }
function onStateChanged(fn) { stateListeners.push(fn); }
// fn(domain, service, serviceData) for every action called in Home Assistant.
function onServiceCalled(fn) { serviceListeners.push(fn); }

function connect() {
  if (!TOKEN) {
    state.lastError = 'No SUPERVISOR_TOKEN found. Is homeassistant_api enabled?';
    log(state.lastError);
    return;
  }
  log('Connecting to Home Assistant at', HA_WS_URL);
  socket = new WebSocket(HA_WS_URL);

  socket.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'auth_required') {
      socket.send(JSON.stringify({ type: 'auth', access_token: TOKEN }));
    } else if (msg.type === 'auth_ok') {
      state.connected = true;
      state.version = msg.ha_version;
      state.lastError = null;
      log('Connected to Home Assistant', state.version);
      try {
        const config = await call({ type: 'get_config' });
        state.timeZone = config.time_zone || 'UTC';
      } catch (err) {
        log('Could not read HA config:', err.message);
      }
      try {
        subscriptionId = nextId;
        await call({ type: 'subscribe_events', event_type: 'state_changed' });
      } catch (err) {
        warn('Could not follow state changes:', err.message);
      }
      try {
        serviceSubscriptionId = nextId;
        await call({ type: 'subscribe_events', event_type: 'call_service' });
      } catch (err) {
        serviceSubscriptionId = null;
        warn('Could not follow dashboard choices:', err.message);
      }
      for (const fn of connectListeners) {
        try { await fn(); } catch (err) { warn('Start-up step failed:', err.message); }
      }
    } else if (msg.type === 'auth_invalid') {
      state.lastError = 'Authentication failed: ' + (msg.message || 'invalid token');
      log(state.lastError);
    } else if (msg.type === 'event' && msg.id === subscriptionId) {
      const data = msg.event && msg.event.data;
      if (data && data.entity_id) for (const fn of stateListeners) fn(data.entity_id, data.new_state);
    } else if (msg.type === 'event' && msg.id === serviceSubscriptionId) {
      const data = (msg.event && msg.event.data) || {};
      for (const fn of serviceListeners) {
        try { fn(String(data.domain || ''), String(data.service || ''), data.service_data || {}); } catch (err) { warn('Handling an action event failed:', err.message); }
      }
    } else if (msg.type === 'result' && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.success) resolve(msg.result);
      else reject(new Error((msg.error && msg.error.message) || 'Home Assistant error'));
    }
  });

  socket.on('close', () => {
    state.connected = false;
    subscriptionId = null;
    serviceSubscriptionId = null;
    for (const [, p] of pending) p.reject(new Error('Connection closed'));
    pending.clear();
    log('Connection to Home Assistant closed, retrying in', RECONNECT_MS / 1000, 's');
    setTimeout(connect, RECONNECT_MS);
  });

  socket.on('error', (err) => {
    state.lastError = err.message;
    debug('WebSocket error:', err.message);
  });
}

module.exports = { state, connect, getStates, callAction, setActionPolicy, ACTIONS, getHistory, setState, onConnect, onStateChanged, onServiceCalled, log, debug, warn, recentLog, OWN_SENSOR };
