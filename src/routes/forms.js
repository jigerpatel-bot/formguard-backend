const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db/pool');
const { validateInviteToken, requireAuth } = require('../middleware/auth');
const { encrypt, maskSSN } = require('../utils/encryption');
const { auditLog } = require('../utils/auditLog');

const router = express.Router();

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ════════════════════════════════════════════════════════════
// EMPLOYEE-FACING: uses invite token (no JWT required)
// ════════════════════════════════════════════════════════════

// ── GET /api/forms/onboard-info?token=xxx ─────────────────────────────────
// Returns employee info so the frontend can pre-fill and show progress
router.get('/onboard-info', validateInviteToken, (req, res) => {
  res.json({
    employee: req.employee,
    companyName: req.employee.companyName,
  });
});

// ── POST /api/forms/w4 ────────────────────────────────────────────────────
router.post('/w4', validateInviteToken, [
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty(),
  body('filingStatus').notEmpty().withMessage('Filing status required'),
  body('signatureName').trim().notEmpty().withMessage('Signature required'),
  body('signDate').isISO8601().withMessage('Valid sign date required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const emp = req.employee;
  const {
    firstName, lastName, ssn, address, city, state, zip, filingStatus,
    multipleJobs, dependentAmount, otherIncome, deductions, extraWithholding,
    exempt, signatureName, signDate,
  } = req.body;

  // Prevent duplicate submission
  const existing = await query(
    `SELECT id FROM w4_submissions WHERE employee_id = $1`,
    [emp.id]
  );
  if (existing.rows.length) {
    return res.status(409).json({ error: 'W-4 already submitted for this employee' });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Insert W-4
    const w4Result = await client.query(
      `INSERT INTO w4_submissions (
         employee_id, company_id,
         first_name, last_name, ssn_encrypted, address, city, state, zip, filing_status,
         multiple_jobs, dependent_amount, other_income, deductions, extra_withholding, exempt,
         signature_name, signed_at, signer_ip, signer_user_agent
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        emp.id, emp.companyId,
        firstName, lastName,
        ssn ? encrypt(ssn) : null,
        address, city, state, zip, filingStatus,
        multipleJobs || false,
        parseFloat(dependentAmount) || 0,
        parseFloat(otherIncome) || 0,
        parseFloat(deductions) || 0,
        parseFloat(extraWithholding) || 0,
        exempt || false,
        signatureName,
        new Date(signDate).toISOString(),
        getClientIP(req),
        req.headers['user-agent'],
      ]
    );

    // Update employee status
    await client.query(
      `UPDATE employees
       SET w4_status = 'completed', w4_completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [emp.id]
    );

    // Mark invite token as used
    await client.query(
      `UPDATE invite_tokens SET used_at = NOW() WHERE id = $1`,
      [req.inviteToken.id]
    );

    await client.query('COMMIT');

    await auditLog({
      companyId: emp.companyId, employeeId: emp.id,
      action: 'w4.submitted',
      entityType: 'w4', entityId: w4Result.rows[0].id,
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
      metadata: { signatureName, signDate, filingStatus },
    });

    res.status(201).json({
      success: true,
      submissionId: w4Result.rows[0].id,
      message: 'W-4 submitted and digitally signed.',
      ssnMasked: ssn ? maskSSN(ssn) : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('W-4 submit error:', err);
    res.status(500).json({ error: 'Failed to submit W-4' });
  } finally {
    client.release();
  }
});

// ── POST /api/forms/i9/section1 ───────────────────────────────────────────
router.post('/i9/section1', validateInviteToken, [
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty(),
  body('citizenStatus').notEmpty().withMessage('Citizenship status required'),
  body('signatureName').trim().notEmpty().withMessage('Signature required'),
  body('signDate').isISO8601(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const emp = req.employee;
  const {
    firstName, lastName, otherLastNames, dob, ssn, email, phone,
    address, city, state, zip,
    citizenStatus, alienRegNumber, i94Number, foreignPassportNumber,
    countryOfIssuance, authExpDate,
    signatureName, signDate,
  } = req.body;

  // Check if already has an i9
  const existing = await query(
    `SELECT id, section1_completed_at FROM i9_submissions WHERE employee_id = $1`,
    [emp.id]
  );
  if (existing.rows.length && existing.rows[0].section1_completed_at) {
    return res.status(409).json({ error: 'I-9 Section 1 already submitted' });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    let i9Id;
    if (existing.rows.length) {
      // Update existing draft
      await client.query(
        `UPDATE i9_submissions SET
           first_name=$1, last_name=$2, other_last_names=$3, dob=$4, ssn_encrypted=$5,
           email=$6, phone=$7, address=$8, city=$9, state=$10, zip=$11,
           citizen_status=$12, alien_reg_number=$13, i94_number=$14,
           foreign_passport_number=$15, country_of_issuance=$16, auth_exp_date=$17,
           emp_signature_name=$18, emp_signed_at=$19, emp_signer_ip=$20,
           emp_signer_user_agent=$21, section1_completed_at=NOW()
         WHERE id=$22`,
        [
          firstName, lastName, otherLastNames || null,
          dob ? new Date(dob) : null,
          ssn ? encrypt(ssn) : null,
          email, phone, address, city, state, zip,
          citizenStatus, alienRegNumber || null, i94Number || null,
          foreignPassportNumber || null, countryOfIssuance || null,
          authExpDate ? new Date(authExpDate) : null,
          signatureName, new Date(signDate).toISOString(),
          getClientIP(req), req.headers['user-agent'],
          existing.rows[0].id,
        ]
      );
      i9Id = existing.rows[0].id;
    } else {
      // Create new I-9
      const result = await client.query(
        `INSERT INTO i9_submissions (
           employee_id, company_id,
           first_name, last_name, other_last_names, dob, ssn_encrypted,
           email, phone, address, city, state, zip,
           citizen_status, alien_reg_number, i94_number,
           foreign_passport_number, country_of_issuance, auth_exp_date,
           emp_signature_name, emp_signed_at, emp_signer_ip, emp_signer_user_agent,
           section1_completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
         RETURNING id`,
        [
          emp.id, emp.companyId,
          firstName, lastName, otherLastNames || null,
          dob ? new Date(dob) : null,
          ssn ? encrypt(ssn) : null,
          email, phone, address, city, state, zip,
          citizenStatus, alienRegNumber || null, i94Number || null,
          foreignPassportNumber || null, countryOfIssuance || null,
          authExpDate ? new Date(authExpDate) : null,
          signatureName, new Date(signDate).toISOString(),
          getClientIP(req), req.headers['user-agent'],
        ]
      );
      i9Id = result.rows[0].id;
    }

    // Update employee i9 status to pending (awaiting employer section 2)
    await client.query(
      `UPDATE employees SET i9_status = 'pending', updated_at = NOW() WHERE id = $1`,
      [emp.id]
    );

    await client.query('COMMIT');

    await auditLog({
      companyId: emp.companyId, employeeId: emp.id,
      action: 'i9.section1.submitted',
      entityType: 'i9', entityId: i9Id,
      ipAddress: getClientIP(req),
      metadata: { signatureName, citizenStatus },
    });

    res.status(201).json({
      success: true,
      i9Id,
      message: 'I-9 Section 1 submitted. Employer must complete Section 2 within 3 business days.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('I-9 section 1 error:', err);
    res.status(500).json({ error: 'Failed to submit I-9 Section 1' });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════
// EMPLOYER-FACING: JWT required
// ════════════════════════════════════════════════════════════

// ── POST /api/forms/i9/:i9Id/section2 ────────────────────────────────────
router.post('/i9/:i9Id/section2', requireAuth, [
  body('docListA').optional().trim(),
  body('docListB').optional().trim(),
  body('docListC').optional().trim(),
  body('employerSignatureName').trim().notEmpty().withMessage('Employer signature required'),
  body('employerTitle').trim().notEmpty(),
  body('employerDate').isISO8601(),
  body('employerBusinessName').trim().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const {
    docListA, docListB, docListC,
    docIssuingAuthority, docNumber, docExpirationDate,
    employerSignatureName, employerTitle, employerDate,
    employerBusinessName, employerCity, employerState, employerZip,
  } = req.body;

  try {
    // Verify i9 belongs to this company
    const i9Result = await query(
      `SELECT i.*, e.id AS emp_id FROM i9_submissions i
       JOIN employees e ON e.id = i.employee_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [req.params.i9Id, req.companyId]
    );

    if (!i9Result.rows.length) {
      return res.status(404).json({ error: 'I-9 not found' });
    }

    const i9 = i9Result.rows[0];
    if (!i9.section1_completed_at) {
      return res.status(400).json({ error: 'Employee must complete Section 1 first' });
    }
    if (i9.section2_completed_at) {
      return res.status(409).json({ error: 'Section 2 already completed' });
    }

    // Validate: either List A OR (List B + List C)
    if (!docListA && (!docListB || !docListC)) {
      return res.status(400).json({
        error: 'Must provide either one List A document OR one List B AND one List C document',
      });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE i9_submissions SET
           doc_list_a=$1, doc_list_b=$2, doc_list_c=$3,
           doc_issuing_authority=$4, doc_number=$5, doc_expiration_date=$6,
           employer_signature_name=$7, employer_title=$8, employer_signed_at=$9,
           employer_signer_ip=$10, employer_business_name=$11,
           employer_city=$12, employer_state=$13, employer_zip=$14,
           section2_completed_at=NOW()
         WHERE id=$15`,
        [
          docListA || null, docListB || null, docListC || null,
          docIssuingAuthority || null, docNumber || null,
          docExpirationDate ? new Date(docExpirationDate) : null,
          employerSignatureName, employerTitle,
          new Date(employerDate).toISOString(),
          getClientIP(req),
          employerBusinessName, employerCity, employerState, employerZip,
          req.params.i9Id,
        ]
      );

      await client.query(
        `UPDATE employees
         SET i9_status = 'completed', i9_completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [i9.emp_id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await auditLog({
      companyId: req.companyId, employeeId: i9.emp_id, userId: req.user.id,
      action: 'i9.section2.completed',
      entityType: 'i9', entityId: req.params.i9Id,
      ipAddress: getClientIP(req),
      metadata: { employerSignatureName, employerTitle, docListA, docListB, docListC },
    });

    res.json({ success: true, message: 'I-9 Section 2 completed. Form is now fully executed.' });
  } catch (err) {
    console.error('I-9 section 2 error:', err);
    res.status(500).json({ error: 'Failed to complete I-9 Section 2' });
  }
});

// ── GET /api/forms/employee/:employeeId ───────────────────────────────────
// Get all form submissions for an employee (employer view)
router.get('/employee/:employeeId', requireAuth, async (req, res) => {
  try {
    const [w4, i9] = await Promise.all([
      query(`SELECT * FROM w4_submissions WHERE employee_id=$1 AND company_id=$2`,
        [req.params.employeeId, req.companyId]),
      query(`SELECT * FROM i9_submissions WHERE employee_id=$1 AND company_id=$2`,
        [req.params.employeeId, req.companyId]),
    ]);

    // Mask SSN before returning
    const maskForm = (form) => form ? {
      ...form,
      ssn_encrypted: undefined,
      ssn_masked: maskSSN('0000'), // display only last 4
    } : null;

    res.json({
      w4: w4.rows[0] ? maskForm(w4.rows[0]) : null,
      i9: i9.rows[0] ? maskForm(i9.rows[0]) : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch form data' });
  }
});

module.exports = router;
