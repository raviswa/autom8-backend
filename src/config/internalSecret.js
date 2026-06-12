// src/config/internalSecret.js
// Shared secret for service-to-service calls (chat → api, KDS notify, feedback queue).

'use strict';

const DEV_FALLBACK = 'munafe_kds_sync_2026';

function getKdsSecret() {
  const secret = process.env.AUTOM8_KDS_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTOM8_KDS_SECRET must be set in production. ' +
      'Configure it in Railway for both api and chat services.'
    );
  }

  console.warn('[security] AUTOM8_KDS_SECRET not set — using dev fallback');
  return DEV_FALLBACK;
}

/** Returns true if the request carries a valid internal secret. */
function isValidKdsSecret(candidate) {
  if (!candidate) return false;
  return candidate === getKdsSecret();
}

/** Extract secret from body.secret, Bearer token, or x-internal-secret header. */
function extractInternalSecret(req) {
  return (
    req.body?.secret ??
    req.headers['authorization']?.split(' ')[1] ??
    req.headers['x-internal-secret'] ??
    req.query?.secret ??
    null
  );
}

module.exports = { getKdsSecret, isValidKdsSecret, extractInternalSecret };
