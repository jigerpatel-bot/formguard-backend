/**
 * FormGuard — Employee Profile Routes
 *
 * GET    /api/profiles/:employeeId          — get full profile
 * PUT    /api/profiles/:employeeId          — create or update profile
 * GET    /api/profiles/:employeeId/emergency-contacts
 * POST   /api/profiles/:employeeId/emergency-contacts
 * PUT    /api/profiles/:employeeId/emergency-contacts/:contactId
 * DELETE /api/profiles/:employeeId/emergency-contacts/:contactId
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/auditLog');

const router = express.Router();
router.use(requireAuth);

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ── Guard: employee must belong to this company ───────────────────────────
const verifyEmployeeOwnership = async (employeeId, companyId) => {
  const result = await query(
    `SELECT id FROM employees WHERE id = $1 AND company_id = $2 AND active = true`,
    [employeeId, companyId]
  );
  return result.rows.length > 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/profiles/:employeeId
router.get('/:employeeId', async (req, res) => {
  try {
    if (!await verifyEmployeeOwnership(req.params.employeeId, req.companyId)) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const [empResult, profileResult, contactsResult, deptResult] = await Promise.all([
      query(
        `SELECT e.*, d.name AS department_name
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.id = $1 AND e.company_id = $2`,
        [req.params.employeeId, req.companyId]
      ),
      query(
        `SELECT p.*, d.name AS department_name
         FROM employee_profiles p
         LEFT JOIN departments d ON d.id = p.department_id
         WHERE p.employee_id = $1`,
        [req.params.employeeId]
      ),
      query(
        `SELECT * FROM emergency_contacts
         WHERE employee_id = $1
         ORDER BY is_primary DESC, created_at ASC`,
        [req.params.employeeId]
      ),
      query(
        `SELECT id, name FROM departments
         WHERE company_id = $1 AND active = true ORDER BY name`,
        [req.companyId]
      ),
    ]);

    // If terminated, include termination record (admin only)
    let termination = null;
    if (req.user.role === 'admin' && empResult.rows[0]?.employment_status === 'terminated') {
      const termResult = await query(
        `SELECT tr.*, u.first_name || ' ' || u.last_name AS terminated_by_name
         FROM termination_records tr
         LEFT JOIN users u ON u.id = tr.terminated_by
         WHERE tr.employee_id = $1`,
        [req.params.employeeId]
      );
      termination = termResult.rows[0] || null;
    }

    res.json({
      employee:          empResult.rows[0] || null,
      profile:           profileResult.rows[0] || null,
      emergencyContacts: contactsResult.rows,
      departments:       deptResult.rows,
      termination,
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PUT /api/profiles/:employeeId  — upsert profile
router.put('/:employeeId', [
  body('phone').optional().trim(),
  body('employmentType').optional().isIn(['full_time','part_time','contractor','temp']),
  body('startDate').optional().isISO8601(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  if (!await verifyEmployeeOwnership(req.params.employeeId, req.companyId)) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  const {
    phone, dob, address, city, state, zip,
    departmentId, managerName, employmentType, startDate, hrNotes,
  } = req.body;

  // HR notes only writable by admin/hr
  const canWriteNotes = ['admin','hr'].includes(req.user.role);

  try {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Upsert profile
      await client.query(
        `INSERT INTO employee_profiles
           (employee_id, company_id, phone, dob, address, city, state, zip,
            department_id, manager_name, employment_type, start_date, hr_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (employee_id) DO UPDATE SET
           phone           = COALESCE(EXCLUDED.phone, employee_profiles.phone),
           dob             = COALESCE(EXCLUDED.dob, employee_profiles.dob),
           address         = COALESCE(EXCLUDED.address, employee_profiles.address),
           city            = COALESCE(EXCLUDED.city, employee_profiles.city),
           state           = COALESCE(EXCLUDED.state, employee_profiles.state),
           zip             = COALESCE(EXCLUDED.zip, employee_profiles.zip),
           department_id   = COALESCE(EXCLUDED.department_id, employee_profiles.department_id),
           manager_name    = COALESCE(EXCLUDED.manager_name, employee_profiles.manager_name),
           employment_type = COALESCE(EXCLUDED.employment_type, employee_profiles.employment_type),
           start_date      = COALESCE(EXCLUDED.start_date, employee_profiles.start_date),
           hr_notes        = CASE WHEN $14 THEN COALESCE(EXCLUDED.hr_notes, employee_profiles.hr_notes)
                             ELSE employee_profiles.hr_notes END,
           updated_at      = NOW()`,
        [
          req.params.employeeId, req.companyId,
          phone || null, dob || null, address || null, city || null, state || null, zip || null,
          departmentId || null, managerName || null, employmentType || null, startDate || null,
          canWriteNotes ? (hrNotes || null) : null,
          canWriteNotes,
        ]
      );

      // Sync department_id to employees table too
      if (departmentId) {
        await client.query(
          `UPDATE employees SET department_id = $1 WHERE id = $2`,
          [departmentId, req.params.employeeId]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: 'profile.updated', entityType: 'employee', entityId: req.params.employeeId,
      ipAddress: getClientIP(req),
    });

    res.json({ success: true, message: 'Profile updated.' });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY CONTACTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/profiles/:employeeId/emergency-contacts
router.get('/:employeeId/emergency-contacts', async (req, res) => {
  if (!await verifyEmployeeOwnership(req.params.employeeId, req.companyId)) {
    return res.status(404).json({ error: 'Employee not found' });
  }
  const result = await query(
    `SELECT * FROM emergency_contacts WHERE employee_id = $1 ORDER BY is_primary DESC, created_at ASC`,
    [req.params.employeeId]
  );
  res.json({ contacts: result.rows });
});

// POST /api/profiles/:employeeId/emergency-contacts
router.post('/:employeeId/emergency-contacts', [
  body('fullName').trim().notEmpty().withMessage('Full name required'),
  body('relationship').trim().notEmpty().withMessage('Relationship required'),
  body('phonePrimary').trim().notEmpty().withMessage('Primary phone required'),
  body('email').optional().isEmail().normalizeEmail(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  if (!await verifyEmployeeOwnership(req.params.employeeId, req.companyId)) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  const { fullName, relationship, phonePrimary, phoneAlt, email, isPrimary } = req.body;

  try {
    // If marking as primary, unmark others first
    if (isPrimary) {
      await query(
        `UPDATE emergency_contacts SET is_primary = false WHERE employee_id = $1`,
        [req.params.employeeId]
      );
    }

    const result = await query(
      `INSERT INTO emergency_contacts
         (employee_id, company_id, full_name, relationship, phone_primary, phone_alt, email, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.params.employeeId, req.companyId, fullName, relationship, phonePrimary, phoneAlt || null, email || null, isPrimary || false]
    );

    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: 'emergency_contact.added', entityType: 'employee',
      ipAddress: getClientIP(req),
      metadata: { contactName: fullName },
    });

    res.status(201).json({ contact: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add emergency contact' });
  }
});

// PUT /api/profiles/:employeeId/emergency-contacts/:contactId
router.put('/:employeeId/emergency-contacts/:contactId', async (req, res) => {
  if (!await verifyEmployeeOwnership(req.params.employeeId, req.companyId)) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  const { fullName, relationship, phonePrimary, phoneAlt, email, isPrimary } = req.body;

  try {
    if (isPrimary) {
      await query(
        `UPDATE emergency_contacts SET is_primary = false WHERE employee_id = $1`,
        [req.params.employeeId]
      );
    }

    const result = await query(
      `UPDATE emergency_contacts SET
         full_name     = COALESCE($1, full_name),
         relationship  = COALESCE($2, relationship),
         phone_primary = COALESCE($3, phone_primary),
         phone_alt     = $4,
         email         = $5,
         is_primary    = COALESCE($6, is_primary),
         updated_at    = NOW()
       WHERE id = $7 AND employee_id = $8
       RETURNING *`,
      [fullName, relationship, phonePrimary, phoneAlt || null, email || null, isPrimary, req.params.contactId, req.params.employeeId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json({ contact: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/profiles/:employeeId/emergency-contacts/:contactId
router.delete('/:employeeId/emergency-contacts/:contactId', async (req, res) => {
  if (!await verifyEmployeeOwnership(req.params.employeeId, req.companyId)) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  const result = await query(
    `DELETE FROM emergency_contacts WHERE id = $1 AND employee_id = $2 RETURNING id`,
    [req.params.contactId, req.params.employeeId]
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEPARTMENTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/profiles/departments  — list all departments for this company
router.get('/departments/list', async (req, res) => {
  try {
    const result = await query(
      `SELECT d.*, COUNT(e.id) AS employee_count
       FROM departments d
       LEFT JOIN employees e ON e.department_id = d.id AND e.active = true AND e.employment_status = 'active'
       WHERE d.company_id = $1 AND d.active = true
       GROUP BY d.id
       ORDER BY d.name`,
      [req.companyId]
    );
    res.json({ departments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch departments' });
  }
});

// POST /api/profiles/departments
router.post('/departments/create', requireRole('admin', 'hr'), [
  body('name').trim().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const result = await query(
      `INSERT INTO departments (company_id, name, description)
       VALUES ($1,$2,$3) RETURNING *`,
      [req.companyId, req.body.name, req.body.description || null]
    );
    res.status(201).json({ department: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Department already exists' });
    res.status(500).json({ error: 'Failed to create department' });
  }
});

module.exports = router;
