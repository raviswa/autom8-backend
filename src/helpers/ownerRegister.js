'use strict';

/**
 * Email-first merchant registration: Auth user + shell tenant + owner employee.
 */

const { randomUUID } = require('crypto');
const { supabase, supabaseAdmin } = require('../config/supabase');
const { ensureRestaurantSubscription, DEFAULT_SERVICES } = require('./subscriptionBilling');
const { recordActivationEvent } = require('./tenantActivation');

const APP_SIGNUP_URL = (
  process.env.FRONTEND_URL || 'https://app.autom8.works'
).replace(/\/$/, '') + '/signup';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Create shell tenant + owner session for email-first signup.
 * @returns {{ token, refreshToken, user, restaurant_id }}
 */
async function registerOwnerWithShellTenant({ email, password, full_name }) {
  const emailNorm = normalizeEmail(email);
  const name = String(full_name || '').trim();
  const pass = String(password || '');

  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    const err = new Error('A valid email is required');
    err.status = 400;
    throw err;
  }
  if (!name) {
    const err = new Error('Full name is required');
    err.status = 400;
    throw err;
  }
  if (pass.length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.status = 400;
    throw err;
  }

  const { data: existingEmp } = await supabaseAdmin
    .from('employees')
    .select('id, role')
    .eq('email', emailNorm)
    .maybeSingle();
  if (existingEmp) {
    const err = new Error('You already have an account — please log in');
    err.status = 409;
    err.code = 'existing_owner';
    err.login_url = (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '') + '/login';
    throw err;
  }

  const pendingSlug = `pending-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const displayName = `${name.split(/\s+/)[0]}'s store`;

  let restaurantId = null;
  let authUserId = null;

  try {
    const shellBase = {
      name: displayName,
      display_name: displayName,
      email: emailNorm,
      slug: pendingSlug,
      timezone: 'Asia/Kolkata',
      payment_mode: 'prepay',
      is_active: true,
      lob_type: 'retail',
      lifecycle_status: 'onboarding',
      onboarding_step: 0,
      subscribed_features: DEFAULT_SERVICES,
      payment_provider: 'phonepe',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    let { data: restaurant, error: restError } = await supabaseAdmin
      .from('tenants')
      .insert(shellBase)
      .select('id, name, display_name, lob_type, lifecycle_status, onboarding_step, slug')
      .single();

    // Older DBs may lack lifecycle columns — retry without them.
    if (restError && /lifecycle_status|onboarding_step|payment_provider|slug/i.test(restError.message || '')) {
      const fallback = { ...shellBase };
      if (/lifecycle_status/i.test(restError.message || '')) delete fallback.lifecycle_status;
      if (/onboarding_step/i.test(restError.message || '')) delete fallback.onboarding_step;
      if (/payment_provider/i.test(restError.message || '')) delete fallback.payment_provider;
      if (/slug/i.test(restError.message || '')) delete fallback.slug;
      ({ data: restaurant, error: restError } = await supabaseAdmin
        .from('tenants')
        .insert(fallback)
        .select('id, name, display_name, lob_type')
        .single());
    }
    if (restError) throw restError;
    restaurantId = restaurant.id;

    await ensureRestaurantSubscription(supabaseAdmin, restaurantId, {
      enabledServices: DEFAULT_SERVICES,
    });

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: emailNorm,
      password: pass,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (authError) throw authError;
    authUserId = authData.user.id;

    const { data: emp, error: empError } = await supabaseAdmin
      .from('employees')
      .insert({
        id: authUserId,
        restaurant_id: restaurantId,
        email: emailNorm,
        full_name: name,
        role: 'owner',
        is_active: true,
        hired_at: new Date().toISOString(),
      })
      .select('*')
      .single();
    if (empError) throw empError;

    // Establish session (same as login)
    const { data: sessionData, error: signInError } = await supabase.auth.signInWithPassword({
      email: emailNorm,
      password: pass,
    });
    if (signInError) throw signInError;

    recordActivationEvent(restaurantId, 'trial_started', { source: 'email_register' }).catch(() => {});

    const user = {
      ...emp,
      restaurant_id: restaurantId,
      restaurant_name: restaurant.display_name || restaurant.name,
      lob_type: restaurant.lob_type || 'retail',
      lifecycle_status: restaurant.lifecycle_status || 'onboarding',
      onboarding_step: restaurant.onboarding_step ?? 0,
      scope: 'outlet',
      brand: undefined,
      outlets: undefined,
    };

    return {
      success: true,
      token: sessionData.session.access_token,
      refreshToken: sessionData.session.refresh_token,
      user,
      restaurant_id: restaurantId,
    };
  } catch (err) {
    // Best-effort rollback
    try {
      if (authUserId) await supabaseAdmin.auth.admin.deleteUser(authUserId);
    } catch (_) { /* ignore */ }
    try {
      if (restaurantId) {
        await supabaseAdmin.from('tenant_subscriptions').delete().eq('restaurant_id', restaurantId);
        await supabaseAdmin.from('tenants').delete().eq('id', restaurantId);
      }
    } catch (_) { /* ignore */ }
    throw err;
  }
}

module.exports = {
  registerOwnerWithShellTenant,
  APP_SIGNUP_URL,
  normalizeEmail,
};
