# Multi-Tenant API — `src/lib`

The HRMS is now multi-tenant: **many companies, one system SuperAdmin**.
This document is the contract for UI agents building against the tenant layer
(SuperAdmin console, company switcher, org chart, custom fields).

## 1. Storage model

| Key | Contents | Scope |
|---|---|---|
| `myhrms:t:<companyId>:<collection>` | every operational collection (employees, attendance, …) | per tenant |
| `myhrms:companies` | `Company[]` — the tenant directory | **global** |
| `myhrms:activeTenant` | active companyId, or `__system__` (SuperAdmin system view) | global |
| `myhrms:holidays` | holiday admin overrides | **global** (law is national) |
| `myhrms:migrated:v2` | legacy single-tenant → multi-tenant migration flag | global |
| `myhrms:system:audit` | `SystemAuditEntry[]` — GLOBAL system stream: tenant-deletion tombstones + SuperAdmin impersonation enter/exit events | **global** |
| `myhrms:t:<companyId>:seeded:v1` | per-tenant seed flag | per tenant |
| `hrms.users` / `hrms.session` | mock-auth account directory / session | **global** |

**Pages do not change.** `useCollection(name)`, `getCollection(name)`,
`setCollection(name, items)` transparently read/write the **active tenant**.
`getCollection` / `setCollection` / `logAudit` accept an optional trailing
`tenantId` for cross-tenant tooling:

```ts
getCollection<Employee>('employees');            // active tenant
getCollection<Employee>('employees', 'co-asm');  // explicit tenant (SuperAdmin tooling)
setCollection('employees', rows, 'co-merdeka');
logAudit({ actorName, action, entity }, 'co-desa');
```

When no tenant has ever been selected, the active tenant defaults to
`'co-asm'` (exported as `DEFAULT_COMPANY_ID`) — tests and scripts keep
working with zero setup.

### 1a. Collection registry (`COLLECTIONS` in `lib/db.ts`)

`COLLECTIONS` / `CollectionName` are the **single source of truth** for every
persisted collection. JSON export/import (`exportTenantData` /
`importTenantData`), legacy migration, per-tenant seed init and storage
accounting all iterate the registry — a collection that is not registered is
silently dropped by all of them. Since the P1 registry unification, the
former typed-cast module stores are first-class members and use
`useCollection` directly (no private pub/sub, no casts):

| Collection | Contents | Owner module |
|---|---|---|
| `departments` | Department[] | core scaffold |
| `positions` | Position[] | core scaffold |
| `employees` | Employee[] | core scaffold |
| `shifts` | Shift[] | core scaffold |
| `attendance` | AttendanceRecord[] | core scaffold |
| `leaves` | LeaveRequest[] | core scaffold |
| `leaveBalances` | LeaveBalance[] | core scaffold |
| `claims` | Claim[] | core scaffold |
| `payrollRuns` | PayrollRun[] | core scaffold |
| `payslips` | Payslip[] | core scaffold |
| `kpis` | KPI[] | core scaffold |
| `reviews` | KPIReview[] | core scaffold |
| `holidays` | Holiday[] — **global** (law is national) | core scaffold |
| `settings` | Settings / extension docs | core scaffold |
| `audit` | AuditLog[] — capped at newest 2,000 per tenant (`MAX_AUDIT_ENTRIES`) | core scaffold |
| `onboardingChecklists` | OnboardingChecklist[] | `lib/lifecycle.ts` |
| `offboardingCases` | OffboardingCase[] | `lib/lifecycle.ts` |
| `positionProfiles` | PositionProfile[] (keyed by positionId) | `lib/orgChart.ts` |
| `departmentProfiles` | DepartmentProfile[] (keyed by departmentId) | `lib/orgChart.ts` |
| `contracts` | EmploymentContract[] | `lib/contracts.ts` |
| `contractFeePayments` | FeePayment[] | `lib/contracts.ts` |
| `employeeRecords` | EmployeeRecordFile[] (per-employee personnel file) | `lib/employeeRecords.ts` |
| `onboardLinks` | OnboardLink[] (token-gated invite links) | `lib/onboardLinks.ts` |
| `onboardSubmissions` | OnboardSubmission[] | `lib/onboardLinks.ts` |
| `onboardingExtras` | OnboardingExtras[] (keyed by employeeId) | `lib/onboardLinks.ts` |
| `cycles` | KpiCycle[] (review-cycle stage machine) | `lib/kpiEngine.ts` |
| `objectives` | Objective[] (OKRs + goal cascade) | `lib/kpiEngine.ts` |
| `checkins` | CheckIn[] (1:1 notes per review) | `lib/kpiEngine.ts` |
| `pips` | Pip[] (performance improvement plans) | `lib/kpiEngine.ts` |
| `attendance:rotations` | RotationPlan[] — physical sub-key `myhrms:t:<companyId>:attendance:rotations` | `pages/attendance/model.ts` |

