/**
 * FormGuard — Write-ups Routes
 *
 * Employer (JWT):
 *   GET    /api/writeups                         — list all write-ups for company
 *   GET    /api/writeups/:employeeId             — write-ups for one employee
 *   POST   /api/writeups/:employeeId             — create write-up
 *   PUT    /api/writeups/:writeupId              — update draft
 *   POST   /api/writeups/:writeupId/send         — send to employee (generates token)
 *   GET    /api/writeups/:writeupId/status       — check acknowledgment status
 *   POST   /api/writeups/:employeeId/ai-draft    — generate AI unemployment draft
 *
 * Employee (ack token):
 *   GET    /api/writeups/acknowledge?token=      — view write-up
 *   POST   /api/writeups/acknowledge?token=      — submit response + sign/decline
 */

const express = require('express');
const crypto  = require('crypto');
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../utils/auditLog');
const { addTimelineEvent } = require('../services/timeline');
const { generateUnemploymentDraft } = require('../services/aiDraft');
const { sendEmail } = require('../services/email');

const router = express.Router();
const getClientIP = req =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ══════════════════════════════════════════════════════════════════════════════
// EMPLOYER ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/writeups ─────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const conditions = ['w.company_id = $1'];
    const params = [req.companyId];
    let i = 2;
    if (status) { conditions.push(`w.status = $${i++}`); params.push(status); }
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(
      `SELECT w.*,
              e.first_name, e.last_name, e.job_title,
              u.first_name || ' ' || u.last_name AS created_by_name
       FROM writeups w
       JOIN employees e ON e.id = w.employee_id
       LEFT JOIN users u ON u.id = w.created_by
       WHERE ${conditions.join(' AND ')}
       ORDER BY w.created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      params
    );
    res.json({ writeups: result.rows });
  } catch (err) {
    console.error('List writeups error:', err);
    res.status(500).json({ error: 'Failed to fetch write-ups' });
  }
});

// ── GET /api/writeups/:employeeId ─────────────────────────────────────────
router.get('/:employeeId', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT w.*,
              wa.employee_response, wa.action AS ack_action,
              wa.signed_at AS ack_signed_at, wa.signature_name AS ack_signature
       FROM writeups w
       LEFT JOIN writeup_acknowledgments wa ON wa.writeup_id = w.id
       WHERE w.employee_id = $1 AND w.company_id = $2
       ORDER BY w.created_at DESC`,
      [req.params.employeeId, req.companyId]
    );
    res.json({ writeups: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch write-ups' });
  }
});

// ── POST /api/writeups/:employeeId — create write-up ─────────────────────
router.post('/:employeeId', requireAuth, [
  body('incidentDate').isISO8601().withMessage('Valid incident date required'),
  body('incidentType').notEmpty().withMessage('Incident type required'),
  body('severity').isIn(['verbal_warning','written_warning','final_warning','suspension','termination']),
  body('incidentDescription').trim().notEmpty().withMessage('Incident description required'),
  body('employerSignatureName').trim().notEmpty().withMessage('Your signature is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const {
    incidentDate, incidentType, severity,
    incidentDescription, employerStatement, improvementPlan, consequences,
    priorWarningsCount, employerSignatureName,
  } = req.body;

  try {
    const empCheck = await query(
      `SELECT id FROM employees WHERE id = $1 AND company_id = $2`,
      [req.params.employeeId, req.companyId]
    );
    if (!empCheck.rows.length) return res.status(404).json({ error: 'Employee not found' });

    const result = await query(
      `INSERT INTO writeups
         (company_id, employee_id, created_by,
          incident_date, incident_type, severity,
          incident_description, employer_statement, improvement_plan, consequences,
          prior_warnings_count, employer_signature_name, employer_signed_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),'draft')
       RETURNING *`,
      [
        req.companyId, req.params.employeeId, req.user.id,
        incidentDate, incidentType, severity,
        incidentDescription, employerStatement || null,
        improvementPlan || null, consequences || null,
        parseInt(priorWarningsCount) || 0,
        employerSignatureName,
      ]
    );

    await auditLog({
      companyId: req.companyId, employeeId: req.params.employeeId, userId: req.user.id,
      action: 'writeup.created', entityType: 'writeup', entityId: result.rows[0].id,
      ipAddress: getClientIP(req),
      metadata: { severity, incidentType },
    });

    res.status(201).json({ writeup: result.rows[0] });
  } catch (err) {
    console.error('Create writeup error:', err);
    res.status(500).json({ error: 'Failed to create write-up' });
  }
});

