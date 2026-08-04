'use strict';

/**
 * Dukaan — REST order create.
 * Credentials: access_token = API token, config.store_id = store id.
 */

async function testConnection(integration) {
  const token = String(integration.access_token || '').trim();
  const storeId = String(integration.config?.store_id || '').trim();
  if (!token || !storeId) {
    return { ok: false, error: 'Store ID and API Token are required' };
  }
  const resp = await fetch(`https://api.mydukaan.io/api/store/${encodeURIComponent(storeId)}/`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) {
    // Soft-ok if endpoint shape differs but auth is accepted somehow — surface HTTP error.
    const body = await resp.text().catch(() => '');
    return { ok: false, error: `Dukaan HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

async function pushOrder(integration, snapshot) {
  const token = String(integration.access_token || '').trim();
  const storeId = String(integration.config?.store_id || '').trim();
  if (!token || !storeId) throw new Error('Dukaan credentials incomplete');

  const payload = {
    products: (snapshot.items || []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      price: Number(item.unit_price || 0),
    })),
    customer: {
      name: snapshot.customer.name,
      phone: snapshot.customer.phone || undefined,
    },
    payment_status: 'paid',
    status: 'completed',
    notes: snapshot.note,
    source: 'munafe',
  };

  const resp = await fetch(
    `https://api.mydukaan.io/api/store/${encodeURIComponent(storeId)}/orders/`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Dukaan push failed: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const orderId = data?.id || data?.order_id || data?.uuid;
  if (!orderId) throw new Error('Dukaan push succeeded but no order id returned');
  return { external_id: String(orderId), raw: data };
}

module.exports = { testConnection, pushOrder };