Notes:

- `attendance:rotations` is a registry member so export/import, legacy
  migration and per-tenant seed init cover it, but its store module
  (`pages/attendance/model.ts`, outside the registry scope) still owns a
  private pub/sub + its own legacy-key migration (idempotent, tenant-wins —
  compatible with the db.ts migration). Registry-driven writes (e.g. an
  import) do not live-refresh already-mounted attendance screens; they
  re-read on next mount. Fold it into `useCollection` when that module's
  owner picks up the follow-up.
- `pages/claims/actingAsStorage.ts` keeps a page-local UI pointer under
  `myhrms:t:<companyId>:claims:actingAs`. It is a session-scoped selection,
  not a document collection, and is intentionally NOT in the registry.
- The seed dataset (`lib/seed.ts`) only generates the 15 core collections;
  module collections start empty and are produced by user activity. Reseeding
  a tenant rewrites the seeded core collections and leaves module collections
  untouched.

## 2. `lib/tenantContext.tsx` — React tenant state

`TenantProvider` is wired in `App.tsx` around `AuthProvider`.

```ts
const {
  companies,        // Company[] — global directory
  activeCompanyId,  // string | null (null = SuperAdmin system view)
  activeCompany,    // Company | null
  isSystemView,     // boolean
  trialStatus,      // TrialStatus | null — db.trialStatusOf(activeCompany);
                    // expired trials block company users at login
  setActiveCompany, // (companyId) => void — enter a company (seeds it on first entry);
                    // SuperAdmin entries log 'superadmin.enter_company' to the
                    // GLOBAL system audit (impersonation trail)
  leaveCompany,     // () => void — SuperAdmin only: back to system view;
                    // logs 'superadmin.exit_company'
  refreshCompanies, // () => void — re-read the directory after create/update
} = useTenant();
```

- Regular users (Admin/HR/Manager/Employee) are **pinned** to their account's
  `companyId`; `setActiveCompany` / `leaveCompany` are guarded no-ops for them.
- SuperAdmin enters any company with `setActiveCompany(id)`; every page then
  scopes to it automatically. `leaveCompany()` returns to the system view.
- **Impersonation audit (§7):** enter/exit writes go through
  `auth.auditImpersonation()`, which re-checks the SuperAdmin session — regular
  sessions cannot forge trail entries even by calling it directly.

Low-level equivalents in `lib/db.ts` (non-React):
`getActiveTenantId()`, `setActiveTenantId(id | null)`, `subscribeTenant(fn)`.

## 3. Companies API (`lib/db.ts`)

