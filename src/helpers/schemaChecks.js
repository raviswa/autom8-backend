'use strict';

const { supabaseAdmin } = require('../config/supabase');

const PROBE_ID = '__schema_probe_scheduled_delivery__';

/**
 * Insert + delete a scheduled_delivery row at boot so we know the live DB
 * accepts the type (catches migration applied in wrong Supabase project).
 */
async function verifyScheduledDeliveryTokenType() {
  const restaurantId = process.env.SCHEMA_PROBE_RESTAURANT_ID
    || '46fb9b9e-431a-43c9-9edb-d316b0fef216';

  const { error } = await supabaseAdmin.from('walk_in_tokens').insert({
    id:            PROBE_ID,
    restaurant_id: restaurantId,
    name:          'schema-probe',
    type:          'scheduled_delivery',
    pax:           1,
    status:        'pending_approval',
    meta:          {},
  });

  if (error) {
    console.error(
      '[boot] ❌ walk_in_tokens rejects scheduled_delivery on THIS Supabase project:',
      error.message,
    );
    console.error(
      '[boot]    Run migrations/fix_walk_in_tokens_scheduled_delivery_check.sql in the SQL editor',
      `for ${process.env.SUPABASE_URL || '(SUPABASE_URL not set)'}`,
    );
    return false;
  }

  await supabaseAdmin.from('walk_in_tokens').delete().eq('id', PROBE_ID);
  console.log('[boot] ✅ walk_in_tokens accepts scheduled_delivery');
  return true;
}

module.exports = { verifyScheduledDeliveryTokenType };
