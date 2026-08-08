'use strict';

/**
 * Facebook Login for Business — Instagram Content Publishing connect.
 * Separate from WhatsApp Embedded Signup (which cannot grant IG scopes).
 *
 * Env:
 *   META_APP_ID / META_APP_SECRET (required)
 *   META_GRAPH_VERSION (default v21.0)
 *   META_INSTAGRAM_OAUTH_REDIRECT_URI — must match Meta app Valid OAuth Redirect URIs
 *     (default: {API_PUBLIC_URL}/api/instagram/oauth/callback)
 *   API_PUBLIC_URL — e.g. https://api.autom8.works
 *   APP_FRONTEND_URL — Settings return base, e.g. https://app.autom8.works
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { upsertInstagramIntegration } = require('./tenantIntegrations');
const { invalidateRestaurantConfigCache } = require('./restaurantConfig');

const GRAPH_VERSION = () => process.env.META_GRAPH_VERSION || 'v21.0';
const STATE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const IG_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
].join(',');

/** @type {Map<string, { pages: object[], userLongLivedToken: string, expiresAt: number }>} */
const pendingByRestaurant = new Map();

function graphBase() {
  return `https://graph.facebook.com/${GRAPH_VERSION()}`;
}

function httpError(message, status = 400, code = null) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function appId() {
  return String(process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '').trim();
}

function appSecret() {
  return String(process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '').trim();
}

function stateSecret() {
  return appSecret() || String(process.env.AUTOM8_KDS_SECRET || '').trim();
}

