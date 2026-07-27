/**
 * M8 — Report builders. Pure functions that turn collection data into
 * column/row structures for on-screen preview and CSV export.
 *
 * Every statutory figure (OT rates, minimum wage, OT cap, ORP divisor) comes
 * from @/lib/statutory — nothing is hardcoded here.
 */
import {
  MAX_OT_HOURS_MONTH,
  MINIMUM_WAGE,
  calcOT,
  hourlyFromMonthly,
  orpFromMonthly,
} from '@/lib/statutory';
import { daysBetween, fmtDate, fmtRM, round2 } from '@/lib/utils';
import { stateInfo } from '@/lib/holidays';
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

export type ReportRow = Record<string, string | number>;

export interface ReportColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  format?: 'text' | 'money' | 'number';
  decimals?: number;
}

export interface BuiltReport {
  id: string;
  title: string;
  filename: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totalRow?: ReportRow;
  note?: string;
  /** Column key whose values are Pass / Review / Action required (rendered as badges). */
  statusKey?: string;
}

const deptNameOf = (departments: Department[], e: Employee | undefined): string =>
  e ? departments.find((d) => d.id === e.departmentId)?.name ?? '—' : '—';

// ─────────────────────────────────────────────────────────────────────────────
// 1) Headcount report — by department / state / status
// ─────────────────────────────────────────────────────────────────────────────

