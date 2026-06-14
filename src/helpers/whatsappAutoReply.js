// Detect WhatsApp Business auto-reply / away messages that should be ignored.
// Keep patterns in sync with chat/tools/auto_reply_filter.py

'use strict';

const AUTO_REPLY_RE = new RegExp(
  [
    String.raw`hi,?\s+thanks\s+for\s+contacting`,
    String.raw`thank\s+you\s+for\s+(?:contacting|reaching|your\s+message)`,
    String.raw`thanks\s+for\s+(?:contacting|reaching\s+out|your\s+message)`,
    String.raw`we(?:'ve|\s+have)\s+received\s+your\s+message`,
    String.raw`your\s+message\s+(?:has\s+been\s+)?received`,
    String.raw`appreciate\s+your\s+(?:getting\s+in\s+touch|message|contacting)`,
    String.raw`we(?:\s+will|'ll)\s+get\s+back\s+to\s+you`,
    String.raw`get\s+back\s+to\s+you\s+(?:as\s+soon\s+as\s+possible|shortly|soon)`,
    String.raw`auto[\s-]?reply`,
    String.raw`automatic(?:ally)?\s+(?:reply|response|message)`,
    String.raw`out\s+of\s+(?:office|town)`,
    String.raw`currently\s+(?:unavailable|away|busy|not\s+available)`,
    String.raw`this\s+is\s+an\s+automated\s+(?:message|response)`,
    String.raw`do\s+not\s+reply\s+to\s+this`,
    String.raw`outside\s+(?:of\s+)?(?:business|working|office)\s+hours`,
    String.raw`our\s+(?:business|working|office)\s+hours`,
    String.raw`not\s+available\s+right\s+now`,
    String.raw`away\s+from\s+(?:my|the)\s+(?:phone|desk)`,
    String.raw`message\s+is\s+important\s+to\s+us`,
    String.raw`we\s+are\s+(?:currently\s+)?closed`,
  ].join('|'),
  'i',
);

/** Lighter signals — only used together with reply-to-us context. */
const AUTO_REPLY_WEAK_RE = new RegExp(
  [
    String.raw`thank`,
    String.raw`received`,
    String.raw`contacting`,
    String.raw`get\s+back`,
    String.raw`unavailable`,
    String.raw`business\s+hours`,
    String.raw`automated`,
  ].join('|'),
  'i',
);

function normalizePhone(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

function extractText(message) {
  if (!message || typeof message !== 'object') return '';
  return (
    message.text?.body
    || message.button?.text
    || message.interactive?.list_reply?.title
    || message.interactive?.button_reply?.title
    || ''
  ).trim();
}

function isReplyToUs(message, ourPhone) {
  if (!ourPhone) return false;
  const contextFrom = message?.context?.from;
  if (!contextFrom) return false;
  const cf = normalizePhone(contextFrom);
  const op = normalizePhone(ourPhone);
  if (!cf || !op) return false;
  return cf === op || cf.endsWith(op.slice(-10)) || op.endsWith(cf.slice(-10));
}

/** Short numeric / rating replies must not be treated as auto-replies. */
function looksLikeCustomerReply(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (t.length <= 12 && /^[\d\s.,!?]+$/i.test(t)) return true;
  if (/^(excellent|good|average|poor|skip|yes|no|ok|okay|menu|help|hi)$/i.test(t)) return true;
  return false;
}

/**
 * @param {object} message — Meta WhatsApp message object
 * @param {string} [messageText] — pre-extracted body
 * @param {string} [ourPhone] — restaurant WA number for context check
 */
function isWhatsAppAutoReply(message, messageText = '', ourPhone = null) {
  if (!message || typeof message !== 'object') return false;
  if (message.system) return true;

  const msgType = message.type || '';
  if (msgType !== 'text') return false;

  const text = (messageText || extractText(message)).trim();
  if (!text) return false;
  if (looksLikeCustomerReply(text)) return false;

  if (AUTO_REPLY_RE.test(text)) return true;

  if (isReplyToUs(message, ourPhone) && AUTO_REPLY_WEAK_RE.test(text) && text.length >= 25) {
    return true;
  }

  return false;
}

module.exports = {
  isWhatsAppAutoReply,
  extractText,
  AUTO_REPLY_RE,
};