```ts
getCompanies(): Company[]
saveCompanies(list): void          // notifies tenant subscribers
getCompany(id): Company | undefined
upsertCompany(company): Company    // insert-or-update by id
removeCompany(id, actorName?): RemoveCompanyReport | null
                                   // PDPA erasure — purges EVERY key under
                                   // myhrms:t:<id>: (registry + sub-keys +
                                   // page-local keys + seed flag), removes the
                                   // directory record, removes the company's
                                   // hrms.users accounts (SuperAdmin exempt),
                                   // drops a session pinned to the tenant,
                                   // resets the active tenant if it was active,
                                   // and writes a GLOBAL tombstone to
                                   // myhrms:system:audit. null = unknown id.
getActiveCompany(): Company | undefined
nextEmployeeNo(companyId): string  // e.g. 'ASM0031' — applies
                                   // config.numberFormats.employeeIdPrefix
trialStatusOf(company, now?): TrialStatus
                                   // { isTrial, trialEndsAt, daysLeft, expired } —
                                   // pure; expired only when status==='trial'
                                   // AND trialEndsAt is a valid past date
logSystemAudit(entry): void        // GLOBAL stream append (capped at
                                   // MAX_AUDIT_ENTRIES, oldest dropped)
getSystemAudit(): SystemAuditEntry[]
SYSTEM_AUDIT_KEY                   // 'myhrms:system:audit'
seedTenantIfEmpty(companyId, force?): Promise<void>  // per-tenant seeding (idempotent);
                                                     // await — resolves after writes land
seedIfEmpty(force?): Promise<void>                   // seeds ALL demo tenants (awaited)
dbReady(): Promise<void>                   // resolves once the module-init auto-seed has
                                           // landed (immediately when already seeded)
exportTenantData(tenantId?): Record<CollectionName, unknown[]>
                                           // snapshot EVERY registry collection
importTenantData(data, tenantId?, mode): ImportReport
                                           // merge (by id) | replace; unknown keys
                                           // skipped & reported
MAX_AUDIT_ENTRIES = 2000                   // per-tenant audit cap — logAudit trims
                                           // oldest entries on append (the system
                                           // stream uses the same cap)
```

Seeding is **awaitable** (P1 seed-race fix): `seedTenantIfEmpty` /
`seedIfEmpty` dynamically import `lib/seed.ts` and return a promise that
resolves only after the import and all collection writes have landed. The
module-bottom auto-seed still fires on import when storage is available;
`dbReady()` is the ready handle for non-React callers that must not read
before initialization (reactive pages converge on their own — seed writes
notify subscribers).

**Export/import & the enterprise migrator.** "Export all data" (Settings →
Data management) serializes **every** registry collection via
`exportTenantData`, and the web import restores any of them via
`importTenantData` (unknown keys are skipped with a report). The Postgres
migrator (`server/scripts/migrate-from-browser.ts`, registry in
`server/src/db/collections.ts`) currently maps 20 collections — the 15 core
ones plus `cycles`, `objectives`, `checkins`, `pips`, `positionProfiles`,
`departmentProfiles`, with `audit` handled specially. The remaining 9
(`onboardingChecklists`, `offboardingCases`, `contracts`,
`contractFeePayments`, `employeeRecords`, `onboardLinks`,
`onboardSubmissions`, `onboardingExtras`, `attendance:rotations`) now appear
in export files and are skipped with a console warning until the server
registry + SQL schema are extended — that follow-up lives in the server
scope, not the web registry.

`Company` / `CompanyConfig` shape (`lib/types.ts`):

```ts
interface Company {
  id: string; code: string; name: string; regNo: string; hqState: StateCode;
  status: 'active' | 'suspended' | 'trial';
  plan: 'free' | 'pro' | 'enterprise';
  trialEndsAt?: string;                           // ISO — trial clock; company users
                                                  // are blocked at login once past
                                                  // (absent = open, non-expiring trial)
  createdAt: string;                              // ISO datetime
  branding: { logoText: string; accentColor: string };
  config: CompanyConfig;
}

interface CompanyConfig {
  workingWeek: 'sat-sun' | 'fri-sat';             // default by HQ state
  payrollCutoffDay: number;                       // 1–28
  claimPolicy: { mileageRatePerKm?; mealDailyLimit?; medicalClaimLimit?; phoneMonthlyLimit? };
  leaveTopUps: { annual?; sick?; hospitalization?; maternity?; paternity? };
  enabledModules: ModuleKey[];                    // attendance|leave|claims|payroll|kpi|insights|reports|onboarding|offboarding
  customFields: { id; label; type: 'text'|'number'|'date'|'select'; options?; appliesTo: 'employee' }[];
  numberFormats: { employeeIdPrefix: string; payslipPrefix: string };
  orgChart: { showDottedLineReports: boolean };
}
```

