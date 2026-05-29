// ============================================================================
// src/routes/marketing.js
//
// Marketing & CRM API — bridges walk_in_tokens + orders to the dashboard.
//
// ENDPOINTS:
//   GET  /api/marketing/subscribers        — stats + segment counts
//   GET  /api/marketing/templates          — Meta WABA templates
//   POST /api/marketing/templates/create   — submit template to Meta for approval
//   POST /api/marketing/media/upload       — upload header media to Meta
//   POST /api/marketing/broadcast          — send campaign to a segment
//   GET  /api/marketing/campaigns          — campaign history
//   POST /api/marketing/ai-suggest         — AI segment + message suggestion
//   POST /api/marketing/ai-rewrite         — AI copy rewrite
//   GET  /api/restaurants/:id/waba         — WABA connection info (for WABAStrip)
//
// SETUP IN server.js:
//   1. app.use('/api/marketing', require('./src/routes/marketing'));
//   2. npm install multer  (only needed if using media/upload)
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');

// multer is used only for the media upload endpoint.
// If you don't need template headers, it's safe to remove that route.
let multer;
try { multer = require('multer'); } catch (_) { /* optional */ }
const upload = multer
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } })
  : null;

// ─── Env constants ──────────────────────────────────────────────────────────

const WA_API_URL    = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v20.0';
const WA_PHONE_ID   = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_TOKEN      = process.env.WHATSAPP_ACCESS_TOKEN;
// META_ACCESS_TOKEN is used for WABA management APIs (templates, media).
// Falls back to WA_TOKEN if not separately configured.
const META_TOKEN    = process.env.META_ACCESS_TOKEN || WA_TOKEN;
const XAI_KEY = process.env.XAI_API_KEY;

const SEGMENT_KEYS = ['all', 'recent', 'lapsed', 'takeaway', 'high_value', 'never_returned'];

// ─── Auth helper ─────────────────────────────────────────────────────────────

/**
 * Validates the Bearer token and returns { user, role, restaurantId }.
 * Returns null and writes the error response itself if auth fails.
 */
async function requireAuth(req, res) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'No token' });
    return null;
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    res.status(403).json({ error: 'Invalid token' });
    return null;
  }
  const { data: u } = await supabaseAdmin
    .from('users').select('role, restaurant_id').eq('id', user.id).single();
  if (!u) {
    res.status(403).json({ error: 'User not found' });
    return null;
  }
  return { user, role: u.role, restaurantId: u.restaurant_id };
}

// ─── WhatsApp send helpers ────────────────────────────────────────────────────

async function sendWAText(to, body) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.warn('[marketing] WA not configured — skipping send to', to);
    return;
  }
  const r = await fetch(`${WA_API_URL}/${WA_PHONE_ID}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to:   String(to),
      type: 'text',
      text: { body },
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error?.message || `WA send failed (${r.status})`);
  }
}

async function sendWATemplate(to, templateName, languageCode = 'en', components = []) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.warn('[marketing] WA not configured — skipping template send to', to);
    return;
  }
  const r = await fetch(`${WA_API_URL}/${WA_PHONE_ID}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to:   String(to),
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, components },
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error?.message || `WA template send failed (${r.status})`);
  }
}

// ─── Customer map builder ─────────────────────────────────────────────────────
//
// Aggregates walk_in_tokens + orders into a unified phone → profile map.
// This is the single source of truth for all segment calculations.
//
// Profile shape:
//   { phone, name, firstActivity, lastActivity, visitCount, takeawayCount, totalSpend }

