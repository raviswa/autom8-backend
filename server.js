// server.js
// ============================================================================
// Autom8 Backend — Express bootstrap
//
// This file is intentionally lean. All business logic lives in:
//   src/routes/       — HTTP handlers
//   src/helpers/      — Shared utilities (whatsapp, feedback, resolveRestaurant)
//   src/schedulers/   — Background jobs
//   src/handlers/     — WhatsApp event handlers (waHandlers.js)
//   src/middleware/   — Auth, region
// ============================================================================

'use strict';

const http    = require('http');
const express = require('express');
const cors    = require('cors');

const { startAllSchedulers } = require('./src/schedulers/index');
const { attachWebSocketServer } = require('./src/websocket');
const { handleInternalMenuItems, menuUploadMiddleware } = require('./src/routes/catalog');
const { logKdsSecretStatus } = require('./src/config/internalSecret');

if (process.env.NODE_ENV === 'production' && !process.env.AUTOM8_KDS_SECRET) {
  throw new Error('AUTOM8_KDS_SECRET must be set in production');
}

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://app.autom8.works',
    'http://localhost:5173',
    process.env.FRONTEND_URL,
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

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/auth',        require('./src/routes/auth'));
app.use('/api/dashboard',   require('./src/routes/dashboard'));
app.use('/api/marketing',   require('./src/routes/marketing'));
app.use('/api/restaurants', require('./src/routes/marketing'));    // WABAStrip compat

// ── NEW: brands must be before /api (pos router) to avoid prefix conflict ──
app.use('/api/brands',      require('./src/routes/brands'));

// ── Specific /api sub-paths (must come before the catch-all pos router) ──────
app.use('/api/kds',         require('./src/routes/kds'));          // FULL kds/notify
app.use('/api/catalog',     require('./src/routes/catalog'));      // catalog sync + feed + menu upload
app.post('/api/menu/upload', ...menuUploadMiddleware);             // Manager portal Excel upload alias
app.get('/api/internal/menu-items', handleInternalMenuItems);      // Python chat menu cache
app.use('/api/tokens',      require('./src/routes/tokens'));
app.use('/api/feedback',    require('./src/routes/feedback'));
app.use('/api/referrals',   require('./src/routes/referrals'));
app.use('/api/delivery',    require('./src/routes/delivery'));
app.use('/api/enterprise',  require('./src/routes/enterprise'));
app.use('/api/invoices',    require('./src/routes/invoices'));
app.use('/api/subscription',require('./src/routes/subscription')); // replaces hardcoded stub

// ── POS router (catch-all for /api/*) — must be last under /api ──────────────
app.use('/api',             require('./src/routes/pos'));

app.use('/api/onboarding',  require('./src/routes/onboarding'));
app.use('/api/whatsapp',    require('./src/routes/webhook'));
app.use('/api/v1/takeaway', require('./src/routes/takeaway'));
app.use('/api/staff',       require('./src/routes/staff'));

// ── Receipt + order verification (public HTML pages) ─────────────────────────
app.use('/',                require('./src/routes/receipts'));     // /verify/:id  + /r/:token


//───────────────────────── Restaurant discovery tool─────────────────────────
app.use('/api/discovery', require('./src/routes/discovery'));
// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
    region:    process.env.REGION || 'IN',
    commit:    process.env.RAILWAY_GIT_COMMIT_SHA || null,
    kds:       'orders.notes',
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const server = http.createServer(app);
attachWebSocketServer(server);

server.listen(PORT, () => {
  logKdsSecretStatus();
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown';
  console.log(`[boot] commit=${sha} | kds orders column=notes`);
  console.log(`🚀 Autom8 Backend running on port ${PORT}`);
  console.log(`📍 Region: ${process.env.REGION || 'IN'}`);
  console.log(`🗄️  Database: ${process.env.SUPABASE_URL}`);
  startAllSchedulers();
});
