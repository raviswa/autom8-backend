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

router.get('/api/webcart/saved-addresses', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const phone = String(req.query.phone || '').trim();
    if (!token || !phone) {
      return res.status(400).json({ ok: false, error: 'token and phone are required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    await resolveSession({
      restaurantId: restaurant.id,
      token,
      phone,
      allowSoftMenuSession: !isRestaurantLob(restaurant.lob_type),
    });

    const variants = phoneVariants(phone);
    if (!variants.length) {
      return res.json({ ok: true, addresses: [] });
    }

    const { data: customers, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id')
      .eq('restaurant_id', restaurant.id)
      .in('phone', variants);
    if (custErr) throw custErr;

    const customerIds = (customers || []).map((row) => row.id).filter(Boolean);
    if (!customerIds.length) {
      return res.json({ ok: true, addresses: [] });
    }

    const { data: bookings, error: bookErr } = await supabaseAdmin
      .from('bookings')
      .select('delivery_address, created_at')
      .eq('restaurant_id', restaurant.id)
      .in('customer_id', customerIds)
      .not('delivery_address', 'is', null)
      .order('created_at', { ascending: false })
      .limit(40);
    if (bookErr) throw bookErr;

    const seen = new Set();
    const addresses = [];
    for (const row of (bookings || [])) {
      const raw = String(row.delivery_address || '').trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const pin = parsePincodeFromAddress(raw);
      let address = raw;
      if (pin) {
        address = raw.replace(new RegExp(`[,\\s]*${pin}\\s*$`), '').trim() || raw;
      }
      addresses.push({ address, pincode: pin || '' });
      if (addresses.length >= 5) break;
    }

    return res.json({ ok: true, addresses });
  } catch (err) {
    console.error('[webcart/saved-addresses]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load saved addresses.' });
  }
});

