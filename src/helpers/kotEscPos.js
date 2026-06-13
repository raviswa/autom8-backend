// src/helpers/kotEscPos.js
// Optional network thermal print (ESC/POS over TCP port 9100).
// Only works when the API can reach the printer IP (same LAN or VPN).
// Default KOT path is browser print on the KDS screen — no IP required.

'use strict';

const net = require('net');

function escPosText(lines) {
  const chunks = [Buffer.from([0x1b, 0x40])]; // ESC @ init
  for (const line of lines) {
    chunks.push(Buffer.from(String(line || '') + '\n', 'ascii'));
  }
  chunks.push(Buffer.from('\n\n', 'ascii'));
  chunks.push(Buffer.from([0x1d, 0x56, 0x00])); // GS V 0 full cut
  return Buffer.concat(chunks);
}

/**
 * @param {{ ip: string, port?: number, lines: string[] }} opts
 * @returns {Promise<void>}
 */
function printKotEscPos({ ip, port = 9100, lines }) {
  if (!ip || !lines?.length) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const payload = escPosText(lines);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Printer timeout (${ip}:${port})`));
    }, 4000);

    socket.connect(port, ip, () => {
      socket.write(payload, () => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function buildKotLines(order) {
  const items = order.items || [];
  const lines = [
    '*** KITCHEN ORDER ***',
    order.restaurant_name || 'AUTOM8',
    `Order: ${order.order_number || '-'}`,
    order.token_number ? `Token: ${order.token_number}` : '',
    order.table_number ? `Table: ${order.table_number}` : '',
    order.service_type ? `Type: ${order.service_type}` : '',
    '------------------------',
  ].filter(Boolean);

  items.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.qty || 1}x ${item.name || 'Item'}`);
  });

  if (order.special_notes) {
    lines.push('------------------------');
    lines.push(`Notes: ${order.special_notes}`);
  }

  lines.push('------------------------');
  lines.push(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  return lines;
}

module.exports = { printKotEscPos, buildKotLines };
