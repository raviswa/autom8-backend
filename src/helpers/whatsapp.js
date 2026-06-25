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

async function isWhatsAppConfigured(restaurantId = null) {
  try {
    const creds = restaurantId ? await getWhatsAppIntegration(restaurantId) : null;
    const accessToken   = creds?.accessToken   || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = creds?.phoneNumberId   || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const apiUrl        = creds?.apiUrl          || process.env.WHATSAPP_API_URL;
    return Boolean(accessToken && phoneNumberId && apiUrl);
  } catch {
    return false;
  }
}

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

// ── sendWhatsAppInteractive ───────────────────────────────────────────────────
// Sends a WhatsApp interactive message (list, button, product_list, etc.).

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
        recipient_type:    'individual',
        to:                String(toNumber),
        type:              'interactive',
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

// ── Catalog helpers (Option B: category picker → filtered product_list) ───────

const CATALOG_PICKER_FULL_ID = '__full__';
const MAX_CATALOG_SECTIONS = 10;
const MAX_CATALOG_PRODUCTS = 30;
const MAX_LIST_ROW_TITLE = 24;
const MAX_LIST_ROW_DESC = 72;

function truncate(text, maxLen) {
  const s = String(text || '').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

async function fetchAvailableMenuItems(restaurantId) {
  const { data, error } = await supabaseAdmin
    .from('menu_items')
    .select('retailer_id, name, category')
    .eq('restaurant_id', restaurantId)
    .eq('is_available', true)
    .eq('is_stocked', true)
    .not('retailer_id', 'is', null)
    .order('name', { ascending: true });

  if (error) throw error;
  return (data ?? []).map((i) => ({
    id: i.retailer_id,
    title: i.name || '',
    category: (i.category || 'General').trim() || 'General',
  }));
}

function orderedCategories(items) {
  const seen = new Set();
  const cats = [];
  for (const item of items) {
    const cat = item.category || 'General';
    if (!seen.has(cat)) {
      seen.add(cat);
      cats.push(cat);
    }
  }
  return cats.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function itemsInCategory(items, category) {
  return items.filter((i) => (i.category || 'General') === category);
}

function buildProductListSections(items, category = null) {
  const available = items.filter((i) => i.id);
  if (!available.length) return [];

  if (category) {
    const scoped = itemsInCategory(available, category);
    if (!scoped.length) return [];
    return [{
      title: truncate(category, 24),
      product_items: scoped.slice(0, MAX_CATALOG_PRODUCTS).map((i) => ({
        product_retailer_id: i.id,
      })),
    }];
  }

  const sections = [];
  let productCount = 0;
  for (const cat of orderedCategories(available)) {
    if (sections.length >= MAX_CATALOG_SECTIONS) break;
    const catItems = itemsInCategory(available, cat);
    if (!catItems.length) continue;
    const remaining = MAX_CATALOG_PRODUCTS - productCount;
    if (remaining <= 0) break;
    const chunk = catItems.slice(0, remaining);
    sections.push({
      title: truncate(cat, 24),
      product_items: chunk.map((i) => ({ product_retailer_id: i.id })),
    });
    productCount += chunk.length;
  }
  return sections;
}

async function getRestaurantLabel(restaurantId) {
  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('name')
    .eq('id', restaurantId)
    .maybeSingle();
  return restaurant?.name || 'Hotel Munafe';
}

async function sendWhatsAppProductList(toNumber, restaurantId, { header, body, category = null }) {
  const catalogId = await getMetaCatalogId(restaurantId);
  if (!catalogId) {
    console.error(`[catalog-b] meta_catalog_id not set for restaurant ${restaurantId}`);
    return false;
  }

  const label = await getRestaurantLabel(restaurantId);
  const items = await fetchAvailableMenuItems(restaurantId);
  const sections = buildProductListSections(items, category);
  if (!sections.length) {
    console.error(`[catalog-b] No product_list sections (restaurant=${restaurantId}, category=${category})`);
    return false;
  }

  const productCount = sections.reduce(
    (n, s) => n + (s.product_items?.length || 0),
    0,
  );

  const ok = await sendWhatsAppInteractive(
    toNumber,
    {
      type: 'product_list',
      header: { type: 'text', text: truncate(header, 60) },
      body: { text: body },
      footer: { text: `Prices excl. GST • ${label}` },
      action: { catalog_id: catalogId, sections },
    },
    restaurantId,
  );

  if (ok) {
    const scope = category || 'all categories';
    console.log(
      `[catalog-b] ✅ product_list sent to ${toNumber} — ` +
      `${productCount} items, ${sections.length} section(s), scope=${scope}`,
    );
  }
  return ok;
}

function buildCategoryPickerRows(items) {
  const categories = orderedCategories(items);
  const categoryRowMap = {};
  const rows = [];

  categories.slice(0, 9).forEach((cat, index) => {
    const rowKey = String(index);
    categoryRowMap[rowKey] = cat;
    const catItems = itemsInCategory(items, cat);
    const sample = catItems.slice(0, 3).map((i) => i.title).join(', ');
    rows.push({
      // Meta list row ids: alphanumeric, underscores, dashes only (no spaces/&).
      id: `CAT:${rowKey}`,
      title: truncate(cat, MAX_LIST_ROW_TITLE),
      description: truncate(`${catItems.length} items · ${sample}`, MAX_LIST_ROW_DESC),
    });
  });

  categoryRowMap[CATALOG_PICKER_FULL_ID] = CATALOG_PICKER_FULL_ID;
  rows.push({
    id: `CAT:${CATALOG_PICKER_FULL_ID}`,
    title: truncate('Browse full menu', MAX_LIST_ROW_TITLE),
    description: truncate(`All ${items.length} items · every category`, MAX_LIST_ROW_DESC),
  });

  return { rows, categoryRowMap };
}

async function sendCatalogCategoryPicker(toNumber, restaurantId) {
  const items = await fetchAvailableMenuItems(restaurantId);
  if (!items.length) {
    console.warn(`[catalog-b] No available items for category picker (${restaurantId})`);
    return { ok: false, categoryRowMap: null };
  }

  const label = await getRestaurantLabel(restaurantId);
  const { rows, categoryRowMap } = buildCategoryPickerRows(items);

  const ok = await sendWhatsAppInteractive(
    toNumber,
    {
      type: 'list',
      header: { type: 'text', text: truncate(`🍽️ ${label} Menu`, 60) },
      body: {
        text:
          'What are you in the mood for today?\n\n' +
          'Tap *Browse menu* below, pick a category, ' +
          'then add items from our catalog to your basket.',
      },
      footer: { text: 'Prices excl. GST' },
      action: {
        button: 'Browse menu',
        sections: [{ title: 'Menu categories', rows }],
      },
    },
    restaurantId,
  );

  if (ok) {
    console.log(`[catalog-b] ✅ Category picker sent to ${toNumber} (${rows.length} rows)`);
  } else {
    console.error(`[catalog-b] Category picker rejected by Meta for ${toNumber}`);
  }
  return { ok, categoryRowMap: ok ? categoryRowMap : null };
}

// ── sendWhatsAppCatalogMessage ────────────────────────────────────────────────
// Grouped product_list fallback (legacy / retry when category picker fails).

async function sendWhatsAppCatalogMessage(toNumber, restaurantId) {
  try {
    const label = await getRestaurantLabel(restaurantId);
    const items = await fetchAvailableMenuItems(restaurantId);
    if (!items.length) {
      console.warn(`[catalog-msg] No stocked items for restaurant ${restaurantId}`);
      return false;
    }

    let sections = buildProductListSections(items);
    if (!sections.length) {
      sections = [{
        title: "Today's Menu",
        product_items: items.slice(0, MAX_CATALOG_PRODUCTS).map((i) => ({
          product_retailer_id: i.id,
        })),
      }];
    }

    const catalogId = await getMetaCatalogId(restaurantId);
    if (!catalogId) {
      console.error(
        `[catalog-msg] meta_catalog_id not set for restaurant ${restaurantId} — ` +
        'skipping (refusing env fallback; wrong catalog is a showstopper)',
      );
      return false;
    }

    const productCount = sections.reduce(
      (n, s) => n + (s.product_items?.length || 0),
      0,
    );

    const ok = await sendWhatsAppInteractive(
      toNumber,
      {
        type: 'product_list',
        header: { type: 'text', text: `🍽️ ${label} Menu` },
        body: {
          text:
            "Browse today's items below 👇\n" +
            'Tap any item to see details and add to your basket.\n' +
            'When done, send us your basket to place the order.',
        },
        footer: { text: `Prices excl. GST • ${label}` },
        action: { catalog_id: catalogId, sections },
      },
      restaurantId,
    );

    if (ok) {
      console.log(
        `[catalog-msg] ✅ product_list sent to ${toNumber} — ` +
        `${productCount} items, ${sections.length} section(s)`,
      );
    }
    return ok;
  } catch (err) {
    console.error('[catalog-msg] Failed:', err.message);
    return false;
  }
}

// ── sendSpecialDishesNote ─────────────────────────────────────────────────────
// WhatsApp note for manager-marked daily specials (not in Meta catalog).

async function sendSpecialDishesNote(toNumber, restaurantId) {
  try {
    const { data: specials, error } = await supabaseAdmin
      .from('menu_items')
      .select('name')
      .eq('restaurant_id', restaurantId)
      .eq('is_special_today', true)
      .eq('is_available', true)
      .order('name');

    if (error) {
      console.warn(`[specials] Query failed for ${restaurantId}:`, error.message);
      return false;
    }
    if (!specials?.length) {
      console.log(`[specials] No is_special_today items for restaurant ${restaurantId}`);
      return false;
    }

    const names = specials.slice(0, 8).map((i) => i.name).join(', ');
    const extra = specials.length > 8 ? ` (+${specials.length - 8} more)` : '';

    await sendWhatsAppMessage(
      toNumber,
      `🌟 *Today's specials:* ${names}${extra}\n`
        + "Ask us to add any of these while you order — we'd love to serve you! 😊",
      restaurantId,
    );
    console.log(`[specials] Sent ${specials.length} special(s) to ${toNumber}`);
    return true;
  } catch (err) {
    console.warn(`[specials] Failed for ${toNumber}:`, err.message);
    return false;
  }
}

async function sendPlainTextMenuFallback(toNumber, restaurantId) {
  const items = await fetchAvailableMenuItems(restaurantId);
  if (!items.length) return false;

  const byCategory = orderedCategories(items);
  const lines = [];
  let n = 1;
  for (const cat of byCategory) {
    lines.push(`*${cat}*`);
    for (const item of itemsInCategory(items, cat).slice(0, 8)) {
      lines.push(`${n}. ${item.title}`);
      n += 1;
      if (n > 25) break;
    }
    if (n > 25) break;
    lines.push('');
  }

  const ok = await sendWhatsAppMessage(
    toNumber,
    '🍽️ *Today\'s Menu*\n\n'
      + `${lines.join('\n').trim()}\n\n`
      + 'Reply with item names to order, or type *MENU* to reopen the catalog.',
    restaurantId,
  );
  if (ok) console.log(`[catalog-fallback] Plain-text menu sent to ${toNumber}`);
  return ok;
}

async function sendMenuLastResortPrompt(toNumber, restaurantId) {
  const ok = await sendWhatsAppMessage(
    toNumber,
    '🍽️ Our menu is ready for you!\n\n'
      + '👆 Tap the *🛍️ Shop* icon at the top of this chat to browse '
      + 'and add items to your basket — then come back here to confirm.\n\n'
      + 'Or type *MENU* for a text list of today\'s items.',
    restaurantId,
  );
  if (ok) console.log(`[catalog-fallback] Shop-icon prompt sent to ${toNumber}`);
  return ok;
}

/**
 * Option B menu send with full fallback chain (mirrors Python send_unified_booking_menu).
 */
async function sendWhatsAppCatalogWithSpecials(toNumber, restaurantId) {
  let categoryRowMap = null;

  let pickerResult = await sendCatalogCategoryPicker(toNumber, restaurantId);
  if (!pickerResult.ok) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    pickerResult = await sendCatalogCategoryPicker(toNumber, restaurantId);
  }

  let pickerSent = pickerResult.ok;
  if (pickerSent) categoryRowMap = pickerResult.categoryRowMap;

  let catalogOk = pickerSent;
  let mechanism = pickerSent ? 'catalog_b' : 'none';

  if (!pickerSent) {
    catalogOk = await sendWhatsAppCatalogMessage(toNumber, restaurantId);
    if (!catalogOk) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      catalogOk = await sendWhatsAppCatalogMessage(toNumber, restaurantId);
    }
    mechanism = catalogOk ? 'catalog' : 'none';
  }

  if (!catalogOk && !pickerSent) {
    const textOk = await sendPlainTextMenuFallback(toNumber, restaurantId);
    if (textOk) {
      mechanism = 'cart_text';
      catalogOk = true;
    }
  }

  if (!catalogOk && !pickerSent) {
    await sendMenuLastResortPrompt(toNumber, restaurantId);
    console.error(
      `[catalog-b] ALL menu mechanisms failed for ${toNumber} (restaurant ${restaurantId})`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const specialsSent = await sendSpecialDishesNote(toNumber, restaurantId);
  return {
    catalogOk: catalogOk || pickerSent,
    pickerSent,
    specialsSent,
    mechanism,
    categoryRowMap,
  };
}

// ── notifyOrderReady ──────────────────────────────────────────────────────────
// Marks the order as 'ready', notifies customer (+ assigned captain for takeaway),
// and broadcasts ORDER_READY to all KDS screens.

function isTakeawayOrder(serviceType, orderSource) {
  const svc = String(serviceType || '').toLowerCase();
  const src = String(orderSource || '').toLowerCase();
  return svc === 'takeaway' || src === 'takeaway' || src.includes('takeaway');
}

function isDeliveryOrder(serviceType, orderSource) {
  const svc = String(serviceType || '').toLowerCase();
  const src = String(orderSource || '').toLowerCase();
  return svc === 'delivery' || src === 'delivery' || src.includes('delivery');
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
    const isDelivery = isDeliveryOrder(kdsItem?.service_type, updated.source);
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
      } else if (isDelivery) {
        const tokenLabel = tokenNumber || null;
        await sendWhatsAppMessage(
          phone,
          `✅ *Your delivery order is ready!*\n\n` +
          (tokenLabel ? `Token: *${tokenLabel}*\n` : '') +
          `Order: *${updated.order_number}*\n\n` +
          `Our kitchen has finished preparing your order. It will be packed and ` +
          `sent out to your delivery address shortly.\n\n` +
          `You'll receive another message when it's on the way. 🛵`,
          restaurantId,
        );
      } else {
        await sendWhatsAppMessage(
          phone,
          `✅ *Your order is ready!*\n\nOrder: *${updated.order_number}*\n` +
          (updated.table?.table_number ? `Table: *${updated.table.table_number}*\n` : '') +
          `\nYour food will be served at your table shortly. Enjoy! 🍽️`,
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

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  isWhatsAppConfigured,
  sendWhatsAppMessage,
  sendWhatsAppInteractive,
  sendWhatsAppCatalogMessage,
  sendCatalogCategoryPicker,
  sendWhatsAppProductList,
  sendSpecialDishesNote,
  sendWhatsAppCatalogWithSpecials,
  notifyOrderReady,
  CATALOG_PICKER_FULL_ID,
};
