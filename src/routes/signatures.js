/**
 * FormGuard — Signature Routes
 *
 * POST /api/signatures/w4/request        — create W-4 signing request (employee)
 * POST /api/signatures/i9/request        — create I-9 signing request (employee)
 * GET  /api/signatures/i9/:id/employer-url — get employer sign URL (Section 2)
 * GET  /api/signatures/:requestId/status  — check status of a request
 */

const express = require('express');
const { query, getClient } = require('../db/pool');
const { validateInviteToken, requireAuth } = require('../middleware/auth');
const {
  createW4SignatureRequest,
  createI9SignatureRequest,
  getEmployerI9SignUrl,
} = require('../services/dropboxSign');
const { auditLog } = require('../utils/auditLog');

const router = express.Router();
const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ── POST /api/signatures/w4/request ──────────────────────────────────────
// Employee hits this after filling in W-4 form data.
// Returns a signUrl to load in the embedded iframe.
router.post('/w4/request', validateInviteToken, async (req, res) => {
  const emp = req.employee;

  try {
    // Look up employer HR email for notifications
    const hrResult = await query(
      `SELECT u.email, u.first_name || ' ' || u.last_name AS name
       FROM users u WHERE u.company_id = $1 AND u.role IN ('admin','hr')
       ORDER BY u.created_at ASC LIMIT 1`,
      [emp.companyId]
    );
    const hrEmail = hrResult.rows[0]?.email;

    const { signatureRequestId, signUrl } = await createW4SignatureRequest(
      emp,
      req.body,   // pre-fill data from the form
      hrEmail
    );

    // Persist the signature request ID so we can track it
    await query(
      `UPDATE w4_submissions
       SET pdf_s3_key = $1
       WHERE employee_id = $2`,
      [`ds_pending:${signatureRequestId}`, emp.id]
    ).catch(() => {
      // W-4 row may not exist yet — that's OK, webhook will update it
    });

    await auditLog({
      companyId: emp.companyId, employeeId: emp.id,
      action: 'w4.signature_requested',
      entityType: 'w4',
      ipAddress: getClientIP(req),
      metadata: { signatureRequestId },
    });

    res.json({ signUrl, signatureRequestId });
  } catch (err) {
    console.error('W-4 signature request error:', err);
    res.status(500).json({ error: 'Failed to create W-4 signature request: ' + err.message });
  }
});

// ── POST /api/signatures/i9/request ──────────────────────────────────────
// Employee hits this after filling in I-9 Section 1 data.
router.post('/i9/request', validateInviteToken, async (req, res) => {
  const emp = req.employee;

  try {
    // Get employer HR info for Section 2
    const hrResult = await query(
      `SELECT u.email, u.first_name || ' ' || u.last_name AS name
       FROM users u WHERE u.company_id = $1 AND u.role IN ('admin','hr')
       ORDER BY u.created_at ASC LIMIT 1`,
      [emp.companyId]
    );

    if (!hrResult.rows.length) {
      return res.status(400).json({ error: 'No HR user found to complete Section 2' });
    }

    const { email: hrEmail, name: hrName } = hrResult.rows[0];

    const { signatureRequestId, signUrl, employerSignerId } =
      await createI9SignatureRequest(emp, req.body, hrEmail, hrName);

    // Store employer signer ID so we can generate their sign URL later
    await query(
      `INSERT INTO i9_submissions (employee_id, company_id, first_name, last_name, pdf_s3_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (employee_id) DO UPDATE
       SET pdf_s3_key = EXCLUDED.pdf_s3_key`,
      [
        emp.id, emp.companyId,
        emp.firstName, emp.lastName,
        `ds_pending:${signatureRequestId}:employer:${employerSignerId}`,
      ]
    ).catch(() => {});

    await auditLog({
      companyId: emp.companyId, employeeId: emp.id,
      action: 'i9.signature_requested',
      entityType: 'i9',
      ipAddress: getClientIP(req),
      metadata: { signatureRequestId, employerSignerId },
    });

    res.json({ signUrl, signatureRequestId, employerSignerId });
  } catch (err) {
    console.error('I-9 signature request error:', err);
    res.status(500).json({ error: 'Failed to create I-9 signature request: ' + err.message });
  }
});

// ── GET /api/signatures/i9/:employeeId/employer-url ───────────────────────
// Called when HR wants to complete I-9 Section 2.
// Returns an embedded sign URL for the employer.
router.get('/i9/:employeeId/employer-url', requireAuth, async (req, res) => {
  try {
    const i9Result = await query(
      `SELECT pdf_s3_key FROM i9_submissions
       WHERE employee_id = $1 AND company_id = $2`,
      [req.params.employeeId, req.companyId]
    );

    if (!i9Result.rows.length) {
      return res.status(404).json({ error: 'I-9 not found for this employee' });
    }

    const key = i9Result.rows[0].pdf_s3_key || '';

    // Key format: ds_pending:<sigReqId>:employer:<employerSignerId>
    const match = key.match(/ds_pending:[^:]+:employer:(.+)/);
    if (!match) {
      return res.status(400).json({
        error: 'Employee has not completed Section 1 yet, or I-9 is already finalized',
      });
    }

    const employerSignerId = match[1];
    const signUrl = await getEmployerI9SignUrl(employerSignerId);

    await auditLog({
      companyId: req.companyId,
      employeeId: req.params.employeeId,
      userId: req.user.id,
      action: 'i9.employer_sign_url_generated',
      entityType: 'i9',
      ipAddress: getClientIP(req),
    });

    res.json({ signUrl });
  } catch (err) {
    console.error('Employer I-9 sign URL error:', err);
    res.status(500).json({ error: 'Failed to get employer sign URL: ' + err.message });
  }
});

// ── GET /api/signatures/:requestId/status ────────────────────────────────
// Check the status of any signature request
router.get('/:requestId/status', requireAuth, async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const API_KEY = process.env.DROPBOX_SIGN_API_KEY;
    const authHeader = 'Basic ' + Buffer.from(`${API_KEY}:`).toString('base64');

    const response = await fetch(
      `https://api.hellosign.com/v3/signature_request/${req.params.requestId}`,
      { headers: { Authorization: authHeader } }
    );

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch signature status' });
    }

    const data = await response.json();
    const sr = data.signature_request;

    res.json({
      signatureRequestId: sr.signature_request_id,
      title: sr.title,
      isComplete: sr.is_complete,
      isDeclined: sr.is_declined,
      hasError: sr.has_error,
      signers: sr.signatures.map(s => ({
        name: s.signer_name,
        email: s.signer_email_address,
        role: s.signer_role,
        statusCode: s.status_code,    // awaiting_signature | signed | declined
        signedAt: s.signed_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get signature status' });
  }
});

module.exports = router;
