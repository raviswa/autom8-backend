// src/routes/marketing.js
// ============================================================================
// Marketing & CRM API — bridges walk_in_tokens + orders to the dashboard.
// ENDPOINTS:
//   GET  /api/marketing/subscribers        — stats + segment counts + preview name
//   GET  /api/marketing/templates          — Meta WABA templates
//   POST /api/marketing/templates/create   — submit template to Meta
//   GET  /api/marketing/template-drafts    — list saved drafts
//   POST /api/marketing/template-drafts    — save draft
//   DELETE /api/marketing/template-drafts/:id
//   POST /api/marketing/media/upload       — upload header media to Meta
//   POST /api/marketing/broadcast          — send or schedule campaign
//   GET  /api/marketing/campaigns          — campaign history + ROI
//   GET  /api/marketing/automations        — list automations
//   POST /api/marketing/automations        — create automation
//   PATCH /api/marketing/automations/:id   — toggle active
//   POST /api/marketing/ai-suggest         — AI segment + message suggestion
//   POST /api/marketing/ai-rewrite         — AI copy rewrite
//   POST /api/marketing/ai-generate        — AI template from scratch
//   GET  /api/marketing/restaurants/:id/waba — WABA connection info
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();
const { supabase, supabaseAdmin } = require('../config/supabase');
const {
  SEGMENT_KEYS,
  buildCustomerMap,
  filterSegment,
  computeStats,
  getPreviewSampleName,
  computeCampaignRoi,
  executeBroadcast,
} = require('../helpers/marketingCampaign');

let multer;
try { multer = require('multer'); } catch (_) { /* optional */ }
const upload = multer
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } })
  : null;

const WA_API_URL  = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v20.0';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const META_TOKEN  = process.env.META_ACCESS_TOKEN || WA_TOKEN;
const GROQ_KEY    = process.env.GROQ_API_KEY;

const AUTOMATION_TRIGGERS = {
  lapsed_14d:       { label: 'No order in 14 days',        segment: 'lapsed',         defaultMessage: 'Hi {{name}}, we miss you at our restaurant! 🍽️ Come back this week — we have something special waiting for you.' },
  loyalty_5th_order:{ label: 'Completed 5th order',        segment: 'high_value',     defaultMessage: 'Hi {{name}}, thank you for being a loyal guest! ⭐ Enjoy a complimentary dessert on your next visit — you\'ve earned it.' },
  first_order:      { label: 'First order completed',      segment: 'never_returned', defaultMessage: 'Hi {{name}}, welcome! 👋 Thanks for your first visit. Here\'s what regulars love — ask us for today\'s chef\'s pick on your next order.' },
};

// ─── Auth helper ──────────────────────────────────────────────────────────────
async function requireAuth(req, res) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) { res.status(401).json({ error: 'No token' }); return null; }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(403).json({ error: 'Invalid token' }); return null; }
  const { data: u } = await supabaseAdmin
    .from('employees').select('role, restaurant_id').eq('id', user.id).single();
  if (!u) { res.status(403).json({ error: 'User not found' }); return null; }
  return { user, role: u.role, restaurantId: u.restaurant_id };
}

async function enrichCampaignsWithRoi(restaurantId, campaigns) {
  return Promise.all((campaigns ?? []).map(async (c) => {
    let orders48h = c.roi_orders_48h;
    let revenue48h = c.roi_revenue_48h;
    if (c.status === 'completed' && orders48h == null) {
      const roi = await computeCampaignRoi(restaurantId, c);
      orders48h = roi.orders_48h;
      revenue48h = roi.revenue_48h;
    }
    return {
      ...c,
      roi: {
        sent_to: c.sent_count ?? c.recipient_count ?? 0,
        orders_48h: orders48h ?? 0,
        revenue_48h: revenue48h ?? 0,
      },
    };
  }));
}

// ============================================================================
// ROUTES
// ============================================================================

