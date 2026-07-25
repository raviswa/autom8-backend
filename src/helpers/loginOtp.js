'use strict';

/**
 * Platform-level WhatsApp OTP for auth (password reset / future login).
 * Uses Munafe system WABA credentials — never tenant_integrations.
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { createRecoveryCredentials } = require('./passwordReset');
const { sendPlatformWhatsAppTemplate, normalizePhoneDigits } = require('./whatsapp');

const OTP_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 3;
const MAX_ATTEMPTS = 5;
const OTP_LENGTH = 6;

const ENABLED_PURPOSES = new Set(['password_reset']); // login deferred

function getOtpPepper() {
  return (
    process.env.LOGIN_OTP_PEPPER
    || process.env.MUNAFE_SYSTEM_OTP_PEPPER
    || process.env.AUTOM8_KDS_SECRET
    || ''
  );
}

function hashOtpCode(code) {
  const pepper = getOtpPepper();
  if (!pepper) {
    throw new Error('LOGIN_OTP_PEPPER (or AUTOM8_KDS_SECRET) is not configured');
  }
  return crypto.createHmac('sha256', pepper).update(String(code)).digest('hex');
}

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

async function resolveTenantForEmployee(emp) {
  const BRAND_ROLES = ['brand_owner', 'brand_manager'];
  let tenantId = emp.restaurant_id || null;

  if (!tenantId && BRAND_ROLES.includes(emp.role) && emp.brand_id) {
    const { data: outlets } = await supabaseAdmin
      .from('tenants')
      .select('id')
      .eq('brand_id', emp.brand_id)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .limit(1);
    tenantId = outlets?.[0]?.id || null;
  }

  if (!tenantId) return null;

  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('id, contact_phone, name')
    .eq('id', tenantId)
    .maybeSingle();

  return tenant || null;
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

/**
 * Request an OTP. Always returns a generic message (no enumeration).
 * @returns {{ success: true, message: string, masked_phone?: string|null }}
 */
