'use strict';

const { storeBaseUrl } = require('./shared');

function basicAuthHeader(key, secret) {
  const token = Buffer.from(`${key}:${secret}`).toString('base64');
  return `Basic ${token}`;
}

async function testConnection(integration) {
  const base = storeBaseUrl(integration.api_endpoint);
  const key = String(integration.access_token || '').trim();
  const secret = String(integration.webhook_secret || '').trim();
  if (!base || !key || !secret) {
    return { ok: false, error: 'Store URL, Consumer Key, and Consumer Secret are required' };
  }
  const url = `${base}/wp-json/wc/v3/system_status`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(key, secret),
      'Content-Type': 'application/json',
    },
  });
  // Some stores disable system_status — fall back to a lightweight products probe.
  if (!resp.ok && resp.status !== 401 && resp.status !== 403) {
    const fallback = await fetch(`${base}/wp-json/wc/v3/products?per_page=1`, {
      method: 'GET',
      headers: {
        Authorization: basicAuthHeader(key, secret),
        'Content-Type': 'application/json',
      },
    });
    if (!fallback.ok) {
      const body = await fallback.text().catch(() => '');
      return { ok: false, error: `WooCommerce HTTP ${fallback.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { ok: false, error: `WooCommerce HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

async function pushOrder(integration, snapshot) {
  const base = storeBaseUrl(integration.api_endpoint);
  const key = String(integration.access_token || '').trim();
  const secret = String(integration.webhook_secret || '').trim();
  if (!base || !key || !secret) throw new Error('WooCommerce credentials incomplete');

  const url = `${base}/wp-json/wc/v3/orders`;
  const payload = {
    payment_method: 'munafe_whatsapp',
    payment_method_title: 'Munafe WhatsApp / Webcart',
    set_paid: true,
    status: 'completed',
    customer_note: snapshot.note,
    billing: {
      first_name: snapshot.customer.first_name,
      phone: snapshot.customer.phone || '',
    },
    line_items: (snapshot.items || []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      total: (Number(item.unit_price || 0) * Number(item.quantity || 1)).toFixed(2),
    })),
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(key, secret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`WooCommerce push failed: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const orderId = data?.id;
  if (!orderId) throw new Error('WooCommerce push succeeded but no order id returned');
  return { external_id: String(orderId), raw: data };
}

module.exports = { testConnection, pushOrder };
