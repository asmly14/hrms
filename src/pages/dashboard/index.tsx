/**
 * HRMS home dashboard (route '/').
 *
 * Composes: headline stat cards → quick actions → analytics charts →
 * compliance/holiday/alert widgets. Every figure is derived from
 * useCollection plus the shared lib engines (statutory, holidays,
 * payroll) — no rate or date is hardcoded in this module.
 *
 * Role gating (via useAuth):
 *  - Admin / HR → full company dashboard.
 *  - Manager    → department-scoped cards/charts and alerts; payroll-cost
 *                 widgets (StatCards payroll card, PayrollTrend) withheld.
 *  - Employee   → personal view only: own attendance/leave/claims cards,
 *                 self quick actions, holidays and the statutory calendar.
 *                 No org charts, no payroll figures, no alerts naming others.
 */
import { useAuth } from '@/lib/authContext';
import { fmtDate } from '@/lib/utils';
import { StatCards } from './components/stat-cards';
import { QuickActions } from './components/quick-actions';
import { AttendanceRate, ClaimsDonut, HeadcountByDepartment, PayrollTrend } from './components/charts';
import { ComplianceDeadlines } from './components/compliance-deadlines';
import { UpcomingHolidays } from './components/upcoming-holidays';
import { AlertsPanel } from './components/alerts-panel';
import { todayISO } from './lib';

export default function DashboardPage() {
  const { role } = useAuth();
  const isEmployee = role === 'Employee';
  // Company payroll spend is Admin/HR-only — Managers never see it.
  const canSeePayroll = role === 'Admin' || role === 'HR';

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {isEmployee
            ? `Your attendance, leave and claims at a glance · ${fmtDate(todayISO())}`
            : `Workforce, payroll and statutory compliance at a glance · ${fmtDate(todayISO())}`}
        </p>
      </div>

      <StatCards />
      <QuickActions />

      {!isEmployee && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <HeadcountByDepartment />
          {canSeePayroll && <PayrollTrend />}
          <AttendanceRate />
          <ClaimsDonut />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ComplianceDeadlines />
        <UpcomingHolidays />
        {!isEmployee && <AlertsPanel />}
      </div>
    </div>
  );
}
