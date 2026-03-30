/**
 * FormGuard — Dev Seed
 * Run: node src/db/seed.js
 * Creates a demo company, admin user, and sample employees.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { pool } = require('./pool');

async function seed() {
  console.log('🌱 Seeding FormGuard dev database...\n');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Company ────────────────────────────────────────────
    const companyId = uuid();
    await client.query(`
      INSERT INTO companies (id, name, ein, address, city, state, zip, plan)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT DO NOTHING
    `, [companyId, 'Acme Corp', '12-3456789', '100 Business Ave', 'Austin', 'TX', '78701', 'pro']);
    console.log('  ✓ Company: Acme Corp');

    // ── Admin User ─────────────────────────────────────────
    const adminId = uuid();
    const passwordHash = await bcrypt.hash('Admin1234!', 12);
    await client.query(`
      INSERT INTO users (id, company_id, email, password_hash, first_name, last_name, role)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (email) DO NOTHING
    `, [adminId, companyId, 'admin@acme.com', passwordHash, 'Alex', 'Johnson', 'admin']);
    console.log('  ✓ Admin user: admin@acme.com / Admin1234!');

    // ── Sample Employees ───────────────────────────────────
    const employees = [
      { first: 'Sarah', last: 'Mitchell', email: 'sarah@acme.com', title: 'Marketing Manager', w4: 'completed', i9: 'completed' },
      { first: 'James', last: 'Okafor',   email: 'james@acme.com', title: 'Software Engineer',  w4: 'completed', i9: 'pending' },
      { first: 'Priya', last: 'Nair',     email: 'priya@acme.com', title: 'Sales Rep',           w4: 'pending',   i9: 'pending' },
      { first: 'Carlos', last: 'Rivera',  email: 'carlos@acme.com', title: 'Operations',         w4: 'not_started', i9: 'not_started' },
    ];

    for (const emp of employees) {
      const empId = uuid();
      await client.query(`
        INSERT INTO employees
          (id, company_id, invited_by, first_name, last_name, email, job_title, w4_status, i9_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (company_id, email) DO NOTHING
      `, [empId, companyId, adminId, emp.first, emp.last, emp.email, emp.title, emp.w4, emp.i9]);
      console.log(`  ✓ Employee: ${emp.first} ${emp.last} (W-4: ${emp.w4}, I-9: ${emp.i9})`);
    }

    await client.query('COMMIT');
    console.log('\n✅ Seed complete. Login: admin@acme.com / Admin1234!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