async function requestLoginOtp({ email, purpose = 'password_reset' }) {
  const normalized = String(email || '').trim().toLowerCase();
  const purposeNorm = String(purpose || 'password_reset').trim().toLowerCase();

  const generic = {
    success: true,
    message:
      'If an account exists for that email and a contact phone is on file, '
      + 'a WhatsApp verification code has been sent. It expires in 10 minutes.',
    masked_phone: null,
  };

  if (!normalized) {
    const err = new Error('Email is required');
    err.status = 400;
    throw err;
  }

  if (!ENABLED_PURPOSES.has(purposeNorm)) {
    const err = new Error(
      purposeNorm === 'login'
        ? 'WhatsApp OTP login is not enabled yet. Use password recovery instead.'
        : 'Invalid purpose',
    );
    err.status = 400;
    throw err;
  }

  const { data: emp } = await supabaseAdmin
    .from('employees')
    .select('id, is_active, full_name, restaurant_id, brand_id, role, email')
    .eq('email', normalized)
    .maybeSingle();

  if (!emp?.is_active) {
    return generic;
  }

  const tenant = await resolveTenantForEmployee(emp);
  const contactPhone = String(tenant?.contact_phone || '').trim();
  if (!tenant?.id || !contactPhone) {
    console.warn(`[login-otp] No contact_phone for tenant of ${normalized}`);
    return generic;
  }

  const recent = await countRecentOtpRequests(tenant.id, purposeNorm);
  if (recent >= RATE_MAX) {
    const err = new Error('Too many code requests. Please wait 15 minutes and try again.');
    err.status = 429;
    throw err;
  }

  const code = generateOtpCode();
  const codeHash = hashOtpCode(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  const e164 = toE164India(contactPhone);

  const { error: insertErr } = await supabaseAdmin.from('login_otp_codes').insert({
    tenant_id: tenant.id,
    phone: contactPhone,
    code_hash: codeHash,
    purpose: purposeNorm,
    expires_at: expiresAt,
  });
  if (insertErr) {
    console.error('[login-otp] insert failed:', insertErr.message);
    const err = new Error('Could not send verification code. Please try again later.');
    err.status = 500;
    throw err;
  }

  const sent = await sendPlatformWhatsAppTemplate(e164 || contactPhone, {
    bodyParams: [code],
    buttonParams: [code],
  });

  if (!sent) {
    console.warn(`[login-otp] Platform WhatsApp send failed for tenant ${tenant.id}`);
    // Still return generic — do not leak send failures as enumeration
  }

  const digits = normalizePhoneDigits(contactPhone);
  const masked = digits.length >= 4
    ? `******${digits.slice(-4)}`
    : null;

  return { ...generic, masked_phone: masked };
}

/**
 * Verify OTP. On password_reset success, returns recovery token_hash for ResetPasswordPage.
 */
async function verifyLoginOtp({ email, code, purpose = 'password_reset', redirectTo = null }) {
  const normalized = String(email || '').trim().toLowerCase();
  const purposeNorm = String(purpose || 'password_reset').trim().toLowerCase();
  const codeStr = String(code || '').trim().replace(/\s+/g, '');

  if (!normalized || !codeStr) {
    const err = new Error('Email and code are required');
    err.status = 400;
    throw err;
  }

  if (!ENABLED_PURPOSES.has(purposeNorm)) {
    const err = new Error(
      purposeNorm === 'login'
        ? 'WhatsApp OTP login is not enabled yet.'
        : 'Invalid purpose',
    );
    err.status = 400;
    throw err;
  }

  const { data: emp } = await supabaseAdmin
    .from('employees')
    .select('id, is_active, restaurant_id, brand_id, role, email')
    .eq('email', normalized)
    .maybeSingle();

  if (!emp?.is_active) {
    const err = new Error('Invalid or expired code');
    err.status = 400;
    throw err;
  }

  const tenant = await resolveTenantForEmployee(emp);
  if (!tenant?.id) {
    const err = new Error('Invalid or expired code');
    err.status = 400;
    throw err;
  }

  const { data: rows, error: findErr } = await supabaseAdmin
    .from('login_otp_codes')
    .select('id, code_hash, expires_at, consumed_at, attempt_count')
    .eq('tenant_id', tenant.id)
    .eq('purpose', purposeNorm)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (findErr) throw findErr;
  const row = rows?.[0];
  if (!row) {
    const err = new Error('Invalid or expired code');
    err.status = 400;
    throw err;
  }

  if (row.attempt_count >= MAX_ATTEMPTS) {
    const err = new Error('Too many incorrect attempts. Request a new code.');
    err.status = 429;
    throw err;
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    const err = new Error('Invalid or expired code');
    err.status = 400;
    throw err;
  }

  let expectedHash;
  try {
    expectedHash = hashOtpCode(codeStr);
  } catch (e) {
    const err = new Error('OTP verification is not configured');
    err.status = 500;
    throw err;
  }

  if (!codesMatch(row.code_hash, expectedHash)) {
    await supabaseAdmin
      .from('login_otp_codes')
      .update({ attempt_count: (row.attempt_count || 0) + 1 })
      .eq('id', row.id);
    const err = new Error('Invalid or expired code');
    err.status = 400;
    throw err;
  }

  await supabaseAdmin
    .from('login_otp_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id);

  if (purposeNorm === 'password_reset') {
    const creds = await createRecoveryCredentials(normalized, redirectTo);
    const tokenHash = creds.hashedToken;
    if (!tokenHash) {
      const err = new Error('Could not create password reset session');
      err.status = 500;
      throw err;
    }
    return {
      success: true,
      purpose: purposeNorm,
      token_hash: tokenHash,
      type: 'recovery',
      reset_url: creds.directLink || null,
    };
  }

  const err = new Error('Unsupported purpose');
  err.status = 400;
  throw err;
}

module.exports = {
  requestLoginOtp,
  verifyLoginOtp,
  hashOtpCode,
  ENABLED_PURPOSES,
};
