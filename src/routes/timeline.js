/**
 * FormGuard — Timeline Routes
 *
 * GET  /api/timeline/:employeeId          — get employee timeline
 * POST /api/timeline/:employeeId/sync     — rebuild timeline from all records
 * POST /api/timeline/:employeeId/note     — add manual note to timeline
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { syncTimeline, getTimeline, addTimelineEvent } = require('../services/timeline');
const { query } = require('../db/pool');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/timeline/:employeeId ─────────────────────────────────────────
router.get('/:employeeId', async (req, res) => {
  try {
    // Verify employee belongs to company
    const check = await query(
      `SELECT id FROM employees WHERE id = $1 AND company_id = $2`,
      [req.params.employeeId, req.companyId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Employee not found' });

    const timeline = await getTimeline(req.params.employeeId, req.companyId);
    res.json({ timeline });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch timeline' });
  }
});

// ── POST /api/timeline/:employeeId/sync ───────────────────────────────────
router.post('/:employeeId/sync', async (req, res) => {
  try {
    const count = await syncTimeline(req.params.employeeId, req.companyId);
    const timeline = await getTimeline(req.params.employeeId, req.companyId);
    res.json({ success: true, eventsAdded: count, timeline });
  } catch (err) {
    res.status(500).json({ error: 'Failed to sync timeline' });
  }
});

// ── POST /api/timeline/:employeeId/note ───────────────────────────────────
router.post('/:employeeId/note', [
  body('eventTitle').trim().notEmpty().withMessage('Note title required'),
  body('eventDetail').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const event = await addTimelineEvent(req.params.employeeId, req.companyId, {
      eventType: 'note_added',
      eventTitle: req.body.eventTitle,
      eventDetail: req.body.eventDetail || null,
      triggeredBy: `${req.user.first_name} ${req.user.last_name}`,
      actorId: req.user.id,
    });
    res.status(201).json({ event });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add note' });
  }
});

module.exports = router;
