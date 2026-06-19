// src/schedulers/index.js
// ============================================================================
// All background scheduler functions.
//
// startAllSchedulers() is called once at server startup (from server.js listen
// callback) and chains:
//   startSlotScheduler()              — auto-release + slot rotation (every 5 min + 1 min)
//   startSpecialNotesTimeoutMonitor() — auto-confirm stale notes prompts (every 60s)
//   startFeedbackScheduler()          — 2-hr post-visit feedback (every 10 min)
//   startAccountingSyncScheduler()    — nightly Zoho/Tally push at 23:30 IST
//   startMarketingScheduler()         — scheduled campaigns + automations (every 5 min)
// ============================================================================

'use strict';

const { supabaseAdmin }         = require('../config/supabase');
const { sendWhatsAppMessage }   = require('../helpers/whatsapp');
const { startFeedbackScheduler } = require('../routes/feedback');
const { notifyKdsFromSessionContext } = require('../helpers/kdsNotifyClient');
const { getManagerPhone } = require('../helpers/restaurantConfig');
const {
  releaseTablesForToken,
  releaseOrphanedOccupiedTables,
  ACTIVE_ORDER_STATUSES,
} = require('../helpers/tableRelease');
const { sendKitchenOpenReminders } = require('../helpers/kitchenReminders');
const { runDineInAutoAssignJob } = require('../helpers/dineInAutoAssign');

// Slot helpers live in catalog.js (single source of truth — shared with POST /catalog/slot-sync)
const {
  getCurrentSlotIST,
  applySlotAvailability,
  applySlotForAllRestaurants,
  resetDailySpecialDishes,
} = require('../routes/catalog');

// Accounting push lives in invoices.js
const { pushInvoiceToAccounting } = require('../routes/invoices');

// ── startSlotScheduler ────────────────────────────────────────────────────────