`lib/appSettings.ts` accessors (`getClaimPolicy`, `getLeaveTopUps`,
`getPayrollCutoff`) automatically read the ACTIVE tenant and layer:
**system defaults → Company.config → settings docs** (unchanged exports).

Employees carry an optional human-facing `employeeNo?: string` (e.g.
`ASM0007`) — generate it with `nextEmployeeNo(companyId)` when creating
employees.

## 4. Auth (`lib/auth.ts`, `lib/authContext.tsx`)

- `AuthRole = 'Admin' | 'HR' | 'Manager' | 'Employee' | 'SuperAdmin'`.
- `UserAccount.companyId: string | null` — **required**; `null` only for
  SuperAdmin (cross-company, never an `employeeId`).
- `Session.companyId: string | null` — login resolves the account's company
  and switches the active tenant; a SuperAdmin session starts in the system
  view (active tenant `null`).
- `useAuth()` gains `companyId: string | null` and `isSuperAdmin: boolean`.
  SuperAdmin scopes like Admin/HR (unrestricted) in `scopeByEmployee` & co.
- AppRole consumers map `SuperAdmin → Admin` (nav/route guards) — done in
  `AppLayout.useEffectiveRole` and `pages/leave/useAuthScope`.
- **Login tenant gates (checked only AFTER credentials verify — never leaked
  to bad passwords):** users of a `suspended` company are rejected, and users
  of an **expired-trial** company (`trialStatusOf(company).expired`) are
  rejected with a "trial expired — contact support" message. SuperAdmin
  (`companyId: null`) is never blocked.
- `auditImpersonation('enter' | 'exit', companyId)` — session-guarded writer
  for the impersonation trail (no-op for non-SuperAdmin sessions or unknown
  companies); called by `TenantProvider` on enter/exit.

### Demo accounts (`seedUsers()`)

| Username | Password | Role | Company |
|---|---|---|---|
| `superadmin` | `super123` | SuperAdmin | — (system) |
| `admin` | `admin123` | Admin | co-asm |
| `hr` | `hr123` | HR | co-asm |
| `ahmad.faizal` | `manager123` | Manager (emp-01) | co-asm |
| `tan.weiling` | `manager123` | Manager (emp-03) | co-asm |
| `admin2` | `admin123` | Admin | co-merdeka |
| `hr2` | `hr123` | HR | co-merdeka |
| `admin3` | `admin123` | Admin | co-desa |
| `hr3` | `hr123` | HR | co-desa |
| *email local-part* (e.g. `zulkifli1`) | `password123` | Employee | each company |

Password pattern: fixed staff accounts reuse the ASM pattern
(`admin123`/`hr123`/`manager123`/`password123`); the numeric username suffix
(`admin2`, `admin3`) distinguishes companies. Cross-company username
collisions are namespaced with the company code (`name.mrd`).

## 5. Demo tenants (`lib/tenants.ts`, `lib/seed.ts`)

| Company | Id | HQ | Weekend | Employees |
|---|---|---|---|---|
| ASM Tech Sdn Bhd | `co-asm` | KUL | sat-sun | 30 (original dataset, unchanged) |
| Merdeka Manufacturing Sdn Bhd | `co-merdeka` | JHR | **fri-sat** | 12 (manufacturing) |
| Desa Retail Group | `co-desa` | PNG | sat-sun | 8 (retail) |

