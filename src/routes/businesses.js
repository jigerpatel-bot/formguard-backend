/**
 * FormGuard — Multi-Business Routes
 *
 * GET  /api/businesses                    — list all companies for logged-in user
 * POST /api/businesses                    — create a new company (adds membership)
 * GET  /api/businesses/:companyId         — get one company details
 * PUT  /api/businesses/:companyId         — update company info
 * POST /api/businesses/:companyId/switch  — set as active company (updates JWT context)
 * POST /api/businesses/:companyId/members — invite another user to this company
 * GET  /api/businesses/:companyId/members — list members of a company
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, getClient } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/auditLog');

const router = express.Router();
router.use(requireAuth);

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ── GET /api/businesses ───────────────────────────────────────────────────
// List all companies the logged-in user has access to
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT
         c.id, c.name, c.ein, c.address, c.city, c.state, c.zip,
         c.phone, c.industry, c.employee_count_range, c.logo_url,
         c.setup_complete, c.plan, c.active,
         bm.role, bm.is_primary,
         COUNT(DISTINCT e.id) AS employee_count,
         COUNT(DISTINCT e.id) FILTER (
           WHERE e.w4_status = 'completed' AND e.i9_status = 'completed'
         ) AS compliant_count,
         sp.overall_complete AS setup_wizard_complete,
         sp.selected_state
       FROM business_memberships bm
       JOIN companies c ON c.id = bm.company_id
       LEFT JOIN employees e ON e.company_id = c.id AND e.employment_status = 'active'
       LEFT JOIN business_setup_progress sp ON sp.company_id = c.id
       WHERE bm.user_id = $1 AND c.active = true
       GROUP BY c.id, bm.role, bm.is_primary, sp.overall_complete, sp.selected_state
       ORDER BY bm.is_primary DESC, c.name ASC`,
      [req.user.id]
    );

    res.json({ businesses: result.rows });
  } catch (err) {
    console.error('List businesses error:', err);
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

// ── POST /api/businesses ──────────────────────────────────────────────────
// Create a new company and add current user as owner
router.post('/', [
  body('name').trim().notEmpty().withMessage('Business name required'),
  body('state').isLength({ min: 2, max: 2 }).withMessage('Valid 2-letter state code required'),
  body('ein').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const {
    name, ein, address, city, state, zip,
    phone, industry, employeeCountRange,
  } = req.body;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const companyId = uuid();

    // Create company
    await client.query(
      `INSERT INTO companies
         (id, name, ein, address, city, state, zip, phone, industry, employee_count_range)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [companyId, name, ein || null, address || null, city || null,
       state.toUpperCase(), zip || null, phone || null, industry || null,
       employeeCountRange || null]
    );

    // Add current user as owner of this new company
    await client.query(
      `INSERT INTO business_memberships (user_id, company_id, role, is_primary)
       VALUES ($1,$2,'owner', false)`,
      [req.user.id, companyId]
    );

    // Initialize setup progress
    await client.query(
      `INSERT INTO business_setup_progress (company_id, step1_complete, selected_state)
       VALUES ($1, true, $2)`,
      [companyId, state.toUpperCase()]
    );

    // Auto-assign federal forms (W-4 + I-9) for every company
    const federalForms = await client.query(
      `SELECT form_key, form_name, is_federal FROM state_required_forms
       WHERE state_code = 'US' AND active = true`
    );
    for (const form of federalForms.rows) {
      await client.query(
        `INSERT INTO company_required_forms (company_id, form_key, form_name, is_federal)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [companyId, form.form_key, form.form_name, form.is_federal]
      );
    }

    // Auto-assign state-specific forms
    const stateForms = await client.query(
      `SELECT form_key, form_name, is_federal FROM state_required_forms
       WHERE state_code = $1 AND active = true`,
      [state.toUpperCase()]
    );
    for (const form of stateForms.rows) {
      await client.query(
        `INSERT INTO company_required_forms (company_id, form_key, form_name, is_federal)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [companyId, form.form_key, form.form_name, form.is_federal]
      );
    }

    await client.query('COMMIT');

    await auditLog({
      companyId, userId: req.user.id,
      action: 'company.created',
      entityType: 'company', entityId: companyId,
      ipAddress: getClientIP(req),
      metadata: { name, state: state.toUpperCase() },
    });

    res.status(201).json({
      company: { id: companyId, name, state: state.toUpperCase() },
      formsAssigned: federalForms.rows.length + stateForms.rows.length,
      message: `Business created. ${federalForms.rows.length + stateForms.rows.length} required forms auto-assigned for ${state.toUpperCase()}.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create business error:', err);
    res.status(500).json({ error: 'Failed to create business' });
  } finally {
    client.release();
  }
});

// ── GET /api/businesses/:companyId ────────────────────────────────────────
router.get('/:companyId', async (req, res) => {
  try {
    // Verify user has access to this company
    const access = await query(
      `SELECT bm.role FROM business_memberships bm
       WHERE bm.user_id = $1 AND bm.company_id = $2`,
      [req.user.id, req.params.companyId]
    );
    if (!access.rows.length) {
      return res.status(403).json({ error: 'Access denied to this business' });
    }

    const [company, forms, setup, members] = await Promise.all([
      query(`SELECT * FROM companies WHERE id = $1`, [req.params.companyId]),
      query(
        `SELECT * FROM company_required_forms WHERE company_id = $1 AND is_active = true ORDER BY is_federal DESC, form_name`,
        [req.params.companyId]
      ),
      query(`SELECT * FROM business_setup_progress WHERE company_id = $1`, [req.params.companyId]),
      query(
        `SELECT u.id, u.email, u.first_name, u.last_name, bm.role, bm.is_primary, bm.created_at
         FROM business_memberships bm JOIN users u ON u.id = bm.user_id
         WHERE bm.company_id = $1`,
        [req.params.companyId]
      ),
    ]);

    res.json({
      company: company.rows[0],
      requiredForms: forms.rows,
      setupProgress: setup.rows[0] || null,
      members: members.rows,
      userRole: access.rows[0].role,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch business' });
  }
});

// ── PUT /api/businesses/:companyId ────────────────────────────────────────
router.put('/:companyId', async (req, res) => {
  const access = await query(
    `SELECT role FROM business_memberships WHERE user_id = $1 AND company_id = $2`,
    [req.user.id, req.params.companyId]
  );
  if (!access.rows.length || !['owner','admin'].includes(access.rows[0].role)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { name, ein, address, city, state, zip, phone, industry, employeeCountRange } = req.body;

  try {
    await query(
      `UPDATE companies SET
         name                 = COALESCE($1, name),
         ein                  = COALESCE($2, ein),
         address              = COALESCE($3, address),
         city                 = COALESCE($4, city),
         state                = COALESCE($5, state),
         zip                  = COALESCE($6, zip),
         phone                = COALESCE($7, phone),
         industry             = COALESCE($8, industry),
         employee_count_range = COALESCE($9, employee_count_range),
         updated_at           = NOW()
       WHERE id = $10`,
      [name, ein, address, city, state?.toUpperCase(), zip, phone, industry, employeeCountRange, req.params.companyId]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update business' });
  }
});

// ── POST /api/businesses/:companyId/switch ────────────────────────────────
// Returns a new JWT scoped to the selected company
router.post('/:companyId/switch', async (req, res) => {
  try {
    const access = await query(
      `SELECT bm.role, c.name, c.plan
       FROM business_memberships bm
       JOIN companies c ON c.id = bm.company_id
       WHERE bm.user_id = $1 AND bm.company_id = $2 AND c.active = true`,
      [req.user.id, req.params.companyId]
    );

    if (!access.rows.length) {
      return res.status(403).json({ error: 'You do not have access to this business' });
    }

    // Issue a new token scoped to the new company
    const newToken = jwt.sign(
      { userId: req.user.id, companyId: req.params.companyId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    await auditLog({
      companyId: req.params.companyId,
      userId: req.user.id,
      action: 'company.switched',
      entityType: 'company',
      ipAddress: getClientIP(req),
      metadata: { companyName: access.rows[0].name },
    });

    res.json({
      token: newToken,
      company: {
        id: req.params.companyId,
        name: access.rows[0].name,
        plan: access.rows[0].plan,
        role: access.rows[0].role,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to switch business' });
  }
});

// ── GET /api/businesses/:companyId/state-forms ────────────────────────────
// Get all required forms for a given state (used in wizard)
router.get('/:companyId/state-forms', async (req, res) => {
  try {
    const company = await query(
      `SELECT state FROM companies WHERE id = $1`, [req.params.companyId]
    );
    const state = company.rows[0]?.state;
    if (!state) return res.status(400).json({ error: 'Company state not set' });

    const forms = await query(
      `SELECT * FROM state_required_forms
       WHERE (state_code = 'US' OR state_code = $1) AND active = true
       ORDER BY is_federal DESC, form_name`,
      [state]
    );

    res.json({ state, forms: forms.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch state forms' });
  }
});

// ── GET /api/businesses/state-forms/lookup?state=TX ──────────────────────
// Preview forms for any state (used before company creation)
router.get('/state-forms/lookup', async (req, res) => {
  const { state } = req.query;
  if (!state || state.length !== 2) {
    return res.status(400).json({ error: 'Provide a 2-letter state code' });
  }
  try {
    const forms = await query(
      `SELECT * FROM state_required_forms
       WHERE (state_code = 'US' OR state_code = $1) AND active = true
       ORDER BY is_federal DESC, form_name`,
      [state.toUpperCase()]
    );
    res.json({ state: state.toUpperCase(), forms: forms.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to lookup state forms' });
  }
});

// ── POST /api/businesses/:companyId/setup-progress ───────────────────────
// Update setup wizard progress
router.post('/:companyId/setup-progress', async (req, res) => {
  const access = await query(
    `SELECT role FROM business_memberships WHERE user_id = $1 AND company_id = $2`,
    [req.user.id, req.params.companyId]
  );
  if (!access.rows.length) return res.status(403).json({ error: 'Access denied' });

  const {
    step1Complete, step2Complete, step3Complete,
    step4Complete, step5Complete,
  } = req.body;

  try {
    const result = await query(
      `INSERT INTO business_setup_progress (company_id)
       VALUES ($1)
       ON CONFLICT (company_id) DO UPDATE SET
         step1_complete = CASE WHEN $2 THEN true ELSE business_setup_progress.step1_complete END,
         step2_complete = CASE WHEN $3 THEN true ELSE business_setup_progress.step2_complete END,
         step3_complete = CASE WHEN $4 THEN true ELSE business_setup_progress.step3_complete END,
         step4_complete = CASE WHEN $5 THEN true ELSE business_setup_progress.step4_complete END,
         step5_complete = CASE WHEN $6 THEN true ELSE business_setup_progress.step5_complete END,
         last_updated_at = NOW()
       RETURNING *`,
      [req.params.companyId,
       !!step1Complete, !!step2Complete, !!step3Complete,
       !!step4Complete, !!step5Complete]
    );

    const progress = result.rows[0];
    const allDone = progress.step1_complete && progress.step2_complete &&
                    progress.step3_complete && progress.step4_complete &&
                    progress.step5_complete;

    if (allDone && !progress.overall_complete) {
      await query(
        `UPDATE business_setup_progress SET overall_complete = true, completed_at = NOW()
         WHERE company_id = $1`,
        [req.params.companyId]
      );
      await query(
        `UPDATE companies SET setup_complete = true WHERE id = $1`,
        [req.params.companyId]
      );
    }

    res.json({ progress: result.rows[0], allComplete: allDone });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update setup progress' });
  }
});

module.exports = router;
