// src/helpers/feedbackFlow.js
// ============================================================================
// Multi-step post-visit feedback flow (Node.js / WhatsApp webhook path).
//
// Step 1 — Rating (1-5 or interactive list)
// Step 2 — Multi-select aspects (numbered reply: "1 3 5" or "all")
// Step 3 — Optional free-text comment
//
// Visit context: Token number is primary (dine-in + takeaway). Table number is
// shown only for dine-in seated visits.
// ============================================================================

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { sendWhatsAppMessage, sendWhatsAppInteractive } = require('./whatsapp');

const POSITIVE_ASPECTS = [
  ['food_quality',        '🍽️ Food quality'],
  ['quick_service',       '⚡ Quick service'],
  ['friendly_staff',      '😊 Friendly staff'],
  ['cleanliness',         '🧹 Cleanliness'],
  ['value_for_money',     '💰 Great value for money'],
  ['ordering_experience', '📱 Easy ordering experience'],
];

const IMPROVEMENT_ASPECTS = [
  ['food_quality',        '🍽️ Food quality'],
  ['wait_time',           '⏱️ Wait time'],
  ['staff_attitude',      '😐 Staff attitude'],
  ['cleanliness',         '🧹 Cleanliness'],
  ['value_for_money',     '💰 Value for money'],
  ['ordering_experience', '📱 Ordering experience'],
];

const NEGATIVE_ASPECTS = [
  ['food_quality',        '🍽️ Food quality'],
  ['wait_time',           '⏱️ Wait time too long'],
  ['staff_attitude',      '😐 Staff attitude'],
  ['cleanliness',         '🧹 Cleanliness'],
  ['overpriced',          '💰 Felt overpriced'],
  ['wrong_order',         '❌ Wrong / missing items'],
  ['food_temperature',    '🌡️ Food temperature'],
  ['ordering_experience', '📱 Ordering experience'],
];

const RATING_MAP = {
  excellent: 5, 5: 5,
  good: 4, 4: 4,
  average: 3, 3: 3,
  'below average': 2, 'below_average': 2, 2: 2,
  poor: 1, 1: 1,
};

function aspectsForRating(rating) {
  if (rating >= 4) {
    return [POSITIVE_ASPECTS, '🌟 What did you love about your visit?'];
  }
  if (rating === 3) {
    return [IMPROVEMENT_ASPECTS, '💡 What could we do better next time?'];
  }
  return [NEGATIVE_ASPECTS, '😔 We\'re sorry to hear that. What went wrong?'];
}

function buildAspectMenu(aspects, prompt) {
  const lines = aspects.map(([_, label], i) => `${i + 1}️⃣ ${label}`).join('\n');
  return (
    `${prompt}\n\n${lines}\n\n` +
    `Reply with the numbers that apply, separated by spaces or commas\n` +
    `_(e.g. *1 3* or *1,3,5* or *all*)_\n\n` +
    `Or reply *Skip* to finish.`
  );
}

function parseAspectReply(text, aspects) {
  const t = String(text || '').trim().toLowerCase();
  if (['skip', 's', 'none', 'no', 'done', 'ok', 'okay', 'skip_aspects'].includes(t)) {
    return [];
  }
  if (['all', 'everything', 'all of the above'].includes(t)) {
    return aspects.map(([id]) => id);
  }
  const tokens = t.split(/[\s,;]+/).filter(Boolean);
  const selected = [];
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const idx = parseInt(tok, 10) - 1;
      if (idx >= 0 && idx < aspects.length) selected.push(aspects[idx][0]);
    }
  }
  return selected.length ? selected : null;
}

function aspectLabels(aspects, ids) {
  const map = Object.fromEntries(aspects.map(([id, label]) => [id, label]));
  return ids.map(id => map[id] || id);
}

/** Resolve visit context — token is primary; table only for dine-in. */
async function resolveVisitContext(record) {
  let visitType = record.visit_type || null;
  let tableNumber = record.table_number || null;
  const tokenId = record.token_number || null;

  if (tokenId) {
    const { data: token } = await supabaseAdmin
      .from('walk_in_tokens')
      .select('type, table_number')
      .eq('id', tokenId)
      .maybeSingle();
    if (token) {
      visitType = token.type || visitType;
      if (token.table_number != null) tableNumber = String(token.table_number);
    }
  }

  const isTakeaway = visitType === 'takeaway';
  const isDineIn   = !isTakeaway && (visitType === 'dinein' || visitType === 'large_party' || !!tableNumber);

  let contextLine = '';
  if (tokenId) contextLine = `Token *${tokenId}*`;
  if (isDineIn && tableNumber) {
    contextLine += contextLine ? ` · Table *${tableNumber}*` : `Table *${tableNumber}*`;
  } else if (isTakeaway) {
    contextLine += contextLine ? ' · Takeaway' : 'Takeaway order';
  }

  const thanksLine = isTakeaway
    ? 'Thank you for ordering with us today'
    : 'Thank you for visiting us today';

  return { contextLine, thanksLine, visitType, tableNumber, tokenId, isTakeaway, isDineIn };
}

