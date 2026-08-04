'use strict';

/**
 * Instamojo — payment/link style API. For order mirroring we POST a payment
 * record using API Key + Auth Token.
 * access_token = API Key, webhook_secret = Auth Token.
 */

async function testConnection(integration) {
  const apiKey = String(integration.access_token || '').trim();
  const authToken = String(integration.webhook_secret || '').trim();
  if (!apiKey || !authToken) {
    return { ok: false, error: 'API Key and Auth Token are required' };
  }
  const resp = await fetch('https://www.instamojo.com/api/1.1/payment-requests/', {
    method: 'GET',
    headers: {
      'X-Api-Key': apiKey,
      'X-Auth-Token': authToken,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { ok: false, error: `Instamojo HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

async function pushOrder(integration, snapshot) {
  const apiKey = String(integration.access_token || '').trim();
  const authToken = String(integration.webhook_secret || '').trim();
  if (!apiKey || !authToken) throw new Error('Instamojo credentials incomplete');

  const amount = Number(snapshot.total || 0);
  if (!(amount > 0)) throw new Error('Instamojo push requires a positive total');

  const payload = {
    purpose: snapshot.note || `Munafe order ${snapshot.order_ref || snapshot.booking_id}`,
    amount: amount.toFixed(2),
    buyer_name: snapshot.customer.name,
    phone: snapshot.customer.phone || undefined,
    send_email: false,
    send_sms: false,
    allow_repeated_payments: false,
  };

  const resp = await fetch('https://www.instamojo.com/api/1.1/payment-requests/', {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'X-Auth-Token': authToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.success === false) {
    throw new Error(`Instamojo push failed: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const orderId = data?.payment_request?.id || data?.id;
  if (!orderId) throw new Error('Instamojo push succeeded but no payment_request id returned');
  return { external_id: String(orderId), raw: data };
}

module.exports = { testConnection, pushOrder };