async function buildCustomerMap(restaurantId) {
  const [{ data: tokens, error: tokErr }, { data: orders, error: ordErr }] = await Promise.all([
    supabaseAdmin
      .from('walk_in_tokens')
      .select('phone, name, type, arrived_at')
      .eq('restaurant_id', restaurantId)
      .not('phone', 'is', null),
    supabaseAdmin
      .from('orders')
      .select('customer_phone, created_at, total_amount, status')
      .eq('restaurant_id', restaurantId)
      .not('customer_phone', 'is', null),
  ]);

  if (tokErr) console.error('[marketing] walk_in_tokens query failed:', tokErr.message);
  if (ordErr) console.error('[marketing] orders query failed:', ordErr.message);

  const map = new Map(); // clean_phone → profile

  const touch = (rawPhone, { name, ts, isTakeaway = false, spend = 0 }) => {
    const phone = String(rawPhone).replace(/\D/g, '');
    if (phone.length < 10) return; // skip invalid numbers

    const p = map.get(phone) ?? {
      phone,
      name:          'Customer',
      firstActivity: null,
      lastActivity:  null,
      visitCount:    0,
      takeawayCount: 0,
      totalSpend:    0,
    };

    // Keep the most meaningful name seen for this phone
    if (name && name !== 'Guest' && name !== 'Customer') p.name = name;

    if (ts) {
      if (!p.firstActivity || ts < p.firstActivity) p.firstActivity = ts;
      if (!p.lastActivity  || ts > p.lastActivity)  p.lastActivity  = ts;
    }

    p.visitCount    += 1;
    p.takeawayCount += isTakeaway ? 1 : 0;
    p.totalSpend    += spend;

    map.set(phone, p);
  };

  for (const t of tokens ?? []) {
    touch(t.phone, {
      name:       t.name,
      ts:         t.arrived_at,
      isTakeaway: t.type === 'takeaway',
    });
  }

  for (const o of orders ?? []) {
    touch(o.customer_phone, {
      ts:    o.created_at,
      // Only count spend from completed orders
      spend: o.status === 'completed' ? (parseFloat(o.total_amount) || 0) : 0,
    });
  }

  return map;
}

// ─── Segment filter ───────────────────────────────────────────────────────────

function filterSegment(customerMap, segKey) {
  const now = Date.now();
  const DAY = 86_400_000; // ms
  const out = [];

  for (const p of customerMap.values()) {
    const lastMs  = p.lastActivity  ? new Date(p.lastActivity).getTime()  : 0;
    const firstMs = p.firstActivity ? new Date(p.firstActivity).getTime() : 0;

    // Age of last activity in days (Infinity if never seen)
    const lastDays = lastMs ? (now - lastMs) / DAY : Infinity;

    switch (segKey) {
      case 'all':
        out.push(p);
        break;
      case 'recent':
        // Active in the last 7 days
        if (lastDays <= 7) out.push(p);
        break;
      case 'lapsed':
        // Last activity was 14–30 days ago — at risk of churning
        if (lastDays >= 14 && lastDays <= 30) out.push(p);
        break;
      case 'takeaway':
        // 3+ takeaway orders — loyal regulars
        if (p.takeawayCount >= 3) out.push(p);
        break;
      case 'high_value':
        // Total completed spend > ₹500
        if (p.totalSpend >= 500) out.push(p);
        break;
      case 'never_returned':
        // Exactly one visit, more than 7 days ago
        if (p.visitCount === 1 && lastDays > 7) out.push(p);
        break;
    }
  }

  return out;
}

// ─── Stats from map ───────────────────────────────────────────────────────────

function computeStats(customerMap) {
  const now = Date.now();
  const DAY = 86_400_000;
  let newThisWeek = 0, active30d = 0;

  for (const p of customerMap.values()) {
    const firstMs = p.firstActivity ? new Date(p.firstActivity).getTime() : 0;
    const lastMs  = p.lastActivity  ? new Date(p.lastActivity).getTime()  : 0;

    // "New" = first seen within the last 7 days
    if (firstMs && (now - firstMs) / DAY <= 7) newThisWeek++;
    // "Active" = any activity in the last 30 days
    if (lastMs  && (now - lastMs)  / DAY <= 30) active30d++;
  }

  return {
    total:         customerMap.size,
    new_this_week: newThisWeek,
    active_30d:    active30d,
    opted_out:     0, // No opt-out table yet — add when you build it
  };
}

