'use strict';

/**
 * Instagram promo drafts + Content Publishing (Feed / Carousel / Stories).
 *
 * GET  /api/instagram/status              — connection readiness
 * GET  /api/instagram/oauth/start         — Facebook Login for Business URL
 * GET  /api/instagram/oauth/callback      — OAuth redirect (public)
 * GET  /api/instagram/oauth/pending       — multi-page pick list
 * POST /api/instagram/oauth/select-page   — finish multi-page pick
 * POST /api/instagram/drafts             — AI/fallback sales pitch for an item
 * POST /api/instagram/publish            — confirm and publish (requires IG user id + token)
 * POST /api/instagram/token/exchange     — short-lived → long-lived Meta user token (internal override)
 */

const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, getRestaurantId, canManageRestaurantSettings } = require('../middleware/auth');
const { getWhatsAppIntegration } = require('../helpers/restaurantConfig');
const { writeAuditLog } = require('../helpers/auditLog');
const { buildPromoDraft, collectImageUrls } = require('../helpers/salesCopy');
const { deriveMenuDiscount } = require('../helpers/menuDiscount');
const { buildSkuStorySvg } = require('../helpers/skuStory');
const { requireStepUpInHandler } = require('../helpers/stepUpAuth');
const {
  isInstagramOAuthConfigured,
  getInstagramOAuthUrl,
  verifyOAuthState,
  completeInstagramConnect,
  selectInstagramPage,
  listPendingPages,
  buildSettingsRedirect,
} = require('../helpers/instagramConnect');

const GRAPH = 'https://graph.facebook.com/v20.0';
const DEFAULT_MIRROR_CAP = 20;
const BRANDED_CAPTION = (username) => (
  `New post from @${username} — powered by Autom8 Works`
);

function requireSettingsAccess(req, res, next) {
  if (!canManageRestaurantSettings(req.user_role)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  return next();
}

function isNumericIgUserId(raw) {
  return /^\d{5,}$/.test(String(raw || '').trim());
}

function mapGraphError(err) {
  const meta = err?.meta || {};
  const code = meta.code;
  const subcode = meta.error_subcode;
  const msg = String(err?.message || meta.message || '');

  if (code === 190 || /session has expired|access token|oauth/i.test(msg)) {
    return {
      status: 400,
      error: 'Instagram Meta token expired or invalid. Paste a long-lived or System User token in Settings (recommended: System User).',
      code: 'token_expired',
    };
  }
  if (/does not exist|missing permissions|does not support this operation/i.test(msg)) {
    return {
      status: 400,
      error: 'Meta cannot access this Instagram user ID with the current token. Use the numeric IG Business Account ID and a token with instagram_content_publish for that account (not the @handle; WhatsApp-only tokens often fail).',
      code: 'object_permission',
    };
  }
  if (/image_url|download|media|unsupported format|url/i.test(msg) && /invalid|unable|failed|could not/i.test(msg)) {
    return {
      status: 400,
      error: `Invalid or unreachable product image URL for Instagram: ${msg}`,
      code: 'invalid_image',
    };
  }
  if (code === 10 || code === 200 || /permission|instagram_content_publish/i.test(msg)) {
    return {
      status: 400,
      error: 'Meta token is missing Instagram Content Publishing permission (instagram_content_publish).',
      code: 'missing_permission',
    };
  }
  if (subcode || code) {
    return { status: 500, error: msg, code: 'graph_error', meta };
  }
  return { status: 500, error: msg || 'Instagram publish failed', meta };
}

async function loadTenant(restaurantId) {
  const fullCols = 'id, name, display_name, receipt_tagline, instagram_handle, instagram_user_id, lob_type, instagram_feature_on_autom8';
  const baseCols = 'id, name, display_name, receipt_tagline, instagram_handle, instagram_user_id, lob_type';
  let { data, error } = await supabaseAdmin
    .from('tenants')
    .select(fullCols)
    .eq('id', restaurantId)
    .maybeSingle();
  if (error && /instagram_feature_on_autom8|column .* does not exist/i.test(error.message || '')) {
    console.warn('[instagram] full tenant select failed — falling back without mirror consent column');
    ({ data, error } = await supabaseAdmin
      .from('tenants')
      .select(baseCols)
      .eq('id', restaurantId)
      .maybeSingle());
  }
  if (error) throw error;
  return data ? { ...data, instagram_feature_on_autom8: !!data.instagram_feature_on_autom8 } : data;
}

async function resolvePublishCreds(restaurantId, tenant) {
  const rawIgUserId = String(tenant?.instagram_user_id || process.env.INSTAGRAM_USER_ID || '').trim();
  const igUserIdValid = isNumericIgUserId(rawIgUserId);
  const igUserId = igUserIdValid ? rawIgUserId : '';

  const igIntegration = await supabaseAdmin
    .from('tenant_integrations')
    .select('access_token, config, is_active')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'instagram')
    .maybeSingle()
    .then((r) => r.data)
    .catch(() => null);

  const igTokenActive = !!(igIntegration?.is_active !== false && igIntegration?.access_token);
  const igToken = igTokenActive ? String(igIntegration.access_token).trim() : '';

  const wa = await getWhatsAppIntegration(restaurantId).catch(() => null);
  const waToken = String(wa?.accessToken || '').trim();
  const envToken = String(process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '').trim();

  let token = '';
  let source = null;
  if (igToken) {
    token = igToken;
    source = 'instagram_integration';
  } else if (waToken) {
    token = waToken;
    source = 'whatsapp_token';
  } else if (envToken) {
    token = envToken;
    source = process.env.META_ACCESS_TOKEN ? 'env' : 'env_whatsapp';
  }

  const cfg = (igIntegration?.config && typeof igIntegration.config === 'object')
    ? igIntegration.config
    : {};

  return {
    igUserId,
    igUserIdRaw: rawIgUserId || null,
    igUserIdValid,
    token,
    tokenConfigured: !!igToken,
    tokenExpiresAt: cfg.token_expires_at || null,
    connected: Boolean(igUserId && token),
    source,
  };
}

