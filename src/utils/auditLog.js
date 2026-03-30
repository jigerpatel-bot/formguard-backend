const { query } = require('../db/pool');

/**
 * Write an immutable audit log entry.
 * Never throws — audit failures should not break the main flow.
 */
const auditLog = async ({
  companyId = null,
  employeeId = null,
  userId = null,
  action,               // e.g. 'employee.invited', 'w4.submitted', 'i9.section2.signed'
  entityType = null,    // 'employee' | 'w4' | 'i9' | 'invite' | 'user'
  entityId = null,
  ipAddress = null,
  userAgent = null,
  metadata = {},        // any extra JSON data
}) => {
  try {
    await query(
      `INSERT INTO audit_logs
         (company_id, employee_id, user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [companyId, employeeId, userId, action, entityType, entityId, ipAddress, userAgent, JSON.stringify(metadata)]
    );
  } catch (err) {
    // Log but never throw — audit must not break business logic
    console.error('⚠️  Audit log write failed:', err.message);
  }
};

/**
 * Fetch audit trail for an employee (most recent first).
 */
const getEmployeeAuditTrail = async (employeeId, companyId) => {
  const result = await query(
    `SELECT
       a.id, a.action, a.entity_type, a.entity_id,
       a.ip_address, a.user_agent, a.metadata, a.created_at,
       u.first_name || ' ' || u.last_name AS actor_name,
       u.email AS actor_email
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.employee_id = $1 AND a.company_id = $2
     ORDER BY a.created_at DESC
     LIMIT 100`,
    [employeeId, companyId]
  );
  return result.rows;
};

/**
 * Fetch company-wide audit log with optional filters.
 */
const getCompanyAuditLog = async (companyId, { action, entityType, limit = 200, offset = 0 } = {}) => {
  const conditions = ['a.company_id = $1'];
  const params = [companyId];
  let i = 2;

  if (action) { conditions.push(`a.action = $${i++}`); params.push(action); }
  if (entityType) { conditions.push(`a.entity_type = $${i++}`); params.push(entityType); }
  params.push(limit, offset);

  const result = await query(
    `SELECT
       a.id, a.action, a.entity_type, a.entity_id,
       a.ip_address, a.metadata, a.created_at,
       e.first_name || ' ' || e.last_name AS employee_name,
       u.email AS actor_email
     FROM audit_logs a
     LEFT JOIN employees e ON e.id = a.employee_id
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    params
  );
  return result.rows;
};

module.exports = { auditLog, getEmployeeAuditTrail, getCompanyAuditLog };
