// src/middleware/internalAuth.js
// Auth for internal service-to-service and staff endpoints.

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { isValidKdsSecret, extractInternalSecret } = require('../config/internalSecret');

/** Require AUTOM8_KDS_SECRET (body, Bearer, or x-internal-secret). */
function requireKdsSecret(req, res, next) {
  if (isValidKdsSecret(extractInternalSecret(req))) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

/**
 * Allow internal secret OR Supabase JWT (WalkInForm / captain tablet).
 * Attaches req.user when JWT is used.
 */
async function requireKdsSecretOrJwt(req, res, next) {
  if (isValidKdsSecret(extractInternalSecret(req))) return next();

  const bearer = req.headers['authorization']?.split(' ')[1];
  if (bearer) {
    try {
      const { data: { user }, error } = await supabaseAdmin.auth.getUser(bearer);
      if (!error && user) {
        req.user = { sub: user.id, email: user.email };
        return next();
      }
    } catch (_) {}
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireKdsSecret, requireKdsSecretOrJwt };
