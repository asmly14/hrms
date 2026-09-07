/**
 * Router root. All module routes are wired here by the integration agent,
 * following the route map in docs/architecture.md. The shell
 * (sidebar/topbar) wraps everything via the layout route.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AppWindow, type LucideIcon } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { useEffectiveRole } from '@/components/layout/useEffectiveRole';
import { useDarkClass } from '@/components/layout/useDarkClass';
import { Toaster } from '@/components/ui/sonner';
import { RoleProvider, type AppRole } from '@/lib/roleContext';
import { AuthProvider } from '@/lib/authContext';
import { useAuth } from '@/lib/useAuth';
import { TenantProvider } from '@/lib/tenantContext';
import { useTenant } from '@/lib/useTenant';
import type { ModuleKey } from '@/lib/types';
import LoginPage from '@/pages/login/LoginPage';
import { isModuleEnabled, MODULE_DEFS } from '@/pages/company/modules';

// Route-level code-splitting: every page is a lazy chunk so first paint only
// downloads the shell + the route being opened. Each element is wrapped in
// <Suspense> by guardElement() below (innermost, so a failed role/module gate
// never triggers the page chunk download).
const DashboardPage = lazy(() => import('@/pages/dashboard'));
const EmployeesPage = lazy(() => import('@/pages/employees/EmployeesPage'));
const EmployeeDetailPage = lazy(() => import('@/pages/employees/EmployeeDetailPage'));
const AttendancePage = lazy(() => import('@/pages/attendance/AttendancePage'));
const ShiftsPage = lazy(() => import('@/pages/attendance/ShiftsPage'));
const LeavePage = lazy(() => import('@/pages/leave/LeavePage'));
const HolidaysPage = lazy(() => import('@/pages/holidays/HolidaysPage'));
const ClaimsPage = lazy(() => import('@/pages/claims/ClaimsPage'));
const ApprovalsPage = lazy(() => import('@/pages/approvals/ApprovalsPage'));
const PayrollHome = lazy(() => import('@/pages/payroll/PayrollHome'));
const RunDetail = lazy(() => import('@/pages/payroll/RunDetail'));
const PayslipPage = lazy(() => import('@/pages/payroll/PayslipPage'));
const MyPayslipsPage = lazy(() => import('@/pages/payroll/MyPayslipsPage'));
const YearEndPack = lazy(() => import('@/pages/payroll/YearEndPack'));
const BatchPayslips = lazy(() => import('@/pages/payroll/BatchPayslips'));
const KpiPage = lazy(() => import('@/pages/kpi'));
const ReviewCycle = lazy(() => import('@/pages/kpi/ReviewCycle'));
const SalaryInsightsPage = lazy(() => import('@/pages/insights/SalaryInsightsPage'));
const ReportsPage = lazy(() => import('@/pages/reports/ReportsPage'));
const SalaryReportPage = lazy(() => import('@/pages/reports/SalaryReportPage'));
const SettingsPage = lazy(() => import('@/pages/settings/SettingsPage'));
const OnboardingPage = lazy(() => import('@/pages/onboarding/OnboardingPage'));
const OffboardingPage = lazy(() => import('@/pages/offboarding/OffboardingPage'));
const SuperAdminPage = lazy(() => import('@/pages/superadmin/SuperAdminPage'));
const OrgPage = lazy(() => import('@/pages/org/OrgPage'));
const OrgChartPage = lazy(() => import('@/pages/org/OrgChartPage'));
const CompanyPage = lazy(() => import('@/pages/company/CompanyPage'));
// These three live behind named re-exports in their module meta.ts files.
const ContractsPage = lazy(() =>
  import('@/pages/contracts/meta').then((m) => ({ default: m.ContractsPage })),
);
const EmployeeRecordsPage = lazy(() =>
  import('@/pages/employees/records/meta').then((m) => ({ default: m.EmployeeRecordsPage })),
);
const OnboardFormPage = lazy(() =>
  import('@/pages/onboard/meta').then((m) => ({ default: m.OnboardFormPage })),
);
const LoansPage = lazy(() =>
  import('@/pages/loans/meta').then((m) => ({ default: m.LoansPage })),
);
const NotFound = lazy(() => import('@/pages/NotFound'));

/** Shared suspense fallback for lazy route pages. */
const routeFallback = (
  <div className="p-8 text-sm text-muted-foreground">Loading…</div>
);

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
 * (Module-private — App.tsx is a component module for fast refresh.)
 */
