/**
 * Payroll engine — runs a whole month end-to-end and persists results.
 *
 * Wage-base tagging per scheme (docs/research/statutory-rates.md §6):
 *  - EPF base   = basic (after unpaid-leave) + fixed allowances   (OT & claims excluded)
 *  - SOCSO/EIS  = gross incl. OT                                  (claims excluded)
 *  - HRD levy   = basic (after unpaid-leave) + fixed allowances   (OT/bonus excluded)
 *  - PCB        = annualized on the gross incl. OT                (claims excluded)
 * Claims reimbursements are paid in net but flagged nonStatutory.
 *
 * YTD / PCB basis: stored payslips of the year + the employee's TP3
 * `ytdCarryIn` when present (seeded for the first recorded run of the year);
 * employees who joined before this year with no history get a
 * current-package year-continuity estimate (PCB basis only — never printed);
 * genuine mid-year hires have a true zero YTD.
 */

import { getCollection, setCollection, uid, logAudit } from './db';
import {
  calcEPF, calcSOCSO, calcEIS, calcPCB, calcOT, hrdfLevy, annualTax, PCB_RELIEFS,
  hourlyFromMonthly, orpFromMonthly, MINIMUM_WAGE, MAX_OT_HOURS_MONTH,
} from './statutory';
import { ageFromDob, round2 } from './utils';
import type {
  AttendanceRecord, Claim, Employee, LeaveRequest, PayrollRun, Payslip, PayslipLine, YTDCarryIn,
} from './types';

export interface PayrollResult {
  run: PayrollRun;
  payslips: Payslip[];
}

/** YTD statutory totals shape (recorded payslips, optionally + TP3 carry-in). */
export interface YtdBasis {
  gross: number;
  epf: number;
  socso: number;  // employee SOCSO + EIS
  pcb: number;
  net: number;
  months: number; // recorded payslip months in the basis (carry-in excluded)
}

/** YTD statutory totals from stored payslips of the same calendar year, before `month`. */
export function ytdFor(employeeId: string, month: string): YtdBasis {
  const year = month.slice(0, 4);
  const slips = getCollection<Payslip>('payslips').filter(
    (p) => p.employeeId === employeeId && p.monthKey.startsWith(year) && p.monthKey < month,
  );
  return {
    gross: round2(slips.reduce((s, p) => s + p.grossPay, 0)),
    epf: round2(slips.reduce((s, p) => s + p.epfEmployee, 0)),
    socso: round2(slips.reduce((s, p) => s + p.socsoEmployee + p.eisEmployee, 0)),
    pcb: round2(slips.reduce((s, p) => s + p.pcb, 0)),
    net: round2(slips.reduce((s, p) => s + p.netPay, 0)),
    months: slips.length,
  };
}

export function payslipFor(runId: string, employeeId: string): Payslip | undefined {
  return getCollection<Payslip>('payslips').find((p) => p.runId === runId && p.employeeId === employeeId);
}

/** Latest stored payslip for an employee in a month (any run). */
export function payslipForMonth(employeeId: string, month: string): Payslip | undefined {
  return getCollection<Payslip>('payslips')
    .filter((p) => p.employeeId === employeeId && p.monthKey === month)
    .sort((a, b) => b.id.localeCompare(a.id))[0];
}

/** TP3 carry-in applicable to a calendar year, if the employee has one. */
function carryInForYear(emp: Employee, year: number): YTDCarryIn | undefined {
  const c = emp.ytdCarryIn;
  return c && Number.isFinite(c.year) && c.year === year ? c : undefined;
}

/** Recorded YTD + applicable TP3 carry-in (carry-in never fabricates `months`). */
function withCarryIn(ytd: YtdBasis, carryIn: YTDCarryIn | undefined): YtdBasis {
  if (!carryIn) return ytd;
  return {
    gross: round2(ytd.gross + carryIn.gross),
    epf: round2(ytd.epf + carryIn.epf),
    socso: round2(ytd.socso + carryIn.socso),
    pcb: round2(ytd.pcb + carryIn.pcb),
    net: ytd.net,
    months: ytd.months,
  };
}

/**
 * Year-continuity estimate: with no recorded runs before `monthIndex` and no
 * TP3 carry-in, assume the employee earned the current package since January
 * so the annualized PCB isn't understated mid-year. Applied ONLY to employees
 * who joined before this calendar year — a genuine mid-year hire with no TP3
 * has a true zero YTD and must NOT get the estimate (QA employees C-1).
 */