function platformMirrorCreds() {
  const igUserId = String(
    process.env.AUTOM8_IG_USER_ID
    || process.env.INSTAGRAM_USER_ID
    || '17841438721697078',
  ).trim();
  const token = String(
    process.env.AUTOM8_IG_ACCESS_TOKEN
    || process.env.META_ACCESS_TOKEN
    || '',
  ).trim();
  return {
    igUserId: isNumericIgUserId(igUserId) ? igUserId : '',
    token,
    ready: Boolean(isNumericIgUserId(igUserId) && token),
  };
}

async function graphGet(path, accessToken, fields) {
  const url = new URL(`${GRAPH}${path}`);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', accessToken);
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const msg = data.error?.message || JSON.stringify(data.error || data) || `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.meta = data.error || data;
    throw err;
  }
  return data;
}

async function graphPost(path, params) {
  const url = new URL(`${GRAPH}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  });
  const resp = await fetch(url.toString(), { method: 'POST', signal: AbortSignal.timeout(30_000) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const msg = data.error?.message || JSON.stringify(data.error || data) || `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.meta = data.error || data;
    throw err;
  }
  return data;
}

async function waitContainerReady(containerId, accessToken, { tries = 12 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const url = `${GRAPH}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const data = await resp.json().catch(() => ({}));
    const status = data.status_code || data.status;
    if (status === 'FINISHED') return data;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Media container ${status}: ${data.status || data.error?.message || 'failed'}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn('[instagram] media container wait timed out — attempting publish anyway', containerId);
  return { status_code: 'READY' };
}

async function publishFeed({ igUserId, token, imageUrls, caption }) {
  if (!imageUrls.length) throw new Error('At least one public image_url is required for Feed publish');

  if (imageUrls.length === 1) {
    const container = await graphPost(`/${igUserId}/media`, {
      image_url: imageUrls[0],
      caption: caption || '',
      access_token: token,
    });
    await waitContainerReady(container.id, token);
    return graphPost(`/${igUserId}/media_publish`, {
      creation_id: container.id,
      access_token: token,
    });
  }

  const children = [];
  for (const imageUrl of imageUrls.slice(0, 10)) {
    const child = await graphPost(`/${igUserId}/media`, {
      image_url: imageUrl,
      is_carousel_item: true,
      access_token: token,
    });
    children.push(child.id);
  }
  const carousel = await graphPost(`/${igUserId}/media`, {
    media_type: 'CAROUSEL',
    children: children.join(','),
    caption: caption || '',
    access_token: token,
  });
  await waitContainerReady(carousel.id, token);
  return graphPost(`/${igUserId}/media_publish`, {
    creation_id: carousel.id,
    access_token: token,
  });
}

async function publishStory({ igUserId, token, imageUrl }) {
  if (!imageUrl) throw new Error('A public image_url is required for Story publish');
  const container = await graphPost(`/${igUserId}/media`, {
    image_url: imageUrl,
    media_type: 'STORIES',
    access_token: token,
  });
  await waitContainerReady(container.id, token);
  return graphPost(`/${igUserId}/media_publish`, {
    creation_id: container.id,
    access_token: token,
  });
}

async function countMirrorsToday() {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  try {
    const { count, error } = await supabaseAdmin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'Instagram mirror published')
      .gte('created_at', start.toISOString());
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.warn('[instagram/mirror] daily count unavailable:', err.message);
    return 0;
  }
}

