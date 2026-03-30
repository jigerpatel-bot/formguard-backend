/**
 * FormGuard — Database Migration
 * Run: node src/db/migrate.js
 *
 * Tables:
 *   companies         — employer tenants
 *   users             — employer admins/HR users
 *   employees         — invited employees per company
 *   invite_tokens     — secure time-limited invite links
 *   w4_submissions    — completed W-4 form data
 *   i9_submissions    — completed I-9 form data
 *   audit_logs        — immutable audit trail (every action)
 */

require('dotenv').config();
const { pool } = require('./pool');

const migrations = [

  // ── Companies (tenants) ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS companies (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(255) NOT NULL,
    ein           VARCHAR(20),                       -- Employer Identification Number
    address       TEXT,
    city          VARCHAR(100),
    state         CHAR(2),
    zip           VARCHAR(10),
    plan          VARCHAR(50) DEFAULT 'starter',     -- starter | pro | enterprise
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Users (employer admins / HR) ─────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    first_name    VARCHAR(100),
    last_name     VARCHAR(100),
    role          VARCHAR(50) DEFAULT 'admin',       -- admin | hr | viewer
    active        BOOLEAN DEFAULT true,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,

  // ── Employees ────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS employees (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invited_by      UUID REFERENCES users(id),
    first_name      VARCHAR(100),
    last_name       VARCHAR(100),
    email           VARCHAR(255) NOT NULL,
    job_title       VARCHAR(150),
    department      VARCHAR(150),
    start_date      DATE,
    w4_status       VARCHAR(30) DEFAULT 'not_started',   -- not_started | pending | completed
    i9_status       VARCHAR(30) DEFAULT 'not_started',
    w4_completed_at TIMESTAMPTZ,
    i9_completed_at TIMESTAMPTZ,
    active          BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, email)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email)`,

  // ── Invite Tokens ─────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS invite_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    token         VARCHAR(128) NOT NULL UNIQUE,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,                        -- null = not yet used
    revoked       BOOLEAN DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON invite_tokens(token)`,
  `CREATE INDEX IF NOT EXISTS idx_invite_tokens_employee ON invite_tokens(employee_id)`,

  // ── W-4 Submissions ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS w4_submissions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id         UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Step 1: Personal Info
    first_name          VARCHAR(100) NOT NULL,
    last_name           VARCHAR(100) NOT NULL,
    ssn_encrypted       TEXT,                         -- AES-256 encrypted
    address             TEXT,
    city                VARCHAR(100),
    state               CHAR(2),
    zip                 VARCHAR(10),
    filing_status       VARCHAR(80),

    -- Step 2: Withholding
    multiple_jobs       BOOLEAN DEFAULT false,
    dependent_amount    NUMERIC(10,2) DEFAULT 0,
    other_income        NUMERIC(10,2) DEFAULT 0,
    deductions          NUMERIC(10,2) DEFAULT 0,
    extra_withholding   NUMERIC(10,2) DEFAULT 0,
    exempt              BOOLEAN DEFAULT false,

    -- Step 3: Signature
    signature_name      VARCHAR(255),
    signed_at           TIMESTAMPTZ,
    signer_ip           VARCHAR(45),
    signer_user_agent   TEXT,

    -- Metadata
    form_version        VARCHAR(20) DEFAULT '2026',
    pdf_s3_key          TEXT,                         -- S3 key once PDF is generated
    submitted_at        TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_w4_employee ON w4_submissions(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_w4_company ON w4_submissions(company_id)`,

  // ── I-9 Submissions ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS i9_submissions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id             UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Section 1: Employee Info
    first_name              VARCHAR(100) NOT NULL,
    last_name               VARCHAR(100) NOT NULL,
    other_last_names        VARCHAR(200),
    dob                     DATE,
    ssn_encrypted           TEXT,
    email                   VARCHAR(255),
    phone                   VARCHAR(20),
    address                 TEXT,
    city                    VARCHAR(100),
    state                   CHAR(2),
    zip                     VARCHAR(10),

    -- Section 1: Attestation
    citizen_status          VARCHAR(50),              -- citizen | noncitizen_national | perm_resident | authorized_alien
    alien_reg_number        VARCHAR(50),
    i94_number              VARCHAR(50),
    foreign_passport_number VARCHAR(50),
    country_of_issuance     VARCHAR(100),
    auth_exp_date           DATE,

    -- Section 1: Employee Signature
    emp_signature_name      VARCHAR(255),
    emp_signed_at           TIMESTAMPTZ,
    emp_signer_ip           VARCHAR(45),
    emp_signer_user_agent   TEXT,

    -- Section 2: Document Verification (employer)
    doc_list_a              VARCHAR(200),
    doc_list_b              VARCHAR(200),
    doc_list_c              VARCHAR(200),
    doc_issuing_authority   VARCHAR(200),
    doc_number              VARCHAR(100),
    doc_expiration_date     DATE,

    -- Section 2: Employer Signature
    employer_signature_name VARCHAR(255),
    employer_title          VARCHAR(150),
    employer_signed_at      TIMESTAMPTZ,
    employer_signer_ip      VARCHAR(45),
    employer_business_name  VARCHAR(255),
    employer_city           VARCHAR(100),
    employer_state          CHAR(2),
    employer_zip            VARCHAR(10),

    -- Section 3: Reverification (optional, for re-hires)
    reverification_date     DATE,
    reverification_name     VARCHAR(255),
    reverification_doc      VARCHAR(200),

    -- Metadata
    form_edition            VARCHAR(20) DEFAULT '07/17/2017',
    pdf_s3_key              TEXT,
    section1_completed_at   TIMESTAMPTZ,
    section2_completed_at   TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_i9_employee ON i9_submissions(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_i9_company ON i9_submissions(company_id)`,

  // ── Audit Logs (immutable — never UPDATE or DELETE rows here) ─────────────
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id            BIGSERIAL PRIMARY KEY,
    company_id    UUID REFERENCES companies(id),
    employee_id   UUID REFERENCES employees(id),
    user_id       UUID REFERENCES users(id),
    action        VARCHAR(100) NOT NULL,
    entity_type   VARCHAR(50),                        -- employee | w4 | i9 | invite | user
    entity_id     UUID,
    ip_address    VARCHAR(45),
    user_agent    TEXT,
    metadata      JSONB,                              -- any extra context
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_employee ON audit_logs(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC)`,

  // ── Updated_at auto-update trigger ──────────────────────────────────────
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ language 'plpgsql'`,

  ...[
    'companies', 'users', 'employees'
  ].map(tbl => `
    DROP TRIGGER IF EXISTS set_updated_at_${tbl} ON ${tbl};
    CREATE TRIGGER set_updated_at_${tbl}
    BEFORE UPDATE ON ${tbl}
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
  `),
];

async function migrate() {
  console.log('🔄 Running FormGuard migrations...\n');
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      const preview = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
      await client.query(sql);
      console.log(`  ✓ ${preview}...`);
    }
    console.log('\n✅ All migrations completed successfully.');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