// ── POST /api/writeups/:writeupId/send ────────────────────────────────────
router.post('/:writeupId/send', requireAuth, async (req, res) => {
  try {
    const wuResult = await query(
      `SELECT w.*, e.email, e.first_name, e.last_name, c.name AS company_name
       FROM writeups w
       JOIN employees e ON e.id = w.employee_id
       JOIN companies c ON c.id = w.company_id
       WHERE w.id = $1 AND w.company_id = $2`,
      [req.params.writeupId, req.companyId]
    );
    if (!wuResult.rows.length) return res.status(404).json({ error: 'Write-up not found' });
    const wu = wuResult.rows[0];

    if (wu.status === 'acknowledged') {
      return res.status(409).json({ error: 'Write-up already acknowledged' });
    }

    // Generate secure token
    const token = crypto.randomBytes(48).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 days

    await query(
      `UPDATE writeups SET ack_token=$1, ack_token_expires=$2, status='sent', updated_at=NOW()
       WHERE id=$3`,
      [token, expires, wu.id]
    );

    const ackUrl = `${process.env.APP_BASE_URL}/writeup-response?token=${token}`;

    // Send email to employee
    await sendEmail({
      to: wu.email,
      subject: `Action required: Please review and acknowledge a disciplinary notice — ${wu.company_name}`,
      html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f4f6f9;margin:0;padding:0">
<div style="max-width:540px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#0A1628;padding:24px 28px;display:flex;align-items:center;gap:10px">
    <div style="width:32px;height:32px;background:#00C9A7;border-radius:7px;display:flex;align-items:center;justify-content:center;color:#0A1628;font-weight:800;font-size:16px">✓</div>
    <span style="color:#fff;font-size:16px;font-weight:700">FormGuard</span>
  </div>
  <div style="padding:28px">
    <p style="font-size:15px;color:#111827;margin:0 0 14px">Hi ${wu.first_name},</p>
    <div style="background:#FAEEDA;border:1px solid #EF9F27;border-radius:8px;padding:14px 16px;margin-bottom:20px">
      <div style="font-size:13px;font-weight:700;color:#633806;margin-bottom:4px">Action Required</div>
      <div style="font-size:13px;color:#854F0B">You have a disciplinary notice from ${wu.company_name} that requires your review and acknowledgment.</div>
    </div>
    <p style="font-size:13px;color:#374151;line-height:1.6;margin-bottom:20px">Please click the button below to review the notice. You will have the opportunity to read the full document, add your written response or perspective, and sign to acknowledge receipt.</p>
    <p style="font-size:12px;color:#6b7280;margin-bottom:20px"><strong>Note:</strong> Acknowledging does not mean you agree with the contents — it only confirms you have received and read the notice. You may also choose to decline to sign, which will be noted in the record.</p>
    <a href="${ackUrl}" style="display:block;text-align:center;background:#1D9E75;color:#fff;text-decoration:none;padding:13px 20px;border-radius:8px;font-weight:700;font-size:14px;margin-bottom:16px">Review & Acknowledge Notice →</a>
    <p style="font-size:11px;color:#9ca3af;text-align:center">This link expires in 7 days. If you have questions, contact your HR manager directly.</p>
  </div>
</div>
</body></html>`,
    });

    await auditLog({
      companyId: req.companyId, employeeId: wu.employee_id, userId: req.user.id,
      action: 'writeup.sent', entityType: 'writeup', entityId: wu.id,
      metadata: { email: wu.email },
    });

    res.json({ success: true, message: `Write-up sent to ${wu.email}`, ackUrl });
  } catch (err) {
    console.error('Send writeup error:', err);
    res.status(500).json({ error: 'Failed to send write-up' });
  }
});

// ── POST /api/writeups/:employeeId/ai-draft ───────────────────────────────
router.post('/:employeeId/ai-draft', requireAuth, requireRole('admin','hr'), async (req, res) => {
  try {
    const result = await generateUnemploymentDraft(
      req.params.employeeId,
      req.companyId,
      req.user.id
    );
    res.json(result);
  } catch (err) {
    console.error('AI draft error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate AI draft' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE ROUTES (ack token — no JWT)
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/writeups/acknowledge?token= ─────────────────────────────────
router.get('/acknowledge', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    const result = await query(
      `SELECT w.*, e.first_name, e.last_name, c.name AS company_name,
              wa.employee_response, wa.action AS ack_action, wa.signed_at
       FROM writeups w
       JOIN employees e ON e.id = w.employee_id
       JOIN companies c ON c.id = w.company_id
       LEFT JOIN writeup_acknowledgments wa ON wa.writeup_id = w.id
       WHERE w.ack_token = $1`,
      [token]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Invalid or expired link' });
    const wu = result.rows[0];

    if (wu.ack_token_expires && new Date(wu.ack_token_expires) < new Date()) {
      return res.status(410).json({ error: 'This acknowledgment link has expired' });
    }

    // Sanitize — remove sensitive fields before sending to employee
    const {
      ack_token, ack_token_expires, notes,
      company_id, created_by, ...safeWriteup
    } = wu;

    res.json({ writeup: safeWriteup });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch write-up' });
  }
});

// ── POST /api/writeups/acknowledge?token= ─────────────────────────────────
router.post('/acknowledge', [
  body('action').isIn(['signed','declined']).withMessage('Action must be signed or declined'),
  body('signatureName').if(body('action').equals('signed')).trim().notEmpty().withMessage('Signature required to sign'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const { action, signatureName, employeeResponse } = req.body;

  try {
    const wuResult = await query(
      `SELECT w.id, w.employee_id, w.company_id, w.status, w.ack_token_expires
       FROM writeups w WHERE w.ack_token = $1`,
      [token]
    );

    if (!wuResult.rows.length) return res.status(404).json({ error: 'Invalid link' });
    const wu = wuResult.rows[0];

    if (wu.ack_token_expires && new Date(wu.ack_token_expires) < new Date()) {
      return res.status(410).json({ error: 'This link has expired' });
    }

    if (wu.status === 'acknowledged' || wu.status === 'declined') {
      return res.status(409).json({ error: 'Already responded to this write-up' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Save acknowledgment
      await client.query(
        `INSERT INTO writeup_acknowledgments
           (writeup_id, employee_id, company_id,
            employee_response, response_submitted_at,
            action, signature_name, signed_at, signer_ip, signer_user_agent)
         VALUES ($1,$2,$3,$4,NOW(),$5,$6,NOW(),$7,$8)`,
        [
          wu.id, wu.employee_id, wu.company_id,
          employeeResponse || null,
          action,
          action === 'signed' ? signatureName : null,
          getClientIP(req),
          req.headers['user-agent'],
        ]
      );

      // Update writeup status
      await client.query(
        `UPDATE writeups SET status=$1, updated_at=NOW() WHERE id=$2`,
        [action === 'signed' ? 'acknowledged' : 'declined', wu.id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Add to employee timeline
    await addTimelineEvent(wu.employee_id, wu.company_id, {
      eventType: action === 'signed' ? 'writeup_acknowledged' : 'writeup_declined',
      eventTitle: action === 'signed' ? 'Write-up acknowledged' : 'Declined to sign write-up',
      eventDetail: action === 'signed'
        ? `Employee signed the disciplinary notice${employeeResponse ? ' and submitted a response' : ''}.`
        : 'Employee declined to sign. Refusal recorded.',
      triggeredBy: 'employee',
      referenceId: wu.id,
      referenceType: 'writeup',
    });

    await auditLog({
      companyId: wu.company_id, employeeId: wu.employee_id,
      action: `writeup.${action}`,
      entityType: 'writeup', entityId: wu.id,
      ipAddress: getClientIP(req),
      metadata: { action, hasResponse: !!employeeResponse },
    });

    res.json({
      success: true,
      action,
      message: action === 'signed'
        ? 'You have acknowledged the notice. A copy has been recorded.'
        : 'Your refusal to sign has been recorded. The notice is still valid.',
    });
  } catch (err) {
    console.error('Acknowledge writeup error:', err);
    res.status(500).json({ error: 'Failed to process acknowledgment' });
  }
});

module.exports = router;
