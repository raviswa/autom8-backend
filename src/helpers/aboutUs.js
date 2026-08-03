'use strict';

const ABOUT_NOTE_MAX = 150;

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function yearsInBusiness(inceptionDate) {
  if (!inceptionDate) return null;
  const start = new Date(String(inceptionDate));
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  const monthDiff = now.getMonth() - start.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < start.getDate())) years -= 1;
  return years >= 0 ? years : null;
}

function normalizeHttpUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function instagramProfileUrl(handle) {
  const h = String(handle || '').trim().replace(/^@+/, '');
  if (!h || !/^[A-Za-z0-9._]+$/.test(h)) return null;
  return `https://instagram.com/${h}`;
}

/**
 * Public Contact Us payload for webcart. Returns null when the entry should be hidden.
 */
function buildAboutPayload(restaurant) {
  if (!restaurant || !restaurant.about_enabled) return null;

  const note = String(restaurant.about_note || '').trim().slice(0, ABOUT_NOTE_MAX) || null;
  const address = [
    restaurant.address_line1,
    restaurant.address_line2,
    restaurant.city,
    restaurant.state,
    restaurant.postal_code,
  ].map((p) => String(p || '').trim()).filter(Boolean).join(', ') || null;

  const mapsUrl = normalizeHttpUrl(restaurant.google_maps_url);
  const contactPhone = digitsOnly(restaurant.contact_phone || '') || null;
  const fssai = String(restaurant.fssai_license || '').trim() || null;
  const logoUrl = String(restaurant.logo_url || '').trim() || null;
  const inception = restaurant.inception_date || null;

  const socials = [];
  const seen = new Set();
  const pushSocial = (platform, url) => {
    const clean = normalizeHttpUrl(url);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    socials.push({ platform: String(platform || 'link').trim() || 'link', url: clean });
  };

  const rawLinks = Array.isArray(restaurant.social_links) ? restaurant.social_links : [];
  for (const row of rawLinks) {
    if (!row || typeof row !== 'object') continue;
    pushSocial(row.platform, row.url);
  }
  pushSocial('website', restaurant.website_url);
  pushSocial('instagram', instagramProfileUrl(restaurant.instagram_handle));

  const hasContent = !!(
    logoUrl
    || note
    || inception
    || contactPhone
    || address
    || mapsUrl
    || fssai
    || socials.length
  );
  if (!hasContent) return null;

  return {
    name: restaurant.display_name || restaurant.name || null,
    logo_url: logoUrl,
    note,
    inception_date: inception,
    years_in_business: yearsInBusiness(inception),
    contact_phone: contactPhone,
    address,
    google_maps_url: mapsUrl,
    fssai_license: fssai,
    social_links: socials,
  };
}

function normalizeSocialLinks(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const platform = String(row.platform || '').trim().slice(0, 40);
    const url = normalizeHttpUrl(row.url);
    if (!platform || !url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ platform, url });
    if (out.length >= 12) break;
  }
  return out;
}

function normalizeAboutNote(raw) {
  if (raw == null) return null;
  const note = String(raw).trim().slice(0, ABOUT_NOTE_MAX);
  return note || null;
}

function normalizeInceptionDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  // Accept YYYY-MM or YYYY-MM-DD; store as first of month when month-only.
  const ym = /^(\d{4})-(\d{2})$/.exec(s);
  if (ym) return `${ym[1]}-${ym[2]}-01`;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!ymd) return null;
  const d = new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
}

module.exports = {
  ABOUT_NOTE_MAX,
  yearsInBusiness,
  buildAboutPayload,
  normalizeSocialLinks,
  normalizeAboutNote,
  normalizeInceptionDate,
};
