/**
 * M8 — Reports center (/reports).
 * Five operational reports with on-screen previews and CSV download:
 * headcount, attendance summary, leave liability, payroll register and a
 * statutory compliance checklist.
 *
 * Role scoping (via useAuth — see src/lib/authContext.tsx):
 *   - Admin / HR → all five reports; only HR can trigger a payroll run from
 *     the register's empty state.
 *   - Manager    → headcount / attendance / leave only, scoped to their own
 *     department; payroll register and compliance are hidden.
 *   - Employee   → no reports (access guard card).
 * Until AuthProvider is wired into App.tsx (integration wave) the page falls
 * back to the pre-auth demo behavior (unrestricted Admin view).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  CalendarCheck,
  Download,
  FileSpreadsheet,
  Play,
  ShieldAlert,
  ShieldCheck,
  Umbrella,
  Users,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { runPayroll } from '@/lib/payrollEngine';
import { useAuth, type AuthContextValue } from '@/lib/authContext';
import type { AuthRole } from '@/lib/auth';
import { cn, monthKey } from '@/lib/utils';
import type {
  AttendanceRecord,
  Department,
  Employee,
  LeaveBalance,
  PayrollRun,
  Payslip,
  Settings,
  Shift,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  buildAttendanceReport,
  buildComplianceReport,
  buildHeadcountReport,
  buildLeaveLiabilityReport,
  buildPayrollRegisterReport,
  type BuiltReport,
} from './reportBuilders';
import { downloadCsv, reportCsv } from './csv';
import ReportPreview from './ReportPreview';

/**
 * useAuth with a fallback for the pre-integration window: AuthProvider is
 * wired into App.tsx in a later wave, so until then useAuth() throws (no
 * provider). Returning null lets the page fall back to the pre-auth demo
 * behavior (unrestricted Admin view).
 */
function useReportsAuth(): AuthContextValue | null {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- useContext inside useAuth always runs before the no-provider throw, so hook order stays stable
    return useAuth();
  } catch {
    return null;
  }
}

type ReportId = 'headcount' | 'attendance' | 'leave' | 'payroll' | 'compliance';

interface ReportMeta {
  id: ReportId;
  title: string;
  description: string;
  icon: LucideIcon;
  needsMonth?: boolean;
}

const REPORT_META: ReportMeta[] = [
  {
    id: 'headcount',
    title: 'Headcount report',
    description: 'Workforce by department, state and employment status.',
    icon: Users,
  },
  {
    id: 'attendance',
    title: 'Attendance summary',
    description: 'Presence, lateness and approved/pending OT totals for a month.',
    icon: CalendarCheck,
    needsMonth: true,
  },
  {
    id: 'leave',
    title: 'Leave liability',
    description: 'Untaken annual leave valued at the ordinary rate of pay.',
    icon: Umbrella,
  },
  {
    id: 'payroll',
    title: 'Payroll register',
    description: 'Full EPF/SOCSO/EIS/PCB/HRD breakdown from payslips.',
    icon: Wallet,
    needsMonth: true,
  },
  {
    id: 'compliance',
    title: 'Statutory compliance',
    description: 'Remittance deadlines, EA form readiness, wage & OT-cap checks.',
    icon: ShieldCheck,
  },
];