const routeRegistry: RouteDef[] = [
  { path: '/', title: 'Dashboard', element: <DashboardPage /> },
  // Unified approvals inbox — no role gate on purpose: nav hides it from
  // Employees, but a direct visit shows them their own pending requests
  // (read-only); approver roles get the full decision queues. Spans the
  // leave/claims/attendance modules, so no single-module gate either.
  { path: '/approvals', title: 'Approvals', element: <ApprovalsPage /> },
  { path: '/employees', title: 'Employees', element: <EmployeesPage />, roles: ['Admin', 'HR'] },
  { path: '/employees/:id', title: 'Employee Detail', element: <EmployeeDetailPage /> },
  // All roles may open the route — the records page self-gates (Employee →
  // redirect to own detail, Manager → read-only own department, salary tab
  // and print-outs Admin/HR only).
  { path: '/employees/:id/records', title: 'Employee Records', element: <EmployeeRecordsPage /> },
  // Contracts is not a toggleable module (no ModuleKey in enabledModules) —
  // always-on for Admin/HR.
  { path: '/contracts', title: 'Contracts', element: <ContractsPage />, roles: ['Admin', 'HR'] },
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
  { path: '/payroll/year-end', title: 'Year-End Pack', element: <YearEndPack />, roles: ['Admin', 'HR'], module: 'payroll' },
  { path: '/payroll/batch-payslips', title: 'Batch Payslips', element: <BatchPayslips />, roles: ['Admin', 'HR'], module: 'payroll' },
  // Employee self-service: own payslips only (page filters by the session's
  // linked employeeId, finalized runs). Open to every authenticated role.
  { path: '/my-payslips', title: 'My Payslips', element: <MyPayslipsPage />, module: 'payroll' },
  // Loans & Benefits — Admin/HR get the full registry; other roles get a
  // read-only view scoped to their own records (page self-gates), so the
  // route is intentionally not role-gated (linked from the records page).
  { path: '/loans', title: 'Loans & Benefits', element: <LoansPage />, module: 'payroll' },
  { path: '/kpi', title: 'KPI & Performance', element: <KpiPage />, roles: ['Admin', 'HR', 'Manager'], module: 'kpi' },
  { path: '/kpi/reviews/:id', title: 'Review Cycle', element: <ReviewCycle />, module: 'kpi' },
  { path: '/insights/salary', title: 'Salary Insights', element: <SalaryInsightsPage />, roles: ['Admin', 'HR'], module: 'insights' },
  { path: '/reports', title: 'Reports', element: <ReportsPage />, roles: ['Admin', 'HR', 'Manager'], module: 'reports' },
  // Multi-period salary analysis — Admin/HR only (payroll-grade figures).
  { path: '/reports/salary', title: 'Salary Report', element: <SalaryReportPage />, roles: ['Admin', 'HR'], module: 'reports' },
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
  // Suspense is innermost: role/module gates run first and can redirect
  // without ever downloading the lazy page chunk.
  let el = <Suspense fallback={routeFallback}>{r.element}</Suspense>;
  if (r.module) el = <ModuleGate module={r.module}>{el}</ModuleGate>;
  if (r.roles) el = <RoleGate roles={r.roles}>{el}</RoleGate>;
  return el;
}

export default function App() {
  // Theme-aware toasts: the app uses its own dark-class strategy (AppLayout
  // toggles `dark` on <html>); next-themes is not wired up, so follow the class.
  const dark = useDarkClass();
  return (
    <RoleProvider>
      <TenantProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {/* Public applicant onboarding form — resolves company/branding from
              the invite token itself; must stay OUTSIDE RequireAuth. */}
          <Route
            path="/onboard/:token"
            element={
              <Suspense fallback={routeFallback}>
                <OnboardFormPage />
              </Suspense>
            }
          />
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
                  <Suspense fallback={routeFallback}>
                    <NotFound />
                  </Suspense>
                }
              />
            </Route>
          </Route>
        </Routes>
        {/* App-wide toast host (sonner) — pages fire via @/lib/toast. */}
        <Toaster position="top-right" closeButton theme={dark ? 'dark' : 'light'} />
      </AuthProvider>
      </TenantProvider>
    </RoleProvider>
  );
}
