/**
 * FormGuard — Termination Module
 * Admin-only. All routes require role: admin.
 *
 * POST /api/terminations/:employeeId       — terminate an employee
 * GET  /api/terminations/:employeeId       — get termination record
 * PUT  /api/terminations/:employeeId       — update checklist / notes
 * GET  /api/terminations                   — list all terminated employees
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/auditLog');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

/**
 * Calculate I-9 retention deadline.
 * Federal law: later of (3 years from hire date) OR (1 year after termination date)
 */
const calculateI9RetentionDate = (hireDate, terminationDate) => {
  const hire = hireDate ? new Date(hireDate) : null;
  const term = new Date(terminationDate);

  const threeYearsFromHire = hire
    ? new Date(hire.setFullYear(hire.getFullYear() + 3))
    : null;

  const oneYearFromTerm = new Date(term);
  oneYearFromTerm.setFullYear(oneYearFromTerm.getFullYear() + 1);

  if (!threeYearsFromHire) return oneYearFromTerm;
  return threeYearsFromHire > oneYearFromTerm ? threeYearsFromHire : oneYearFromTerm;
};

// ── POST /api/terminations/:employeeId ────────────────────────────────────
router.post('/:employeeId', [
  body('terminationDate').isISO8601().withMessage('Valid termination date required'),
  body('terminationType')
    .isIn(['voluntary','involuntary','layoff','contract_end','retirement','death','other'])
    .withMessage('Invalid termination type'),
  body('reasonCategory').optional().trim(),
  body('privateNotes').optional().trim(),
  body('eligibleForRehire').optional().isBoolean(),
  body('referencePolicy').optional().isIn(['standard','no_comment','positive']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { employeeId } = req.params;

  try {
    // Verify employee belongs to this company and is active
    const empResult = await query(
      `SELECT e.*, p.start_date
       FROM employees e
       LEFT JOIN employee_profiles p ON p.employee_id = e.id
       WHERE e.id = $1 AND e.company_id = $2`,
      [employeeId, req.companyId]
    );

    if (!empResult.rows.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const emp = empResult.rows[0];

    if (emp.employment_status === 'terminated') {
      return res.status(409).json({ error: 'Employee is already terminated' });
    }

    const {
      terminationDate, terminationType, reasonCategory, privateNotes,
      eligibleForRehire = true, referencePolicy = 'standard',
    } = req.body;

    const i9RetainUntil = calculateI9RetentionDate(emp.start_date, terminationDate);

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Create termination record
      const termResult = await client.query(
        `INSERT INTO termination_records (
           employee_id, company_id, terminated_by,
           termination_date, termination_type, reason_category,
           private_notes, eligible_for_rehire, reference_policy,
           i9_retain_until
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          employeeId, req.companyId, req.user.id,
          terminationDate, terminationType, reasonCategory || null,
          privateNotes || null, eligibleForRehire, referencePolicy,
          i9RetainUntil.toISOString().slice(0, 10),
        ]
      );

      // Update employee status
      await client.query(
        `UPDATE employees
         SET employment_status = 'terminated', active = false, updated_at = NOW()
         WHERE id = $1`,
        [employeeId]
      );

      await client.query('COMMIT');

      await auditLog({
        companyId: req.companyId, employeeId, userId: req.user.id,
        action: 'employee.terminated',
        entityType: 'employee', entityId: employeeId,
        ipAddress: getClientIP(req),
        metadata: {
          terminationType,
          terminationDate,
          i9RetainUntil: i9RetainUntil.toISOString().slice(0, 10),
          // Do NOT log private notes in audit trail
        },
      });

      res.status(201).json({
        termination: termResult.rows[0],
        i9RetainUntil: i9RetainUntil.toISOString().slice(0, 10),
        message: `Employee terminated. I-9 must be retained until ${i9RetainUntil.toLocaleDateString()}.`,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Termination error:', err);
    res.status(500).json({ error: 'Failed to process termination' });
  }
});

// ── GET /api/terminations/:employeeId ─────────────────────────────────────
router.get('/:employeeId', async (req, res) => {
  try {
    const result = await query(
      `SELECT tr.*,
              e.first_name, e.last_name, e.email, e.job_title,
              p.start_date, p.department_id,
              d.name AS department_name,
              u.first_name || ' ' || u.last_name AS terminated_by_name
       FROM termination_records tr
       JOIN employees e ON e.id = tr.employee_id
       LEFT JOIN employee_profiles p ON p.employee_id = tr.employee_id
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN users u ON u.id = tr.terminated_by
       WHERE tr.employee_id = $1 AND tr.company_id = $2`,
      [req.params.employeeId, req.companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Termination record not found' });
    }

    res.json({ termination: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch termination record' });
  }
});

// ── PUT /api/terminations/:employeeId ─────────────────────────────────────
// Update checklist items or notes
router.put('/:employeeId', async (req, res) => {
  const {
    equipmentReturned, accessRevoked, finalPayProcessed,
    benefitsTerminated, cobraNotified,
    privateNotes, eligibleForRehire, referencePolicy,
  } = req.body;

  try {
    const result = await query(
      `UPDATE termination_records SET
         equipment_returned  = COALESCE($1, equipment_returned),
         access_revoked      = COALESCE($2, access_revoked),
         final_pay_processed = COALESCE($3, final_pay_processed),
         benefits_terminated = COALESCE($4, benefits_terminated),
         cobra_notified      = COALESCE($5, cobra_notified),
         private_notes       = COALESCE($6, private_notes),
         eligible_for_rehire = COALESCE($7, eligible_for_rehire),
         reference_policy    = COALESCE($8, reference_policy),
         updated_at          = NOW()
       WHERE employee_id = $9 AND company_id = $10
       RETURNING *`,
      [
        equipmentReturned ?? null, accessRevoked ?? null,
        finalPayProcessed ?? null, benefitsTerminated ?? null,
        cobraNotified ?? null, privateNotes ?? null,
        eligibleForRehire ?? null, referencePolicy ?? null,
        req.params.employeeId, req.companyId,
      ]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Record not found' });

    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: 'termination.checklist_updated',
      entityType: 'employee',
      ipAddress: getClientIP(req),
    });

    res.json({ termination: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update termination record' });
  }
});

// ── GET /api/terminations ─────────────────────────────────────────────────
// List all terminated employees for this company
router.get('/', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await query(
      `SELECT tr.id, tr.termination_date, tr.termination_type, tr.reason_category,
              tr.eligible_for_rehire, tr.i9_retain_until, tr.created_at,
              tr.equipment_returned, tr.access_revoked, tr.final_pay_processed,
              tr.benefits_terminated, tr.cobra_notified,
              e.first_name, e.last_name, e.email, e.job_title,
              d.name AS department_name,
              u.first_name || ' ' || u.last_name AS terminated_by_name
       FROM termination_records tr
       JOIN employees e ON e.id = tr.employee_id
       LEFT JOIN employee_profiles p ON p.employee_id = e.id
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN users u ON u.id = tr.terminated_by
       WHERE tr.company_id = $1
       ORDER BY tr.termination_date DESC
       LIMIT $2 OFFSET $3`,
      [req.companyId, parseInt(limit), parseInt(offset)]
    );

    res.json({ terminated: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch terminated employees' });
  }
});

module.exports = router;
