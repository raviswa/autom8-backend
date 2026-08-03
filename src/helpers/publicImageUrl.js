'use strict';

/**
 * Turn common share / view links into URLs that work in <img src>.
 * Leaves already-direct http(s) image URLs unchanged.
 */
function normalizePublicImageUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;

  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();

    // Google Drive share / open → direct view
    // https://drive.google.com/file/d/FILE_ID/view?...
    // https://drive.google.com/open?id=FILE_ID
    if (host === 'drive.google.com' || host === 'docs.google.com') {
      const fileMatch = u.pathname.match(/\/file\/d\/([^/]+)/i);
      const id = fileMatch?.[1] || u.searchParams.get('id');
      if (id) return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}`;
    }

    // Dropbox share → direct
    if (host === 'www.dropbox.com' || host === 'dropbox.com') {
      u.searchParams.set('raw', '1');
      u.searchParams.delete('dl');
      return u.toString();
    }

    return s;
  } catch (_) {
    return s;
  }
}

function normalizeMenuItemImageFields(item) {
  if (!item || typeof item !== 'object') return item;
  const keys = ['image_url', 'image_url_2', 'image_url_3', 'image_url_4', 'image_url_5', 'image_link'];
  const out = { ...item };
  for (const key of keys) {
    if (out[key] != null && out[key] !== '') {
      out[key] = normalizePublicImageUrl(out[key]) || out[key];
    }
  }
  if (!out.image_url && out.image_link) out.image_url = out.image_link;
  return out;
}

module.exports = {
  normalizePublicImageUrl,
  normalizeMenuItemImageFields,
};
