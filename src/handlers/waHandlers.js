// ============================================================================
// src/handlers/waHandlers.js
// ============================================================================
// Extracted from server.js to eliminate the circular dependency:
//   BEFORE: server.js → webhook.js → server.js  (circular)
//   AFTER:  server.js → webhook.js → waHandlers.js  (clean)
//           server.js → waHandlers.js  (for validateReferralCode, generateReferralSharePrompt)
//
// RULE: This file MUST NEVER require server.js or any route file.
//       Only leaf modules are permitted: ../config/supabase, ../websocket
// ============================================================================

'use strict';

// BEGIN: Separated/Resilient Architecture Updates

// ── Critical imports — hard dependencies, exit if unavailable ─────────────────
// Both supabase and websocket are non-negotiable. If either fails to load,
// the entire handler module is broken and continuing would cause silent failures.

let supabaseAdmin;
let broadcastToRestaurant;

try {
  ({ supabaseAdmin } = require('../config/supabase'));
} catch (err) {
  console.error('[waHandlers] FATAL — could not load supabase config:', err.message);
  process.exit(1);
}

try {
  ({ broadcastToRestaurant } = require('../websocket'));
} catch (err) {
  console.error('[waHandlers] FATAL — could not load websocket module:', err.message);
  process.exit(1);
}

// ── Condiment detection — keyword lists ──────────────────────────────────────
// Local copies — must stay in sync with any updates in server.js keyword lists.

const SOUTH_INDIAN_ITEM_KEYWORDS = [
  'idli', 'idly', 'dosa', 'dosai', 'vada', 'vadai', 'pongal',
  'uttapam', 'upma', 'rava', 'appam', 'puttu', 'pesarattu',
  'medu', 'uthapam', 'paniyaram',
];
const SOUTH_INDIAN_CATEGORY_KEYWORDS = [
  'morning tiffin', 'morning_tiffin', 'tiffin', 'south indian',
  'south_indian', 'southindian',
];
const NORTH_INDIAN_ITEM_KEYWORDS = [
  'biryani', 'biriyani', 'pulao', 'pulav', 'parotta', 'paratha',
  'fried rice', 'meals', 'curry', 'korma', 'masala', 'paneer',
  'dal makhani', 'naan', 'roti', 'thali', 'kofta',
];
const NORTH_INDIAN_CATEGORY_KEYWORDS = [
  'north indian', 'north_indian', 'northindian', 'biryani',
  'main course', 'main_course', 'meals',
];

// ── GST rates — local copy (avoids cross-require to server.js) ───────────────

const GST_RATES = {
  default:          5,   // CGST 2.5% + SGST 2.5% — standard restaurant without ITC
  premium_service: 18,   // AC restaurants / hotels with room tariff > ₹7500
  non_ac:           5,
};

// ============================================================================
// PURE HELPER FUNCTIONS — no I/O, no side effects, safe to call anywhere
// ============================================================================

/**
 * detectCondimentContext
 * Inspects cart items and returns 'south_indian', 'north_indian', or 'default'.
 */
function detectCondimentContext(items) {
  if (!Array.isArray(items) || items.length === 0) return 'default';

  let hasSouthIndian = false;
  let hasNorthIndian = false;

  for (const item of items) {
    const rawName     = (item?.menu_item?.name ?? item?.item_name ?? item?.name     ?? '').toLowerCase();
    const rawCategory = (item?.menu_item?.category ?? item?.category               ?? '').toLowerCase();

    if (SOUTH_INDIAN_ITEM_KEYWORDS.some(kw => rawName.includes(kw)) ||
        SOUTH_INDIAN_CATEGORY_KEYWORDS.some(kw => rawCategory.includes(kw))) {
      hasSouthIndian = true;
    }
    if (NORTH_INDIAN_ITEM_KEYWORDS.some(kw => rawName.includes(kw)) ||
        NORTH_INDIAN_CATEGORY_KEYWORDS.some(kw => rawCategory.includes(kw))) {
      hasNorthIndian = true;
    }
  }

  if (hasSouthIndian) return 'south_indian';
  if (hasNorthIndian) return 'north_indian';
  return 'default';
}

