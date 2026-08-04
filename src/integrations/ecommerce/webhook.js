'use strict';

/**
 * Generic webhook ("Other") — POST Munafe order JSON to merchant URL.
 * config.webhook_url required. Optional access_token sent as Bearer.
 */

async function testConnection(integration) {
  const url = String(integration.config?.webhook_url || integration.api_endpoint || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Valid webhook URL (https://…) is required' };
  }
  // HEAD/GET may not be supported — send a ping event.
  const headers = { 'Content-Type': 'application/json' };
  const token = String(integration.access_token || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      event: 'munafe.ping',
      platform: 'munafe',
      timestamp: new Date().toISOString(),
    }),
  });
  if (!resp.ok && resp.status !== 404 && resp.status !== 405) {
    const body = await resp.text().catch(() => '');
    return { ok: false, error: `Webhook HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

async function pushOrder(integration, snapshot) {
  const url = String(integration.config?.webhook_url || integration.api_endpoint || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('Webhook URL incomplete');

  const headers = { 'Content-Type': 'application/json' };
  const token = String(integration.access_token || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const payload = {
    event: 'order.confirmed',
    platform: 'munafe',
    token: snapshot.token_number,
    order_ref: snapshot.order_ref,
    booking_id: snapshot.booking_id,
    customer: {
      name: snapshot.customer.name,
      phone: snapshot.customer.phone_e164 || snapshot.customer.phone,
    },
    items: (snapshot.items || []).map((i) => ({
      name: i.name,
      qty: i.quantity,
      price: Number(i.unit_price || 0),
    })),
    subtotal: snapshot.subtotal,
    delivery: snapshot.delivery,
    tax: snapshot.tax,
    total: snapshot.total,
    service_type: snapshot.service_type,
    address: snapshot.address,
    timestamp: snapshot.timestamp,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`Webhook push failed HTTP ${resp.status}: ${text.slice(0, 400)}`);
  }
  let externalId = null;
  try {
    const data = JSON.parse(text);
    externalId = data?.id || data?.order_id || data?.external_id || null;
  } catch (_) {
    externalId = null;
  }
  return {
    external_id: externalId ? String(externalId) : `webhook:${Date.now()}`,
    raw: text.slice(0, 500),
  };
}

module.exports = { testConnection, pushOrder };
