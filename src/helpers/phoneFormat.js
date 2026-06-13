// WhatsApp / SMS numbers — store digits-only with country code (e.g. 919876543210).

'use strict';

const NOTIFY_ROLES = ['manager', 'kitchen_staff', 'captain', 'waiter', 'owner'];

/**
 * Normalize and validate a WhatsApp number for storage / Cloud API.
 * India example: 91 + 10-digit mobile = 12 digits total.
 *
 * @returns {{ value: string } | { error: string }}
 */
function validateAndNormalizeWhatsApp(raw, { required = false } = {}) {
  const digits = String(raw || '').replace(/\D/g, '');

  if (!digits) {
    if (required) {
      return {
        error:
          'WhatsApp number is required for this role. ' +
          'Use 12 digits including country code (e.g. 919876543210).',
      };
    }
    return { value: null };
  }

  if (digits.length === 10) {
    return {
      error:
        'Enter the full number with country code (e.g. 917305362067), ' +
        'not just the 10-digit mobile number.',
    };
  }

  if (digits.length < 11 || digits.length > 15) {
    return {
      error:
        'WhatsApp number must be 11–15 digits including country code ' +
        '(e.g. 919876543210 for India).',
    };
  }

  return { value: digits };
}

function roleRequiresWhatsApp(role) {
  return NOTIFY_ROLES.includes(role);
}

module.exports = {
  NOTIFY_ROLES,
  validateAndNormalizeWhatsApp,
  roleRequiresWhatsApp,
};