/**
 * buildSpecialNotesPrompt
 * Constructs a context-aware WhatsApp message asking for special notes.
 */
function buildSpecialNotesPrompt(context, customerName = 'there') {
  const greeting = `Hi ${customerName}! 😊\n\n`;
  const closer   = `\n\nOr reply *"No notes"* / *"Skip"* to confirm as-is.`;

  switch (context) {
    case 'south_indian':
      return greeting +
        `📝 *Any special requirements for your order?*\n\n` +
        `For example:\n• Extra *Sambar* on the side 🍲\n` +
        `• Less spice / more spice\n• Allergy or dietary notes\n` +
        `• Specific cooking instructions` + closer;

    case 'north_indian':
      return greeting +
        `📝 *Any special requirements for your order?*\n\n` +
        `For example:\n• Extra *Raita* on the side 🥣\n` +
        `• Less spice / extra gravy\n• Allergy or dietary notes\n` +
        `• Specific cooking instructions` + closer;

    default:
      return greeting +
        `📝 *Any special requirements for your order?*\n\n` +
        `For example:\n• Extra side portions\n• Spice adjustments\n` +
        `• Allergy or dietary notes\n• Specific cooking instructions` + closer;
  }
}

/**
 * calculateGST
 * Base-price → CGST/SGST breakdown. Mirrors server.js implementation.
 */
function calculateGST(subtotal, ratePercent = 5) {
  const rate     = Number(ratePercent) || 5;
  const halfRate = rate / 2;
  const cgst     = parseFloat(((subtotal * halfRate) / 100).toFixed(2));
  const sgst     = parseFloat(((subtotal * halfRate) / 100).toFixed(2));
  return {
    cgst,
    sgst,
    totalTax:   parseFloat((cgst + sgst).toFixed(2)),
    grandTotal: parseFloat((subtotal + cgst + sgst).toFixed(2)),
  };
}

/**
 * buildInvoicePayload
 * Constructs the structured JSON payload for the PDF renderer / Zoho push.
 */
function buildInvoicePayload(order, restaurant, gstRate = 5) {
  const subtotal       = parseFloat(order?.subtotal        ?? 0);
  const deliveryCharge = parseFloat(order?.delivery_charge ?? 0);
  const { cgst, sgst, grandTotal } = calculateGST(subtotal, gstRate);
  const finalTotal = parseFloat((grandTotal + deliveryCharge).toFixed(2));

  return {
    invoice_meta: {
      brand_id:         restaurant?.brand_id  ?? null,
      store_id:         restaurant?.id        ?? null,
      store_name:       restaurant?.name      ?? '',
      gstin:            restaurant?.gstin     ?? restaurant?.store_gstin ?? '',
      order_id:         order?.id,
      order_number:     order?.order_number,
      fulfillment_type: order?.service_type   ?? order?.source ?? 'dine_in',
      invoice_date:     new Date().toISOString(),
    },
    financial_breakdown: {
      subtotal_base_price:          subtotal,
      cgst_amount:                  cgst,
      cgst_rate_pct:                gstRate / 2,
      sgst_amount:                  sgst,
      sgst_rate_pct:                gstRate / 2,
      total_gst:                    parseFloat((cgst + sgst).toFixed(2)),
      packaging_or_delivery_charge: deliveryCharge,
      grand_total:                  finalTotal,
    },
    line_items: (order?.order_items ?? []).map(oi => ({
      name:       oi?.menu_item?.name     ?? oi?.item_name ?? 'Item',
      category:   oi?.menu_item?.category ?? '',
      quantity:   oi?.quantity            ?? 1,
      unit_price: parseFloat(oi?.unit_price ?? 0),
      line_total: parseFloat(((oi?.unit_price ?? 0) * (oi?.quantity ?? 1)).toFixed(2)),
    })),
    verification: {
      qr_code_data:           `${process.env.API_BASE_URL ?? 'https://api.autom8.works'}/verify/${order?.id}`,
      accounting_sync_status: 'PENDING_DAILY_ROLLUP_ZOHO_TALLY',
    },
  };
}

