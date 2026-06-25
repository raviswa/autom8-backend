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
const { closeOpenFeedbackRows } = require('./feedbackDedup');
const { phoneVariants } = require('./conversationState');
const {
  classifyFeedbackIntent,
  extractInteractiveId,
  getFeedbackSubState,
  gracefullyExpireFeedback,
  isReplyWindowExpired,
  parseRating,
} = require('./feedbackIntent');

async function dismissActiveFeedback(restaurantId, phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return;

  const { error } = await supabaseAdmin
    .from('feedback_pending')
    .update({
      manager_notified: true,
      feedback_received_at: new Date().toISOString(),
      feedback_text: 'dismissed:user_reset',
    })
    .eq('restaurant_id', restaurantId)
    .in('customer_phone', variants)
    .eq('feedback_sent', true)
    .eq('manager_notified', false);
  if (error) throw error;
}

async function findOpenFeedbackRecord(restaurantId, phone) {
  for (const variant of phoneVariants(phone)) {
    const { data } = await supabaseAdmin
      .from('feedback_pending')
      .select('*')
      .eq('customer_phone', variant)
      .eq('restaurant_id', restaurantId)
      .eq('feedback_sent', true)
      .eq('manager_notified', false)
      .order('freed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

async function closeAllStaleFeedbackInvites(restaurantId, phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return;

  await supabaseAdmin
    .from('feedback_pending')
    .update({
      manager_notified: true,
      feedback_received_at: new Date().toISOString(),
    })
    .eq('restaurant_id', restaurantId)
    .in('customer_phone', variants)
    .eq('feedback_sent', true)
    .eq('manager_notified', false);
}

const RESET_KEYWORDS = new Set([
  'home', 'menu', 'main menu', 'mainmenu', 'restart', 'start over', 'startover',
  'reboot', 'new', 'begin',
]);

function isResetKeyword(text) {
  return RESET_KEYWORDS.has(String(text || '').trim().toLowerCase());
}
const { sendWhatsAppMessage, sendWhatsAppInteractive } = require('./whatsapp');
const { isWhatsAppAutoReply } = require('./whatsappAutoReply');

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
  const t = String(text || '').trim().toLowerCase().replace(/^⏭️\s*/, '');
  if (['skip', 's', 'none', 'no', 'done', 'ok', 'okay', 'skip_aspects', 'skip_comment'].includes(t)) {
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

  if (sent) return true;

  return sendWhatsAppMessage(
    record.customer_phone,
    `Hi ${name}! 😊\n\n${thanksLine}${ctxSuffix}\n\n` +
    `*How was your experience?*\n\n` +
    `⭐ Reply with a rating from *1 to 5*:\n` +
    `5 ⭐ — Excellent\n4 ⭐ — Good\n3 ⭐ — Average\n` +
    `2 ⭐ — Below average\n1 ⭐ — Poor`,
    record.restaurant_id,
  );
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
  const { sendOperationalAlerts } = require('./operationalAlerts');
  const { getOperationalAlertPhones } = require('./restaurantConfig');
  const phones = await getOperationalAlertPhones(record.restaurant_id);
  if (!phones.length) return;

  const { contextLine, visitType } = await resolveVisitContext(record);
  const starBar = rating ? '⭐'.repeat(rating) + ` (${rating}/5)` : 'No rating';
  const urgency = rating && rating <= 2 ? '🚨 *LOW SCORE — Immediate follow-up recommended*\n' : '';
  const aspectBlock = aspectLabelsList.length
    ? `*Highlighted:*\n${aspectLabelsList.map(l => `• ${l}`).join('\n')}\n`
    : '';
  const serviceLabel = visitType === 'takeaway' ? 'Takeaway' : visitType === 'dinein' ? 'Dine-in' : 'Visit';

  await sendOperationalAlerts(
    record.restaurant_id,
    `📣 *Customer Feedback*\n────────────────────\n${urgency}` +
    `Customer: *${record.customer_name}*\nPhone:    +${phone}\n` +
    `Service:  ${serviceLabel}\n` +
    (contextLine ? `Ref:      ${contextLine.replace(/\*/g, '')}\n` : '') +
    `Rating:   ${starBar}\n────────────────────\n` +
    aspectBlock +
    (comment ? `*Comment:*\n${comment}\n────────────────────\n` : '') +
    `Received: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
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

  const { syncConversationForFeedbackComplete } = require('./conversationState');
  await syncConversationForFeedbackComplete({
    restaurantId: record.restaurant_id,
    customerPhone: record.customer_phone,
  }).catch(() => {});

  // Close any duplicate open invites (e.g. auto-release + token-complete rows).
  await closeAllStaleFeedbackInvites(record.restaurant_id, phone).catch(() => {});
}

/**
 * Handle an inbound WhatsApp message that may be part of the feedback flow.
 * Returns { consumed, completed }.
 */
async function handleFeedbackReply(customerPhone, message, restaurantId) {
  const none = { consumed: false, completed: false };
  const partial = { consumed: true, completed: false };
  try {
    if (!customerPhone || !restaurantId) return none;

    const phone = String(customerPhone).replace(/\D/g, '');
    if (!phone) return none;

    const text = extractMessageText(message);
    const interactiveId = extractInteractiveId(message);

    if (isResetKeyword(text)) {
      await dismissActiveFeedback(restaurantId, phone).catch(() => {});
      await closeOpenFeedbackRows(restaurantId, phone).catch(() => {});
      return none;
    }

    if (isWhatsAppAutoReply(message, text, process.env.WHATSAPP_PHONE_NUMBER || null)) {
      return none;
    }

    const record = await findOpenFeedbackRecord(restaurantId, phone);

    if (!record) return none;

    if (isReplyWindowExpired(record)) {
      await gracefullyExpireFeedback(record, 'expired:window');
      return none;
    }

    const subState = getFeedbackSubState(record, aspectsPayload);
    const classification = classifyFeedbackIntent({ text, message, subState });

    if (classification.abandon_feedback_flow) {
      await gracefullyExpireFeedback(
        record,
        `abandoned:${classification.intent}`,
      );
      return none;
    }

    const action = classification.feedback_action;

    // ── Step 1: Rating ───────────────────────────────────────────────────────
    if (record.feedback_rating == null) {
      if (action === 'skip') {
        await gracefullyExpireFeedback(record, 'abandoned:skip');
        return none;
      }
      if (action !== 'rating') return none;

      const rating = parseRating(interactiveId || text);
      if (!rating) return none;

      await supabaseAdmin
        .from('feedback_pending')
        .update({ feedback_rating: rating })
        .eq('id', record.id);

      await sendAspectPrompt(record, rating);
      return partial;
    }

    const rating = record.feedback_rating;
    const payload = aspectsPayload(record);

    // ── Step 2: Tags / aspects ───────────────────────────────────────────────
    if (!payload) {
      if (action === 'skip') {
        await supabaseAdmin
          .from('feedback_pending')
          .update({ feedback_text: JSON.stringify({ aspects: [] }) })
          .eq('id', record.id);
        await sendCommentPrompt(record);
        return partial;
      }
      if (action !== 'tags') return none;

      const [aspects] = aspectsForRating(rating);
      const parsed = parseAspectReply(text, aspects);
      if (parsed === null) return none;

      await supabaseAdmin
        .from('feedback_pending')
        .update({ feedback_text: JSON.stringify({ aspects: parsed }) })
        .eq('id', record.id);

      await sendCommentPrompt(record);
      return partial;
    }

    // ── Step 3: Comment ───────────────────────────────────────────────────────
    if (action !== 'comment' && action !== 'skip') return none;

    const aspectIds = payload.aspects || [];
    const skipComments = ['skip_comment', 'skip', 's', 'no', 'none', ''];
    const normalized = text.toLowerCase().replace(/^⏭️\s*/, '');
    const comment =
      action === 'skip' || skipComments.includes(normalized)
        ? null
        : text.slice(0, 500);

    await completeFeedback(record, rating, aspectIds, comment, phone);
    return { consumed: true, completed: true };
  } catch (err) {
    console.error('[feedbackFlow:handleFeedbackReply]', err.message);
    return none;
  }
}

module.exports = {
  sendFeedbackInvite,
  handleFeedbackReply,
  dismissActiveFeedback,
  resolveVisitContext,
  aspectsForRating,
};
