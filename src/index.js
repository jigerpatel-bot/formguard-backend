/**
 * FormGuard Backend — Express Server
 * Start: npm run dev
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes         = require('./routes/auth');
const businessRoutes     = require('./routes/businesses');
const employeeRoutes     = require('./routes/employees');
const formRoutes         = require('./routes/forms');
const auditRoutes        = require('./routes/audit');
const signatureRoutes    = require('./routes/signatures');
const webhookRoutes      = require('./routes/webhooks');
const profileRoutes      = require('./routes/profiles');
const terminationRoutes  = require('./routes/terminations');
const demographicsRoutes = require('./routes/demographics');
const complianceRoutes   = require('./routes/compliance');
const onboardingRoutes   = require('./routes/onboarding');
const writeupsRoutes     = require('./routes/writeups');
const timelineRoutes     = require('./routes/timeline');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security Middleware ───────────────────────────────────────────────────
app.use(helmet());

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,                  // stricter for auth endpoints
  message: { error: 'Too many login attempts, please try again later.' },
});

app.use(limiter);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',         authLimiter, authRoutes);
app.use('/api/businesses',   businessRoutes);
app.use('/api/employees',    employeeRoutes);
app.use('/api/forms',        formRoutes);
app.use('/api/signatures',   signatureRoutes);
app.use('/api/audit',        auditRoutes);
app.use('/api/webhooks',     webhookRoutes);
app.use('/api/profiles',     profileRoutes);
app.use('/api/terminations', terminationRoutes);
app.use('/api/demographics', demographicsRoutes);
app.use('/api/compliance',   complianceRoutes);
app.use('/api/onboarding',   onboardingRoutes);
app.use('/api/writeups',     writeupsRoutes);
app.use('/api/timeline',     timelineRoutes);

// ── Health Check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'FormGuard API',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
  });
});

// ── 404 Handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global Error Handler ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   FormGuard API running on :${PORT}    ║
  ║   ENV: ${(process.env.NODE_ENV || 'development').padEnd(28)}║
  ╚══════════════════════════════════════╝

  Endpoints:
    POST /api/auth/register
    POST /api/auth/login
    GET  /api/auth/me
    GET  /api/employees
    POST /api/employees/invite
    GET  /api/employees/stats
    POST /api/forms/w4
    POST /api/forms/i9/section1
    POST /api/forms/i9/:id/section2
    GET  /api/audit
    GET  /api/audit/export
    GET  /health
  `);
});

module.exports = app;