// ============================================================================
// sendWhatsAppMessage
// Local copy with per-restaurant credential support.
// server.js keeps its own copy for routes and schedulers.
// Changes here should be mirrored in server.js sendWhatsAppMessage.
// ============================================================================

async function sendWhatsAppMessage(toNumber, message, restaurantId = null) {
  try {
    if (!toNumber || !message) {
      console.warn('[waHandlers:WA] sendWhatsAppMessage called with missing args — skipping');
      return;
    }

    let accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
    let phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    let apiUrl        = process.env.WHATSAPP_API_URL;

    // Per-restaurant credential override via restaurant_integrations
    if (restaurantId) {
      try {
        const { data: integration } = await supabaseAdmin
          .from('restaurant_integrations')
          .select('access_token, phone_number_id, api_endpoint')
          .eq('restaurant_id', restaurantId)
          .eq('provider', 'whatsapp')
          .eq('is_active', true)
          .maybeSingle();
        if (integration?.access_token)    accessToken   = integration.access_token;
        if (integration?.phone_number_id) phoneNumberId = integration.phone_number_id;
        if (integration?.api_endpoint)    apiUrl        = integration.api_endpoint;
      } catch (integErr) {
        console.warn('[waHandlers:WA] Integration lookup failed, using global creds:', integErr.message);
      }
    }

    if (!accessToken || !phoneNumberId || !apiUrl) {
      console.warn('[waHandlers:WA] Missing WA credentials — message not sent to', toNumber);
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
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[waHandlers:WA] API error:', err);
    } else {
      console.log(`[waHandlers:WA] ✅ Sent to ${toNumber}`);
    }
  } catch (err) {
    console.error('[waHandlers:WA] Failed:', err.message);
  }
}

// ============================================================================
// handleFeedbackReply
// Called from webhook.js when an inbound WA message may be a feedback rating.
// Returns true if the message was consumed as feedback, false otherwise.
// ============================================================================

