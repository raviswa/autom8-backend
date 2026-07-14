'use strict';

const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../config/supabase');

const PROBE_ID = '__schema_probe_scheduled_delivery__';
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/**
 * Reads every migrations/*.sql file and extracts (table, column, sourceFile)
 * for each `ALTER TABLE x ADD COLUMN IF NOT EXISTS y` statement.
 * This is how we know, generically, which columns the *code* now assumes
 * exist — without hand-maintaining a separate list that goes stale.
 */
function parseMigrationColumns() {
  const byTable = new Map(); // table -> Map(column -> sourceFile)

  let files = [];
  try {
    files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  } catch (e) {
    console.error('[boot] schema check: could not read migrations dir:', e.message);
    return byTable;
  }

  const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/gi;

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    let match;
    while ((match = alterRe.exec(sql)) !== null) {
      const [, table, column] = match;
      if (!byTable.has(table)) byTable.set(table, new Map());
      byTable.get(table).set(column, file);
    }
  }

  return byTable;
}

/**
 * Boot-time check: for every table touched by a migration file, confirm the
 * live DB (whatever SUPABASE_URL points at) actually has every column that
 * file says it added. Catches the "migration file exists in the repo but
 * was never run against this Supabase project" failure mode — the same one
 * that caused the webcart 500s (missing tenants.postal_code).
 *
 * Never throws — logs loudly and returns { ok, missing } so callers can
 * decide whether to hard-fail (see STRICT_SCHEMA_CHECK below).
 */
async function verifyMigrationColumns() {
  const byTable = parseMigrationColumns();
  const missing = [];        // { table, column, file }
  const missingTables = [];  // { table, files }

  const isMissingRelation = (error) =>
    !!error && (error.code === '42P01' || /relation .* does not exist/i.test(error.message || '')
      || /could not find the table/i.test(error.message || ''));

  for (const [table, columnMap] of byTable.entries()) {
    const columns = [...columnMap.keys()];
    const { error } = await supabaseAdmin.from(table).select(columns.join(',')).limit(0);
    if (!error) continue; // whole set exists, nothing missing on this table

    if (isMissingRelation(error)) {
      // The table itself doesn't exist (dropped, renamed, or not yet created) —
      // report that once, don't bisect column-by-column (every column would
      // "fail" identically and falsely imply a column-level problem when the
      // real issue is the table name/existence).
      missingTables.push({ table, files: [...new Set(columnMap.values())] });
      continue;
    }

    // Something in this table's column set is missing — bisect to find
    // exactly which ones, since PostgREST only reports the first offender.
    for (const column of columns) {
      const probe = await supabaseAdmin.from(table).select(column).limit(0);
      if (probe.error && !isMissingRelation(probe.error)) {
        missing.push({ table, column, file: columnMap.get(column) });
      }
    }
  }

  if (missingTables.length || missing.length) {
    if (missingTables.length) {
      console.error('[boot] ❌ schema check found tables referenced in migrations that do not exist (renamed or dropped?):');
      for (const { table, files } of missingTables) {
        console.error(`[boot]    table "${table}" not found  ←  referenced in ${files.map((f) => `migrations/${f}`).join(', ')}`);
      }
    }
    if (missing.length) {
      console.error('[boot] ❌ schema check found columns the code expects but the DB is missing:');
      for (const { table, column, file } of missing) {
        console.error(`[boot]    ${table}.${column}  ←  run migrations/${file}`);
      }
    }
    console.error(`[boot]    Target DB: ${process.env.SUPABASE_URL || '(SUPABASE_URL not set)'}`);
  } else {
    console.log(`[boot] ✅ schema check passed — all migration-tracked columns present (${byTable.size} tables checked)`);
  }

  return { ok: missingTables.length === 0 && missing.length === 0, missing, missingTables };
}

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

module.exports = { verifyScheduledDeliveryTokenType, verifyMigrationColumns };