router.post('/api/webcart/delivery-quote', async (req, res) => {
  try {
    // #region agent log
    fetch('http://127.0.0.1:7380/ingest/982e28a2-86ba-4a90-a485-a232585f9d4f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'26a250'},body:JSON.stringify({sessionId:'26a250',runId:'post-fix',hypothesisId:'A',location:'delivery.js:delivery-quote:entry',message:'delivery-quote entered',data:{hasSelectDropping:typeof selectDroppingMissingColumns,hasCalculateDelivery:typeof calculateDelivery,hasResolveCartLineWeights:typeof resolveCartLineWeights,pincodeLen:String((req.body||{}).pincode||'').length,itemCount:Array.isArray((req.body||{}).items)?(req.body||{}).items.length:0},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const { pincode, cart_total, items } = req.body || {};
    const customerPincode = normalizePincode(pincode);
    if (!customerPincode) {
      return res.status(400).json({ ok: false, error: 'A valid 6-digit pincode is required.' });
    }

    const restaurant = await resolveRestaurantBySlug(req);
    // #region agent log
    fetch('http://127.0.0.1:7380/ingest/982e28a2-86ba-4a90-a485-a232585f9d4f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'26a250'},body:JSON.stringify({sessionId:'26a250',runId:'post-fix',hypothesisId:'C',location:'delivery.js:delivery-quote:restaurant',message:'restaurant resolved',data:{found:!!restaurant,lob:restaurant?.lob_type||null,provider:restaurant?.shipping_provider||null,hasPostal:!!restaurant?.postal_code,hasRateCard:!!restaurant?.courier_rate_card},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    // Resolve catalog weights server-side (client qty × menu weight_grams)
    let weighedItems = [];
    const rawItems = Array.isArray(items) ? items : [];
    if (rawItems.length) {
      // #region agent log
      fetch('http://127.0.0.1:7380/ingest/982e28a2-86ba-4a90-a485-a232585f9d4f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'26a250'},body:JSON.stringify({sessionId:'26a250',runId:'post-fix',hypothesisId:'A',location:'delivery.js:delivery-quote:before-weight',message:'about to call selectDroppingMissingColumns',data:{typeofFn:typeof selectDroppingMissingColumns,rawItemCount:rawItems.length},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      const { data: liveItems, error: liveErr } = await selectDroppingMissingColumns(
        'menu_items:delivery-quote',
        'id, retailer_id, weight_grams, item_type, meta',
        (select) => supabaseAdmin
          .from('menu_items')
          .select(select)
          .eq('restaurant_id', restaurant.id)
          .is('archived_at', null),
      );
      if (liveErr) {
        // Weight enrichment is best-effort — still quote with default parcel weight.
        console.warn('[webcart/delivery-quote] menu weight lookup failed:', liveErr.message);
      } else {
        weighedItems = resolveCartLineWeights(rawItems, liveItems || []);
      }
    }

    const quote = await calculateDelivery(restaurant, customerPincode, cart_total, {
      items: weighedItems,
    });
    // #region agent log
    fetch('http://127.0.0.1:7380/ingest/982e28a2-86ba-4a90-a485-a232585f9d4f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'26a250'},body:JSON.stringify({sessionId:'26a250',runId:'post-fix',hypothesisId:'B',location:'delivery.js:delivery-quote:success',message:'quote computed',data:{charge:quote?.charge,source:quote?.source,zone:quote?.zone,weight_kg:quote?.weight_kg},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return res.json({ ok: true, ...quote });
  } catch (err) {
    // #region agent log
    fetch('http://127.0.0.1:7380/ingest/982e28a2-86ba-4a90-a485-a232585f9d4f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'26a250'},body:JSON.stringify({sessionId:'26a250',runId:'post-fix',hypothesisId:'A',location:'delivery.js:delivery-quote:catch',message:'delivery-quote threw',data:{name:err?.name||null,message:String(err?.message||err),stackTop:String(err?.stack||'').split('\\n').slice(0,4)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    console.error('[webcart/delivery-quote]', err.message);
    if (err?.details) console.error('[webcart/delivery-quote] details:', err.details);
    if (err?.hint) console.error('[webcart/delivery-quote] hint:', err.hint);
    return res.status(500).json({
      ok: false,
      error: 'Failed to calculate delivery charge.',
      detail: process.env.NODE_ENV === 'production' ? undefined : (err.message || String(err)),
    });
  }
});

/** Notify-me waitlist when a SKU is sold out. */
router.post('/api/webcart/stock-waitlist', async (req, res) => {
  try {
    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    const phone = String(req.body?.phone || req.query.phone || '').trim();
    const retailerId = String(req.body?.retailer_id || '').trim() || null;
    const menuItemId = String(req.body?.menu_item_id || '').trim() || null;
    let itemName = String(req.body?.item_name || '').trim() || null;
    const reason = String(req.body?.reason || 'restock').toLowerCase() === 'launch' ? 'launch' : 'restock';

    if (!phone) return res.status(400).json({ ok: false, error: 'phone is required.' });
    if (!retailerId && !menuItemId) {
      return res.status(400).json({ ok: false, error: 'retailer_id or menu_item_id is required.' });
    }

    if (!itemName && (menuItemId || retailerId)) {
      let q = supabaseAdmin
        .from('menu_items')
        .select('id, name, retailer_id')
        .eq('restaurant_id', restaurant.id)
        .limit(1);
      if (menuItemId) q = q.eq('id', menuItemId);
      else q = q.eq('retailer_id', retailerId);
      const { data: row } = await q.maybeSingle();
      if (row) {
        itemName = row.name;
      }
    }

    const row = await joinStockWaitlist(supabaseAdmin, {
      restaurantId: restaurant.id,
      phone,
      menuItemId,
      retailerId: retailerId || menuItemId,
      itemName,
      reason,
    });

    const msg = reason === 'launch'
      ? `You're on the launch list for ${itemName || 'this item'}. We'll WhatsApp you when it drops.`
      : `We'll WhatsApp you when ${itemName || 'this item'} is back in stock.`;

    return res.json({
      ok: true,
      id: row?.id || null,
      message: msg,
    });
  } catch (err) {
    console.error('[webcart/stock-waitlist]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'Could not join waitlist.' });
  }
});

module.exports = router;