async function maybeMirrorBrandedRepost({
  tenant,
  restaurantId,
  userId,
  subscriberIgId,
  subscriberToken,
  imageUrls,
  itemId,
  itemName,
}) {
  if (!tenant?.instagram_feature_on_autom8) {
    return { skipped: true, reason: 'consent_off' };
  }
  if (!imageUrls?.length) {
    return { skipped: true, reason: 'no_images' };
  }

  const platform = platformMirrorCreds();
  if (!platform.ready) {
    return { skipped: true, reason: 'platform_creds_missing' };
  }

  // Never mirror onto the same account (Autom8 Works testing as itself).
  if (String(platform.igUserId) === String(subscriberIgId)) {
    return { skipped: true, reason: 'same_account' };
  }

  const cap = Number(process.env.AUTOM8_IG_MIRROR_DAILY_CAP || DEFAULT_MIRROR_CAP);
  const used = await countMirrorsToday();
  if (used >= cap) {
    console.warn('[instagram/mirror] daily cap reached', { used, cap });
    return { skipped: true, reason: 'daily_cap', used, cap };
  }

  let username = String(tenant.instagram_handle || '').replace(/^@/, '').trim();
  try {
    const profile = await graphGet(`/${subscriberIgId}`, subscriberToken, 'username');
    if (profile?.username) username = String(profile.username).replace(/^@/, '');
  } catch (err) {
    console.warn('[instagram/mirror] username fetch failed, using handle fallback:', err.message);
  }
  if (!username) username = 'autom8_subscriber';

  try {
    const published = await publishFeed({
      igUserId: platform.igUserId,
      token: platform.token,
      imageUrls,
      caption: BRANDED_CAPTION(username),
    });
    await writeAuditLog({
      user_id: userId,
      restaurant_id: restaurantId,
      action: 'Instagram mirror published',
      details: {
        item_id: itemId,
        item_name: itemName,
        subscriber_ig_id: subscriberIgId,
        subscriber_username: username,
        mirror_ig_id: platform.igUserId,
        mirror_post_id: published?.id || null,
      },
    });
    return { ok: true, id: published?.id || null, username };
  } catch (err) {
    console.error('[instagram/mirror] failed (subscriber post kept):', err.message, err.meta || '');
    await writeAuditLog({
      user_id: userId,
      restaurant_id: restaurantId,
      action: 'Instagram mirror failed',
      details: {
        item_id: itemId,
        item_name: itemName,
        subscriber_ig_id: subscriberIgId,
        error: err.message,
        meta: err.meta || null,
      },
    }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

function setupHint(creds) {
  if (creds.connected) return null;
  if (creds.igUserIdRaw && !creds.igUserIdValid) {
    return 'Instagram user ID must be the numeric Business/Creator account ID (digits only), not the @handle.';
  }
  if (!creds.igUserIdValid) {
    return 'Add your numeric Instagram professional account ID in Settings. Handle alone is not enough.';
  }
  if (!creds.token) {
    return 'Add an Instagram publish token in Settings (System User recommended, or long-lived User token with instagram_content_publish).';
  }
  return 'Instagram publishing is not fully connected.';
}

router.get('/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const tenant = await loadTenant(req.restaurant_id);
    const creds = await resolvePublishCreds(req.restaurant_id, tenant);
    res.json({
      success: true,
      instagram_handle: tenant?.instagram_handle || null,
      instagram_user_id: creds.igUserId || creds.igUserIdRaw || null,
      ig_user_id_valid: creds.igUserIdValid,
      connected: creds.connected,
      token_source: creds.source,
      token_configured: creds.tokenConfigured,
      token_expires_at: creds.tokenExpiresAt,
      can_draft: true,
      can_publish: creds.connected,
      feature_on_autom8: !!tenant?.instagram_feature_on_autom8,
      setup_hint: setupHint(creds),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/token/exchange', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    try {
      await requireStepUpInHandler(req, 'instagram_bind');
    } catch (stepErr) {
      return res.status(stepErr.status || 403).json({
        error: stepErr.message || 'Verification required before exchanging Instagram token.',
      });
    }

    const shortLived = String(req.body?.short_lived_token || req.body?.access_token || '').trim();
    if (!shortLived) {
      return res.status(400).json({ error: 'short_lived_token is required' });
    }

    const appId = String(process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '').trim();
    const appSecret = String(process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '').trim();
    if (!appId || !appSecret) {
      return res.status(500).json({
        error: 'Server missing META_APP_ID / META_APP_SECRET — cannot exchange tokens. Paste a long-lived or System User token instead.',
      });
    }

    const url = new URL(`${GRAPH}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('fb_exchange_token', shortLived);

    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error || !data.access_token) {
      const msg = data.error?.message || JSON.stringify(data.error || data) || `HTTP ${resp.status}`;
      return res.status(400).json({ error: `Token exchange failed: ${msg}` });
    }

    const expiresIn = Number(data.expires_in) || null;
    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    const { data: existing } = await supabaseAdmin
      .from('tenant_integrations')
      .select('id, config')
      .eq('restaurant_id', req.restaurant_id)
      .eq('provider', 'meta')
      .eq('channel', 'instagram')
      .maybeSingle();

    const prevCfg = (existing?.config && typeof existing.config === 'object') ? existing.config : {};
    const nextConfig = {
      ...prevCfg,
      token_type: 'long_lived_user',
      token_expires_at: expiresAt,
      exchanged_at: new Date().toISOString(),
    };

    let row;
    if (existing) {
      const { data: updated, error } = await supabaseAdmin
        .from('tenant_integrations')
        .update({
          access_token: data.access_token,
          is_active: true,
          config: nextConfig,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('id, is_active, config')
        .single();
      if (error) throw error;
      row = updated;
    } else {
      const { data: inserted, error } = await supabaseAdmin
        .from('tenant_integrations')
        .insert({
          restaurant_id: req.restaurant_id,
          provider: 'meta',
          channel: 'instagram',
          access_token: data.access_token,
          is_active: true,
          config: nextConfig,
        })
        .select('id, is_active, config')
        .single();
      if (error) throw error;
      row = inserted;
    }

    res.json({
      success: true,
      expires_in: expiresIn,
      token_expires_at: expiresAt,
      access_token_configured: true,
      integration_id: row?.id || null,
      note: 'Long-lived User tokens typically last ~60 days. Prefer a System User token (no expiry) for production.',
    });
  } catch (err) {
    console.error('[instagram/token/exchange]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/drafts', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const itemId = req.body?.item_id || req.body?.menu_item_id;
    if (!itemId) return res.status(400).json({ error: 'item_id is required' });

    const { data: item, error } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, description, price, pack_size_label, size_label, special_note, is_special_today, is_todays_special, discount_percent, discount_ends_at, image_url, image_url_2, image_url_3, image_url_4, image_url_5')
      .eq('id', itemId)
      .eq('restaurant_id', req.restaurant_id)
      .maybeSingle();
    if (error) throw error;
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    const tenant = await loadTenant(req.restaurant_id);
    const draft = await buildPromoDraft({ item, restaurant: tenant });
    if (req.body?.caption_override) {
      draft.feed_caption = String(req.body.caption_override).trim();
    }
    const creds = await resolvePublishCreds(req.restaurant_id, tenant);
    draft.publish = {
      connected: creds.connected,
      token_source: creds.source,
      setup_hint: setupHint(creds)
        || (creds.source === 'whatsapp_token'
          ? 'Using WhatsApp Meta token as fallback — prefer a dedicated Instagram publish token in Settings.'
          : null),
    };

    const discount = deriveMenuDiscount(item);
    draft.story_svg = buildSkuStorySvg({
      brand: draft.brand,
      productName: draft.product.name,
      price: discount.discount_active ? discount.effective_price : discount.list_price,
      compareAtPrice: discount.discount_active ? discount.list_price : null,
      packLabel: draft.product.pack,
      tagline: draft.tagline,
      shopHint: 'Order on WhatsApp · link in bio',
      promoHeadline: draft.story_headline,
      promoSubcopy: draft.story_subcopy,
      discountPercent: discount.discount_active ? discount.discount_percent : null,
      isSpecial: !!(item.is_special_today || item.is_todays_special),
    });

    res.json({ success: true, draft });
  } catch (err) {
    console.error('[instagram/drafts]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/publish', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    if (!['owner', 'manager', 'brand_owner'].includes(req.user_role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const {
      item_id,
      feed_caption,
      publish_feed = true,
      publish_story = false,
      image_urls: bodyImages,
      confirm,
    } = req.body || {};

    if (!confirm) {
      return res.status(400).json({ error: 'confirm: true is required — preview the draft before publishing' });
    }
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });
    if (!publish_feed && !publish_story) {
      return res.status(400).json({ error: 'Select Feed and/or Story to publish' });
    }

    const tenant = await loadTenant(req.restaurant_id);
    const creds = await resolvePublishCreds(req.restaurant_id, tenant);
    if (!creds.igUserIdValid) {
      return res.status(400).json({
        error: 'Instagram user ID must be numeric (Business/Creator account ID), not the @handle.',
        setup_hint: setupHint(creds),
      });
    }
    if (!creds.connected) {
      return res.status(400).json({
        error: 'Instagram publishing is not connected',
        setup_hint: setupHint(creds),
      });
    }

    const { data: item, error } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, image_url, image_url_2, image_url_3, image_url_4, image_url_5')
      .eq('id', item_id)
      .eq('restaurant_id', req.restaurant_id)
      .maybeSingle();
    if (error) throw error;
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    const images = (Array.isArray(bodyImages) && bodyImages.length
      ? bodyImages
      : collectImageUrls(item)
    ).filter((u) => /^https?:\/\//i.test(String(u || '')));

    const results = { feed: null, story: null, mirror: null };

    if (publish_feed) {
      if (!images.length) {
        return res.status(400).json({ error: 'Feed/Carousel publish needs at least one public product image URL' });
      }
      results.feed = await publishFeed({
        igUserId: creds.igUserId,
        token: creds.token,
        imageUrls: images,
        caption: feed_caption || '',
      });
    }

    if (publish_story) {
      if (!images.length) {
        return res.status(400).json({
          error: 'Story API publish needs a public image URL. Download the Story SVG instead if you have no product photos.',
        });
      }
      results.story = await publishStory({
        igUserId: creds.igUserId,
        token: creds.token,
        imageUrl: images[0],
      });
    }

    await writeAuditLog({
      user_id: req.user.sub,
      restaurant_id: req.restaurant_id,
      action: 'Instagram promo published',
      details: {
        item_id,
        item_name: item.name,
        publish_feed: !!publish_feed,
        publish_story: !!publish_story,
        feed_id: results.feed?.id || null,
        story_id: results.story?.id || null,
        token_source: creds.source,
      },
    });

    // Branded mirror to Autom8 Works — only after subscriber success; never rolls back.
    if (publish_feed && results.feed?.id && images.length) {
      results.mirror = await maybeMirrorBrandedRepost({
        tenant,
        restaurantId: req.restaurant_id,
        userId: req.user.sub,
        subscriberIgId: creds.igUserId,
        subscriberToken: creds.token,
        imageUrls: images,
        itemId: item_id,
        itemName: item.name,
      });
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('[instagram/publish]', err.message, err.meta || '');
    const mapped = mapGraphError(err);
    res.status(mapped.status).json({
      error: mapped.error,
      code: mapped.code,
      meta: mapped.meta || err.meta || undefined,
    });
  }
});

// ── Facebook Login for Business (Instagram publishing) ───────────────────────

router.get('/oauth/start', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    try {
      await requireStepUpInHandler(req, 'instagram_bind');
    } catch (stepErr) {
      return res.status(stepErr.status || 403).json({
        error: stepErr.message || 'Verification required before connecting Instagram.',
        code: stepErr.code,
      });
    }

    if (!isInstagramOAuthConfigured()) {
      return res.status(503).json({
        error: 'Instagram OAuth is not configured on the server. Set META_APP_ID, META_APP_SECRET, and META_INSTAGRAM_OAUTH_REDIRECT_URI.',
        code: 'oauth_not_configured',
      });
    }

    const { url } = getInstagramOAuthUrl(req.restaurant_id);
    return res.json({ success: true, url });
  } catch (err) {
    console.error('[instagram/oauth/start]', err.message);
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * Public Meta redirect target — no JWT. State carries restaurantId (HMAC-signed).
 */
router.get('/oauth/callback', async (req, res) => {
  const fail = (message, code = 'oauth_error') => {
    const dest = buildSettingsRedirect({
      ig_oauth: 'error',
      message: String(message || 'Instagram connect failed').slice(0, 240),
      code,
    });
    return res.redirect(302, dest);
  };

  try {
    if (req.query.error) {
      return fail(
        req.query.error_description || req.query.error || 'Authorization denied',
        'oauth_denied',
      );
    }

    let restaurantId;
    try {
      ({ restaurantId } = verifyOAuthState(req.query.state));
    } catch (stateErr) {
      return fail(stateErr.message, stateErr.code || 'oauth_state_invalid');
    }

    const code = String(req.query.code || '').trim();
    if (!code) return fail('Missing OAuth code', 'oauth_missing_code');

    const result = await completeInstagramConnect(restaurantId, { code });
    if (result.status === 'pick_required') {
      return res.redirect(302, buildSettingsRedirect({ ig_oauth: 'pick' }));
    }

    await writeAuditLog({
      user_id: null,
      restaurant_id: restaurantId,
      action: 'Instagram OAuth connected',
      details: {
        ig_user_id: result.ig_user_id,
        page_id: result.page_id,
        username: result.username,
      },
    }).catch(() => {});

    return res.redirect(302, buildSettingsRedirect({
      ig_oauth: 'connected',
      ig_user: result.username || result.ig_user_id || '',
    }));
  } catch (err) {
    console.error('[instagram/oauth/callback]', err.message, err.graph || '');
    return fail(err.message, err.code || 'oauth_error');
  }
});

router.get('/oauth/pending', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    const pages = listPendingPages(req.restaurant_id);
    if (!pages) {
      return res.status(404).json({
        error: 'No pending Instagram page selection. Connect Instagram again.',
        code: 'oauth_pending_expired',
      });
    }
    return res.json({ success: true, pages });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

router.post('/oauth/select-page', authenticateToken, getRestaurantId, requireSettingsAccess, async (req, res) => {
  try {
    try {
      await requireStepUpInHandler(req, 'instagram_bind');
    } catch (stepErr) {
      return res.status(stepErr.status || 403).json({
        error: stepErr.message || 'Verification required before connecting Instagram.',
        code: stepErr.code,
      });
    }

    const result = await selectInstagramPage(req.restaurant_id, req.body?.page_id);
    await writeAuditLog({
      user_id: req.user_id || null,
      restaurant_id: req.restaurant_id,
      action: 'Instagram OAuth page selected',
      details: {
        ig_user_id: result.ig_user_id,
        page_id: result.page_id,
        username: result.username,
      },
    }).catch(() => {});

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[instagram/oauth/select-page]', err.message);
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

module.exports = router;