export default function ReportsPage() {
  const auth = useReportsAuth();
  /** Pre-integration (no AuthProvider yet) the demo stays unrestricted (Admin). */
  const role: AuthRole | null = auth ? auth.role : 'Admin';
  const isStaffRole = role === 'Admin' || role === 'HR';

  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: attendance } = useCollection<AttendanceRecord>('attendance');
  const { items: shifts } = useCollection<Shift>('shifts');
  const { items: leaveBalances } = useCollection<LeaveBalance>('leaveBalances');
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');
  const { items: settings } = useCollection<Settings>('settings');

  const [selected, setSelected] = useState<ReportId>('headcount');
  const [month, setMonth] = useState(monthKey());
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setReady(true), 250);
    return () => clearTimeout(t);
  }, []);

  /** Data scoping: Admin/HR see everything; Managers their own department only. */
  const scopeEmployees = useMemo(
    () => auth?.scopeEmployees ?? ((list: Employee[]) => list),
    [auth],
  );
  const scopeByEmployee = useMemo(
    () => auth?.scopeByEmployee ?? (<T,>(list: T[], _getEmpId: (item: T) => string): T[] => list),
    [auth],
  );
  const scopedEmployees = useMemo(() => scopeEmployees(employees), [employees, scopeEmployees]);
  const scopedAttendance = useMemo(
    () => scopeByEmployee(attendance, (a) => a.employeeId),
    [attendance, scopeByEmployee],
  );
  const scopedLeaveBalances = useMemo(
    () => scopeByEmployee(leaveBalances, (b) => b.employeeId),
    [leaveBalances, scopeByEmployee],
  );
  const scopedPayslips = useMemo(
    () => scopeByEmployee(payslips, (p) => p.employeeId),
    [payslips, scopeByEmployee],
  );

  /** Payroll register + statutory compliance are Admin/HR-only. */
  const visibleMeta = useMemo(
    () => REPORT_META.filter((m) => (m.id !== 'payroll' && m.id !== 'compliance') || isStaffRole),
    [isStaffRole],
  );

  // Keep the selection valid when the visible set shrinks (e.g. Manager login).
  useEffect(() => {
    if (visibleMeta.length > 0 && !visibleMeta.some((m) => m.id === selected)) {
      setSelected(visibleMeta[0].id);
    }
  }, [visibleMeta, selected]);

  /** Months that carry data, newest first; always includes current + previous. */
  const months = useMemo(() => {
    const set = new Set<string>();
    attendance.forEach((a) => set.add(a.date.slice(0, 7)));
    payslips.forEach((p) => set.add(p.monthKey));
    runs.forEach((r) => set.add(r.monthKey));
    set.add(monthKey());
    const prev = new Date();
    prev.setMonth(prev.getMonth() - 1);
    set.add(monthKey(prev));
    return [...set].sort().reverse();
  }, [attendance, payslips, runs]);

  const buildById = (id: ReportId): BuiltReport => {
    switch (id) {
      case 'attendance':
        return buildAttendanceReport(month, scopedEmployees, departments, scopedAttendance, shifts);
      case 'leave':
        return buildLeaveLiabilityReport(new Date().getFullYear(), scopedEmployees, departments, scopedLeaveBalances);
      case 'payroll':
        return buildPayrollRegisterReport(month, scopedEmployees, departments, scopedPayslips);
      case 'compliance':
        return buildComplianceReport({ employees: scopedEmployees, attendance: scopedAttendance, payslips: scopedPayslips, runs, settings, today: new Date() });
      default:
        return buildHeadcountReport(scopedEmployees, departments);
    }
  };

  const report = useMemo(() => buildById(selected), [
    selected,
    month,
    scopedEmployees,
    departments,
    scopedAttendance,
    shifts,
    scopedLeaveBalances,
    scopedPayslips,
    runs,
    settings,
  ]);

  const meta = visibleMeta.find((m) => m.id === selected) ?? visibleMeta[0];
  // Seed-flash guard: also treat "seed flag absent" as loading so the empty
  // state never flashes while the async demo seed is still landing.
  const seeded =
    typeof localStorage !== 'undefined' && localStorage.getItem('myhrms:seeded:v1') !== null;
  const loading = employees.length === 0 && (!ready || !seeded);

  const handleDownload = (r: BuiltReport) => downloadCsv(r.filename, reportCsv(r));

  const handleRunPayroll = () => {
    setRunning(true);
    try {
      runPayroll(month, undefined, auth?.user?.username ?? 'HR (reports demo)');
    } finally {
      setRunning(false);
    }
  };

  // Employees (and logged-out sessions once auth is wired) get no reports.
  if (role !== 'Admin' && role !== 'HR' && role !== 'Manager') {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        </div>
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldAlert />
            </EmptyMedia>
            <EmptyTitle>No access to reports</EmptyTitle>
            <EmptyDescription>
              Operational reports are available to Admin, HR and Managers only. If you need a
              figure from one of these reports, please contact HR.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  if (employees.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileSpreadsheet />
          </EmptyMedia>
          <EmptyTitle>No data yet</EmptyTitle>
          <EmptyDescription>
            Reports build on the employee register, attendance and payroll data. The demo seed
            should load automatically — if it did not, reseed from Settings.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Operational reports for HR and finance — preview on screen, download as CSV. All
          statutory figures come from <code className="rounded bg-muted px-1 py-0.5 text-xs">src/lib/statutory.ts</code>.
        </p>
        {role === 'Manager' && (
          <p className="text-xs font-medium text-amber-700">
            Scoped to your department — company-wide payroll and compliance reports are
            available to Admin/HR only.
          </p>
        )}
      </div>

      {/* Report cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visibleMeta.map((m) => (
          <Card
            key={m.id}
            className={cn(
              'rounded-xl transition-shadow hover:shadow-md',
              selected === m.id && 'border-amber-500/60 ring-2 ring-amber-500/30',
            )}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                  <m.icon className="h-4 w-4" />
                </span>
                <CardTitle className="text-base">{m.title}</CardTitle>
              </div>
              <CardDescription>{m.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button
                variant={selected === m.id ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelected(m.id)}
              >
                Open report
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Download ${m.title} CSV`}
                onClick={() => handleDownload(buildById(m.id))}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                CSV
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Preview */}
      <Card className="rounded-xl">
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">{report.title}</CardTitle>
              <CardDescription>
                {report.rows.length} row{report.rows.length === 1 ? '' : 's'}
                {meta.needsMonth ? ` · ${month}` : ''}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {meta.needsMonth && (
                <Select value={month} onValueChange={setMonth}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="Month" />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((mk) => (
                      <SelectItem key={mk} value={mk}>
                        {mk}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button size="sm" variant="outline" onClick={() => handleDownload(report)}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {selected === 'payroll' && report.rows.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Wallet />
                </EmptyMedia>
                <EmptyTitle>No payslips for {month}</EmptyTitle>
                <EmptyDescription>
                  {role === 'HR'
                    ? 'The payroll register reads from stored payslips. Run payroll for this month to generate them — the register and the Payroll module update instantly.'
                    : `The payroll register reads from stored payslips. Payroll for ${month} has not been run yet — HR can start the run from the Payroll module.`}
                </EmptyDescription>
              </EmptyHeader>
              {role === 'HR' && (
                <EmptyContent>
                  <Button onClick={handleRunPayroll} disabled={running}>
                    <Play className="mr-1.5 h-4 w-4" />
                    {running ? 'Running payroll…' : `Run payroll for ${month}`}
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          ) : report.rows.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileSpreadsheet />
                </EmptyMedia>
                <EmptyTitle>Nothing to report</EmptyTitle>
                <EmptyDescription>
                  No records match this report for the selected period. Try another month.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ReportPreview report={report} />
          )}
          {report.note && <p className="text-xs text-muted-foreground">{report.note}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
