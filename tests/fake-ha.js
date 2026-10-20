'use strict';

// A small fake Home Assistant for tests: a WebSocket API and the REST
// /api/states endpoint. It records every command the app sends, so a test
// can check that nothing but reads happened.

const http = require('http');
const { WebSocketServer } = require('../smart_ventilation/app/node_modules/ws');

function startFakeHa({ states = [], history = {}, token = 'test-token' } = {}) {
  const received = []; // every WebSocket message from the app
  const written = []; // every REST state write
  const sockets = new Set();
  const statesById = new Map(states.map((s) => [s.entity_id, s]));
  let subscription = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
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
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.10.2' }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        ws.send(JSON.stringify(msg.access_token === token ? { type: 'auth_ok', ha_version: '2026.10.2' } : { type: 'auth_invalid', message: 'bad token' }));
        return;
      }
      received.push(msg);
      const reply = (result, success = true) => ws.send(JSON.stringify({ id: msg.id, type: 'result', success, result }));
      if (msg.type === 'get_config') reply({ time_zone: 'Europe/Amsterdam' });
      else if (msg.type === 'get_states') reply([...statesById.values()]);
      else if (msg.type === 'subscribe_events') { subscription = { ws, id: msg.id }; reply(null); }
      else if (msg.type === 'history/history_during_period') {
        const out = {};
        for (const id of msg.entity_ids || []) if (history[id]) out[id] = history[id];
        reply(out);
      } else reply(null, false);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        wsUrl: `ws://127.0.0.1:${port}/api/websocket`,
        restUrl: `http://127.0.0.1:${port}/api`,
        token,
        received,
        written,
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
      });
    });
  });
}

module.exports = { startFakeHa };
