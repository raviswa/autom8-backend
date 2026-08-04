'use strict';

/**
 * Wix eCommerce — create order via Stores/Orders API.
 * Credentials: access_token = API key, config.site_id = site id.
 */

async function testConnection(integration) {
  const token = String(integration.access_token || '').trim();
  const siteId = String(integration.config?.site_id || '').trim();
  if (!token || !siteId) {
    return { ok: false, error: 'Site ID and API Key are required' };
  }
  const resp = await fetch('https://www.wixapis.com/site-properties/v4/properties', {
    method: 'GET',
    headers: {
      Authorization: token,
      'wix-site-id': siteId,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { ok: false, error: `Wix HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

async function pushOrder(integration, snapshot) {
  const token = String(integration.access_token || '').trim();
  const siteId = String(integration.config?.site_id || '').trim();
  if (!token || !siteId) throw new Error('Wix credentials incomplete');

  const payload = {
    order: {
      lineItems: (snapshot.items || []).map((item) => ({
        productName: { original: item.name },
        quantity: item.quantity,
        price: Number(item.unit_price || 0).toFixed(2),
      })),
      buyerInfo: {
        contactDetails: {
          firstName: snapshot.customer.first_name,
          phone: snapshot.customer.phone || undefined,
        },
      },
      paymentStatus: 'PAID',
      fulfillmentStatus: 'FULFILLED',
      buyerNote: snapshot.note,
    },
  };

  const resp = await fetch('https://www.wixapis.com/ecom/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: token,
      'wix-site-id': siteId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Wix push failed: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const orderId = data?.order?.id || data?.id;
  if (!orderId) throw new Error('Wix push succeeded but no order id returned');
  return { external_id: String(orderId), raw: data };
}

module.exports = { testConnection, pushOrder };
