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

// ── sendWhatsAppMessage ───────────────────────────────────────────────────────
// Sends a plain-text WhatsApp message.
// Looks up per-outlet credentials from restaurant_integrations if restaurantId
// is supplied; falls back to global env vars for standalone installs.

async function sendWhatsAppMessage(toNumber, message, restaurantId = null) {
  try {
    let accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
    let phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    let apiUrl        = process.env.WHATSAPP_API_URL;

    if (restaurantId) {
      const { data: integration } = await supabaseAdmin
        .from('restaurant_integrations')
        .select('access_token, phone_number_id, api_endpoint')
        .eq('restaurant_id', restaurantId)
        .eq('provider', 'meta')
        .eq('is_active', true)
        .maybeSingle();

      if (integration?.access_token)    accessToken   = integration.access_token;
      if (integration?.phone_number_id) phoneNumberId = integration.phone_number_id;
      if (integration?.api_endpoint)    apiUrl        = integration.api_endpoint;
    }

    if (!accessToken || !phoneNumberId || !apiUrl) {
      console.warn(`[WhatsApp] Missing credentials — skipping message to ${toNumber}`);
      return;
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
    } else {
      console.log(`[WhatsApp] ✅ Sent to ${toNumber}`);
    }
  } catch (err) {
    console.error('[WhatsApp] Failed to send message:', err.message);
  }
}

// ── sendWhatsAppCatalogMessage ────────────────────────────────────────────────
// Sends a WhatsApp catalog interactive message so the customer can browse items.
// Tries each stocked item as thumbnail until one succeeds (avoids 131009 errors).

async function sendWhatsAppCatalogMessage(toNumber, restaurantId) {
  try {
    if (!process.env.META_CATALOG_ID) {
      console.warn('[catalog-msg] META_CATALOG_ID not set — skipping');
      return;
    }

    const { data: availableItems } = await supabaseAdmin
      .from('menu_items')
      .select('retailer_id, name')
      .eq('restaurant_id', restaurantId)
      .eq('is_stocked', true)
      .not('retailer_id', 'is', null)
      .order('name', { ascending: true })
      .limit(10);

    if (!availableItems?.length) return;

    let accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
    let phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    let apiUrl        = process.env.WHATSAPP_API_URL;

    const { data: integration } = await supabaseAdmin
      .from('restaurant_integrations')
      .select('access_token, phone_number_id, api_endpoint')
      .eq('restaurant_id', restaurantId)
      .eq('provider', 'meta')
      .eq('is_active', true)
      .maybeSingle();

    if (integration?.access_token)    accessToken   = integration.access_token;
    if (integration?.phone_number_id) phoneNumberId = integration.phone_number_id;
    if (integration?.api_endpoint)    apiUrl        = integration.api_endpoint;

    for (const item of availableItems) {
      const response = await fetch(`${apiUrl}/${phoneNumberId}/messages`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:   String(toNumber),
          type: 'interactive',
          interactive: {
            type:   'catalog_message',
            body:   { text: "🍽️ Browse today's menu and add items to your basket 🛒" },
            footer: { text: 'Tap any item to see details and order' },
            action: { name: 'catalog_message', parameters: { thumbnail_product_retailer_id: item.retailer_id } },
          },
        }),
        signal: AbortSignal.timeout(8_000),
      });

      if (response.ok) {
        console.log(`[catalog-msg] ✅ Sent to ${toNumber}`);
        return;
      }

      const errBody = await response.json().catch(() => ({}));
      const errCode = errBody?.error?.code;
      // 131009 = product not found in catalog — try next item
      if (errCode === 131009 || errBody?.error?.details?.includes('not found')) continue;

      console.error('[catalog-msg] API error:', JSON.stringify(errBody).slice(0, 300));
      return;
    }

    // All items failed — trigger catalog re-sync in background
    console.warn('[catalog-msg] All catalog items failed — scheduling re-sync');
  } catch (err) {
    console.error('[catalog-msg] Failed:', err.message);
  }
}

// ── notifyOrderReady ──────────────────────────────────────────────────────────
// Marks the order as 'ready', sends a WA notification to the customer,
// and broadcasts ORDER_READY to all KDS screens.

async function notifyOrderReady({ orderId, restaurantId, kdsItem }) {
  try {
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('orders')
      .update({ status: 'ready' })
      .eq('id', orderId)
      .neq('status', 'ready')
      .neq('status', 'cancelled')
      .select('order_number, table:table_id!left(table_number), walk_in_tokens(phone)')
      .single();

    if (updateErr || !updated) return;

    const phone = updated.walk_in_tokens?.[0]?.phone ?? kdsItem?.customer_phone ?? null;
    if (phone) {
      await sendWhatsAppMessage(
        phone,
        `✅ *Your order is ready!*\n\nOrder: *${updated.order_number}*\n` +
        (updated.table?.table_number ? `Table: *${updated.table.table_number}*\n` : '') +
        `\nYour food will be served shortly. Enjoy! 🍽️`,
        restaurantId
      );
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
    let accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
    let phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    let apiUrl        = process.env.WHATSAPP_API_URL;

    if (restaurantId) {
      const { data: integration } = await supabaseAdmin
        .from('restaurant_integrations')
        .select('access_token, phone_number_id, api_endpoint')
        .eq('restaurant_id', restaurantId)
        .eq('provider', 'meta')
        .eq('is_active', true)
        .maybeSingle();

      if (integration?.access_token)    accessToken   = integration.access_token;
      if (integration?.phone_number_id) phoneNumberId = integration.phone_number_id;
      if (integration?.api_endpoint)    apiUrl        = integration.api_endpoint;
    }

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
