/**
 * FormGuard — Onboarding Routes
 *
 * Employer-facing (JWT):
 *   GET  /api/onboarding                          — all checklists for company
 *   GET  /api/onboarding/:employeeId              — one employee's checklist
 *   POST /api/onboarding/:employeeId/generate     — generate/regenerate checklist
 *   POST /api/onboarding/:employeeId/remind       — send reminder email
 *   POST /api/onboarding/:employeeId/steps/:stepKey/employer-complete
 *                                                 — employer marks their action done
 *   GET  /api/onboarding/:employeeId/id-uploads   — view uploaded IDs
 *   POST /api/onboarding/:employeeId/id-uploads/:uploadId/verify
 *                                                 — verify or reject ID
 *
 * Employee-facing (invite token):
 *   GET  /api/onboarding/my-checklist?token=      — employee views their steps
 *   POST /api/onboarding/steps/:stepKey/complete?token=
 *                                                 — employee completes a step
 *   POST /api/onboarding/id-upload?token=         — employee uploads ID
 *
 * Company documents:
 *   GET  /api/onboarding/company-docs             — list company documents
 *   POST /api/onboarding/company-docs             — upload company document
 *   DELETE /api/onboarding/company-docs/:docId    — remove document
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db/pool');
const { requireAuth, requireRole, validateInviteToken } = require('../middleware/auth');
const {
  generateChecklist,
  getChecklist,
  completeStep,
  getCompanyChecklists,
} = require('../services/onboarding');
const { sendEmployeeInvite } = require('../services/email');
const { auditLog } = require('../utils/auditLog');

const router = express.Router();
const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ══════════════════════════════════════════════════════════════════════════════
// EMPLOYER ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/onboarding ───────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const checklists = await getCompanyChecklists(req.companyId, {
      status, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0,
    });
    res.json({ checklists });
  } catch (err) {
    console.error('Get checklists error:', err);
    res.status(500).json({ error: 'Failed to fetch checklists' });
  }
});

// ── GET /api/onboarding/:employeeId ──────────────────────────────────────
router.get('/:employeeId', requireAuth, async (req, res) => {
  try {
    const data = await getChecklist(req.params.employeeId, req.companyId);
    if (!data) return res.status(404).json({ error: 'Checklist not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch checklist' });
  }
});

// ── POST /api/onboarding/:employeeId/generate ────────────────────────────
// Generate or regenerate a checklist (call after inviting employee)
router.post('/:employeeId/generate', requireAuth, async (req, res) => {
  try {
    // Verify employee belongs to this company
    const empResult = await query(
      `SELECT id FROM employees WHERE id = $1 AND company_id = $2`,
      [req.params.employeeId, req.companyId]
    );
    if (!empResult.rows.length) return res.status(404).json({ error: 'Employee not found' });

    const result = await generateChecklist(req.params.employeeId, req.companyId);

    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: 'onboarding.checklist_generated',
      entityType: 'employee', entityId: req.params.employeeId,
      metadata: { totalSteps: result.totalSteps },
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    console.error('Generate checklist error:', err);
    res.status(500).json({ error: 'Failed to generate checklist' });
  }
});

// ── POST /api/onboarding/:employeeId/remind ───────────────────────────────
router.post('/:employeeId/remind', requireAuth, async (req, res) => {
  try {
    const empResult = await query(
      `SELECT e.first_name, e.last_name, e.email,
              it.token, it.expires_at,
              c.name AS company_name,
              u.first_name AS hr_first_name, u.last_name AS hr_last_name
       FROM employees e
       JOIN companies c ON c.id = e.company_id
       JOIN invite_tokens it ON it.employee_id = e.id AND it.revoked = false
       LEFT JOIN users u ON u.id = $2
       WHERE e.id = $1 AND e.company_id = $3
       ORDER BY it.created_at DESC LIMIT 1`,
      [req.params.employeeId, req.user.id, req.companyId]
    );

    if (!empResult.rows.length) return res.status(404).json({ error: 'Employee not found' });
    const emp = empResult.rows[0];

    const inviteUrl = `${process.env.APP_BASE_URL}/onboard?token=${emp.token}`;

    await sendEmployeeInvite({
      employeeEmail: emp.email,
      employeeFirstName: emp.first_name,
      companyName: emp.company_name,
      inviteUrl,
      expiresAt: emp.expires_at,
      hrName: `${emp.hr_first_name} ${emp.hr_last_name}`,
    });

    // Update reminder tracking
    await query(
      `UPDATE onboarding_checklists SET
         last_reminder_at = NOW(),
         reminder_count = reminder_count + 1
       WHERE employee_id = $1`,
      [req.params.employeeId]
    );

    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: 'onboarding.reminder_sent',
      metadata: { email: emp.email },
    });

    res.json({ success: true, message: `Reminder sent to ${emp.email}` });
  } catch (err) {
    console.error('Send reminder error:', err);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// ── POST /api/onboarding/:employeeId/steps/:stepKey/employer-complete ─────
// Employer marks their portion of a step done (e.g. I-9 Section 2, ID verified)
router.post('/:employeeId/steps/:stepKey/employer-complete', requireAuth, async (req, res) => {
  try {
    await completeStep(req.params.employeeId, req.companyId, req.params.stepKey, {
      completedBy: `${req.user.first_name} ${req.user.last_name}`,
      notes: req.body.notes,
    });

    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: `onboarding.step.employer_completed`,
      metadata: { stepKey: req.params.stepKey },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete step' });
  }
});

// ── GET /api/onboarding/:employeeId/id-uploads ───────────────────────────
router.get('/:employeeId/id-uploads', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM id_uploads WHERE employee_id = $1 AND company_id = $2 ORDER BY uploaded_at DESC`,
      [req.params.employeeId, req.companyId]
    );
    res.json({ uploads: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ID uploads' });
  }
});

// ── POST /api/onboarding/:employeeId/id-uploads/:uploadId/verify ─────────
router.post('/:employeeId/id-uploads/:uploadId/verify', requireAuth, requireRole('admin','hr'), async (req, res) => {
  const { status, notes } = req.body;
  if (!['verified','needs_correction','rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    await query(
      `UPDATE id_uploads SET
         verification_status = $1,
         verified_by = $2,
         verified_at = NOW(),
         verification_notes = $3
       WHERE id = $4 AND employee_id = $5 AND company_id = $6`,
      [status, req.user.id, notes || null, req.params.uploadId, req.params.employeeId, req.companyId]
    );

    // If verified, mark the id_upload step complete
    if (status === 'verified') {
      await completeStep(req.params.employeeId, req.companyId, 'id_upload', {
        completedBy: `${req.user.first_name} ${req.user.last_name}`,
        referenceId: req.params.uploadId,
        referenceType: 'id_upload',
      });
    }

    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: `id_upload.${status}`,
      metadata: { uploadId: req.params.uploadId, notes },
    });

    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify ID' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE ROUTES (invite token)
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/onboarding/my-checklist?token= ──────────────────────────────
router.get('/my-checklist', validateInviteToken, async (req, res) => {
  try {
    const data = await getChecklist(req.employee.id, req.employee.companyId);

    if (!data) {
      // Auto-generate if missing (handles edge case)
      await generateChecklist(req.employee.id, req.employee.companyId);
      const newData = await getChecklist(req.employee.id, req.employee.companyId);
      return res.json({ ...newData, employee: req.employee });
    }

    // Don't expose sensitive employer-only fields to employee
    const safeSteps = data.steps.map(s => ({
      id: s.id, step_order: s.step_order, step_key: s.step_key,
      step_type: s.step_type, title: s.title, description: s.description,
      status: s.status, is_required: s.is_required,
      requires_employer_action: s.requires_employer_action,
      completed_at: s.completed_at,
    }));

    res.json({ checklist: data.checklist, steps: safeSteps, employee: req.employee });
  } catch (err) {
    console.error('My checklist error:', err);
    res.status(500).json({ error: 'Failed to fetch checklist' });
  }
});

// ── POST /api/onboarding/steps/:stepKey/complete?token= ──────────────────
router.post('/steps/:stepKey/complete', validateInviteToken, async (req, res) => {
  try {
    await completeStep(req.employee.id, req.employee.companyId, req.params.stepKey, {
      completedBy: 'employee',
      referenceId: req.body.referenceId,
      referenceType: req.body.referenceType,
    });

    await auditLog({
      companyId: req.employee.companyId, employeeId: req.employee.id,
      action: `onboarding.step.completed`,
      ipAddress: getClientIP(req),
      metadata: { stepKey: req.params.stepKey },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete step' });
  }
});

// ── POST /api/onboarding/id-upload?token= ────────────────────────────────
router.post('/id-upload', validateInviteToken, async (req, res) => {
  const { documentType, documentLabel, fileName, fileSize, fileType } = req.body;

  if (!documentType) return res.status(400).json({ error: 'Document type required' });

  try {
    // In production: receive file upload, upload to S3, store s3_key
    // For now: store metadata + placeholder s3_key
    const result = await query(
      `INSERT INTO id_uploads
         (employee_id, company_id, document_type, document_label,
          file_name, file_size, file_type, s3_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        req.employee.id, req.employee.companyId,
        documentType, documentLabel || documentType,
        fileName || null, fileSize || null, fileType || null,
        `uploads/${req.employee.companyId}/${req.employee.id}/ids/${Date.now()}-${fileName || 'id'}`,
      ]
    );

    // Mark personal_info step complete if not already done
    await completeStep(req.employee.id, req.employee.companyId, 'personal_info', {
      completedBy: 'employee',
    }).catch(() => {}); // ignore if already done

    await auditLog({
      companyId: req.employee.companyId, employeeId: req.employee.id,
      action: 'id_upload.submitted',
      ipAddress: getClientIP(req),
      metadata: { documentType, fileName },
    });

    res.status(201).json({
      success: true,
      uploadId: result.rows[0].id,
      message: 'ID uploaded. Your employer will verify it shortly.',
    });
  } catch (err) {
    console.error('ID upload error:', err);
    res.status(500).json({ error: 'Failed to upload ID' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// COMPANY DOCUMENTS
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/onboarding/company-docs ─────────────────────────────────────
router.get('/company-docs', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT cd.*,
         COUNT(ds.id) AS total_assigned,
         COUNT(ds.id) FILTER (WHERE ds.status = 'signed') AS total_signed
       FROM company_documents cd
       LEFT JOIN document_signatures ds ON ds.document_id = cd.id
       WHERE cd.company_id = $1 AND cd.active = true
       GROUP BY cd.id
       ORDER BY cd.created_at ASC`,
      [req.companyId]
    );
    res.json({ documents: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ── POST /api/onboarding/company-docs ────────────────────────────────────
router.post('/company-docs', requireAuth, requireRole('admin','hr'), [
  body('name').trim().notEmpty().withMessage('Document name required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, description, docType, requiresSignature, assignToAll } = req.body;

  try {
    const result = await query(
      `INSERT INTO company_documents
         (company_id, uploaded_by, name, description, doc_type,
          requires_signature, assign_to_all)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        req.companyId, req.user.id, name,
        description || null,
        docType || 'custom',
        requiresSignature !== false,
        assignToAll !== false,
      ]
    );

    await auditLog({
      companyId: req.companyId, userId: req.user.id,
      action: 'company_doc.uploaded',
      entityType: 'company_doc', entityId: result.rows[0].id,
      metadata: { name, docType },
    });

    res.status(201).json({ document: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create document' });
  }
});

// ── DELETE /api/onboarding/company-docs/:docId ───────────────────────────
router.delete('/company-docs/:docId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await query(
      `UPDATE company_documents SET active = false WHERE id = $1 AND company_id = $2`,
      [req.params.docId, req.companyId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove document' });
  }
});

module.exports = router;
