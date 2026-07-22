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
  'delivery_charge_default','delivery_charge_tiers',
  'min_delivery_order_amount','min_takeaway_order_amount',
  'scheduled_delivery_enabled','scheduled_takeaway_enabled','scheduled_kds_lead_minutes','max_delivery_radius_km',
  'scheduled_slot_max_orders','schedule_buffer_minutes','schedule_rounding_minutes','schedule_early_start_max_minutes',
  'shiprocket_connected','shiprocket_api_key','shiprocket_email','intra_city_charge','outstation_charge','free_delivery_above',
  'cod_enabled_city','cod_enabled_outstation',
  'shipping_provider','courier_name','courier_rate_card',
  'gstin','fssai_license','sac_code','receipt_tagline',
  'packaging_weight_grams',
  'daily_settlement_enabled','weekly_promo_drafts_enabled','instagram_handle','instagram_user_id',
  'subscribed_features', 'enabled_services',
    ];

    // These two fields are owner-governed only — a manager may have general
// settings access (whitelisted above), but must not be able to change the
// business type or grant themselves menu-upload rights via direct API call,
// even though the UI already hides these controls from managers.
const OWNER_ONLY_FIELDS = ['lob_type', 'allow_manager_menu_upload', 'shiprocket_api_key', 'shiprocket_email'];
const isOwnerLike = ['owner', 'brand_owner'].includes(req.user_role);
    
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED.includes(k))
    );
    if (req.body.maps_url !== undefined) {
      updates.google_maps_url = req.body.maps_url || null;
    }
    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'No valid fields provided' });

    if (!isOwnerLike) {
      for (const key of OWNER_ONLY_FIELDS) delete updates[key];
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

    // Auto-resolve pickup coordinates for cloud kitchens when saving address/maps link
    const needsPickupResolve = (
      (updates.restaurant_type === 'cloud_kitchen' || updates.pickup_address !== undefined)
      && (updates.pickup_address || req.body.maps_url)
      && (updates.pickup_latitude === undefined && updates.pickup_longitude === undefined
          || !updates.pickup_latitude || !updates.pickup_longitude)
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

// ── WhatsApp integration credentials ──────────────────────────────────────────
router.get('/restaurants/integration', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('tenant_integrations')
      .select('id,provider,channel,phone_number_id,access_token,webhook_secret,webhook_verify_token,config,is_active')
      .eq('restaurant_id', req.restaurant_id)
      .eq('provider', 'meta').eq('channel', 'whatsapp')
      .maybeSingle();
    res.json({ success: true, integration: data ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/restaurants/integration', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {

    const { provider = 'meta', channel = 'whatsapp', phone_number_id, access_token, webhook_secret, webhook_verify_token } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (phone_number_id     !== undefined) updates.phone_number_id     = phone_number_id;
    if (access_token        !== undefined) updates.access_token        = access_token;
    if (webhook_secret      !== undefined) updates.webhook_secret      = webhook_secret;
    if (webhook_verify_token!== undefined) updates.webhook_verify_token= webhook_verify_token;

    const { data: existing } = await supabaseAdmin
      .from('tenant_integrations')
      .select('id').eq('restaurant_id', req.restaurant_id)
      .eq('provider', provider).eq('channel', channel).maybeSingle();

    let result;
    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('tenant_integrations').update(updates)
        .eq('id', existing.id).select().single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('tenant_integrations')
        .insert({ restaurant_id: req.restaurant_id, provider, channel, is_active: true, ...updates })
        .select().single();
      if (error) throw error;
      result = data;
    }
    invalidateRestaurantConfigCache(req.restaurant_id);
    res.json({ success: true, integration: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Payments ─────────────────────────────────────────────────────────────────

module.exports = router;
