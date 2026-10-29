'use strict';

// A small fake Home Assistant for tests: a WebSocket API and the REST
// /api/states endpoint. It records every command the app sends, so a test
// can check what was read and what was set. Actions (call_service) change the
// fan, number, select and switch states like Home Assistant does, unless the
// entity is in `stuck` (it ignores commands) or `failing` (an error).

const http = require('http');
const { WebSocketServer } = require('../smart_ventilation/app/node_modules/ws');

function startFakeHa({ states = [], history = {}, token = 'test-token' } = {}) {
  const received = []; // every WebSocket message from the app
  const written = []; // every REST state write
  const reportRequests = []; // read-only timestamp template requests
  const sockets = new Set();
  const statesById = new Map(states.map((s) => [s.entity_id, s]));
  let subscription = null; // state_changed
  let serviceSubscription = null; // call_service
  const stuck = new Set();
  const failing = new Set();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/template' && req.headers.authorization === `Bearer ${token}`) {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        reportRequests.push(body);
        const reports = {};
        for (const id of body.variables.entity_ids) {
          const st = statesById.get(id);
          if (st) reports[id] = st.last_reported;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(JSON.stringify(reports));
        return;
      }
      const m = req.url.match(/^\/api\/states\/(.+)$/);
      if (req.method === 'POST' && m && req.headers.authorization === `Bearer ${token}`) {
        written.push({ entity_id: m[1], ...JSON.parse(Buffer.concat(chunks).toString() || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  const wss = new WebSocketServer({ server, path: '/api/websocket' });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.10.4' }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        ws.send(JSON.stringify(msg.access_token === token ? { type: 'auth_ok', ha_version: '2026.10.4' } : { type: 'auth_invalid', message: 'bad token' }));
        return;
      }
      received.push(msg);
      const reply = (result, success = true) => ws.send(JSON.stringify({ id: msg.id, type: 'result', success, result }));
      if (msg.type === 'get_config') reply({ time_zone: 'Europe/Amsterdam' });
      else if (msg.type === 'get_states') reply([...statesById.values()]);
      else if (msg.type === 'subscribe_events') {
        if (msg.event_type === 'call_service') serviceSubscription = { ws, id: msg.id };
        else subscription = { ws, id: msg.id };
        reply(null);
      }
      else if (msg.type === 'history/history_during_period') {
        const out = {};
        for (const id of msg.entity_ids || []) if (history[id]) out[id] = history[id];
        reply(out);
      } else if (msg.type === 'call_service') {
        const id = msg.target && msg.target.entity_id;
        if (failing.has(id)) { ws.send(JSON.stringify({ id: msg.id, type: 'result', success: false, error: { code: 'home_assistant_error', message: 'Device not responding' } })); return; }
        reply({ context: {} });
        if (stuck.has(id) || !statesById.has(id)) return;
        const d = msg.service_data || {};
        const action = `${msg.domain}.${msg.service}`;
        if (action === 'fan.set_percentage') api.setState(id, d.percentage > 0 ? 'on' : 'off', { percentage: d.percentage });
        else if (action === 'fan.set_preset_mode') api.setState(id, 'on', { preset_mode: d.preset_mode });
        else if (action === 'number.set_value') api.setState(id, d.value);
        else if (action === 'select.select_option') api.setState(id, d.option);
        else if (action === 'switch.turn_on') api.setState(id, 'on');
        else if (action === 'switch.turn_off') api.setState(id, 'off');
      } else reply(null, false);
    });
  });

  // What the tests use. setState also serves actions from the app.
  const api = {
    wsUrl: null,
    restUrl: null,
    token,
    received,
    written,
    reportRequests,
    stuck,
    failing,
    // The actions the app called: [{ service, entity_id, data }].
    actions() {
      return received.filter((m) => m.type === 'call_service').map((m) => ({ service: `${m.domain}.${m.service}`, entity_id: m.target && m.target.entity_id, data: m.service_data }));
    },
    state(id) { return statesById.get(id); },
    // HA stores an identical report without emitting state_changed.
    reportState(entityId, at = Date.now()) {
      const old = statesById.get(entityId);
      if (!old) throw new Error(`Unknown entity ${entityId}`);
      statesById.set(entityId, { ...old, last_reported: new Date(at).toISOString() });
    },
    // A service call from someone else (for example a dashboard), like Home
    // Assistant does it: first the call_service event, then the new state,
    // but only when the state really changes. input_select.select_option only.
    callService(domain, service, data) {
      if (serviceSubscription) {
        serviceSubscription.ws.send(JSON.stringify({ id: serviceSubscription.id, type: 'event', event: { event_type: 'call_service', data: { domain, service, service_data: data } } }));
      }
      if (domain === 'input_select' && service === 'select_option') {
        const old = statesById.get(data.entity_id);
        if (!old || old.state !== data.option) api.setState(data.entity_id, data.option);
      }
    },
    // Change an entity and tell the app, like Home Assistant does.
    setState(entityId, state, attributes = {}) {
      const nowIso = new Date().toISOString();
      const old = statesById.get(entityId);
      const next = { entity_id: entityId, state: String(state), attributes: { ...(old ? old.attributes : {}), ...attributes }, last_updated: nowIso, last_reported: nowIso, last_changed: nowIso };
      statesById.set(entityId, next);
      if (subscription) {
        subscription.ws.send(JSON.stringify({ id: subscription.id, type: 'event', event: { event_type: 'state_changed', data: { entity_id: entityId, old_state: old || null, new_state: next } } }));
      }
    },
    close() {
      for (const s of sockets) s.terminate();
      wss.close();
      return new Promise((r) => server.close(r));
    },
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      api.wsUrl = `ws://127.0.0.1:${port}/api/websocket`;
      api.restUrl = `http://127.0.0.1:${port}/api`;
      resolve(api);
    });
  });
}

module.exports = { startFakeHa };
