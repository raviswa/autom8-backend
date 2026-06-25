// src/helpers/captainAssignment.js
// Auto-assign takeaway orders to an on-duty captain (least-loaded round-robin).

'use strict';

const { supabaseAdmin } = require('../config/supabase');
const { sendWhatsAppMessage } = require('./whatsapp');
const { validateAndNormalizeWhatsApp } = require('./phoneFormat');

function captainDisplayName(fullName) {
  const name = String(fullName || '').trim();
  if (!name) return null;
  const parts = name.split(/\s+/);
  // Role placeholders like "Field Captain" — not a person's name
  if (/^field\s+captain$/i.test(name)) return null;
  if (parts.length >= 2 && parts[parts.length - 1].toLowerCase() === 'captain') {
    return parts[0];
  }
  if (parts.length === 1) return name;
  return parts[0];
}

async function getActiveCaptains(restaurantId) {
  const { data, error } = await supabaseAdmin
    .from('employees')
    .select('id, full_name, whatsapp_number, phone, hired_at')
    .eq('restaurant_id', restaurantId)
    .eq('role', 'captain')
    .eq('is_active', true)
    .order('hired_at', { ascending: true });

  if (error) {
    console.warn(`[captain-assign] load captains failed: ${error.message}`);
    return [];
  }

  return (data ?? []).filter((c) => {
    const wa = String(c.whatsapp_number || c.phone || '').replace(/\D/g, '');
    return wa.length >= 10;
  });
}

async function countOpenTakeawayLoads(restaurantId, captainIds) {
  const loads = Object.fromEntries(captainIds.map((id) => [id, 0]));
  if (!captainIds.length) return loads;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('meta')
    .eq('restaurant_id', restaurantId)
    .eq('type', 'takeaway')
    .in('status', ['takeaway', 'waiting'])
    .gte('arrived_at', startOfDay.toISOString());

  if (error) {
    console.warn(`[captain-assign] load counts failed: ${error.message}`);
    return loads;
  }

  for (const row of data ?? []) {
    const cid = row.meta?.captain_id;
    if (cid && loads[cid] !== undefined) loads[cid] += 1;
  }
  return loads;
}

function pickLeastLoadedCaptain(captains, loads) {
  let best = null;
  let bestLoad = Infinity;

  for (const captain of captains) {
    const load = loads[captain.id] ?? 0;
    if (load < bestLoad) {
      best = captain;
      bestLoad = load;
    }
  }
  return best;
}

