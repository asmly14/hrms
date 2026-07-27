/**
 * Router root. All module routes are wired here by the integration agent,
 * following the route map in docs/architecture.md. The shell
 * (sidebar/topbar) wraps everything via the layout route.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AppWindow, type LucideIcon } from 'lucide-react';
import AppLayout, { useEffectiveRole } from '@/components/layout/AppLayout';
import { RoleProvider, type AppRole } from '@/lib/roleContext';
import { AuthProvider, useAuth } from '@/lib/authContext';
import { TenantProvider, useTenant } from '@/lib/tenantContext';
import type { ModuleKey } from '@/lib/types';
import LoginPage from '@/pages/login/LoginPage';
import DashboardPage from '@/pages/dashboard';
import EmployeesPage from '@/pages/employees/EmployeesPage';
import EmployeeDetailPage from '@/pages/employees/EmployeeDetailPage';
import AttendancePage from '@/pages/attendance/AttendancePage';
import ShiftsPage from '@/pages/attendance/ShiftsPage';
import LeavePage from '@/pages/leave/LeavePage';
import HolidaysPage from '@/pages/holidays/HolidaysPage';
import ClaimsPage from '@/pages/claims/ClaimsPage';
import PayrollHome from '@/pages/payroll/PayrollHome';
import RunDetail from '@/pages/payroll/RunDetail';
import PayslipPage from '@/pages/payroll/PayslipPage';
import KpiPage from '@/pages/kpi';
import ReviewCycle from '@/pages/kpi/ReviewCycle';
import SalaryInsightsPage from '@/pages/insights/SalaryInsightsPage';
import ReportsPage from '@/pages/reports/ReportsPage';
import SettingsPage from '@/pages/settings/SettingsPage';
import OnboardingPage from '@/pages/onboarding/OnboardingPage';
import OffboardingPage from '@/pages/offboarding/OffboardingPage';
import SuperAdminPage from '@/pages/superadmin/SuperAdminPage';
import OrgPage from '@/pages/org/OrgPage';
import OrgChartPage from '@/pages/org/OrgChartPage';
import CompanyPage from '@/pages/company/CompanyPage';
import { isModuleEnabled, MODULE_DEFS } from '@/pages/company/modules';

const NotFound = lazy(() => import('@/pages/NotFound'));

export interface RouteDef {
  path: string;
  title: string;
  icon?: LucideIcon;
  element: ReactNode;
  /** When set, only these session roles may open the route (direct-URL guard,
   *  mirrors the nav gating in AppLayout). Others are redirected to '/'.
   *  Omit for routes any authenticated user may open. */
  roles?: AppRole[];
  /** When set, the route is feature-gated by the active company's module
   *  toggles (pages/company/modules.ts). A disabled module renders a
   *  "module disabled" card instead of the page. Omit for always-on routes
   *  (dashboard, employees, holidays, org, company, settings, superadmin). */
  module?: ModuleKey;
}

/**
 * The single place routes are registered. Mirrors docs/architecture.md:
 * M1 dashboard · M2 employees · M3 attendance · M4 leave/holidays ·
 * M5 claims · M6 payroll · M7 kpi · M8 insights/reports · M9 settings ·
 * M10 org · Company Setup · Super Admin console.
 */
