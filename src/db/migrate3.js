/**
 * FormGuard — Migration 003
 * Adds: employee_demographics, compliance_exports log
 * Run: node src/db/migrate3.js
 */

require('dotenv').config();
const { pool } = require('./pool');

const migrations = [

  // ── Employee Demographics (voluntary self-identification) ─────────────────
  // Stored separately from main profile — extra encryption layer, access logged
  `CREATE TABLE IF NOT EXISTS employee_demographics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id         UUID NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Self-identification fields (all voluntary)
    gender              VARCHAR(50),
      -- male | female | non_binary | self_describe | prefer_not_to_say
    gender_self_desc    VARCHAR(100),   -- if self_describe chosen

    race_ethnicity      VARCHAR(100),
      -- hispanic_latino | white | black_african_american | asian |
      -- native_hawaiian_pacific_islander | american_indian_alaska_native |
      -- two_or_more | prefer_not_to_say

    veteran_status      VARCHAR(50),
      -- not_veteran | veteran | disabled_veteran | prefer_not_to_say

    disability_status   VARCHAR(50),
      -- no_disability | yes_disability | prefer_not_to_say

    -- EEO-1 job category (set by employer, not employee)
    eeo1_job_category   VARCHAR(100),
      -- exec_senior_officials | first_mid_officials | professionals |
      -- technicians | sales | admin_support | craft_workers |
      -- operatives | laborers | service_workers

    -- Pay info (for EEOC pay equity analysis)
    pay_rate            NUMERIC(10,2),
    pay_type            VARCHAR(20),    -- hourly | salary | contractor
    pay_effective_date  DATE,

    -- Metadata
    self_identified_at  TIMESTAMPTZ,   -- when employee filled this in
    identified_via      VARCHAR(30) DEFAULT 'onboarding_link',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_demographics_company ON employee_demographics(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_demographics_employee ON employee_demographics(employee_id)`,

  // ── Compliance Export Log (immutable — every export recorded) ─────────────
  `CREATE TABLE IF NOT EXISTS compliance_exports (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id),
    exported_by     UUID REFERENCES users(id),
    export_type     VARCHAR(50) NOT NULL,
      -- ice_audit_single_pdf | ice_audit_zip | eeoc_report | i9_single | full_export
    employee_count  INTEGER,
    includes_terminated BOOLEAN DEFAULT false,
    file_reference  TEXT,       -- S3 key or identifier
    ip_address      VARCHAR(45),
    user_agent      TEXT,
    notes           TEXT,       -- e.g. "Generated during ICE inspection"
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_exports_company ON compliance_exports(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exports_type ON compliance_exports(export_type)`,
  `CREATE INDEX IF NOT EXISTS idx_exports_created ON compliance_exports(created_at DESC)`,

  // ── Add pay fields to employee_profiles if not present ───────────────────
  `ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS pay_rate NUMERIC(10,2)`,
  `ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS pay_type VARCHAR(20) DEFAULT 'hourly'`,

  // ── Add EEO-1 category to employees ──────────────────────────────────────
  `ALTER TABLE employees ADD COLUMN IF NOT EXISTS eeo1_job_category VARCHAR(100)`,

  // ── Trigger for demographics updated_at ──────────────────────────────────
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ language 'plpgsql'`,

  `DROP TRIGGER IF EXISTS set_updated_at_employee_demographics ON employee_demographics`,
  `CREATE TRIGGER set_updated_at_employee_demographics
   BEFORE UPDATE ON employee_demographics
   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`,
];

async function migrate() {
  console.log('🔄 Running FormGuard Migration 003...\n');
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      const preview = sql.trim().slice(0, 65).replace(/\s+/g, ' ');
      await client.query(sql);
      console.log(`  ✓ ${preview}...`);
    }
    console.log('\n✅ Migration 003 complete.');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
