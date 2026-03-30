const express = require('express');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { body, param, query: qV, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog, getEmployeeAuditTrail } = require('../utils/auditLog');

const router = express.Router();
// All routes require auth
router.use(requireAuth);

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ── GET /api/employees ────────────────────────────────────────────────────
// List all employees for the company, with optional filters
router.get('/', async (req, res) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query;
    const conditions = ['e.company_id = $1', 'e.active = true'];
    const params = [req.companyId];
    let i = 2;

    if (search) {
      conditions.push(`(
        e.first_name ILIKE $${i} OR e.last_name ILIKE $${i} OR e.email ILIKE $${i}
      )`);
      params.push(`%${search}%`);
      i++;
    }

    if (status === 'complete') {
      conditions.push(`e.w4_status = 'completed' AND e.i9_status = 'completed'`);
    } else if (status === 'pending') {
      conditions.push(`(e.w4_status = 'pending' OR e.i9_status = 'pending')`);
    } else if (status === 'todo') {
      conditions.push(`e.w4_status = 'not_started' AND e.i9_status = 'not_started'`);
    }

    params.push(parseInt(limit), parseInt(offset));

    const result = await query(
      `SELECT
         e.id, e.first_name, e.last_name, e.email, e.job_title, e.department,
         e.w4_status, e.i9_status, e.w4_completed_at, e.i9_completed_at,
         e.created_at AS invited_at,
         u.first_name || ' ' || u.last_name AS invited_by_name
       FROM employees e
       LEFT JOIN users u ON u.id = e.invited_by
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    );

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) FROM employees e
       WHERE ${conditions.slice(0, -0).join(' AND ')}`,
      params.slice(0, -2)
    );

    res.json({
      employees: result.rows,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (err) {
    console.error('List employees error:', err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// ── GET /api/employees/stats ──────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE active = true)                                  AS total,
         COUNT(*) FILTER (WHERE w4_status='completed' AND i9_status='completed') AS fully_complete,
         COUNT(*) FILTER (WHERE w4_status='pending' OR i9_status='pending')      AS in_progress,
         COUNT(*) FILTER (WHERE w4_status='not_started' AND i9_status='not_started') AS not_started,
         COUNT(*) FILTER (WHERE w4_status='completed')                           AS w4_complete,
         COUNT(*) FILTER (WHERE i9_status='completed')                           AS i9_complete
       FROM employees
       WHERE company_id = $1 AND active = true`,
      [req.companyId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── GET /api/employees/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT
         e.*,
         u.first_name || ' ' || u.last_name AS invited_by_name
       FROM employees e
       LEFT JOIN users u ON u.id = e.invited_by
       WHERE e.id = $1 AND e.company_id = $2`,
      [req.params.id, req.companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch employee' });
  }
});

// ── POST /api/employees/invite ────────────────────────────────────────────
router.post('/invite', [
  body('firstName').trim().notEmpty().withMessage('First name required'),
  body('lastName').trim().notEmpty().withMessage('Last name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('jobTitle').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { firstName, lastName, email, jobTitle, department, startDate } = req.body;

  try {
    // Check for duplicate in this company
    const existing = await query(
      `SELECT id FROM employees WHERE company_id = $1 AND email = $2`,
      [req.companyId, email]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An employee with this email already exists' });
    }

    const empId = uuid();
    const tokenValue = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(
      Date.now() + (parseInt(process.env.INVITE_TOKEN_EXPIRES_HOURS) || 72) * 3600 * 1000
    );

    const client = await require('../db/pool').getClient();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO employees
           (id, company_id, invited_by, first_name, last_name, email, job_title, department, start_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [empId, req.companyId, req.user.id, firstName, lastName, email, jobTitle, department, startDate || null]
      );

      await client.query(
        `INSERT INTO invite_tokens (employee_id, company_id, token, expires_at)
         VALUES ($1,$2,$3,$4)`,
        [empId, req.companyId, tokenValue, expiresAt]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const inviteUrl = `${process.env.APP_BASE_URL}/onboard?token=${tokenValue}`;

    await auditLog({
      companyId: req.companyId,
      employeeId: empId,
      userId: req.user.id,
      action: 'employee.invited',
      entityType: 'employee', entityId: empId,
      ipAddress: getClientIP(req),
      metadata: { email, firstName, lastName, jobTitle, inviteUrl },
    });

    res.status(201).json({
      employee: { id: empId, firstName, lastName, email, jobTitle },
      inviteUrl,
      expiresAt,
      message: `Invite created. In production, send inviteUrl via email to ${email}.`,
    });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// ── POST /api/employees/:id/resend-invite ────────────────────────────────
router.post('/:id/resend-invite', async (req, res) => {
  try {
    const empResult = await query(
      `SELECT * FROM employees WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.companyId]
    );
    if (!empResult.rows.length) return res.status(404).json({ error: 'Employee not found' });

    const emp = empResult.rows[0];

    // Revoke old tokens
    await query(
      `UPDATE invite_tokens SET revoked = true WHERE employee_id = $1 AND used_at IS NULL`,
      [emp.id]
    );

    const tokenValue = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 3600 * 1000);
    await query(
      `INSERT INTO invite_tokens (employee_id, company_id, token, expires_at) VALUES ($1,$2,$3,$4)`,
      [emp.id, req.companyId, tokenValue, expiresAt]
    );

    const inviteUrl = `${process.env.APP_BASE_URL}/onboard?token=${tokenValue}`;

    await auditLog({
      companyId: req.companyId, employeeId: emp.id, userId: req.user.id,
      action: 'employee.invite_resent',
      entityType: 'invite',
      ipAddress: getClientIP(req),
      metadata: { email: emp.email, inviteUrl },
    });

    res.json({ inviteUrl, expiresAt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend invite' });
  }
});

// ── GET /api/employees/:id/audit ─────────────────────────────────────────
router.get('/:id/audit', async (req, res) => {
  try {
    const trail = await getEmployeeAuditTrail(req.params.id, req.companyId);
    res.json({ auditTrail: trail });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit trail' });
  }
});

// ── DELETE /api/employees/:id ─────────────────────────────────────────────
// Soft delete (sets active=false; data retained for compliance)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE employees SET active = false, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Employee not found' });

    await auditLog({
      companyId: req.companyId, employeeId: req.params.id, userId: req.user.id,
      action: 'employee.deactivated',
      entityType: 'employee', entityId: req.params.id,
      ipAddress: getClientIP(req),
    });

    res.json({ message: 'Employee deactivated. Records retained for compliance.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate employee' });
  }
});

module.exports = router;
