# Multi-Tenant Audit — Malaysian HRMS

**Scope:** `hrms-web/` tenant layer (`src/lib/tenantContext.tsx`, `db.ts`, `tenants.ts`, `auth.ts`), module storage via typed-cast collections (lifecycle, orgChart, contracts, employeeRecords, onboardLinks, kpiEngine), SuperAdmin console (`src/pages/superadmin/`), and the Fastify/Postgres backend (`hrms-web/server/`). Read-only audit; evidence cites file:line.

**Verdict in one line:** the physical tenant-namespacing design is sound and consistently applied — with **one real isolation leak** (attendance rotation plans) and a set of **lifecycle/config- coverage gaps**, notably no tenant deletion, no suspend enforcement, and dead config fields (`payslipPrefix`, `workingWeek`, `payrollCutoffDay`).

---

## 1. Isolation verification

### 1.1 Storage model (as designed)

- All operational collections live at `myhrms:t:<companyId>:<collection>` (`src/lib/db.ts:149-152`).
- Globals **by design**: `myhrms:companies`, `myhrms:activeTenant`, `myhrms:holidays` + `myhrms:holidayCache:*` (national law — shared), `myhrms:migrated:v2`, legacy `myhrms:seeded:v1`, `hrms.users` / `hrms.session` (`src/lib/db.ts:60-73`, `src/lib/auth.ts:79-80`, `src/lib/holidays.ts:48`).
- `GLOBAL_COLLECTIONS` contains **only** `holidays` (`src/lib/db.ts:65`) — nothing else silently escapes namespacing through `key()`.

### 1.2 Typed-cast module collections — all namespace per tenant

| Module | Collections | Mechanism | Tenant-scoped? |
|---|---|---|---|
| lifecycle (`src/lib/lifecycle.ts:476-484`) | `onboardingChecklists`, `offboardingCases` | `asCollection` → `db.key()` | ✅ `myhrms:t:<id>:*` |
| contracts (`src/lib/contracts.ts:436-447`) | `contracts`, `contractFeePayments` | `asCollection` → `db.key()` | ✅ |
| employeeRecords (`src/lib/employeeRecords.ts:225-233`) | `employeeRecords` | `asCollection` → `db.key()` | ✅ |
| onboardLinks (`src/lib/onboardLinks.ts:308-341`) | `onboardLinks`, `onboardSubmissions`, `onboardingExtras` (+ writes `onboardingChecklists`) | `asCollection` + explicit `companyId` on all mutation paths (public, sessionless submissions pin `link.companyId`) | ✅ |
| kpiEngine (`src/lib/kpiEngine.ts:32-37`) | `cycles`, `objectives`, `checkins`, `pips` | `asCollection` → `db.key()` | ✅ |
| orgChart (`src/lib/orgChart.ts:77-85`) | `positionProfiles`, `departmentProfiles` | private pub/sub but **same** `myhrms:t:<id>:` key convention + `subscribeTenant` | ✅ |

The `db.ts` `COLLECTIONS` union being closed forced every module onto the typed-cast pattern; all six modules followed the convention correctly.

### 1.3 Isolation leak table