function extractMessageText(message) {
  if (typeof message === 'string') return message.trim();
  if (!message || typeof message !== 'object') return '';

  if (message.type === 'interactive') {
    const interactive = message.interactive || {};
    if (interactive.type === 'list_reply') {
      return (interactive.list_reply?.id || interactive.list_reply?.title || '').trim();
    }
    if (interactive.type === 'button_reply') {
      return (interactive.button_reply?.id || interactive.button_reply?.title || '').trim();
    }
  }
  if (message.type === 'button') {
    return (message.button?.payload || message.button?.text || '').trim();
  }
  return (message.text?.body || '').trim();
}

function parseRating(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (RATING_MAP[raw] != null) return RATING_MAP[raw];
  const digit = raw.match(/\b([1-5])\b/);
  if (digit) return parseInt(digit[1], 10);
  const stars = raw.match(/[⭐★]/g);
  if (stars?.length) return Math.min(stars.length, 5);
  return null;
}

function aspectsPayload(record) {
  if (!record.feedback_text || !record.feedback_text.startsWith('{"aspects"')) return null;
  try {
    return JSON.parse(record.feedback_text);
  } catch {
    return null;
  }
}

/** Send step-1 rating invite (interactive list + plain-text fallback). */
async function sendFeedbackInvite(record) {
  const { contextLine, thanksLine } = await resolveVisitContext(record);
  const name = record.customer_name || 'Guest';
  const ctxSuffix = contextLine ? `\n_${contextLine}_` : '';

  const bodyText =
    `${thanksLine}${ctxSuffix}\n\n` +
    `*How was your experience?*\n\n` +
    `Tap a rating below, or reply with a number from *1* to *5*.`;

  const sent = await sendWhatsAppInteractive(
    record.customer_phone,
    {
      type: 'list',
      header: { type: 'text', text: `Hi ${name}! 😊` },
      body: { text: bodyText },
      footer: { text: 'Your feedback helps us improve 🙏' },
      action: {
        button: 'Rate your visit',
        sections: [{
          title: 'Tap to rate',
          rows: [
            { id: 'excellent',     title: '🌟 Excellent',     description: 'Everything was perfect!' },
            { id: 'good',          title: '😊 Good',          description: 'Mostly great, minor issues' },
            { id: 'average',       title: '😐 Average',       description: 'It was okay' },
            { id: 'below_average', title: '😔 Below average', description: 'Could be better' },
            { id: 'poor',          title: '😞 Poor',          description: 'Very disappointed' },
          ],
        }],
      },
    },
    record.restaurant_id,
  );

  if (!sent) {
    await sendWhatsAppMessage(
      record.customer_phone,
      `Hi ${name}! 😊\n\n${thanksLine}${ctxSuffix}\n\n` +
      `*How was your experience?*\n\n` +
      `⭐ Reply with a rating from *1 to 5*:\n` +
      `5 ⭐ — Excellent\n4 ⭐ — Good\n3 ⭐ — Average\n` +
      `2 ⭐ — Below average\n1 ⭐ — Poor`,
      record.restaurant_id,
    );
  }
}

async function sendAspectPrompt(record, rating) {
  const [aspects, prompt] = aspectsForRating(rating);
  const menuText = buildAspectMenu(aspects, prompt);

  const sent = await sendWhatsAppInteractive(
    record.customer_phone,
    {
      type: 'button',
      body: { text: menuText },
      footer: { text: 'Reply with numbers (e.g. 1 3) or type Skip' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'SKIP_ASPECTS', title: '⏭️ Skip' } },
        ],
      },
    },
    record.restaurant_id,
  );

  if (!sent) {
    await sendWhatsAppMessage(record.customer_phone, menuText, record.restaurant_id);
  }
}

async function sendCommentPrompt(record) {
  const sent = await sendWhatsAppInteractive(
    record.customer_phone,
    {
      type: 'button',
      body: {
        text: 'Any other comments for the team? 💬\n\nFeel free to type anything — or tap *Skip* to finish.',
      },
      footer: { text: 'Your feedback is always welcome 🙏' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'SKIP_COMMENT', title: '⏭️ Skip' } },
        ],
      },
    },
    record.restaurant_id,
  );

  if (!sent) {
    await sendWhatsAppMessage(
      record.customer_phone,
      'Any other comments? Type freely or reply *Skip* to finish. 🙏',
      record.restaurant_id,
    );
  }
}

