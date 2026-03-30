/**
 * FormGuard — Migration 006
 * Adds: writeups, writeup_acknowledgments, document_library enhancements
 * Run: node src/db/migrate6.js
 */

require('dotenv').config();
const { pool } = require('./pool');

const migrations = [

  // ── Write-ups / Disciplinary Records ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS writeups (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id         UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    created_by          UUID REFERENCES users(id),

    -- Incident details
    incident_date       DATE NOT NULL,
    incident_type       VARCHAR(100) NOT NULL,
      -- tardiness | attendance | performance | misconduct | policy_violation
      -- insubordination | safety | other
    severity            VARCHAR(30) DEFAULT 'warning',
      -- verbal_warning | written_warning | final_warning | suspension | termination

    -- Content
    incident_description  TEXT NOT NULL,
    employer_statement    TEXT,
    improvement_plan      TEXT,
    consequences          TEXT,   -- what happens if not improved

    -- Prior warnings referenced
    prior_warnings_count  INTEGER DEFAULT 0,
    prior_writeup_ids     UUID[],  -- references to previous writeups

    -- Employer signature
    employer_signature_name  VARCHAR(255),
    employer_signed_at       TIMESTAMPTZ,

    -- Status
    status              VARCHAR(30) DEFAULT 'draft',
      -- draft | sent | acknowledged | declined | completed

    -- Secure token for employee acknowledgment link
    ack_token           VARCHAR(128) UNIQUE,
    ack_token_expires   TIMESTAMPTZ,

    -- Metadata
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_writeups_company   ON writeups(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_writeups_employee  ON writeups(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_writeups_status    ON writeups(status)`,
  `CREATE INDEX IF NOT EXISTS idx_writeups_ack_token ON writeups(ack_token)`,

  // ── Write-up Acknowledgments ──────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS writeup_acknowledgments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    writeup_id          UUID NOT NULL REFERENCES writeups(id) ON DELETE CASCADE,
    employee_id         UUID NOT NULL REFERENCES employees(id),
    company_id          UUID NOT NULL REFERENCES companies(id),

    -- Employee response
    employee_response   TEXT,       -- their written rebuttal / perspective
    response_submitted_at TIMESTAMPTZ,

    -- Signature
    action              VARCHAR(20) NOT NULL,
      -- signed | declined
    signature_name      VARCHAR(255),
    signed_at           TIMESTAMPTZ,
    signer_ip           VARCHAR(45),
    signer_user_agent   TEXT,

    -- Dropbox Sign
    signature_request_id  TEXT,
    pdf_s3_key            TEXT,

    created_at          TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_writeup_acks_writeup   ON writeup_acknowledgments(writeup_id)`,
  `CREATE INDEX IF NOT EXISTS idx_writeup_acks_employee  ON writeup_acknowledgments(employee_id)`,

  // ── AI Draft Logs ─────────────────────────────────────────────────────────
  // Track every AI-generated draft for audit purposes
  `CREATE TABLE IF NOT EXISTS ai_draft_logs (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID REFERENCES companies(id),
    employee_id     UUID REFERENCES employees(id),
    generated_by    UUID REFERENCES users(id),
    draft_type      VARCHAR(50) NOT NULL,
      -- unemployment_response | termination_summary | writeup_summary
    input_summary   JSONB,    -- what records were used (no PII)
    was_edited      BOOLEAN DEFAULT false,
    was_used        BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_ai_logs_company ON ai_draft_logs(company_id)`,

  // ── Employee Timeline Events ──────────────────────────────────────────────
  // Materialized timeline — computed from audit_logs + key events
  `CREATE TABLE IF NOT EXISTS employee_timeline (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    event_type      VARCHAR(80) NOT NULL,
      -- hired | w4_signed | i9_completed | writeup_issued | writeup_acknowledged
      -- document_signed | id_verified | terminated | promoted | note_added
    event_title     VARCHAR(255) NOT NULL,
    event_detail    TEXT,
    event_date      TIMESTAMPTZ NOT NULL,

    -- Optional references
    reference_id    UUID,
    reference_type  VARCHAR(50),

    -- Who triggered it
    triggered_by    VARCHAR(100),  -- 'employee', 'system', or user name
    actor_id        UUID REFERENCES users(id),

    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_timeline_employee ON employee_timeline(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_timeline_company  ON employee_timeline(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_timeline_date     ON employee_timeline(event_date DESC)`,

  // ── Triggers ──────────────────────────────────────────────────────────────
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ language 'plpgsql'`,

  `DROP TRIGGER IF EXISTS set_updated_at_writeups ON writeups`,
  `CREATE TRIGGER set_updated_at_writeups
   BEFORE UPDATE ON writeups
   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`,
];

async function migrate() {
  console.log('🔄 Running FormGuard Migration 006...\n');
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      const preview = sql.trim().slice(0, 65).replace(/\s+/g, ' ');
      await client.query(sql);
      console.log(`  ✓ ${preview}...`);
    }
    console.log('\n✅ Migration 006 complete.');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