router.get('/subscribers', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const map      = await buildCustomerMap(auth.restaurantId);
    const stats    = computeStats(map);
    const segments = {};
    for (const key of SEGMENT_KEYS) segments[key] = filterSegment(map, key).length;
    res.json({
      success: true, stats, segments,
      preview_name: getPreviewSampleName(map),
    });
  } catch (err) {
    console.error('[marketing/subscribers]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/templates', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { data: rest } = await supabaseAdmin
      .from('tenants').select('waba_id').eq('id', auth.restaurantId).single();
    const wabaId = rest?.waba_id;
    if (!wabaId || !META_TOKEN) return res.json({ success: true, templates: [] });
    const r = await fetch(
      `${WA_API_URL}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100&access_token=${META_TOKEN}`
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

router.post('/templates/create', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { name, category, language, components } = req.body;
    if (!name || !components) return res.status(400).json({ error: 'name and components are required' });
    const { data: rest } = await supabaseAdmin
      .from('tenants').select('waba_id').eq('id', auth.restaurantId).single();
    const wabaId = rest?.waba_id;
    if (!wabaId || !META_TOKEN) return res.status(400).json({ error: 'WhatsApp Business Account not configured' });
    const sanitizedComponents = (components || []).map(comp => {
      if (comp.type !== 'BUTTONS') return comp;
      return {
        ...comp,
        buttons: (comp.buttons || []).map(btn => {
          if (btn.type !== 'COPY_CODE') return btn;
          const { text, ...rest } = btn;
          return rest;
        }),
      };
    });

    const r = await fetch(`${WA_API_URL}/${wabaId}/message_templates`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category: category || 'MARKETING', language: language || 'en', components: sanitizedComponents }),
    });
    const data = await r.json();
    if (!r.ok || data.error) return res.status(400).json({ error: data.error?.message || 'Template creation failed' });
    res.json({ success: true, template: data });
  } catch (err) {
    console.error('[marketing/templates/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/template-drafts', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { data, error } = await supabaseAdmin
      .from('marketing_template_drafts')
      .select('id, name, payload, updated_at')
      .eq('restaurant_id', auth.restaurantId)
      .order('updated_at', { ascending: false })
      .limit(20);
    if (error) {
      if (error.message?.includes('marketing_template_drafts')) {
        return res.json({ success: true, drafts: [] });
      }
      throw error;
    }
    res.json({ success: true, drafts: data ?? [] });
  } catch (err) {
    console.error('[marketing/template-drafts GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/template-drafts', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { id, name, payload } = req.body;
    if (!payload) return res.status(400).json({ error: 'payload is required' });
    const row = {
      restaurant_id: auth.restaurantId,
      name: (name || 'untitled_draft').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'untitled_draft',
      payload,
      created_by: auth.user.id,
      updated_at: new Date().toISOString(),
    };
    let result;
    if (id) {
      result = await supabaseAdmin.from('marketing_template_drafts')
        .update(row).eq('id', id).eq('restaurant_id', auth.restaurantId).select().single();
    } else {
      result = await supabaseAdmin.from('marketing_template_drafts').insert(row).select().single();
    }
    if (result.error) {
      if (result.error.message?.includes('marketing_template_drafts')) {
        return res.status(503).json({ error: 'Drafts not available — run migrations/add_marketing_features.sql' });
      }
      throw result.error;
    }
    res.json({ success: true, draft: result.data });
  } catch (err) {
    console.error('[marketing/template-drafts POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/template-drafts/:id', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { error } = await supabaseAdmin
      .from('marketing_template_drafts')
      .delete()
      .eq('id', req.params.id)
      .eq('restaurant_id', auth.restaurantId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[marketing/template-drafts DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/media/upload', (req, res, next) => {
  if (!upload) return res.status(503).json({ error: 'multer not installed — run: npm install multer' });
  upload.single('file')(req, res, next);
}, async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!WA_TOKEN || !WA_PHONE_ID) return res.status(400).json({ error: 'WhatsApp not configured' });
    const { type = 'image' } = req.body;
    const mimeMap = { image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf' };
    const mime    = req.file.mimetype || mimeMap[type] || 'application/octet-stream';
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: mime }), req.file.originalname);
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    const r    = await fetch(`${WA_API_URL}/${WA_PHONE_ID}/media`, {
      method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}` }, body: form,
    });
    const data = await r.json();
    if (!r.ok || data.error) return res.status(400).json({ error: data.error?.message || 'Media upload failed' });
    res.json({ success: true, handle: data.id });
  } catch (err) {
    console.error('[marketing/media/upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/broadcast', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { name, segment, template_name, custom_message, scheduled_at } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Campaign name is required' });
    if (!SEGMENT_KEYS.includes(segment)) return res.status(400).json({ error: `Invalid segment. Must be one of: ${SEGMENT_KEYS.join(', ')}` });
    if (!template_name && !custom_message?.trim()) return res.status(400).json({ error: 'Either template_name or custom_message is required' });

    const map        = await buildCustomerMap(auth.restaurantId);
    const recipients = filterSegment(map, segment);
    if (recipients.length === 0) return res.status(400).json({ error: 'No recipients found for this segment' });

    const scheduleMs = scheduled_at ? new Date(scheduled_at).getTime() : 0;
    const isScheduled = scheduleMs > Date.now() + 60_000;

    const insertPayload = {
      restaurant_id: auth.restaurantId,
      name: name.trim(),
      segment_type: segment,
      template_name: template_name || null,
      custom_message: custom_message || null,
      recipient_count: recipients.length,
      sent_count: 0,
      failed_count: 0,
      status: isScheduled ? 'scheduled' : 'sending',
      created_by: auth.user.id,
      ...(isScheduled ? { scheduled_at: new Date(scheduleMs).toISOString() } : {}),
    };

    let campaign;
    let campErr;
    ({ data: campaign, error: campErr } = await supabaseAdmin
      .from('broadcast_campaigns').insert(insertPayload).select().single());

    if (campErr?.message?.includes('custom_message') || campErr?.message?.includes('scheduled_at')) {
      const { custom_message: _cm, scheduled_at: _sa, ...fallback } = insertPayload;
      if (isScheduled) return res.status(503).json({ error: 'Scheduling requires migration — run add_marketing_features.sql' });
      ({ data: campaign, error: campErr } = await supabaseAdmin
        .from('broadcast_campaigns').insert(fallback).select().single());
    }
    if (campErr) throw campErr;

    if (isScheduled) {
      return res.json({
        success: true,
        scheduled: true,
        campaign_id: campaign.id,
        scheduled_at: campaign.scheduled_at,
        recipient_count: recipients.length,
      });
    }

    res.json({
      success: true,
      campaign_id: campaign.id,
      sent_count: recipients.length,
      recipient_count: recipients.length,
    });

    executeBroadcast(campaign.id, auth.restaurantId, {
      name: name.trim(), segment, template_name, custom_message,
    }).catch(e => console.error('[broadcast] Background error:', e.message));
  } catch (err) {
    console.error('[marketing/broadcast]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/campaigns', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { data, error } = await supabaseAdmin
      .from('broadcast_campaigns').select('*')
      .eq('restaurant_id', auth.restaurantId)
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    const campaigns = await enrichCampaignsWithRoi(auth.restaurantId, data);
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error('[marketing/campaigns]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/automations', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { data, error } = await supabaseAdmin
      .from('marketing_automations')
      .select('*')
      .eq('restaurant_id', auth.restaurantId)
      .order('created_at', { ascending: false });
    if (error) {
      if (error.message?.includes('marketing_automations')) {
        return res.json({ success: true, automations: [], triggers: AUTOMATION_TRIGGERS });
      }
      throw error;
    }
    res.json({ success: true, automations: data ?? [], triggers: AUTOMATION_TRIGGERS });
  } catch (err) {
    console.error('[marketing/automations GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/automations', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { name, trigger_type, segment, template_name, custom_message } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!AUTOMATION_TRIGGERS[trigger_type]) return res.status(400).json({ error: 'Invalid trigger_type' });
    const seg = segment || AUTOMATION_TRIGGERS[trigger_type].segment;
    if (!SEGMENT_KEYS.includes(seg)) return res.status(400).json({ error: 'Invalid segment' });
    if (!template_name && !custom_message?.trim()) {
      return res.status(400).json({ error: 'template_name or custom_message required' });
    }

    const { data, error } = await supabaseAdmin.from('marketing_automations').insert({
      restaurant_id: auth.restaurantId,
      name: name.trim(),
      trigger_type,
      segment_type: seg,
      template_name: template_name || null,
      custom_message: custom_message || null,
      is_active: true,
      created_by: auth.user.id,
    }).select().single();

    if (error) {
      if (error.message?.includes('marketing_automations')) {
        return res.status(503).json({ error: 'Automations require migration — run add_marketing_features.sql' });
      }
      throw error;
    }
    res.json({ success: true, automation: data });
  } catch (err) {
    console.error('[marketing/automations POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/automations/:id', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { is_active } = req.body;
    const { data, error } = await supabaseAdmin
      .from('marketing_automations')
      .update({ is_active: !!is_active, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('restaurant_id', auth.restaurantId)
      .select().single();
    if (error) throw error;
    res.json({ success: true, automation: data });
  } catch (err) {
    console.error('[marketing/automations PATCH]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/ai-suggest', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { goal } = req.body;
    if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });
    if (!GROQ_KEY) return res.status(503).json({ error: 'AI not configured — add GROQ_API_KEY to Railway' });

    const map = await buildCustomerMap(auth.restaurantId);
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

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: `Goal: ${goal.trim()}` },
        ],
      }),
    });
    const aiData = await r.json();
    if (!r.ok) throw new Error(aiData.error?.message || 'Groq API request failed');
    const raw = aiData.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch { parsed = { segment: 'lapsed', reasoning: raw, suggested_message: '' }; }
    const seg = SEGMENT_KEYS.includes(parsed.segment) ? parsed.segment : 'lapsed';
    res.json({
      success: true, segment: seg, reasoning: parsed.reasoning || '',
      suggested_message: parsed.suggested_message || '', estimated_count: segCounts[seg] ?? null,
    });
  } catch (err) {
    console.error('[marketing/ai-suggest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/ai-rewrite', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { text, category = 'MARKETING' } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });
    if (!GROQ_KEY) return res.status(503).json({ error: 'AI not configured — add GROQ_API_KEY to Railway' });

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', max_tokens: 300,
        messages: [
          { role: 'system', content: `You are a WhatsApp marketing copy editor for an Indian restaurant. Rewrite the provided message to be more concise, warm, and engaging while keeping it Meta/WhatsApp compliant (no misleading claims). Keep all {{variable}} placeholders intact. Use *bold* sparingly. Max 400 characters. Sound human, not corporate. Respond with ONLY the rewritten message — no explanation, no quotes.` },
          { role: 'user',   content: `Category: ${category}\nMessage: ${text.trim()}` },
        ],
      }),
    });
    const aiData = await r.json();
    if (!r.ok) throw new Error(aiData.error?.message || 'Groq API request failed');
    res.json({ success: true, rewritten: aiData.choices?.[0]?.message?.content?.trim() || text });
  } catch (err) {
    console.error('[marketing/ai-rewrite]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const AI_GENERATE_GOALS = {
  win_back:    'Bring back lapsed customers who have not visited recently',
  special:     'Announce a limited-time special offer or promotion',
  loyalty:     'Reward loyal high-value customers',
  welcome:     'Welcome first-time customers and suggest what to try next',
};

router.post('/ai-generate', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { goal_key, goal_text, language = 'en', category = 'MARKETING', restaurant_name } = req.body;
    const goal = goal_text?.trim() || AI_GENERATE_GOALS[goal_key] || goal_key;
    if (!goal) return res.status(400).json({ error: 'goal_key or goal_text is required' });
    if (!GROQ_KEY) return res.status(503).json({ error: 'AI not configured — add GROQ_API_KEY to Railway' });

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', max_tokens: 600,
        messages: [
          {
            role: 'system',
            content: `You create WhatsApp Business message templates for an Indian restaurant (${restaurant_name || 'the restaurant'}).
Respond ONLY with valid JSON (no markdown):
{
  "template_name": "lowercase_with_underscores max 40 chars",
  "body": "Message body under 400 chars. Use {{name}} for customer name. WhatsApp formatting: *bold* _italic_. Must be Meta-compliant — no false urgency, include opt-out friendly tone.",
  "footer": "Reply STOP to opt out",
  "category": "MARKETING or UTILITY"
}
Language: ${language}. Category hint: ${category}.`,
          },
          { role: 'user', content: `Goal: ${goal}` },
        ],
      }),
    });
    const aiData = await r.json();
    if (!r.ok) throw new Error(aiData.error?.message || 'Groq API request failed');
    const raw = aiData.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch {
      return res.status(502).json({ error: 'AI returned invalid JSON — try again' });
    }
    const templateName = (parsed.template_name || 'campaign_message')
      .toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 40);
    res.json({
      success: true,
      template_name: templateName,
      body: parsed.body || '',
      footer: parsed.footer || 'Reply STOP to opt out',
      category: parsed.category === 'UTILITY' ? 'UTILITY' : 'MARKETING',
    });
  } catch (err) {
    console.error('[marketing/ai-generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/restaurants/:id/waba', async (req, res) => {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (req.params.id !== auth.restaurantId) return res.status(403).json({ error: 'Access denied' });
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('id, name, waba_id, whatsapp_number, display_name')
      .eq('id', auth.restaurantId).single();
    if (error || !data) return res.status(404).json({ error: 'Restaurant not found' });
    res.json({
      success: true, waba_id: data.waba_id ?? null, name: data.name,
      whatsapp_phone_number: data.whatsapp_number ?? null,
      whatsapp_display_name: data.display_name ?? data.name,
    });
  } catch (err) {
    console.error('[restaurants/:id/waba]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('id, name, waba_id, whatsapp_number, display_name, is_active')
      .eq('id', req.params.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Restaurant not found' });
    res.json({ success: true, restaurant: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('id, name, waba_id, whatsapp_number, is_active')
      .eq('is_active', true);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, restaurants: data ?? [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
