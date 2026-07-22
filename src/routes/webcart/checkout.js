'use strict';

const express = require('express');
const router = express.Router();
const {
  path,
  supabaseAdmin,
  getKdsSecret,
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
  normalizeShippingProvider,
  fetchShiprocketCheapestRate,
  getAffinityForWebcart,
  cartWeightKg,
  resolveCartLineWeights,
  deductStockForLines,
  joinStockWaitlist,
  deriveMenuDiscount,
  ACTIVE_TOKEN_STATUSES,
  DEFAULT_THEME,
  CHAT_SERVICE_URL,
  SHIPPED_LOBS,
  digitsOnly,
  phoneVariants,
  slugify,
  readHostSlug,
  pickSupportPhone,
  requiresShipping,
  parsePincodeFromAddress,
  formatDeliveryAddress,
  buildSubmissionFingerprint,
  buildExpiredPayload,
  resolveRestaurantBySlug,
  isRestaurantLob,
  calculateDelivery,
  resolveCurrentSlot,
  normalizeSlots,
  isActiveWalkInRow,
  menuTokenSoftSession,
  resolveSession,
  deriveStockStatus,
  fetchMenuItems,
  triggerConfirmAndPay,
  SHIPROCKET_STATUS_MAP,
  triggerShipmentNotify,
  selectDroppingMissingColumns,
  isMissingColumnError,
} = require('./shared');

router.get('/api/webcart/payment-status', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const phone = String(req.query.phone || '').trim();
    const orderRefFilter = String(req.query.order_ref || '').trim();
    const bookingIdFilter = String(req.query.booking_id || '').trim();

    if ((!token || !phone) && !bookingIdFilter) {
      return res.status(400).json({ ok: false, error: 'token/phone or booking_id is required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    let bookingId = bookingIdFilter;
    let submission = null;

    if (token && phone) {
      const session = await resolveSession({
        restaurantId: restaurant.id,
        token,
        phone,
      });

      if (session) {
        submission = session?.meta?.web_cart_submission || null;
        bookingId = bookingId || String(submission?.booking_id || '').trim();
      }
    }

    if (!submission && bookingId) {
      const { data: bookingRow, error: bookingErr } = await supabaseAdmin
        .from('bookings')
        .select('id, meta, status, payment_status')
        .eq('restaurant_id', restaurant.id)
        .eq('id', bookingId)
        .limit(1)
        .maybeSingle();
      if (bookingErr) throw bookingErr;

      const meta = bookingRow?.meta || {};
      submission = meta?.web_cart_submission || null;
      if (!submission) {
        return res.json({
          ok: true,
          has_active_submission: false,
          paid: String(bookingRow?.payment_status || '').toLowerCase() === 'paid' || String(bookingRow?.status || '').toLowerCase() === 'confirmed',
          status: 'booking_lookup_only',
          booking_id: bookingId,
        });
      }
    }

    if (!submission) {
      return res.json({
        ok: true,
        has_active_submission: false,
        paid: false,
        status: 'no_submission',
      });
    }

    const submissionOrderRef = String(submission.order_ref || '').trim();
    if (orderRefFilter && submissionOrderRef && submissionOrderRef !== orderRefFilter) {
      return res.json({
        ok: true,
        has_active_submission: false,
        paid: false,
        status: 'stale_submission',
      });
    }

    bookingId = String(submission.booking_id || bookingId || '').trim();
    if (!bookingId) {
      return res.json({
        ok: true,
        has_active_submission: true,
        paid: false,
        status: 'booking_pending',
        order_ref: submissionOrderRef || null,
      });
    }

    const { data: booking, error: bookingErr } = await supabaseAdmin
      .from('bookings')
      .select('id, status, payment_status')
      .eq('restaurant_id', restaurant.id)
      .eq('id', bookingId)
      .limit(1)
      .maybeSingle();
    if (bookingErr) throw bookingErr;

    const bookingStatus = String(booking?.status || '').trim().toLowerCase();
    const paymentStatus = String(booking?.payment_status || '').trim().toLowerCase();
    const paid = paymentStatus === 'paid' || bookingStatus === 'confirmed';

    return res.json({
      ok: true,
      has_active_submission: true,
      booking_id: bookingId,
      order_ref: submissionOrderRef || null,
      paid,
      booking_status: bookingStatus || null,
      payment_status: paymentStatus || null,
      updated_at: null,
    });
  } catch (err) {
    console.error('[webcart/payment-status]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to fetch payment status.' });
  }
});

