// src/helpers/feedbackIntent.js
// Reply-window gate + rule-based intent classification for post-visit feedback.
// No LLM calls — threshold check runs first; ambiguous in-window messages abandon
// the flow rather than blocking normal ordering.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { phoneVariants } = require('./conversationState');

const FEEDBACK_REPLY_WINDOW_MS =
  Math.max(1, parseInt(process.env.FEEDBACK_REPLY_WINDOW_MINUTES || '15', 10)) *
  60 *
  1000;

const RESET_KEYWORDS = new Set([
  'home', 'menu', 'main menu', 'mainmenu', 'restart', 'start over', 'startover',
  'reboot', 'new', 'begin',
]);

const SERVICE_MENU_IDS = new Set([
  'dine_in', 'takeaway_now', 'takeaway_schedule', 'takeaway', 'delivery',
  'schedule_delivery', 'reserve_table', 'book_table', 'order_food',
]);

const GREETING_RE = /^(hi|hello|hey|hola|namaste|good\s+(morning|afternoon|evening)|gm|yo)\b/i;

const RATING_MAP = {
  excellent: 5, 5: 5,
  good: 4, 4: 4,
  average: 3, 3: 3,
  'below average': 2, below_average: 2, 2: 2,
  poor: 1, 1: 1,
};

const SKIP_TOKENS = new Set([
  'skip', 's', 'none', 'no', 'done', 'ok', 'okay', 'skip_aspects', 'skip_comment',
]);

const ORDER_HINT_RE =
  /\b(menu|order|idli|dosa|biryani|cart|done|catalog|takeaway|delivery|dine)\b/i;

function normalizeText(text) {
  return String(text || '').trim().toLowerCase().replace(/^⏭️\s*/, '');
}

function getReplyWindowStart(record) {
  return record.feedback_sent_at || record.freed_at || record.updated_at || null;
}

function isReplyWindowExpired(record) {
  const start = getReplyWindowStart(record);
  if (!start) return false;
  return Date.now() - new Date(start).getTime() > FEEDBACK_REPLY_WINDOW_MS;
}

/** Map feedback_pending row → sub-state name used by the classifier spec. */
function getFeedbackSubState(record, aspectsPayloadFn) {
  if (record.feedback_rating == null) return 'awaiting_feedback_rating';
  if (!aspectsPayloadFn(record)) return 'awaiting_feedback_tags';
  return 'awaiting_feedback_comment';
}

function parseRating(text) {
  const raw = normalizeText(text);
  if (RATING_MAP[raw] != null) return RATING_MAP[raw];
  if (/^\s*[1-5]\s*$/.test(raw)) return parseInt(raw, 10);
  const digit = raw.match(/\b([1-5])\b/);
  if (digit) return parseInt(digit[1], 10);
  const stars = String(text || '').match(/[⭐★]/g);
  if (stars?.length) return Math.min(stars.length, 5);
  return null;
}

function isSkipToken(text) {
  return SKIP_TOKENS.has(normalizeText(text));
}

function isTagSelection(text) {
  const t = normalizeText(text);
  if (['all', 'everything', 'all of the above'].includes(t)) return true;
  return /^[\d\s,;]+$/.test(t) && /\d/.test(t);
}

function extractInteractiveId(message) {
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
  return '';
}

/**
 * Rule-based intent classifier (spec-aligned JSON).
 * @returns {{ intent: string, feedback_action: string|null, abandon_feedback_flow: boolean }}
 */
function classifyFeedbackIntent({ text, message, subState }) {
  const raw = String(text || '').trim();
  const lower = normalizeText(raw);
  const abandon = (intent, action = null) => ({
    intent,
    feedback_action: action,
    abandon_feedback_flow: true,
  });
  const reply = (action) => ({
    intent: 'feedback_reply',
    feedback_action: action,
    abandon_feedback_flow: false,
  });

  if (message?.type === 'order') {
    return abandon('new_order');
  }

  const interactiveId = extractInteractiveId(message);
  const interactiveLower = interactiveId.toLowerCase();

  if (interactiveId) {
    if (SERVICE_MENU_IDS.has(interactiveLower)) {
      return abandon('menu_action');
    }
    if (SKIP_TOKENS.has(interactiveLower)) {
      return reply('skip');
    }
    if (subState === 'awaiting_feedback_rating' && RATING_MAP[interactiveLower] != null) {
      return reply('rating');
    }
    if (subState === 'awaiting_feedback_rating' && !RATING_MAP[interactiveLower]) {
      return abandon('menu_action');
    }
    if (subState !== 'awaiting_feedback_rating') {
      return abandon('menu_action');
    }
  }

  if (RESET_KEYWORDS.has(lower) || SERVICE_MENU_IDS.has(lower)) {
    return abandon('menu_action');
  }
  if (GREETING_RE.test(lower)) {
    return abandon('greeting');
  }
  if (isSkipToken(raw)) {
    return reply('skip');
  }

  if (subState === 'awaiting_feedback_rating') {
    if (/^[\d\s,;]+$/.test(lower) && /[\s,;]/.test(lower) && /\d/.test(lower)) {
      return abandon('other');
    }
    if (parseRating(raw) != null) return reply('rating');
    if (ORDER_HINT_RE.test(raw)) return abandon('new_order');
    return abandon('other');
  }

  if (subState === 'awaiting_feedback_tags') {
    if (isTagSelection(raw)) return reply('tags');
    if (ORDER_HINT_RE.test(raw)) return abandon('new_order');
    return abandon('other');
  }

  if (subState === 'awaiting_feedback_comment') {
    if (raw.length > 0) return reply('comment');
    return abandon('other');
  }

  return abandon('other');
}

/**
 * Mark feedback invite closed without manager alert (window expired or abandoned).
 */
async function gracefullyExpireFeedback(record, reason = 'expired:window') {
  if (!record?.id) return;

  await supabaseAdmin
    .from('feedback_pending')
    .update({
      manager_notified: true,
      feedback_received_at: new Date().toISOString(),
      feedback_text: reason,
    })
    .eq('id', record.id);

  const variants = phoneVariants(record.customer_phone);
  if (variants.length) {
    await supabaseAdmin
      .from('feedback_pending')
      .update({
        manager_notified: true,
        feedback_received_at: new Date().toISOString(),
        feedback_text: reason,
      })
      .eq('restaurant_id', record.restaurant_id)
      .in('customer_phone', variants)
      .eq('feedback_sent', true)
      .eq('manager_notified', false);
  }

  const { syncConversationForFeedbackComplete } = require('./conversationState');
  await syncConversationForFeedbackComplete({
    restaurantId: record.restaurant_id,
    customerPhone: record.customer_phone,
  }).catch(() => {});
}

module.exports = {
  FEEDBACK_REPLY_WINDOW_MS,
  classifyFeedbackIntent,
  getFeedbackSubState,
  getReplyWindowStart,
  gracefullyExpireFeedback,
  isReplyWindowExpired,
  parseRating,
  RATING_MAP,
  SERVICE_MENU_IDS,
};
