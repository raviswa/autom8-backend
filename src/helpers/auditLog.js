'use strict';

const { supabaseAdmin } = require('../config/supabase');

/** Best-effort audit log write — never throws. */
async function writeAuditLog(entry) {
  try {
    const { error } = await supabaseAdmin.from('audit_logs').insert(entry);
    if (error) console.warn('[audit_log]', error.message);
  } catch (err) {
    console.warn('[audit_log]', err.message);
  }
}

module.exports = { writeAuditLog };