// ============================================================================
// ROUTES
// ============================================================================

// ─── GET /api/marketing/subscribers ──────────────────────────────────────────
//
// Returns:
//   { stats: { total, new_this_week, active_30d, opted_out },
//     segments: { all, recent, lapsed, takeaway, high_value, never_returned } }

router.get('/subscribers', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const map     = await buildCustomerMap(auth.restaurantId);
    const stats   = computeStats(map);
    const segments = {};

    for (const key of SEGMENT_KEYS) {
      segments[key] = filterSegment(map, key).length;
    }

    res.json({ success: true, stats, segments });
  } catch (err) {
    console.error('[marketing/subscribers]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/marketing/templates ────────────────────────────────────────────
//
// Fetches approved/pending templates from Meta WABA.
// Returns empty array if WABA isn't configured (not an error).

router.get('/templates', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { data: rest } = await supabaseAdmin
      .from('restaurants').select('waba_id').eq('id', auth.restaurantId).single();

    const wabaId = rest?.waba_id;

    if (!wabaId || !META_TOKEN) {
      // WABA not yet configured — return empty gracefully
      return res.json({ success: true, templates: [] });
    }

    const r = await fetch(
      `${WA_API_URL}/${wabaId}/message_templates` +
      `?fields=name,status,category,language,components&limit=100&access_token=${META_TOKEN}`
    );
    const data = await r.json();

    if (!r.ok || data.error) {
      console.error('[marketing/templates] Meta error:', data.error?.message);
      return res.json({ success: true, templates: [] });
    }

    res.json({ success: true, templates: data.data ?? [] });
  } catch (err) {
    console.error('[marketing/templates]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/marketing/templates/create ─────────────────────────────────────
//
// Submits a new template to Meta for approval.
// Body: { name, category, language, components }

router.post('/templates/create', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { name, category, language, components } = req.body;
    if (!name || !components)
      return res.status(400).json({ error: 'name and components are required' });

    const { data: rest } = await supabaseAdmin
      .from('restaurants').select('waba_id').eq('id', auth.restaurantId).single();
    const wabaId = rest?.waba_id;

    if (!wabaId || !META_TOKEN)
      return res.status(400).json({ error: 'WhatsApp Business Account not configured for this restaurant' });

    const r = await fetch(`${WA_API_URL}/${wabaId}/message_templates`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        category: category || 'MARKETING',
        language: language || 'en',
        components,
      }),
    });
    const data = await r.json();

    if (!r.ok || data.error)
      return res.status(400).json({ error: data.error?.message || 'Template creation failed' });

    res.json({ success: true, template: data });
  } catch (err) {
    console.error('[marketing/templates/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/marketing/media/upload ─────────────────────────────────────────
//
// Uploads a header image/video/document to Meta and returns a media handle.
// Requires: npm install multer

router.post('/media/upload', (req, res, next) => {
  if (!upload) {
    return res.status(503).json({
      error: 'multer not installed — run: npm install multer',
    });
  }
  upload.single('file')(req, res, next);
}, async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!WA_TOKEN || !WA_PHONE_ID)
      return res.status(400).json({ error: 'WhatsApp not configured' });

    const { type = 'image' } = req.body;
    const mimeMap = { image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf' };
    const mime    = req.file.mimetype || mimeMap[type] || 'application/octet-stream';

    // Node 18+ has native FormData; for older Node use form-data package
    const form = new FormData();
    form.append('file',               new Blob([req.file.buffer], { type: mime }), req.file.originalname);
    form.append('messaging_product', 'whatsapp');
    form.append('type',               mime);

    const r    = await fetch(`${WA_API_URL}/${WA_PHONE_ID}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      body: form,
    });
    const data = await r.json();

    if (!r.ok || data.error)
      return res.status(400).json({ error: data.error?.message || 'Media upload failed' });

    res.json({ success: true, handle: data.id });
  } catch (err) {
    console.error('[marketing/media/upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/marketing/broadcast ────────────────────────────────────────────
//
// Creates a campaign record, responds immediately, then sends messages async.
// Body: { name, segment, template_name?, custom_message? }
//
// Rate-limited to ~10 msg/sec to stay well under Meta's limits.

router.post('/broadcast', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { name, segment, template_name, custom_message } = req.body;

    if (!name?.trim())
      return res.status(400).json({ error: 'Campaign name is required' });
    if (!SEGMENT_KEYS.includes(segment))
      return res.status(400).json({ error: `Invalid segment. Must be one of: ${SEGMENT_KEYS.join(', ')}` });
    if (!template_name && !custom_message?.trim())
      return res.status(400).json({ error: 'Either template_name or custom_message is required' });

    // Build recipient list
    const map        = await buildCustomerMap(auth.restaurantId);
    const recipients = filterSegment(map, segment);

    if (recipients.length === 0)
      return res.status(400).json({ error: 'No recipients found for this segment' });

    // Create campaign record — status starts as 'sending'
    const { data: campaign, error: campErr } = await supabaseAdmin
      .from('broadcast_campaigns')
      .insert({
        restaurant_id:   auth.restaurantId,
        name:            name.trim(),
        segment_type:    segment,
        template_name:   template_name || null,
        recipient_count: recipients.length,
        sent_count:      0,
        failed_count:    0,
        status:          'sending',
        created_by:      auth.user.id,
      })
      .select()
      .single();

    if (campErr) throw campErr;

    // Respond immediately so the UI doesn't hang while messages send
    res.json({
      success:     true,
      campaign_id: campaign.id,
      sent_count:  recipients.length,
    });

    // ── Background send ────────────────────────────────────────────────────
    ;(async () => {
      let sent = 0, failed = 0;

      for (const customer of recipients) {
        try {
          if (template_name) {
            // Template messages work outside 24h window — no personalisation needed
            await sendWATemplate(customer.phone, template_name, 'en');
          } else {
            // Free-form: replace {{name}} placeholder
            const msg = (custom_message || '')
              .replace(/\{\{name\}\}/gi, customer.name || 'Customer');
            await sendWAText(customer.phone, msg);
          }
          sent++;
        } catch (e) {
          console.error(`[broadcast] ❌ Failed for ${customer.phone}:`, e.message);
          failed++;
        }

        // Throttle: ~10 messages/second
        await new Promise(r => setTimeout(r, 100));
      }

      // Finalise campaign record
      await supabaseAdmin
        .from('broadcast_campaigns')
        .update({
          sent_count:   sent,
          failed_count: failed,
          status:       failed === recipients.length ? 'failed' : 'completed',
          sent_at:      new Date().toISOString(),
        })
        .eq('id', campaign.id);

      console.log(
        `[broadcast] ✅ "${name}" complete — sent: ${sent}, failed: ${failed}`
      );
    })().catch(e => console.error('[broadcast] Background error:', e.message));

  } catch (err) {
    console.error('[marketing/broadcast]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/marketing/campaigns ────────────────────────────────────────────
//
// Returns last 50 campaigns in reverse-chronological order.

router.get('/campaigns', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { data, error } = await supabaseAdmin
      .from('broadcast_campaigns')
      .select('*')
      .eq('restaurant_id', auth.restaurantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ success: true, campaigns: data ?? [] });
  } catch (err) {
    console.error('[marketing/campaigns]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/marketing/ai-suggest ──────────────────────────────────────────
//
// Calls Claude to map a plain-English goal to a segment + draft message.
// Body: { goal: string }

router.post('/ai-suggest', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { goal } = req.body;
    if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });

    if (!XAI_KEY) {
      return res.status(503).json({
        error: 'AI not configured — add XAI_API_KEY to your environment',
      });
    }

    // Get live segment counts so estimated_count is accurate
    const map      = await buildCustomerMap(auth.restaurantId);
    const segCounts = {};
    for (const key of SEGMENT_KEYS) segCounts[key] = filterSegment(map, key).length;

    const systemPrompt = `You are a restaurant marketing assistant for an Indian restaurant that communicates with customers via WhatsApp.

Available customer segments:
- all           : Everyone who has ever ordered
- recent        : Active in the last 7 days
- lapsed        : Last activity was 14–30 days ago — at-risk churners
- takeaway      : 3+ takeaway orders — loyal regulars
- high_value    : Total spend above ₹500 — VIP customers
- never_returned: Ordered exactly once, more than 7 days ago — win-back targets

Given a marketing goal, respond ONLY with a valid JSON object (no markdown fences, no preamble):
{
  "segment": "<one of the keys above>",
  "reasoning": "<1–2 sentences explaining why this segment fits>",
  "suggested_message": "<a friendly WhatsApp message under 200 characters — use {{name}} for personalisation>"
}`;

    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${XAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:      'grok-3-latest',
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: `Goal: ${goal.trim()}` },
        ],
      }),
    });

    const aiData = await r.json();
    if (!r.ok) throw new Error(aiData.error?.message || 'xAI API request failed');

    const raw = aiData.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      parsed = { segment: 'lapsed', reasoning: raw, suggested_message: '' };
    }

    const seg = SEGMENT_KEYS.includes(parsed.segment) ? parsed.segment : 'lapsed';

    res.json({
      success:           true,
      segment:           seg,
      reasoning:         parsed.reasoning         || '',
      suggested_message: parsed.suggested_message || '',
      estimated_count:   segCounts[seg] ?? null,
    });
  } catch (err) {
    console.error('[marketing/ai-suggest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/marketing/ai-rewrite ──────────────────────────────────────────
//
// Rewrites a WhatsApp message body to be more engaging.
// Body: { text: string, category?: 'MARKETING' | 'UTILITY' }

router.post('/ai-rewrite', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { text, category = 'MARKETING' } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });

    if (!XAI_KEY) {
      return res.status(503).json({
        error: 'AI not configured — add XAI_API_KEY to your environment',
      });
    }

    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${XAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:      'grok-3-latest',
        max_tokens: 300,
        messages: [
          { role: 'system', content: `You are a WhatsApp marketing copy editor for an Indian restaurant. Rewrite the provided message to be more concise, warm, and engaging. Keep all {{variable}} placeholders intact. Use *bold* sparingly. Max 200 characters. Sound human, not corporate. Respond with ONLY the rewritten message — no explanation, no quotes.` },
          { role: 'user',   content: `Category: ${category}\nMessage: ${text.trim()}` },
        ],
      }),
    });

    const aiData = await r.json();
    if (!r.ok) throw new Error(aiData.error?.message || 'xAI API request failed');

    res.json({
      success:   true,
      rewritten: aiData.choices?.[0]?.message?.content?.trim() || text,
    });
  } catch (err) {
    console.error('[marketing/ai-rewrite]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/restaurants/:id/waba ────────────────────────────────────────────
//
// Called by the WABAStrip component to show the connection banner.
// Reads directly from the restaurants table — no auth needed for this
// public-facing info, but we still verify the user belongs to this restaurant.

router.get('/restaurants/:id/waba', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    // Users can only see their own restaurant's WABA info
    if (req.params.id !== auth.restaurantId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, waba_id, whatsapp_phone_number, whatsapp_display_name')
      .eq('id', auth.restaurantId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Restaurant not found' });

    res.json({
      success:                 true,
      waba_id:                 data.waba_id                ?? null,
      name:                    data.name,
      whatsapp_phone_number:   data.whatsapp_phone_number  ?? null,
      whatsapp_display_name:   data.whatsapp_display_name  ?? data.name,
    });
  } catch (err) {
    console.error('[restaurants/:id/waba]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