async function notifyManager(record, { rating, aspects, aspectLabelsList, comment, phone }) {
  const managerPhone = process.env.MANAGER_WHATSAPP_NUMBER;
  if (!managerPhone) return;

  const { contextLine, visitType } = await resolveVisitContext(record);
  const starBar = rating ? '⭐'.repeat(rating) + ` (${rating}/5)` : 'No rating';
  const urgency = rating && rating <= 2 ? '🚨 *LOW SCORE — Immediate follow-up recommended*\n' : '';
  const aspectBlock = aspectLabelsList.length
    ? `*Highlighted:*\n${aspectLabelsList.map(l => `• ${l}`).join('\n')}\n`
    : '';
  const serviceLabel = visitType === 'takeaway' ? 'Takeaway' : visitType === 'dinein' ? 'Dine-in' : 'Visit';

  await sendWhatsAppMessage(
    managerPhone,
    `📣 *Customer Feedback*\n────────────────────\n${urgency}` +
    `Customer: *${record.customer_name}*\nPhone:    +${phone}\n` +
    `Service:  ${serviceLabel}\n` +
    (contextLine ? `Ref:      ${contextLine.replace(/\*/g, '')}\n` : '') +
    `Rating:   ${starBar}\n────────────────────\n` +
    aspectBlock +
    (comment ? `*Comment:*\n${comment}\n────────────────────\n` : '') +
    `Received: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
    record.restaurant_id,
  );
}

async function completeFeedback(record, rating, aspectIds, comment, phone) {
  const [aspects] = aspectsForRating(rating);
  const labels = aspectLabels(aspects, aspectIds);
  const summaryParts = [];
  if (labels.length) summaryParts.push(`Aspects: ${labels.join(', ')}`);
  if (comment) summaryParts.push(`Comment: ${comment}`);
  const feedbackText = summaryParts.join('\n') || null;

  await supabaseAdmin
    .from('feedback_pending')
    .update({
      feedback_rating:      rating,
      feedback_text:        feedbackText,
      feedback_received_at: new Date().toISOString(),
      manager_notified:     true,
    })
    .eq('id', record.id);

  const emoji = rating >= 4 ? '🌟' : rating === 3 ? '😐' : '😔';
  const aspectThanks = labels.length
    ? (rating >= 4
      ? `\nLoved that you enjoyed:\n${labels.map(l => `• ${l}`).join('\n')}\n`
      : `\nWe'll work on:\n${labels.map(l => `• ${l}`).join('\n')}\n`)
    : '';

  await sendWhatsAppMessage(
    record.customer_phone,
    `${emoji} Thank you for your feedback, ${record.customer_name}!\n` +
    `${aspectThanks}\nYour input helps us serve you better. See you again soon! 😊`,
    record.restaurant_id,
  );

  await notifyManager(record, {
    rating,
    aspects: aspectIds,
    aspectLabelsList: labels,
    comment,
    phone,
  });
}

/**
 * Handle an inbound WhatsApp message that may be part of the feedback flow.
 * Returns true if consumed.
 */
async function handleFeedbackReply(customerPhone, message, restaurantId) {
  try {
    if (!customerPhone || !restaurantId) return false;

    const phone = String(customerPhone).replace(/\D/g, '');
    if (!phone) return false;

    const text = extractMessageText(message);

    const { data: record } = await supabaseAdmin
      .from('feedback_pending')
      .select('*')
      .eq('customer_phone', phone)
      .eq('restaurant_id', restaurantId)
      .eq('feedback_sent', true)
      .eq('manager_notified', false)
      .order('freed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!record) return false;

    // ── Step 1: Awaiting rating ─────────────────────────────────────────────
    if (record.feedback_rating == null) {
      const rating = parseRating(text);
      if (!rating) {
        await sendWhatsAppMessage(
          phone,
          'Please tap one of the rating options above, or reply with a number from *1* to *5*. 😊',
          restaurantId,
        );
        return true;
      }

      await supabaseAdmin
        .from('feedback_pending')
        .update({ feedback_rating: rating })
        .eq('id', record.id);

      await sendAspectPrompt(record, rating);
      return true;
    }

    const rating = record.feedback_rating;
    const payload = aspectsPayload(record);

    // ── Step 2: Awaiting aspects ────────────────────────────────────────────
    if (!payload) {
      const [aspects] = aspectsForRating(rating);
      const parsed = parseAspectReply(text, aspects);
      if (parsed === null) {
        await sendWhatsAppMessage(
          phone,
          'Please reply with the numbers that apply (e.g. *1 3*) or type *Skip*. 😊',
          restaurantId,
        );
        return true;
      }

      await supabaseAdmin
        .from('feedback_pending')
        .update({ feedback_text: JSON.stringify({ aspects: parsed }) })
        .eq('id', record.id);

      await sendCommentPrompt(record);
      return true;
    }

    // ── Step 3: Awaiting comment ────────────────────────────────────────────
    const aspectIds = payload.aspects || [];
    const skipComments = ['skip_comment', 'skip', 's', 'no', 'none', ''];
    const comment = skipComments.includes(text.toLowerCase()) ? null : text.slice(0, 500);

    await completeFeedback(record, rating, aspectIds, comment, phone);
    return true;
  } catch (err) {
    console.error('[feedbackFlow:handleFeedbackReply]', err.message);
    return false;
  }
}

module.exports = {
  sendFeedbackInvite,
  handleFeedbackReply,
  resolveVisitContext,
  aspectsForRating,
};
