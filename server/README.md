# MY HRMS — Production API (`server/`)

Multi-tenant Node 20+ / Fastify / TypeScript / PostgreSQL backend for the
Malaysian HRMS. It mirrors the web app's localStorage data layer
(`hrms-web/src/lib/db.ts`) 1:1 and reuses the **same payroll calculation code**
(`src/calc/statutory.ts` is a sync-verified copy of `hrms-web/src/lib/statutory.ts`).

## Quick start (local)

```bash
cd server
cp .env.example .env            # then edit values
npm install

# Postgres — either docker-compose (recommended)…
docker compose up -d postgres   # schema auto-applies on first boot
# …or any existing Postgres:
psql "$DATABASE_URL" -f sql/schema.sql

npm run seed                    # 4 companies + bcrypt-hashed user accounts
npm run dev                     # tsx watch → http://localhost:4010
```

Full stack in Docker:

```bash
docker compose up -d --build
docker compose exec api npx tsx src/seed.ts
```

## npm scripts

| Script | Purpose |
|---|---|
| `dev` | tsx watch dev server |
| `build` / `start` | `tsc` → `dist/`, run `node dist/src/index.js` |
| `typecheck` | `tsc --noEmit` |
| `seed` | companies + users (idempotent; never resets changed passwords) |
| `migrate` | import a browser "Export all data" JSON into a company |
| `sync-calc` | re-copy `statutory.ts`/`workdays.ts` from the web app |

## API surface

Auth (`POST /auth/login` → `{ token, user }`; send `Authorization: Bearer <token>`):

| Method | Route | Notes |
|---|---|---|
| POST | `/auth/login` | bcrypt verify → JWT (12h), payload `{userId, companyId, role}` |
| GET | `/auth/me` | current token profile |
| GET | `/health` | liveness + DB ping |
| GET/POST | `/api/companies`, GET/PATCH `/api/companies/:id` | tenant directory (SuperAdmin governs) |
| GET/POST/PUT | `/api/:collection` | list / create / **replace-all** (`setCollection` mirror) |
| GET/PATCH/DELETE | `/api/:collection/:id` | single-record CRUD |
| POST | `/api/payroll/run` | `{month:'YYYY-MM', employeeIds?, draft?}` — Admin/HR |
| POST | `/api/payroll/finalize` | `{runId}` — draft → finalized, stamps claims 'paid' |
| POST | `/api/payroll/undo` | `{runId}` or `{month}` — removes run+payslips, un-pays claims |
| POST | `/api/payroll/payslip/adjust` | `{runId, employeeId, adjustments[]}` — draft-run editor (CP38/Zakat/PTPTN/custom) |
| POST | `/api/payroll/payslip/reset` | `{runId, employeeId}` — recompute one draft payslip from defaults |
| POST | `/api/payroll/payslip/exclude` | `{runId, employeeId}` — drop one employee from a draft run |
| GET/POST | `/api/audit` | read (Admin/HR) / append |

**Collections**: `employees, departments, positions, shifts, attendance,
leaves, leaveBalances, claims, payrollRuns, payslips, kpis, reviews, cycles,
objectives, checkins, pips, holidays, settings, positionProfiles,
departmentProfiles` (`holidays` is national/global).

**Tenant scoping**: company users are pinned to their JWT `companyId`
(cross-company requests → 403). SuperAdmin is cross-tenant and must pass
`?companyId=` or the `x-company-id` header for tenant collections.

**Role scoping** (mirrors `hrms-web/docs/auth-integration.md` §4):

| Role | Read | Write |
|---|---|---|
| Admin / HR / SuperAdmin | whole company | whole company |
| Manager | own department (employee-linked collections); company-wide reference data | employee-linked rows in own department only |
| Employee | own records only | create/patch own rows on self-service collections (`leaves, claims, attendance, objectives, checkins`); no deletes |

## Data migration from the browser app

In the web app: **Settings → Data management → Export all data (JSON)** — once
per company (switch tenant, export again). Then:

```bash
npm run migrate -- --file hrms-export-2026-02-05.json --company co-asm
npm run migrate -- --file export-merdeka.json --company co-merdeka
# optional: accounts from localStorage 'hrms.users' (plaintext → bcrypt on import)
npm run migrate -- --users-file hrms-users.json
```

## Calc-code sync contract

`src/calc/statutory.ts` is a **verbatim copy** of `hrms-web/src/lib/statutory.ts`
(refreshed with `npm run sync-calc`); `src/calc/payroll.ts` is a line-for-line
DB-backed port of `hrms-web/src/lib/payrollEngine.ts`, and
`src/calc/workdays.ts` is a dependency-free port of `hrms-web/src/lib/workdays.ts`
(the web module reads `lib/db` + `lib/holidays`, so it is ported, not copied).
When any of the web calc files change: run `npm run sync-calc`, mirror engine /
workdays changes into `src/calc/payroll.ts` / `src/calc/workdays.ts`, then
`npm run typecheck`.

## Security checklist (production)

- Set a strong `JWT_SECRET` (`openssl rand -hex 32`); rotate periodically.
- HTTPS only (terminate at your platform/load balancer).
- `PGSSL=true` for managed Postgres (Supabase/Neon).
- Rate limiting is built in (`RATE_LIMIT_*`, stricter bucket on `/auth/login`).
- Consider Postgres Row-Level Security as a second layer — see
  `hrms-web/docs/enterprise-deployment.md` for a ready-made RLS policy set.
- Backups: enable PITR on your managed PG (Supabase/Neon include it on paid tiers).
