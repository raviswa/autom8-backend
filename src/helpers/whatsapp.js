// src/helpers/whatsapp.js
// ============================================================================
// Shared WhatsApp messaging helpers.
// Extracted from server.js — single source of truth used by tokens, kds,
// feedback, delivery, schedulers, and any other module that needs to send WA.
//
// All functions are fire-safe: internal try/catch so a failed WA send
// never crashes the caller's request lifecycle.
// ============================================================================

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { broadcastToRestaurant } = require('../websocket');
const { getMetaCatalogId, getWhatsAppIntegration } = require('./restaurantConfig');

// ── sendWhatsAppMessage ───────────────────────────────────────────────────────
// Sends a plain-text WhatsApp message.
// Looks up per-outlet credentials from restaurant_integrations if restaurantId
// is supplied; falls back to global env vars for standalone installs.

async function sendWhatsAppMessage(toNumber, message, restaurantId = null) {
  try {
    const creds = restaurantId
      ? await getWhatsAppIntegration(restaurantId)
      : null;

    let accessToken   = creds?.accessToken   || process.env.WHATSAPP_ACCESS_TOKEN;
    let phoneNumberId = creds?.phoneNumberId   || process.env.WHATSAPP_PHONE_NUMBER_ID;
    let apiUrl        = creds?.apiUrl          || process.env.WHATSAPP_API_URL;

    if (restaurantId && !creds) {
      console.warn(`[WhatsApp] No integration for restaurant ${restaurantId} — trying global env`);
    }

    if (!accessToken || !phoneNumberId || !apiUrl) {
      console.warn(`[WhatsApp] Missing credentials — skipping message to ${toNumber}`);
      return false;
    }

    const response = await fetch(`${apiUrl}/${phoneNumberId}/messages`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   String(toNumber),
        type: 'text',
        text: { body: message },
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[WhatsApp] API error:', JSON.stringify(err).slice(0, 300));
      return false;
    }
    console.log(`[WhatsApp] ✅ Sent to ${toNumber}`);
    return true;
  } catch (err) {
    console.error('[WhatsApp] Failed to send message:', err.message);
    return false;
  }
}

// ── sendWhatsAppCatalogMessage ────────────────────────────────────────────────
// Sends a WhatsApp product_list catalog (same format as Python chat takeaway menu).

