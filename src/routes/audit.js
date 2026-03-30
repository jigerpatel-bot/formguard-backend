const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getCompanyAuditLog } = require('../utils/auditLog');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/audit ─────────────────────────────────────────────────────────
// Full company audit log — admin/hr only
router.get('/', requireRole('admin', 'hr'), async (req, res) => {
  try {
    const { action, entityType, limit, offset } = req.query;
    const logs = await getCompanyAuditLog(req.companyId, {
      action, entityType,
      limit: parseInt(limit) || 200,
      offset: parseInt(offset) || 0,
    });
    res.json({ auditLog: logs, total: logs.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ── GET /api/audit/export ──────────────────────────────────────────────────
// Export audit log as CSV for DHS inspection compliance
router.get('/export', requireRole('admin'), async (req, res) => {
  try {
    const logs = await getCompanyAuditLog(req.companyId, { limit: 10000 });

    const rows = [
      ['ID', 'Timestamp', 'Action', 'Entity Type', 'Entity ID', 'Employee', 'Actor', 'IP Address', 'Metadata'],
      ...logs.map(l => [
        l.id,
        l.created_at,
        l.action,
        l.entity_type || '',
        l.entity_id || '',
        l.employee_name || '',
        l.actor_email || '',
        l.ip_address || '',
        JSON.stringify(l.metadata || {}),
      ]),
    ];

    const csv = rows.map(r =>
      r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition',
      `attachment; filename="formguard-audit-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
