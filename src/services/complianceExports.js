/**
 * FormGuard — Compliance Export Service
 *
 * Generates:
 *  1. ICE / DHS I-9 Audit Package
 *     - Single PDF: all I-9s + ID docs combined with cover sheet
 *     - ZIP: one folder per employee with their I-9 + ID docs
 *
 *  2. EEOC Compliance Report
 *     - Workforce demographics summary
 *     - Pay equity analysis by gender and race
 *     - EEO-1 headcount by job category
 *
 * In production these would use a PDF library (pdfkit or puppeteer).
 * For now we generate structured JSON that the frontend renders,
 * and flag where PDF generation hooks in.
 */

const { query } = require('../db/pool');
const { auditLog } = require('../utils/auditLog');

// ─────────────────────────────────────────────────────────────────────────────
// ICE / DHS I-9 AUDIT PACKAGE DATA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gather all data needed for an ICE audit response.
 * Returns structured data ready for PDF generation.
 *
 * Federal requirement: produce I-9s for:
 *   - All current employees
 *   - Former employees still within retention window
 *     (3 years from hire OR 1 year from termination, whichever is later)
 */
const getICEAuditData = async (companyId) => {
  // Company info
  const companyResult = await query(
    `SELECT name, ein, address, city, state, zip FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = companyResult.rows[0];

  // Active employees with I-9 data
  const activeResult = await query(
    `SELECT
       e.id, e.first_name, e.last_name, e.email,
       e.job_title, e.employment_status, e.created_at AS hire_date,
       i.id AS i9_id,
       i.first_name AS i9_first_name,
       i.last_name AS i9_last_name,
       i.dob, i.citizen_status,
       i.alien_reg_number, i.i94_number, i.auth_exp_date,
       i.doc_list_a, i.doc_list_b, i.doc_list_c,
       i.doc_issuing_authority, i.doc_number, i.doc_expiration_date,
       i.emp_signature_name, i.emp_signed_at,
       i.employer_signature_name, i.employer_title, i.employer_signed_at,
       i.employer_business_name, i.section1_completed_at, i.section2_completed_at,
       i.form_edition,
       p.start_date
     FROM employees e
     LEFT JOIN i9_submissions i ON i.employee_id = e.id
     LEFT JOIN employee_profiles p ON p.employee_id = e.id
     WHERE e.company_id = $1
       AND e.employment_status = 'active'
     ORDER BY e.last_name, e.first_name`,
    [companyId]
  );

  // Terminated employees still within I-9 retention window
  const terminatedResult = await query(
    `SELECT
       e.id, e.first_name, e.last_name, e.email,
       e.job_title, e.employment_status,
       t.termination_date, t.i9_retain_until,
       i.id AS i9_id,
       i.first_name AS i9_first_name, i.last_name AS i9_last_name,
       i.dob, i.citizen_status,
       i.doc_list_a, i.doc_list_b, i.doc_list_c,
       i.doc_number, i.doc_expiration_date,
       i.emp_signature_name, i.emp_signed_at,
       i.employer_signature_name, i.employer_signed_at,
       i.section1_completed_at, i.section2_completed_at,
       p.start_date
     FROM employees e
     JOIN termination_records t ON t.employee_id = e.id
     LEFT JOIN i9_submissions i ON i.employee_id = e.id
     LEFT JOIN employee_profiles p ON p.employee_id = e.id
     WHERE e.company_id = $1
       AND e.employment_status = 'terminated'
       AND t.i9_retain_until >= CURRENT_DATE
     ORDER BY e.last_name, e.first_name`,
    [companyId]
  );

  return {
    company,
    generatedAt: new Date().toISOString(),
    activeEmployees: activeResult.rows,
    terminatedEmployees: terminatedResult.rows,
    totalActive: activeResult.rows.length,
    totalTerminated: terminatedResult.rows.length,
    totalIncluded: activeResult.rows.length + terminatedResult.rows.length,
    missingI9: activeResult.rows.filter(e => !e.i9_id).length,
    incompleteI9: activeResult.rows.filter(e => e.i9_id && !e.section2_completed_at).length,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// EEOC COMPLIANCE REPORT DATA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate workforce demographics for EEOC reporting.
 * Never returns individual-level race/gender data.
 * Only returns aggregate counts and averages.
 */
const getEEOCReportData = async (companyId) => {
  const companyResult = await query(
    `SELECT name, ein, address, city, state, zip FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = companyResult.rows[0];

  // Total workforce
  const totalResult = await query(
    `SELECT COUNT(*) AS total FROM employees
     WHERE company_id = $1 AND employment_status = 'active'`,
    [companyId]
  );

  // Gender breakdown (aggregate only)
  const genderResult = await query(
    `SELECT
       COALESCE(d.gender, 'not_provided') AS gender,
       COUNT(*) AS count,
       ROUND(AVG(d.pay_rate)::numeric, 2) AS avg_pay,
       MIN(d.pay_rate) AS min_pay,
       MAX(d.pay_rate) AS max_pay
     FROM employees e
     LEFT JOIN employee_demographics d ON d.employee_id = e.id
     WHERE e.company_id = $1 AND e.employment_status = 'active'
     GROUP BY COALESCE(d.gender, 'not_provided')
     ORDER BY count DESC`,
    [companyId]
  );

  // Race/ethnicity breakdown (aggregate only)
  const raceResult = await query(
    `SELECT
       COALESCE(d.race_ethnicity, 'not_provided') AS race_ethnicity,
       COUNT(*) AS count,
       ROUND(AVG(d.pay_rate)::numeric, 2) AS avg_pay
     FROM employees e
     LEFT JOIN employee_demographics d ON d.employee_id = e.id
     WHERE e.company_id = $1 AND e.employment_status = 'active'
     GROUP BY COALESCE(d.race_ethnicity, 'not_provided')
     ORDER BY count DESC`,
    [companyId]
  );

  // EEO-1 job category breakdown
  const eeo1Result = await query(
    `SELECT
       COALESCE(d.eeo1_job_category, 'not_assigned') AS job_category,
       COALESCE(d.gender, 'not_provided') AS gender,
       COALESCE(d.race_ethnicity, 'not_provided') AS race_ethnicity,
       COUNT(*) AS count
     FROM employees e
     LEFT JOIN employee_demographics d ON d.employee_id = e.id
     WHERE e.company_id = $1 AND e.employment_status = 'active'
     GROUP BY
       COALESCE(d.eeo1_job_category, 'not_assigned'),
       COALESCE(d.gender, 'not_provided'),
       COALESCE(d.race_ethnicity, 'not_provided')
     ORDER BY job_category, count DESC`,
    [companyId]
  );

  // Pay equity — gender pay gap
  const payGapResult = await query(
    `SELECT
       d.gender,
       COUNT(*) AS employee_count,
       ROUND(AVG(d.pay_rate)::numeric, 2) AS avg_pay,
       d.pay_type
     FROM employee_demographics d
     JOIN employees e ON e.id = d.employee_id
     WHERE d.company_id = $1
       AND e.employment_status = 'active'
       AND d.gender IS NOT NULL
       AND d.gender != 'prefer_not_to_say'
       AND d.pay_rate IS NOT NULL
     GROUP BY d.gender, d.pay_type
     HAVING COUNT(*) > 1   -- never show single-person groups (privacy)
     ORDER BY d.pay_type, avg_pay DESC`,
    [companyId]
  );

  // Self-identification response rate
  const responseRateResult = await query(
    `SELECT
       COUNT(*) AS total_employees,
       COUNT(d.employee_id) AS provided_demographics,
       ROUND((COUNT(d.employee_id)::numeric / NULLIF(COUNT(*), 0)) * 100, 1) AS response_rate
     FROM employees e
     LEFT JOIN employee_demographics d
       ON d.employee_id = e.id AND d.self_identified_at IS NOT NULL
     WHERE e.company_id = $1 AND e.employment_status = 'active'`,
    [companyId]
  );

  return {
    company,
    generatedAt: new Date().toISOString(),
    reportingPeriod: {
      start: new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10),
      end: new Date().toISOString().slice(0, 10),
    },
    workforce: {
      total: parseInt(totalResult.rows[0].total),
      responseRate: responseRateResult.rows[0],
    },
    genderBreakdown: genderResult.rows,
    raceBreakdown: raceResult.rows,
    eeo1Breakdown: eeo1Result.rows,
    payEquity: payGapResult.rows,
    disclaimer: [
      'All demographic data is based on voluntary employee self-identification.',
      'Employees who chose "prefer not to say" or did not respond are excluded from pay equity calculations.',
      'Groups with fewer than 2 employees are excluded from pay equity analysis to protect individual privacy.',
      'This report is generated for internal compliance review only.',
    ],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// LOG EXPORT (every export must be recorded)
// ─────────────────────────────────────────────────────────────────────────────

const logExport = async ({
  companyId, userId, exportType,
  employeeCount, includesTerminated = false,
  fileReference = null, ipAddress = null,
  userAgent = null, notes = null,
}) => {
  const result = await query(
    `INSERT INTO compliance_exports
       (company_id, exported_by, export_type, employee_count,
        includes_terminated, file_reference, ip_address, user_agent, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, created_at`,
    [companyId, userId, exportType, employeeCount,
     includesTerminated, fileReference, ipAddress, userAgent, notes]
  );

  await auditLog({
    companyId, userId,
    action: `compliance.export.${exportType}`,
    entityType: 'compliance',
    ipAddress,
    metadata: { exportType, employeeCount, includesTerminated, notes },
  });

  return result.rows[0];
};

// Get export history for a company
const getExportHistory = async (companyId, limit = 50) => {
  const result = await query(
    `SELECT ce.*, u.first_name || ' ' || u.last_name AS exported_by_name
     FROM compliance_exports ce
     LEFT JOIN users u ON u.id = ce.exported_by
     WHERE ce.company_id = $1
     ORDER BY ce.created_at DESC
     LIMIT $2`,
    [companyId, limit]
  );
  return result.rows;
};

module.exports = {
  getICEAuditData,
  getEEOCReportData,
  logExport,
  getExportHistory,
};