async function sendWhatsAppCatalogMessage(toNumber, restaurantId) {
  try {
    const catalogId = await getMetaCatalogId(restaurantId);
    if (!catalogId) {
      console.error(
        `[catalog-msg] meta_catalog_id not set for restaurant ${restaurantId} — ` +
        'skipping (refusing env fallback; wrong catalog is a showstopper)',
      );
      return;
    }

    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('name')
      .eq('id', restaurantId)
      .maybeSingle();
    const label = restaurant?.name || 'Hotel Munafe';

    const { data: availableItems } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id')
      .eq('restaurant_id', restaurantId)
      .eq('is_stocked', true)
      .not('retailer_id', 'is', null)
      .order('name', { ascending: true })
      .limit(30);

    if (!availableItems?.length) {
      console.warn(`[catalog-msg] No stocked items for restaurant ${restaurantId}`);
      return;
    }

    const creds = await getWhatsAppIntegration(restaurantId);
    const accessToken   = creds?.accessToken   || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = creds?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const apiUrl        = creds?.apiUrl          || process.env.WHATSAPP_API_URL;

    if (!accessToken || !phoneNumberId || !apiUrl) {
      console.warn(`[catalog-msg] Missing WhatsApp credentials for restaurant ${restaurantId}`);
      return;
    }

    const productItems = availableItems.map((i) => ({
      product_retailer_id: i.retailer_id,
    }));

    const interactive = {
      type: 'product_list',
      header: { type: 'text', text: `🍽️ ${label} Menu` },
      body: {
        text:
          "Browse today's items below 👇\n" +
          'Tap any item to see details and add to your basket.\n' +
          'When done, send us your basket to place the order.',
      },
      footer: { text: `Prices excl. GST • ${label}` },
      action: {
        catalog_id: catalogId,
        sections: [{ title: "Today's Menu", product_items: productItems }],
      },
    };

    const response = await fetch(`${apiUrl}/${phoneNumberId}/messages`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                String(toNumber),
        type:              'interactive',
        interactive,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (response.ok) {
      console.log(`[catalog-msg] ✅ product_list sent to ${toNumber} (${productItems.length} items)`);
      return;
    }

    const errBody = await response.json().catch(() => ({}));
    console.error('[catalog-msg] API error:', JSON.stringify(errBody).slice(0, 300));
  } catch (err) {
    console.error('[catalog-msg] Failed:', err.message);
  }
}

// ── notifyOrderReady ──────────────────────────────────────────────────────────
// Marks the order as 'ready', notifies customer (+ assigned captain for takeaway),
// and broadcasts ORDER_READY to all KDS screens.

function isTakeawayOrder(serviceType, orderSource) {
  const svc = String(serviceType || '').toLowerCase();
  const src = String(orderSource || '').toLowerCase();
  return svc === 'takeaway' || src === 'takeaway' || src.includes('takeaway');
}

async function notifyOrderReady({ orderId, restaurantId, kdsItem }) {
  try {
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('orders')
      .update({ status: 'ready' })
      .eq('id', orderId)
      .neq('status', 'ready')
      .neq('status', 'cancelled')
      .select('order_number, source, customer_phone, table:table_id!left(table_number)')
      .single();

    if (updateErr || !updated) return;

    const { notifyCaptainTakeawayReady, orderNumberToToken } = require('./captainAssignment');
    const isTakeaway = isTakeawayOrder(kdsItem?.service_type, updated.source);
    const tokenNumber = kdsItem?.token_number || orderNumberToToken(updated.order_number);
    const phone = updated.customer_phone ?? kdsItem?.customer_phone ?? null;

    if (phone) {
      if (isTakeaway) {
        const tokenLabel = tokenNumber || updated.order_number;
        await sendWhatsAppMessage(
          phone,
          `✅ *Your takeaway order is ready!*\n\n` +
          `Token: *${tokenLabel}*\n` +
          `Order: *${updated.order_number}*\n\n` +
          `Please pick up at the counter. Show your receipt QR when you collect. 🛍️`,
          restaurantId,
        );
      } else {
        await sendWhatsAppMessage(
          phone,
          `✅ *Your order is ready!*\n\nOrder: *${updated.order_number}*\n` +
          (updated.table?.table_number ? `Table: *${updated.table.table_number}*\n` : '') +
          `\nYour food will be served shortly. Enjoy! 🍽️`,
          restaurantId,
        );
      }
    }

    if (isTakeaway && tokenNumber) {
      await notifyCaptainTakeawayReady({
        restaurantId,
        tokenNumber,
        orderNumber:  updated.order_number,
        customerPhone: phone,
      });
    }

    broadcastToRestaurant(restaurantId, {
      type:         'ORDER_READY',
      order_id:     orderId,
      order_number: updated.order_number,
      table_number: updated.table?.table_number ?? null,
      timestamp:    new Date().toISOString(),
    });
  } catch (err) {
    console.error('[notifyOrderReady] Error:', err.message);
  }
}

// ── sendWhatsAppInteractive ───────────────────────────────────────────────────
// Sends a WhatsApp interactive message (list, button, etc.).

async function sendWhatsAppInteractive(toNumber, interactive, restaurantId = null) {
  try {
    const creds = restaurantId ? await getWhatsAppIntegration(restaurantId) : null;
    const accessToken   = creds?.accessToken   || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = creds?.phoneNumberId   || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const apiUrl        = creds?.apiUrl          || process.env.WHATSAPP_API_URL;

    if (!accessToken || !phoneNumberId || !apiUrl) {
      console.warn(`[WhatsApp] Missing credentials — skipping interactive to ${toNumber}`);
      return false;
    }

    const response = await fetch(`${apiUrl}/${phoneNumberId}/messages`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   String(toNumber),
        type: 'interactive',
        interactive,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[WhatsApp] Interactive API error:', JSON.stringify(err).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[WhatsApp] Interactive send failed:', err.message);
    return false;
  }
}

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppInteractive,
  sendWhatsAppCatalogMessage,
  notifyOrderReady,
};
