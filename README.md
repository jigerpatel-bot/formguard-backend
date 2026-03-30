# FormGuard Backend

Node.js + Express + PostgreSQL backend for W-4 & I-9 compliance management.

---

## Quick Start

### 1. Prerequisites
- Node.js 18+
- PostgreSQL 14+

### 2. Install dependencies
```bash
cd formguard-backend
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your DB credentials and secrets
```

Minimum required `.env` values:
```
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/formguard
JWT_SECRET=your_secret_at_least_32_chars
ENCRYPTION_KEY=64_hex_chars_for_aes256
FRONTEND_URL=http://localhost:5173
APP_BASE_URL=http://localhost:5173
```

### 4. Create the database
```bash
psql -U postgres -c "CREATE DATABASE formguard;"
```

### 5. Run migrations
```bash
npm run migrate
```

### 6. Seed dev data (optional)
```bash
npm run seed
# Creates: admin@acme.com / Admin1234!
```

### 7. Start the server
```bash
npm run dev       # development (nodemon)
npm start         # production
```

Server runs on http://localhost:3001

---

## API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create company + admin |
| POST | `/api/auth/login` | Login, returns JWT |
| GET  | `/api/auth/me` | Get current user |

### Employees
All require `Authorization: Bearer <token>` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/employees` | List employees (supports `?search=&status=&limit=&offset=`) |
| GET  | `/api/employees/stats` | Completion stats |
| GET  | `/api/employees/:id` | Get employee detail |
| POST | `/api/employees/invite` | Create employee + invite token |
| POST | `/api/employees/:id/resend-invite` | Revoke old token + generate new |
| GET  | `/api/employees/:id/audit` | Employee audit trail |
| DELETE | `/api/employees/:id` | Soft deactivate (admin only) |

### Forms
Employee routes use `?token=<invite_token>` (no JWT).
Employer routes use JWT.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET  | `/api/forms/onboard-info?token=` | invite token | Get pre-fill data |
| POST | `/api/forms/w4?token=` | invite token | Submit W-4 |
| POST | `/api/forms/i9/section1?token=` | invite token | Submit I-9 Section 1 |
| POST | `/api/forms/i9/:id/section2` | JWT (employer) | Complete I-9 Section 2 |
| GET  | `/api/forms/employee/:id` | JWT | Get employee's submissions |

### Audit
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit` | Company audit log |
| GET | `/api/audit/export` | Download as CSV (admin) |

---

## Database Schema

```
companies        → tenants (one per employer)
users            → employer admins / HR staff
employees        → invited employees (per company)
invite_tokens    → secure time-limited links
w4_submissions   → completed W-4 forms (SSN encrypted)
i9_submissions   → completed I-9 forms (SSN encrypted)
audit_logs       → immutable event log (never delete)
```

---

## Security Features

- **AES-256-GCM** encryption for SSN and sensitive fields
- **bcrypt** (12 rounds) for password hashing
- **JWT** authentication with configurable expiry
- **Helmet.js** for HTTP security headers
- **Rate limiting** (strict on auth endpoints)
- **Soft deletes** — employee records are never deleted (compliance retention)
- **Immutable audit log** — every action is recorded with IP + user agent
- **Multi-tenant isolation** — all queries scoped by `company_id`

---

## Deployment (Railway / Render)

1. Set all environment variables in the platform dashboard
2. Set `NODE_ENV=production`
3. Set `DATABASE_URL` to your hosted PostgreSQL connection string
4. Build command: `npm install`
5. Start command: `npm start`
6. Run `npm run migrate` once after first deploy

---

## Next Steps

- [ ] **Step 3**: Dropbox Sign / HelloSign integration for legally binding e-signatures
- [ ] **Step 4**: PDF generation — populate official IRS W-4 and USCIS I-9 templates
- [ ] **Step 5**: Email delivery (Resend / SendGrid) — send invite links automatically
- [ ] **Step 6**: Stripe billing for SaaS subscriptions