export const routeRegistry: RouteDef[] = [
  { path: '/', title: 'Dashboard', element: <DashboardPage /> },
  { path: '/employees', title: 'Employees', element: <EmployeesPage />, roles: ['Admin', 'HR'] },
  { path: '/employees/:id', title: 'Employee Detail', element: <EmployeeDetailPage /> },
  { path: '/org', title: 'Organization', element: <OrgPage />, roles: ['Admin', 'HR'] },
  { path: '/org/chart', title: 'Org Chart', element: <OrgChartPage />, roles: ['Admin', 'HR'] },
  { path: '/attendance', title: 'Attendance', element: <AttendancePage />, module: 'attendance' },
  { path: '/attendance/shifts', title: 'Shifts', element: <ShiftsPage />, module: 'attendance' },
  { path: '/leave', title: 'Leave', element: <LeavePage />, module: 'leave' },
  { path: '/holidays', title: 'Public Holidays', element: <HolidaysPage />, roles: ['Admin', 'HR'] },
  { path: '/claims', title: 'Claims', element: <ClaimsPage />, module: 'claims' },
  { path: '/payroll', title: 'Payroll', element: <PayrollHome />, roles: ['Admin', 'HR'], module: 'payroll' },
  { path: '/payroll/runs/:id', title: 'Payroll Run', element: <RunDetail />, roles: ['Admin', 'HR'], module: 'payroll' },
  { path: '/payroll/payslip/:id', title: 'Payslip', element: <PayslipPage />, module: 'payroll' },
  { path: '/kpi', title: 'KPI & Performance', element: <KpiPage />, roles: ['Admin', 'HR', 'Manager'], module: 'kpi' },
  { path: '/kpi/reviews/:id', title: 'Review Cycle', element: <ReviewCycle />, module: 'kpi' },
  { path: '/insights/salary', title: 'Salary Insights', element: <SalaryInsightsPage />, roles: ['Admin', 'HR'], module: 'insights' },
  { path: '/reports', title: 'Reports', element: <ReportsPage />, roles: ['Admin', 'HR', 'Manager'], module: 'reports' },
  { path: '/onboarding', title: 'Onboarding', element: <OnboardingPage />, roles: ['Admin', 'HR'], module: 'onboarding' },
  { path: '/offboarding', title: 'Offboarding', element: <OffboardingPage />, roles: ['Admin', 'HR'], module: 'offboarding' },
  { path: '/company', title: 'Company Setup', element: <CompanyPage />, roles: ['Admin', 'HR'] },
  { path: '/settings', title: 'Settings', element: <SettingsPage />, roles: ['Admin'] },
  // SuperAdmin maps to Admin in useEffectiveRole, so RoleGate passes the
  // system SuperAdmin through; company Admins hit the in-page restricted
  // notice (the page self-guards on useAuth().isSuperAdmin).
  { path: '/superadmin', title: 'Super Admin', element: <SuperAdminPage />, roles: ['Admin'] },
];

/** Redirects unauthenticated users to /login, remembering where they were headed. */
export function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

/**
 * Direct-URL role guard. Nav gating hides links, but a logged-in user could
 * still type e.g. /payroll — without this an Employee session would see
 * payroll runs (the dev role stub defaults to 'Admin'). Fails closed.
 */
function RoleGate({ roles, children }: { roles: AppRole[]; children: ReactNode }) {
  const { role } = useEffectiveRole();
  if (!roles.includes(role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/** Styled card shown when the active company has disabled a module. */
function ModuleDisabledCard({ module }: { module: ModuleKey }) {
  const label = MODULE_DEFS.find((m) => m.key === module)?.label ?? module;
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="w-full max-w-md rounded-xl border border-dashed bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950">
          <AppWindow className="h-6 w-6 text-amber-600 dark:text-amber-400" />
        </div>
        <h2 className="text-lg font-semibold">{label} is disabled</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This module has been disabled by your company admin for the active
          company. It can be re-enabled under Company Setup → Modules.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            to="/"
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Back to dashboard
          </Link>
          <Link
            to="/company?tab=modules"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Manage modules
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-company feature gate. isModuleEnabled() is non-reactive (reads the
 * active company from storage), so subscribe to tenant switches to
 * re-evaluate the gate immediately after entering/leaving a company.
 */
function ModuleGate({ module, children }: { module: ModuleKey; children: ReactNode }) {
  const { activeCompanyId } = useTenant();
  void activeCompanyId; // subscription only — the gate reads fresh state below
  if (!isModuleEnabled(module)) {
    return <ModuleDisabledCard module={module} />;
  }
  return <>{children}</>;
}

/** Applies the route's guards: role gate outside, module gate inside. */
function guardElement(r: RouteDef): ReactNode {
  let el = r.element;
  if (r.module) el = <ModuleGate module={r.module}>{el}</ModuleGate>;
  if (r.roles) el = <RoleGate roles={r.roles}>{el}</RoleGate>;
  return el;
}

export default function App() {
  return (
    <RoleProvider>
      <TenantProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppLayout />}>
              {routeRegistry.map((r) => (
                <Route
                  key={r.path}
                  path={r.path}
                  element={guardElement(r)}
                />
              ))}
              <Route
                path="*"
                element={
                  <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading…</div>}>
                    <NotFound />
                  </Suspense>
                }
              />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
      </TenantProvider>
    </RoleProvider>
  );
}
