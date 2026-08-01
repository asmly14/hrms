# Enterprise Deployment Guide — MY HRMS

How to take the HRMS from browser-localStorage demo to a production,
multi-tenant deployment: managed Postgres, the `server/` Fastify API, and the
web app running in API mode.

---

## 1. Overview

| Layer | Demo (today) | Enterprise |
|---|---|---|
| Data | `localStorage` (`src/lib/db.ts`) | PostgreSQL via `server/` API |
| Auth | mock, plaintext passwords (`src/lib/auth.ts`) | bcrypt + JWT (12 h), `POST /auth/login` |
| Tenancy | namespaced localStorage keys | `company_id` columns + JWT-pinned scope |
| Payroll calc | browser (`payrollEngine.ts`) | server, **same statutory code** (`server/src/calc/`) |
| Web ↔ server | — | `src/lib/api.ts` (`VITE_DATA_MODE=api`) |

---

## 2. Architecture

```
                 ┌────────────────────────────────────────────────┐
                 │                 Browser (SPA)                  │
                 │  React + Vite                                  │
                 │  ┌───────────────┐      ┌───────────────────┐  │
                 │  │ lib/db.ts     │      │ lib/api.ts        │  │
                 │  │ (local mode)  │      │ (api mode)        │  │
                 │  └──────┬────────┘      └─────────┬─────────┘  │
                 │       DataProvider interface ◄────┘            │
                 └───────────────────────┬────────────────────────┘
                                         │ HTTPS, Authorization: Bearer <JWT>
                                         │ x-company-id (SuperAdmin scope)
                 ┌───────────────────────▼────────────────────────┐
                 │              server/ (Fastify, Node 20+)       │
                 │  ┌───────────────────────────────────────────┐ │
                 │  │ Auth: bcrypt verify → JWT {userId,        │ │
                 │  │ companyId, role} (12 h)                   │ │
                 │  │ Guards: tenant pin + role scoping         │ │
                 │  │   Admin/HR → whole company                │ │
                 │  │   Manager  → own department               │ │
                 │  │   Employee → own records only             │ │
                 │  ├───────────────────────────────────────────┤ │
                 │  │ /api/:collection CRUD  /api/payroll/run   │ │
                 │  │ /api/payroll/undo      /api/audit         │ │
                 │  │ /api/companies         /auth/login        │ │
                 │  ├───────────────────────────────────────────┤ │
                 │  │ calc/statutory.ts  ◄── sync-verified copy │ │
                 │  │ calc/payroll.ts    ◄── port of web engine │ │
                 │  └───────────────────────────────────────────┘ │
                 └───────────────────────┬────────────────────────┘
                                         │ pg (SQL, JSONB docs)
                 ┌───────────────────────▼────────────────────────┐
                 │        PostgreSQL 14+ (Supabase / Neon / RDS)  │
                 │  companies · users · employees · attendance    │
                 │  leaves · claims · payroll_runs · payslips     │
                 │  kpis · reviews · cycles · objectives          │
                 │  checkins · pips · holidays (national) ·       │
                 │  settings · audit · profiles · …               │
                 │  every tenant table: company_id + indexes      │
                 └────────────────────────────────────────────────┘
```

---

## 3. Data model & tenancy

- The web app's localStorage collections map 1:1 to tables
  (`server/sql/schema.sql`). Documents are stored as JSONB (`data`), with hot
  columns extracted at write time (`employee_id`, `month_key`, `department_id`,
  …) so role scoping and payroll queries stay index-backed.
- Every tenant table carries `company_id → companies.id` (FK, `ON DELETE
  CASCADE`) and is queried only through tenant-scoped code paths.
- `holidays` is **national** (`company_id NULL` = shared) — Malaysian public
  holidays are federal/state law, not per tenant.
