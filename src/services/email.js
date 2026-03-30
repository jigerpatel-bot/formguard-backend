/**
 * FormGuard — Email Service (Resend)
 *
 * Sends:
 *  - HR notification when a document is fully signed
 *
 * Uses Resend (resend.com) — simple, reliable, free tier available.
 * Sign up at resend.com, get an API key, add to .env as RESEND_API_KEY.
 */

const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const FROM_EMAIL      = process.env.FROM_EMAIL || 'noreply@yourdomain.com';
const APP_BASE_URL    = process.env.APP_BASE_URL || 'http://localhost:5173';

/**
 * Send an email via Resend API
 */
const sendEmail = async ({ to, subject, html }) => {
  if (!RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not set — email not sent. Would have sent to:', to);
    console.warn('   Subject:', subject);
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error: ${err}`);
  }

  return res.json();
};

// ─────────────────────────────────────────────────────────────────────────────
// HR NOTIFICATION — document fully signed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify HR/admin that an employee has completed a document.
 *
 * @param {Object} params
 * @param {string} params.hrEmail
 * @param {string} params.hrFirstName
 * @param {string} params.employeeName
 * @param {string} params.employeeEmail
 * @param {string} params.jobTitle
 * @param {string} params.companyName
 * @param {string} params.docType        — 'W-4' or 'I-9'
 * @param {string} params.completedAt
 */
const sendHRNotification = async ({
  hrEmail, hrFirstName, employeeName, employeeEmail,
  jobTitle, companyName, docType, completedAt,
}) => {
  const dashboardUrl = `${APP_BASE_URL}/dashboard`;

  const subject = `✅ ${employeeName} has completed their ${docType} — ${companyName}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f6f9; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { background: #0A1628; padding: 28px 32px; }
    .logo { display: flex; align-items: center; gap: 10px; }
    .logo-icon { width: 36px; height: 36px; background: #00C9A7; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: #0A1628; font-weight: 800; font-size: 18px; }
    .logo-text { color: #ffffff; font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
    .body { padding: 32px; }
    .greeting { font-size: 16px; color: #1a2b42; margin-bottom: 20px; }
    .alert-box { background: #f0fdf9; border: 1px solid #00C9A7; border-radius: 10px; padding: 20px 24px; margin-bottom: 24px; }
    .alert-title { font-size: 15px; font-weight: 700; color: #00a88a; margin-bottom: 4px; }
    .alert-body { font-size: 14px; color: #374151; }
    .detail-table { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
    .detail-table td { padding: 10px 0; border-bottom: 1px solid #f0f2f5; font-size: 14px; }
    .detail-table td:first-child { color: #6b7280; width: 40%; }
    .detail-table td:last-child { color: #111827; font-weight: 600; }
    .cta-btn { display: block; width: fit-content; margin: 0 auto 28px; background: #00C9A7; color: #0A1628; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 700; font-size: 15px; }
    .footer { padding: 20px 32px; border-top: 1px solid #f0f2f5; font-size: 12px; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">
        <div class="logo-icon">✓</div>
        <span class="logo-text">FormGuard</span>
      </div>
    </div>
    <div class="body">
      <p class="greeting">Hi ${hrFirstName || 'there'},</p>

      <div class="alert-box">
        <div class="alert-title">Document Signed ✓</div>
        <div class="alert-body">
          <strong>${employeeName}</strong> has successfully completed and signed their
          <strong>${docType}</strong> form.
        </div>
      </div>

      <table class="detail-table">
        <tr><td>Employee</td><td>${employeeName}</td></tr>
        <tr><td>Email</td><td>${employeeEmail}</td></tr>
        <tr><td>Job Title</td><td>${jobTitle || '—'}</td></tr>
        <tr><td>Document</td><td>${docType}</td></tr>
        <tr><td>Completed</td><td>${completedAt}</td></tr>
        <tr><td>Company</td><td>${companyName}</td></tr>
      </table>

      ${docType === 'I-9' ? `
      <div style="background:#fffbeb; border:1px solid #f59e0b; border-radius:8px; padding:14px 18px; margin-bottom:24px; font-size:13px; color:#92400e;">
        <strong>⚠️ Action Required:</strong> You must complete I-9 Section 2 (employer verification)
        within <strong>3 business days</strong> of the employee's first day of work.
        Please log in to FormGuard to complete your portion.
      </div>
      ` : ''}

      <a href="${dashboardUrl}" class="cta-btn">View in FormGuard Dashboard →</a>

      <p style="font-size:13px; color:#6b7280; line-height:1.6;">
        The signed document has been securely stored with a full audit trail.
        You can download the PDF anytime from the employee's profile in FormGuard.
      </p>
    </div>
    <div class="footer">
      <p>FormGuard HR Compliance · <a href="${APP_BASE_URL}" style="color:#00C9A7;">formguard.com</a></p>
      <p>This is an automated notification. Do not reply to this email.</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({ to: hrEmail, subject, html });
};

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE INVITE EMAIL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send the invite link to a new employee.
 * Call this from the invite route once you have Resend set up.
 *
 * @param {Object} params
 * @param {string} params.employeeEmail
 * @param {string} params.employeeFirstName
 * @param {string} params.companyName
 * @param {string} params.inviteUrl
 * @param {string} params.expiresAt        — ISO date string
 * @param {string} params.hrName
 */
const sendEmployeeInvite = async ({
  employeeEmail, employeeFirstName, companyName,
  inviteUrl, expiresAt, hrName,
}) => {
  const expiry = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : '72 hours';

  const subject = `Action Required: Complete your W-4 & I-9 for ${companyName}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f6f9; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { background: #0A1628; padding: 28px 32px; }
    .logo-icon { display: inline-block; width: 36px; height: 36px; background: #00C9A7; border-radius: 8px; text-align: center; line-height: 36px; color: #0A1628; font-weight: 800; font-size: 18px; vertical-align: middle; }
    .logo-text { color: #ffffff; font-size: 18px; font-weight: 800; vertical-align: middle; margin-left: 10px; }
    .body { padding: 32px; }
    .steps { background: #f8fafc; border-radius: 10px; padding: 20px 24px; margin: 20px 0 28px; }
    .step { display: flex; gap: 14px; margin-bottom: 14px; font-size: 14px; color: #374151; }
    .step-num { width: 24px; height: 24px; background: #00C9A7; border-radius: 50%; color: #0A1628; font-weight: 800; font-size: 12px; text-align: center; line-height: 24px; flex-shrink: 0; }
    .cta-btn { display: block; background: #00C9A7; color: #0A1628; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 700; font-size: 16px; text-align: center; margin: 0 0 20px; }
    .expiry { font-size: 13px; color: #ef4444; text-align: center; margin-bottom: 24px; }
    .footer { padding: 20px 32px; border-top: 1px solid #f0f2f5; font-size: 12px; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <span class="logo-icon">✓</span>
      <span class="logo-text">FormGuard</span>
    </div>
    <div class="body">
      <h2 style="font-size:20px; color:#0A1628; margin:0 0 12px;">Welcome to ${companyName}! 👋</h2>
      <p style="font-size:15px; color:#374151; margin-bottom:20px;">
        Hi ${employeeFirstName}, ${hrName || 'your employer'} has invited you to complete
        your required new hire paperwork — a <strong>W-4</strong> and <strong>I-9</strong> form.
        This takes about 5 minutes.
      </p>

      <div class="steps">
        <div class="step"><span class="step-num">1</span><span>Click the button below to open your secure onboarding link.</span></div>
        <div class="step"><span class="step-num">2</span><span>Fill in your W-4 (tax withholding) form and sign electronically.</span></div>
        <div class="step"><span class="step-num">3</span><span>Fill in your I-9 (employment eligibility) form and sign electronically.</span></div>
        <div class="step" style="margin-bottom:0"><span class="step-num">4</span><span>Done! Your employer will be notified automatically.</span></div>
      </div>

      <a href="${inviteUrl}" class="cta-btn">Complete My W-4 &amp; I-9 →</a>

      <p class="expiry">⏰ This link expires on ${expiry}. Please complete your forms before then.</p>

      <p style="font-size:13px; color:#6b7280; line-height:1.6;">
        🔒 Your information is encrypted and stored securely. Your Social Security Number
        is encrypted using AES-256 and never stored in plain text.
      </p>
      <p style="font-size:13px; color:#6b7280;">
        If you have questions, contact ${hrName || 'your HR team'} directly.
        Do not reply to this email.
      </p>
    </div>
    <div class="footer">
      <p>FormGuard HR Compliance · Secure New Hire Onboarding</p>
      <p>If you did not expect this email, please ignore it.</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({ to: employeeEmail, subject, html });
};

module.exports = { sendHRNotification, sendEmployeeInvite, sendEmail };
