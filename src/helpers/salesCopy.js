'use strict';

/**
 * Sales-pitch copy for Special / time-bound discount promos.
 * Prefer Groq when configured; always fall back to deterministic honest copy.
 */

const { deriveMenuDiscount, discountLabel } = require('./menuDiscount');

const GROQ_KEY = process.env.GROQ_API_KEY;

function collectImageUrls(item) {
  return [item?.image_url, item?.image_url_2, item?.image_url_3, item?.image_url_4, item?.image_url_5]
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

function offerContext(item, restaurant = {}) {
  const discount = deriveMenuDiscount(item);
  const isSpecial = !!(item?.is_special_today || item?.is_todays_special);
  const brand = restaurant.display_name || restaurant.name || 'Our kitchen';
  const listPrice = discount.list_price;
  const salePrice = discount.effective_price;
  const pack = item?.pack_size_label || item?.size_label || null;
  const endsLabel = discount.discount_ends_at
    ? new Date(discount.discount_ends_at).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    })
    : null;

  return {
    brand,
    tagline: restaurant.receipt_tagline || 'Homemade · small batch',
    handle: restaurant.instagram_handle || null,
    name: item?.name || 'Item',
    description: String(item?.description || '').trim(),
    special_note: String(item?.special_note || '').trim(),
    pack,
    list_price: listPrice,
    sale_price: salePrice,
    discount_active: discount.discount_active,
    discount_percent: discount.discount_active ? discount.discount_percent : null,
    discount_ends_at: discount.discount_active ? discount.discount_ends_at : null,
    discount_ends_label: discount.discount_active ? endsLabel : null,
    discount_label: discountLabel(discount),
    is_special: isSpecial,
    eligible: discount.discount_active || isSpecial,
    image_urls: collectImageUrls(item),
  };
}

function buildFallbackSalesCopy(ctx) {
  const packBit = ctx.pack ? ` (${ctx.pack})` : '';
  const descBit = ctx.description
    ? ` ${ctx.description.replace(/\s+/g, ' ').slice(0, 120)}`
    : '';
  const noteBit = ctx.special_note ? ` ${ctx.special_note}` : '';
  const handleBit = ctx.handle ? `\n@${String(ctx.handle).replace(/^@/, '')}` : '';

  let feedCaption;
  let storyHeadline;
  let storySubcopy;

  if (ctx.discount_active) {
    feedCaption = (
      `${ctx.name}${packBit} is ${Math.round(ctx.discount_percent)}% off at ${ctx.brand} — ` +
      `now ₹${Math.round(ctx.sale_price)}, was ₹${Math.round(ctx.list_price)}.` +
      (ctx.discount_ends_label ? ` Offer ends ${ctx.discount_ends_label}.` : '') +
      `${noteBit || descBit}\nOrder on WhatsApp while the offer is active.${handleBit}`
    ).trim();
    storyHeadline = `${Math.round(ctx.discount_percent)}% OFF`;
    storySubcopy = `${ctx.name}${packBit} · ₹${Math.round(ctx.sale_price)} (was ₹${Math.round(ctx.list_price)})`;
  } else if (ctx.is_special) {
    feedCaption = (
      `Today's special at ${ctx.brand}: ${ctx.name}${packBit} — ₹${Math.round(ctx.list_price)}.` +
      `${noteBit || descBit}\nOrder on WhatsApp.${handleBit}`
    ).trim();
    storyHeadline = `TODAY'S SPECIAL`;
    storySubcopy = `${ctx.name}${packBit} · ₹${Math.round(ctx.list_price)}`;
  } else {
    feedCaption = (
      `${ctx.name}${packBit} from ${ctx.brand} — ₹${Math.round(ctx.list_price)}.` +
      `${descBit}\nOrder on WhatsApp.${handleBit}`
    ).trim();
    storyHeadline = ctx.name;
    storySubcopy = `₹${Math.round(ctx.list_price)}${ctx.pack ? ` · ${ctx.pack}` : ''}`;
  }

  return {
    feed_caption: feedCaption,
    story_headline: storyHeadline,
    story_subcopy: storySubcopy,
    generated_by: 'fallback',
  };
}

async function generateWithGroq(ctx) {
  if (!GROQ_KEY) return null;

  const facts = {
    brand: ctx.brand,
    tagline: ctx.tagline,
    product: ctx.name,
    pack: ctx.pack,
    description: ctx.description,
    special_note: ctx.special_note,
    is_special: ctx.is_special,
    discount_percent: ctx.discount_percent,
    list_price: ctx.list_price,
    sale_price: ctx.sale_price,
    offer_ends: ctx.discount_ends_label,
  };

  const system = (
    'You write short Instagram sales copy for Indian packaged-food makers. ' +
    'Use ONLY the provided facts. Never invent discounts, prices, end dates, bestsellers, or claims. ' +
    'If a discount or special is present, lead with that sales pitch. Warm, human, concise. ' +
    'Respond with JSON only: {"feed_caption":"...","story_headline":"...","story_subcopy":"..."}'
  );

  const user = `Facts:\n${JSON.stringify(facts, null, 2)}\n\n` +
    'feed_caption max 400 chars. story_headline max 28 chars. story_subcopy max 60 chars.';

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 450,
      temperature: 0.5,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Groq request failed');
  const raw = data.choices?.[0]?.message?.content || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Groq returned non-JSON');
  const parsed = JSON.parse(match[0]);
  if (!parsed.feed_caption || !parsed.story_headline) throw new Error('Incomplete AI copy');
  return {
    feed_caption: String(parsed.feed_caption).trim(),
    story_headline: String(parsed.story_headline).trim().slice(0, 40),
    story_subcopy: String(parsed.story_subcopy || '').trim().slice(0, 80),
    generated_by: 'groq',
  };
}

/**
 * @returns {Promise<object>} draft payload for Instagram preview
 */
async function buildPromoDraft({ item, restaurant }) {
  const ctx = offerContext(item, restaurant);
  let copy = buildFallbackSalesCopy(ctx);
  try {
    const ai = await generateWithGroq(ctx);
    if (ai) copy = ai;
  } catch (err) {
    console.warn('[salesCopy] AI failed, using fallback:', err.message);
  }

  return {
    item_id: item.id,
    eligible: ctx.eligible,
    offer: {
      is_special: ctx.is_special,
      discount_active: ctx.discount_active,
      discount_percent: ctx.discount_percent,
      discount_ends_at: ctx.discount_ends_at,
      discount_label: ctx.discount_label,
      list_price: ctx.list_price,
      sale_price: ctx.sale_price,
      special_note: ctx.special_note || null,
    },
    product: {
      name: ctx.name,
      description: ctx.description,
      pack: ctx.pack,
      image_urls: ctx.image_urls,
    },
    brand: ctx.brand,
    tagline: ctx.tagline,
    instagram_handle: ctx.handle,
    feed_caption: copy.feed_caption,
    story_headline: copy.story_headline,
    story_subcopy: copy.story_subcopy,
    generated_by: copy.generated_by,
    publish_readiness: {
      has_images: ctx.image_urls.length > 0,
      can_carousel: ctx.image_urls.length >= 2,
      can_story_svg: true,
      note: ctx.image_urls.length
        ? null
        : 'No public product images — Feed/Carousel publish needs image URLs; Story SVG download still works.',
    },
  };
}

module.exports = {
  offerContext,
  collectImageUrls,
  buildFallbackSalesCopy,
  generateWithGroq,
  buildPromoDraft,
};