- `users.company_id` is `NULL` only for the SuperAdmin; every other account is
  pinned to exactly one company and the API enforces that pin (a JWT for
  company A requesting company B's data → 403).

---

## 4. Threat model (basics)

| Threat | Mitigation in place | Harden before go-live |
|---|---|---|
| Password theft | bcrypt (cost 10) hashes in `users.password_hash`; plaintext never stored | Force password reset for demo accounts; add password policy + optional MFA (TOTP) later |
| Credential brute force | Stricter rate-limit bucket on `/auth/login` (`LOGIN_RATE_LIMIT_MAX`, default 10/min) | Add CAPTCHA / lockout policy for internet-facing deployments |
| Token theft / replay | JWT signed HS256, 12 h expiry (`JWT_TTL`); secret from env only | HTTPS only; short TTL + refresh tokens if sessions must be longer; rotate `JWT_SECRET` |
| Cross-tenant access | Server-side scope pin on every request; SuperAdmin requires explicit `?companyId=`; role filters mirror the web app's Admin/HR → company, Manager → department, Employee → self | Enable Postgres **RLS** (below) as defence-in-depth |
| SQL injection | Parameterized queries only (`pg` placeholders) | Keep it that way — never interpolate identifiers from user input |
| Data scraping | Global rate limit (`RATE_LIMIT_MAX`, default 300/min) | WAF / CDN rate rules for public exposure |
| Audit tampering | `audit` is append-only via API (no update/delete endpoints) | Periodic export/WORM storage for PDPA-sensitive audits |
| Demo data leakage | Server seed creates only companies + accounts; demo employee data never touches the server unless explicitly migrated | Verify with `SELECT count(*) FROM employees` before go-live |

### Suggested Row-Level Security (defence-in-depth)

Application middleware already enforces tenancy; RLS adds a second wall. Example
for one table — repeat per tenant table:

```sql
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;

-- The API connects as role `hrms_api`; the app sets the tenant per transaction:
--   SELECT set_config('app.company_id', 'co-asm', true);
CREATE POLICY tenant_isolation ON employees
  USING (company_id = current_setting('app.company_id', true));

CREATE POLICY superadmin_bypass ON employees
  USING (current_setting('app.is_superadmin', true) = 'true');
```

> Note: with RLS on, set `app.company_id` / `app.is_superadmin` per request
> (transaction-local `set_config`). This is a **recommendation**, not wired into
> `server/` yet — treat it as the next hardening milestone.

---

## 5. Production deploy — step by step

### 5.1 Provision managed Postgres

**Supabase**: create project → Settings → Database → use the *connection pooler*
string (`aws-0-<region>.pooler.supabase.com:6543`). SSL required.
**Neon**: create project → copy the `postgres://…neon.tech/…` string (SSL required).
**Other**: any Postgres 14+ works (RDS, Azure Flexible Server, self-hosted).

### 5.2 Apply the schema

```bash
psql "$DATABASE_URL" -f server/sql/schema.sql
```

(For docker-compose the schema auto-applies on first boot via
`docker-entrypoint-initdb.d`.)

### 5.3 Deploy the API (Render / Railway / Fly.io)

| Platform | Steps |
|---|---|
| **Render** | New → Web Service → repo root `server/` → Build `npm install && npm run build` → Start `node dist/src/index.js` → set env vars (below). |
| **Railway** | New Service → repo → set root directory `server/` → add env vars → Railway builds via Nixpacks (`npm run build`) and starts with `npm start`. |
| **Fly.io** | `fly launch` inside `server/` (uses the Dockerfile) → `fly secrets set …` → `fly deploy`. |
| **Docker anywhere** | `docker build -t hrms-api server/ && docker run -p 4010:4010 --env-file .env hrms-api` |

Required env vars (see `server/.env.example`):

```
DATABASE_URL=postgres://…            # from step 5.1
PGSSL=true                           # Supabase/Neon
JWT_SECRET=<openssl rand -hex 32>    # REQUIRED — no default in production
CORS_ORIGIN=https://hrms.example.com # the web app's public URL
PORT=4010                            # platform may inject its own PORT
```

### 5.4 Seed tenants + accounts

```bash
cd server
DATABASE_URL=… PGSSL=true npm run seed
```

Creates the 4 companies — including the intentionally EMPTY
**ASM Tech Division Sdn Bhd** (`co-asm-division`) — and the bcrypt-hashed
accounts (`superadmin/super123`, `admin/admin123`, `smithang/123123`, …).
Re-seeding never resets changed passwords.

### 5.5 Deploy the web app in API mode

```bash
cd hrms-web
VITE_DATA_MODE=api VITE_API_URL=https://api.hrms.example.com npm run build
# deploy dist/ as usual (Vercel/Netlify/S3+CDN)
```

### 5.6 Migrate existing browser data (optional)

Per company: in the demo app, switch to the tenant → **Settings → Data
management → Export all data (JSON)**, then:

```bash
cd server
DATABASE_URL=… PGSSL=true npm run migrate -- --file hrms-export-2026-02-05.json --company co-asm
DATABASE_URL=… PGSSL=true npm run migrate -- --users-file hrms-users.json   # optional accounts
```

### 5.7 Verify

```bash
curl https://api.hrms.example.com/health
# → {"ok":true,"db":true,"at":"…"}
curl -X POST https://api.hrms.example.com/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"smithang","password":"123123"}'
# → {"token":"…","user":{"companyId":"co-asm-division",…}}
```

---

## 6. Wiring the web app to the API (integration-agent recipe)

`db.ts` is untouched. `src/lib/api.ts` defines the contract and both backends:

- **`DataProvider` interface** (`src/lib/api.ts`): Promise-based
  `login/logout/getSession/getCompanies/getCollection/setCollection/addItem/
  updateItem/removeItem/logAudit`.
- `createLocalProvider()` adapts `db.ts` (lazy-imported — no demo-seed side
  effects in API mode); `createApiProvider()` talks to `server/`;
  `getDataProvider()` picks by `VITE_DATA_MODE`.

Integration steps:

1. **Env**: set `VITE_DATA_MODE=api` and `VITE_API_URL` in the build.
2. **Auth**: in `src/lib/authContext.tsx`, replace the `login()`/`logout()`
   calls from `lib/auth.ts` with the provider's:
   ```ts
   import { getDataProvider } from '@/lib/api';
   const provider = getDataProvider();
   // login: const session = await provider.login(username, password);
   ```
   `api.ts` writes the same `hrms.session` Session shape and the
   `myhrms:activeTenant` key, so the existing Session consumers and
   `TenantProvider` keep working unchanged.
3. **Collections**: pages can migrate incrementally. Options:
   - **Drop-in hook (API mode)**: swap `import { useCollection } from '@/lib/db'`
     for `import { useCollection } from '@/lib/api'`. Same `CollectionApi`
     shape; note `add()` is optimistic — prefer the async
     `provider.addItem()` when the stored id matters.
   - **Provider calls (either mode)**: replace `getCollection/setCollection/
     logAudit` call sites with `await provider.*` equivalents.
4. **SuperAdmin tenant switching**: `api.ts` reads `myhrms:activeTenant` and
   sends it as the `x-company-id` header — `setActiveCompany()` keeps working.
5. **Payroll pages**: call the `lib/api.ts` lifecycle helpers in API mode —
   `runPayroll(month, ids?, {draft})`, `finalizePayroll(runId)`,
   `undoPayroll({runId} | {month})`, `adjustPayslip(runId, empId, adjustments)`,
   `resetPayslip(runId, empId)`, `excludeFromRun(runId, empId)` — instead of
   the browser engine (the server computes with the same statutory code).
6. **Logout**: also call `clearApiCache()` to drop the in-memory collection
   cache.

---

## 7. Calc-code sync contract (do not skip)

- `server/src/calc/statutory.ts` is a **verbatim copy** of
  `hrms-web/src/lib/statutory.ts`; refresh with `cd server && npm run sync-calc`.
- `server/src/calc/payroll.ts` is a line-for-line DB-backed port of
  `hrms-web/src/lib/payrollEngine.ts` — including the proration engine
  (joiner/leaver proration, unpaid leave on the same basis), draft-run
  lifecycle (`finalizePayrollRun`, `setPayslipAdjustments`, reset, exclude)
  and `undoPayrollRun`. When the web engine changes, mirror the change there
  and re-run `npm run typecheck`.
- `server/src/calc/workdays.ts` + `server/src/calc/holidays.ts` are
  **dependency-free ports** of the same-named web modules (they import
  `lib/db`, so `sync-calc` deliberately does not copy them — re-port manually
  on change, same rule as the payroll engine). The curated holiday calendar
  `hrms-web/src/lib/holidayData.ts` IS copied verbatim by `sync-calc`.

---

## 8. Go-live checklist

- [ ] `JWT_SECRET` is a real random secret (not the dev default); stored in the
      platform's secret manager.
- [ ] HTTPS everywhere; `CORS_ORIGIN` locked to the exact web origin(s).
- [ ] `PGSSL=true` against managed Postgres; DB not publicly reachable
      otherwise.
- [ ] Demo passwords changed (`admin123`, `super123`, `123123`, …) — the seed
      exists for first boot only.
- [ ] Rate limits reviewed (`RATE_LIMIT_*`, `LOGIN_RATE_LIMIT_MAX`).
- [ ] Backups: PITR/scheduled snapshots enabled on the managed PG; restore
      tested once.
- [ ] Audit log retention decided (PDPA: keep employee personal-data access
      logs; define a purge/export policy).
- [ ] **PDPA 2010 (Malaysia)**: employee personal data (NRIC, bank accounts,
      salaries) is *sensitive in practice* — document the lawful basis
      (employment contract), restrict access to need-to-know roles, publish a
      privacy notice to employees, and have a breach-response runbook. Keep DB
      and backups within jurisdictions your policy allows.
- [ ] RLS milestone scheduled (see §4).
- [ ] Monitoring: platform logs + `/health` probe wired to uptime alerts.
- [ ] Payroll parallel-run: one month computed in BOTH browser and server
      engines on the same data, payslips diffed to the sen.

---

## 9. Repo layout

```
server/
  sql/schema.sql                 # idempotent DDL (21 tables)
  src/
    index.ts  app.ts  config.ts  # entrypoint / app assembly / env
    db/pool.ts  db/collections.ts# pg pool / registry + tenant+role scoping
    auth/guard.ts                # JWT verify + request.hrmsUser
    routes/                      # auth, companies, collections, payroll, audit
    calc/                        # statutory + holidayData (sync copies),
                                 # payroll/workdays/holidays (manual ports)
    seed.ts                      # 4 companies + bcrypt users
  scripts/
    migrate-from-browser.ts      # "Export all data" JSON → Postgres
    sync-calc.mjs                # re-copy web calc modules
  Dockerfile  docker-compose.yml  .env.example  README.md
hrms-web/
  src/lib/api.ts                 # DataProvider + dual-mode data layer
  docs/enterprise-deployment.md  # this document
```
