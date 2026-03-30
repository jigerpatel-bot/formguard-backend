const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

/**
 * requireAuth — verifies JWT, attaches req.user and req.company
 */
const requireAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = header.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Token expired or invalid' });
    }

    // Load fresh user from DB (catches deactivated accounts)
    const result = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.active,
              c.id AS company_id, c.name AS company_name, c.plan
       FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1`,
      [payload.userId]
    );

    if (!result.rows.length || !result.rows[0].active) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }

    req.user = result.rows[0];
    req.companyId = result.rows[0].company_id;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Authentication error' });
  }
};

/**
 * requireRole — use after requireAuth
 * e.g. requireRole('admin') or requireRole(['admin','hr'])
 */
const requireRole = (...roles) => (req, res, next) => {
  const allowed = roles.flat();
  if (!allowed.includes(req.user?.role)) {
    return res.status(403).json({ error: `Requires role: ${allowed.join(' or ')}` });
  }
  next();
};

/**
 * validateInviteToken — for employee-facing routes
 * Attaches req.employee and req.inviteToken
 */
const validateInviteToken = async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing invite token' });

    const result = await query(
      `SELECT it.*, e.id AS emp_id, e.first_name, e.last_name, e.email,
              e.company_id, e.w4_status, e.i9_status,
              c.name AS company_name
       FROM invite_tokens it
       JOIN employees e ON e.id = it.employee_id
       JOIN companies c ON c.id = it.company_id
       WHERE it.token = $1`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Invalid invite link' });
    }

    const invite = result.rows[0];

    if (invite.revoked) {
      return res.status(410).json({ error: 'This invite link has been revoked' });
    }
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This invite link has expired' });
    }

    req.inviteToken = invite;
    req.employee = {
      id: invite.emp_id,
      firstName: invite.first_name,
      lastName: invite.last_name,
      email: invite.email,
      companyId: invite.company_id,
      companyName: invite.company_name,
      w4Status: invite.w4_status,
      i9Status: invite.i9_status,
    };
    next();
  } catch (err) {
    console.error('Invite token middleware error:', err);
    res.status(500).json({ error: 'Token validation error' });
  }
};

module.exports = { requireAuth, requireRole, validateInviteToken };
