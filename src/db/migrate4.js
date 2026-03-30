/**
 * FormGuard — Migration 004
 * Adds: business_memberships (one user → many companies)
 *        business_setup_progress (wizard state per company)
 *        state_required_forms (which forms each state requires)
 *        company_documents (employer-uploaded docs assigned to employees)
 * Run: node src/db/migrate4.js
 */

require('dotenv').config();
const { pool } = require('./pool');

const migrations = [

  // ── Business Memberships ──────────────────────────────────────────────────
  // Replaces the hard 1:1 user→company relationship.
  // One user can belong to many companies with different roles.
  `CREATE TABLE IF NOT EXISTS business_memberships (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role          VARCHAR(50) NOT NULL DEFAULT 'admin',
      -- owner | admin | hr | viewer
    is_primary    BOOLEAN DEFAULT false,   -- default company on login
    invited_by    UUID REFERENCES users(id),
    accepted_at   TIMESTAMPTZ DEFAULT NOW(),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, company_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_memberships_user    ON business_memberships(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memberships_company ON business_memberships(company_id)`,

  // ── Business Setup Progress ───────────────────────────────────────────────
  // Tracks wizard completion state per company
  `CREATE TABLE IF NOT EXISTS business_setup_progress (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,

    -- Step 1: Basic info
    step1_complete            BOOLEAN DEFAULT false,

    -- Step 2: State + required forms
    step2_complete            BOOLEAN DEFAULT false,
    selected_state            CHAR(2),

    -- Step 3: Required forms confirmed
    step3_complete            BOOLEAN DEFAULT false,

    -- Step 4: Company documents uploaded
    step4_complete            BOOLEAN DEFAULT false,

    -- Step 5: First employee invited
    step5_complete            BOOLEAN DEFAULT false,

    overall_complete          BOOLEAN DEFAULT false,
    completed_at              TIMESTAMPTZ,
    last_updated_at           TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_setup_company ON business_setup_progress(company_id)`,

  // ── State Required Forms Config ───────────────────────────────────────────
  // Which forms are required for each state
  `CREATE TABLE IF NOT EXISTS state_required_forms (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_code    CHAR(2) NOT NULL,
    state_name    VARCHAR(100) NOT NULL,
    form_key      VARCHAR(100) NOT NULL,   -- unique key like 'federal_w4', 'tx_new_hire'
    form_name     VARCHAR(200) NOT NULL,
    form_description TEXT,
    is_federal    BOOLEAN DEFAULT false,
    filing_agency VARCHAR(200),
    due_within_days INTEGER,               -- days after hire to submit
    form_url      TEXT,                   -- link to official form
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(state_code, form_key)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_state_forms_state ON state_required_forms(state_code)`,

  // ── Company Required Forms (which forms this company needs) ───────────────
  `CREATE TABLE IF NOT EXISTS company_required_forms (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    form_key      VARCHAR(100) NOT NULL,
    form_name     VARCHAR(200) NOT NULL,
    is_federal    BOOLEAN DEFAULT false,
    is_active     BOOLEAN DEFAULT true,
    added_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, form_key)
  )`,

  // ── Add fields to companies table ─────────────────────────────────────────
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone        VARCHAR(20)`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS website      VARCHAR(255)`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry     VARCHAR(100)`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS employee_count_range VARCHAR(30)`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS setup_complete BOOLEAN DEFAULT false`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url     TEXT`,

  // ── Seed state required forms ─────────────────────────────────────────────
  // Federal forms (apply to ALL states)
  `INSERT INTO state_required_forms
     (state_code, state_name, form_key, form_name, form_description, is_federal, filing_agency, due_within_days, form_url)
   VALUES
     ('US', 'Federal', 'federal_w4',
      'IRS Form W-4 — Employee Withholding Certificate',
      'Required for all new hires to determine federal income tax withholding.',
      true, 'Internal Revenue Service', 1,
      'https://www.irs.gov/pub/irs-pdf/fw4.pdf'),
     ('US', 'Federal', 'federal_i9',
      'USCIS Form I-9 — Employment Eligibility Verification',
      'Required for all new hires to verify identity and work authorization. Must be completed within 3 business days.',
      true, 'U.S. Citizenship and Immigration Services', 3,
      'https://www.uscis.gov/i-9')
   ON CONFLICT (state_code, form_key) DO NOTHING`,

  // State-specific new hire reporting forms
  `INSERT INTO state_required_forms
     (state_code, state_name, form_key, form_name, form_description, is_federal, filing_agency, due_within_days, form_url)
   VALUES
     ('TX', 'Texas', 'tx_new_hire',
      'Texas New Hire Reporting',
      'Employers must report all newly hired employees to the Texas New Hire Reporting program within 20 days of hire.',
      false, 'Texas Office of the Attorney General', 20,
      'https://www.newhire-reporting.com/TX/Employer.aspx'),
     ('CA', 'California', 'ca_de34',
      'California DE 34 — Report of New Employee(s)',
      'California employers must report all new employees to EDD within 20 days of their start-of-work date.',
      false, 'California Employment Development Department', 20,
      'https://edd.ca.gov/en/Payroll_Taxes/New_Hire_Reporting/'),
     ('CA', 'California', 'ca_de4',
      'California DE 4 — Employee Withholding Allowance Certificate',
      'California state income tax withholding form, required in addition to federal W-4.',
      false, 'California Franchise Tax Board', 1,
      'https://www.ftb.ca.gov/forms/2023/2023-de-4.pdf'),
     ('NY', 'New York', 'ny_it2104',
      'New York IT-2104 — Employee Withholding Certificate',
      'New York state income tax withholding allowances form.',
      false, 'New York State Department of Taxation', 1,
      'https://www.tax.ny.gov/pdf/current_forms/it/it2104.pdf'),
     ('NY', 'New York', 'ny_new_hire',
      'New York New Hire Reporting',
      'New York employers must report new hires within 20 days.',
      false, 'New York State Department of Taxation and Finance', 20,
      'https://www.tax.ny.gov/bus/wt/newhire.htm'),
     ('FL', 'Florida', 'fl_new_hire',
      'Florida New Hire Reporting',
      'Florida employers must report new hires within 20 days of hire.',
      false, 'Florida New Hire Reporting Center', 20,
      'https://fl-newhire.com/'),
     ('IL', 'Illinois', 'il_w4',
      'Illinois IL-W-4 — Employee Withholding Certificate',
      'Illinois state income tax withholding form.',
      false, 'Illinois Department of Revenue', 1,
      'https://tax.illinois.gov/content/dam/soi/en/web/tax/docs/current/pub-131.pdf'),
     ('IL', 'Illinois', 'il_new_hire',
      'Illinois New Hire Reporting',
      'Illinois employers must report new hires within 20 days.',
      false, 'Illinois Department of Employment Security', 20,
      'https://www2.illinois.gov/ides/employers/Pages/NewHireReporting.aspx'),
     ('WA', 'Washington', 'wa_new_hire',
      'Washington New Hire Reporting',
      'Washington employers must report new hires within 20 days.',
      false, 'Washington State DSHS', 20,
      'https://www.dshs.wa.gov/esa/division-child-support/new-hire-reporting'),
     ('GA', 'Georgia', 'ga_new_hire',
      'Georgia New Hire Reporting',
      'Georgia employers must report new hires within 10 days of hire.',
      false, 'Georgia Department of Labor', 10,
      'https://www.georgia.gov/report-new-hire'),
     ('AZ', 'Arizona', 'az_new_hire',
      'Arizona New Hire Reporting',
      'Arizona employers must report new hires within 20 days.',
      false, 'Arizona Department of Economic Security', 20,
      'https://newhire-reporting.com/AZ/Employer.aspx'),
     ('CO', 'Colorado', 'co_new_hire',
      'Colorado New Hire Reporting',
      'Colorado employers must report new hires within 20 days.',
      false, 'Colorado Department of Labor and Employment', 20,
      'https://newhire-reporting.com/CO/Employer.aspx'),
     ('NC', 'North Carolina', 'nc_new_hire',
      'North Carolina New Hire Reporting',
      'North Carolina employers must report new hires within 20 days.',
      false, 'North Carolina Department of Health and Human Services', 20,
      'https://newhire-reporting.com/NC/Employer.aspx')
   ON CONFLICT (state_code, form_key) DO NOTHING`,
];

async function migrate() {
  console.log('🔄 Running FormGuard Migration 004...\n');
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      const preview = sql.trim().slice(0, 65).replace(/\s+/g, ' ');
      await client.query(sql);
      console.log(`  ✓ ${preview}...`);
    }
    console.log('\n✅ Migration 004 complete.');
    console.log('   State forms seeded for: US (federal), TX, CA, NY, FL, IL, WA, GA, AZ, CO, NC');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
