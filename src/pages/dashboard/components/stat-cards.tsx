/**
 * Row of headline stat cards, role-scoped via useAuth():
 *  - Admin / HR → company-wide: active headcount, present today,
 *    pending approvals (leave + claims + OT) and this month's payroll cost
 *    (finalized run when available, statutory estimate otherwise).
 *  - Manager    → same cards scoped to their own department; the payroll-cost
 *    card is withheld (company spend is Admin/HR-only).
 *  - Employee   → self only: own attendance this month, own annual-leave
 *    balance, own pending claims.
 */
import { CalendarCheck, CalendarDays, ClipboardCheck, Receipt, Users, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { useCollection } from '@/lib/db';
import { fmtRM, monthKey } from '@/lib/utils';
import type {
  AttendanceRecord, Claim, Employee, LeaveBalance, LeaveRequest, PayrollRun,
} from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { estimateMonthlyEmployerCost, todayISO } from '../lib';

interface StatCard {
  title: string;
  value: string;
  hint: string;
  icon: typeof Users;
}

export function StatCards() {
  const { role, employeeId, scopeEmployees, scopeByEmployee } = useAuth();
  const { items: employees } = useCollection<Employee>('employees');
  const { items: attendance } = useCollection<AttendanceRecord>('attendance');
  const { items: leaves } = useCollection<LeaveRequest>('leaves');
  const { items: claims } = useCollection<Claim>('claims');
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');
  const { items: leaveBalances } = useCollection<LeaveBalance>('leaveBalances');

  if (employees.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[7.5rem] rounded-xl" />
        ))}
      </div>
    );
  }

  const today = todayISO();
  const thisMonth = monthKey();

  // ── Employee: self-scoped personal cards ──────────────────────────────────
  if (role === 'Employee') {
    const myAttendance = employeeId
      ? attendance.filter((a) => a.employeeId === employeeId && a.date.startsWith(thisMonth))
      : [];
    const presentDays = myAttendance.filter((a) => a.status === 'present').length;
    const halfDays = myAttendance.filter((a) => a.status === 'half-day').length;
    const leaveDays = myAttendance.filter((a) => a.status === 'leave').length;

    const year = new Date().getFullYear();
    const balance = employeeId
      ? leaveBalances.find((b) => b.employeeId === employeeId && b.year === year)
      : undefined;
    const annualTotal = balance ? balance.annualEntitled + balance.carriedForward : 0;
    const annualLeft = balance ? annualTotal - balance.annualUsed : null;

    const myClaims = employeeId ? claims.filter((c) => c.employeeId === employeeId) : [];
    const myPendingClaims = myClaims.filter((c) => c.status === 'submitted');
    const pendingClaimsAmount = myPendingClaims.reduce((s, c) => s + c.amount, 0);
    const myPendingLeaves = employeeId
      ? leaves.filter((l) => l.employeeId === employeeId && l.status === 'pending').length
      : 0;

    const cards: StatCard[] = [
      {
        title: 'My attendance this month',
        value: String(presentDays + halfDays),
        hint: `${presentDays} present · ${halfDays} half-day · ${leaveDays} on leave`,
        icon: CalendarCheck,
      },
      {
        title: 'My annual leave balance',
        value: annualLeft === null ? '—' : `${annualLeft} days`,
        hint: balance
          ? `${balance.annualUsed} used of ${annualTotal} entitled (${year})`
          : 'No leave balance record yet',
        icon: CalendarDays,
      },
      {
        title: 'My pending claims',
        value: String(myPendingClaims.length),
        hint:
          myPendingClaims.length > 0
            ? `${fmtRM(pendingClaimsAmount)} awaiting approval`
            : myPendingLeaves > 0
              ? `${myPendingLeaves} leave request${myPendingLeaves > 1 ? 's' : ''} pending`
              : 'Nothing awaiting approval',
        icon: Receipt,
      },
    ];

    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Card key={c.title} className="rounded-xl">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
              <c.icon className="h-4 w-4 text-amber-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tracking-tight">{c.value}</div>
              <p className="mt-1 text-xs text-muted-foreground">{c.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  // ── Admin / HR / Manager: workforce cards scoped to the visible employees ──
  const scopedEmployees = scopeEmployees(employees);
  const scopedAttendance = scopeByEmployee(attendance, (a) => a.employeeId);
  const scopedLeaves = scopeByEmployee(leaves, (l) => l.employeeId);
  const scopedClaims = scopeByEmployee(claims, (c) => c.employeeId);

  const active = scopedEmployees.filter((e) => e.status !== 'resigned');
  const activeIds = new Set(active.map((e) => e.id));
  const onProbation = active.filter((e) => e.status === 'probation').length;

  // Present today — joined to active employees so stale records for resigned
  // staff cannot inflate the count (numerator and hint share the same scope).
  const presentToday = new Set(
    scopedAttendance
      .filter(
        (a) =>
          a.date === today && (a.status === 'present' || a.status === 'half-day') &&
          activeIds.has(a.employeeId),
      )
      .map((a) => a.employeeId),
  ).size;

  const pendingLeaves = scopedLeaves.filter((l) => l.status === 'pending').length;
  const pendingClaims = scopedClaims.filter((c) => c.status === 'submitted').length;
  // Pending OT is bounded to the current month and active staff — older
  // unapproved OT is never paid and has no rejection flow to clear it.
  const pendingOt = scopedAttendance.filter(
    (a) =>
      a.otHours > 0 && !a.otApproved && a.date.startsWith(thisMonth) && activeIds.has(a.employeeId),
  ).length;
  const pendingTotal = pendingLeaves + pendingClaims + pendingOt;

  const cards: StatCard[] = [
    {
      title: role === 'Manager' ? 'Team headcount' : 'Active headcount',
      value: String(active.length),
      hint: `${onProbation} on probation · ${scopedEmployees.length - active.length} resigned`,
      icon: Users,
    },
    {
      title: 'Present today',
      value: String(presentToday),
      hint: `of ${active.length} active employees clocked in`,
      icon: CalendarCheck,
    },
    {
      title: 'Pending approvals',
      value: String(pendingTotal),
      hint: `${pendingLeaves} leave · ${pendingClaims} claims · ${pendingOt} OT`,
      icon: ClipboardCheck,
    },
  ];

  // Payroll cost is company spend — Admin/HR only, never shown to Managers.
  if (role === 'Admin' || role === 'HR') {
    const runThisMonth = runs.find((r) => r.monthKey === thisMonth && r.status === 'finalized');
    const draftThisMonth = runs.find((r) => r.monthKey === thisMonth && r.status === 'draft');
    const latestRun = [...runs].sort((a, b) => b.monthKey.localeCompare(a.monthKey))[0];
    const payrollCost = runThisMonth
      ? runThisMonth.totalEmployerCost
      : estimateMonthlyEmployerCost(scopedEmployees);
    const payrollHint = runThisMonth
      ? `Finalized ${thisMonth} run · ${runThisMonth.employeeCount} payslips`
      : draftThisMonth
        ? `Estimate · ${thisMonth} run still in draft`
        : latestRun
          ? `Estimate · last run ${latestRun.monthKey} at ${fmtRM(latestRun.totalEmployerCost)}`
          : 'Estimate from current salaries · no run yet';
    cards.push({
      title: 'Payroll cost this month',
      value: fmtRM(payrollCost),
      hint: payrollHint,
      icon: Wallet,
    });
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.title} className="rounded-xl">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
            <c.icon className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tracking-tight">{c.value}</div>
            <p className="mt-1 text-xs text-muted-foreground">{c.hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
