/**
 * Shiprocket helpers — auth (API user email/password → JWT) + serviceability quotes.
 *
 * Shiprocket does NOT accept the panel password as a Bearer token.
 * Create an API User in Shiprocket → Settings → API, then POST auth/login
 * to get a JWT (valid ~10 days). We cache tokens in-memory by email.
 */

const tokenCache = new Map(); // email -> { token, expiresAt }

function looksLikeJwt(value) {
  const s = String(value || '').trim();
  return s.startsWith('eyJ') && s.split('.').length >= 3;
}

/**
 * Resolve a Bearer token from either a JWT or API-user email+password.
 */
async function resolveShiprocketToken({ email, password, apiKey }) {
  const jwtCandidate = String(apiKey || password || '').trim();
  if (looksLikeJwt(jwtCandidate) && !email) {
    return { token: jwtCandidate, error: null };
  }

  const userEmail = String(email || '').trim().toLowerCase();
  const userPassword = String(password || apiKey || '').trim();

  if (!userEmail || !userPassword) {
    return {
      token: null,
      error: 'Add Shiprocket API User email and password (Settings → API → Create API User), not a panel password.',
    };
  }

  const cached = tokenCache.get(userEmail);
  if (cached?.token && cached.expiresAt > Date.now() + 60_000) {
    return { token: cached.token, error: null };
  }

  try {
    const loginRes = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userEmail, password: userPassword }),
    });
    const loginData = await loginRes.json().catch(() => ({}));
    if (!loginRes.ok || !loginData?.token) {
      const msg = loginData?.message
        || (loginRes.status === 401
          ? 'Shiprocket login failed (401) — check API User email/password from Shiprocket Settings → API.'
          : `Shiprocket login error ${loginRes.status}`);
      return { token: null, error: msg };
    }

    // Tokens last ~10 days; refresh a day early
    const expiresAt = Date.now() + (9 * 24 * 60 * 60 * 1000);
    tokenCache.set(userEmail, { token: loginData.token, expiresAt });
    return { token: loginData.token, error: null };
  } catch (err) {
    return { token: null, error: err.message || 'Shiprocket login request failed.' };
  }
}

async function fetchShiprocketCourierOptions({
  apiKey,
  email,
  password,
  pickupPincode,
  deliveryPincode,
  weightKg = 0.5,
  limit = 5,
}) {
  if (!pickupPincode || !deliveryPincode) {
    return { cheapest: null, couriers: [], error: 'Missing pickup or delivery pincode.' };
  }

  const auth = await resolveShiprocketToken({ email, password, apiKey });
  if (!auth.token) {
    return { cheapest: null, couriers: [], error: auth.error || 'Shiprocket auth failed.' };
  }

  const weight = Math.max(0.01, Number(weightKg) || 0.5);
  try {
    const url = new URL('https://apiv2.shiprocket.in/v1/external/courier/serviceability/');
    url.searchParams.set('pickup_postcode', pickupPincode);
    url.searchParams.set('delivery_postcode', deliveryPincode);
    url.searchParams.set('weight', String(weight));
    url.searchParams.set('cod', '0');

    const rateRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    const data = await rateRes.json().catch(() => ({}));
    if (!rateRes.ok) {
      // Stale JWT — clear cache and surface a clear message
      if (rateRes.status === 401 && email) {
        tokenCache.delete(String(email).trim().toLowerCase());
      }
      const message = data?.message
        || (rateRes.status === 401
          ? 'Shiprocket 401 — token invalid. Re-save API User email/password and try again.'
          : `Shiprocket error ${rateRes.status}`);
      return { cheapest: null, couriers: [], error: message };
    }

    const raw = data?.data?.available_courier_companies || data?.data || [];
    const list = Array.isArray(raw) ? raw : [];
    const couriers = list
      .map((row) => ({
        name: String(row.courier_name || row.courier_company || row.name || 'Courier').trim(),
        rate: Number(row.rate || row.freight_charge || row.charge || 0),
        etd: row.etd || row.estimated_delivery_days || null,
      }))
      .filter((row) => row.rate > 0)
      .sort((a, b) => a.rate - b.rate)
      .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));

    return {
      cheapest: couriers.length ? couriers[0].rate : null,
      couriers,
      error: couriers.length ? null : 'No couriers available for this route/weight.',
    };
  } catch (err) {
    return { cheapest: null, couriers: [], error: err.message || 'Shiprocket request failed.' };
  }
}

async function fetchShiprocketCheapestRate(opts) {
  const result = await fetchShiprocketCourierOptions(opts);
  return result.cheapest;
}

module.exports = {
  resolveShiprocketToken,
  fetchShiprocketCourierOptions,
  fetchShiprocketCheapestRate,
};
