/**
 * FormGuard — Dropbox Sign (HelloSign) Integration
 *
 * Handles:
 *  - Creating embedded signature requests for W-4 and I-9
 *  - Downloading signed PDFs once complete
 *  - Webhook event processing (signed, declined, expired)
 *  - Storing signed PDF references in the database
 */

const FormData = require('form-data');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { query } = require('../db/pool');
const { auditLog } = require('../utils/auditLog');

const API_BASE = 'https://api.hellosign.com/v3';
const API_KEY = process.env.DROPBOX_SIGN_API_KEY;
const CLIENT_ID = process.env.DROPBOX_SIGN_CLIENT_ID; // for embedded signing
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5173';

// Basic auth header — Dropbox Sign uses API key as username, empty password
const authHeader = () =>
  'Basic ' + Buffer.from(`${API_KEY}:`).toString('base64');

/**
 * Make an authenticated request to the Dropbox Sign API
 */
const dsRequest = async (endpoint, options = {}) => {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: authHeader(),
      ...(options.headers || {}),
    },
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.error_msg || `Dropbox Sign error ${res.status}`;
    throw new Error(msg);
  }

  return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// W-4 SIGNATURE REQUEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an embedded W-4 signature request.
 * Returns { signatureRequestId, signUrl } — signUrl is loaded in an iframe.
 *
 * @param {Object} employee  — { id, firstName, lastName, email, companyId }
 * @param {Object} w4Data    — pre-filled form field values
 * @param {string} requestedBy — HR user email
 */
const createW4SignatureRequest = async (employee, w4Data, requestedBy) => {
  const form = new FormData();

  // ── Signers ──────────────────────────────────────────────────────────────
  form.append('signers[0][name]',        `${employee.firstName} ${employee.lastName}`);
  form.append('signers[0][email_address]', employee.email);
  form.append('signers[0][order]',       '0');

  // ── Document ─────────────────────────────────────────────────────────────
  // In production: use the actual IRS W-4 PDF template uploaded to Dropbox Sign
  // For now: use the template ID stored in env, OR send a blank PDF placeholder
  if (process.env.DROPBOX_SIGN_W4_TEMPLATE_ID) {
    form.append('template_ids[0]', process.env.DROPBOX_SIGN_W4_TEMPLATE_ID);
  } else {
    // Attach a placeholder PDF (replace with real IRS W-4 PDF in production)
    const placeholderPath = path.join(__dirname, '../assets/w4-placeholder.pdf');
    if (fs.existsSync(placeholderPath)) {
      form.append('files[0]', fs.createReadStream(placeholderPath), 'w4-2026.pdf');
    }
  }

  // ── Metadata ─────────────────────────────────────────────────────────────
  form.append('title',          'IRS Form W-4 (2026) — Employee Withholding Certificate');
  form.append('subject',        'Please sign your W-4 form');
  form.append('message',
    `Hi ${employee.firstName}, please review and sign your W-4 form. ` +
    `This is required for payroll setup.`
  );
  form.append('client_id',      CLIENT_ID || '');
  form.append('is_for_embedded_signing', '1');
  form.append('skip_me_now',    '1');
  form.append('test_mode',      process.env.NODE_ENV !== 'production' ? '1' : '0');

  // ── Callback (webhook) ───────────────────────────────────────────────────
  form.append('signing_redirect_url', `${APP_BASE_URL}/onboard/complete?doc=w4`);
  form.append('metadata[employee_id]',  employee.id);
  form.append('metadata[company_id]',   employee.companyId);
  form.append('metadata[doc_type]',     'w4');

  // ── Pre-fill custom fields ────────────────────────────────────────────────
  if (w4Data) {
    const fields = [
      { name: 'first_name',     value: w4Data.firstName || '' },
      { name: 'last_name',      value: w4Data.lastName || '' },
      { name: 'address',        value: w4Data.address || '' },
      { name: 'city_state_zip', value: `${w4Data.city || ''}, ${w4Data.state || ''} ${w4Data.zip || ''}` },
      { name: 'filing_status',  value: w4Data.filingStatus || '' },
    ];
    fields.forEach((f, i) => {
      form.append(`custom_fields[${i}][name]`,  f.name);
      form.append(`custom_fields[${i}][value]`, f.value);
    });
  }

  const data = await dsRequest('/signature_request/create_embedded', {
    method: 'POST',
    body: form,
  });

  const sigReqId  = data.signature_request.signature_request_id;
  const signerId  = data.signature_request.signatures[0].signature_id;

  // Get the embedded sign URL
  const embedData = await dsRequest(`/embedded/sign_url/${signerId}`);
  const signUrl   = embedData.embedded.sign_url;

  return { signatureRequestId: sigReqId, signerId, signUrl };
};

