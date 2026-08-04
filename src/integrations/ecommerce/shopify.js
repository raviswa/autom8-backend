'use strict';

const { storeBaseUrl } = require('./shared');

async function testConnection(integration) {
  const base = storeBaseUrl(integration.api_endpoint);
  const token = String(integration.access_token || '').trim();
  if (!base || !token) {
    return { ok: false, error: 'Store URL and Admin API Token are required' };
  }
  const url = `https://${base.replace(/^https?:\/\//i, '')}/admin/api/2024-01/shop.json`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { ok: false, error: `Shopify HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }
  const data = await resp.json().catch(() => ({}));
  return {
    ok: true,
    shop_name: data?.shop?.name || null,
    domain: data?.shop?.domain || null,
  };
}

async function pushOrder(integration, snapshot) {
  const host = storeBaseUrl(integration.api_endpoint).replace(/^https?:\/\//i, '');
  const token = String(integration.access_token || '').trim();
  if (!host || !token) throw new Error('Shopify credentials incomplete');

  const url = `https://${host}/admin/api/2024-01/orders.json`;
  const payload = {
    order: {
      line_items: (snapshot.items || []).map((item) => ({
        title: item.name,
        quantity: item.quantity,
        price: Number(item.unit_price || 0).toFixed(2),
      })),
      customer: {
        first_name: snapshot.customer.first_name,
        phone: snapshot.customer.phone_e164 || snapshot.customer.phone || undefined,
      },
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
      note: snapshot.note,
      tags: 'munafe,whatsapp',
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Shopify push failed: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const orderId = data?.order?.id;
  if (!orderId) throw new Error('Shopify push succeeded but no order id returned');
  return { external_id: String(orderId), raw: data.order };
}

module.exports = { testConnection, pushOrder };
