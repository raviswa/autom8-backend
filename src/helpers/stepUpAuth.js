'use strict';

/**
 * Authenticated WhatsApp OTP step-up for sensitive actions.
 * Platform WABA → actor personal phone (never business WABA number).
 * After verify, mints a single-use purpose-bound step-up token.
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { sendPlatformWhatsAppTemplate, normalizePhoneDigits } = require('./whatsapp');
const { hashOtpCode } = require('./loginOtp');

const OTP_TTL_MS = 10 * 60 * 1000;
const STEPUP_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 3;
const MAX_ATTEMPTS = 5;
const OTP_LENGTH = 6;

const STEPUP_PURPOSES = new Set([
  'delete_account',
  'whatsapp_bind',
  'instagram_bind',
  'change_owner_phone_old',
  'change_owner_phone_new',
  'change_owner_email',
  'change_manager_phone',
  'staff_terminate',
  'staff_elevate',
  'staff_password_reset',
]);

function codesMatch(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function generateOtpCode() {
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, '0');
}

function toE164India(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  if (digits.startsWith('91') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 11) return `91${digits.slice(1)}`;
  return digits;
}

function normalizePhoneKey(phone) {
  return normalizePhoneDigits(phone) || String(phone || '').replace(/\D/g, '');
}

function maskPhone(phone) {
  const digits = normalizePhoneKey(phone);
  return digits.length >= 4 ? `******${digits.slice(-4)}` : null;
}

function getStepUpPepper() {
  return (
    process.env.LOGIN_OTP_PEPPER
    || process.env.MUNAFE_SYSTEM_OTP_PEPPER
    || process.env.AUTOM8_KDS_SECRET
    || ''
  );
}

function hashStepUpToken(raw) {
  const pepper = getStepUpPepper();
  if (!pepper) {
    throw new Error('LOGIN_OTP_PEPPER (or AUTOM8_KDS_SECRET) is not configured');
  }
  return crypto.createHmac('sha256', pepper).update(String(raw)).digest('hex');
}

function mintRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function countRecentOtpRequests(tenantId, purpose) {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count, error } = await supabaseAdmin
    .from('login_otp_codes')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('purpose', purpose)
    .gte('created_at', since);
  if (error) throw error;
  return count ?? 0;
}

async function loadActor(userId) {
  const { data: emp, error } = await supabaseAdmin
    .from('employees')
    .select('id, is_active, phone, email, role, restaurant_id, brand_id, full_name')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!emp?.is_active) throw httpError('Your account has been deactivated.', 403);
  return emp;
}

/**
 * @param {{ userId: string, tenantId: string, purpose: string, destPhoneOverride?: string|null }} opts
 */
