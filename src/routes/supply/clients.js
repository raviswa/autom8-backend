// src/routes/supply/clients.js
// ============================================================================
// Munafe Supply — Module 2: Client / Buyer Management
//
// Buyers are supply_clients for any LOB (restaurants, retail, etc.).
// Optional munafe_restaurant_id bridges shared-WABA demo tenants only.
//   GET    /api/supply/clients                — list all clients for supplier
//   POST   /api/supply/clients                — add new client
//   GET    /api/supply/clients/:id            — get single client
//   PUT    /api/supply/clients/:id            — update client
//   DELETE /api/supply/clients/:id            — soft delete (is_active = false)
//   GET    /api/supply/clients/:id/summary    — client + balance + last 5 transactions + pending orders
//   GET    /api/supply/clients/by-phone/:phone — bot: identify client by WhatsApp number
//
// Register in server.js (before pos catch-all):
//   app.use('/api/supply/clients', require('./src/routes/supply/clients'));
//
// Dependencies:
//   - Migration 01_suppliers.sql (suppliers table)
//   - Migration 02_supply_clients.sql (supply_clients table)
//   - src/middleware/supplyAuth.js (getSupplierContext)
//   - src/helpers/supplyWhatsapp.js (welcome message on add)
//     NOTE: supplyWhatsapp.js is Module 12. Until it exists, welcome message
//     is skipped gracefully — see WELCOME_MSG_ENABLED flag below.
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const { supabaseAdmin }         = require('../../config/supabase');
const { authenticateToken }     = require('../../middleware/auth');
const { getSupplierContext }    = require('../../middleware/supplyAuth');
const { createFormToken }       = require('./supplyFormToken');
const { notifyClient }          = require('./notify');

const SUPPLY_FORM_BASE_URL = process.env.SUPPLY_FORM_BASE_URL || 'https://order.autom8.works';

// Gracefully skip welcome message until Module 12 (supplyWhatsapp.js) exists.
// Set to true once notify.js and supplyWhatsapp.js are deployed.

const { sendSupplyWhatsAppMessage } = require('./supplyWhatsapp');



// ── Helpers ───────────────────────────────────────────────────────────────────

// Normalise phone: strip spaces/dashes, ensure leading country code
// Bot messages always use the stored phone directly.
function normalisePhone(raw) {
  if (!raw) return null;
  return String(raw).replace(/[\s\-()]/g, '');
}

// Validate delivery_days array
const VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function validateDeliveryDays(days) {
  if (!Array.isArray(days)) return false;
  return days.every(d => VALID_DAYS.includes(d));
}

function getTodayCutoffDate(supplier) {
  const cutoff = supplier?.ordering_cutoff_time || '22:00:00';
  const [hours = '22', minutes = '00'] = String(cutoff).split(':');
  const validUntil = new Date();
  validUntil.setHours(Number(hours), Number(minutes), 0, 0);

  if (validUntil.getTime() <= Date.now()) {
    validUntil.setDate(validUntil.getDate() + 1);
  }

  return validUntil;
}

// ── GET /api/supply/clients ───────────────────────────────────────────────────
// Returns all clients for the authenticated supplier.
// Includes outstanding_balance from supply_credit_ledger (if that table exists).
// Supports ?active=true|false and ?search=name_or_phone