| # | Severity | Key / path | Problem | Evidence |
|---|---|---|---|---|
| L1 | **Medium — real leak** | `myhrms:attendance:rotations` (`src/pages/attendance/model.ts:221`) | Shift `RotationPlan[]` is stored under a **single global key**, not the tenant prefix. Tenant A's plans (carrying tenant-A `employeeIds`/`shiftIds`) are readable and overwritable from tenant B; last writer wins cross-tenant. | `ROT_KEY = 'myhrms:attendance:rotations'`; `getRotations/saveRotations/useRotations` never resolve a tenant (`model.ts:224-248`). |
| L2 | Low — stale pointer | `myhrms:claims:actingAs` (`src/pages/claims/ClaimsPage.tsx:38`) | Global UI preference holding an employee id. Cross-tenant it points at another company's person; mitigated by namespaced demo ids (`emp-*` vs `mrd-*` vs `desa-*`) and a `?? employees[0]` fallback (`ClaimsPage.tsx:87-90`). Cosmetic, not corrupting. | `ACTING_AS_KEY` init/persist at lines 55, 79-84. |
| L3 | Info | legacy `myhrms:seeded:v1` | Global seed flag still written (`db.ts:449`) and probed by `SalaryInsightsPage.tsx:64` / `ReportsPage.tsx:239` as a "has the demo run" check. Harmless; per-tenant flags `myhrms:t:<id>:seeded:v1` are correct (`db.ts:395-397`). | — |
| L4 | By design | public onboarding token scan | `/onboard/:token` resolves links by scanning **all** tenants' `onboardLinks` unauthenticated (`OnboardFormPage.tsx:5`, `lib/onboardLinks.ts:422+`), then reads the target tenant's positions/departments/branding sessionless. Necessary for the public form; relies on token entropy. No write outside the target tenant (submission pins `link.companyId`). | design, acceptable |

No other direct-`localStorage` writer escapes the tenant prefix (audited: `api.ts`, `kpiEngine.ts`, `roleContext.tsx`, `AppLayout.tsx`, `separations.ts`, `UsersSection.tsx`, `DataSection.tsx` — all either UI prefs or global-by-design auth keys). `separations.ts:281-295` prunes `hrms.users` correctly filtered by `companyId`.

Existing test evidence: `src/lib/__tests__/tenant.test.ts:51-94` proves physical namespacing, A↔B invisibility, global holidays, and per-tenant audit.

### 1.4 User accounts (global) — username collision assessment

- One global directory `hrms.users`; usernames are **globally unique**.
- Seed-time strategy: email local-part; on cross-company collision the later account is suffixed with the company code (`zulkifli1.mrd`) (`src/lib/auth.ts:167-180`). Fixed demo accounts dodge collisions with numeric suffixes (`admin2`, `admin3`).
- Wizard strategy: global-uniqueness enforced at creation via `usernameAvailable()` (`src/pages/superadmin/lib.ts:88-108`, `CreateCompanyWizard.tsx:159-161`).
- Assessment: workable for the demo, but (a) cross-tenant username-availability probing leaks which usernames exist elsewhere (minor info disclosure), (b) forced unnatural usernames per tenant, (c) tenant admins cannot provision accounts at all — `UsersSection` is read-only (`UsersSection.tsx:91`); new-employee accounts appear only lazily when `seedUsers()` runs on the next `login()` (`auth.ts:214`, `152-196`), always with the default password `password123` and no reset/invite flow. Production target: `(companyId, username)` composite identity or email+tenant-resolution login.

---

## 2. Tenant lifecycle

### 2.1 Creation ✅ (with notes)

`CreateCompanyWizard` (4 steps) writes the `Company` record (`upsertCompany`), creates the first Admin account via direct `hrms.users` append, logs `company.create` into the new tenant's audit, and deliberately does **not** seed — first entry initialises empty core collections (`CreateCompanyWizard.tsx:183-242`, `db.ts:404-427`). Notes:

- Empty init covers only the 15 core `COLLECTIONS`; module extras lazily read as `[]` (harmless).
- Plan selection has **no effect** on `enabledModules` — every module is enabled regardless of choosing Free (`CreateCompanyWizard.tsx:72`).
- If the admin-account append fails (username taken/storage), the tenant is left with no admin and no recovery path in the UI (`CreateCompanyWizard.tsx:294-299`).
- Server equivalent: `POST /api/companies` SuperAdmin-only (`server/src/routes/companies.ts:75-99`).

### 2.2 Deletion ❌ — absent everywhere

There is **no way to delete a tenant or its data**:

- No `removeCompany`/`deleteCompany` in `src/lib/db.ts` (directory API ends at `upsertCompany`, `db.ts:301-308`).
- SuperAdmin UI offers Enter / Edit / Suspend / Reactivate / Create only (`CompaniesSection.tsx:363-400`).
- Server has no `DELETE /api/companies/:id` (routes: auth, companies GET/POST/PATCH, collections, payroll, audit).
- No cascade purge of `myhrms:t:<id>:*` keys, module-extra keys, or the tenant's `hrms.users` accounts.

**Gap confirmed.** PDPA implications: no tenant off-boarding, no data-erasure path.

### 2.3 Suspend ❌ — flag without enforcement

- Suspend/reactivate only flips `Company.status` + audit (`CompaniesSection.tsx:244-261`); the confirm copy itself admits "the mock login does not block suspended tenants" (`CompaniesSection.tsx:433`).
- Mock `login()` never reads company status (`src/lib/auth.ts:210-236`); server `/auth/login` likewise (`server/src/routes/auth.ts:29-66`).
- `TenantProvider` does not block entering a suspended company; no route guard checks status anywhere (`grep 'suspended'` outside superadmin/tenants/types → zero hits).
- The only behavioural effect is billing math: suspended ⇒ MRR RM0 (`src/pages/superadmin/lib.ts:53-55`).

### 2.4 Trial → paid transitions ⚠️ — manual only

New tenants start `status:'trial'` (`CreateCompanyWizard.tsx:198`); transitions happen via the Edit dialog's plan/status dropdowns (`CompaniesSection.tsx:134-158`), gated server-side to SuperAdmin (`server/src/routes/companies.ts:109-111`). Missing: trial expiry/clock, dunning, automatic trial→paid or trial→suspended transitions, and **plan entitlement enforcement** — `SystemSection` admits "plan gates are not enforced in this demo build" and module `planHint` badges are cosmetic (`src/pages/company/modules.ts:17-20`).

### 2.5 Export / portability ⚠️ — partial

Settings → Data exports the **active tenant's** 15 core collections to JSON (`DataSection.tsx:45-65`), and `server/scripts/migrate-from-browser.ts` ingests that export into Postgres. Gaps: export **omits all module-extra collections** (lifecycle, contracts, employeeRecords, onboard\*, kpi cycles/objectives/checkins/pips, org profiles, rotations) and the Company record + user accounts; import is a disabled placeholder (`DataSection.tsx:107-110`). No SuperAdmin-side all-tenant export.

---

## 3. Per-tenant config — coverage vs actual consumers