- `buildTenantSeedData(companyId)` → `{ company, collections } | null`.
- `buildCompanySeedData(params)` — the parameterized generator (departments,
  positions, empRows, salary bands, shifts, weekend days, headcount-scaled
  attendance/leave/claims/KPI samples). `buildSeedData()` remains the ASM
  entry (identical dataset).

## 6. Migration

`migrateLegacyData()` (db.ts) runs automatically on first storage access:
pre-multitenant keys `myhrms:<collection>` are moved under
`myhrms:t:co-asm:<collection>`, the `co-asm` Company record is ensured, and
`myhrms:migrated:v2` is written. Idempotent — tenant data always wins over
leftover legacy keys; re-runs are no-ops. The loop iterates the full
registry (§1a), so the legacy global rotations key
(`myhrms:attendance:rotations`) is covered too — alongside the attendance
module's own idempotent migration in `pages/attendance/model.ts`.

## 7. Tenant lifecycle (deletion · trial clock · impersonation trail)

Closes the audit-multitenant §2 lifecycle gaps (P1-3 deletion, §2.4 toothless
trial, §4.2 missing impersonation audit).

### 7a. Tenant deletion — PDPA erasure

`db.removeCompany(companyId, actorName?)` is the erasure path. It purges by
**prefix scan** (`myhrms:t:<companyId>:`), not by registry iteration, so every
tenant-owned key is removed — all 31 registry collections, sub-keys
(`attendance:rotations`), page-local keys (`claims:actingAs`) and the
per-tenant seed flag — then:

1. removes the `Company` from the global directory (`myhrms:companies`);
2. removes the company's accounts from `hrms.users` (SuperAdmin,
   `companyId: null`, is structurally exempt);
3. drops `hrms.session` when it is pinned to the deleted company;
4. resets the active-tenant pointer to the system view when the deleted
   company was active (no later write can resurrect the purged namespace);
5. appends a **global tombstone** (actor, company name, timestamp, key count)
   to `myhrms:system:audit` — the only surviving trace of the tenant.

Access control lives at the call site: the SuperAdmin console → Companies →
Edit dialog → **Danger zone**, with a type-the-company-name confirm
(`CompaniesSection.deleteCompany`). When the deleted company was the active
tenant the console calls `leaveCompany()` first (so the impersonation-exit
event still resolves the company name), then toasts and navigates back to
`/superadmin`.

### 7b. Trial clock

- `Company.trialEndsAt?: string` (ISO, additive). `db.trialStatusOf(company)`
  → `{ isTrial, trialEndsAt, daysLeft, expired }`; a trial with no clock never
  expires, and `trialEndsAt` is ignored for non-trial statuses.
- **Login gate** (`auth.login`, same post-credential pattern as the suspend
  check): expired-trial company users get "The trial for ‹name› has expired.
  Please contact support…". SuperAdmin is never blocked.
- The create-company wizard auto-sets `trialEndsAt = now + 30 days` (new
  tenants start on trial); the SuperAdmin Edit dialog exposes a date input
  (empty = open trial).
- Console surfaces: an amber **"Trial expired"** badge in the Companies
  directory (live trials show "Nd left"), and an amber **TrialExpiredBanner**
  inside the app shell while the SuperAdmin works inside an expired tenant.

### 7c. Impersonation audit trail + system stream

`myhrms:system:audit` (`SystemAuditEntry[]`, capped at `MAX_AUDIT_ENTRIES`)
is the GLOBAL, never-namespaced audit stream. Writers:

| Event | Writer |
|---|---|
| `company.delete` | `db.removeCompany` (tombstone) |
| `superadmin.enter_company` | `TenantProvider.setActiveCompany` → `auth.auditImpersonation` |
| `superadmin.exit_company` | `TenantProvider.leaveCompany` → `auth.auditImpersonation` |

The SuperAdmin console → Activity section merges this stream with every
tenant's own audit trail (system rows carry a **SYSTEM** badge); a dedicated
"System events" filter isolates it. The stream is deliberately outside any
tenant: tenant admins cannot edit it, and it survives tenant deletion.