function startSlotScheduler() {
  // Auto-release stale seated tokens using each restaurant's dining_duration_minutes
  setInterval(async () => {
    try {
      const { data: restaurants } = await supabaseAdmin
        .from('restaurants')
        .select('id, dining_duration_minutes')
        .eq('is_active', true);

      for (const restaurant of restaurants ?? []) {
        const minutes = restaurant.dining_duration_minutes || 90;
        const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();

        const { data: staleTokens } = await supabaseAdmin
          .from('walk_in_tokens')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('status', 'seated')
          .eq('restaurant_id', restaurant.id)
          .lt('seated_at', cutoff)
          .select('*');

        for (const token of staleTokens ?? []) {
          const freed = await releaseTablesForToken(supabaseAdmin, token, restaurant.id, {
            queueFeedback: true,
            feedbackSource: 'auto-release',
          });
          console.log(
            `[auto-release] Token ${token.id} freed ${freed.length} table(s) ` +
            `(duration=${minutes}m)`,
          );
        }

        const orphans = await releaseOrphanedOccupiedTables(supabaseAdmin, restaurant.id);
        if (orphans.length) {
          console.log(
            `[auto-release] Freed orphaned occupied table(s): ${orphans.join(', ')} ` +
            `(restaurant ${restaurant.id})`,
          );
        }

        const { data: staleOrders } = await supabaseAdmin
          .from('orders')
          .update({ status: 'completed' })
          .eq('restaurant_id', restaurant.id)
          .in('status', ACTIVE_ORDER_STATUSES)
          .lt('created_at', cutoff)
          .select('table_id, id, order_number');

        for (const order of staleOrders ?? []) {
          if (!order.table_id) continue;
          const { data: remaining } = await supabaseAdmin
            .from('orders').select('id').eq('table_id', order.table_id)
            .in('status', ACTIVE_ORDER_STATUSES);
          if (!remaining || remaining.length === 0) {
            await supabaseAdmin.from('tables').update({ status: 'available' }).eq('id', order.table_id);
          }
        }
      }
    } catch (err) {
      console.error('[auto-release] Error:', err.message);
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  // Slot rotation — runs every minute, applies on change
  let lastAppliedSlot = Symbol('init');
  let lastSpecialResetDate = null;
  applySlotForAllRestaurants().catch(e => console.error('[slot] Initial apply failed:', e.message));
  setInterval(async () => {
    try {
      const currentSlot = getCurrentSlotIST();
      if (currentSlot !== lastAppliedSlot) {
        console.log(`🔄 Slot changed: ${String(lastAppliedSlot)} → ${currentSlot}`);
        if (lastAppliedSlot !== Symbol('init') && currentSlot && !lastAppliedSlot) {
          const n = await sendKitchenOpenReminders();
          if (n) console.log(`[kitchen-remind] Sent ${n} open notification(s)`);
        }
        lastAppliedSlot = currentSlot;
        await applySlotForAllRestaurants();
      }

      const nowIST = new Date(Date.now() + 330 * 60 * 1000);
      const todayKey = nowIST.toISOString().slice(0, 10);
      const istHour = nowIST.getUTCHours();
      const istMin = nowIST.getUTCMinutes();
      if (istHour === 0 && istMin < 2 && lastSpecialResetDate !== todayKey) {
        lastSpecialResetDate = todayKey;
        await resetDailySpecialDishes();
      }
    } catch (err) {
      console.error('[slot-rotation] Error:', err.message);
    }
  }, 60 * 1000); // Every minute

  console.log('⏰ Slot scheduler started (auto-release every 5min, slot rotation every 1min)');
}

// ── startSpecialNotesTimeoutMonitor ──────────────────────────────────────────
// Auto-confirms bookings where the customer hasn't replied to the special-notes
// prompt within 2 minutes.

function startSpecialNotesTimeoutMonitor() {
  setInterval(async () => {
    try {
      const epochNowMinus2Min = (Date.now() / 1000) - (2 * 60);

      const { data: staleSessions, error } = await supabaseAdmin
        .from('conversation_states')
        .select('id, restaurant_id, customer_phone, current_state, context')
        .filter('context->>booking_step', 'eq', 'awaiting_special_notes')
        .filter('context->>special_notes_asked_at', 'lt', String(epochNowMinus2Min))
        .limit(50);

      if (error) { console.error('[notes-timeout] Query failed:', error.message); return; }

      for (const session of staleSessions ?? []) {
        try {
          const ctx           = session.context || {};
          const bookingId     = ctx.booking_id  || null;
          const customerPhone = session.customer_phone;
          const customerName  = ctx.customer_name || ctx.name || 'Guest';
          const tokenNumber   = ctx.token_number  || ctx.display_token || null;
          const kitchenAlreadySent = !!(ctx._kitchen_sent || ctx._customer_finalize_sent);
          const prepayPending = !!(
            ctx.payment_link
            || ctx._prepay_blocks_kitchen
            || ctx._notes_finalized_pending_payment
            || ctx.pending_prepay_fulfillment
          ) && !ctx._payment_received;

          if (prepayPending) {
            await supabaseAdmin.from('conversation_states').update({
              current_state: 'visit_complete',
              context: {
                ...ctx,
                booking_step: 'visit_complete',
                special_notes: null,
                special_notes_asked_at: null,
                auto_confirmed_at: new Date().toISOString(),
              },
              updated_at: new Date().toISOString(),
            }).eq('id', session.id);
            console.log(
              `[notes-timeout] Session ${session.id} closed (prepay — KDS waits for payment)`
            );
            continue;
          }

          if (kitchenAlreadySent) {
            // KDS + manager order alert already fired at confirm — just close the session.
            await supabaseAdmin.from('conversation_states').update({
              current_state: 'visit_complete',
              context: {
                ...ctx,
                booking_step: 'visit_complete',
                special_notes: null,
                special_notes_asked_at: null,
                _customer_finalize_sent: true,
                auto_confirmed_at: new Date().toISOString(),
              },
              updated_at: new Date().toISOString(),
            }).eq('id', session.id);
            console.log(`[notes-timeout] Session ${session.id} closed (kitchen already sent)`);
            continue;
          }

          // Push order to KDS if Python chat notify failed (e.g. secret mismatch).
          const kdsOk = await notifyKdsFromSessionContext(session);
          if (!kdsOk && ctx._pending_kitchen) {
            console.warn(`[notes-timeout] KDS notify failed for session ${session.id} — check AUTOM8_KDS_SECRET`);
          }

          if (bookingId) {
            await supabaseAdmin.from('bookings').update({
              status:             'confirmed',
              table_confirmed_at: new Date().toISOString(),
            }).eq('id', bookingId).eq('status', 'pending');
          }

          await supabaseAdmin.from('conversation_states').update({
            current_state: 'visit_complete',
            context: {
              ...ctx,
              booking_step: 'visit_complete',
              special_notes: null,
              special_notes_asked_at: null,
              _kitchen_sent: kdsOk || ctx._kitchen_sent || false,
              auto_confirmed_at: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
          }).eq('id', session.id);

          if (customerPhone && process.env.WHATSAPP_ACCESS_TOKEN) {
            await sendWhatsAppMessage(
              customerPhone,
              `✅ *Booking Confirmed!*\n\nHi ${customerName}, your booking` +
              (tokenNumber ? ` (Token: *${tokenNumber}*)` : '') +
              ` has been confirmed.\n\nWe look forward to serving you! 🍽️`,
              session.restaurant_id
            );
          }

          const managerPhone = await getManagerPhone(session.restaurant_id);
          if (managerPhone) {
            try {
              await sendWhatsAppMessage(
                managerPhone,
                `⏰ *Auto-Confirmed (Notes Timeout)*\nCustomer: ${customerName}\nToken: ${tokenNumber || '—'}\nBooking: ${bookingId || '—'}`,
                session.restaurant_id,
              );
            } catch (waErr) {
              console.warn(`[notes-timeout] Manager notify failed: ${waErr.message}`);
            }
          }

          console.log(`[notes-timeout] ✅ Auto-confirmed session ${session.id}`);
        } catch (sessionErr) {
          console.error(`[notes-timeout] Session ${session.id}:`, sessionErr.message);
        }
      }
    } catch (err) {
      console.error('[notes-timeout] Monitor scan error:', err.message);
    }
  }, 60 * 1000);

  console.log('⏰ Special notes timeout monitor started (polls every 60s, 2-min idle auto-confirm)');
}

// ── startAccountingSyncScheduler ─────────────────────────────────────────────

function startAccountingSyncScheduler() {
  let lastSyncDate = null;

  setInterval(async () => {
    try {
      const now        = new Date();
      const istMinutes = ((now.getUTCHours() * 60 + now.getUTCMinutes()) + 330) % (24 * 60);
      const istHour    = Math.floor(istMinutes / 60);
      const istMin     = istMinutes % 60;

      if (istHour !== 23 || istMin < 30 || istMin > 31) return;

      const todayIST = new Date(now.getTime() + 330 * 60 * 1000).toISOString().split('T')[0];
      if (lastSyncDate === todayIST) return;
      lastSyncDate = todayIST;

      console.log(`[accounting-sync] 🔄 Starting nightly sync for ${todayIST}`);

      const { data: pendingInvoices, error: fetchErr } = await supabaseAdmin
        .from('invoices').select('id, order_id, payload, restaurant_id')
        .eq('accounting_sync_status', 'PENDING_DAILY_ROLLUP_ZOHO_TALLY').limit(200);

      if (fetchErr) throw fetchErr;
      if (!pendingInvoices?.length) { console.log('[accounting-sync] No pending invoices'); return; }

      let synced = 0, failed = 0;
      for (const invoice of pendingInvoices) {
        try {
          await pushInvoiceToAccounting(invoice);
          await supabaseAdmin.from('invoices').update({
            accounting_sync_status: 'SYNCED',
            synced_at:              new Date().toISOString(),
          }).eq('id', invoice.id);
          synced++;
        } catch (invoiceErr) {
          console.error(`[accounting-sync] Failed for ${invoice.id}:`, invoiceErr.message);
          await supabaseAdmin.from('invoices').update({ accounting_sync_status: 'SYNC_FAILED' }).eq('id', invoice.id);
          failed++;
        }
      }

      console.log(`[accounting-sync] ✅ Done — synced: ${synced}, failed: ${failed}`);

      if (process.env.MANAGER_WHATSAPP_NUMBER) {
        sendWhatsAppMessage(
          process.env.MANAGER_WHATSAPP_NUMBER,
          `📊 *Nightly Accounting Sync Complete*\nDate: ${todayIST}\n✅ Synced: ${synced}\n❌ Failed: ${failed}\nPlatform: Zoho Books / Tally`
        ).catch(() => {});
      }
    } catch (err) {
      console.error('[accounting-sync] Scheduler error:', err.message);
    }
  }, 60 * 1000);

  console.log('📊 Accounting sync scheduler started (fires nightly at 23:30 IST)');
}

async function pushInvoiceToAccountingStub_DELETE_ME() {
  // This function is now in src/routes/invoices.js — imported above.
  // Left as a reminder: delete this placeholder.
}

// ── startMarketingScheduler ───────────────────────────────────────────────────

const { dispatchScheduledCampaigns, runMarketingAutomations } = require('../helpers/marketingCampaign');

function startMarketingScheduler() {
  const tick = async () => {
    try {
      await dispatchScheduledCampaigns();
      await runMarketingAutomations();
    } catch (err) {
      console.error('[marketing-scheduler] Error:', err.message);
    }
  };
  tick();
  setInterval(tick, 5 * 60 * 1000);
  console.log('📣 Marketing scheduler started (scheduled sends + automations every 5 min)');
}

// ── startDineInAutoAssignScheduler ───────────────────────────────────────────
// After 2–4 minutes, seat dine-in walk-ins on a free table or approve large parties
// when the proposed tables are still available and no manager action was taken.

function startDineInAutoAssignScheduler() {
  const tick = async () => {
    try {
      await runDineInAutoAssignJob();
    } catch (err) {
      console.error('[dine-in-auto] Error:', err.message);
    }
  };
  tick();
  setInterval(tick, 60 * 1000);
  console.log('🪑 Dine-in auto-assign scheduler started (every 60s, delay 2–4 min)');
}

// ── startAllSchedulers ────────────────────────────────────────────────────────

function startAllSchedulers() {
  startSlotScheduler();
  startSpecialNotesTimeoutMonitor();
  startFeedbackScheduler();
  startAccountingSyncScheduler();
  startMarketingScheduler();
  startDineInAutoAssignScheduler();
}

module.exports = { startAllSchedulers };