function estimateYtdBasis(
  emp: Employee,
  monthIndex: number,
  grossPay: number,
  epfEE: number,
  socsoEE: number,
): YtdBasis {
  const m1 = monthIndex - 1;
  const n = 13 - monthIndex;
  const estGross = round2(grossPay * m1);
  const estEpf = round2(epfEE * m1);
  const estSocso = round2(socsoEE * m1);
  const epfRelief = Math.min(estEpf + epfEE * n, PCB_RELIEFS.epfCap);
  const socsoRelief = Math.min(estSocso + socsoEE * n, PCB_RELIEFS.socsoCap);
  const personal =
    PCB_RELIEFS.self +
    (emp.maritalStatus === 'married' ? PCB_RELIEFS.spouse : 0) +
    emp.children * PCB_RELIEFS.child;
  const taxEst = annualTax(Math.max(0, estGross + grossPay * n - epfRelief - socsoRelief - personal));
  return {
    gross: estGross,
    epf: estEpf,
    socso: estSocso,
    pcb: round2((taxEst * m1) / 12),
    net: 0,
    months: m1,
  };
}

/**
 * YTD basis for PCB annualization: recorded payslips of the year, plus the
 * employee's TP3 carry-in when it applies, plus (for employees who joined
 * before this year and have no recorded run yet) the year-continuity estimate
 * derived from their current package — the same basis `runPayroll` uses.
 * Shared with the insights increment simulator so the two can never drift
 * (QA insights B1). Package-based: OT / unpaid-leave / claims of a specific
 * run are not reproducible here.
 */
export function ytdForPcb(employeeId: string, month: string): YtdBasis {
  const recorded = ytdFor(employeeId, month);
  const emp = getCollection<Employee>('employees').find((e) => e.id === employeeId);
  if (!emp) return recorded;
  const year = month.slice(0, 4);
  const monthIndex = Number(month.split('-')[1]);
  const carryIn = carryInForYear(emp, Number(year));
  const base = withCarryIn(recorded, carryIn);
  if (recorded.months > 0 || carryIn || monthIndex <= 1 || emp.joinDate.startsWith(year)) {
    return base;
  }
  const age = ageFromDob(emp.dateOfBirth, new Date(`${month}-28T00:00:00`));
  const allowances = round2((emp.fixedAllowances ?? []).reduce((s, a) => s + a.amount, 0));
  const gross = round2(emp.baseSalary + allowances);
  const epf = calcEPF(gross, age, !emp.isForeignWorker, emp.isForeignWorker);
  const socso = calcSOCSO(gross, age);
  const eis = calcEIS(gross, age, !emp.isForeignWorker);
  return estimateYtdBasis(emp, monthIndex, gross, epf.employee, round2(socso.employee + eis.employee));
}

/** Employee-side EPF rate for the payslip line label (mirrors calcEPF branches). */
function epfEmployeeRateLabel(emp: Employee, age: number): string {
  if (emp.isForeignWorker) return '2%'; // EPF (Amendment) Act 2025 — mandatory from 1 Oct 2025
  if (age >= 60) return '0%';           // Third Schedule s.E (citizen 60+; nil from 75)
  return '11%';
}

/** Employer-side EPF rate for the payslip line label (mirrors calcEPF branches). */
function epfEmployerRateLabel(emp: Employee, age: number, epfWages: number): string {
  if (emp.isForeignWorker) return '2%';
  if (age >= 75) return '0%';
  if (age >= 60) return '4%';
  return epfWages > 5000 ? '12%' : '13%';
}

function overlapDaysInMonth(start: string, end: string, month: string): number {
  const [y, m] = month.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0);
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const from = s > monthStart ? s : monthStart;
  const to = e < monthEnd ? e : monthEnd;
  if (to < from) return 0;
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

/**
 * Runs payroll for a month ('YYYY-MM'). Covers active + probation employees;
 * resigned employees are covered for every month up to and including their
 * resignation month (a missing resignDate keeps them payable, with a warning,
 * so the final month is never silently skipped). Employees joining after the
 * payroll month are excluded, with a warning. Re-running the same month
 * replaces that month's payslips for the targeted employees; payslips of
 * non-targeted employees are re-pointed to the new run so `payslip.runId`
 * never dangles and the month's totals stay full-coverage.
 */
