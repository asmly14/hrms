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

## 2. `lib/tenantContext.tsx` — React tenant state

`TenantProvider` is wired in `App.tsx` around `AuthProvider`.

```ts
const {
  companies,        // Company[] — global directory
  activeCompanyId,  // string | null (null = SuperAdmin system view)
  activeCompany,    // Company | null
  isSystemView,     // boolean
  setActiveCompany, // (companyId) => void — enter a company (seeds it on first entry)
  leaveCompany,     // () => void — SuperAdmin only: back to system view
  refreshCompanies, // () => void — re-read the directory after create/update
} = useTenant();
```

- Regular users (Admin/HR/Manager/Employee) are **pinned** to their account's
  `companyId`; `setActiveCompany` / `leaveCompany` are guarded no-ops for them.
- SuperAdmin enters any company with `setActiveCompany(id)`; every page then
  scopes to it automatically. `leaveCompany()` returns to the system view.

Low-level equivalents in `lib/db.ts` (non-React):
`getActiveTenantId()`, `setActiveTenantId(id | null)`, `subscribeTenant(fn)`.

## 3. Companies API (`lib/db.ts`)

```ts
getCompanies(): Company[]
saveCompanies(list): void          // notifies tenant subscribers
getCompany(id): Company | undefined
upsertCompany(company): Company    // insert-or-update by id
getActiveCompany(): Company | undefined
nextEmployeeNo(companyId): string  // e.g. 'ASM0031' — applies
                                   // config.numberFormats.employeeIdPrefix
seedTenantIfEmpty(companyId, force?)  // per-tenant seeding (idempotent)
seedIfEmpty(force?)                   // seeds ALL demo tenants
```

`Company` / `CompanyConfig` shape (`lib/types.ts`):

```ts
interface Company {
  id: string; code: string; name: string; regNo: string; hqState: StateCode;
  status: 'active' | 'suspended' | 'trial';
  plan: 'free' | 'pro' | 'enterprise';
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
leftover legacy keys; re-runs are no-ops.
