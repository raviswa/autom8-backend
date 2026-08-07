'use strict';

const express = require('express');
const router  = express.Router();
const {
  supabaseAdmin,
  invalidateRestaurantConfigCache,
  writeAuditLog,
  authenticateToken,
  getRestaurantId,
  withAudit,
  auditOwnerDashboardContext,
  normalizeShippingProvider,
  normalizeRateCard,
  normalizePincode,
  resolveCourierZone,
  chargeFromRateCard,
  fetchShiprocketCourierOptions,
  broadcastToRestaurant,
  sendWhatsAppMessage,
  sendWhatsAppCatalogMessage,
  notifyOrderReady,
  notifyPackingTicketAlert,
  queueForStation,
  queueFeedbackForTable,
  resolvePickupLocation,
  parseGoogleMapsCoords,
  resolveFailureMessage,
  ORDER_SERVICES,
  resolvePaidFeatures,
  mergeEnabledFeatures,
  validateEnabledFeatures,
  enabledOrderServices,
  dispatchBookingToKds,
  runDueScheduledJobsForRestaurant,
  reconcileMissedKdsDispatches,
  explainKdsVisibility,
  formatTokenDisplay,
  looksLikeShiprocketJwt,
  sanitizeRestaurantForClient,
  requireSettingsAccess,
  enrichScheduledOrdersFromPortal,
} = require('./shared');
const { resolveBusinessTaxonomy } = require('../../config/lobTaxonomy');
const {
  normalizeAboutNote,
  normalizeInceptionDate,
  normalizeSocialLinks,
} = require('../../helpers/aboutUs');
const { requireStepUpInHandler, normalizePhoneKey } = require('../../helpers/stepUpAuth');
const {
  assertDisclosureAccepted,
  tenantHasCurrentDisclosure,
  META_UTILITY_DISCLOSURE_VERSION,
} = require('../../helpers/registrationGuards');

