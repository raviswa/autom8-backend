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
} = require('./shared');

router.get(['/cart', '/menu', '/shop'], (_req, res) => {
  // Webcart behavior changes frequently during debugging and deployment.
  // Disable browser reuse so refreshed pages always pick up the latest UI logic.
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'webcart.html'));
});

router.get('/gift/:token', async (req, res) => {
  try {
    const { getGiftByToken, redeemGiftLink } = require('../../helpers/giftLinks');
    const gift = await getGiftByToken(supabaseAdmin, req.params.token);
    if (!gift) {
      return res.status(404).type('html').send('<h1>Gift link not found</h1>');
    }
    const { data: restaurant } = await supabaseAdmin
      .from('tenants')
      .select('id, display_name, name')
      .eq('id', gift.restaurant_id)
      .maybeSingle();
    const brand = restaurant?.display_name || restaurant?.name || 'Kitchen';
    if (String(req.query.redeem || '') === '1') {
      await redeemGiftLink(supabaseAdmin, gift.token, {
        recipientPhone: req.query.phone || null,
      });
    }
    const note = gift.gift_message
      ? `<p style="font-size:16px;color:#444">“${String(gift.gift_message).replace(/</g, '')}”</p>`
      : '';
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Gift · ${brand}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#1a1a1a}
h1{font-size:22px} .btn{display:inline-block;margin-top:16px;background:#128c7e;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none}</style></head>
<body>
  <h1>A gift from ${brand}</h1>
  ${note}
  <p>Status: <strong>${gift.status}</strong></p>
  <a class="btn" href="/shop?slug=${encodeURIComponent(String(brand).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shop')}">Browse the shop</a>
</body></html>`);
  } catch (err) {
    console.error('[gift]', err.message);
    res.status(500).type('html').send('<h1>Could not open gift</h1>');
  }
});

router.get('/feedback', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'feedback.html'));
});


module.exports = router;
