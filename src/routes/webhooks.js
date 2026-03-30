/**
 * FormGuard — Webhook Handler
 *
 * POST /api/webhooks/dropbox-sign
 *   Receives events from Dropbox Sign when documents are signed/declined/expired.
 *   Also triggers HR email notifications.
 *
 * POST /api/webhooks/dropbox-sign must be whitelisted in your Dropbox Sign
 * dashboard under API → Webhooks.
 */

const express = require('express');
const crypto = require('crypto');
const { processWebhookEvent } = require('../services/dropboxSign');
const { sendHRNotification } = require('../services/email');
const { query } = require('../db/pool');

const router = express.Router();

// Dropbox Sign sends JSON with the event wrapped in a "payload" string
// It also sends an API key header for verification
router.post('/dropbox-sign', express.text({ type: '*/*' }), async (req, res) => {
  try {
    // ── Verify the webhook is genuinely from Dropbox Sign ──────────────────
    // They include a header: x-hellosign-event-hash (HMAC-SHA256 of the payload)
    const apiKey     = process.env.DROPBOX_SIGN_API_KEY;
    const rawBody    = req.body;
    const receivedHash = req.headers['x-hellosign-event-hash'];

    if (receivedHash && apiKey) {
      const expectedHash = crypto
        .createHmac('sha256', apiKey)
        .update(rawBody)
        .digest('hex');

      if (receivedHash !== expectedHash) {
        console.warn('⚠️  Dropbox Sign webhook hash mismatch — possible forgery');
        return res.status(401).send('Hash mismatch');
      }
    }

    // ── Parse payload ──────────────────────────────────────────────────────
    let eventData;
    try {
      // Dropbox Sign sends: { payload: "<json string>" }
      const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
      eventData  = typeof body.payload === 'string' ? JSON.parse(body.payload) : body;
    } catch {
      return res.status(400).send('Invalid payload');
    }

    const eventType       = eventData?.event?.event_type;
    const sigReq          = eventData?.signature_request;
    const meta            = sigReq?.metadata || {};
    const employeeId      = meta.employee_id;
    const companyId       = meta.company_id;
    const docType         = meta.doc_type;

    console.log(`📬 Webhook received: ${eventType} | doc: ${docType} | emp: ${employeeId}`);

    // ── Must respond quickly — process async ──────────────────────────────
    // Dropbox Sign requires a 200 within 10s or it retries
    res.status(200).send('Hello API Event Received');

    // ── Process the event ─────────────────────────────────────────────────
    await processWebhookEvent(eventData);

    // ── Send HR email notification on completion ───────────────────────────
    if (eventType === 'signature_request_all_signed' && employeeId && companyId) {
      try {
        // Get employee + HR info
        const empResult = await query(
          `SELECT e.first_name, e.last_name, e.email, e.job_title,
                  u.email AS hr_email,
                  u.first_name AS hr_first_name,
                  c.name AS company_name
           FROM employees e
           JOIN companies c ON c.id = e.company_id
           LEFT JOIN users u ON u.company_id = e.company_id AND u.role IN ('admin','hr')
           WHERE e.id = $1
           ORDER BY u.created_at ASC
           LIMIT 1`,
          [employeeId]
        );

        if (empResult.rows.length) {
          const row = empResult.rows[0];
          await sendHRNotification({
            hrEmail:      row.hr_email,
            hrFirstName:  row.hr_first_name,
            employeeName: `${row.first_name} ${row.last_name}`,
            employeeEmail: row.email,
            jobTitle:     row.job_title,
            companyName:  row.company_name,
            docType:      docType?.toUpperCase(),
            completedAt:  new Date().toLocaleString(),
          });
        }
      } catch (emailErr) {
        // Email failure must not affect the webhook response
        console.error('HR notification email failed:', emailErr.message);
      }
    }

  } catch (err) {
    console.error('Webhook processing error:', err);
    // Still respond 200 so Dropbox Sign doesn't retry endlessly
    if (!res.headersSent) res.status(200).send('Error handled');
  }
});

module.exports = router;
