/**
 * FormGuard — Timeline Service
 * Builds a chronological event timeline for an employee
 * by pulling from multiple tables and the audit log.
 */

const { query } = require('../db/pool');

/**
 * Sync timeline events for an employee.
 * Call after any significant event (hire, sign, writeup, termination).
 * Uses INSERT ... ON CONFLICT DO NOTHING to stay idempotent.
 */
const syncTimeline = async (employeeId, companyId) => {
  const client = require('../db/pool').pool;

  // Pull all source events and upsert into employee_timeline
  const [emp, w4, i9, writeups, termination, docs, idUploads] = await Promise.all([
    // Hire event
    query(`SELECT id, created_at, first_name, last_name, job_title FROM employees WHERE id = $1`, [employeeId]),
    // W-4
    query(`SELECT id, submitted_at, signature_name FROM w4_submissions WHERE employee_id = $1`, [employeeId]),
    // I-9
    query(`SELECT id, section1_completed_at, section2_completed_at, emp_signature_name FROM i9_submissions WHERE employee_id = $1`, [employeeId]),
    // Write-ups
    query(`SELECT id, incident_date, incident_type, severity, status, created_at FROM writeups WHERE employee_id = $1 ORDER BY incident_date ASC`, [employeeId]),
    // Termination
    query(`SELECT id, termination_date, termination_type FROM termination_records WHERE employee_id = $1`, [employeeId]),
    // Signed company docs
    query(`SELECT ds.id, ds.signed_at, cd.name AS doc_name FROM document_signatures ds JOIN company_documents cd ON cd.id = ds.document_id WHERE ds.employee_id = $1 AND ds.status = 'signed'`, [employeeId]),
    // ID uploads
    query(`SELECT id, uploaded_at, document_type, verification_status, verified_at FROM id_uploads WHERE employee_id = $1`, [employeeId]),
  ]);

  const events = [];

  // Hired
  if (emp.rows[0]) {
    const e = emp.rows[0];
    events.push({
      event_type: 'hired',
      event_title: `Hired as ${e.job_title || 'Employee'}`,
      event_detail: `${e.first_name} ${e.last_name} added to the system.`,
      event_date: e.created_at,
      reference_id: e.id,
      reference_type: 'employee',
      triggered_by: 'system',
    });
  }

  // W-4 signed
  if (w4.rows[0]?.submitted_at) {
    events.push({
      event_type: 'w4_signed',
      event_title: 'W-4 signed',
      event_detail: `IRS Form W-4 digitally signed by ${w4.rows[0].signature_name || 'employee'}.`,
      event_date: w4.rows[0].submitted_at,
      reference_id: w4.rows[0].id,
      reference_type: 'w4',
      triggered_by: 'employee',
    });
  }

  // I-9 Section 1
  if (i9.rows[0]?.section1_completed_at) {
    events.push({
      event_type: 'i9_section1',
      event_title: 'I-9 Section 1 completed',
      event_detail: 'Employee completed and signed I-9 Section 1.',
      event_date: i9.rows[0].section1_completed_at,
      reference_id: i9.rows[0].id,
      reference_type: 'i9',
      triggered_by: 'employee',
    });
  }

  // I-9 Section 2
  if (i9.rows[0]?.section2_completed_at) {
    events.push({
      event_type: 'i9_completed',
      event_title: 'I-9 fully completed',
      event_detail: 'Employer verified documents and completed I-9 Section 2.',
      event_date: i9.rows[0].section2_completed_at,
      reference_id: i9.rows[0].id,
      reference_type: 'i9',
      triggered_by: 'employer',
    });
  }

  // ID uploads
  for (const upload of idUploads.rows) {
    events.push({
      event_type: 'id_uploaded',
      event_title: `ID uploaded: ${upload.document_type.replace(/_/g, ' ')}`,
      event_detail: `Government-issued ID uploaded for verification.`,
      event_date: upload.uploaded_at,
      reference_id: upload.id,
      reference_type: 'id_upload',
      triggered_by: 'employee',
    });
    if (upload.verification_status === 'verified' && upload.verified_at) {
      events.push({
        event_type: 'id_verified',
        event_title: 'ID verified by employer',
        event_detail: 'Government-issued ID reviewed and approved.',
        event_date: upload.verified_at,
        reference_id: upload.id,
        reference_type: 'id_upload',
        triggered_by: 'employer',
      });
    }
  }

  // Write-ups
  for (const wu of writeups.rows) {
    events.push({
      event_type: 'writeup_issued',
      event_title: `Write-up issued: ${wu.severity.replace(/_/g, ' ')}`,
      event_detail: `Disciplinary action for ${wu.incident_type.replace(/_/g, ' ')}.`,
      event_date: wu.created_at,
      reference_id: wu.id,
      reference_type: 'writeup',
      triggered_by: 'employer',
    });
    if (wu.status === 'acknowledged') {
      events.push({
        event_type: 'writeup_acknowledged',
        event_title: 'Write-up acknowledged by employee',
        event_detail: 'Employee signed the disciplinary notice.',
        event_date: wu.updated_at,
        reference_id: wu.id,
        reference_type: 'writeup',
        triggered_by: 'employee',
      });
    }
    if (wu.status === 'declined') {
      events.push({
        event_type: 'writeup_declined',
        event_title: 'Employee declined to sign write-up',
        event_detail: 'Refusal to sign recorded. Notice still valid.',
        event_date: wu.updated_at,
        reference_id: wu.id,
        reference_type: 'writeup',
        triggered_by: 'employee',
      });
    }
  }

  // Document signatures
  for (const doc of docs.rows) {
    if (doc.signed_at) {
      events.push({
        event_type: 'document_signed',
        event_title: `Signed: ${doc.doc_name}`,
        event_detail: `Employee digitally signed company document.`,
        event_date: doc.signed_at,
        reference_id: doc.id,
        reference_type: 'document_signature',
        triggered_by: 'employee',
      });
    }
  }

  // Termination
  if (termination.rows[0]) {
    const t = termination.rows[0];
    events.push({
      event_type: 'terminated',
      event_title: `Employment terminated`,
      event_detail: `${t.termination_type.replace(/_/g, ' ')} termination.`,
      event_date: new Date(t.termination_date),
      reference_id: t.id,
      reference_type: 'termination',
      triggered_by: 'employer',
    });
  }

  // Bulk insert all events
  for (const ev of events) {
    await query(
      `INSERT INTO employee_timeline
         (employee_id, company_id, event_type, event_title, event_detail,
          event_date, reference_id, reference_type, triggered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [
        employeeId, companyId,
        ev.event_type, ev.event_title, ev.event_detail,
        ev.event_date, ev.reference_id || null,
        ev.reference_type || null, ev.triggered_by,
      ]
    ).catch(() => {}); // ignore constraint errors
  }

  return events.length;
};

/**
 * Get timeline for an employee, most recent first.
 */
const getTimeline = async (employeeId, companyId) => {
  const result = await query(
    `SELECT * FROM employee_timeline
     WHERE employee_id = $1 AND company_id = $2
     ORDER BY event_date DESC`,
    [employeeId, companyId]
  );
  return result.rows;
};

/**
 * Add a manual note to the timeline (HR notes, promotions, etc.)
 */
const addTimelineEvent = async (employeeId, companyId, {
  eventType, eventTitle, eventDetail,
  eventDate = new Date(), triggeredBy, actorId, referenceId, referenceType,
}) => {
  const result = await query(
    `INSERT INTO employee_timeline
       (employee_id, company_id, event_type, event_title, event_detail,
        event_date, triggered_by, actor_id, reference_id, reference_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [employeeId, companyId, eventType, eventTitle, eventDetail,
     eventDate, triggeredBy, actorId || null, referenceId || null, referenceType || null]
  );
  return result.rows[0];
};

module.exports = { syncTimeline, getTimeline, addTimelineEvent };