async function assignCaptainToToken(restaurantId, tokenId, captain) {
  const { data: token, error: fetchErr } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('id, meta')
    .eq('id', tokenId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (fetchErr || !token) {
    console.warn(`[captain-assign] token ${tokenId} not found for ${restaurantId}`);
    return null;
  }

  const existingId = token.meta?.captain_id;
  if (existingId) {
    const { data: existing } = await supabaseAdmin
      .from('employees')
      .select('id, full_name, whatsapp_number, phone, is_active')
      .eq('id', existingId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (existing?.is_active) {
      return {
        captain_id:   existing.id,
        captain_name: existing.full_name,
        whatsapp:     existing.whatsapp_number || existing.phone,
        already_assigned: true,
      };
    }
  }

  const meta = {
    ...(token.meta || {}),
    captain_id:          captain.id,
    captain_name:        captain.full_name,
    captain_assigned_at: new Date().toISOString(),
  };

  const { error: updateErr } = await supabaseAdmin
    .from('walk_in_tokens')
    .update({ meta })
    .eq('id', tokenId)
    .eq('restaurant_id', restaurantId);

  if (updateErr) {
    console.error(`[captain-assign] meta update failed: ${updateErr.message}`);
    return null;
  }

  return {
    captain_id:   captain.id,
    captain_name: captain.full_name,
    whatsapp:     captain.whatsapp_number || captain.phone,
    already_assigned: false,
  };
}

/**
 * Pick least-loaded active captain and persist on walk_in_tokens.meta.
 * Returns null if no captains are configured.
 */
async function autoAssignCaptainForTakeaway(restaurantId, tokenId) {
  const captains = await getActiveCaptains(restaurantId);
  if (!captains.length) {
    console.warn(`[captain-assign] No active captains with WhatsApp for ${restaurantId}`);
    return null;
  }

  const loads = await countOpenTakeawayLoads(
    restaurantId,
    captains.map((c) => c.id),
  );
  const captain = pickLeastLoadedCaptain(captains, loads);
  if (!captain) return null;

  return assignCaptainToToken(restaurantId, tokenId, captain);
}

function orderNumberToToken(orderNumber) {
  const on = String(orderNumber || '').trim();
  if (/^ORD-/i.test(on)) return `T-${on.slice(4)}`;
  if (/^T-/i.test(on)) return on;
  return null;
}

async function getCaptainContactForToken(restaurantId, tokenNumber) {
  const tid = orderNumberToToken(tokenNumber) || String(tokenNumber || '').trim();
  if (!tid || !restaurantId) return null;

  const { data: token } = await supabaseAdmin
    .from('walk_in_tokens')
    .select('meta, name, phone')
    .eq('id', tid)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (!token) return null;

  const captainId = token.meta?.captain_id;
  if (!captainId) return null;

  const { data: emp } = await supabaseAdmin
    .from('employees')
    .select('id, full_name, whatsapp_number, phone, is_active')
    .eq('id', captainId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (!emp || !emp.is_active) return null;

  const waResult = validateAndNormalizeWhatsApp(emp.whatsapp_number || emp.phone || '');
  if (!waResult.value) return null;

  return {
    captain_id:   emp.id,
    captain_name: emp.full_name,
    whatsapp:     waResult.value,
    customer_name: token.name,
    customer_phone: token.phone,
  };
}

async function notifyCaptainTakeawayReady({
  restaurantId,
  tokenNumber,
  orderNumber,
  customerName,
  customerPhone,
}) {
  const contact = await getCaptainContactForToken(restaurantId, tokenNumber);
  if (!contact) {
    console.warn(
      `[captain-ready] No captain on token ${tokenNumber} for restaurant ${restaurantId}`,
    );
    return false;
  }

  const displayToken = orderNumberToToken(tokenNumber) || tokenNumber;
  const portalUrl = `${process.env.FRONTEND_URL || 'https://app.autom8.works'}/dashboard/captain`;
  const body =
    `✅ *Takeaway ready for pickup* — Token *${displayToken}*\n` +
    `👤 Customer: ${customerName || contact.customer_name || 'Guest'}\n` +
    `📞 Phone: ${customerPhone || contact.customer_phone || '—'}\n` +
    `Order: ${orderNumber || '—'}\n` +
    `────────────────────\n` +
    `Hand over at the counter, then scan the receipt QR to mark collected.\n` +
    portalUrl;

  await sendWhatsAppMessage(contact.whatsapp, body, restaurantId);
  console.log(
    `[captain-ready] ✅ ${displayToken} → captain ${contact.captain_name} (${contact.whatsapp})`,
  );
  return true;
}

async function notifyCaptainTakeawayOrder({
  restaurantId,
  captain,
  tokenNumber,
  customerName,
  customerPhone,
  orderText,
  total,
  bookingTime,
}) {
  const waResult = validateAndNormalizeWhatsApp(captain.whatsapp || '');
  const wa = waResult.value || '';
  if (!wa) {
    console.warn(`[captain-assign] Captain ${captain.captain_name} has no WhatsApp number`);
    return false;
  }

  const portalUrl = `${process.env.FRONTEND_URL || 'https://app.autom8.works'}/dashboard/captain`;
  const body =
    `📦 *Takeaway Order* — Token *${tokenNumber}*\n` +
    `👤 Customer: ${customerName || 'Guest'}\n` +
    `📞 Phone: ${customerPhone || '—'}\n` +
    `🕐 ${bookingTime || '—'} IST\n` +
    `Order: ${orderText || '—'}\n` +
    `Total: ₹${Number(total || 0).toFixed(0)}\n` +
    `────────────────────\n` +
    `Coordinate pickup at the counter.\n${portalUrl}`;

  await sendWhatsAppMessage(wa, body, restaurantId);
  console.log(`[captain-assign] ✅ ${tokenNumber} → captain ${captain.captain_name} (${wa})`);
  return true;
}

/**
 * Assign (if needed) and WhatsApp-notify the captain for a takeaway order.
 */
async function assignAndNotifyCaptainTakeaway({
  restaurantId,
  tokenNumber,
  customerName,
  customerPhone,
  orderText,
  total,
  bookingTime,
}) {
  const assignment = await autoAssignCaptainForTakeaway(restaurantId, tokenNumber);
  if (!assignment) {
    return { assigned: false, notified: false, captain_name: null, captain_id: null };
  }

  let notified = false;
  if (!assignment.already_assigned) {
    notified = await notifyCaptainTakeawayOrder({
      restaurantId,
      captain: assignment,
      tokenNumber,
      customerName,
      customerPhone,
      orderText,
      total,
      bookingTime,
    });
  } else {
    console.log(
      `[captain-assign] ${tokenNumber} already has captain ${assignment.captain_name}`,
    );
  }

  return {
    assigned:     true,
    notified,
    captain_id:   assignment.captain_id,
    captain_name: assignment.captain_name,
    display_name: captainDisplayName(assignment.captain_name),
  };
}

module.exports = {
  assignAndNotifyCaptainTakeaway,
  autoAssignCaptainForTakeaway,
  captainDisplayName,
  notifyCaptainTakeawayReady,
  orderNumberToToken,
};
