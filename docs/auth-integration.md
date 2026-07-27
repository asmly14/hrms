# Auth Integration Guide (for the integration agent)

Wave-1 auth core is complete and self-contained in **new files only**:

| File | Exports |
|---|---|
| `src/lib/auth.ts` | `UserAccount`, `PublicUser`, `Session`, `AuthRole`, `LoginResult`, `DEMO_PASSWORD`, `seedUsers()`, `usernameForEmployee()`, `findUser()`, `login()`, `logout()`, `getSession()`, `currentUser()` |
| `src/lib/authContext.tsx` | `AuthProvider`, `useAuth()` |
| `src/pages/login/LoginPage.tsx` | default export `LoginPage` |

Nothing existing was modified. Wire it up as follows.

---

## 1. Demo accounts (seeded by `seedUsers()`, runs on `AuthProvider` mount and on every `login()`)

| Username | Password | Role | Linked employee |
|---|---|---|---|
| `admin` | `admin123` | Admin | — (standalone) |
| `hr` | `hr123` | HR | — (standalone) |
| `ahmad.faizal` | `manager123` | Manager | `emp-01` (Head of Engineering) |
| `tan.weiling` | `manager123` | Manager | `emp-03` (Head of Finance) |
| email prefix of every seeded employee, e.g. `siti5` | `password123` | Employee | that employee |

Employee usernames are the email local-part (`ahmad1@asmtech.my` → `ahmad1`).
Storage: accounts in `localStorage['hrms.users']`, session in `localStorage['hrms.session']`.

---

## 2. `App.tsx` — mount provider, route, and guard

```tsx
import { AuthProvider, useAuth } from '@/lib/authContext';
import LoginPage from '@/pages/login/LoginPage';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
// …existing imports (RoleProvider stays for the dev-only switcher, see §3)

/** Redirects unauthenticated users to /login, remembering where they were headed. */
export function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

export default function App() {
  return (
    <RoleProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppLayout />}>
              {routeRegistry.map((r) => (
                <Route key={r.path} path={r.path} element={r.element} />
              ))}
              <Route path="*" element={
                <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading…</div>}>
                  <NotFound />
                </Suspense>
              } />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </RoleProvider>
  );
}
```

---

## 3. `AppLayout.tsx` — use the auth role; keep the switcher as a dev-only override

The topbar role switcher (`roleContext.tsx`) must no longer decide what a real
session sees. Recommended pattern — effective role = dev override **or** the
authenticated role:

```tsx
import { useAuth } from '@/lib/authContext';
import { useRole, type AppRole } from '@/lib/roleContext';

function useEffectiveRole(): AppRole {
  const { role } = useAuth();            // 'Admin' | 'HR' | 'Manager' | 'Employee' | null
  const { role: devOverride } = useRole();
  // Dev-only override: set localStorage 'myhrms:devRoleOverride' = '1' to
  // re-enable the topbar switcher for demos. Default = follow the login role.
  const devEnabled = import.meta.env.DEV &&
    localStorage.getItem('myhrms:devRoleOverride') === '1';
  if (devEnabled) return devOverride;
  return role ?? 'Employee';             // fail closed, never wider
}
```

Then in `TopBar`/`SideNav`/`BottomNav` replace `const { role } = useRole()`
with `const role = useEffectiveRole()`. Add a user menu (name + role +
**Sign out** → `logout(); navigate('/login')`) next to the switcher. When the
override is disabled, render the switcher as a disabled badge showing the
session role (or hide it).

---

## 4. Per-module data scoping recipe (the 8 module fix-agents)

`useAuth()` exposes three pure helpers — apply them **after** `useCollection`:

```ts
canViewEmployee(id: string): boolean
scopeEmployees(list: Employee[]): Employee[]
scopeByEmployee<T>(list: T[], getEmpId: (item: T) => string): T[]
```

Rules: Admin/HR → everything · Manager → own department (resolved from the
linked employee record) · Employee → self only. Wrap in `useMemo` when the
list is large or feeds a table.

### Attendance (the reported bug: Employee saw everyone's attendance)

```tsx
// BEFORE
const { items: records } = useCollection<AttendanceRecord>('attendance');
// …records rendered directly → leaks everyone’s data

// AFTER
const { scopeByEmployee } = useAuth();
const { items: records } = useCollection<AttendanceRecord>('attendance');
const visible = useMemo(
  () => scopeByEmployee(records, (r) => r.employeeId),
  [records, scopeByEmployee],
);
// …render `visible`
```

### Leave

```tsx
const { scopeByEmployee } = useAuth();
const { items: leaves } = useCollection<LeaveRequest>('leaves');
const visible = scopeByEmployee(leaves, (l) => l.employeeId);
// LeaveBalance ('leaveBalances') uses the same recipe.
```

### Claims

```tsx
const { scopeByEmployee } = useAuth();
const { items: claims } = useCollection<Claim>('claims');
const visible = scopeByEmployee(claims, (c) => c.employeeId);
```

### Payslips

```tsx
const { scopeByEmployee, employeeId, role } = useAuth();
const { items: payslips } = useCollection<Payslip>('payslips');
const visible = scopeByEmployee(payslips, (p) => p.employeeId);
// Employee self-service payslip view: role === 'Employee' → show `visible`
// (already just their own). Payroll *runs* stay Admin/HR-only via NAV gating.
```

### Employee directory pages

```tsx
const { scopeEmployees } = useAuth();
const { items: employees } = useCollection<Employee>('employees');
const visible = scopeEmployees(employees);
```

### Detail pages (`/employees/:id`, `/payroll/payslip/:id`, …)

Guard direct URL access, not just lists:

```tsx
const { canViewEmployee } = useAuth();
const { id } = useParams();
// after resolving the record's employeeId:
if (!canViewEmployee(record.employeeId)) {
  return <Navigate to="/" replace />; // or an inline "No access" empty state
}
```

### Approvals / decision writes

When a Manager approves leave/claims/OT, additionally verify
`canViewEmployee(request.employeeId)` before calling `update(...)` so managers
cannot act outside their department.

---

## 5. Notes & limits (demo mode)

- Passwords are **plaintext in localStorage** — demo only, never production.
- `seedUsers()` is idempotent and merge-based; reseeding demo data
  (`seedIfEmpty(true)`) does not wipe accounts — employee accounts are
  re-derived on next login/provider mount.
- `logout()` only clears `hrms.session`; demo data and accounts persist.
- Scoping helpers fail closed: a Manager/Employee account with no linked
  employee sees nothing; unknown role ⇒ self-only (empty).