// ─────────────────────────────────────────────────────────────────────────────
// I-9 SIGNATURE REQUEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an embedded I-9 signature request — two signers:
 *   [0] Employee  (Section 1)
 *   [1] Employer  (Section 2 — HR/admin)
 *
 * Returns signUrl for the employee (signer 0).
 * Employer gets their own signUrl after employee completes.
 */
const createI9SignatureRequest = async (employee, i9Data, employerEmail, employerName) => {
  const form = new FormData();

  // ── Signers ──────────────────────────────────────────────────────────────
  // Signer 0: Employee (Section 1)
  form.append('signers[0][name]',          `${employee.firstName} ${employee.lastName}`);
  form.append('signers[0][email_address]',  employee.email);
  form.append('signers[0][order]',         '0');
  form.append('signers[0][role]',          'Employee');

  // Signer 1: Employer (Section 2) — signs after employee
  form.append('signers[1][name]',          employerName || 'HR Manager');
  form.append('signers[1][email_address]',  employerEmail);
  form.append('signers[1][order]',         '1');
  form.append('signers[1][role]',          'Employer');

  // ── Document ─────────────────────────────────────────────────────────────
  if (process.env.DROPBOX_SIGN_I9_TEMPLATE_ID) {
    form.append('template_ids[0]', process.env.DROPBOX_SIGN_I9_TEMPLATE_ID);
  } else {
    const placeholderPath = path.join(__dirname, '../assets/i9-placeholder.pdf');
    if (fs.existsSync(placeholderPath)) {
      form.append('files[0]', fs.createReadStream(placeholderPath), 'i9-2023.pdf');
    }
  }

  // ── Metadata ─────────────────────────────────────────────────────────────
  form.append('title',    'USCIS Form I-9 — Employment Eligibility Verification');
  form.append('subject',  'Action Required: Complete your I-9 form');
  form.append('message',
    `Hi ${employee.firstName}, please complete Section 1 of your I-9 form. ` +
    `Your employer will then verify your documents and complete Section 2.`
  );
  form.append('client_id',               CLIENT_ID || '');
  form.append('is_for_embedded_signing', '1');
  form.append('skip_me_now',             '1');
  form.append('test_mode',               process.env.NODE_ENV !== 'production' ? '1' : '0');
  form.append('signing_redirect_url',    `${APP_BASE_URL}/onboard/complete?doc=i9`);
  form.append('metadata[employee_id]',   employee.id);
  form.append('metadata[company_id]',    employee.companyId);
  form.append('metadata[doc_type]',      'i9');

  const data = await dsRequest('/signature_request/create_embedded', {
    method: 'POST',
    body: form,
  });

  const sigReq   = data.signature_request;
  const sigReqId = sigReq.signature_request_id;

  // Employee is signer 0
  const empSigner = sigReq.signatures.find(s => s.signer_role === 'Employee')
    || sigReq.signatures[0];

  const embedData = await dsRequest(`/embedded/sign_url/${empSigner.signature_id}`);

  return {
    signatureRequestId: sigReqId,
    employeeSignerId:   empSigner.signature_id,
    employerSignerId:   sigReq.signatures[1]?.signature_id,
    signUrl:            embedData.embedded.sign_url,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYER SIGN URL (I-9 Section 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a sign URL for the employer to complete I-9 Section 2.
 * Call this after the employee has completed Section 1.
 */
const getEmployerI9SignUrl = async (employerSignerId) => {
  const embedData = await dsRequest(`/embedded/sign_url/${employerSignerId}`);
  return embedData.embedded.sign_url;
};

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD SIGNED PDF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download the completed signed PDF from Dropbox Sign.
 * Returns a Buffer.
 */
const downloadSignedPDF = async (signatureRequestId) => {
  const res = await fetch(
    `${API_BASE}/signature_request/${signatureRequestId}/files?file_type=pdf`,
    { headers: { Authorization: authHeader() } }
  );

  if (!res.ok) {
    throw new Error(`Failed to download signed PDF: ${res.status}`);
  }

  return res.buffer();
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL / REVOKE
// ─────────────────────────────────────────────────────────────────────────────

const cancelSignatureRequest = async (signatureRequestId) => {
  await dsRequest(`/signature_request/cancel/${signatureRequestId}`, {
    method: 'POST',
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK EVENT PROCESSOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process incoming Dropbox Sign webhook events.
 * Called from POST /api/webhooks/dropbox-sign
 *
 * Key events:
 *   signature_request_signed       — one signer completed
 *   signature_request_all_signed   — all signers done → download PDF
 *   signature_request_declined     — signer declined
 *   signature_request_expired      — request timed out
 */
const processWebhookEvent = async (eventData) => {
  const { event, signature_request } = eventData;
  const eventType = event?.event_type;

  if (!eventType || !signature_request) return;

  const sigReqId   = signature_request.signature_request_id;
  const meta       = signature_request.metadata || {};
  const employeeId = meta.employee_id;
  const companyId  = meta.company_id;
  const docType    = meta.doc_type; // 'w4' or 'i9'

  console.log(`📬 Dropbox Sign webhook: ${eventType} | ${docType} | employee: ${employeeId}`);

  switch (eventType) {

    case 'signature_request_signed': {
      // One signer completed — update status to 'pending' (waiting for next signer if I-9)
      if (docType === 'w4') {
        await query(
          `UPDATE employees SET w4_status = 'pending', updated_at = NOW() WHERE id = $1`,
          [employeeId]
        );
      }
      await auditLog({
        companyId, employeeId,
        action: `${docType}.signer_completed`,
        entityType: docType,
        metadata: { signatureRequestId: sigReqId, eventType },
      });
      break;
    }

    case 'signature_request_all_signed': {
      // All signers done — download PDF and update DB
      try {
        const pdfBuffer = await downloadSignedPDF(sigReqId);

        // In production: upload pdfBuffer to S3 and store the key
        // For now: store the signature_request_id as reference
        const s3Key = `signed/${companyId}/${docType}/${employeeId}/${sigReqId}.pdf`;

        if (docType === 'w4') {
          await query(
            `UPDATE w4_submissions
             SET pdf_s3_key = $1
             WHERE employee_id = $2`,
            [s3Key, employeeId]
          );
          await query(
            `UPDATE employees
             SET w4_status = 'completed', w4_completed_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [employeeId]
          );
        } else if (docType === 'i9') {
          await query(
            `UPDATE i9_submissions
             SET pdf_s3_key = $1, section2_completed_at = NOW()
             WHERE employee_id = $2`,
            [s3Key, employeeId]
          );
          await query(
            `UPDATE employees
             SET i9_status = 'completed', i9_completed_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [employeeId]
          );
        }

        await auditLog({
          companyId, employeeId,
          action: `${docType}.fully_signed`,
          entityType: docType,
          metadata: { signatureRequestId: sigReqId, s3Key },
        });

        console.log(`✅ ${docType.toUpperCase()} fully signed for employee ${employeeId}`);
      } catch (err) {
        console.error(`❌ Failed to process fully-signed ${docType}:`, err.message);
      }
      break;
    }

    case 'signature_request_declined': {
      const status = docType === 'w4' ? 'not_started' : 'not_started';
      if (docType === 'w4') {
        await query(`UPDATE employees SET w4_status = $1 WHERE id = $2`, [status, employeeId]);
      } else {
        await query(`UPDATE employees SET i9_status = $1 WHERE id = $2`, [status, employeeId]);
      }
      await auditLog({
        companyId, employeeId,
        action: `${docType}.declined`,
        entityType: docType,
        metadata: { signatureRequestId: sigReqId },
      });
      break;
    }

    case 'signature_request_expired': {
      await auditLog({
        companyId, employeeId,
        action: `${docType}.expired`,
        entityType: docType,
        metadata: { signatureRequestId: sigReqId },
      });
      break;
    }
  }
};

module.exports = {
  createW4SignatureRequest,
  createI9SignatureRequest,
  getEmployerI9SignUrl,
  downloadSignedPDF,
  cancelSignatureRequest,
  processWebhookEvent,
};
