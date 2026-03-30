/**
 * FormGuard — Demographics Routes
 *
 * Employee-facing (invite token):
 *   POST /api/demographics/self-identify?token=   — employee submits their own data
 *
 * Employer-facing (JWT):
 *   GET  /api/demographics/:employeeId             — get one employee's demographics
 *   PUT  /api/demographics/:employeeId/eeo1        — employer sets EEO-1 job category
 *   GET  /api/demographics/summary                 — aggregate company summary (no PII)
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { validateInviteToken, requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/auditLog');

const router = express.Router();

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// Valid values — match these to frontend dropdowns
const VALID_GENDERS = ['male','female','non_binary','self_describe','prefer_not_to_say'];
const VALID_RACES   = [
  'hispanic_latino','white','black_african_american','asian',
  'native_hawaiian_pacific_islander','american_indian_alaska_native',
  'two_or_more','prefer_not_to_say',
];
const VALID_VETERAN = ['not_veteran','veteran','disabled_veteran','prefer_not_to_say'];
const VALID_DISABILITY = ['no_disability','yes_disability','prefer_not_to_say'];
const VALID_EEO1 = [
  'exec_senior_officials','first_mid_officials','professionals','technicians',
  'sales','admin_support','craft_workers','operatives','laborers','service_workers',
];

// ── POST /api/demographics/self-identify?token= ───────────────────────────
// Employee fills this in during onboarding — all fields voluntary
router.post('/self-identify', validateInviteToken, [
  body('gender').optional().isIn(VALID_GENDERS),
  body('raceEthnicity').optional().isIn(VALID_RACES),
  body('veteranStatus').optional().isIn(VALID_VETERAN),
  body('disabilityStatus').optional().isIn(VALID_DISABILITY),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const emp = req.employee;
  const {
    gender, genderSelfDesc, raceEthnicity,
    veteranStatus, disabilityStatus,
  } = req.body;

  try {
    await query(
      `INSERT INTO employee_demographics
         (employee_id, company_id, gender, gender_self_desc, race_ethnicity,
          veteran_status, disability_status, self_identified_at, identified_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),'onboarding_link')
       ON CONFLICT (employee_id) DO UPDATE SET
         gender              = COALESCE(EXCLUDED.gender, employee_demographics.gender),
         gender_self_desc    = COALESCE(EXCLUDED.gender_self_desc, employee_demographics.gender_self_desc),
         race_ethnicity      = COALESCE(EXCLUDED.race_ethnicity, employee_demographics.race_ethnicity),
         veteran_status      = COALESCE(EXCLUDED.veteran_status, employee_demographics.veteran_status),
         disability_status   = COALESCE(EXCLUDED.disability_status, employee_demographics.disability_status),
         self_identified_at  = NOW(),
         updated_at          = NOW()`,
      [
        emp.id, emp.companyId,
        gender || null,
        genderSelfDesc || null,
        raceEthnicity || null,
        veteranStatus || null,
        disabilityStatus || null,
      ]
    );

    await auditLog({
      companyId: emp.companyId, employeeId: emp.id,
      action: 'demographics.self_identified',
      entityType: 'employee', entityId: emp.id,
      ipAddress: getClientIP(req),
      // Do NOT log the actual demographic values in audit trail
      metadata: { fieldsProvided: Object.keys(req.body).filter(k => req.body[k]) },
    });

    res.json({ success: true, message: 'Demographics saved. Thank you.' });
  } catch (err) {
    console.error('Demographics self-identify error:', err);
    res.status(500).json({ error: 'Failed to save demographics' });
  }
});

// ── GET /api/demographics/:employeeId ─────────────────────────────────────
// Admin/HR only — view one employee's demographics
router.get('/:employeeId', requireAuth, requireRole('admin', 'hr'), async (req, res) => {
  try {
    const result = await query(
      `SELECT d.*, e.first_name, e.last_name
       FROM employee_demographics d
       JOIN employees e ON e.id = d.employee_id
       WHERE d.employee_id = $1 AND d.company_id = $2`,
      [req.params.employeeId, req.companyId]
    );

    // Log access to sensitive demographic data
    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: 'demographics.viewed',
      entityType: 'employee',
      ipAddress: getClientIP(req),
    });

    res.json({ demographics: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch demographics' });
  }
});

// ── PUT /api/demographics/:employeeId/eeo1 ────────────────────────────────
// Employer sets EEO-1 job category (separate from self-identification)
router.put('/:employeeId/eeo1', requireAuth, requireRole('admin', 'hr'), [
  body('eeo1JobCategory').isIn(VALID_EEO1).withMessage('Invalid EEO-1 category'),
  body('payRate').optional().isNumeric(),
  body('payType').optional().isIn(['hourly','salary','contractor']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { eeo1JobCategory, payRate, payType, payEffectiveDate } = req.body;

  try {
    // Upsert demographics row with EEO-1 category
    await query(
      `INSERT INTO employee_demographics
         (employee_id, company_id, eeo1_job_category, pay_rate, pay_type, pay_effective_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (employee_id) DO UPDATE SET
         eeo1_job_category  = EXCLUDED.eeo1_job_category,
         pay_rate           = COALESCE(EXCLUDED.pay_rate, employee_demographics.pay_rate),
         pay_type           = COALESCE(EXCLUDED.pay_type, employee_demographics.pay_type),
         pay_effective_date = COALESCE(EXCLUDED.pay_effective_date, employee_demographics.pay_effective_date),
         updated_at         = NOW()`,
      [req.params.employeeId, req.companyId, eeo1JobCategory,
       payRate || null, payType || null, payEffectiveDate || null]
    );

    // Also update employee_profiles pay info
    if (payRate || payType) {
      await query(
        `UPDATE employee_profiles SET
           pay_rate = COALESCE($1, pay_rate),
           pay_type = COALESCE($2, pay_type)
         WHERE employee_id = $3`,
        [payRate || null, payType || null, req.params.employeeId]
      );
    }

    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: 'demographics.eeo1_updated',
      entityType: 'employee',
      ipAddress: getClientIP(req),
      metadata: { eeo1JobCategory },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update EEO-1 category' });
  }
});

module.exports = router;
