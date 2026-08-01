-- ═══════════════════════════════════════════════════════════════════════════
-- MY HRMS — PostgreSQL schema (multi-tenant)
-- Works on any Postgres 14+ (Supabase, Neon, RDS, self-hosted).
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).
--
-- Design notes
-- ────────────
-- • Tenancy: every operational table carries company_id → companies.id and is
--   indexed (company_id, …). Application middleware enforces the tenant scope;
--   enabling Postgres RLS on top is recommended (see enterprise-deployment.md).
-- • Documents are stored as JSONB (`data`) mirroring the web app's localStorage
--   collections 1:1 (hrms-web/src/lib/types.ts). Hot query columns (employee_id,
--   month_key, department_id, …) are extracted at write time for indexing.
-- • holidays is NATIONAL (law is federal/state, not per tenant): company_id is
--   NULL for shared rows. Per-company holiday rows are allowed but unused today.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Tenant directory (global) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id          TEXT PRIMARY KEY,                 -- e.g. 'co-asm'
  code        TEXT NOT NULL UNIQUE,             -- e.g. 'ASM'
  name        TEXT NOT NULL,
  reg_no      TEXT NOT NULL DEFAULT '',
  hq_state    TEXT NOT NULL DEFAULT 'KUL',
  status      TEXT NOT NULL DEFAULT 'active'    CHECK (status IN ('active','suspended','trial')),
  plan        TEXT NOT NULL DEFAULT 'free'      CHECK (plan IN ('free','pro','enterprise')),
  branding    JSONB NOT NULL DEFAULT '{}'::jsonb,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Users (global directory; company_id NULL only for SuperAdmin) ────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,                  -- bcrypt ($2a/$2b$)
  role          TEXT NOT NULL CHECK (role IN ('Admin','HR','Manager','Employee','SuperAdmin')),
  company_id    TEXT REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = SuperAdmin
  employee_id   TEXT,                           -- link into the SAME tenant's employees.id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key ON users (lower(username));
CREATE INDEX IF NOT EXISTS users_company_idx ON users (company_id);

-- ── Generic per-tenant document tables ───────────────────────────────────────
-- Shape: PRIMARY KEY (company_id, id) + data JSONB + extracted index columns.

CREATE TABLE IF NOT EXISTS departments (
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);

CREATE TABLE IF NOT EXISTS positions (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  department_id TEXT,                           -- extracted: data->>'departmentId'
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS positions_dept_idx ON positions (company_id, department_id);

CREATE TABLE IF NOT EXISTS employees (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  department_id TEXT,                           -- extracted: data->>'departmentId'
  employee_no   TEXT,                           -- extracted: data->>'employeeNo'
  status        TEXT,                           -- extracted: data->>'status'
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS employees_dept_idx   ON employees (company_id, department_id);
CREATE INDEX IF NOT EXISTS employees_status_idx ON employees (company_id, status);

CREATE TABLE IF NOT EXISTS shifts (
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);

CREATE TABLE IF NOT EXISTS attendance (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  employee_id   TEXT,                           -- extracted: data->>'employeeId'
  date          TEXT,                           -- extracted: data->>'date' (ISO day)
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS attendance_emp_idx  ON attendance (company_id, employee_id);
CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance (company_id, date);

CREATE TABLE IF NOT EXISTS leaves (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  employee_id   TEXT,
  status        TEXT,                           -- extracted: data->>'status'
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS leaves_emp_idx ON leaves (company_id, employee_id);

CREATE TABLE IF NOT EXISTS leave_balances (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  employee_id   TEXT,
  year          INT,                            -- extracted: (data->>'year')::int
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS leave_balances_emp_year_key ON leave_balances (company_id, employee_id, year);

CREATE TABLE IF NOT EXISTS claims (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  employee_id   TEXT,
  status        TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS claims_emp_idx    ON claims (company_id, employee_id);
CREATE INDEX IF NOT EXISTS claims_status_idx ON claims (company_id, status);

CREATE TABLE IF NOT EXISTS payroll_runs (
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  month_key   TEXT,                             -- extracted: data->>'monthKey' ('YYYY-MM')
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS payroll_runs_month_idx ON payroll_runs (company_id, month_key);

CREATE TABLE IF NOT EXISTS payslips (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  run_id        TEXT,                           -- extracted: data->>'runId'
  employee_id   TEXT,
  month_key     TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- incl. `lines` JSONB line items
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS payslips_emp_idx   ON payslips (company_id, employee_id);
CREATE INDEX IF NOT EXISTS payslips_run_idx   ON payslips (company_id, run_id);
CREATE INDEX IF NOT EXISTS payslips_month_idx ON payslips (company_id, month_key);

CREATE TABLE IF NOT EXISTS kpis (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  employee_id   TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS kpis_emp_idx ON kpis (company_id, employee_id);

CREATE TABLE IF NOT EXISTS reviews (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  employee_id   TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS reviews_emp_idx ON reviews (company_id, employee_id);

-- KPI-engine extras (hrms-web/src/lib/kpiEngine.ts collections)
CREATE TABLE IF NOT EXISTS cycles (
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);

CREATE TABLE IF NOT EXISTS objectives (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  employee_id   TEXT,                           -- NULL = company/department-level OKR
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS objectives_emp_idx ON objectives (company_id, employee_id);

CREATE TABLE IF NOT EXISTS checkins (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  employee_id   TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS checkins_emp_idx ON checkins (company_id, employee_id);

CREATE TABLE IF NOT EXISTS pips (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  employee_id   TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS pips_emp_idx ON pips (company_id, employee_id);

-- Holidays are NATIONAL: company_id NULL = shared across tenants.
-- PK is id-only because company_id is nullable (PK columns cannot be NULL).
CREATE TABLE IF NOT EXISTS holidays (
  company_id  TEXT REFERENCES companies(id) ON DELETE CASCADE,   -- NULL = global
  id          TEXT PRIMARY KEY,
  date        TEXT,                             -- extracted: data->>'date' (ISO day)
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS holidays_date_idx ON holidays (date);

-- Per-company settings (singleton doc id 'company' per tenant).
CREATE TABLE IF NOT EXISTS settings (
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);

-- Org-designer profile extras (hrms-web/src/lib/orgChart.ts collections)
CREATE TABLE IF NOT EXISTS position_profiles (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,                  -- === positionId
  position_id   TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS position_profiles_pos_idx ON position_profiles (company_id, position_id);

CREATE TABLE IF NOT EXISTS department_profiles (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,                  -- === departmentId
  department_id TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS department_profiles_dept_idx ON department_profiles (company_id, department_id);

-- ── Audit log (per tenant, append-only) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit (
  company_id  TEXT REFERENCES companies(id) ON DELETE CASCADE,   -- NULL = system/global
  id          TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    TEXT,
  actor_name  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL DEFAULT '',
  entity      TEXT NOT NULL DEFAULT '',
  entity_id   TEXT,
  detail      TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id)                          -- company_id nullable → id-only PK
);
CREATE INDEX IF NOT EXISTS audit_company_idx ON audit (company_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit (company_id, entity, entity_id);

COMMIT;
