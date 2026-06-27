// src/routes/supply/webhook.js
// ============================================================================
// Munafe Supply webhook endpoints.
// ============================================================================

'use strict';

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');

router.get('/whatsapp/status', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && expected && token === expected) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

router.post('/whatsapp/status', async (req, res) => {
  try {
    const entries = req.body?.entry || [];
    const updates = [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        for (const status of change.value?.statuses || []) {
          if (!status.id || !status.status) continue;

          const logStatus = status.status === 'read' ? 'delivered' : status.status;

          updates.push(
            supabaseAdmin
              .from('supply_notification_log')
              .update({
                status: logStatus,
                payload: {
                  webhook_status: status,
                },
              })
              .eq('wa_message_id', status.id)
          );
        }
      }
    }

    await Promise.all(updates);
    res.json({ success: true, updated: updates.length });
  } catch (err) {
    console.error('[supply/webhook/status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
