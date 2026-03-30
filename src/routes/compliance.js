/**
 * FormGuard — Compliance Export Routes
 * All routes require admin role.
 *
 * GET  /api/compliance/ice/data              — get audit package data (JSON)
 * POST /api/compliance/ice/generate          — generate + log the export
 * GET  /api/compliance/eeoc/report           — EEOC report data (JSON)
 * GET  /api/compliance/exports/history       — past export log
 * GET  /api/compliance/status                — company-wide compliance overview
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { query } = require('../db/pool');
const {
  getICEAuditData,
  getEEOCReportData,
  logExport,
  getExportHistory,
} = require('../services/complianceExports');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ── GET /api/compliance/ice/data ─────────────────────────────────────────
// Returns structured I-9 data for all employees in scope
router.get('/ice/data', async (req, res) => {
  try {
    const data = await getICEAuditData(req.companyId);
    res.json(data);
  } catch (err) {
    console.error('ICE audit data error:', err);
    res.status(500).json({ error: 'Failed to generate ICE audit data' });
  }
});

// ── POST /api/compliance/ice/generate ────────────────────────────────────
// Generates the audit package, logs it, returns data + export record
router.post('/ice/generate', async (req, res) => {
  const { format = 'single_pdf', notes } = req.body;

  if (!['single_pdf', 'zip', 'both'].includes(format)) {
    return res.status(400).json({ error: 'Invalid format. Use: single_pdf | zip | both' });
  }

  try {
    const data = await getICEAuditData(req.companyId);

    // Log the export — THIS IS LEGALLY IMPORTANT
    // Every time an I-9 package is generated it must be recorded
    const exportTypes = format === 'both'
      ? ['ice_audit_single_pdf', 'ice_audit_zip']
      : [`ice_audit_${format}`];

    const exportRecords = await Promise.all(
      exportTypes.map(exportType =>
        logExport({
          companyId: req.companyId,
          userId: req.user.id,
          exportType,
          employeeCount: data.totalIncluded,
          includesTerminated: data.totalTerminated > 0,
          ipAddress: getClientIP(req),
          userAgent: req.headers['user-agent'],
          notes: notes || null,
        })
      )
    );

    res.json({
      success: true,
      data,
      exportRecords,
      message: `ICE audit package generated. Includes ${data.totalActive} active and ${data.totalTerminated} terminated employees within retention window.`,
      warnings: [
        data.missingI9 > 0
          ? `⚠️ ${data.missingI9} active employee(s) are missing I-9 forms entirely.`
          : null,
        data.incompleteI9 > 0
          ? `⚠️ ${data.incompleteI9} I-9 form(s) have Section 1 but not Section 2 (employer verification).`
          : null,
      ].filter(Boolean),
    });
  } catch (err) {
    console.error('ICE generate error:', err);
    res.status(500).json({ error: 'Failed to generate ICE audit package' });
  }
});

// ── GET /api/compliance/eeoc/report ──────────────────────────────────────
router.get('/eeoc/report', async (req, res) => {
  try {
    const report = await getEEOCReportData(req.companyId);

    // Log EEOC report access
    await logExport({
      companyId: req.companyId,
      userId: req.user.id,
      exportType: 'eeoc_report',
      employeeCount: report.workforce.total,
      includesTerminated: false,
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
    });

    res.json(report);
  } catch (err) {
    console.error('EEOC report error:', err);
    res.status(500).json({ error: 'Failed to generate EEOC report' });
  }
});

// ── GET /api/compliance/exports/history ──────────────────────────────────
router.get('/exports/history', async (req, res) => {
  try {
    const history = await getExportHistory(req.companyId, 100);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch export history' });
  }
});

// ── GET /api/compliance/status ───────────────────────────────────────────
// Company-wide compliance overview — used by dashboard
router.get('/status', async (req, res) => {
  try {
    const [employees, i9Status, w4Status, demographics] = await Promise.all([
      // Total active employee count
      query(
        `SELECT COUNT(*) AS total FROM employees
         WHERE company_id = $1 AND employment_status = 'active'`,
        [req.companyId]
      ),
      // I-9 status breakdown
      query(
        `SELECT
           COUNT(*) FILTER (WHERE i9_status = 'completed') AS completed,
           COUNT(*) FILTER (WHERE i9_status = 'pending')   AS pending,
           COUNT(*) FILTER (WHERE i9_status = 'not_started') AS missing
         FROM employees
         WHERE company_id = $1 AND employment_status = 'active'`,
        [req.companyId]
      ),
      // W-4 status breakdown
      query(
        `SELECT
           COUNT(*) FILTER (WHERE w4_status = 'completed')  AS completed,
           COUNT(*) FILTER (WHERE w4_status = 'pending')    AS pending,
           COUNT(*) FILTER (WHERE w4_status = 'not_started') AS missing
         FROM employees
         WHERE company_id = $1 AND employment_status = 'active'`,
        [req.companyId]
      ),
      // Demographics response rate
      query(
        `SELECT
           COUNT(*) AS total,
           COUNT(d.employee_id) AS self_identified
         FROM employees e
         LEFT JOIN employee_demographics d
           ON d.employee_id = e.id AND d.self_identified_at IS NOT NULL
         WHERE e.company_id = $1 AND e.employment_status = 'active'`,
        [req.companyId]
      ),
    ]);

    const total = parseInt(employees.rows[0].total);
    const i9 = i9Status.rows[0];
    const w4 = w4Status.rows[0];
    const demo = demographics.rows[0];

    // Employees fully compliant = both W-4 and I-9 completed
    const fullyCompliant = await query(
      `SELECT COUNT(*) AS count FROM employees
       WHERE company_id = $1
         AND employment_status = 'active'
         AND w4_status = 'completed'
         AND i9_status = 'completed'`,
      [req.companyId]
    );

    res.json({
      totalActive: total,
      fullyCompliant: parseInt(fullyCompliant.rows[0].count),
      complianceRate: total > 0
        ? Math.round((parseInt(fullyCompliant.rows[0].count) / total) * 100)
        : 0,
      i9: {
        completed: parseInt(i9.completed),
        pending: parseInt(i9.pending),
        missing: parseInt(i9.missing),
      },
      w4: {
        completed: parseInt(w4.completed),
        pending: parseInt(w4.pending),
        missing: parseInt(w4.missing),
      },
      demographics: {
        total: parseInt(demo.total),
        selfIdentified: parseInt(demo.self_identified),
        responseRate: demo.total > 0
          ? Math.round((parseInt(demo.self_identified) / parseInt(demo.total)) * 100)
          : 0,
      },
      // Terminated employees still in I-9 retention window
      retentionRequired: await query(
        `SELECT COUNT(*) AS count FROM termination_records
         WHERE company_id = $1 AND i9_retain_until >= CURRENT_DATE`,
        [req.companyId]
      ).then(r => parseInt(r.rows[0].count)),
    });
  } catch (err) {
    console.error('Compliance status error:', err);
    res.status(500).json({ error: 'Failed to fetch compliance status' });
  }
});

module.exports = router;
