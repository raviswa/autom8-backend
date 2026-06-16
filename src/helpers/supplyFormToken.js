'use strict';

const crypto = require('crypto');

function getSecret() {
  return process.env.SUPPLY_FORM_SECRET || process.env.AUTOM8_KDS_SECRET || 'dev-supply-form-secret';
}

function signFormToken(clientId, supplierId, expUnix) {
  const payload = `${clientId}.${supplierId}.${expUnix}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  const blob = JSON.stringify({ c: clientId, s: supplierId, e: expUnix, sig });
  return Buffer.from(blob, 'utf8').toString('base64url');
}

function verifyFormToken(token) {
  if (!token) return null;
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const data = JSON.parse(raw);
    const { c: clientId, s: supplierId, e: expUnix, sig } = data;
    if (!clientId || !supplierId || !expUnix || !sig) return null;
    const payload = `${clientId}.${supplierId}.${expUnix}`;
    const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Math.floor(Date.now() / 1000) > expUnix) return { expired: true, clientId, supplierId };
    return { clientId, supplierId, expUnix };
  } catch (_) {
    return null;
  }
}

module.exports = { signFormToken, verifyFormToken };
