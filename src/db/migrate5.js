/**
 * FormGuard — Migration 005
 * Adds: onboarding_checklists, onboarding_steps, id_uploads
 * Run: node src/db/migrate5.js
 */

require('dotenv').config();
const { pool } = require('./pool');

const migrations = [

  // ── Onboarding Checklists ─────────────────────────────────────────────────
  // One checklist per employee per company
  `CREATE TABLE IF NOT EXISTS onboarding_checklists (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id       UUID NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
    company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    total_steps       INTEGER NOT NULL DEFAULT 0,
    completed_steps   INTEGER NOT NULL DEFAULT 0,
    progress_pct      INTEGER NOT NULL DEFAULT 0,  -- 0-100

    status            VARCHAR(30) DEFAULT 'not_started',
      -- not_started | in_progress | completed | blocked

    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    last_activity_at  TIMESTAMPTZ,

    -- Reminder tracking
    last_reminder_at  TIMESTAMPTZ,
    reminder_count    INTEGER DEFAULT 0,

    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_checklists_company  ON onboarding_checklists(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_checklists_employee ON onboarding_checklists(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_checklists_status   ON onboarding_checklists(status)`,

  // ── Onboarding Steps ──────────────────────────────────────────────────────
  // Individual steps within a checklist — dynamically generated per employee
  `CREATE TABLE IF NOT EXISTS onboarding_steps (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    checklist_id    UUID NOT NULL REFERENCES onboarding_checklists(id) ON DELETE CASCADE,
    employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    step_order      INTEGER NOT NULL,
    step_key        VARCHAR(100) NOT NULL,
      -- personal_info | id_upload | i9 | w4 | state_form_* | company_doc_*
    step_type       VARCHAR(50) NOT NULL,
      -- info | upload | form | signature | acknowledgment
    title           VARCHAR(200) NOT NULL,
    description     TEXT,

    status          VARCHAR(30) DEFAULT 'not_started',
      -- not_started | in_progress | completed | blocked | skipped

    is_required     BOOLEAN DEFAULT true,
    requires_employer_action BOOLEAN DEFAULT false,
      -- true for I-9 Section 2 (employer must verify)

    -- Reference to completed artifact
    reference_id    UUID,       -- ID of w4_submission, i9_submission, etc.
    reference_type  VARCHAR(50), -- w4 | i9 | company_doc | id_upload

    completed_at    TIMESTAMPTZ,
    completed_by    VARCHAR(100), -- 'employee' or user name
    notes           TEXT,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(checklist_id, step_key)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_steps_checklist ON onboarding_steps(checklist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_steps_employee  ON onboarding_steps(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_steps_status    ON onboarding_steps(status)`,

  // ── ID Uploads ────────────────────────────────────────────────────────────
  // Stores government-issued ID documents uploaded by employees
  `CREATE TABLE IF NOT EXISTS id_uploads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    document_type   VARCHAR(100) NOT NULL,
      -- drivers_license | passport | state_id | social_security_card |
      -- birth_certificate | permanent_resident_card | work_permit | other
    document_label  VARCHAR(200),  -- e.g. "Driver's License (front)"

    -- File storage (S3 in production)
    file_name       VARCHAR(255),
    file_size       INTEGER,
    file_type       VARCHAR(50),   -- image/jpeg | image/png | application/pdf
    s3_key          TEXT,

    -- Verification
    verification_status VARCHAR(30) DEFAULT 'pending',
      -- pending | verified | needs_correction | rejected
    verified_by     UUID REFERENCES users(id),
    verified_at     TIMESTAMPTZ,
    verification_notes TEXT,

    uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_id_uploads_employee ON id_uploads(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_id_uploads_status   ON id_uploads(verification_status)`,

  // ── Company Documents ─────────────────────────────────────────────────────
  // Documents the employer uploads and assigns to employees
  `CREATE TABLE IF NOT EXISTS company_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    uploaded_by     UUID REFERENCES users(id),

    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    doc_type        VARCHAR(50) DEFAULT 'custom',
      -- handbook | nda | safety | policy | custom

    file_name       VARCHAR(255),
    file_size       INTEGER,
    s3_key          TEXT,

    requires_signature  BOOLEAN DEFAULT true,
    assign_to_all       BOOLEAN DEFAULT true,  -- auto-assign to all new hires

    active          BOOLEAN DEFAULT true,
    version         INTEGER DEFAULT 1,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_company_docs_company ON company_documents(company_id)`,

  // ── Employee Document Signatures ──────────────────────────────────────────
  // Tracks who signed which company document
  `CREATE TABLE IF NOT EXISTS document_signatures (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES company_documents(id) ON DELETE CASCADE,
    employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    status          VARCHAR(30) DEFAULT 'pending',
      -- pending | sent | signed | declined

    -- Dropbox Sign tracking
    signature_request_id  TEXT,
    signer_id             TEXT,
    sign_url              TEXT,

    signed_at       TIMESTAMPTZ,
    signer_ip       VARCHAR(45),
    signer_name     VARCHAR(255),

    pdf_s3_key      TEXT,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, employee_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_doc_sigs_employee ON document_signatures(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_sigs_document ON document_signatures(document_id)`,

  // ── Business Owner Onboarding Progress ───────────────────────────────────
  // Tracks first-time business owner signup wizard
  `CREATE TABLE IF NOT EXISTS owner_onboarding (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    company_id            UUID REFERENCES companies(id),

    step_account          BOOLEAN DEFAULT true,   -- always done (they signed up)
    step_business_info    BOOLEAN DEFAULT false,
    step_documents        BOOLEAN DEFAULT false,
    step_first_employee   BOOLEAN DEFAULT false,
    completed             BOOLEAN DEFAULT false,
    completed_at          TIMESTAMPTZ,

    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Triggers ──────────────────────────────────────────────────────────────
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ language 'plpgsql'`,

  ...[
    'onboarding_checklists',
    'onboarding_steps',
    'company_documents',
  ].map(tbl => `
    DROP TRIGGER IF EXISTS set_updated_at_${tbl} ON ${tbl};
    CREATE TRIGGER set_updated_at_${tbl}
    BEFORE UPDATE ON ${tbl}
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
  `),
];

async function migrate() {
  console.log('🔄 Running FormGuard Migration 005...\n');
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      const preview = sql.trim().slice(0, 65).replace(/\s+/g, ' ');
      await client.query(sql);
      console.log(`  ✓ ${preview}...`);
    }
    console.log('\n✅ Migration 005 complete.');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