function getOAuthRedirectUri() {
  const explicit = String(process.env.META_INSTAGRAM_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const apiBase = String(process.env.API_PUBLIC_URL || process.env.PUBLIC_API_URL || '').trim().replace(/\/$/, '');
  if (apiBase) return `${apiBase}/api/instagram/oauth/callback`;
  return '';
}

function getSettingsReturnBase() {
  return String(process.env.APP_FRONTEND_URL || 'https://app.autom8.works').trim().replace(/\/$/, '');
}

function isInstagramOAuthConfigured() {
  return Boolean(appId() && appSecret() && getOAuthRedirectUri());
}

function buildSettingsRedirect(query = {}) {
  const url = new URL(`${getSettingsReturnBase()}/settings`);
  url.searchParams.set('tab', 'business');
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function graphGet(path, params = {}) {
  const url = new URL(`${graphBase()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || `Graph GET ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status >= 400 ? res.status : 502;
    err.graph = data?.error;
    throw err;
  }
  return data;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signOAuthState({ restaurantId, nonce, exp }) {
  const secret = stateSecret();
  if (!secret) throw httpError('OAuth state signing secret is not configured', 503, 'oauth_not_configured');
  const payload = b64url(JSON.stringify({
    restaurantId: String(restaurantId),
    nonce: String(nonce || crypto.randomBytes(8).toString('hex')),
    exp: Number(exp) || (Date.now() + STATE_TTL_MS),
  }));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyOAuthState(state) {
  const secret = stateSecret();
  if (!secret) throw httpError('OAuth state signing secret is not configured', 503, 'oauth_not_configured');
  const raw = String(state || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) throw httpError('Invalid OAuth state', 400, 'oauth_state_invalid');
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw httpError('Invalid OAuth state', 400, 'oauth_state_invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw httpError('Invalid OAuth state', 400, 'oauth_state_invalid');
  }
  if (!parsed?.restaurantId || !parsed?.exp || Number(parsed.exp) < Date.now()) {
    throw httpError('OAuth state expired — please connect Instagram again', 400, 'oauth_state_invalid');
  }
  return { restaurantId: String(parsed.restaurantId), nonce: parsed.nonce, exp: Number(parsed.exp) };
}

function prunePending() {
  const now = Date.now();
  for (const [id, row] of pendingByRestaurant.entries()) {
    if (!row || row.expiresAt < now) pendingByRestaurant.delete(id);
  }
}

function storePending(restaurantId, payload) {
  prunePending();
  pendingByRestaurant.set(String(restaurantId), {
    ...payload,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

function getPending(restaurantId) {
  prunePending();
  const row = pendingByRestaurant.get(String(restaurantId));
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    pendingByRestaurant.delete(String(restaurantId));
    return null;
  }
  return row;
}

function clearPending(restaurantId) {
  pendingByRestaurant.delete(String(restaurantId));
}

function getInstagramOAuthUrl(restaurantId) {
  if (!isInstagramOAuthConfigured()) {
    throw httpError(
      'Instagram OAuth is not configured (META_APP_ID, META_APP_SECRET, META_INSTAGRAM_OAUTH_REDIRECT_URI).',
      503,
      'oauth_not_configured',
    );
  }
  if (!restaurantId) throw httpError('restaurantId is required', 400);

  const state = signOAuthState({
    restaurantId,
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Date.now() + STATE_TTL_MS,
  });
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION()}/dialog/oauth`);
  url.searchParams.set('client_id', appId());
  url.searchParams.set('redirect_uri', getOAuthRedirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', IG_SCOPES);
  return { url: url.toString(), state };
}

function normalizeHandle(username) {
  const u = String(username || '').replace(/^@/, '').trim();
  return u ? `@${u}` : '';
}

function mapIgPages(accountsData) {
  const rows = Array.isArray(accountsData?.data) ? accountsData.data : [];
  const pages = [];
  for (const page of rows) {
    const igId = page?.instagram_business_account?.id;
    if (!igId) continue;
    pages.push({
      page_id: String(page.id),
      page_name: String(page.name || page.id),
      ig_user_id: String(igId),
      page_access_token: String(page.access_token || ''),
    });
  }
  return pages;
}

/**
 * Persist Page token + IG Business Account on the tenant.
 */
async function finalizeInstagramPage(restaurantId, page) {
  const pageId = String(page?.page_id || '').trim();
  const igUserId = String(page?.ig_user_id || '').trim();
  const pageToken = String(page?.page_access_token || '').trim();
  if (!restaurantId || !pageId || !igUserId || !pageToken) {
    throw httpError('page_id, ig_user_id, and page_access_token are required', 400);
  }
  if (!/^\d{5,}$/.test(igUserId)) {
    throw httpError('Invalid Instagram Business Account id', 400, 'invalid_ig_user');
  }

  let username = '';
  try {
    const profile = await graphGet(`/${igUserId}`, {
      fields: 'username,name',
      access_token: pageToken,
    });
    username = String(profile?.username || '').replace(/^@/, '').trim();
  } catch (err) {
    console.warn('[instagram-oauth] username fetch failed:', err.message);
  }

  const connectedAt = new Date().toISOString();
  try {
    await upsertInstagramIntegration(restaurantId, {
      access_token: pageToken,
      is_active: true,
      config: {
        oauth: true,
        connected_at: connectedAt,
        page_id: pageId,
        page_name: page.page_name || null,
        ig_user_id: igUserId,
        username: username || null,
        token_type: 'page',
        instagram_basic: true,
      },
    });
  } catch (err) {
    console.error('[instagram-oauth] integration persist failed:', err.message);
    throw httpError('Could not save Instagram connection', 500, 'integration_persist_failed');
  }

  const handle = normalizeHandle(username);
  const { error: tenantErr } = await supabaseAdmin
    .from('tenants')
    .update({
      instagram_user_id: igUserId,
      ...(handle ? { instagram_handle: handle } : {}),
      updated_at: connectedAt,
    })
    .eq('id', restaurantId);
  if (tenantErr) {
    console.warn('[instagram-oauth] tenant ig fields update failed:', tenantErr.message);
  }

  try {
    invalidateRestaurantConfigCache(restaurantId);
  } catch {
    /* non-fatal */
  }

  clearPending(restaurantId);
  return {
    connected: true,
    username: username || null,
    ig_user_id: igUserId,
    page_id: pageId,
    page_name: page.page_name || null,
    instagram_handle: handle || null,
  };
}

/**
 * Exchange OAuth code → long-lived user token → discover IG Pages.
 * If multiple Pages, returns pick_required (caller stores pending).
 */
async function completeInstagramConnect(restaurantId, { code } = {}) {
  if (!isInstagramOAuthConfigured()) {
    throw httpError(
      'Instagram OAuth is not configured (META_APP_ID, META_APP_SECRET, META_INSTAGRAM_OAUTH_REDIRECT_URI).',
      503,
      'oauth_not_configured',
    );
  }
  if (!restaurantId) throw httpError('restaurantId is required', 400);
  if (!String(code || '').trim()) throw httpError('code is required', 400);

  const redirectUri = getOAuthRedirectUri();
  const shortPayload = await graphGet('/oauth/access_token', {
    client_id: appId(),
    client_secret: appSecret(),
    redirect_uri: redirectUri,
    code: String(code).trim(),
  });
  const shortToken = shortPayload.access_token;
  if (!shortToken) {
    throw httpError('Meta did not return an access_token for the OAuth code', 502);
  }

  const longPayload = await graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId(),
    client_secret: appSecret(),
    fb_exchange_token: shortToken,
  });
  const userLongLivedToken = longPayload.access_token || shortToken;

  const accounts = await graphGet('/me/accounts', {
    fields: 'id,name,access_token,instagram_business_account',
    access_token: userLongLivedToken,
  });
  const pages = mapIgPages(accounts);

  if (pages.length === 0) {
    throw httpError(
      'No Facebook Page with a linked Instagram Professional account was found. '
      + 'Convert the Instagram account to Professional and link it to a Facebook Page, then try again.',
      400,
      'no_instagram_page',
    );
  }

  if (pages.length > 1) {
    storePending(restaurantId, {
      pages,
      userLongLivedToken,
    });
    return {
      status: 'pick_required',
      pages: pages.map((p) => ({
        page_id: p.page_id,
        page_name: p.page_name,
        ig_user_id: p.ig_user_id,
      })),
    };
  }

  const result = await finalizeInstagramPage(restaurantId, pages[0]);
  return { status: 'connected', ...result };
}

/**
 * Finish multi-page pick using pending store (or re-fetch accounts with stored user token).
 */
async function selectInstagramPage(restaurantId, pageId) {
  const want = String(pageId || '').trim();
  if (!want) throw httpError('page_id is required', 400);

  const pending = getPending(restaurantId);
  if (!pending) {
    throw httpError(
      'Instagram page selection expired — please Connect Instagram again.',
      400,
      'oauth_pending_expired',
    );
  }

  let page = (pending.pages || []).find((p) => String(p.page_id) === want);
  if (!page?.page_access_token && pending.userLongLivedToken) {
    const accounts = await graphGet('/me/accounts', {
      fields: 'id,name,access_token,instagram_business_account',
      access_token: pending.userLongLivedToken,
    });
    const pages = mapIgPages(accounts);
    page = pages.find((p) => String(p.page_id) === want);
  }
  if (!page?.page_access_token) {
    throw httpError('Selected Facebook Page was not found in your Meta account', 400, 'page_not_found');
  }

  const result = await finalizeInstagramPage(restaurantId, page);
  return { status: 'connected', ...result };
}

function listPendingPages(restaurantId) {
  const pending = getPending(restaurantId);
  if (!pending) return null;
  return (pending.pages || []).map((p) => ({
    page_id: p.page_id,
    page_name: p.page_name,
    ig_user_id: p.ig_user_id,
  }));
}

module.exports = {
  GRAPH_VERSION,
  isInstagramOAuthConfigured,
  getOAuthRedirectUri,
  getSettingsReturnBase,
  buildSettingsRedirect,
  signOAuthState,
  verifyOAuthState,
  getInstagramOAuthUrl,
  completeInstagramConnect,
  finalizeInstagramPage,
  selectInstagramPage,
  listPendingPages,
  storePending,
  getPending,
  clearPending,
};