async function requestStepUpOtp({ userId, tenantId, purpose, destPhoneOverride = null }) {
  const purposeNorm = String(purpose || '').trim().toLowerCase();
  if (!STEPUP_PURPOSES.has(purposeNorm)) {
    throw httpError('Invalid step-up purpose');
  }
  if (!tenantId) throw httpError('No outlet context', 400);

  const emp = await loadActor(userId);
  let destPhone;

  if (purposeNorm === 'change_owner_phone_new') {
    destPhone = String(destPhoneOverride || '').trim();
    if (!destPhone || normalizePhoneKey(destPhone).length < 10) {
      throw httpError('Enter a valid new WhatsApp number to receive the verification code.');
    }
  } else {
    destPhone = String(emp.phone || '').trim();
    if (!destPhone) {
      throw httpError(
        'Add your personal WhatsApp under Team first — step-up codes are never sent to the business WhatsApp number.',
        400,
      );
    }
  }

  const recent = await countRecentOtpRequests(tenantId, purposeNorm);
  if (recent >= RATE_MAX) {
    throw httpError('Too many code requests. Please wait 15 minutes and try again.', 429);
  }

  const code = generateOtpCode();
  const codeHash = hashOtpCode(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  const e164 = toE164India(destPhone);

  const { error: insertErr } = await supabaseAdmin.from('login_otp_codes').insert({
    tenant_id: tenantId,
    phone: destPhone,
    code_hash: codeHash,
    purpose: purposeNorm,
    expires_at: expiresAt,
  });
  if (insertErr) {
    console.error(
      `[step-up] otp insert failed purpose=${purposeNorm} tenant=${tenantId}:`,
      insertErr.message,
      insertErr.code || '',
      insertErr.details || '',
    );
    throw httpError('Could not send verification code. Please try again later.', 500);
  }

  const sent = await sendPlatformWhatsAppTemplate(e164 || destPhone, {
    bodyParams: [code],
    buttonParams: [code],
  });
  if (!sent) {
    console.warn(`[step-up] Platform WhatsApp send failed for tenant ${tenantId} purpose=${purposeNorm}`);
    throw httpError(
      'Could not send the WhatsApp verification code. Check that platform OTP WhatsApp is configured, then try again.',
      502,
    );
  }

  return {
    success: true,
    message: 'Verification code sent via WhatsApp. It expires in 10 minutes.',
    masked_phone: maskPhone(destPhone),
    purpose: purposeNorm,
  };
}

/**
 * @param {{ userId: string, tenantId: string, purpose: string, code: string, destPhoneOverride?: string|null }} opts
 */
async function verifyStepUpOtp({ userId, tenantId, purpose, code, destPhoneOverride = null }) {
  const purposeNorm = String(purpose || '').trim().toLowerCase();
  const codeStr = String(code || '').trim().replace(/\s+/g, '');
  if (!STEPUP_PURPOSES.has(purposeNorm)) throw httpError('Invalid step-up purpose');
  if (!codeStr) throw httpError('Code is required');
  if (!tenantId) throw httpError('No outlet context', 400);

  await loadActor(userId);

  const { data: rows, error: findErr } = await supabaseAdmin
    .from('login_otp_codes')
    .select('id, code_hash, expires_at, consumed_at, attempt_count, phone')
    .eq('tenant_id', tenantId)
    .eq('purpose', purposeNorm)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (findErr) throw findErr;
  const row = rows?.[0];
  if (!row) throw httpError('Invalid or expired code');

  if (row.attempt_count >= MAX_ATTEMPTS) {
    throw httpError('Too many incorrect attempts. Request a new code.', 429);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw httpError('Invalid or expired code');
  }

  if (purposeNorm === 'change_owner_phone_new') {
    const expected = normalizePhoneKey(destPhoneOverride);
    const sentTo = normalizePhoneKey(row.phone);
    if (!expected || expected !== sentTo) {
      throw httpError('Code was sent to a different number. Request a new code for the new phone.');
    }
  }

  let expectedHash;
  try {
    expectedHash = hashOtpCode(codeStr);
  } catch {
    throw httpError('OTP verification is not configured', 500);
  }

  if (!codesMatch(row.code_hash, expectedHash)) {
    await supabaseAdmin
      .from('login_otp_codes')
      .update({ attempt_count: (row.attempt_count || 0) + 1 })
      .eq('id', row.id);
    throw httpError('Invalid or expired code');
  }

  await supabaseAdmin
    .from('login_otp_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id);

  const rawToken = mintRawToken();
  const tokenHash = hashStepUpToken(rawToken);
  const expiresAt = new Date(Date.now() + STEPUP_TTL_MS).toISOString();
  const meta = {};
  if (purposeNorm === 'change_owner_phone_new') {
    meta.new_phone = normalizePhoneKey(destPhoneOverride || row.phone);
  }

  const { error: tokErr } = await supabaseAdmin.from('auth_stepup_tokens').insert({
    user_id: userId,
    tenant_id: tenantId,
    purpose: purposeNorm,
    token_hash: tokenHash,
    meta,
    expires_at: expiresAt,
  });
  if (tokErr) {
    console.error('[step-up] token insert failed:', tokErr.message);
    throw httpError('Could not create step-up token. Please try again.', 500);
  }

  return {
    success: true,
    step_up_token: rawToken,
    expires_at: expiresAt,
    purpose: purposeNorm,
    masked_phone: maskPhone(row.phone),
  };
}

/**
 * Consume a single-use step-up token. Throws on failure.
 * @param {{ token: string, userId: string, tenantId: string, purpose: string, metaMatch?: object }} opts
 */
async function consumeStepUpToken({ token, userId, tenantId, purpose, metaMatch = null }) {
  const purposeNorm = String(purpose || '').trim().toLowerCase();
  const raw = String(token || '').trim();
  if (!raw) throw httpError('WhatsApp verification required. Complete the OTP step first.', 403);
  if (!STEPUP_PURPOSES.has(purposeNorm)) throw httpError('Invalid step-up purpose', 500);

  let tokenHash;
  try {
    tokenHash = hashStepUpToken(raw);
  } catch {
    throw httpError('Step-up verification is not configured', 500);
  }

  const { data: row, error } = await supabaseAdmin
    .from('auth_stepup_tokens')
    .select('id, user_id, tenant_id, purpose, meta, expires_at, consumed_at')
    .eq('token_hash', tokenHash)
    .is('consumed_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!row) throw httpError('Invalid or expired verification. Request a new WhatsApp code.', 403);
  if (row.user_id !== userId) throw httpError('Invalid or expired verification.', 403);
  if (row.tenant_id !== tenantId) throw httpError('Invalid or expired verification.', 403);
  if (row.purpose !== purposeNorm) throw httpError('Verification does not match this action. Request a new code.', 403);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw httpError('Verification expired. Request a new WhatsApp code.', 403);
  }

  if (metaMatch && typeof metaMatch === 'object') {
    const meta = row.meta || {};
    for (const [k, v] of Object.entries(metaMatch)) {
      if (String(meta[k] || '') !== String(v || '')) {
        throw httpError('Verification does not match the submitted values. Request a new code.', 403);
      }
    }
  }

  const { error: updErr } = await supabaseAdmin
    .from('auth_stepup_tokens')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('consumed_at', null);
  if (updErr) throw updErr;

  return { ok: true, meta: row.meta || {} };
}

function readStepUpToken(req) {
  return (
    req.headers['x-step-up-token']
    || req.body?.step_up_token
    || null
  );
}

/**
 * Express middleware factory. Must run after authenticateToken + getRestaurantId.
 */
function requireStepUp(purpose, options = {}) {
  return async (req, res, next) => {
    try {
      const token = readStepUpToken(req);
      const metaMatch = typeof options.metaFromReq === 'function'
        ? options.metaFromReq(req)
        : (options.metaMatch || null);
      await consumeStepUpToken({
        token,
        userId: req.user.sub,
        tenantId: req.restaurant_id,
        purpose,
        metaMatch,
      });
      next();
    } catch (err) {
      const status = err.status || 403;
      return res.status(status).json({ error: err.message || 'Step-up verification required' });
    }
  };
}

/**
 * Consume without middleware (for conditional gates inside handlers).
 */
async function requireStepUpInHandler(req, purpose, metaMatch = null) {
  const token = readStepUpToken(req);
  return consumeStepUpToken({
    token,
    userId: req.user.sub,
    tenantId: req.restaurant_id,
    purpose,
    metaMatch,
  });
}

async function consumeDualOwnerPhoneTokens(req, newPhone) {
  const oldTok = req.headers['x-step-up-token-old']
    || req.body?.step_up_token_old
    || null;
  const newTok = req.headers['x-step-up-token-new']
    || req.body?.step_up_token_new
    || null;
  await consumeStepUpToken({
    token: oldTok,
    userId: req.user.sub,
    tenantId: req.restaurant_id,
    purpose: 'change_owner_phone_old',
  });
  await consumeStepUpToken({
    token: newTok,
    userId: req.user.sub,
    tenantId: req.restaurant_id,
    purpose: 'change_owner_phone_new',
    metaMatch: { new_phone: normalizePhoneKey(newPhone) },
  });
}

module.exports = {
  STEPUP_PURPOSES,
  requestStepUpOtp,
  verifyStepUpOtp,
  consumeStepUpToken,
  requireStepUp,
  requireStepUpInHandler,
  consumeDualOwnerPhoneTokens,
  readStepUpToken,
  normalizePhoneKey,
};