export function runPayroll(month: string, employeeIds?: string[], runBy = 'system'): PayrollResult {
  const monthIndex = Number(month.split('-')[1]);
  const eligibilityWarnings: string[] = [];
  const employees = getCollection<Employee>('employees').filter((e) => {
    if (employeeIds && !employeeIds.includes(e.id)) return false;
    // Joined after the payroll month → not payable for it (QA payroll B13).
    if (e.joinDate.slice(0, 7) > month) {
      eligibilityWarnings.push(
        `${e.name}: joined ${e.joinDate} — after payroll month ${month}; excluded from this run.`,
      );
      return false;
    }
    if (e.status === 'resigned') {
      // No resignDate on record: the final month is unknowable, so keep the
      // employee payable (with a loud warning) until HR sets the date
      // (QA employees H-1 — final-month pay must never vanish silently).
      if (!e.resignDate) {
        eligibilityWarnings.push(
          `${e.name}: status is resigned but no resignation date is on record — included in this run; set the date to stop future runs.`,
        );
        return true;
      }
      // Employed during any month up to and including the resignation month.
      return e.resignDate.slice(0, 7) >= month;
    }
    return true; // active + probation
  });
  const attendance = getCollection<AttendanceRecord>('attendance');
  const leaves = getCollection<LeaveRequest>('leaves');
  const claims = getCollection<Claim>('claims');
  const numLocal = getCollection<Employee>('employees').filter(
    (e) => !e.isForeignWorker && e.status !== 'resigned',
  ).length;

  // Re-run integrity (QA payroll B1): capture prior runs of the month BEFORE
  // they are replaced. Non-targeted employees' month payslips survive and are
  // re-pointed to the new run id below, so payslip.runId never dangles.
  const targetIds = new Set(employees.map((e) => e.id));
  const priorRunIds = new Set(
    getCollection<PayrollRun>('payrollRuns')
      .filter((r) => r.monthKey === month)
      .map((r) => r.id),
  );
  const allSlips = getCollection<Payslip>('payslips');
  const otherMonthSlips = allSlips.filter((p) => p.monthKey !== month);

  const run: PayrollRun = {
    id: uid(),
    monthKey: month,
    status: 'finalized',
    runAt: new Date().toISOString(),
    runBy,
    employeeCount: 0,
    totalGross: 0,
    totalNet: 0,
    totalEmployerCost: 0,
    warnings: [],
  };

  const payslips: Payslip[] = employees.map((emp) => {
    const age = ageFromDob(emp.dateOfBirth, new Date(`${month}-28T00:00:00`));
    const fixedAllowances = emp.fixedAllowances ?? [];
    const allowanceTotal = round2(fixedAllowances.reduce((s, a) => s + a.amount, 0));

    // ── Unpaid leave proration (deducted at ORP = monthly ÷ 26) ──
    const unpaidDays = leaves
      .filter((l) => l.employeeId === emp.id && l.type === 'unpaid' && l.status === 'approved')
      .reduce((s, l) => s + overlapDaysInMonth(l.startDate, l.endDate, month), 0);
    const unpaidDeduction = round2(unpaidDays * orpFromMonthly(emp.baseSalary));
    const basicPay = round2(Math.max(0, emp.baseSalary - unpaidDeduction));

    // ── Approved OT from attendance, split by day type (1.5×/2×/3×) ──
    const otRecords = attendance.filter(
      (a) => a.employeeId === emp.id && a.date.startsWith(month) && a.otApproved && a.otHours > 0,
    );
    const otHours = round2(otRecords.reduce((s, a) => s + a.otHours, 0));
    const hrp = hourlyFromMonthly(emp.baseSalary);
    const otBy = (t: 'normal' | 'rest' | 'holiday') =>
      round2(otRecords.filter((a) => a.otDayType === t).reduce((s, a) => s + calcOT(hrp, a.otHours, t), 0));
    const otNormal = otBy('normal');
    const otRest = otBy('rest');
    const otHoliday = otBy('holiday');
    const otPay = round2(otNormal + otRest + otHoliday);

    // ── Approved claims in the month → non-statutory reimbursement ──
    // Include status 'paid' too: claims already reimbursed by an earlier run
    // of THIS month stay reimbursable on idempotent re-runs (the superseded
    // run is deleted below, so they must roll into the replacement payslip).
    const monthClaims = claims.filter(
      (c) => c.employeeId === emp.id && (c.status === 'approved' || c.status === 'paid') && c.claimDate.startsWith(month),
    );
    const claimsTotal = round2(monthClaims.reduce((s, c) => s + c.amount, 0));

    // ── Statutory bases ──
    const grossPay = round2(basicPay + allowanceTotal + otPay);
    const epfWages = round2(basicPay + allowanceTotal); // OT excluded from EPF (s.2 EPF Act)
    const epf = calcEPF(epfWages, age, !emp.isForeignWorker, emp.isForeignWorker);
    const socso = calcSOCSO(grossPay, age);
    const eis = calcEIS(grossPay, age, !emp.isForeignWorker);
    // ── YTD basis for PCB annualization ──
    // Recorded payslips + TP3 carry-in (real prior-employer figures — QA
    // employees C-1). The year-continuity estimate applies ONLY when there is
    // no carry-in AND the employee joined before this calendar year; a genuine
    // mid-year hire (joinDate in this year, no TP3) has a true zero YTD.
    const recordedYtd = ytdFor(emp.id, month);
    const carryIn = carryInForYear(emp, Number(month.slice(0, 4)));
    const ytdBase = withCarryIn(recordedYtd, carryIn);
    let pcbBasis = ytdBase;
    if (
      recordedYtd.months === 0 &&
      !carryIn &&
      monthIndex > 1 &&
      !emp.joinDate.startsWith(month.slice(0, 4))
    ) {
      pcbBasis = estimateYtdBasis(
        emp, monthIndex, grossPay, epf.employee, round2(socso.employee + eis.employee),
      );
    }
    const pcb = calcPCB(grossPay, pcbBasis, {
      marital: emp.maritalStatus,
      children: emp.children,
      monthIndex,
      epfEmployee: epf.employee,
      socsoEmployee: round2(socso.employee + eis.employee),
    });
    const hrd = hrdfLevy(round2(basicPay + allowanceTotal), numLocal);

    const netPay = round2(grossPay - epf.employee - socso.employee - eis.employee - pcb + claimsTotal);
    const employerCost = round2(grossPay + epf.employer + socso.employer + eis.employer + hrd + claimsTotal);

    // ── Compliance warnings ──
    if (emp.employmentType === 'full-time' && emp.baseSalary < MINIMUM_WAGE) {
      run.warnings.push(
        `${emp.name}: basic ${emp.baseSalary.toFixed(2)} below minimum wage RM${MINIMUM_WAGE} (MWO 2024)`,
      );
    }
    if (otHours > MAX_OT_HOURS_MONTH) {
      run.warnings.push(
        `${emp.name}: OT ${otHours}h exceeds ${MAX_OT_HOURS_MONTH}h/month cap (OT Regulations 1980)`,
      );
    }

    // ── Itemized payslip lines (EA 1955 — itemized payslips mandatory) ──
    const lines: PayslipLine[] = [
      { label: 'Basic salary', amount: round2(emp.baseSalary), kind: 'earning' },
      ...fixedAllowances.map((a) => ({ label: `Allowance — ${a.name}`, amount: round2(a.amount), kind: 'earning' as const })),
      ...(unpaidDeduction > 0
        ? [{ label: `Unpaid leave (${unpaidDays}d)`, amount: -unpaidDeduction, kind: 'deduction' as const }]
        : []),
      ...(otNormal > 0 ? [{ label: 'OT — normal day (1.5×)', amount: otNormal, kind: 'earning' as const }] : []),
      ...(otRest > 0 ? [{ label: 'OT — rest day (2.0×)', amount: otRest, kind: 'earning' as const }] : []),
      ...(otHoliday > 0 ? [{ label: 'OT — public holiday (3.0×)', amount: otHoliday, kind: 'earning' as const }] : []),
      { label: `EPF employee (${epfEmployeeRateLabel(emp, age)})`, amount: -epf.employee, kind: 'deduction' },
      { label: 'SOCSO employee', amount: -socso.employee, kind: 'deduction' },
      { label: 'EIS employee', amount: -eis.employee, kind: 'deduction' },
      { label: 'PCB / MTD', amount: -pcb, kind: 'deduction' },
      ...monthClaims.map((c) => ({
        label: `Claim — ${c.title}`,
        amount: round2(c.amount),
        kind: 'earning' as const,
        nonStatutory: true,
      })),
      { label: `EPF employer (${epfEmployerRateLabel(emp, age, epfWages)})`, amount: epf.employer, kind: 'employer' },
      { label: 'SOCSO employer', amount: socso.employer, kind: 'employer' },
      { label: 'EIS employer', amount: eis.employer, kind: 'employer' },
      { label: 'HRD Corp levy', amount: hrd, kind: 'employer' },
    ];

    return {
      id: uid(),
      runId: run.id,
      employeeId: emp.id,
      monthKey: month,
      basicPay,
      unpaidLeaveDeduction: unpaidDeduction,
      otPay,
      otHours,
      allowances: allowanceTotal,
      claimsTotal,
      grossPay,
      epfEmployee: epf.employee,
      epfEmployer: epf.employer,
      socsoEmployee: socso.employee,
      socsoEmployer: socso.employer,
      socsoCategory: socso.category,
      eisEmployee: eis.employee,
      eisEmployer: eis.employer,
      pcb,
      hrdLevy: hrd,
      netPay,
      employerCost,
      lines,
      // Printed YTD: recorded payslips + TP3 carry-in (never the estimate —
      // estimated figures are a PCB basis, not employee-facing facts).
      ytd: {
        gross: round2(ytdBase.gross + grossPay),
        epf: round2(ytdBase.epf + epf.employee),
        socso: round2(ytdBase.socso + socso.employee + eis.employee),
        pcb: round2(ytdBase.pcb + pcb),
        net: round2(ytdBase.net + netPay),
      },
    };
  });

  // ── Persist: one run per month; non-targeted payslips survive on the new run ──
  const keptRuns = getCollection<PayrollRun>('payrollRuns').filter((r) => r.monthKey !== month);
  // Payslips of employees NOT targeted by this (partial) re-run survive and
  // are re-pointed to the new run id — payslip.runId never dangles (B1).
  const survivingSlips = allSlips
    .filter((p) => p.monthKey === month && !targetIds.has(p.employeeId))
    .map((p) => ({ ...p, runId: run.id }));
  setCollection('payslips', [...otherMonthSlips, ...survivingSlips, ...payslips]);

  // Claims: targeted employees' approved/paid claims are (re)stamped onto the
  // new run; surviving employees' already-paid claims follow their payslip so
  // paidInRunId never points at a deleted run either. Only written when changed.
  const paidSlipByEmp = new Map(payslips.map((p) => [p.employeeId, p]));
  const survivorEmpIds = new Set(survivingSlips.map((p) => p.employeeId));
  const nextClaims = claims.map((c) => {
    if (!c.claimDate.startsWith(month)) return c;
    if ((c.status === 'approved' || c.status === 'paid') && paidSlipByEmp.has(c.employeeId)) {
      return { ...c, status: 'paid' as const, paidInRunId: run.id };
    }
    if (
      c.status === 'paid' &&
      survivorEmpIds.has(c.employeeId) &&
      c.paidInRunId !== undefined &&
      priorRunIds.has(c.paidInRunId)
    ) {
      return { ...c, paidInRunId: run.id };
    }
    return c;
  });
  if (nextClaims.some((c, i) => c !== claims[i])) setCollection('claims', nextClaims);

  // Run totals reflect the WHOLE month (new payslips + re-pointed survivors),
  // so run history / giro / statutory exports never silently under-report
  // after a partial re-run.
  const monthSlips = [...survivingSlips, ...payslips];
  run.employeeCount = monthSlips.length;
  run.totalGross = round2(monthSlips.reduce((s, p) => s + p.grossPay, 0));
  run.totalNet = round2(monthSlips.reduce((s, p) => s + p.netPay, 0));
  run.totalEmployerCost = round2(monthSlips.reduce((s, p) => s + p.employerCost, 0));
  run.warnings.unshift(...eligibilityWarnings);
  setCollection('payrollRuns', [...keptRuns, run]);

  logAudit({
    actorName: runBy,
    action: 'payroll.run',
    entity: 'payrollRuns',
    entityId: run.id,
    detail: `${month}: ${run.employeeCount} payslips, net ${run.totalNet.toFixed(2)}`,
  });

  return { run, payslips };
}