| `CompanyConfig` field | Written by | Runtime consumer(s) | Status |
|---|---|---|---|
| `workingWeek` | Wizard step 2, `PolicySection` | **None.** Weekends derive from `Employee.state` via `holidays.isWeekend` (`src/lib/workdays.ts:57-71`, `attendance/model.ts:302-306`) | ❌ **Dead config** — UI implies behaviour that never happens |
| `payrollCutoffDay` | Wizard, `PolicySection` | **None.** `getPayrollCutoff()` (`appSettings.ts:224`) has zero callers in payrollEngine / attendance / claims | ❌ **Dead config + dead accessor** |
| `payrollProration?` (undocumented in `tenant-api.md`) | *nothing* — no UI, no seed | `payrollEngine` via `resolveProrationMethod()` (`payrollEngine.ts:455,620,647`) | ⚠️ **Read-but-never-written** — always `'calendar'`; only displayed in `EmployeeAdjustDialog.tsx:166` |
| `claimPolicy` | `PolicySection` / settings doc | Claims via `claimPolicy.ts` → `appSettings.getClaimPolicy()` (config → doc layering) | ✅ applied |
| `leaveTopUps` | `tenants.ts` seed (ASM `{annual:2}`), `LeavePolicySection` doc | `leaveLogic.leaveTopUps()` reads **only** the `ext:leaveTopups` settings doc (`pages/leave/leaveLogic.ts:57-72`), bypassing `appSettings.getLeaveTopUps()` which layers `Company.config` (`appSettings.ts:191-203`) | ⚠️ **Layering bypass** — config-level top-ups (e.g. ASM +2 annual) silently ignored until a settings doc exists |
| `enabledModules` | Wizard, `ModulesSection` | `isModuleEnabled()` → route gate (`App.tsx:158-165`) + nav filter (`AppLayout.tsx:80-88`) | ✅ enforced for nav/routes. Not enforced: `/contracts` (deliberately non-toggleable, `App.tsx:74`), direct engine calls, anything server-side |
| `customFields` | `CustomFieldsSection` | `EmployeeFormDialog`, `EmployeeDetailPage` via `getEmployeeCustomFields()` | ✅ for forms/detail; ⚠️ absent from `records/PrintSheet.tsx` and exports |
| `numberFormats.employeeIdPrefix` | Wizard, `BrandingSection` | `nextEmployeeNo()` (`db.ts:322-338`) — used by seed + `onboardLinks.ts:630` conversion | ⚠️ **Not applied** on manual employee creation (`EmployeeFormDialog` never calls it) |
| `numberFormats.payslipPrefix` | Wizard, `BrandingSection` | **None.** Payslips get `uid()` ids (`payrollEngine.ts:394,496`); no formatted slip number in `PayslipPage`, `StatutoryOutputs`, `EAForm` | ❌ **Dead config** — gap confirmed as suspected |
| `orgChart.showDottedLineReports` | Wizard (false), tenants seed | `OrgChartPage.tsx:101`, `OrgPage.tsx:76` | ✅ |
| `branding` (on Company) | Wizard, `BrandingSection` | App shell via `useCompanyBranding` (`AppLayout.tsx:21,357`), `ContractDocument.tsx:69-70`, public onboard banner (`onboard/fields.tsx:55-58`) | ✅; payslip header reads the tenant `settings` singleton instead (consistent, tenant-scoped) |

---

## 4. Cross-tenant features

### 4.1 SuperAdmin console depth

- **Overview**: tenant/employee/status counts, estimated MRR (seats × plan rate, active-only), headcount bar, plan donut — all live cross-tenant reads via `getCollection(name, tenantId)` (`OverviewSection.tsx`, `lib.ts:43-56`).
- **Companies**: search/filter, enter, edit, suspend/reactivate, create wizard (`CompaniesSection.tsx`).
- **Activity**: merged cross-tenant audit, latest 50, per-tenant filter (`ActivitySection.tsx:19-31`).
- **System**: per-tenant force-reseed, global-holidays note, plan matrix (`SystemSection.tsx`).

Missing depth: no cross-tenant *operational* reporting (payroll cost, attrition, module usage per tenant), no per-tenant storage footprint, no usage/adoption metrics, no invoice/billing history, no all-tenant export. Analytics are read-only aggregates with no drill-through.

### 4.2 Impersonation audit trail ❌

"Enter company" is a bare `setActiveCompany(id)` + navigate (`CompaniesSection.tsx:239-242`) — **no audit event is written for impersonation start/end** (neither in the target tenant nor a system log). SuperAdmin *management* actions (`company.create/update/suspend/reactivate`) are logged into the **affected tenant's** audit (`CompaniesSection.tsx:86-95, 249-258`) — visible to that tenant, good — but day-to-day edits made while impersonating are indistinguishable from local admin actions beyond the actor name. No read-only "support view" mode.

### 4.3 Server-side tenancy ✅ (strong) with coverage gaps

- JWT carries `companyId` (null only for SuperAdmin) (`server/src/db/collections.ts:15-22`, `auth/guard.ts`).
- Every table is `company_id`-pinned with composite PK `(company_id, id)`; holidays global via `company_id IS NULL` (`collections.ts:263-331`, `sql/schema.sql`).
- Company users pinned — cross-company scope ⇒ 403; SuperAdmin must pass explicit `x-company-id` (`collections.ts:131-146`).
- Role scoping fail-closed: Manager→department, Employee→self (`visibilityFilter`/`assertWriteAllowed`, `collections.ts:170-247`); audit append-only over API.
- **Gaps:** (a) schema/registry covers only core collections + kpi/org extras — lifecycle, contracts, onboardLinks/submissions/extras, employeeRecords and rotations have **no tables** (`sql/schema.sql` 21 tables), so API mode cannot persist those modules; (b) login ignores `companies.status`; (c) no DELETE company; (d) no module/plan enforcement server-side.

