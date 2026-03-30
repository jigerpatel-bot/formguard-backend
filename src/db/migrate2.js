/**
 * FormGuard — Migration 002
 * Adds: departments, emergency_contacts, employee_profile, termination_records
 * Run: node src/db/migrate2.js
 */

require('dotenv').config();
const { pool } = require('./pool');

const migrations = [

  // ── Departments ───────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS departments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name        VARCHAR(150) NOT NULL,
    description TEXT,
    active      BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, name)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_departments_company ON departments(company_id)`,

  // ── Employee Profiles (extends employees table) ───────────────────────────
  `CREATE TABLE IF NOT EXISTS employee_profiles (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id       UUID NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
    company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Personal
    phone             VARCHAR(20),
    dob               DATE,
    address           TEXT,
    city              VARCHAR(100),
    state             CHAR(2),
    zip               VARCHAR(10),

    -- Job
    department_id     UUID REFERENCES departments(id),
    manager_name      VARCHAR(200),
    employment_type   VARCHAR(50) DEFAULT 'full_time',  -- full_time | part_time | contractor | temp
    start_date        DATE,
    salary            NUMERIC(12,2),

    -- Internal HR notes (visible to admin + hr)
    hr_notes          TEXT,

    -- Profile photo
    photo_url         TEXT,

    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_profiles_employee ON employee_profiles(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_profiles_company ON employee_profiles(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_profiles_department ON employee_profiles(department_id)`,

  // ── Emergency Contacts ────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS emergency_contacts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    full_name     VARCHAR(200) NOT NULL,
    relationship  VARCHAR(100) NOT NULL,  -- Spouse, Parent, Sibling, Friend, etc.
    phone_primary VARCHAR(20) NOT NULL,
    phone_alt     VARCHAR(20),
    email         VARCHAR(255),
    is_primary    BOOLEAN DEFAULT false,  -- main emergency contact

    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_emergency_employee ON emergency_contacts(employee_id)`,

  // ── Termination Records ───────────────────────────────────────────────────
  // Admin-only visibility enforced at the API layer
  `CREATE TABLE IF NOT EXISTS termination_records (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id           UUID NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
    company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    terminated_by         UUID REFERENCES users(id),

    termination_date      DATE NOT NULL,
    termination_type      VARCHAR(50) NOT NULL,
      -- voluntary | involuntary | layoff | contract_end | retirement | death | other
    reason_category       VARCHAR(100),
      -- performance | misconduct | restructuring | resignation | end_of_contract | etc.

    -- Admin-only sensitive notes
    private_notes         TEXT,

    -- Checklist items
    equipment_returned    BOOLEAN DEFAULT false,
    access_revoked        BOOLEAN DEFAULT false,
    final_pay_processed   BOOLEAN DEFAULT false,
    benefits_terminated   BOOLEAN DEFAULT false,
    cobra_notified        BOOLEAN DEFAULT false,
    reference_policy      VARCHAR(50) DEFAULT 'standard',  -- standard | no_comment | positive

    -- I-9 retention deadline (auto-calculated)
    -- Federal law: retain 3 yrs from hire OR 1 yr after termination, whichever is later
    i9_retain_until       DATE,

    -- Rehire eligibility
    eligible_for_rehire   BOOLEAN DEFAULT true,

    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_termination_company ON termination_records(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_termination_employee ON termination_records(employee_id)`,

  // ── Add department_id to employees table ──────────────────────────────────
  `ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id)`,
  `ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_status VARCHAR(30) DEFAULT 'active'`,
    // active | terminated | on_leave

  // ── Updated_at triggers for new tables ───────────────────────────────────
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ language 'plpgsql'`,

  ...[
    'employee_profiles',
    'emergency_contacts',
    'termination_records',
  ].map(tbl => `
    DROP TRIGGER IF EXISTS set_updated_at_${tbl} ON ${tbl};
    CREATE TRIGGER set_updated_at_${tbl}
    BEFORE UPDATE ON ${tbl}
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
  `),
];

async function migrate() {
  console.log('🔄 Running FormGuard Migration 002...\n');
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      const preview = sql.trim().slice(0, 65).replace(/\s+/g, ' ');
      await client.query(sql);
      console.log(`  ✓ ${preview}...`);
    }
    console.log('\n✅ Migration 002 complete.');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
