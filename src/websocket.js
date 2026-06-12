// src/websocket.js
// Real-time events for ManagerPortal, KDSScreen, and queue views.
// Clients connect: wss://api.autom8.works/ws?restaurant_id={uuid}

'use strict';

const http = require('http');
const WebSocket = require('ws');

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const clients = new Map();

// Legacy event names emitted by older code paths
const EVENT_ALIASES = {
  NEW_TOKEN: 'TOKEN_NEW',
};

function normalizeEvent(data) {
  if (!data || typeof data !== 'object') return data;
  const type = EVENT_ALIASES[data.type] ?? data.type;
  return { ...data, type };
}

function broadcastToRestaurant(restaurantId, data) {
  const key = String(restaurantId);
  const payload = JSON.stringify(normalizeEvent(data));
  const room = clients.get(key);
  if (!room?.size) return;

  for (const client of room) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

/**
 * Attach WebSocket server to the HTTP server (same port as Express).
 * @param {http.Server} server
 */
function attachWebSocketServer(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let restaurantId = null;
    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url || '/ws', `http://${host}`);
      restaurantId = url.searchParams.get('restaurant_id');
    } catch (_) {}

    if (!restaurantId) {
      ws.close(4400, 'restaurant_id query param required');
      return;
    }

    const key = String(restaurantId);
    if (!clients.has(key)) clients.set(key, new Set());
    clients.get(key).add(ws);

    ws.send(JSON.stringify({ type: 'CONNECTED', restaurant_id: key }));

    ws.on('close', () => {
      const room = clients.get(key);
      room?.delete(ws);
      if (room?.size === 0) clients.delete(key);
    });

    ws.on('error', () => {
      ws.terminate();
    });
  });

  console.log('[websocket] ✅ Listening on /ws');
  return wss;
}

module.exports = { clients, broadcastToRestaurant, attachWebSocketServer };
