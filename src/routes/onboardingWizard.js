'use strict';

/**
 * Auth-gated multi-step onboarding wizard (post email-first signup).
 *
 * GET  /wizard
 * PUT  /wizard/:step   (1=business, 2=product, 3=delivery, 4=payment; skip via { skip: true })
 * POST /wizard/complete
 */

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { ensureRestaurantSubscription, DEFAULT_SERVICES } = require('../helpers/subscriptionBilling');
const { mergeEnabledFeatures, ALL_FEATURES, ORDER_SERVICES } = require('../helpers/subscriptionFeatures');
const { resolveBusinessTaxonomy } = require('../config/lobTaxonomy');
const { normalizeShippingProvider } = require('../helpers/courierRates');
const { slugify, selectDroppingMissingColumns } = require('./webcart/shared');
const {
  getPhonePePartnerReferralUrl,
  summarizePhonePeMerchant,
  getPhonePeGateway,
} = require('../helpers/tenantPaymentGateways');
const { getDemoWhatsAppNumber } = require('../helpers/subscriptionAccess');
const { APP_SIGNUP_URL } = require('../helpers/ownerRegister');
const {
  assertDisclosureAccepted,
  tenantHasCurrentDisclosure,
  META_UTILITY_DISCLOSURE_VERSION,
} = require('../helpers/registrationGuards');

const FRONTEND = (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '');
const API_PUBLIC = (process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || 'https://api.autom8.works').replace(/\/$/, '');

const TENANT_WIZARD_SELECT =
  'id, name, display_name, slug, city, lob_type, supply_enabled, business_family, business_vertical, business_vertical_other, '
  + 'whatsapp_number, contact_phone, manager_phone, subscribed_features, '
  + 'delivery_distance_tiers_enabled, delivery_charge_tiers, shipping_provider, '
  + 'shiprocket_email, shiprocket_api_key, shiprocket_connected, '
  + 'payment_provider, lifecycle_status, onboarding_step, '
  + 'platform_charge_enabled, platform_charge_conversation, platform_charge_per_order, '
  + 'disclosure_accepted_at, disclosure_version';

async function loadTenant(restaurantId) {
  const full = await supabaseAdmin
    .from('tenants')
    .select(TENANT_WIZARD_SELECT)
    .eq('id', restaurantId)
    .maybeSingle();
  if (!full.error) return full.data;
  if (!/lifecycle_status|onboarding_step|business_family|shiprocket|delivery_distance|payment_provider/i.test(full.error.message || '')) {
    throw full.error;
  }
  const core = await supabaseAdmin
    .from('tenants')
    .select('id, name, display_name, slug, city, lob_type, whatsapp_number, contact_phone, subscribed_features')
    .eq('id', restaurantId)
    .maybeSingle();
  if (core.error) throw core.error;
  return {
    ...core.data,
    lifecycle_status: 'onboarding',
    onboarding_step: 0,
  };
}

async function patchTenant(restaurantId, updates) {
  const body = { ...updates, updated_at: new Date().toISOString() };
  let { data, error } = await supabaseAdmin
    .from('tenants')
    .update(body)
    .eq('id', restaurantId)
    .select(TENANT_WIZARD_SELECT)
    .single();
  if (error && /column|schema cache/i.test(error.message || '')) {
    // Drop unknown columns and retry once.
    const retry = { ...body };
    for (const key of Object.keys(retry)) {
      if (new RegExp(key, 'i').test(error.message || '')) delete retry[key];
    }
    ({ data, error } = await supabaseAdmin
      .from('tenants')
      .update(retry)
      .eq('id', restaurantId)
      .select('id, name, display_name, slug, city, lob_type, lifecycle_status, onboarding_step')
      .single());
  }
  if (error) throw error;
  return data;
}