async function handleFeedbackReply(customerPhone, message, restaurantId) {
  try {
    if (!customerPhone || !restaurantId) return false;

    const phone = String(customerPhone).replace(/\D/g, '');
    if (!phone) return false;

    const { data: record } = await supabaseAdmin
      .from('feedback_pending')
      .select('*')
      .eq('customer_phone', phone)
      .eq('restaurant_id', restaurantId)
      .eq('feedback_sent', true)      // invitation already dispatched
      .eq('manager_notified', false)  // not yet processed
      .order('freed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!record) return false;

    const text       = (message || '').trim();
    const digitMatch = text.match(/\b([1-5])\b/);
    const starMatch  = text.match(/([⭐★]+)/);
    let rating = null;
    if (digitMatch) {
      rating = parseInt(digitMatch[1], 10);
    } else if (starMatch) {
      rating = Math.min((starMatch[1].match(/[⭐★]/g) || []).length, 5) || null;
    }

    // Persist customer reply
    await supabaseAdmin
      .from('feedback_pending')
      .update({
        feedback_text:        text,
        feedback_rating:      rating,
        feedback_received_at: new Date().toISOString(),
        manager_notified:     true,
      })
      .eq('id', record.id);

    // Thank-you to customer
    const thankYou = (rating && rating >= 4)
      ? `🙏 Thank you for the *${rating}⭐* rating, ${record.customer_name}!\n\nWe're so glad you enjoyed your visit. See you again soon! 😊`
      : `🙏 Thank you for your honest feedback, ${record.customer_name}!\n\nWe'll use it to make things better. Hope to see you again! 😊`;
    await sendWhatsAppMessage(customerPhone, thankYou);

    // Manager escalation alert
    if (process.env.MANAGER_WHATSAPP_NUMBER) {
      const starBar     = rating ? '⭐'.repeat(rating) + ` (${rating}/5)` : 'No rating given';
      const tableLabel  = record.table_number ? `Table ${record.table_number}` : 'Unknown table';
      const urgencyFlag = (rating && rating <= 2)
        ? '🚨 *LOW SCORE — Immediate follow-up recommended*\n'
        : '';
      await sendWhatsAppMessage(
        process.env.MANAGER_WHATSAPP_NUMBER,
        `📣 *Customer Feedback Alert*\n────────────────────\n${urgencyFlag}` +
        `Customer: *${record.customer_name}*\nPhone:    +${phone}\n` +
        `Token:    ${record.token_number || '—'}\nTable:    ${tableLabel}\n` +
        `Rating:   ${starBar}\n────────────────────\n` +
        `*Notes:*\n${text || '(no text provided)'}\n────────────────────\n` +
        `Received: ${new Date().toISOString()}`
      );
    }

    return true;
  } catch (err) {
    console.error('[waHandlers:handleFeedbackReply]', err.message);
    return false;
  }
}

// ============================================================================
// validateReferralCode
// Validates a referral code entered via WhatsApp. First-order customers only.
// Returns true if the message was consumed as a referral attempt.
// ============================================================================

async function validateReferralCode(customerPhone, code, restaurantId) {
  try {
    if (!customerPhone || !code || !restaurantId) return false;

    const cleanPhone = String(customerPhone).replace(/\D/g, '');
    if (!cleanPhone) return false;

    // Guard 1: only first-time customers
    const { count: priorOrders } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('customer_phone', cleanPhone)
      .eq('status', 'completed');

    if ((priorOrders ?? 0) > 0) {
      await sendWhatsAppMessage(customerPhone,
        `🎁 Referral codes are only for first-time orders!\n\nWelcome back — we hope you enjoy your meal. 😊`
      );
      return true;
    }

    // Guard 2: code not already redeemed by this customer
    const { data: existingUse } = await supabaseAdmin
      .from('referral_uses')
      .select('id')
      .eq('referee_phone', cleanPhone)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (existingUse) {
      await sendWhatsAppMessage(customerPhone,
        `🎁 You've already applied a referral code to your account.\n\nThe discount will be applied automatically at checkout. 😊`
      );
      return true;
    }

    // Guard 3: code validity, cap, and expiry
    const upperCode = String(code).toUpperCase().trim();
    const { data: referralRecord } = await supabaseAdmin
      .from('referral_codes')
      .select('id, owner_phone, referee_discount, referrer_reward, max_uses, use_count, expires_at, is_active')
      .eq('code', upperCode)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (!referralRecord?.is_active) {
      await sendWhatsAppMessage(customerPhone,
        `❌ *"${upperCode}"* is not a valid referral code.\n\nPlease check the code and try again, or place your order without a code.`
      );
      return true;
    }
    if (referralRecord.max_uses && referralRecord.use_count >= referralRecord.max_uses) {
      await sendWhatsAppMessage(customerPhone,
        `😔 Referral code *"${upperCode}"* has already reached its usage limit.\n\nPlace your order and enjoy the menu! 🍽️`
      );
      return true;
    }
    if (referralRecord.expires_at && new Date(referralRecord.expires_at) < new Date()) {
      await sendWhatsAppMessage(customerPhone,
        `😔 Referral code *"${upperCode}"* has expired.\n\nPlace your order and enjoy the menu! 🍽️`
      );
      return true;
    }

    // Apply: create referral_uses record
    const { error: useErr } = await supabaseAdmin
      .from('referral_uses')
      .insert({
        restaurant_id:    restaurantId,
        referral_code_id: referralRecord.id,
        referrer_phone:   referralRecord.owner_phone,
        referee_phone:    cleanPhone,
        referee_discount: referralRecord.referee_discount,
        referrer_reward:  referralRecord.referrer_reward,
        status:           'pending',
        applied_at:       new Date().toISOString(),
      });
    if (useErr) throw useErr;

    await supabaseAdmin
      .from('referral_codes')
      .update({ use_count: (referralRecord.use_count ?? 0) + 1 })
      .eq('id', referralRecord.id);

    await sendWhatsAppMessage(customerPhone,
      `🎉 *Referral code applied!*\n\nYou'll get *${referralRecord.referee_discount}* off your first order.\n\nYour discount will be deducted automatically at checkout. Enjoy! 😊`
    );

    // Notify referrer (fire-and-forget)
    if (referralRecord.owner_phone) {
      sendWhatsAppMessage(
        referralRecord.owner_phone,
        `🎁 *Great news!* Someone just used your referral code *${upperCode}*!\n\nYou'll receive *${referralRecord.referrer_reward}* once they complete their first order. 🙌`
      ).catch(e => console.error('[waHandlers:referral] Referrer notify failed:', e.message));
    }

    console.log(`[waHandlers:referral] ✅ Code ${upperCode} applied for ${cleanPhone}`);
    return true;
  } catch (err) {
    console.error('[waHandlers:validateReferralCode]', err.message);
    return false;
  }
}

// ============================================================================
// generateReferralSharePrompt
// Sends the post-order share invitation. Creates a code if none exists.
// Non-fatal — never surfaces errors to the calling order flow.
// ============================================================================

async function generateReferralSharePrompt(customerPhone, restaurantId, customerName = 'there') {
  try {
    if (!customerPhone || !restaurantId) return;

    const cleanPhone = String(customerPhone).replace(/\D/g, '');
    if (!cleanPhone) return;

    let { data: codeRecord } = await supabaseAdmin
      .from('referral_codes')
      .select('code, referee_discount, referrer_reward')
      .eq('owner_phone', cleanPhone)
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true)
      .maybeSingle();

    if (!codeRecord) {
      const newCode = cleanPhone.slice(-4).toUpperCase() +
        Math.random().toString(36).substring(2, 4).toUpperCase();

      const { data: created, error: createErr } = await supabaseAdmin
        .from('referral_codes')
        .insert({
          restaurant_id:    restaurantId,
          owner_phone:      cleanPhone,
          code:             newCode,
          referee_discount: process.env.DEFAULT_REFEREE_DISCOUNT || '₹50',
          referrer_reward:  process.env.DEFAULT_REFERRER_REWARD  || '₹30',
          is_active:        true,
          use_count:        0,
          created_at:       new Date().toISOString(),
        })
        .select('code, referee_discount, referrer_reward')
        .single();

      if (createErr) throw createErr;
      codeRecord = created;
    }

    const firstName = (customerName || 'there').split(' ')[0];
    await sendWhatsAppMessage(customerPhone,
      `Loved your meal, ${firstName}? 🎁 *Share the food love!*\n\n` +
      `Pass your unique code *${codeRecord.code}* to a friend.\n\n` +
      `They get *${codeRecord.referee_discount}* off their first order, and you get ` +
      `*${codeRecord.referrer_reward}* credited to your account when they order!\n\n` +
      `Tap to copy code: \`${codeRecord.code}\``
    );
    console.log(`[waHandlers:referral] 📤 Share prompt sent to ${cleanPhone} (code: ${codeRecord.code})`);
  } catch (err) {
    console.error('[waHandlers:generateReferralSharePrompt] (non-fatal):', err.message);
  }
}

