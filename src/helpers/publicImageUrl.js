'use strict';

/**
 * Turn common share / view links into URLs that work in <img src>.
 * Leaves already-direct http(s) image URLs unchanged (sync transforms only).
 */
function normalizePublicImageUrl(raw) {
  const rawStr = String(raw || '');
  const s = rawStr.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;

  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    // #region agent log
    try {
      const fs = require('fs');
      const path = require('path');
      const logPath = path.join(__dirname, '..', '..', '..', 'debug-6ce792.log');
      fs.appendFileSync(logPath, `${JSON.stringify({
        sessionId: '6ce792',
        hypothesisId: 'H1_H3',
        location: 'publicImageUrl.js:normalizePublicImageUrl',
        message: 'normalize image url',
        data: {
          host,
          hasWhitespace: /\s/.test(rawStr),
          rawLen: rawStr.length,
          trimmedLen: s.length,
          pathPrefix: u.pathname.slice(0, 40),
        },
        timestamp: Date.now(),
      })}\n`);
    } catch (_) { /* ignore debug log failures */ }
    // #endregion

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

function extractOgImage(html) {
  const text = String(html || '');
  const patterns = [
    /property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    /name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1] && /^https?:\/\//i.test(m[1])) return m[1].trim();
  }
  return null;
}

/**
 * Resolve viewer/share pages (e.g. kommodo.ai/i/…) to a direct image URL for <img src>.
 */
async function resolvePublicImageUrl(raw) {
  const base = normalizePublicImageUrl(raw);
  if (!base) return null;

  try {
    const u = new URL(base);
    const host = u.hostname.toLowerCase();
    if (host !== 'kommodo.ai' && host !== 'www.kommodo.ai') return base;

    const idMatch = u.pathname.match(/^\/([iu])\/([^/?#]+)\/?$/i);
    if (!idMatch) return base;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(base, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Autom8ImageResolver/1.0',
        },
      });
      const html = await res.text();
      const og = extractOgImage(html);
      // #region agent log
      try {
        const fs = require('fs');
        const path = require('path');
        const logPath = path.join(__dirname, '..', '..', '..', 'debug-6ce792.log');
        fs.appendFileSync(logPath, `${JSON.stringify({
          sessionId: '6ce792',
          runId: 'post-fix',
          hypothesisId: 'H1',
          location: 'publicImageUrl.js:resolvePublicImageUrl',
          message: 'kommodo resolve result',
          data: {
            status: res.status,
            contentType: String(res.headers.get('content-type') || ''),
            resolved: !!og,
            resolvedHost: og ? new URL(og).hostname : null,
            id: idMatch[2].slice(0, 12),
          },
          timestamp: Date.now(),
        })}\n`);
      } catch (_) { /* ignore */ }
      // #endregion
      if (og) return og;
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    // keep base URL — caller still stores/returns original if resolve fails
  }
  return base;
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

async function resolveMenuItemImageFields(item) {
  if (!item || typeof item !== 'object') return item;
  const keys = ['image_url', 'image_url_2', 'image_url_3', 'image_url_4', 'image_url_5', 'image_link'];
  const out = { ...item };
  await Promise.all(keys.map(async (key) => {
    if (out[key] != null && out[key] !== '') {
      out[key] = (await resolvePublicImageUrl(out[key])) || out[key];
    }
  }));
  if (!out.image_url && out.image_link) out.image_url = out.image_link;
  return out;
}

module.exports = {
  normalizePublicImageUrl,
  resolvePublicImageUrl,
  normalizeMenuItemImageFields,
  resolveMenuItemImageFields,
};
