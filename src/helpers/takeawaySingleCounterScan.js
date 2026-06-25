// Single-counter takeaway QR collection — no Supabase RPC required.

'use strict';

const { supabaseAdmin } = require('../config/supabase');

function formatTimeAgo(iso) {
  if (!iso) return 'earlier';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hr${hrs !== 1 ? 's' : ''} ago`;
}

function formatHumanTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function mapOrderItems(order) {
  return (order.order_items || []).map((oi) => ({
    name:       oi.menu_item?.name ?? 'Item',
    quantity:   oi.quantity,
    line_total: Number(oi.unit_price || 0) * Number(oi.quantity || 1),
  }));
}

function buildOrderPayload(order, staffId, counterId, collectedAt) {
  return {
    order_number: order.order_number,
    total_amount: order.total_amount,
    items:        mapOrderItems(order),
    collected_at: collectedAt,
    collected_by: staffId,
    counter_id:   counterId,
  };
}

function isAlreadyCollected(order) {
  if (!order) return false;
  if (order.collected_at) return true;
  return String(order.takeaway_status || '').toLowerCase() === 'collected';
}

function buildAlreadyCollectedAlert(order) {
  return {
    collected_at:       order.collected_at,
    collected_at_human: formatHumanTime(order.collected_at),
    time_ago:           formatTimeAgo(order.collected_at),
    collected_by:       order.collected_by,
    collected_counter:  order.collected_counter,
  };
}

async function fetchOrderForScan(restaurantId, orderId) {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select(`
      id, order_number, status, total_amount, source,
      takeaway_status, collected_at, collected_by, collected_counter,
      order_items (
        quantity, unit_price,
        menu_item:menu_item_id ( name )
      )
    `)
    .eq('id', orderId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * @returns {{ status: number, body: object }}
 */
async function runSingleCounterTakeawayScan(restaurantId, { order_id, staff_id, counter_id }) {
  const staffId   = String(staff_id).trim();
  const counterId = String(counter_id).trim();

  let order;
  try {
    order = await fetchOrderForScan(restaurantId, order_id);
  } catch (err) {
    console.error('[takeaway/single] load order:', err.message);
    return {
      status: 500,
      body: { error: 'Scan processing failed. Please retry.' },
    };
  }

  if (!order) {
    return {
      status: 404,
      body: {
        success: false,
        code:    'ORDER_NOT_FOUND',
        message: 'Order not found',
        display: {
          screen: 'INVALID',
          heading: '❓ Invalid QR',
          subheading: 'Order not found',
        },
      },
    };
  }

  if (isAlreadyCollected(order)) {
    const alert = buildAlreadyCollectedAlert(order);
    return {
      status: 409,
      body: {
        success: false,
        code:    'ALREADY_COLLECTED',
        mode:    'single_counter',
        message: 'This order was already collected',
        alert,
      },
    };
  }

  const collectedAt = new Date().toISOString();
  const patch = {
    takeaway_status:   'collected',
    collected_at:      collectedAt,
    collected_by:      staffId,
    collected_counter: counterId,
    status:            'completed',
    updated_at:        collectedAt,
  };

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('orders')
    .update(patch)
    .eq('id', order_id)
    .eq('restaurant_id', restaurantId)
    .is('collected_at', null)
    .select('id')
    .maybeSingle();

  if (updateErr) {
    console.error('[takeaway/single] update failed:', updateErr.message);
    if (/collected_|takeaway_status/i.test(updateErr.message)) {
      return {
        status: 500,
        body: {
          error: 'Takeaway collection columns missing. Run migrations/add_takeaway_collection_columns.sql in Supabase.',
        },
      };
    }
    return {
      status: 500,
      body: { error: 'Scan processing failed. Please retry.' },
    };
  }

  if (!updated) {
    let refreshed;
    try {
      refreshed = await fetchOrderForScan(restaurantId, order_id);
    } catch (_) {
      refreshed = null;
    }
    if (isAlreadyCollected(refreshed)) {
      const alert = buildAlreadyCollectedAlert(refreshed);
      return {
        status: 409,
        body: {
          success: false,
          code:    'ALREADY_COLLECTED',
          mode:    'single_counter',
          message: 'This order was already collected',
          alert,
        },
      };
    }
    return {
      status: 503,
      body: {
        success: false,
        code:    'LOCK_CONTENTION',
        message: 'Another counter is processing this scan. Please retry.',
        retry_after_ms: 600,
        display: {
          screen: 'RETRY',
          heading: '⚠️ Please Retry',
          subheading: 'Another counter is processing this scan. Please retry.',
        },
      },
    };
  }

  const orderPayload = buildOrderPayload(order, staffId, counterId, collectedAt);
  return {
    status: 200,
    body: {
      success: true,
      code:    'COLLECTED',
      mode:    'single_counter',
      order:   orderPayload,
    },
  };
}

module.exports = {
  runSingleCounterTakeawayScan,
  formatTimeAgo,
  formatHumanTime,
};
