/**
 * FormGuard — Onboarding Service
 *
 * Core logic for generating and managing employee onboarding checklists.
 * Steps are dynamically generated based on:
 *   1. Federal requirements (always: W-4, I-9, ID upload)
 *   2. State-specific forms (based on company state)
 *   3. Company documents (employer-uploaded, assigned to all)
 */

const { query, getClient } = require('../db/pool');
const { auditLog } = require('../utils/auditLog');

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE CHECKLIST FOR A NEW EMPLOYEE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a checklist + all steps for a newly invited employee.
 * Call this right after creating the employee record.
 */
const generateChecklist = async (employeeId, companyId) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Get company info (state, required forms, company docs)
    const [companyResult, stateFormsResult, companyDocsResult] = await Promise.all([
      client.query(`SELECT state, name FROM companies WHERE id = $1`, [companyId]),
      client.query(
        `SELECT form_key, form_name FROM company_required_forms
         WHERE company_id = $1 AND is_active = true
         ORDER BY is_federal DESC, form_name`,
        [companyId]
      ),
      client.query(
        `SELECT id, name, requires_signature, doc_type FROM company_documents
         WHERE company_id = $1 AND active = true AND assign_to_all = true
         ORDER BY created_at ASC`,
        [companyId]
      ),
    ]);

    const state = companyResult.rows[0]?.state || 'US';
    const stateForms = stateFormsResult.rows;
    const companyDocs = companyDocsResult.rows;

    // Build steps array
    const steps = [];
    let order = 1;

    // ── Step 1: Personal Information (always first) ────────────────────────
    steps.push({
      step_order: order++,
      step_key: 'personal_info',
      step_type: 'info',
      title: 'Personal Information',
      description: 'Provide your full name, address, date of birth, and contact information.',
      is_required: true,
      requires_employer_action: false,
    });

    // ── Step 2: Government-issued ID upload ───────────────────────────────
    steps.push({
      step_order: order++,
      step_key: 'id_upload',
      step_type: 'upload',
      title: 'Upload Government-Issued ID',
      description: 'Upload a photo of your government-issued ID (driver\'s license, passport, etc.).',
      is_required: true,
      requires_employer_action: true, // employer must verify
    });

    // ── Step 3: Self-ID demographics (voluntary) ─────────────────────────
    steps.push({
      step_order: order++,
      step_key: 'demographics',
      step_type: 'info',
      title: 'Voluntary Self-Identification',
      description: 'Optional: provide gender and race/ethnicity for EEOC compliance reporting.',
      is_required: false,
      requires_employer_action: false,
    });

    // ── Steps 4+: Required forms (W-4, I-9, state forms) ─────────────────
    for (const form of stateForms) {
      let title = form.form_name;
      let description = '';
      let stepKey = `form_${form.form_key}`;
      let requiresEmployer = false;

      if (form.form_key === 'federal_w4') {
        title = 'Sign IRS Form W-4';
        description = 'Complete and sign your federal income tax withholding certificate.';
      } else if (form.form_key === 'federal_i9') {
        title = 'Complete Form I-9 (Employment Eligibility)';
        description = 'Verify your identity and authorization to work in the United States. Your employer must complete Section 2 within 3 business days.';
        requiresEmployer = true;
      } else {
        description = `Complete the required ${state} state form.`;
      }

      steps.push({
        step_order: order++,
        step_key: stepKey,
        step_type: 'form',
        title,
        description,
        is_required: true,
        requires_employer_action: requiresEmployer,
      });
    }

    // ── Steps: Company documents ──────────────────────────────────────────
    for (const doc of companyDocs) {
      steps.push({
        step_order: order++,
        step_key: `company_doc_${doc.id}`,
        step_type: doc.requires_signature ? 'signature' : 'acknowledgment',
        title: doc.requires_signature
          ? `Sign: ${doc.name}`
          : `Acknowledge: ${doc.name}`,
        description: doc.requires_signature
          ? `Review and digitally sign the ${doc.name}.`
          : `Read and acknowledge receipt of the ${doc.name}.`,
        is_required: true,
        requires_employer_action: false,
        reference_id: doc.id,
        reference_type: 'company_doc',
      });
    }

    // Create the checklist record
    const checklistResult = await client.query(
      `INSERT INTO onboarding_checklists
         (employee_id, company_id, total_steps, completed_steps, progress_pct, status)
       VALUES ($1, $2, $3, 0, 0, 'not_started')
       ON CONFLICT (employee_id) DO UPDATE SET
         total_steps = EXCLUDED.total_steps,
         updated_at = NOW()
       RETURNING id`,
      [employeeId, companyId, steps.length]
    );
    const checklistId = checklistResult.rows[0].id;

    // Insert all steps
    for (const step of steps) {
      await client.query(
        `INSERT INTO onboarding_steps
           (checklist_id, employee_id, company_id, step_order, step_key, step_type,
            title, description, is_required, requires_employer_action,
            reference_id, reference_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (checklist_id, step_key) DO NOTHING`,
        [
          checklistId, employeeId, companyId,
          step.step_order, step.step_key, step.step_type,
          step.title, step.description, step.is_required,
          step.requires_employer_action,
          step.reference_id || null, step.reference_type || null,
        ]
      );
    }

    await client.query('COMMIT');
    return { checklistId, totalSteps: steps.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET CHECKLIST WITH STEPS
// ─────────────────────────────────────────────────────────────────────────────

const getChecklist = async (employeeId, companyId) => {
  const [checklistResult, stepsResult] = await Promise.all([
    query(
      `SELECT cl.*, e.first_name, e.last_name, e.email, e.job_title
       FROM onboarding_checklists cl
       JOIN employees e ON e.id = cl.employee_id
       WHERE cl.employee_id = $1 AND cl.company_id = $2`,
      [employeeId, companyId]
    ),
    query(
      `SELECT * FROM onboarding_steps
       WHERE employee_id = $1 AND company_id = $2
       ORDER BY step_order ASC`,
      [employeeId, companyId]
    ),
  ]);

  if (!checklistResult.rows.length) return null;

  return {
    checklist: checklistResult.rows[0],
    steps: stepsResult.rows,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE A STEP
// ─────────────────────────────────────────────────────────────────────────────

const completeStep = async (employeeId, companyId, stepKey, {
  completedBy = 'employee',
  referenceId = null,
  referenceType = null,
  notes = null,
} = {}) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Mark step complete
    await client.query(
      `UPDATE onboarding_steps SET
         status        = 'completed',
         completed_at  = NOW(),
         completed_by  = $1,
         reference_id  = COALESCE($2, reference_id),
         reference_type = COALESCE($3, reference_type),
         notes         = $4,
         updated_at    = NOW()
       WHERE employee_id = $5 AND company_id = $6 AND step_key = $7`,
      [completedBy, referenceId, referenceType, notes, employeeId, companyId, stepKey]
    );

    // Recalculate progress
    const progressResult = await client.query(
      `SELECT
         cl.id AS checklist_id,
         cl.total_steps,
         COUNT(s.id) FILTER (WHERE s.status = 'completed') AS completed_steps
       FROM onboarding_checklists cl
       JOIN onboarding_steps s ON s.checklist_id = cl.id
       WHERE cl.employee_id = $1 AND cl.company_id = $2
       GROUP BY cl.id, cl.total_steps`,
      [employeeId, companyId]
    );

    if (progressResult.rows.length) {
      const { checklist_id, total_steps, completed_steps } = progressResult.rows[0];
      const pct = Math.round((parseInt(completed_steps) / parseInt(total_steps)) * 100);
      const allDone = parseInt(completed_steps) >= parseInt(total_steps);

      await client.query(
        `UPDATE onboarding_checklists SET
           completed_steps  = $1,
           progress_pct     = $2,
           status           = $3,
           started_at       = COALESCE(started_at, NOW()),
           completed_at     = $4,
           last_activity_at = NOW(),
           updated_at       = NOW()
         WHERE id = $5`,
        [
          completed_steps, pct,
          allDone ? 'completed' : 'in_progress',
          allDone ? new Date() : null,
          checklist_id,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL CHECKLISTS FOR A COMPANY (dashboard view)
// ─────────────────────────────────────────────────────────────────────────────

const getCompanyChecklists = async (companyId, { status, limit = 50, offset = 0 } = {}) => {
  const conditions = ['cl.company_id = $1'];
  const params = [companyId];
  let i = 2;

  if (status) {
    conditions.push(`cl.status = $${i++}`);
    params.push(status);
  }

  params.push(limit, offset);

  const result = await query(
    `SELECT
       cl.*,
       e.first_name, e.last_name, e.email, e.job_title,
       e.created_at AS hired_at,
       -- Next incomplete required step
       (SELECT s.title FROM onboarding_steps s
        WHERE s.checklist_id = cl.id
          AND s.status = 'not_started'
          AND s.is_required = true
        ORDER BY s.step_order ASC LIMIT 1) AS next_step,
       -- Pending employer actions
       (SELECT COUNT(*) FROM onboarding_steps s
        WHERE s.checklist_id = cl.id
          AND s.requires_employer_action = true
          AND s.status != 'completed') AS pending_employer_actions
     FROM onboarding_checklists cl
     JOIN employees e ON e.id = cl.employee_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY
       CASE cl.status
         WHEN 'in_progress' THEN 1
         WHEN 'not_started' THEN 2
         WHEN 'completed'   THEN 3
       END,
       cl.last_activity_at DESC NULLS LAST
     LIMIT $${i} OFFSET $${i+1}`,
    params
  );

  return result.rows;
};

module.exports = {
  generateChecklist,
  getChecklist,
  completeStep,
  getCompanyChecklists,
};
