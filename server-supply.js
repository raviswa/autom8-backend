// server-supply.js
// ============================================================================
// Munafe Supply Backend — Express bootstrap (separate Railway deployment)
//
// This is the entry point for the autom8-supply Railway service.
// It loads ONLY supply routes — zero restaurant/POS code is touched.
//
// The core restaurant backend (server.js) runs as a separate Railway service
// with all /api/supply/* routes removed.
//
// Shared infrastructure reused from src/:
//   src/config/supabase.js   — same Supabase project, supply_* tables
//   src/middleware/auth.js   — same Supabase JWT verification
//   src/middleware/supplyAuth.js  — supplier context middleware
//   src/middleware/region.js — region header (harmless to keep)
// ============================================================================

'use strict';

const http    = require('http');
const express = require('express');
const cors    = require('cors');

const { supabaseAdmin } = require('./src/config/supabase');

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow the same frontends as the core backend.
// Add your supply frontend URL to SUPPLY_FRONTEND_URL env var in Railway
// if it differs from the main frontend.
app.use(cors({
  origin: [
    'https://app.autom8.works',
    'http://localhost:5173',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    process.env.FRONTEND_URL,
    process.env.SUPPLY_FRONTEND_URL,
  ].filter(Boolean),
  methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-restaurant-id', 'x-internal-secret'],
  credentials:    true,
}));
app.options('*', cors());

// ── Body parser ───────────────────────────────────────────────────────────────
app.use(express.json());

// ── Region middleware ─────────────────────────────────────────────────────────
app.use(require('./src/middleware/region'));

// ── Supply routes ─────────────────────────────────────────────────────────────
app.use('/api/supply/auth',           require('./src/routes/supply/auth'));
app.use('/api/supply/clients',        require('./src/routes/supply/clients'));
app.use('/api/supply/catalog',        require('./src/routes/supply/catalog'));
app.use('/api/supply/ratecards',      require('./src/routes/supply/ratecards'));
app.use('/api/supply/form',           require('./src/routes/supply/form'));
app.use('/api/supply/orders',         require('./src/routes/supply/orders'));
app.use('/api/supply/ledger',         require('./src/routes/supply/ledger'));
app.use('/api/supply/payment-claims', require('./src/routes/supply/payment-claims'));
app.use('/api/supply/invoices',       require('./src/routes/supply/invoices'));
app.use('/api/supply/statements',     require('./src/routes/supply/statements'));
app.use('/api/supply/notify',         require('./src/routes/supply/notify'));
app.use('/api/supply/webhook',        require('./src/routes/supply/webhook'));
app.use('/api/supply/scheduler',      require('./src/routes/supply/scheduler'));
app.use('/api/supply/whatsapp',       require('./src/routes/supply/supplyWhatsapp'));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbProbe = 'ok';
  try {
    const { error } = await supabaseAdmin.from('suppliers').select('id').limit(1);
    if (error) dbProbe = error.message;
  } catch (e) {
    dbProbe = e.message;
  }
  res.json({
    status:    dbProbe === 'ok' ? 'ok' : 'degraded',
    service:   'autom8-supply',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
    region:    process.env.REGION || 'IN',
    commit:    process.env.RAILWAY_GIT_COMMIT_SHA || null,
    db_probe:  dbProbe,
  });
});

// ── 404 for anything not supply ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found on supply service' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
const server = http.createServer(app);

server.listen(PORT, () => {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown';
  console.log(`[boot] commit=${sha}`);
  console.log(`📦 Munafe Supply Backend running on port ${PORT}`);
  console.log(`📍 Region: ${process.env.REGION || 'IN'}`);
  console.log(`🗄️  Database: ${process.env.SUPABASE_URL}`);
});