router.post('/restaurants/resolve-pickup', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const { maps_url, pickup_address, city, state } = req.body;
    const resolved = await resolvePickupLocation({
      mapsUrl: maps_url,
      address: pickup_address,
      city,
      state,
    });
    if (!resolved) {
      return res.status(422).json({
        error: resolveFailureMessage({ maps_url, pickup_address }),
      });
    }
    res.json({ success: true, ...resolved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Compare Shiprocket live courier quotes vs the tenant's custom rate card
 * for selected destination pincodes × weights (settings tool).
 */
router.post('/restaurants/shipping-rate-compare', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const body = req.body || {};
    const weights = (Array.isArray(body.weights) ? body.weights : [0.5, 1, 2])
      .map((w) => Math.round(Number(w) * 1000) / 1000)
      .filter((w) => w > 0)
      .slice(0, 6);
    const destinations = (Array.isArray(body.destinations) ? body.destinations : [])
      .map((d) => ({
        label: String(d.label || d.city || d.pincode || '').trim() || 'Destination',
        pincode: normalizePincode(d.pincode),
      }))
      .filter((d) => d.pincode)
      .slice(0, 8);

    if (!weights.length) {
      return res.status(400).json({ error: 'Add at least one parcel weight (kg).' });
    }
    if (!destinations.length) {
      return res.status(400).json({ error: 'Add at least one destination pincode.' });
    }

    const { data: tenant, error } = await supabaseAdmin
      .from('tenants')
      .select('postal_code, shiprocket_api_key, shiprocket_email, courier_name, courier_rate_card, outstation_charge, intra_city_charge')
      .eq('id', req.restaurant_id)
      .maybeSingle();
    if (error) throw error;
    if (!tenant) return res.status(404).json({ error: 'Business not found.' });

    const pickup = normalizePincode(body.pickup_pincode || tenant.postal_code);
    if (!pickup) {
      return res.status(400).json({
        error: 'Set your business postal code in the Business tab (or pass pickup_pincode) before comparing rates.',
      });
    }

    // Prefer unsaved draft card from the settings form when provided
    const rateCard = body.courier_rate_card != null
      ? normalizeRateCard(body.courier_rate_card)
      : normalizeRateCard(tenant.courier_rate_card);
    const courierName = String(body.courier_name || tenant.courier_name || 'Your courier').trim() || 'Your courier';

    // Draft credentials from form take precedence over saved tenant values
    const shipEmail = String(body.shiprocket_email || '').trim() || tenant.shiprocket_email || '';
    const shipPassword = String(body.shiprocket_api_key || '').trim() || tenant.shiprocket_api_key || '';
    const hasShipCreds = !!(shipEmail && shipPassword) || looksLikeShiprocketJwt(shipPassword);

    const ZONE_LABEL = {
      local: 'Local',
      within_state: 'Within state',
      metro: 'Metro',
      rest_of_india: 'Non-metro',
      special: 'Special',
    };

    const rows = [];
    for (const dest of destinations) {
      const zone = resolveCourierZone(pickup, dest.pincode);
      for (const weightKg of weights) {
        const ship = hasShipCreds
          ? await fetchShiprocketCourierOptions({
              email: shipEmail,
              password: shipPassword,
              apiKey: shipPassword,
              pickupPincode: pickup,
              deliveryPincode: dest.pincode,
              weightKg,
              limit: 5,
            })
          : {
              cheapest: null,
              couriers: [],
              error: 'Save Shiprocket API User email + password above, then Compare again.',
            };

        let yourRate = chargeFromRateCard(rateCard, zone, weightKg);
        let yourSource = 'rate_card';
        if (yourRate == null) {
          yourRate = zone === 'local'
            ? Number(tenant.intra_city_charge || 0) || null
            : Number(tenant.outstation_charge || 0) || null;
          yourSource = zone === 'local' ? 'intra_city_fallback' : 'outstation_fallback';
        }

        const shipCheapest = ship.cheapest;
        let diff = null;
        let cheaper = null;
        if (shipCheapest != null && yourRate != null) {
          diff = Math.round((yourRate - shipCheapest) * 100) / 100;
          cheaper = diff < 0 ? 'yours' : diff > 0 ? 'shiprocket' : 'tie';
        }

        rows.push({
          destination: dest.label,
          pincode: dest.pincode,
          zone,
          zone_label: ZONE_LABEL[zone] || zone,
          weight_kg: weightKg,
          shiprocket_cheapest: shipCheapest,
          shiprocket_couriers: ship.couriers,
          shiprocket_error: ship.error,
          your_courier_name: courierName,
          your_rate: yourRate,
          your_source: yourSource,
          diff,
          cheaper,
        });
      }
    }

    return res.json({
      success: true,
      pickup_pincode: pickup,
      courier_name: courierName,
      shiprocket_available: hasShipCreds,
      rows,
    });
  } catch (err) {
    console.error('[shipping-rate-compare]', err.message);
    return res.status(500).json({ error: err.message || 'Rate compare failed.' });
  }
});

// ── Owner self-service restaurant update ──────────────────────────────────────
// Used by SettingsPanel tabs: Restaurant, Services, Kitchen, WhatsApp

router.put(
  '/restaurants/me',
  authenticateToken,
  getRestaurantId,
  requireSettingsAccess,
  auditOwnerDashboardContext,
  withAudit('settings.update', 'tenant'),
  async (req, res) => {
  try {
    const ALLOWED = [
      'name','display_name','legal_name','address_line1','address_line2',
      'city','state','postal_code','country',
      'contact_phone','contact_email','website_url','cuisine_type',
      'logo_url','gstin','opening_hours',
      'whatsapp_number','waba_id','manager_phone','sweets_counter_phone','meta_catalog_id',
      'timezone','dining_duration_minutes','payment_mode','kitchen_workflow',
      'kot_printer_ip','kot_printer_port','kot_printer_enabled',
      'takeaway_fulfillment_mode','fulfillment_sections',
      'parcel_charge_per_item',
      'takeaway_ready_range','delivery_ready_range',
  'restaurant_type','pickup_address','pickup_latitude','pickup_longitude',
  'google_maps_url',
  'delivery_charge_default','delivery_charge_tiers','delivery_distance_tiers_enabled',
  'min_delivery_order_amount','min_takeaway_order_amount',
  'scheduled_delivery_enabled','scheduled_takeaway_enabled','scheduled_kds_lead_minutes','max_delivery_radius_km',
  'scheduled_slot_max_orders','schedule_buffer_minutes','schedule_rounding_minutes','schedule_early_start_max_minutes',
  'shiprocket_connected','shiprocket_api_key','shiprocket_email','intra_city_charge','outstation_charge','free_delivery_above',
  'cod_enabled_city','cod_enabled_outstation',
  'shipping_provider','courier_name','courier_rate_card',
  'gstin','fssai_license','sac_code','receipt_tagline',
  'gst_rate','gst_inclusive',
  'platform_charge_enabled',
  'packaging_weight_grams',
  'daily_settlement_enabled','weekly_promo_drafts_enabled','instagram_handle','instagram_user_id',
  'instagram_feature_on_autom8',
  'refill_reminders_enabled','refill_lead_time_days','refill_safety_buffer_days',
  'subscribed_features', 'enabled_services',
  'lob_type', 'allow_manager_menu_upload',
  'business_family', 'business_vertical', 'business_vertical_other',
  'order_ops_mode',
  'about_enabled', 'about_note', 'inception_date', 'social_links',
    ];

    // These two fields are owner-governed only — a manager may have general
// settings access (whitelisted above), but must not be able to change the
// business type or grant themselves menu-upload rights via direct API call,
// even though the UI already hides these controls from managers.
const OWNER_ONLY_FIELDS = [
  'lob_type', 'allow_manager_menu_upload', 'shiprocket_api_key', 'shiprocket_email',
  'business_family', 'business_vertical', 'business_vertical_other',
];
const isOwnerLike = ['owner', 'brand_owner'].includes(req.user_role);
    
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED.includes(k))
    );
    if (req.body.maps_url !== undefined) {
      updates.google_maps_url = req.body.maps_url || null;
    }
    if (updates.about_enabled !== undefined) {
      updates.about_enabled = !!updates.about_enabled;
    }
    if (updates.platform_charge_enabled !== undefined) {
      updates.platform_charge_enabled = !!updates.platform_charge_enabled;
    }
    if (updates.gst_inclusive !== undefined) {
      updates.gst_inclusive = !!updates.gst_inclusive;
    }
    if (updates.about_note !== undefined) {
      updates.about_note = normalizeAboutNote(updates.about_note);
    }
    if (updates.inception_date !== undefined) {
      const inception = normalizeInceptionDate(updates.inception_date);
      if (updates.inception_date && !inception) {
        return res.status(400).json({ error: 'inception_date must be YYYY-MM or YYYY-MM-DD.' });
      }
      updates.inception_date = inception;
    }
    if (updates.social_links !== undefined) {
      const links = normalizeSocialLinks(updates.social_links);
      if (links == null) {
        return res.status(400).json({ error: 'social_links must be an array of { platform, url }.' });
      }
      updates.social_links = links;
    }
    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'No valid fields provided' });

    if (!isOwnerLike) {
      for (const key of OWNER_ONLY_FIELDS) delete updates[key];
    }

    // Step-up OTP when manager phone or WA binding fields change
    const needsWaBindStepUp = ['whatsapp_number', 'waba_id'].some((k) => updates[k] !== undefined);
    const needsManagerPhoneStepUp = updates.manager_phone !== undefined;
    if (needsWaBindStepUp || needsManagerPhoneStepUp) {
      const { data: current } = await supabaseAdmin
        .from('tenants')
        .select('manager_phone, whatsapp_number, waba_id')
        .eq('id', req.restaurant_id)
        .maybeSingle();

      const managerChanged = needsManagerPhoneStepUp
        && normalizePhoneKey(updates.manager_phone) !== normalizePhoneKey(current?.manager_phone);
      const waChanged = needsWaBindStepUp && (
        (updates.whatsapp_number !== undefined
          && normalizePhoneKey(updates.whatsapp_number) !== normalizePhoneKey(current?.whatsapp_number))
        || (updates.waba_id !== undefined
          && String(updates.waba_id || '') !== String(current?.waba_id || ''))
      );

      try {
        if (waChanged) await requireStepUpInHandler(req, 'whatsapp_bind');
        else if (managerChanged) await requireStepUpInHandler(req, 'change_manager_phone');
      } catch (stepErr) {
        return res.status(stepErr.status || 403).json({
          error: stepErr.message || 'WhatsApp verification required for this change.',
        });
      }
    }

    // ── Validate service toggles against paid plan ───────────────────────────
    if (updates.subscribed_features !== undefined || updates.enabled_services !== undefined) {
      const { data: sub } = await supabaseAdmin
        .from('tenant_subscriptions')
        .select('features')
        .eq('restaurant_id', req.restaurant_id)
        .maybeSingle();

      const paidFeatures = resolvePaidFeatures(sub);

      let nextEnabled;
      if (updates.enabled_services !== undefined) {
        if (!Array.isArray(updates.enabled_services)) {
          return res.status(400).json({ error: 'enabled_services must be an array' });
        }
        const invalidSvc = updates.enabled_services.filter(s => !ORDER_SERVICES.includes(s));
        if (invalidSvc.length) {
          return res.status(400).json({ error: `Invalid services: ${invalidSvc.join(', ')}` });
        }
        nextEnabled = mergeEnabledFeatures(updates.enabled_services, paidFeatures);
        delete updates.enabled_services;
      } else {
        nextEnabled = updates.subscribed_features;
      }

      const check = validateEnabledFeatures(nextEnabled, paidFeatures);
      if (!check.ok) return res.status(403).json({ error: check.error });

      updates.subscribed_features = nextEnabled;
    }

    // Enabling platform charge requires current Meta utility disclosure acceptance
    if (updates.platform_charge_enabled === true) {
      const { data: currentDisc } = await supabaseAdmin
        .from('tenants')
        .select('platform_charge_enabled, disclosure_version, disclosure_accepted_at')
        .eq('id', req.restaurant_id)
        .maybeSingle();

      if (!tenantHasCurrentDisclosure(currentDisc)) {
        try {
          assertDisclosureAccepted(req.body || {});
        } catch (discErr) {
          return res.status(discErr.status || 400).json({
            error: discErr.message,
            code: discErr.code,
            required_disclosure_version: META_UTILITY_DISCLOSURE_VERSION,
          });
        }
        updates.disclosure_version = META_UTILITY_DISCLOSURE_VERSION;
        updates.disclosure_accepted_at = new Date().toISOString();
      }
    }
    // Strip client-supplied disclosure stamp fields unless we just server-set them above
    if (updates.platform_charge_enabled !== true) {
      delete updates.disclosure_accepted_at;
      delete updates.disclosure_version;
    }

    // Auto-resolve pickup coordinates for cloud kitchens when saving address/maps link
    const needsPickupResolve = (
      (updates.restaurant_type === 'cloud_kitchen' || updates.pickup_address !== undefined)
      && (updates.pickup_address || req.body.maps_url)
      && (
        (updates.pickup_latitude === undefined && updates.pickup_longitude === undefined)
        || !updates.pickup_latitude
        || !updates.pickup_longitude
      )
    );
    if (needsPickupResolve) {
      const { data: current } = await supabaseAdmin
        .from('tenants')
        .select('city, state, pickup_address, restaurant_type')
        .eq('id', req.restaurant_id)
        .maybeSingle();

      const fromUrl = req.body.maps_url ? parseGoogleMapsCoords(req.body.maps_url) : null;
      if (fromUrl) {
        updates.pickup_latitude = fromUrl.lat;
        updates.pickup_longitude = fromUrl.lng;
      } else {
        const resolved = await resolvePickupLocation({
          mapsUrl: req.body.maps_url,
          address: updates.pickup_address || current?.pickup_address,
          city: updates.city || current?.city,
          state: updates.state || current?.state,
        });
        if (resolved) {
          updates.pickup_latitude = resolved.lat;
          updates.pickup_longitude = resolved.lng;
        }
      }
    }

    if (updates.pickup_latitude !== undefined) {
      const lat = parseFloat(updates.pickup_latitude);
      updates.pickup_latitude = Number.isFinite(lat) ? lat : null;
    }
    if (updates.pickup_longitude !== undefined) {
      const lng = parseFloat(updates.pickup_longitude);
      updates.pickup_longitude = Number.isFinite(lng) ? lng : null;
    }

    if (updates.shipping_provider !== undefined) {
      updates.shipping_provider = normalizeShippingProvider(updates.shipping_provider);
    }

    if (updates.order_ops_mode !== undefined) {
      const mode = String(updates.order_ops_mode || '').toLowerCase();
      updates.order_ops_mode = mode === 'split' ? 'split' : 'combined';
    }

    if (updates.refill_reminders_enabled !== undefined) {
      updates.refill_reminders_enabled = !!updates.refill_reminders_enabled;
    }
    if (updates.refill_lead_time_days !== undefined) {
      const n = parseInt(updates.refill_lead_time_days, 10);
      if (!Number.isFinite(n) || n < 0 || n > 90) {
        return res.status(400).json({ error: 'refill_lead_time_days must be 0–90' });
      }
      updates.refill_lead_time_days = n;
    }
    if (updates.refill_safety_buffer_days !== undefined) {
      const n = parseInt(updates.refill_safety_buffer_days, 10);
      if (!Number.isFinite(n) || n < 0 || n > 90) {
        return res.status(400).json({ error: 'refill_safety_buffer_days must be 0–90' });
      }
      updates.refill_safety_buffer_days = n;
    }

    // shiprocket_api_key stores the Shiprocket API User password (misnamed historically).
    // TODO: encrypt at rest — other tenant secrets are also plaintext today; keep the pattern consistent.
    if (updates.shiprocket_api_key !== undefined) {
      const pw = String(updates.shiprocket_api_key || '').trim();
      if (!pw) {
        // Blank means "leave existing password" — never wipe on empty form field.
        delete updates.shiprocket_api_key;
      } else {
        updates.shiprocket_api_key = pw;
      }
    }
    if (updates.shiprocket_email !== undefined) {
      updates.shiprocket_email = String(updates.shiprocket_email || '').trim().toLowerCase() || null;
    }

    // Connected = credentials present (useful for Rate Compare even when provider is "custom").
    // Do not force disconnected merely because the maker switched to their own rate card.
    if (
      updates.shipping_provider !== undefined
      || updates.shiprocket_api_key !== undefined
      || updates.shiprocket_email !== undefined
      || updates.shiprocket_connected !== undefined
    ) {
      const { data: existingCreds } = await supabaseAdmin
        .from('tenants')
        .select('shiprocket_email, shiprocket_api_key')
        .eq('id', req.restaurant_id)
        .maybeSingle();
      const nextEmail = updates.shiprocket_email !== undefined
        ? updates.shiprocket_email
        : (existingCreds?.shiprocket_email || null);
      const nextPassword = updates.shiprocket_api_key !== undefined
        ? updates.shiprocket_api_key
        : (existingCreds?.shiprocket_api_key || null);
      updates.shiprocket_connected = !!(
        String(nextEmail || '').trim() && String(nextPassword || '').trim()
      );
    }

    // Business family / vertical are labels; lob_type stays the schema driver.
    if (
      updates.business_family !== undefined
      || updates.business_vertical !== undefined
      || updates.business_vertical_other !== undefined
    ) {
      const taxonomy = resolveBusinessTaxonomy({
        business_family: updates.business_family,
        business_vertical: updates.business_vertical,
        business_vertical_other: updates.business_vertical_other,
        lob_type: updates.lob_type,
      });
      if (taxonomy.vertical?.custom && !taxonomy.business_vertical_other) {
        return res.status(400).json({
          error: 'Tell us what your business does before saving an "Others" business type.',
        });
      }
      updates.business_family = taxonomy.business_family;
      updates.business_vertical = taxonomy.business_vertical;
      updates.business_vertical_other = taxonomy.business_vertical_other
        ? taxonomy.business_vertical_other.slice(0, 160)
        : null;
      if (taxonomy.business_vertical) updates.lob_type = taxonomy.lob_type;
    }

    if (updates.courier_name !== undefined) {
      updates.courier_name = String(updates.courier_name || '').trim() || null;
    }
    if (updates.courier_rate_card !== undefined) {
      updates.courier_rate_card = normalizeRateCard(updates.courier_rate_card);
    }

    const pickupWarning = (
      (updates.restaurant_type === 'cloud_kitchen' || updates.pickup_address)
      && !updates.pickup_latitude
      && !updates.pickup_longitude
    ) ? 'Saved, but pickup coordinates are not set — delivery distance may be inaccurate until you resolve the location.'
      : undefined;

    updates.updated_at = new Date().toISOString();
    let { data, error } = await supabaseAdmin
      .from('tenants')
      .update(updates)
      .eq('id', req.restaurant_id)
      .select().single();

    // Brochure taxonomy columns arrive in a later migration — keep saves working without them.
    if (error && /business_family|business_vertical/i.test(error.message)) {
      const stripped = { ...updates };
      delete stripped.business_family;
      delete stripped.business_vertical;
      delete stripped.business_vertical_other;
      ({ data, error } = await supabaseAdmin
        .from('tenants')
        .update(stripped)
        .eq('id', req.restaurant_id)
        .select().single());
    }

    if (error && /kitchen_workflow|kot_printer/i.test(error.message)) {
      const kitchenKeys = ['kitchen_workflow', 'kot_printer_ip', 'kot_printer_port', 'kot_printer_enabled'];
      const stripped = Object.fromEntries(
        Object.entries(updates).filter(([k]) => !kitchenKeys.includes(k))
      );
      const skippedKitchen = Object.keys(updates).filter(k => kitchenKeys.includes(k));
      if (Object.keys(stripped).length > 1) {
        ({ data, error } = await supabaseAdmin
          .from('tenants')
          .update(stripped)
          .eq('id', req.restaurant_id)
          .select().single());
      }
      if (!error) {
        return res.json({
          success: true,
          restaurant: sanitizeRestaurantForClient(data),
          warning: skippedKitchen.length
            ? 'Kitchen settings not saved — run migrations/add_restaurant_kitchen_settings.sql in Supabase first.'
            : pickupWarning,
        });
      }
    }
    if (error) throw error;

    invalidateRestaurantConfigCache(req.restaurant_id);

    await writeAuditLog({
      user_id: req.user.sub, restaurant_id: req.restaurant_id,
      // Field names only — never log shiprocket_api_key values (API User password).
      action: 'Restaurant settings updated', details: { fields: Object.keys(updates) },
    });

    res.json({
      success: true,
      restaurant: sanitizeRestaurantForClient(data),
      warning: pickupWarning,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Meta integration credentials (WhatsApp / Instagram) ───────────────────────
function sanitizeMetaIntegration(row, channel) {
  if (!row) {
    return {
      channel,
      provider: 'meta',
      is_active: false,
      phone_number_id: channel === 'whatsapp' ? '' : undefined,
      access_token_configured: false,
      webhook_secret_configured: false,
      webhook_verify_token_configured: false,
      token_expires_at: null,
      config: {},
    };
  }
  const cfg = (row.config && typeof row.config === 'object') ? { ...row.config } : {};
  const safeConfig = {};
  if (cfg.token_expires_at) safeConfig.token_expires_at = String(cfg.token_expires_at);
  if (cfg.token_type) safeConfig.token_type = String(cfg.token_type);
  return {
    id: row.id,
    channel: row.channel || channel,
    provider: row.provider || 'meta',
    is_active: !!row.is_active,
    phone_number_id: channel === 'whatsapp' ? (row.phone_number_id || '') : undefined,
    access_token_configured: !!(row.access_token && String(row.access_token).trim()),
    webhook_secret_configured: !!(row.webhook_secret && String(row.webhook_secret).trim()),
    webhook_verify_token_configured: !!(row.webhook_verify_token && String(row.webhook_verify_token).trim()),
    token_expires_at: cfg.token_expires_at || null,
    config: safeConfig,
  };
}

router.get('/restaurants/integration', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const channel = String(req.query.channel || 'whatsapp').trim().toLowerCase() === 'instagram'
      ? 'instagram'
      : 'whatsapp';
    const { data } = await supabaseAdmin
      .from('tenant_integrations')
      .select('id,provider,channel,phone_number_id,access_token,webhook_secret,webhook_verify_token,config,is_active')
      .eq('restaurant_id', req.restaurant_id)
      .eq('provider', 'meta').eq('channel', channel)
      .maybeSingle();

    // WhatsApp callers historically expected the raw row (including token). Keep that
    // shape for channel=whatsapp; Instagram never echoes the secret.
    if (channel === 'whatsapp') {
      return res.json({ success: true, integration: data ?? null });
    }
    res.json({ success: true, integration: sanitizeMetaIntegration(data, 'instagram') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/restaurants/integration', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const channel = String(req.body?.channel || 'whatsapp').trim().toLowerCase() === 'instagram'
      ? 'instagram'
      : 'whatsapp';
    const stepPurpose = channel === 'instagram' ? 'instagram_bind' : 'whatsapp_bind';
    try {
      await requireStepUpInHandler(req, stepPurpose);
    } catch (stepErr) {
      return res.status(stepErr.status || 403).json({
        error: stepErr.message || 'Verification required before updating integration credentials.',
      });
    }

    const { provider = 'meta', phone_number_id, access_token, webhook_secret, webhook_verify_token, is_active, config } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (phone_number_id !== undefined && channel === 'whatsapp') updates.phone_number_id = phone_number_id;
    if (webhook_secret !== undefined) updates.webhook_secret = webhook_secret;
    if (webhook_verify_token !== undefined) updates.webhook_verify_token = webhook_verify_token;
    if (is_active !== undefined) updates.is_active = !!is_active;

    const { data: existing } = await supabaseAdmin
      .from('tenant_integrations')
      .select('id, access_token, config')
      .eq('restaurant_id', req.restaurant_id)
      .eq('provider', provider)
      .eq('channel', channel)
      .maybeSingle();

    // Blank token = keep existing (ecommerce pattern). Explicit null/empty only clears when sent as clear:true.
    if (access_token !== undefined) {
      const tok = String(access_token || '').trim();
      if (tok) {
        updates.access_token = tok;
      } else if (!existing && req.body?.clear_token === true) {
        updates.access_token = null;
      } else if (req.body?.clear_token === true) {
        updates.access_token = null;
      }
      // else omit — leave existing token unchanged
    }

    if (config !== undefined && typeof config === 'object' && config !== null) {
      const prev = (existing?.config && typeof existing.config === 'object') ? existing.config : {};
      updates.config = { ...prev, ...config };
    }

    let result;
    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('tenant_integrations').update(updates)
        .eq('id', existing.id).select().single();
      if (error) throw error;
      result = data;
    } else {
      const insertRow = {
        restaurant_id: req.restaurant_id,
        provider,
        channel,
        is_active: true,
        ...updates,
      };
      if (!insertRow.access_token && channel === 'instagram') {
        return res.status(400).json({ error: 'access_token is required when creating Instagram integration' });
      }
      const { data, error } = await supabaseAdmin
        .from('tenant_integrations')
        .insert(insertRow)
        .select().single();
      if (error) throw error;
      result = data;
    }
    invalidateRestaurantConfigCache(req.restaurant_id);
    if (channel === 'instagram') {
      return res.json({ success: true, integration: sanitizeMetaIntegration(result, 'instagram') });
    }
    res.json({ success: true, integration: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Ecommerce integrations (own-store push) ───────────────────────────────────
const {
  ECOMMERCE_PROVIDERS,
  PROVIDER_LABELS,
  normalizeProvider,
  testProviderConnection,
} = require('../../integrations/ecommerce');

function sanitizeEcommerceRow(row, provider) {
  const cfg = (row?.config && typeof row.config === 'object') ? { ...row.config } : {};
  // Never echo secrets — only non-secret config keys for the UI.
  const safeConfig = {};
  if (cfg.site_id) safeConfig.site_id = String(cfg.site_id);
  if (cfg.store_id) safeConfig.store_id = String(cfg.store_id);
  if (cfg.webhook_url) safeConfig.webhook_url = String(cfg.webhook_url);
  if (cfg.notes) safeConfig.notes = String(cfg.notes);

  const hasAccessToken = !!(row?.access_token && String(row.access_token).trim());
  const hasWebhookSecret = !!(row?.webhook_secret && String(row.webhook_secret).trim());
  const hasEndpoint = !!(row?.api_endpoint && String(row.api_endpoint).trim());

  return {
    provider,
    label: PROVIDER_LABELS[provider] || provider,
    is_active: !!(row && row.is_active),
    api_endpoint: row?.api_endpoint || '',
    config: safeConfig,
    access_token_configured: hasAccessToken,
    webhook_secret_configured: hasWebhookSecret,
    has_credentials: hasAccessToken || hasWebhookSecret || hasEndpoint || !!safeConfig.webhook_url,
    coming_soon: provider === 'ondc',
  };
}

router.get('/restaurants/ecommerce-integrations', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_integrations')
      .select('id, provider, channel, api_endpoint, access_token, webhook_secret, config, is_active')
      .eq('restaurant_id', req.restaurant_id)
      .eq('channel', 'ecommerce');
    if (error) throw error;

    const byProvider = {};
    for (const row of data || []) {
      const p = normalizeProvider(row.provider);
      if (p) byProvider[p] = row;
    }

    const integrations = ECOMMERCE_PROVIDERS.map((provider) =>
      sanitizeEcommerceRow(byProvider[provider] || null, provider),
    );
    res.json({ success: true, integrations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put(
  '/restaurants/ecommerce-integrations/:provider',
  authenticateToken,
  getRestaurantId,
  requireSettingsAccess,
  async (req, res) => {
    try {
      const provider = normalizeProvider(req.params.provider);
      if (!provider) {
        return res.status(400).json({ error: 'Unknown ecommerce provider' });
      }

      const body = req.body || {};
      const { data: existing } = await supabaseAdmin
        .from('tenant_integrations')
        .select('id, api_endpoint, access_token, webhook_secret, config, is_active')
        .eq('restaurant_id', req.restaurant_id)
        .eq('channel', 'ecommerce')
        .eq('provider', provider)
        .maybeSingle();

      const updates = {
        channel: 'ecommerce',
        provider,
        updated_at: new Date().toISOString(),
      };

      if (body.is_active !== undefined) {
        updates.is_active = !!body.is_active;
      } else if (!existing) {
        updates.is_active = false;
      }

      if (body.api_endpoint !== undefined) {
        updates.api_endpoint = String(body.api_endpoint || '').trim() || null;
      }

      // Blank secret = keep existing (Shiprocket pattern).
      if (body.access_token !== undefined) {
        const tok = String(body.access_token || '').trim();
        if (tok) updates.access_token = tok;
        else if (!existing) updates.access_token = null;
      }
      if (body.webhook_secret !== undefined) {
        const sec = String(body.webhook_secret || '').trim();
        if (sec) updates.webhook_secret = sec;
        else if (!existing) updates.webhook_secret = null;
      }

      if (body.config !== undefined && typeof body.config === 'object' && body.config) {
        const prev = (existing?.config && typeof existing.config === 'object') ? existing.config : {};
        const next = { ...prev };
        for (const key of ['site_id', 'store_id', 'webhook_url', 'notes']) {
          if (body.config[key] !== undefined) {
            const v = String(body.config[key] || '').trim();
            if (v) next[key] = v;
            else delete next[key];
          }
        }
        updates.config = next;
      }

      let result;
      if (existing?.id) {
        const { data, error } = await supabaseAdmin
          .from('tenant_integrations')
          .update(updates)
          .eq('id', existing.id)
          .select('id, provider, channel, api_endpoint, access_token, webhook_secret, config, is_active')
          .single();
        if (error) throw error;
        result = data;
      } else {
        const { data, error } = await supabaseAdmin
          .from('tenant_integrations')
          .insert({
            restaurant_id: req.restaurant_id,
            ...updates,
            is_active: updates.is_active !== undefined ? updates.is_active : false,
          })
          .select('id, provider, channel, api_endpoint, access_token, webhook_secret, config, is_active')
          .single();
        if (error) throw error;
        result = data;
      }

      invalidateRestaurantConfigCache(req.restaurant_id);
      res.json({
        success: true,
        integration: sanitizeEcommerceRow(result, provider),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

router.post(
  '/restaurants/ecommerce-integrations/:provider/test',
  authenticateToken,
  getRestaurantId,
  requireSettingsAccess,
  async (req, res) => {
    try {
      const provider = normalizeProvider(req.params.provider);
      if (!provider) {
        return res.status(400).json({ error: 'Unknown ecommerce provider' });
      }

      const { data: existing } = await supabaseAdmin
        .from('tenant_integrations')
        .select('id, provider, channel, api_endpoint, access_token, webhook_secret, config, is_active')
        .eq('restaurant_id', req.restaurant_id)
        .eq('channel', 'ecommerce')
        .eq('provider', provider)
        .maybeSingle();

      // Allow testing unsaved form values from the request body.
      const body = req.body || {};
      const merged = {
        provider,
        channel: 'ecommerce',
        api_endpoint: body.api_endpoint !== undefined
          ? String(body.api_endpoint || '').trim()
          : (existing?.api_endpoint || ''),
        access_token: String(body.access_token || '').trim()
          || existing?.access_token
          || '',
        webhook_secret: String(body.webhook_secret || '').trim()
          || existing?.webhook_secret
          || '',
        config: {
          ...((existing?.config && typeof existing.config === 'object') ? existing.config : {}),
          ...((body.config && typeof body.config === 'object') ? body.config : {}),
        },
      };

      const result = await testProviderConnection(merged);
      if (!result.ok) {
        return res.status(400).json({ success: false, error: result.error || 'Connection failed' });
      }
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  },
);

// ── Payments ─────────────────────────────────────────────────────────────────

module.exports = router;