async function ensureUniqueSlug(restaurantId, desired) {
  let base = slugify(desired || '') || `store-${String(restaurantId).slice(0, 8)}`;
  base = base.slice(0, 48);
  let candidate = base;
  for (let i = 0; i < 8; i += 1) {
    const { data: rows, error } = await selectDroppingMissingColumns(
      'wizard:slug-check',
      'id, slug, name, display_name',
      (select) => supabaseAdmin.from('tenants').select(select).eq('is_active', true).limit(2000),
    );
    if (error) break;
    const taken = (rows || []).some((t) => {
      if (t.id === restaurantId) return false;
      if (t.slug) return t.slug === candidate;
      return [slugify(t.display_name), slugify(t.name)].filter(Boolean).includes(candidate);
    });
    if (!taken) return candidate;
    candidate = `${base}-${i + 2}`;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

function webcartUrl(tenant) {
  const slug = tenant?.slug && !String(tenant.slug).startsWith('pending-')
    ? tenant.slug
    : null;
  if (slug) return `${API_PUBLIC}/cart?slug=${encodeURIComponent(slug)}`;
  return `${API_PUBLIC}/cart?restaurant_id=${encodeURIComponent(tenant.id)}`;
}

router.get('/wizard', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const tenant = await loadTenant(req.restaurant_id);
    if (!tenant) return res.status(404).json({ error: 'Business not found' });

    const { count: menuCount } = await supabaseAdmin
      .from('menu_items')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', req.restaurant_id);

    let phonepe = null;
    try {
      const gw = await getPhonePeGateway(req.restaurant_id);
      phonepe = summarizePhonePeMerchant(gw);
    } catch (_) { /* ignore */ }

    const step = Number(tenant.onboarding_step || 0);
    const lifecycle = tenant.lifecycle_status || 'active';

    res.json({
      success: true,
      lifecycle_status: lifecycle,
      onboarding_step: step,
      current_step: lifecycle === 'onboarding' ? Math.min(Math.max(step + 1, 1), 5) : 5,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        display_name: tenant.display_name,
        slug: tenant.slug,
        city: tenant.city,
        lob_type: tenant.lob_type,
        business_family: tenant.business_family,
        business_vertical: tenant.business_vertical,
        business_vertical_other: tenant.business_vertical_other,
        whatsapp_number: tenant.whatsapp_number,
        contact_phone: tenant.contact_phone,
        subscribed_features: tenant.subscribed_features || [],
        delivery_distance_tiers_enabled: !!tenant.delivery_distance_tiers_enabled,
        delivery_charge_tiers: tenant.delivery_charge_tiers || [],
        shipping_provider: tenant.shipping_provider || 'shiprocket',
        shiprocket_email: tenant.shiprocket_email || '',
        shiprocket_connected: !!(tenant.shiprocket_connected || tenant.shiprocket_api_key),
        payment_provider: tenant.payment_provider || 'phonepe',
      },
      catalog_item_count: menuCount || 0,
      phonepe,
      phonepe_partner_url: getPhonePePartnerReferralUrl(),
      demo_whatsapp_number: getDemoWhatsAppNumber() || null,
      webcart_url: webcartUrl(tenant),
      qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(webcartUrl(tenant))}`,
      dashboard_url: `${FRONTEND}/dashboard/owner`,
      settings_url: `${FRONTEND}/settings?tab=kitchen`,
    });
  } catch (err) {
    console.error('[onboarding/wizard GET]', err.message);
    res.status(500).json({ error: err.message || 'Failed to load wizard' });
  }
});

router.put('/wizard/:step', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const step = parseInt(req.params.step, 10);
    if (![1, 2, 3, 4].includes(step)) {
      return res.status(400).json({ error: 'step must be 1–4' });
    }

    const tenant = await loadTenant(req.restaurant_id);
    if (!tenant) return res.status(404).json({ error: 'Business not found' });

    const body = req.body || {};
    const skip = !!body.skip;

    if (step === 1 && !skip) {
      const businessName = String(body.business_name || body.name || '').trim();
      if (!businessName) return res.status(400).json({ error: 'Business name is required' });

      const taxonomy = resolveBusinessTaxonomy({
        business_family: body.business_family,
        business_vertical: body.business_vertical,
        business_vertical_other: body.business_vertical_other,
        lob_type: body.lob_type,
      });

      const { assertSinglePackagedCatalogLob, parseSupplyEnabledFlag } = require('../helpers/subscriptionPricing');
      const { setTenantSupplyEnabled } = require('../helpers/supplyTenant');
      try {
        assertSinglePackagedCatalogLob(body);
      } catch (lobErr) {
        return res.status(400).json({ error: lobErr.message, code: lobErr.code || 'lob_conflict' });
      }

      const city = String(body.city || '').trim() || null;
      const wa = String(body.whatsapp_number || body.owner_whatsapp || '').replace(/\D/g, '') || null;
      const desiredSlug = String(body.slug || businessName).trim();
      const slug = await ensureUniqueSlug(req.restaurant_id, desiredSlug);
      const nextLob = taxonomy.lob_type || body.lob_type || tenant.lob_type || 'retail';
      const supplyEnabled = parseSupplyEnabledFlag(body, nextLob);

      await patchTenant(req.restaurant_id, {
        name: businessName,
        display_name: String(body.display_name || businessName).trim(),
        city,
        slug,
        lob_type: nextLob,
        supply_enabled: supplyEnabled,
        business_family: taxonomy.business_family || body.business_family || null,
        business_vertical: taxonomy.business_vertical || body.business_vertical || null,
        business_vertical_other: taxonomy.business_vertical_other || body.business_vertical_other || null,
        whatsapp_number: wa,
        contact_phone: wa,
        manager_phone: wa,
        onboarding_step: Math.max(Number(tenant.onboarding_step || 0), 1),
        lifecycle_status: 'onboarding',
      });

      if (supplyEnabled) {
        try {
          await setTenantSupplyEnabled(supabaseAdmin, {
            restaurantId: req.restaurant_id,
            enabled: true,
            authUserId: req.user?.id || req.user_id || null,
            email: tenant.contact_email || tenant.email || req.user?.email || null,
            name: businessName,
            businessName: String(body.display_name || businessName).trim(),
            phone: wa,
            city,
          });
        } catch (supErr) {
          console.warn('[wizard] ensure supplier failed (non-fatal):', supErr.message);
        }
      }
    } else if (step === 2 && !skip) {
      const itemName = String(body.item_name || body.name || '').trim();
      const price = parseFloat(body.price);
      if (!itemName) return res.status(400).json({ error: 'Product name is required' });
      if (!(price >= 0)) return res.status(400).json({ error: 'Valid price is required' });

      const imageUrl = String(body.image_url || body.photo_url || '').trim() || null;
      const row = {
        restaurant_id: req.restaurant_id,
        name: itemName,
        title: itemName,
        price,
        category: String(body.category || 'General').trim() || 'General',
        is_available: true,
        image_url: imageUrl,
        updated_at: new Date().toISOString(),
      };
      let { error: itemErr } = await supabaseAdmin.from('menu_items').insert(row);
      if (itemErr && /title|image_url|column/i.test(itemErr.message || '')) {
        const fallback = {
          restaurant_id: req.restaurant_id,
          name: itemName,
          price,
          category: row.category,
          is_available: true,
        };
        ({ error: itemErr } = await supabaseAdmin.from('menu_items').insert(fallback));
      }
      if (itemErr) throw itemErr;

      await patchTenant(req.restaurant_id, {
        onboarding_step: Math.max(Number(tenant.onboarding_step || 0), 2),
        lifecycle_status: 'onboarding',
      });
    } else if (step === 3 && !skip) {
      const takeaway = body.takeaway !== false && body.takeaway !== 'false';
      const delivery = body.delivery === true || body.delivery === 'true'
        || body.door_delivery === true;
      const selected = ['token_management'];
      if (takeaway) selected.push('takeaway');
      if (delivery) selected.push('delivery');
      if (body.dine_in === true) selected.push('dine_in');

      const enabled = mergeEnabledFeatures(
        selected.filter((f) => f === 'token_management' || ORDER_SERVICES.includes(f)),
        ALL_FEATURES,
      );

      const inHouse = body.in_house_delivery === true || body.delivery_distance_tiers_enabled === true;
      let tiers = Array.isArray(body.delivery_charge_tiers) ? body.delivery_charge_tiers : null;
      if (inHouse && (!tiers || !tiers.length)) {
        tiers = [
          { max_km: 3, charge: 20 },
          { max_km: 5, charge: 30 },
          { max_km: 8, charge: 40 },
          { max_km: null, charge: 50 },
        ];
      }

      const shippingProvider = normalizeShippingProvider(
        body.shipping_provider || (body.shiprocket ? 'shiprocket' : 'shiprocket'),
      );

      const updates = {
        subscribed_features: enabled,
        delivery_distance_tiers_enabled: !!inHouse,
        shipping_provider: shippingProvider,
        onboarding_step: Math.max(Number(tenant.onboarding_step || 0), 3),
        lifecycle_status: 'onboarding',
      };
      if (tiers) updates.delivery_charge_tiers = tiers;

      if (body.shiprocket_email) {
        updates.shiprocket_email = String(body.shiprocket_email).trim().toLowerCase();
      }
      if (body.shiprocket_api_key && String(body.shiprocket_api_key).trim()) {
        updates.shiprocket_api_key = String(body.shiprocket_api_key).trim();
        updates.shiprocket_connected = true;
      }

      await patchTenant(req.restaurant_id, updates);
      await ensureRestaurantSubscription(supabaseAdmin, req.restaurant_id, {
        enabledFeatures: enabled,
      });
    } else if (step === 4 && !skip) {
      const updates = {
        onboarding_step: Math.max(Number(tenant.onboarding_step || 0), 4),
        lifecycle_status: 'onboarding',
        payment_provider: body.payment_provider === 'razorpay' ? 'razorpay' : 'phonepe',
      };
      // MID persistence goes through billing helpers when provided
      if (body.phonepe_merchant_id) {
        try {
          const { upsertPhonePeGateway } = require('../helpers/tenantPaymentGateways');
          await upsertPhonePeGateway(req.restaurant_id, {
            merchant_id: body.phonepe_merchant_id,
          });
        } catch (midErr) {
          console.warn('[wizard/payment] MID save skipped:', midErr.message);
        }
      }
      await patchTenant(req.restaurant_id, updates);
    } else if (skip) {
      // Advance cursor without requiring fields
      await patchTenant(req.restaurant_id, {
        onboarding_step: Math.max(Number(tenant.onboarding_step || 0), step),
        lifecycle_status: 'onboarding',
      });
    }

    const next = await loadTenant(req.restaurant_id);
    res.json({
      success: true,
      onboarding_step: next?.onboarding_step ?? step,
      lifecycle_status: next?.lifecycle_status || 'onboarding',
      next_step: Math.min(step + 1, 5),
    });
  } catch (err) {
    console.error('[onboarding/wizard PUT]', err.message);
    res.status(400).json({ error: err.message || 'Wizard step failed' });
  }
});

router.post('/wizard/complete', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const tenant = await loadTenant(req.restaurant_id);
    if (!tenant) return res.status(404).json({ error: 'Business not found' });

    // Require business basics at least (step >= 1)
    if (Number(tenant.onboarding_step || 0) < 1
      && (!tenant.name || String(tenant.slug || '').startsWith('pending-'))) {
      return res.status(400).json({
        error: 'Complete business basics (step 1) before finishing setup.',
        code: 'business_required',
      });
    }

    assertDisclosureAccepted(req.body || {});

    const chargeEnabled = req.body?.platform_charge_enabled === true
      || req.body?.platform_charge_enabled === 'true'
      || req.body?.platform_charge_enabled === 1;

    const updated = await patchTenant(req.restaurant_id, {
      lifecycle_status: 'active',
      onboarding_step: 5,
      platform_charge_enabled: !!chargeEnabled,
      disclosure_version: META_UTILITY_DISCLOSURE_VERSION,
      disclosure_accepted_at: new Date().toISOString(),
    });

    const url = webcartUrl(updated || tenant);
    res.json({
      success: true,
      lifecycle_status: 'active',
      onboarding_step: 5,
      webcart_url: url,
      qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(url)}`,
      demo_whatsapp_number: getDemoWhatsAppNumber() || null,
      dashboard_url: `${FRONTEND}/dashboard/owner`,
      signup_url: APP_SIGNUP_URL,
      disclosure_version: META_UTILITY_DISCLOSURE_VERSION,
      platform_charge_enabled: !!chargeEnabled,
    });
  } catch (err) {
    console.error('[onboarding/wizard complete]', err.message);
    if (err.status === 400 || err.code === 'disclosure_required' || err.code === 'disclosure_version_stale') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message || 'Could not complete onboarding' });
  }
});

module.exports = router;