router.get('/', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    const { active, search } = req.query;

    let query = supabaseAdmin
      .from('supply_clients')
      .select([
        'id', 'name', 'phone', 'gstin',
        'address', 'city', 'pincode',
        'delivery_days',
        'credit_limit', 'credit_terms_days', 'credit_auto_block',
        'munafe_restaurant_id',
        'is_active', 'created_at', 'updated_at',
      ].join(', '))
      .eq('supplier_id', req.supplier_id)
      .order('name', { ascending: true });

    // Filter by active status
    if (active === 'true')  query = query.eq('is_active', true);
    if (active === 'false') query = query.eq('is_active', false);

    // Search by name or phone
    if (search?.trim()) {
      query = query.or(`name.ilike.%${search.trim()}%,phone.ilike.%${search.trim()}%`);
    }

    const { data: clients, error } = await query;
    if (error) throw error;

    // ── Attach outstanding_balance from credit ledger ─────────────────────────
    // Gracefully handles case where supply_credit_ledger table doesn't exist yet.
    let balanceMap = {};
    if (clients?.length) {
      try {
        const clientIds = clients.map(c => c.id);

        // Get the latest ledger entry per client (balance_after = running balance)
        const { data: ledgerRows } = await supabaseAdmin
          .from('supply_credit_ledger')
          .select('client_id, balance_after, created_at')
          .in('client_id', clientIds)
          .order('created_at', { ascending: false });

        // Keep only the most recent entry per client
        if (ledgerRows?.length) {
          for (const row of ledgerRows) {
            if (!balanceMap[row.client_id]) {
              balanceMap[row.client_id] = row.balance_after ?? 0;
            }
          }
        }
      } catch (_) {
        // supply_credit_ledger not yet created — all balances default to 0
      }
    }

    const enriched = (clients ?? []).map(c => ({
      ...c,
      outstanding_balance: balanceMap[c.id] ?? 0,
      credit_available:    Math.max(0, (c.credit_limit ?? 0) - (balanceMap[c.id] ?? 0)),
    }));

    res.json({ success: true, clients: enriched });

  } catch (err) {
    console.error('[supply/clients/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/supply/clients ──────────────────────────────────────────────────
// Add a new buyer/client (any LOB — restaurant, retail, etc.).
// Sends a WhatsApp welcome message if Module 12 is deployed.

router.post('/', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    const {
      name,
      phone,
      gstin,
      address,
      city,
      pincode,
      delivery_days = [],
      credit_limit = 0,
      credit_terms_days = 30,
      credit_auto_block = true,
      munafe_restaurant_id,
    } = req.body;

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!name?.trim())  return res.status(400).json({ error: 'Client name is required' });
    if (!phone?.trim()) return res.status(400).json({ error: 'WhatsApp phone number is required' });

    if (delivery_days.length && !validateDeliveryDays(delivery_days)) {
      return res.status(400).json({
        error: `Invalid delivery_days. Allowed values: ${VALID_DAYS.join(', ')}`,
      });
    }

    if (typeof credit_limit !== 'number' || credit_limit < 0) {
      return res.status(400).json({ error: 'credit_limit must be a non-negative number' });
    }

    const normPhone = normalisePhone(phone);

    // ── Check duplicate phone for this supplier ───────────────────────────────
    const { data: existing } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, is_active')
      .eq('supplier_id', req.supplier_id)
      .eq('phone', normPhone)
      .maybeSingle();

    if (existing) {
      if (existing.is_active) {
        return res.status(400).json({
          error: `A client with this phone number already exists: ${existing.name}`,
        });
      } else {
        // Reactivate the deactivated client instead of creating a duplicate
        const { data: reactivated, error: reactErr } = await supabaseAdmin
          .from('supply_clients')
          .update({
            name:               name.trim(),
            gstin:              gstin?.trim() || null,
            address:            address?.trim() || null,
            city:               city?.trim() || null,
            pincode:            pincode?.trim() || null,
            delivery_days:      delivery_days,
            credit_limit:       credit_limit,
            credit_terms_days:  credit_terms_days,
            credit_auto_block:  credit_auto_block,
            is_active:          true,
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (reactErr) throw reactErr;

        console.log(`[supply/clients] Reactivated client: ${reactivated.name} (${reactivated.id})`);
        return res.status(200).json({ success: true, client: reactivated, reactivated: true });
      }
    }

    // ── Insert new client ─────────────────────────────────────────────────────
    const { data: client, error: insertError } = await supabaseAdmin
      .from('supply_clients')
      .insert({
        supplier_id:          req.supplier_id,
        name:                 name.trim(),
        phone:                normPhone,
        gstin:                gstin?.trim() || null,
        address:              address?.trim() || null,
        city:                 city?.trim() || null,
        pincode:              pincode?.trim() || null,
        delivery_days:        delivery_days,
        credit_limit:         credit_limit,
        credit_terms_days:    credit_terms_days,
        credit_auto_block:    credit_auto_block,
        munafe_restaurant_id: munafe_restaurant_id || null,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    console.log(`[supply/clients] ✅ Added client: ${client.name} (${client.id})`);

    // ── Send WhatsApp welcome message (non-blocking) ──────────────────────────
    if (sendSupplyWhatsAppMessage) {
      const welcomeMsg = [
        `Vanakkam! 🙏`,
        ``,
        `You've been added as a client of *${req.supplier.business_name}*.`,
        ``,
        `You can now place your supply orders directly via WhatsApp.`,
        `Your personalised order form and price list will be shared at 6 PM daily.`,
        ``,
        `For queries, contact ${req.supplier.business_name}: ${req.supplier.phone}`,
      ].join('\n');

      sendSupplyWhatsAppMessage(normPhone, welcomeMsg, req.supplier_id)
        .catch(err => console.warn('[supply/clients] Welcome message failed:', err.message));
    }

    res.status(201).json({ success: true, client });

  } catch (err) {
    console.error('[supply/clients/add]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/clients/:id ───────────────────────────────────────────────
// Get a single client. Verifies it belongs to the authenticated supplier.

router.post('/:id/send-form-link', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: client, error } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name, phone, is_active')
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .maybeSingle();

    if (error) throw error;
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.is_active) return res.status(400).json({ error: 'Client is inactive' });

    const validUntil = getTodayCutoffDate(req.supplier);
    const token = createFormToken(req.supplier_id, client.id, validUntil, false);
    const orderFormUrl = `${SUPPLY_FORM_BASE_URL.replace(/\/$/, '')}/s/${token}`;

    const notification = await notifyClient(req.supplier_id, client.phone, 'supply_order_link', {
      client_name: client.name,
      order_form_url: orderFormUrl,
    }, client.id);

    res.json({
      success: true,
      order_form_url: orderFormUrl,
      valid_until: validUntil.toISOString(),
      notification,
    });
  } catch (err) {
    console.error('[supply/clients/send-form-link]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: client, error } = await supabaseAdmin
      .from('supply_clients')
      .select('*')
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)   // ownership check
      .maybeSingle();

    if (error) throw error;
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Attach balance
    let outstanding_balance = 0;
    try {
      const { data: ledger } = await supabaseAdmin
        .from('supply_credit_ledger')
        .select('balance_after')
        .eq('client_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      outstanding_balance = ledger?.balance_after ?? 0;
    } catch (_) {}

    res.json({
      success: true,
      client: {
        ...client,
        outstanding_balance,
        credit_available: Math.max(0, (client.credit_limit ?? 0) - outstanding_balance),
      },
    });

  } catch (err) {
    console.error('[supply/clients/get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/supply/clients/:id ───────────────────────────────────────────────
// Update client details. All fields optional — only provided fields are updated.
// Phone cannot be changed (it's the identity key for the WhatsApp bot).

router.put('/:id', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const { data: existing } = await supabaseAdmin
      .from('supply_clients')
      .select('id')
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ error: 'Client not found' });

    const {
      name,
      gstin,
      address,
      city,
      pincode,
      delivery_days,
      credit_limit,
      credit_terms_days,
      credit_auto_block,
      munafe_restaurant_id,
    } = req.body;

    // Build update — only include provided fields
    const updates = {};
    if (name              !== undefined) updates.name              = name?.trim() || null;
    if (gstin             !== undefined) updates.gstin             = gstin?.trim() || null;
    if (address           !== undefined) updates.address           = address?.trim() || null;
    if (city              !== undefined) updates.city              = city?.trim() || null;
    if (pincode           !== undefined) updates.pincode           = pincode?.trim() || null;
    if (credit_limit      !== undefined) updates.credit_limit      = Number(credit_limit);
    if (credit_terms_days !== undefined) updates.credit_terms_days = Number(credit_terms_days);
    if (credit_auto_block !== undefined) updates.credit_auto_block = Boolean(credit_auto_block);
    if (munafe_restaurant_id !== undefined) updates.munafe_restaurant_id = munafe_restaurant_id || null;

    if (delivery_days !== undefined) {
      if (!validateDeliveryDays(delivery_days)) {
        return res.status(400).json({
          error: `Invalid delivery_days. Allowed: ${VALID_DAYS.join(', ')}`,
        });
      }
      updates.delivery_days = delivery_days;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields provided to update' });
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('supply_clients')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    console.log(`[supply/clients/update] ✅ Updated client ${id}`);
    res.json({ success: true, client: updated });

  } catch (err) {
    console.error('[supply/clients/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/supply/clients/:id ────────────────────────────────────────────
// Soft delete only — sets is_active = false.
// Historical orders, ledger entries, and invoices are preserved.

router.delete('/:id', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing } = await supabaseAdmin
      .from('supply_clients')
      .select('id, name')
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ error: 'Client not found' });

    const { error } = await supabaseAdmin
      .from('supply_clients')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;

    console.log(`[supply/clients/delete] Deactivated client: ${existing.name} (${id})`);
    res.json({ success: true, message: `${existing.name} has been deactivated.` });

  } catch (err) {
    console.error('[supply/clients/delete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/clients/:id/summary ──────────────────────────────────────
// Full account summary: client details + credit position + last 5 ledger
// entries + pending orders count.
// Used by the supplier dashboard client account page.

router.get('/:id/summary', authenticateToken, getSupplierContext, async (req, res) => {
  try {
    const { id } = req.params;

    // ── Client profile ────────────────────────────────────────────────────────
    const { data: client, error: clientError } = await supabaseAdmin
      .from('supply_clients')
      .select('*')
      .eq('id', id)
      .eq('supplier_id', req.supplier_id)
      .maybeSingle();

    if (clientError) throw clientError;
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // ── Outstanding balance ───────────────────────────────────────────────────
    let outstanding_balance = 0;
    let last_transactions   = [];
    let pending_orders      = [];
    let pending_orders_count = 0;

    // Credit ledger (Module 7 — graceful fallback if not yet deployed)
    try {
      const { data: ledgerRows } = await supabaseAdmin
        .from('supply_credit_ledger')
        .select('id, entry_date, type, amount, balance_after, note, order_id, created_at')
        .eq('client_id', id)
        .order('created_at', { ascending: false })
        .limit(5);

      if (ledgerRows?.length) {
        outstanding_balance = ledgerRows[0].balance_after ?? 0;
        last_transactions   = ledgerRows;
      }
    } catch (_) {}

    // Pending orders (Module 6 — graceful fallback)
    try {
      const { data: ordersData } = await supabaseAdmin
        .from('supply_orders')
        .select('id, order_number, delivery_date, status, total_amount, created_at')
        .eq('client_id', id)
        .in('status', ['confirmed', 'out_for_delivery'])
        .order('delivery_date', { ascending: true });

      pending_orders       = ordersData ?? [];
      pending_orders_count = pending_orders.length;
    } catch (_) {}

    // ── Credit utilisation ────────────────────────────────────────────────────
    const credit_limit       = client.credit_limit ?? 0;
    const credit_available   = Math.max(0, credit_limit - outstanding_balance);
    const utilisation_pct    = credit_limit > 0
      ? Math.round((outstanding_balance / credit_limit) * 100)
      : 0;

    res.json({
      success: true,
      client: {
        ...client,
        outstanding_balance,
        credit_available,
        utilisation_pct,
      },
      last_transactions,
      pending_orders,
      pending_orders_count,
    });

  } catch (err) {
    console.error('[supply/clients/summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/supply/clients/by-phone/:phone ───────────────────────────────────
// Used internally by the supply bot handler (supplyBotHandler.js) to resolve
// an inbound WhatsApp number to a client + full context.
//
// Protected by AUTOM8_KDS_SECRET (internal service calls only).
// Returns null-safe response — bot handles unknown clients gracefully.

router.get('/by-phone/:phone', async (req, res) => {
  try {
    // Internal auth: require AUTOM8_KDS_SECRET or supply internal secret
    const internalSecret = req.headers['x-internal-secret']
      || req.headers['authorization']?.replace('Bearer ', '');

    const validSecret = process.env.AUTOM8_KDS_SECRET || process.env.SUPPLY_INTERNAL_SECRET;

    if (!validSecret || internalSecret !== validSecret) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { phone } = req.params;
    const { supplier_id } = req.query;

    if (!supplier_id) {
      return res.status(400).json({ error: 'supplier_id query param is required' });
    }

    const normPhone = normalisePhone(phone);

    const { data: client, error } = await supabaseAdmin
      .from('supply_clients')
      .select('*')
      .eq('supplier_id', supplier_id)
      .eq('phone', normPhone)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;

    if (!client) {
      return res.json({ found: false, client: null });
    }

    // Attach balance
    let outstanding_balance = 0;
    try {
      const { data: ledger } = await supabaseAdmin
        .from('supply_credit_ledger')
        .select('balance_after')
        .eq('client_id', client.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      outstanding_balance = ledger?.balance_after ?? 0;
    } catch (_) {}

    const credit_limit     = client.credit_limit ?? 0;
    const credit_available = Math.max(0, credit_limit - outstanding_balance);
    const utilisation_pct  = credit_limit > 0
      ? Math.round((outstanding_balance / credit_limit) * 100)
      : 0;

    res.json({
      found: true,
      client: {
        ...client,
        outstanding_balance,
        credit_available,
        utilisation_pct,
      },
    });

  } catch (err) {
    console.error('[supply/clients/by-phone]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