// ============================================================================
// handleWhatsAppOrder
// Main WhatsApp catalog order handler. Called from webhook.js on order events.
// Wrapped in a top-level try/catch — any unhandled error is logged, not thrown.
// ============================================================================

async function handleWhatsAppOrder(message, metadata, preResolvedRestaurantId = null) {
  try {
    const customerPhone = message?.from;
    const productItems  = message?.order?.product_items ?? [];

    if (!customerPhone) {
      console.warn('[waHandlers:order] Missing message.from — skipping');
      return;
    }
    if (productItems.length === 0) {
      console.warn('[waHandlers:order] Empty product_items — skipping');
      return;
    }

    // ── Resolve restaurant from phone_number_id ───────────────────────────────
    // Uses restaurant_integrations (not restaurants.whatsapp_phone_number_id
    // which does not exist in the schema).
    // resolveRestaurantByPhone is cached (5-min TTL) to avoid a DB hit per order.
    // Webhook.js pre-resolves and passes it directly; resolve here as fallback.
    let restaurantId = preResolvedRestaurantId || process.env.DEFAULT_RESTAURANT_ID || null;
    if (!restaurantId && metadata?.phone_number_id) {
      try {
        const { resolveRestaurantByPhone } = require('../helpers/resolveRestaurant');
        const resolved = await resolveRestaurantByPhone(metadata.phone_number_id);
        if (resolved) restaurantId = resolved;
      } catch (resolveErr) {
        console.warn('[waHandlers:order] Restaurant resolve error:', resolveErr.message);
      }
    }
    if (!restaurantId) {
      console.error('[waHandlers:order] Could not resolve restaurant — aborting');
      return;
    }

    // ── Check for feedback reply before treating as new order ─────────────────
    const wasFeedback = await handleFeedbackReply(
      customerPhone,
      message?.text?.body || '',
      restaurantId
    ).catch(err => {
      console.error('[waHandlers:order] Feedback check error (non-fatal):', err.message);
      return false;
    });
    if (wasFeedback) return;

    const normalizedPhone = String(customerPhone).replace(/\D/g, '');

    // ── Find seated token ─────────────────────────────────────────────────────
    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('phone', normalizedPhone)
      .eq('status', 'seated')
      .order('seated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!token) {
      console.warn(`[waHandlers:order] No seated token for ${normalizedPhone}`);
      await sendWhatsAppMessage(customerPhone,
        `⚠️ We couldn't find your table assignment.\nPlease ask a staff member for help.`
      );
      return;
    }

    // ── Upsert customers row (non-fatal) ──────────────────────────────────────
    supabaseAdmin
      .from('customers')
      .upsert({
        restaurant_id:      restaurantId,
        phone:              normalizedPhone,
        name:               token.name || 'Guest',
        visit_count:        1,
        opted_in_marketing: true,
        created_at:         new Date().toISOString(),
      }, { onConflict: 'restaurant_id,phone', ignoreDuplicates: true })
      .catch(e => console.warn('[waHandlers:order] customers upsert (non-fatal):', e.message));

    // ── Create order header ───────────────────────────────────────────────────
    const orderNumber = `ORD-WA-${Date.now()}`;
    const { data: orderData, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_id:      token.table_id,
        order_number:  orderNumber,
        status:        'pending',
        source:        'whatsapp',
      })
      .select()
      .single();

    if (orderError || !orderData) {
      console.error('[waHandlers:order] Failed to create order:', orderError?.message);
      return;
    }

    // ── Process items ─────────────────────────────────────────────────────────
    let subtotal = 0;
    const kdsInserts = [];
    const skippedOos = [];

    for (const item of productItems) {
      try {
        const { data: menuItem } = await supabaseAdmin
          .from('menu_items')
          .select('id, name, price, is_stocked, is_available, category')
          .eq('restaurant_id', restaurantId)
          .eq('retailer_id', item.product_retailer_id)
          .maybeSingle();

        if (!menuItem) {
          console.warn(`[waHandlers:order] No menu item for retailer_id: ${item.product_retailer_id}`);
          continue;
        }
        if (!menuItem.is_stocked || !menuItem.is_available) {
          skippedOos.push(menuItem.name);
          continue;
        }

        subtotal += (menuItem.price ?? 0) * (item.quantity ?? 1);

        const { data: orderItem, error: itemError } = await supabaseAdmin
          .from('order_items')
          .insert({
            order_id:     orderData.id,
            menu_item_id: menuItem.id,
            quantity:     item.quantity ?? 1,
            unit_price:   menuItem.price,
          })
          .select()
          .single();

        if (itemError) {
          console.error('[waHandlers:order] order_item insert failed:', itemError.message);
          continue;
        }

        kdsInserts.push({
          restaurant_id: restaurantId,
          order_item_id: orderItem.id,
          status:        'pending',
          priority:      'normal',
          item_name:     menuItem.name,
          item_category: menuItem.category || '',
        });
      } catch (itemErr) {
        console.error('[waHandlers:order] Item processing error:', itemErr.message);
      }
    }

    // ── Flush KDS batch ───────────────────────────────────────────────────────
    if (kdsInserts.length > 0) {
      const { error: kdsError } = await supabaseAdmin.from('kds_items').insert(kdsInserts);
      if (kdsError) console.error('[waHandlers:order] KDS insert failed:', kdsError.message);
    }

    // ── Finalise totals ───────────────────────────────────────────────────────
    const tax   = subtotal * 0.1;
    const total = subtotal + tax;
    await supabaseAdmin
      .from('orders')
      .update({ subtotal, tax, total_amount: total })
      .eq('id', orderData.id);

    // ── Broadcast ORDER_NEW to dashboard ─────────────────────────────────────
    try {
      broadcastToRestaurant(restaurantId, {
        type:         'ORDER_NEW',
        order_id:     orderData.id,
        order_number: orderNumber,
        table_number: token.table_number,
        source:       'whatsapp',
        item_count:   kdsInserts.length,
        timestamp:    new Date().toISOString(),
      });
    } catch (wsErr) {
      console.error('[waHandlers:order] WebSocket broadcast failed (non-fatal):', wsErr.message);
    }

    // ── Manager notification ──────────────────────────────────────────────────
    if (process.env.MANAGER_WHATSAPP_NUMBER) {
      const itemLines = productItems
        .map(i => `• ${i.quantity ?? 1}x ${i.product_retailer_id}`)
        .join('\n');
      sendWhatsAppMessage(
        process.env.MANAGER_WHATSAPP_NUMBER,
        `🍽️ *New WhatsApp Order*\nOrder: *${orderNumber}*\nTable: *${token.table_number}*\n` +
        `Customer: ${token.name}\n\n${itemLines}\n\nTotal: ₹${total.toFixed(2)}`
      ).catch(e => console.error('[waHandlers:order] Manager notify failed:', e.message));
    }

    // ── Order confirmation to customer ────────────────────────────────────────
    const oosWarning = skippedOos.length > 0
      ? `\n\n⚠️ *Out of stock:*\n${skippedOos.map(n => `• ${n}`).join('\n')}`
      : '';
    const receiptUrl = `${process.env.API_BASE_URL ?? 'https://api.autom8.works'}/verify/${orderData.id}`;
    
  await sendWhatsAppMessage(customerPhone,
  `✅ *Order received!*\n\nOrder: *${orderNumber}*\nTable: *Table ${token.table_number}*\n` +
  `Items: ${kdsInserts.length}${oosWarning}\n\n` +
  `🧾 *Receipt:* ${receiptUrl}\n\n` +
  `We're preparing your food now! 🍳`
  );
    
    // ── REQ 1: Condiment nudge + conversation state stamp ─────────────────────
    if (kdsInserts.length > 0) {
      try {
        const condimentContext  = detectCondimentContext(
          kdsInserts.map(k => ({ name: k.item_name || '', category: k.item_category || '' }))
        );
        const customerFirstName = (token.name || 'there').split(' ')[0];
        await sendWhatsAppMessage(
          customerPhone,
          buildSpecialNotesPrompt(condimentContext, customerFirstName)
        );

        // Stamp conversation_states for REQ 2 timeout monitor (non-fatal)
        try {
          await supabaseAdmin
            .from('conversation_states')
            .upsert({
              restaurant_id:  restaurantId,
              customer_phone: normalizedPhone,
              adk_session_id: `${restaurantId}:${normalizedPhone}`,
              current_state:  'awaiting_special_notes',
              context: {
                booking_step:           'awaiting_special_notes',
                special_notes_asked_at: Math.floor(Date.now() / 1000),
                notes_order_id:         orderData.id,
                customer_name:          token.name || 'Guest',
                token_number:           token.id,
              },
              updated_at: new Date().toISOString(),
            }, { onConflict: 'restaurant_id,customer_phone', ignoreDuplicates: false });
        } catch (stampErr) {
          console.warn('[waHandlers:order] conversation_states stamp failed (non-fatal):', stampErr.message);
        }

        console.log(
          `[waHandlers:order] 📝 Condiment nudge sent (context: ${condimentContext}) for ${orderNumber}`
        );
      } catch (nudgeErr) {
        console.error('[waHandlers:order] Condiment nudge failed (non-fatal):', nudgeErr.message);
      }
    }

    // ── Audit log (non-fatal) ─────────────────────────────────────────────────
    supabaseAdmin.from('audit_logs').insert({
      restaurant_id: restaurantId,
      action:        'WhatsApp order created',
      details: {
        order_id:     orderData.id,
        order_number: orderNumber,
        phone:        normalizedPhone,
        item_count:   kdsInserts.length,
      },
    }).catch(e => console.warn('[waHandlers:order] audit log (non-fatal):', e.message));

    // ── REQ 7: Auto-generate GST invoice (non-fatal) ──────────────────────────
    try {
      const [{ data: restaurant }, { data: orderWithItems }] = await Promise.all([
        supabaseAdmin
          .from('restaurants')
          .select('id, name, gstin, brand_id')
          .eq('id', restaurantId)
          .maybeSingle(),
        supabaseAdmin
          .from('orders')
          .select('*, order_items(quantity, unit_price, menu_item:menu_item_id(name, category))')
          .eq('id', orderData.id)
          .single(),
      ]);

      if (orderWithItems && restaurant) {
        const invoicePayload = buildInvoicePayload(orderWithItems, restaurant, GST_RATES.default);
        await supabaseAdmin
          .from('invoices')
          .upsert({
            restaurant_id:          restaurantId,
            order_id:               orderData.id,
            payload:                invoicePayload,
            gst_rate:               GST_RATES.default,
            grand_total:            invoicePayload.financial_breakdown.grand_total,
            accounting_sync_status: 'PENDING_DAILY_ROLLUP_ZOHO_TALLY',
            generated_at:           new Date().toISOString(),
          }, { onConflict: 'order_id', ignoreDuplicates: false });
        console.log(`[waHandlers:order] 🧾 Invoice queued for ${orderNumber}`);
      }
    } catch (invoiceErr) {
      console.error('[waHandlers:order] Invoice generation failed (non-fatal):', invoiceErr.message);
    }

    // ── REQ 4: Post-order referral share prompt (non-fatal) ───────────────────
    generateReferralSharePrompt(customerPhone, restaurantId, token.name)
      .catch(e => console.error('[waHandlers:order] Referral share prompt failed (non-fatal):', e.message));

  } catch (err) {
    console.error('[waHandlers:handleWhatsAppOrder] Unhandled error:', err.message);
    // Do not rethrow — webhook.js must never crash on order processing failure
  }
}

// END: Separated/Resilient Architecture Updates

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  sendWhatsAppMessage,
  handleWhatsAppOrder,
  handleFeedbackReply,
  validateReferralCode,
  generateReferralSharePrompt,
};
