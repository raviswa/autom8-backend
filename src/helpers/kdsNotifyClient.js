// Internal client for POST /api/kds/notify (schedulers, waHandlers backup path).

'use strict';

const { getKdsSecret } = require('../config/internalSecret');

function buildItemsFromCart(cart) {
  if (!cart || typeof cart !== 'object') return [];
  return Object.entries(cart).map(([id, line]) => ({
    retailer_id: id,
    name:        line?.title || line?.name || 'Item',
    qty:         line?.qty ?? 1,
    unit_price:  line?.unit_price ?? 0,
  }));
}

/**
 * Fire KDS notify using the same secret the Python chat agent must use.
 * @returns {Promise<boolean>}
 */
async function notifyKdsFromSessionContext(session) {
  const ctx = session?.context || {};
  if (ctx._kitchen_sent === true || ctx._kitchen_sent === 'true') return true;

  const pending = ctx._pending_kitchen || {};
  const cart    = pending.cart || ctx.cart || {};
  const items   = buildItemsFromCart(cart);
  if (!items.length && !pending.order_text) return false;

  const secret = getKdsSecret();
  const base   = (process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/$/, '');

  const payload = {
    secret,
    restaurant_id:  session.restaurant_id,
    customer_name:  ctx.customer_name || 'Guest',
    customer_phone: session.customer_phone,
    token_number:   ctx.display_token || ctx.token_number || null,
    table_number:   ctx.table_number != null ? String(ctx.table_number) : null,
    service_type:   ctx.service_type || 'dine_in',
    items: items.length
      ? items
      : [{ retailer_id: 'manual', name: pending.order_text || 'Order', qty: 1, unit_price: 0 }],
    special_notes: ctx.special_notes || null,
  };

  try {
    const resp = await fetch(`${base}/api/kds/notify`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': secret,
        Authorization:       `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const created = Number(data.kds_items_created || 0);
      const expected = payload.items.length;
      if (created < expected) {
        console.error(
          `[kds-notify-client] partial — expected ${expected} lines, got ${created} for token ${payload.token_number}`
        );
        return false;
      }
      console.log(`[kds-notify-client] ✅ token ${payload.token_number} → KDS (${created} items)`);
      return true;
    }
    const body = await resp.text();
    console.error(`[kds-notify-client] failed ${resp.status}: ${body.slice(0, 300)}`);
    return false;
  } catch (err) {
    console.error('[kds-notify-client] error:', err.message);
    return false;
  }
}

async def notifyKdsFromPayload({
  restaurant_id,
  customer_name,
  customer_phone,
  token_number,
  service_type,
  items,
  special_notes,
  booking_id,
  create_kot = false,
}) {
  const secret = getKdsSecret();
  const base   = (process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/$/, '');

  const payload = {
    secret,
    restaurant_id,
    customer_name:  customer_name || 'Guest',
    customer_phone,
    token_number,
    service_type:   service_type || 'takeaway',
    items:          items?.length ? items : [],
    special_notes:  special_notes || null,
    booking_id:     booking_id || null,
    create_kot:     !!create_kot,
  };

  if (!payload.items.length) return null;

  try {
    const resp = await fetch(`${base}/api/kds/notify`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-internal-secret': secret,
        Authorization:       `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error(`[kds-notify-client] failed ${resp.status}:`, JSON.stringify(data).slice(0, 300));
      return null;
    }
    const added = Number(data.kds_items_added ?? data.kds_items_created ?? 0);
    if (added <= 0 && !data.deduplicated) return null;
    return data.order_id || true;
  } catch (err) {
    console.error('[kds-notify-client] error:', err.message);
    return null;
  }
}

module.exports = { notifyKdsFromSessionContext, buildItemsFromCart, notifyKdsFromPayload };
