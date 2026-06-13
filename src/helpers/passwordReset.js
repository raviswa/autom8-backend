'use strict';

const { supabase } = require('../config/supabase');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.autom8.works';

async function sendPasswordResetEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('Email is required');

  const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
    redirectTo: `${FRONTEND_URL}/reset-password`,
  });
  if (error) throw error;
  return true;
}

module.exports = { sendPasswordResetEmail, FRONTEND_URL };