router.post('/api/webcart/submit', async (req, res) => {
  try {
    const {
      token,
      phone,
      items,
      special_request,
      promo_code,
      customer_name,
      delivery_address,
      pincode,
      redeem_loyalty,
    } = req.body || {};
    const safeToken = String(token || '').trim();
    const safePhone = String(phone || '').trim();
    const guestCheckout = String(req.body?.guest || '').trim() === '1'
      || safeToken === 'guest'
      || !safeToken;
    const wantLoyaltyRedeem = !!redeem_loyalty;

    if (!safePhone || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: 'phone and at least one item are required.' });
    }
    if (!guestCheckout && !safeToken) {
      return res.status(400).json({ ok: false, error: 'token, phone, and at least one item are required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    const catalogLob = !isRestaurantLob(restaurant.lob_type);
    if (guestCheckout && !catalogLob) {
      return res.status(400).json({ ok: false, error: 'Guest checkout is only available on packaged storefronts.' });
    }

    // Server-side FSSAI gate — defense in depth in case a row was published
    // before the license was on file, or was set stocked via an older client.
    const needsFssai = String(restaurant.lob_type || '').toLowerCase() === 'food_products'
      && !String(restaurant.fssai_license || '').trim();
    if (needsFssai) {
      return res.status(409).json({
        ok: false,
        error: 'This store cannot accept orders yet — FSSAI license is missing on file.',
      });
    }

    const shippedOrder = requiresShipping(restaurant.lob_type);
    const safeName = String(customer_name || '').trim();
    const safeAddress = String(delivery_address || '').trim();
    const safePincode = normalizePincode(pincode);

    if (shippedOrder) {
      if (!safeName) {
        return res.status(400).json({ ok: false, error: 'Customer name is required for delivery orders.' });
      }
      if (!safeAddress) {
        return res.status(400).json({ ok: false, error: 'Delivery address is required.' });
      }
      if (!safePincode) {
        return res.status(400).json({ ok: false, error: 'A valid 6-digit pincode is required.' });
      }
    }

    const session = (!guestCheckout && safeToken)
      ? await resolveSession({
          restaurantId: restaurant.id,
          token: safeToken,
          phone: safePhone,
          allowSoftMenuSession: catalogLob,
          preferDelivery: catalogLob || shippedOrder,
        })
      : null;

    const { data: liveItems, error: liveErr } = await selectDroppingMissingColumns(
      'menu_items:submit',
      'id, retailer_id, name, price, weight_grams, item_type, meta, current_stock, is_stocked, availability_status, discount_percent, discount_ends_at',
      (select) => supabaseAdmin
        .from('menu_items')
        .select(select)
        .eq('restaurant_id', restaurant.id)
        .is('archived_at', null),
    );

    if (liveErr) throw liveErr;

    const liveMap = new Map();
    for (const row of (liveItems || [])) {
      liveMap.set(String(row.id), row);
      if (row.retailer_id) liveMap.set(String(row.retailer_id), row);
    }

    const unavailable = [];
    const shortages = [];
    for (const i of items) {
      const source = liveMap.get(String(i.id || ''));
      if (!source || !deriveStockStatus(source).stocked) {
        if (i.name) unavailable.push(i.name);
        continue;
      }
      const qty = Math.max(0, Math.floor(Number(i.qty || 0)));
      if (source.current_stock != null && qty > Number(source.current_stock)) {
        shortages.push({
          name: source.name,
          asked: qty,
          available: Number(source.current_stock),
        });
      }
    }

    if (unavailable.length) {
      const label = unavailable.slice(0, 3).join(', ');
      return res.status(409).json({
        ok: false,
        error: `${label} ${unavailable.length > 1 ? 'are' : 'is'} no longer available — please remove ${unavailable.length > 1 ? 'them' : 'it'} to continue.`,
        unavailable_items: unavailable,
      });
    }

    if (shortages.length) {
      const s = shortages[0];
      return res.status(409).json({
        ok: false,
        error: `Only ${s.available} left of ${s.name} (you asked for ${s.asked}).`,
        shortages,
      });
    }

    const weightedLines = resolveCartLineWeights(items, liveItems || []);
    const weightByKey = new Map(weightedLines.map((l) => [String(l.id), l.weight_grams]));

    const normalizedItems = [];
    const stockLines = [];
    for (const row of items) {
      const source = liveMap.get(String(row.id || ''));
      if (!source || !deriveStockStatus(source).stocked) continue;

      const qty = Math.max(0, Math.floor(Number(row.qty || 0)));
      if (!qty) continue;

      const discount = deriveMenuDiscount(source);
      const unitPrice = Number(discount.effective_price || source.price || 0);
      const key = source.retailer_id || source.id;
      normalizedItems.push({
        id: key,
        name: source.name,
        qty,
        price: unitPrice,
        list_price: Number(source.price || 0),
        discount_percent: discount.discount_active ? discount.discount_percent : null,
        line_total: unitPrice * qty,
        weight_grams: Number(
          weightByKey.get(String(row.id))
          ?? weightByKey.get(String(key))
          ?? source.weight_grams
          ?? 0,
        ) || 0,
      });
      stockLines.push({
        menu_item_id: source.id,
        id: source.id,
        qty,
        name: source.name,
      });
    }

    if (!normalizedItems.length) {
      return res.status(400).json({ ok: false, error: 'No valid items to submit.' });
    }

    const stockResult = await deductStockForLines(supabaseAdmin, restaurant.id, stockLines);
    if (!stockResult.ok) {
      const s = stockResult.shortages[0];
      return res.status(409).json({
        ok: false,
        error: `Only ${s.available} left of ${s.name} (you asked for ${s.asked}).`,
        shortages: stockResult.shortages,
      });
    }

    const subtotal = normalizedItems.reduce((sum, line) => sum + Number(line.line_total || 0), 0);
    const sessionMeta = session?.meta || {};
    const rawType = String(session?.type || sessionMeta.service_type || 'takeaway').toLowerCase();
    const orderMode = String(
      sessionMeta.order_mode
      || (rawType.startsWith('scheduled_') ? 'scheduled' : '')
      || ''
    ).toLowerCase();
    let serviceType = rawType;
    if (shippedOrder) {
      serviceType = 'delivery';
    } else if (rawType === 'scheduled_delivery') serviceType = 'delivery';
    else if (rawType === 'scheduled_takeaway' || rawType === 'scheduled_pickup') serviceType = 'takeaway';
    else if (rawType === 'dinein' || rawType === 'dine-in') serviceType = 'dine_in';
    else if (sessionMeta.service_type) serviceType = String(sessionMeta.service_type).toLowerCase();
    const parcelPerItem = parseFloat(restaurant.parcel_charge_per_item || 0);
    const gstRate = parseFloat(restaurant.gst_rate || 5.0);

// Parcel charge: sum of qty × rate per item (only for takeaway/delivery)
    let parcelCharge = 0;
    if (['takeaway', 'delivery'].includes(serviceType) && parcelPerItem > 0) {
      parcelCharge = normalizedItems.reduce((s, l) => s + l.qty * parcelPerItem, 0);
      parcelCharge = Math.round(parcelCharge * 100) / 100;
    }

// Delivery charge — shipped LOBs always re-quote server-side; restaurants use flat default
    let deliveryCharge = 0;
    let deliveryQuote = null;
    if (shippedOrder) {
      deliveryQuote = await calculateDelivery(restaurant, safePincode, subtotal, {
        items: normalizedItems,
      });
      deliveryCharge = Number(deliveryQuote.charge || 0);
    } else if (serviceType === 'delivery') {
      deliveryCharge = parseFloat(restaurant.delivery_charge_default || 40);
    }

    const preGst = Math.round((subtotal + parcelCharge + deliveryCharge) * 100) / 100;
    const gstAmount = Math.round(preGst * gstRate / 100 * 100) / 100;
    let totalAmount = Math.round((preGst + gstAmount) * 100) / 100;

    let loyaltyDiscount = 0;
    let loyaltyRedeemed = 0;
    if (wantLoyaltyRedeem) {
      try {
        const { getLoyaltyConfig, redeemLoyaltyPoints } = require('../loyalty');
        const cfg = await getLoyaltyConfig(restaurant.id);
        const redeemResult = await redeemLoyaltyPoints({
          restaurantId: restaurant.id,
          phone: session?.phone || safePhone,
          points: cfg.redeem_points,
          reason: 'checkout_redeem',
        });
        if (redeemResult.ok) {
          loyaltyDiscount = Number(cfg.redeem_inr || 0);
          loyaltyRedeemed = Number(redeemResult.redeemed || cfg.redeem_points);
          totalAmount = Math.max(1, Math.round((totalAmount - loyaltyDiscount) * 100) / 100);
        }
      } catch (loyErr) {
        console.warn('[webcart/submit] loyalty redeem:', loyErr.message);
      }
    }

    if (totalAmount < 1) {
      return res.status(400).json({ ok: false, error: 'Total amount is too low to process payment.' });
    }

    const orderRef = `${(session?.id || safeToken)}-${Date.now().toString().slice(-6)}`;
    const formattedAddress = shippedOrder
      ? formatDeliveryAddress(safeAddress, safePincode)
      : '';
    const submissionFingerprint = buildSubmissionFingerprint({
      items: normalizedItems,
      promo_code,
      special_request,
      total: totalAmount,
      delivery_address: formattedAddress,
      pincode: safePincode,
    });

    const prevSubmission = session?.meta?.web_cart_submission || {};
    const prevSubmittedAt = prevSubmission?.submitted_at ? new Date(prevSubmission.submitted_at).getTime() : 0;
    const prevIsFresh = Number.isFinite(prevSubmittedAt) && (Date.now() - prevSubmittedAt) < (20 * 60 * 1000);
    const isSameSubmission =
      prevSubmission?.submission_fingerprint &&
      prevSubmission.submission_fingerprint === submissionFingerprint;
    const alreadySent = !!prevSubmission?.payment_cta_sent;

    if (prevIsFresh && isSameSubmission && alreadySent) {
      return res.json({
        ok: true,
        order_ref: prevSubmission.order_ref || orderRef,
        message: 'Confirm & Pay was already sent to your WhatsApp. Please complete payment there.',
        deduped: true,
      });
    }

    const nextMeta = {
      ...sessionMeta,
      service_type: serviceType,
      order_mode: orderMode || sessionMeta.order_mode || null,
      scheduled_at: sessionMeta.scheduled_at || null,
      customer_name: shippedOrder ? safeName : (sessionMeta.customer_name || sessionMeta.name || null),
      delivery_address: shippedOrder ? formattedAddress : (sessionMeta.delivery_address || null),
      delivery_pincode: shippedOrder ? safePincode : (sessionMeta.delivery_pincode || null),
      delivery_zone: deliveryQuote?.zone || sessionMeta.delivery_zone || null,
      delivery_source: deliveryQuote?.source || sessionMeta.delivery_source || null,
      web_cart_submission: {
        submitted_at: new Date().toISOString(),
        promo_code: promo_code ? String(promo_code).trim().slice(0, 40) : null,
        special_request: special_request ? String(special_request).trim().slice(0, 500) : null,
        customer_name: shippedOrder ? safeName : null,
        delivery_address: shippedOrder ? formattedAddress : null,
        delivery_pincode: shippedOrder ? safePincode : null,
        delivery_zone: deliveryQuote?.zone || null,
        delivery_source: deliveryQuote?.source || null,
        free_delivery_applied: !!deliveryQuote?.free_delivery_applied,
        cod_enabled: deliveryQuote?.cod_enabled ?? null,
        item_count: normalizedItems.length,
        items: normalizedItems,
        parcel_charge: parcelCharge,
        delivery_charge: deliveryCharge,
        gst_rate: gstRate,
        gst_amount: gstAmount,
        pre_gst_total: preGst,
        total: totalAmount,
        loyalty_discount: loyaltyDiscount || 0,
        loyalty_points_redeemed: loyaltyRedeemed || 0,
        order_ref: orderRef,
        submission_fingerprint: submissionFingerprint,
        payment_cta_sent: false,
      },
    };

    if (session?.id) {
      // Soft sessions still need cart meta persisted on the walk-in row so
      // confirm-and-pay / dedupe can recover if chat retries. Clear completed_at
      // so a reused packaged menu link stays orderable.
      const walkPatch = {
        meta: nextMeta,
        completed_at: null,
        ...(shippedOrder || catalogLob ? { type: 'delivery', status: 'delivery' } : {}),
      };
      const { error } = await supabaseAdmin
        .from('walk_in_tokens')
        .update(walkPatch)
        .eq('restaurant_id', restaurant.id)
        .eq('id', session.id);

      if (error) {
        console.warn('[webcart/submit] walk_in meta update:', error.message);
        if (!session._soft) throw error;
      }
    }

    const confirmResult = await triggerConfirmAndPay({
      restaurant_id: restaurant.id,
      customer_phone: session?.phone || safePhone,
      customer_name: shippedOrder
        ? safeName
        : (String(sessionMeta?.customer_name || sessionMeta?.name || '').trim() || 'Guest'),
      delivery_address: shippedOrder ? formattedAddress : undefined,
      pincode: shippedOrder ? safePincode : undefined,
      token: String(session?.id || safeToken),
      order_ref: orderRef,
      // Send the walk-in type when scheduled so chat can gate approval;
      // otherwise send normalized booking service_type.
      service_type: orderMode === 'scheduled' || rawType.startsWith('scheduled_')
        ? rawType
        : serviceType,
      order_mode: orderMode || undefined,
      scheduled_at: sessionMeta.scheduled_at || undefined,
      total: totalAmount,
      items: normalizedItems,
      promo_code: promo_code ? String(promo_code).trim().slice(0, 40) : null,
      special_request: special_request ? String(special_request).trim().slice(0, 500) : null,
      delivery_charge: deliveryCharge,
      delivery_zone: deliveryQuote?.zone || undefined,
      delivery_source: deliveryQuote?.source || undefined,
    });

    if (session?.id) {
      const confirmedMeta = {
        ...(nextMeta || {}),
        web_cart_submission: {
          ...(nextMeta.web_cart_submission || {}),
          payment_cta_sent: true,
          booking_id: confirmResult?.booking_id || null,
          payment_link: confirmResult?.payment_link || null,
        },
      };

      await supabaseAdmin
        .from('walk_in_tokens')
        .update({ meta: confirmedMeta, completed_at: null })
        .eq('restaurant_id', restaurant.id)
        .eq('id', session.id);
    }

    let giftUrl = null;
    if (req.body?.is_gift) {
      try {
        const { createGiftLink } = require('../../helpers/giftLinks');
        const gift = await createGiftLink(supabaseAdmin, {
          restaurantId: restaurant.id,
          bookingId: confirmResult?.booking_id || null,
          gifterPhone: session?.phone || safePhone,
          recipientPhone: req.body?.gift_recipient_phone || null,
          recipientName: req.body?.gift_recipient_name || null,
          giftMessage: req.body?.gift_message || null,
          // The order actually ships to whatever address/pincode was submitted
          // for delivery — recorded here so gift orders stay traceable even
          // though the gifter (not the recipient) is the paying customer.
          recipientAddress: shippedOrder ? formattedAddress : null,
          recipientPincode: shippedOrder ? safePincode : null,
        });
        giftUrl = `${req.protocol}://${req.get('host')}/gift/${gift.token}`;
      } catch (giftErr) {
        console.warn('[webcart/submit] gift link:', giftErr.message);
      }
    }

    // Mark any abandoned-cart draft as converted so recovery job skips this phone.
    try {
      const phoneKey = digitsOnly(session?.phone || safePhone) || safePhone;
      if (phoneKey) {
        await supabaseAdmin
          .from('webcart_drafts')
          .update({ converted_at: new Date().toISOString(), item_count: 0, items_json: [] })
          .eq('restaurant_id', restaurant.id)
          .eq('phone', phoneKey);
      }
    } catch (draftErr) {
      console.warn('[webcart/submit] draft convert:', draftErr.message);
    }

    return res.json({
      ok: true,
      order_ref: orderRef,
      booking_id: confirmResult?.booking_id || null,
      payment_link: confirmResult?.payment_link || null,
      gift_url: giftUrl,
      awaiting_approval: !!confirmResult?.awaiting_approval,
      message: confirmResult?.awaiting_approval
        ? 'Order submitted for manager approval. Check WhatsApp for updates.'
        : confirmResult?.payment_link
          ? 'Hosted checkout ready.'
          : 'Confirm & Pay has been sent to your WhatsApp.',
    });
  } catch (err) {
    console.error('[webcart/submit]', err.message, err.response || '');
    const detail = err.response?.error || err.message || 'Failed to submit order.';
    const status = /scheduled_at_missing|unavailable|FSSAI|required/i.test(String(detail)) ? 409 : 500;
    return res.status(status).json({
      ok: false,
      error: detail === 'Failed to submit order.' || /Chat service error/i.test(String(detail))
        ? 'Could not complete checkout. Please try again in a moment.'
        : detail,
    });
  }
});

/** Upsert a lightweight cart draft for abandoned-cart recovery. */
router.post('/api/webcart/draft', async (req, res) => {
  try {
    const token = String(req.body?.token || req.query.token || '').trim();
    const phone = String(req.body?.phone || req.query.phone || '').trim();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!phone) {
      return res.status(400).json({ ok: false, error: 'phone is required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    const itemCount = items.reduce((n, row) => n + Math.max(0, Math.floor(Number(row?.qty || 0))), 0);
    const phoneKey = digitsOnly(phone) || phone;
    const nowIso = new Date().toISOString();

    const payload = {
      restaurant_id: restaurant.id,
      phone: phoneKey,
      session_token: token || null,
      items_json: items.slice(0, 40).map((row) => ({
        id: String(row?.id || ''),
        name: String(row?.name || '').slice(0, 120),
        qty: Math.max(0, Math.floor(Number(row?.qty || 0))),
        price: Number(row?.price || 0),
      })),
      item_count: itemCount,
      updated_at: nowIso,
    };

    if (itemCount <= 0) {
      await supabaseAdmin
        .from('webcart_drafts')
        .upsert(
          { ...payload, opened_at: nowIso, converted_at: nowIso },
          { onConflict: 'restaurant_id,phone' },
        );
      return res.json({ ok: true, cleared: true });
    }

    const { data: existing } = await supabaseAdmin
      .from('webcart_drafts')
      .select('id, opened_at, reminder_sent_at, converted_at')
      .eq('restaurant_id', restaurant.id)
      .eq('phone', phoneKey)
      .maybeSingle();

    const row = {
      ...payload,
      opened_at: existing?.opened_at || nowIso,
      converted_at: null,
      reminder_sent_at: existing?.converted_at ? null : (existing?.reminder_sent_at || null),
    };

    const { error } = await supabaseAdmin
      .from('webcart_drafts')
      .upsert(row, { onConflict: 'restaurant_id,phone' });
    if (error) {
      if (isMissingColumnError(error) || /webcart_drafts|pgrst205|42p01/i.test(error.message || '')) {
        console.warn('[webcart/draft] table missing — run 20260722_webcart_drafts.sql');
        return res.json({ ok: true, skipped: true });
      }
      throw error;
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[webcart/draft]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to save cart draft.' });
  }
});

module.exports = router;
