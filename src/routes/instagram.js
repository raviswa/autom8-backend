'use strict';

/**
 * Instagram promo drafts + Content Publishing (Feed / Carousel / Stories).
 *
 * POST /api/instagram/drafts   — AI/fallback sales pitch for an item
 * POST /api/instagram/publish  — confirm and publish (requires IG user id + token)
 * GET  /api/instagram/status   — connection readiness
 */

const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, getRestaurantId } = require('../middleware/auth');
const { getWhatsAppIntegration } = require('../helpers/restaurantConfig');
const { writeAuditLog } = require('../helpers/auditLog');
const { buildPromoDraft, collectImageUrls } = require('../helpers/salesCopy');
const { deriveMenuDiscount } = require('../helpers/menuDiscount');
const { buildSkuStorySvg } = require('../helpers/skuStory');

const GRAPH = 'https://graph.facebook.com/v20.0';

async function loadTenant(restaurantId) {
  const { data } = await supabaseAdmin
    .from('tenants')
    .select('id, name, display_name, receipt_tagline, instagram_handle, instagram_user_id, lob_type')
    .eq('id', restaurantId)
    .maybeSingle();
  return data;
}

async function resolvePublishCreds(restaurantId, tenant) {
  const igUserId = String(tenant?.instagram_user_id || process.env.INSTAGRAM_USER_ID || '').trim();
  const igIntegration = await supabaseAdmin
    .from('tenant_integrations')
    .select('access_token, config, is_active')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'meta')
    .eq('channel', 'instagram')
    .maybeSingle()
    .then((r) => r.data)
    .catch(() => null);

  const wa = await getWhatsAppIntegration(restaurantId).catch(() => null);
  const token = String(
    igIntegration?.access_token
    || wa?.accessToken
    || process.env.META_ACCESS_TOKEN
    || process.env.WHATSAPP_ACCESS_TOKEN
    || '',
  ).trim();

  return {
    igUserId,
    token,
    connected: Boolean(igUserId && token),
    source: igIntegration?.access_token
      ? 'instagram_integration'
      : (wa?.accessToken ? 'whatsapp_token' : (process.env.META_ACCESS_TOKEN ? 'env' : null)),
  };
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
  // Some image containers are publishable immediately without FINISHED.
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

router.get('/status', authenticateToken, getRestaurantId, async (req, res) => {
  try {
    const tenant = await loadTenant(req.restaurant_id);
    const creds = await resolvePublishCreds(req.restaurant_id, tenant);
    res.json({
      success: true,
      instagram_handle: tenant?.instagram_handle || null,
      instagram_user_id: creds.igUserId || null,
      connected: creds.connected,
      token_source: creds.source,
      can_draft: true,
      can_publish: creds.connected,
      setup_hint: creds.connected
        ? null
        : 'Add Instagram professional account user ID in Settings and ensure your Meta token has instagram_content_publish. Handle alone is not enough.',
    });
  } catch (err) {
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
      setup_hint: creds.connected
        ? null
        : 'Instagram Business/Creator account + publish token required. You can still download the Story SVG.',
    };

    // Story SVG preview (inline) for managers without image URLs / publish setup
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
    if (!creds.connected) {
      return res.status(400).json({
        error: 'Instagram publishing is not connected',
        setup_hint: 'Set instagram_user_id in Settings and use a Meta token with instagram_content_publish. Story SVG download still works without this.',
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

    const results = { feed: null, story: null };

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
      // Stories require a public image URL Meta can fetch — use first product photo.
      // Promo text must already be in the creative for SVG downloads; for API Stories we
      // publish the product image (Meta ignores captions on STORIES).
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
      },
    });

    res.json({ success: true, results });
  } catch (err) {
    console.error('[instagram/publish]', err.message, err.meta || '');
    res.status(500).json({ error: err.message, meta: err.meta || undefined });
  }
});

module.exports = router;