export function buildHeadcountReport(employees: Employee[], departments: Department[]): BuiltReport {
  const total = employees.length;
  const share = (n: number) => (total > 0 ? round2((n / total) * 100) : 0);
  const rows: ReportRow[] = [];

  departments
    .map((d) => ({ d, n: employees.filter((e) => e.departmentId === d.id).length }))
    .sort((a, b) => b.n - a.n)
    .forEach(({ d, n }) => {
      rows.push({ section: 'Department', category: `${d.name} (${d.code})`, headcount: n, sharePct: share(n) });
    });

  const byState = new Map<string, number>();
  employees.forEach((e) => byState.set(e.state, (byState.get(e.state) ?? 0) + 1));
  [...byState.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([code, n]) => {
      rows.push({ section: 'State', category: stateInfo(code as Employee['state']).name, headcount: n, sharePct: share(n) });
    });

  (['active', 'probation', 'resigned'] as const).forEach((status) => {
    const n = employees.filter((e) => e.status === status).length;
    rows.push({
      section: 'Status',
      category: status.charAt(0).toUpperCase() + status.slice(1),
      headcount: n,
      sharePct: share(n),
    });
  });

  return {
    id: 'headcount',
    title: 'Headcount report',
    filename: `headcount-report-${new Date().toISOString().slice(0, 10)}.csv`,
    columns: [
      { key: 'section', label: 'Section' },
      { key: 'category', label: 'Category' },
      { key: 'headcount', label: 'Headcount', align: 'right', format: 'number' },
      { key: 'sharePct', label: 'Share %', align: 'right', format: 'number', decimals: 1 },
    ],
    rows,
    totalRow: { section: '', category: 'All employees', headcount: total, sharePct: 100 },
    note: 'Snapshot of the current employee register, including resigned staff under Status.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Attendance summary — presence, lateness, OT for a month
// ─────────────────────────────────────────────────────────────────────────────

export function buildAttendanceReport(
  month: string,
  employees: Employee[],
  departments: Department[],
  attendance: AttendanceRecord[],
  shifts: Shift[],
): BuiltReport {
  const empById = new Map(employees.map((e) => [e.id, e]));
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const byEmp = new Map<string, AttendanceRecord[]>();
  attendance
    .filter((a) => a.date.startsWith(month))
    .forEach((r) => {
      const arr = byEmp.get(r.employeeId) ?? [];
      arr.push(r);
      byEmp.set(r.employeeId, arr);
    });

  interface Acc {
    present: number;
    late: number;
    absent: number;
    leave: number;
    rest: number;
    otApproved: number;
    otPending: number;
    otPay: number;
  }
  const zero = (): Acc => ({ present: 0, late: 0, absent: 0, leave: 0, rest: 0, otApproved: 0, otPending: 0, otPay: 0 });
  const totals = zero();
  const rows: ReportRow[] = [];

  const entries = [...byEmp.entries()].sort((a, b) => {
    const ea = empById.get(a[0]);
    const eb = empById.get(b[0]);
    return `${deptNameOf(departments, ea)}|${ea?.name ?? ''}`.localeCompare(
      `${deptNameOf(departments, eb)}|${eb?.name ?? ''}`,
    );
  });

  for (const [empId, recs] of entries) {
    const emp = empById.get(empId);
    const acc = zero();
    for (const r of recs) {
      if (r.status === 'present') acc.present += 1;
      else if (r.status === 'half-day') acc.present += 0.5;
      else if (r.status === 'absent') acc.absent += 1;
      else if (r.status === 'leave') acc.leave += 1;
      else acc.rest += 1; // rest-day / holiday

      if (r.status === 'present' && r.clockIn && r.shiftId) {
        const start = shiftById.get(r.shiftId)?.startTime;
        if (start && r.clockIn > start) acc.late += 1;
      }
      if (r.otHours > 0) {
        if (r.otApproved) {
          acc.otApproved = round2(acc.otApproved + r.otHours);
          if (emp) acc.otPay = round2(acc.otPay + calcOT(hourlyFromMonthly(emp.baseSalary), r.otHours, r.otDayType));
        } else {
          acc.otPending = round2(acc.otPending + r.otHours);
        }
      }
    }
    (Object.keys(totals) as (keyof Acc)[]).forEach((k) => {
      totals[k] = round2(totals[k] + acc[k]);
    });
    rows.push({
      employee: emp?.name ?? empId,
      department: deptNameOf(departments, emp),
      present: acc.present,
      late: acc.late,
      absent: acc.absent,
      leaveDays: acc.leave,
      restDays: acc.rest,
      otApproved: acc.otApproved,
      otPending: acc.otPending,
      otPay: acc.otPay,
    });
  }

  return {
    id: 'attendance',
    title: 'Attendance summary',
    filename: `attendance-summary-${month}.csv`,
    columns: [
      { key: 'employee', label: 'Employee' },
      { key: 'department', label: 'Department' },
      { key: 'present', label: 'Present', align: 'right', format: 'number', decimals: 1 },
      { key: 'late', label: 'Late', align: 'right', format: 'number' },
      { key: 'absent', label: 'Absent', align: 'right', format: 'number' },
      { key: 'leaveDays', label: 'Leave', align: 'right', format: 'number' },
      { key: 'restDays', label: 'Rest/PH', align: 'right', format: 'number' },
      { key: 'otApproved', label: 'OT hrs (approved)', align: 'right', format: 'number', decimals: 1 },
      { key: 'otPending', label: 'OT hrs (pending)', align: 'right', format: 'number', decimals: 1 },
      { key: 'otPay', label: 'OT pay (approved)', align: 'right', format: 'money' },
    ],
    rows,
    totalRow: {
      employee: `TOTAL (${rows.length} employees)`,
      department: '',
      present: totals.present,
      late: totals.late,
      absent: totals.absent,
      leaveDays: totals.leave,
      restDays: totals.rest,
      otApproved: totals.otApproved,
      otPending: totals.otPending,
      otPay: totals.otPay,
    },
    note: `Late = clock-in after shift start. OT pay uses EA 1955 multipliers (1.5× / 2× / 3×) on the hourly rate of approved OT only.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Leave liability — untaken annual leave × ordinary rate of pay
// ─────────────────────────────────────────────────────────────────────────────

export function buildLeaveLiabilityReport(
  year: number,
  employees: Employee[],
  departments: Department[],
  leaveBalances: LeaveBalance[],
): BuiltReport {
  const rows: ReportRow[] = [];
  let totalBalance = 0;
  let totalLiability = 0;

  employees
    .filter((e) => e.status !== 'resigned')
    .forEach((e) => {
      const bal = leaveBalances.find((b) => b.employeeId === e.id && b.year === year);
      if (!bal) return;
      const balance = Math.max(0, bal.annualEntitled + bal.carriedForward - bal.annualUsed);
      const dailyRate = round2(orpFromMonthly(e.baseSalary));
      const liability = round2(balance * dailyRate);
      totalBalance = round2(totalBalance + balance);
      totalLiability = round2(totalLiability + liability);
      rows.push({
        employee: e.name,
        department: deptNameOf(departments, e),
        entitled: bal.annualEntitled,
        carried: bal.carriedForward,
        used: bal.annualUsed,
        balance,
        dailyRate,
        liability,
      });
    });

  return {
    id: 'leave',
    title: 'Leave liability',
    filename: `leave-liability-${year}.csv`,
    columns: [
      { key: 'employee', label: 'Employee' },
      { key: 'department', label: 'Department' },
      { key: 'entitled', label: 'Entitled', align: 'right', format: 'number' },
      { key: 'carried', label: 'Carried fwd', align: 'right', format: 'number' },
      { key: 'used', label: 'Used', align: 'right', format: 'number' },
      { key: 'balance', label: 'Balance', align: 'right', format: 'number' },
      { key: 'dailyRate', label: 'Daily rate (ORP)', align: 'right', format: 'money' },
      { key: 'liability', label: 'Liability', align: 'right', format: 'money' },
    ],
    rows,
    totalRow: {
      employee: `TOTAL (${rows.length} employees)`,
      department: '',
      entitled: '',
      carried: '',
      used: '',
      balance: totalBalance,
      dailyRate: '',
      liability: totalLiability,
    },
    note: `Untaken annual leave for ${year} valued at the ordinary rate of pay (monthly wages ÷ 26, EA 1955 s.60I(a)) — the provision a finance team books for leave encashment exposure.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Payroll register — statutory breakdown from payslips
// ─────────────────────────────────────────────────────────────────────────────

export function buildPayrollRegisterReport(
  month: string,
  employees: Employee[],
  departments: Department[],
  payslips: Payslip[],
): BuiltReport {
  const empById = new Map(employees.map((e) => [e.id, e]));
  const slips = payslips
    .filter((p) => p.monthKey === month)
    .sort((a, b) => {
      const ea = empById.get(a.employeeId);
      const eb = empById.get(b.employeeId);
      return `${deptNameOf(departments, ea)}|${ea?.name ?? ''}`.localeCompare(
        `${deptNameOf(departments, eb)}|${eb?.name ?? ''}`,
      );
    });

  const sum = (f: (p: Payslip) => number) => round2(slips.reduce((s, p) => s + f(p), 0));

  return {
    id: 'payroll',
    title: 'Payroll register',
    filename: `payroll-register-${month}.csv`,
    columns: [
      { key: 'employee', label: 'Employee' },
      { key: 'department', label: 'Department' },
      { key: 'gross', label: 'Gross', align: 'right', format: 'money' },
      { key: 'epfEE', label: 'EPF ee', align: 'right', format: 'money' },
      { key: 'epfER', label: 'EPF er', align: 'right', format: 'money' },
      { key: 'socsoEE', label: 'SOCSO ee', align: 'right', format: 'money' },
      { key: 'socsoER', label: 'SOCSO er', align: 'right', format: 'money' },
      { key: 'eisEE', label: 'EIS ee', align: 'right', format: 'money' },
      { key: 'eisER', label: 'EIS er', align: 'right', format: 'money' },
      { key: 'pcb', label: 'PCB', align: 'right', format: 'money' },
      { key: 'hrd', label: 'HRD levy', align: 'right', format: 'money' },
      { key: 'net', label: 'Net pay', align: 'right', format: 'money' },
      { key: 'cost', label: 'Employer cost', align: 'right', format: 'money' },
    ],
    rows: slips.map((p) => {
      const emp = empById.get(p.employeeId);
      return {
        employee: emp?.name ?? p.employeeId,
        department: deptNameOf(departments, emp),
        gross: p.grossPay,
        epfEE: p.epfEmployee,
        epfER: p.epfEmployer,
        socsoEE: p.socsoEmployee,
        socsoER: p.socsoEmployer,
        eisEE: p.eisEmployee,
        eisER: p.eisEmployer,
        pcb: p.pcb,
        hrd: p.hrdLevy,
        net: p.netPay,
        cost: p.employerCost,
      };
    }),
    totalRow: {
      employee: `TOTAL (${slips.length} payslips)`,
      department: '',
      gross: sum((p) => p.grossPay),
      epfEE: sum((p) => p.epfEmployee),
      epfER: sum((p) => p.epfEmployer),
      socsoEE: sum((p) => p.socsoEmployee),
      socsoER: sum((p) => p.socsoEmployer),
      eisEE: sum((p) => p.eisEmployee),
      eisER: sum((p) => p.eisEmployer),
      pcb: sum((p) => p.pcb),
      hrd: sum((p) => p.hrdLevy),
      net: sum((p) => p.netPay),
      cost: sum((p) => p.employerCost),
    },
    note: `All payslips on record for ${month}. ee = employee share, er = employer share. Amounts are exactly what the payroll engine computed from src/lib/statutory.ts.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) Statutory compliance checklist
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplianceInput {
  employees: Employee[];
  attendance: AttendanceRecord[];
  payslips: Payslip[];
  runs: PayrollRun[];
  settings: Settings[];
  today: Date;
}

export function buildComplianceReport(input: ComplianceInput): BuiltReport {
  const { employees, attendance, payslips, runs, settings, today } = input;
  const active = employees.filter((e) => e.status !== 'resigned');
  const rows: ReportRow[] = [];

  // ── EPF/SOCSO/EIS/PCB/HRD remitted by the 15th of the following month ──
  // A remittance obligation only exists once the payroll run for that wage
  // month is FINALIZED — until then the row stays 'Not due'. Receipts are not
  // tracked, so a finalized run whose deadline is still ahead reads 'Pending'
  // (never 'Pass'); only an overdue deadline escalates to 'Action required'.
  const runMonths: string[] = [];
  [...runs]
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
    .forEach((r) => {
      if (!runMonths.includes(r.monthKey)) runMonths.push(r.monthKey);
    });
  if (runMonths.length === 0) {
    rows.push({
      check: 'Statutory remittance (EPF · SOCSO · EIS · PCB · HRD)',
      status: 'Not due',
      detail:
        'No payroll run on record yet. After the first run is finalized, all five statutory contributions must reach the respective bodies by the 15th of the following month.',
    });
  }
  runMonths.slice(0, 3).forEach((mk) => {
    const finalized = runs.some((r) => r.monthKey === mk && r.status === 'finalized');
    if (!finalized) {
      rows.push({
        check: `Remittance for ${mk} (EPF · SOCSO · EIS · PCB · HRD)`,
        status: 'Not due',
        detail: `The payroll run for ${mk} has not been finalized yet — the remittance obligation (due by the 15th of the following month) starts once the run is finalized.`,
      });
      return;
    }
    const [y, m] = mk.split('-').map(Number);
    const due = new Date(y, m, 15); // 15th of the month after the wage month
    const daysLeft = daysBetween(today, due);
    const slips = payslips.filter((p) => p.monthKey === mk);
    const sum = (f: (p: Payslip) => number) => round2(slips.reduce((s, p) => s + f(p), 0));
    const amounts =
      `EPF ${fmtRM(sum((p) => p.epfEmployee + p.epfEmployer))} · ` +
      `SOCSO ${fmtRM(sum((p) => p.socsoEmployee + p.socsoEmployer))} · ` +
      `EIS ${fmtRM(sum((p) => p.eisEmployee + p.eisEmployer))} · ` +
      `PCB ${fmtRM(sum((p) => p.pcb))} · HRD ${fmtRM(sum((p) => p.hrdLevy))}`;
    rows.push({
      check: `Remittance for ${mk} (EPF · SOCSO · EIS · PCB · HRD)`,
      status: daysLeft >= 0 ? 'Pending' : 'Action required',
      detail:
        daysLeft >= 0
          ? `Due ${fmtDate(due)} — ${daysLeft} day(s) left; remit and file receipts (receipts are not tracked in this demo). Amounts to remit: ${amounts}.`
          : `Due date ${fmtDate(due)} has passed — remit immediately and verify all five contributions were received (receipts are not tracked in this demo). ${amounts}.`,
    });
  });

  // ── Minimum wage (MWO 2024) ──
  const underpaid = active.filter((e) => e.employmentType === 'full-time' && e.baseSalary < MINIMUM_WAGE);
  rows.push({
    check: `Minimum wage ${fmtRM(MINIMUM_WAGE)}/month`,
    status: underpaid.length === 0 ? 'Pass' : 'Action required',
    detail:
      underpaid.length === 0
        ? 'All full-time employees meet the national minimum wage (Minimum Wages Order 2024).'
        : `${underpaid.length} full-time employee(s) below minimum wage: ${underpaid.map((e) => e.name).join(', ')}.`,
  });

  // ── Monthly OT cap (Employment (Limitation of Overtime Work) Regulations 1980) ──
  const otByEmpMonth = new Map<string, number>();
  attendance.forEach((a) => {
    if (a.otHours > 0) {
      const k = `${a.employeeId}|${a.date.slice(0, 7)}`;
      otByEmpMonth.set(k, round2((otByEmpMonth.get(k) ?? 0) + a.otHours));
    }
  });
  const otViolations = [...otByEmpMonth.entries()].filter(([, h]) => h > MAX_OT_HOURS_MONTH);
  if (otViolations.length === 0) {
    rows.push({
      check: `Overtime cap (${MAX_OT_HOURS_MONTH}h/month)`,
      status: 'Pass',
      detail: 'No employee exceeded the monthly overtime limit in the attendance records.',
    });
  } else {
    otViolations.forEach(([k, h]) => {
      const [empId, month] = k.split('|');
      const name = employees.find((e) => e.id === empId)?.name ?? empId;
      rows.push({
        check: `Overtime cap (${MAX_OT_HOURS_MONTH}h/month)`,
        status: 'Action required',
        detail: `${name} logged ${h}h OT in ${month} — over the regulatory cap; spread OT or seek an exemption.`,
      });
    });
  }

  // ── Missing statutory numbers ──
  const missing = active
    .map((e) => {
      const gaps: string[] = [];
      if (!e.epfNo) gaps.push(e.isForeignWorker ? 'EPF no. (mandatory for foreign workers from 1 Oct 2025)' : 'EPF no.');
      if (!e.socsoNo) gaps.push('SOCSO no.');
      if (!e.taxNo) gaps.push('income tax no.');
      return gaps.length > 0 ? { name: e.name, gaps } : null;
    })
    .filter((x): x is { name: string; gaps: string[] } => x !== null);
  if (missing.length === 0) {
    rows.push({
      check: 'Statutory reference numbers',
      status: 'Pass',
      detail: 'Every employee has EPF, SOCSO and income-tax reference numbers on file.',
    });
  } else {
    missing.forEach((m) => {
      rows.push({
        check: 'Statutory reference numbers',
        status: 'Action required',
        detail: `${m.name} — missing: ${m.gaps.join(', ')}.`,
      });
    });
  }

  // ── EA form readiness (annual wage statement, due end-Feb after the YA) ──
  const year = today.getFullYear();
  const noTax = active.filter((e) => !e.taxNo);
  rows.push({
    check: `EA form readiness ${year} — employee tax numbers`,
    status: noTax.length === 0 ? 'Pass' : 'Action required',
    detail:
      noTax.length === 0
        ? 'All employees have income-tax numbers for EA form preparation.'
        : `${noTax.length} employee(s) without a tax number: ${noTax.map((e) => e.name).join(', ')}.`,
  });
  const co = settings[0];
  rows.push({
    check: 'EA form readiness — employer E-number',
    status: co?.taxEmployerNo ? 'Pass' : 'Action required',
    detail: co?.taxEmployerNo
      ? `Employer tax reference on file: ${co.taxEmployerNo}.`
      : 'Employer E-number is blank — set it under Settings → Company.',
  });
  const monthsOnFile = new Set(
    payslips.filter((p) => p.monthKey.startsWith(String(year))).map((p) => p.monthKey),
  );
  // Mid-year the checklist should measure payroll timeliness, not a full 12/12:
  // expected = months elapsed this year minus the current (usually not yet run)
  // wage month. The EA deadline itself stays end-February after the YA.
  const elapsed = today.getMonth() + 1;
  const expectedMonths = Math.min(12, Math.max(0, elapsed - 1));
  rows.push({
    check: `EA form readiness — payroll coverage ${year}`,
    status: monthsOnFile.size >= expectedMonths ? 'Pass' : 'Review',
    detail: `${monthsOnFile.size}/${expectedMonths} months of payslips on record for ${year} (year-to-date). EA forms are due to employees by the last day of February following the year of assessment.`,
  });

  return {
    id: 'compliance',
    title: 'Statutory compliance checklist',
    filename: `statutory-compliance-${today.toISOString().slice(0, 10)}.csv`,
    columns: [
      { key: 'check', label: 'Check' },
      { key: 'status', label: 'Status' },
      { key: 'detail', label: 'Detail' },
    ],
    rows,
    statusKey: 'status',
    note: 'Advisory checklist computed from payroll runs, attendance and the employee register. Remittance receipts are not tracked in this demo — verify against EPF/SOCSO/EIS/LHDN/HRD Corp portals.',
  };
}