---

## 5. Enterprise multi-tenant roadmap assessment

| Capability | Today | Gap / recommendation |
|---|---|---|
| Org hierarchies (holding → subsidiaries) | `Company` is flat — no `parentCompanyId`, no group/consolidated view; SuperAdmin "system view" is the only cross-company surface | Add `parentCompanyId` + group rollups (consolidated headcount/payroll cost), group-level HR role with scoped multi-tenant read; storage already supports N tenants, so this is a directory + analytics change |
| Tenant-level roles vs system roles | Flat global enum `Admin/HR/Manager/Employee/SuperAdmin`; one account = one company (`UserAccount.companyId`) | Group users (e.g. holding-company HR director) need a `user_company_roles` join with per-tenant grants; keep SuperAdmin as the only system role |
| SSO per tenant | Mock plaintext auth client-side; bcrypt+JWT server-side; no IdP hooks anywhere | Per-tenant IdP config (OIDC/SAML metadata on `Company.config`), just-in-time provisioning, SCIM for enterprise plans; JWT claim mapping already carries `companyId` for pinning |
| Data residency / PDPA | `docs/enterprise-deployment.md:274-278` has a PDPA 2010 checklist (lawful basis, need-to-know, breach runbook, jurisdiction-limited DB/backups) and audit-retention note (line 93); single-DB deployment, no per-tenant region | Add `Company.dataRegion`, residency-aware placement (or schema-per-region), audit WORM/export, retention & erasure policies — currently blocked by the absence of tenant deletion (§2.2) and incomplete export (§2.5) |

---

## 6. Prioritized enhancements

**P0 — isolation & access control**
1. Namespace attendance rotations per tenant (`myhrms:t:<id>:attendance:rotations` or route through `useCollection`) — the one real cross-tenant leak (L1).
2. Enforce `status:'suspended'` at mock `login()` **and** server `/auth/login` (403 with a clear message), and block `setActiveCompany` into suspended tenants.

**P1 — lifecycle completeness & config honesty**
3. Tenant deletion: `deleteCompany` + cascade purge of all `myhrms:t:<id>:*` keys (incl. module extras), tenant's `hrms.users` accounts, and server `DELETE /api/companies/:id` with table cascade; double-confirm + audit.
4. Apply `numberFormats.payslipPrefix` when generating payslips (formatted slip no. on `PayslipPage`/statutory outputs) or remove the field.
5. Fix `leaveTopUps` layering — `leaveLogic` should read via `appSettings.getLeaveTopUps()` so `Company.config` top-ups apply.
6. Wire `payrollCutoffDay` into the payroll run/attendance close-out (or mark it informational); expose `payrollProration` in `PolicySection` (engine already honours it).
7. Complete the data export (all module-extra collections + Company record + accounts) for real portability/PDPA erasure evidence.

**P2 — governance**
8. Audit impersonation: write `tenant.impersonate.start/end` events (target tenant + a system-level audit stream); consider a read-only support mode.
9. Tenant-side account provisioning (invite/reset flow) replacing lazy `seedUsers()` default-password derivation; move username uniqueness to `(companyId, username)`.
10. Trial lifecycle: expiry date, automated trial→suspended transition, and plan→`enabledModules` defaulting/enforcement.
11. Apply `employeeIdPrefix` (`nextEmployeeNo`) in manual employee creation; include custom fields in record print/export.

**P3 — enterprise roadmap**
12. `parentCompanyId` + consolidated group analytics; per-tenant SSO/SCIM; `dataRegion` + residency controls; server tables for lifecycle/contracts/onboard/records collections to close the API-mode coverage gap.
