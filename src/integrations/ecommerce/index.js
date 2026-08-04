'use strict';

/**
 * Ecommerce order push fan-out.
 * Loads active tenant_integrations (channel=ecommerce) and pushes non-blocking.
 */

const { supabaseAdmin } = require('../../config/supabase');
const {
  ECOMMERCE_PROVIDERS,
  PROVIDER_LABELS,
  normalizeProvider,
  isDineInService,
  buildOrderSnapshot,
  alreadyPushedProvider,
} = require('./shared');

const adapters = {
  shopify: require('./shopify'),
  woocommerce: require('./woocommerce'),
  wix: require('./wix'),
  dukaan: require('./dukaan'),
  instamojo: require('./instamojo'),
  webhook: require('./webhook'),
  ondc: require('./ondc'),
};

async function listActiveIntegrations(restaurantId) {
  const { data, error } = await supabaseAdmin
    .from('tenant_integrations')
    .select(
      'id, restaurant_id, provider, channel, api_endpoint, access_token, webhook_secret, config, is_active',
    )
    .eq('restaurant_id', restaurantId)
    .eq('channel', 'ecommerce')
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).filter((row) => normalizeProvider(row.provider));
}

async function loadBooking(bookingId) {
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .select(
      'id, restaurant_id, service_type, status, payment_status, token_number, order_ref, '
      + 'customer_phone, customer_name, delivery_address, order_subtotal, meta, schedule_meta, '
      + 'external_order_id',
    )
    .eq('id', bookingId)
    .maybeSingle();

  if (error) {
    // Older DBs may lack external_order_id / customer_* columns.
    if (/external_order_id|customer_name|customer_phone|order_ref|order_subtotal/i.test(error.message || '')) {
      const retry = await supabaseAdmin
        .from('bookings')
        .select('id, restaurant_id, service_type, status, payment_status, token_number, meta, schedule_meta')
        .eq('id', bookingId)
        .maybeSingle();
      if (retry.error) throw retry.error;
      return retry.data || null;
    }
    throw error;
  }
  return data || null;
}

async function recordPushResult(booking, provider, result, status, errorMessage) {
  const meta = (booking.meta && typeof booking.meta === 'object') ? { ...booking.meta } : {};
  const pushes = Array.isArray(meta.ecommerce_pushes) ? [...meta.ecommerce_pushes] : [];
  const entry = {
    provider,
    external_id: result?.external_id || null,
    status,
    error: errorMessage || null,
    at: new Date().toISOString(),
  };
  const idx = pushes.findIndex((p) => String(p.provider).toLowerCase() === provider);
  if (idx >= 0) pushes[idx] = entry;
  else pushes.push(entry);
  meta.ecommerce_pushes = pushes;

  const patch = {
    meta,
    updated_at: new Date().toISOString(),
  };
  if (status === 'success' && result?.external_id && !booking.external_order_id) {
    patch.external_order_id = String(result.external_id);
  }

  const { error } = await supabaseAdmin
    .from('bookings')
    .update(patch)
    .eq('id', booking.id);

  if (error && /external_order_id/i.test(error.message || '')) {
    delete patch.external_order_id;
    await supabaseAdmin.from('bookings').update(patch).eq('id', booking.id);
  } else if (error) {
    console.warn('[ecommerce] recordPushResult failed:', error.message);
  }
}

/**
 * Push a paid booking to all active ecommerce integrations.
 * Non-fatal by design — callers should .catch().
 */
async function pushEcommerceOrders(bookingId, { items } = {}) {
  if (!bookingId) return { skipped: true, reason: 'no_booking_id' };

  const booking = await loadBooking(bookingId);
  if (!booking) return { skipped: true, reason: 'booking_not_found' };

  const paymentStatus = String(booking.payment_status || '').toLowerCase();
  if (!['paid', 'captured', 'success'].includes(paymentStatus)) {
    return { skipped: true, reason: 'not_paid', payment_status: paymentStatus };
  }

  if (isDineInService(booking.service_type)) {
    return { skipped: true, reason: 'dine_in' };
  }

  const integrations = await listActiveIntegrations(booking.restaurant_id);
  if (!integrations.length) {
    return { skipped: true, reason: 'no_active_integrations' };
  }

  const snapshot = buildOrderSnapshot(booking, items);
  const results = [];

  await Promise.allSettled(
    integrations.map(async (integration) => {
      const provider = normalizeProvider(integration.provider);
      const adapter = adapters[provider];
      if (!adapter) {
        results.push({ provider, status: 'skipped', error: 'unknown_adapter' });
        return;
      }
      if (provider === 'ondc') {
        results.push({ provider, status: 'skipped', error: 'ondc_coming_soon' });
        return;
      }
      if (alreadyPushedProvider(booking, provider)) {
        results.push({ provider, status: 'skipped', error: 'already_pushed' });
        return;
      }
      try {
        const pushed = await adapter.pushOrder(integration, snapshot);
        await recordPushResult(booking, provider, pushed, 'success', null);
        console.log(
          `[ecommerce] ✅ ${provider} order ${pushed.external_id} for booking ${booking.id}`,
        );
        results.push({ provider, status: 'success', external_id: pushed.external_id });
      } catch (err) {
        const msg = err?.message || String(err);
        console.error(`[ecommerce] ${provider} push failed (non-fatal):`, msg);
        await recordPushResult(booking, provider, null, 'failed', msg);
        results.push({ provider, status: 'failed', error: msg });
      }
    }),
  );

  return { ok: true, booking_id: booking.id, results };
}

async function testProviderConnection(integration) {
  const provider = normalizeProvider(integration?.provider);
  const adapter = adapters[provider];
  if (!adapter) return { ok: false, error: 'Unknown provider' };
  return adapter.testConnection(integration);
}

module.exports = {
  ECOMMERCE_PROVIDERS,
  PROVIDER_LABELS,
  normalizeProvider,
  adapters,
  listActiveIntegrations,
  pushEcommerceOrders,
  testProviderConnection,
  buildOrderSnapshot,
};
