const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../utils/auditLog');

const router = express.Router();

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ── POST /api/auth/register ───────────────────────────────────────────────
// Create a new company + admin user
router.post('/register', [
  body('companyName').trim().notEmpty().withMessage('Company name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('firstName').trim().notEmpty().withMessage('First name required'),
  body('lastName').trim().notEmpty().withMessage('Last name required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { companyName, email, password, firstName, lastName } = req.body;

  try {
    // Check if email already exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const companyId = uuid();
    const userId = uuid();
    const passwordHash = await bcrypt.hash(password, 12);

    // Create company + user in a transaction
    const client = await require('../db/pool').getClient();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO companies (id, name) VALUES ($1, $2)`,
        [companyId, companyName]
      );

      await client.query(
        `INSERT INTO users (id, company_id, email, password_hash, first_name, last_name, role)
         VALUES ($1,$2,$3,$4,$5,$6,'admin')`,
        [userId, companyId, email, passwordHash, firstName, lastName]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const token = jwt.sign(
      { userId, companyId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    await auditLog({
      companyId, userId,
      action: 'user.registered',
      entityType: 'user', entityId: userId,
      ipAddress: getClientIP(req),
      metadata: { email, companyName },
    });

    res.status(201).json({
      token,
      user: { id: userId, email, firstName, lastName, role: 'admin' },
      company: { id: companyId, name: companyName },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;

  try {
    const result = await query(
      `SELECT u.*, c.name AS company_name, c.id AS company_id, c.plan
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.email = $1`,
      [email]
    );

    const user = result.rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    const token = jwt.sign(
      { userId: user.id, companyId: user.company_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    await auditLog({
      companyId: user.company_id,
      userId: user.id,
      action: 'user.login',
      entityType: 'user', entityId: user.id,
      ipAddress: getClientIP(req),
    });

    res.json({
      token,
      user: {
        id: user.id, email: user.email,
        firstName: user.first_name, lastName: user.last_name,
        role: user.role,
      },
      company: { id: user.company_id, name: user.company_name, plan: user.plan },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const { id, email, first_name, last_name, role, company_id, company_name, plan } = req.user;
  res.json({
    user: { id, email, firstName: first_name, lastName: last_name, role },
    company: { id: company_id, name: company_name, plan },
  });
});

module.exports = router;
