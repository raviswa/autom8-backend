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

router.get('/api/webcart/session', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const phone = String(req.query.phone || '').trim();
    const guestMode = String(req.query.guest || '').trim() === '1'
      || String(req.query.mode || '').trim().toLowerCase() === 'shop';

    const restaurant = await resolveRestaurantBySlug(req);
    if (!restaurant) {
      return res.status(404).json({
        valid: false,
        code: 'RESTAURANT_NOT_FOUND',
        message: 'Restaurant not found.',
      });
    }

    const lobType = restaurant.lob_type || 'restaurant';
    const catalogLob = !isRestaurantLob(lobType);

    // Permanent storefront: packaged LOBs can browse without WhatsApp token.
    if ((!token || !phone) && !(guestMode && catalogLob)) {
      return res.status(400).json({
        valid: false,
        code: 'BAD_REQUEST',
        message: catalogLob
          ? 'Open /shop?slug=… for the public storefront, or provide token and phone.'
          : 'token and phone are required.',
      });
    }

    const session = (token && phone)
      ? await resolveSession({
          restaurantId: restaurant.id,
          token,
          phone,
          allowSoftMenuSession: catalogLob,
          preferDelivery: catalogLob,
        })
      : null;

    const { items: menuItems, categorySlotMap } = await fetchMenuItems(restaurant.id, { catalogLob });

    let slotInfo;
    let availableNow;
    let preferredCategory = null;

    if (catalogLob) {
      slotInfo = {
        current_slot: null,
        slot_state: 'open',
        banner: null,
        catalog_lob: true,
      };
      availableNow = [];
    } else {
      slotInfo = resolveCurrentSlot(restaurant);

      // Manager portal "Kitchen: Open" override (POST /api/catalog/kitchen-toggle
      // in src/routes/catalog.js) works by flipping menu_items.is_available — it
      // never touches restaurant.opening_hours, which is all resolveCurrentSlot()
      // above looks at. So outside scheduled hours the web menu kept showing
      // "Kitchen is closed" even after the manager explicitly opened it, while
      // the WhatsApp bot (chat/tools/kitchen_hours.py → has_manager_kitchen_override)
      // already honored the same signal. Detect it here the same way so both
      // channels agree.
      const managerOverrideItems = menuItems.filter(i => i.is_available);
      const managerOverrideActive = slotInfo.slot_state !== 'open' && managerOverrideItems.length > 0;
      if (managerOverrideActive) {
        slotInfo = { ...slotInfo, slot_state: 'open', manager_override: true, banner: null };
      }

      availableNow = !slotInfo.current_slot && managerOverrideActive
        ? managerOverrideItems
        : slotInfo.current_slot
          ? menuItems.filter(i => i.effective_slots.includes('anytime') || i.effective_slots.includes(slotInfo.current_slot))
          : [];

      const primarySlotMap = restaurant?.primary_slot_category || {};
      preferredCategory = slotInfo.current_slot
        ? String(primarySlotMap?.[slotInfo.current_slot] || '').trim() || null
        : null;
    }

    const todaysSpecial = catalogLob ? [] : menuItems.filter(i => i.is_todays_special);

    // Packaged storefronts can always check out with a phone — even when the
    // WhatsApp menu_tokens row has expired. Don't scare the shopper with a
    // false "session expired" banner; fall through to guest checkout.
    const publicGuest = !session && catalogLob && (!token || !phone);
    const expiredLinkGuest = !session && catalogLob && !!(token && phone);
    const isGuest = publicGuest || expiredLinkGuest;
    const sessionPayload = session
      ? {
          token: session.id,
          phone: session.phone,
          type: session.type,
          soft_session: !!session._soft,
        }
      : isGuest
        ? {
            token: 'guest',
            phone: expiredLinkGuest ? phone : '',
            type: 'delivery',
            guest: true,
          }
        : {
            token,
            phone,
            type: 'takeaway',
          };

    const orderingEnabled = true;

    let affinity = {
      updated_at: null,
      by_item: {},
      pairs: [],
      customer_favourites: [],
    };
    try {
      affinity = await getAffinityForWebcart(supabaseAdmin, restaurant.id, {
        phone: session?.phone || phone || null,
      });
    } catch (affErr) {
      console.warn('[webcart/session] affinity:', affErr.message);
    }

    const storefrontSlug = slugify(restaurant.display_name || restaurant.name) || null;

    let loyalty = { balance: 0, redeem_points: 100, redeem_inr: 50, points_per_100: 1 };
    try {
      const {
        getLoyaltyBalance,
        getLoyaltyConfig,
      } = require('../loyalty');
      const phoneForLoyalty = session?.phone || phone || '';
      if (phoneForLoyalty) {
        const [balance, cfg] = await Promise.all([
          getLoyaltyBalance(restaurant.id, phoneForLoyalty),
          getLoyaltyConfig(restaurant.id),
        ]);
        loyalty = {
          balance,
          redeem_points: cfg.redeem_points,
          redeem_inr: cfg.redeem_inr,
          points_per_100: cfg.points_per_100,
        };
      } else {
        const cfg = await getLoyaltyConfig(restaurant.id);
        loyalty = {
          balance: 0,
          redeem_points: cfg.redeem_points,
          redeem_inr: cfg.redeem_inr,
          points_per_100: cfg.points_per_100,
        };
      }
    } catch (loyErr) {
      console.warn('[webcart/session] loyalty:', loyErr.message);
    }

    return res.json({
      valid: true,
      ordering_enabled: orderingEnabled,
      session_expired: !session && !isGuest,
      guest_storefront: isGuest,
      storefront_url: storefrontSlug ? `/shop?slug=${encodeURIComponent(storefrontSlug)}` : null,
      restaurant: {
        id: restaurant.id,
        name: restaurant.display_name || restaurant.name,
        logo_url: restaurant.logo_url || null,
        support_phone: pickSupportPhone(restaurant) || null,
        lob_type: lobType,
        gstin: restaurant.gstin || null,
        fssai_license: restaurant.fssai_license || null,
        sac_code: restaurant.sac_code || null,
        receipt_tagline: restaurant.receipt_tagline || null,
      },
      pricing_config: {
        parcel_charge_per_item: restaurant.parcel_charge_per_item || 0,
        gst_rate: restaurant.gst_rate || 5,
        delivery_charge_default: restaurant.delivery_charge_default || 40,
        free_delivery_above: Number(restaurant.free_delivery_above) > 0
          ? Number(restaurant.free_delivery_above)
          : 0,
        packaging_weight_grams: Number(restaurant.packaging_weight_grams) > 0
          ? Number(restaurant.packaging_weight_grams)
          : 0,
      },
      loyalty,
      affinity,
      
      theme: DEFAULT_THEME,
      session: sessionPayload,
      menu_items: menuItems,
      todays_special: todaysSpecial,
      available_now: availableNow,
      current_slot: slotInfo.current_slot,
      slot_state: slotInfo.slot_state,
      slot_banner: slotInfo.banner || null,
      catalog_lob: catalogLob,
      kitchen_manual_override: !!slotInfo.manager_override,
      kitchen_busy: !!restaurant.kitchen_busy,
      preferred_category: preferredCategory,
      category_slots: categorySlotMap,
      promotions: [],
      session_message: isGuest
        ? (expiredLinkGuest
          ? null
          : 'Browse the storefront. Enter your WhatsApp number at checkout to place the order.')
        : (session
          ? null
          : 'Your WhatsApp session expired, but the menu is still available to browse. Please request a fresh link to submit an order.'),
    });
  } catch (err) {
    console.error('[webcart/session]', err.message || err);
    if (err?.details) console.error('[webcart/session] details:', err.details);
    if (err?.hint) console.error('[webcart/session] hint:', err.hint);
    if (err?.code) console.error('[webcart/session] code:', err.code);
    const schemaHint = isMissingColumnError(err)
      ? 'Database is missing a column this build expects — run pending migrations (especially 20260720_*).'
      : null;
    return res.status(500).json({
      valid: false,
      code: 'SERVER_ERROR',
      message: schemaHint || 'Failed to load cart session.',
      detail: process.env.NODE_ENV === 'production' ? undefined : (err.message || String(err)),
    });
  }
});

module.exports = router;
