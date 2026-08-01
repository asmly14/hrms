/**
 * Payroll engine — runs a whole month end-to-end and persists results.
 *
 * Wage-base tagging per scheme (docs/research/statutory-rates.md §6):
 *  - EPF base   = basic (after proration + unpaid-leave) + fixed allowances   (OT & claims excluded)
 *  - SOCSO/EIS  = gross incl. OT + ad-hoc earning adjustments               (claims excluded)
 *  - HRD levy   = basic (after proration + unpaid-leave) + fixed allowances   (OT/bonus excluded)
 *  - PCB        = annualized on the gross; ad-hoc earning adjustments are
 *                 taxed as additional remuneration (LHDN bonus mechanism)
 * Claims reimbursements are paid in net but flagged nonStatutory.
 *
 * Proration (lib/workdays.ts): mid-month joiners/leavers get prorated basic +
 * fixed allowances, and unpaid leave is deducted on the SAME basis — the
 * active company's config.payrollProration ('calendar' | 'working-days' |
 * 'fixed-26', default 'calendar'). Statutory contributions are computed on
 * the prorated wages actually paid (EPF Third Schedule applies to wages paid).
 * Every payslip records daysWorked / daysInBasis / prorationMethod / factor
 * for payslip transparency; the run records the method too.
 *
 * Run lifecycle: a run is created 'draft' (wizard review step — per-employee
 * adjustments, exclusions and resets allowed) or 'finalized'. Only finalized
 * runs stamp claims as paid and feed statutory exports/giro (UI-gated).
 * `undoPayrollRun` deletes a run + its payslips and reverts its paid claims
 * back to approved; YTD recomputes naturally from the remaining payslips.
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
import {
  PRORATION_LABELS, calendarDaysInMonth, prorate, resolveProrationMethod,
  unpaidLeaveDaysInMonth, workingDaysInMonth,
} from './workdays';
import { ageFromDob, round2 } from './utils';
import type {
  AttendanceRecord, Claim, Employee, LeaveRequest, PayrollProrationMethod,
  PayrollRun, Payslip, PayslipAdjustment, PayslipLine, YTDCarryIn,
} from './types';

export interface PayrollResult {
  run: PayrollRun;
  payslips: Payslip[];
}

export interface RunPayrollOptions {
  /** Create the run as an editable draft instead of finalized (claims are
   *  only stamped 'paid' when the draft is finalized). */
  draft?: boolean;
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

/** Display label for an ad-hoc adjustment line. */
export function adjustmentLabel(a: PayslipAdjustment): string {
  const preset =
    a.preset === 'cp38' ? 'CP38' :
    a.preset === 'zakat' ? 'Zakat' :
    a.preset === 'ptptn' ? 'PTPTN' : null;
  return preset ? `${preset} — ${a.label}` : a.label;
}

/** Per-run computation context shared by full runs and single-payslip edits. */
interface PayslipCtx {
  month: string;
  monthIndex: number;
  runId: string;
  method: PayrollProrationMethod;
  attendance: AttendanceRecord[];
  leaves: LeaveRequest[];
  claims: Claim[];
  numLocal: number;
  warnings: string[];
}

function buildCtx(month: string, runId: string, method: PayrollProrationMethod, warnings: string[]): PayslipCtx {
  return {
    month,
    monthIndex: Number(month.split('-')[1]),
    runId,
    method,
    attendance: getCollection<AttendanceRecord>('attendance'),
    leaves: getCollection<LeaveRequest>('leaves'),
    claims: getCollection<Claim>('claims'),
    numLocal: getCollection<Employee>('employees').filter(
      (e) => !e.isForeignWorker && e.status !== 'resigned',
    ).length,
    warnings,
  };
}

/**
 * Compute one employee's payslip for the month. Pure w.r.t. the collections
 * snapshotted in `ctx` (plus stored prior-month payslips for YTD/PCB) — used
 * by runPayroll for every employee and by the draft editor (adjust / reset)
 * for a single employee.
 */
function computePayslip(emp: Employee, ctx: PayslipCtx, adjustments: PayslipAdjustment[] = []): Payslip {
  const { month, monthIndex, method } = ctx;
  const age = ageFromDob(emp.dateOfBirth, new Date(`${month}-28T00:00:00`));
  const fixedAllowances = emp.fixedAllowances ?? [];

  // ── Joiner/leaver proration (basic + fixed allowances, same factor) ──
  const basicPr = prorate(emp.baseSalary, emp, month, method);
  const factor = basicPr.factor;
  const proratedAllowances = fixedAllowances.map((a) => ({
    ...a,
    amount: round2(a.amount * factor),
  }));
  const allowanceTotal = round2(proratedAllowances.reduce((s, a) => s + a.amount, 0));

  // ── Unpaid leave on the SAME basis as the proration method ──
  const unpaidDays = unpaidLeaveDaysInMonth(ctx.leaves, emp.id, month, emp.state, method);
  const dailyRate =
    method === 'calendar' ? emp.baseSalary / calendarDaysInMonth(month) :
    method === 'working-days' ? emp.baseSalary / Math.max(1, workingDaysInMonth(month, emp.state)) :
    orpFromMonthly(emp.baseSalary);
  const unpaidDeduction = round2(unpaidDays * dailyRate);
  const basicPay = round2(Math.max(0, basicPr.amount - unpaidDeduction));

  // ── Approved OT from attendance, split by day type (1.5×/2×/3×) ──
  const otRecords = ctx.attendance.filter(
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
  const monthClaims = ctx.claims.filter(
    (c) => c.employeeId === emp.id && (c.status === 'approved' || c.status === 'paid') && c.claimDate.startsWith(month),
  );
  const claimsTotal = round2(monthClaims.reduce((s, c) => s + c.amount, 0));

  // ── Ad-hoc editor adjustments (draft runs) ──
  // Earnings join the gross (SOCSO/EIS base + PCB additional remuneration);
  // deductions reduce net pay only. Neither touches the EPF/HRD base.
  const cleanAdjustments = adjustments.filter((a) => Number.isFinite(a.amount) && a.amount > 0);
  const adjustmentEarnings = round2(
    cleanAdjustments.filter((a) => a.kind === 'earning').reduce((s, a) => s + a.amount, 0),
  );
  const adjustmentDeductions = round2(
    cleanAdjustments.filter((a) => a.kind === 'deduction').reduce((s, a) => s + a.amount, 0),
  );

  // ── Statutory bases (computed on the prorated wages actually paid) ──
  const grossPay = round2(basicPay + allowanceTotal + otPay + adjustmentEarnings);
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
    // Ad-hoc earning adjustments are additional remuneration (LHDN bonus
    // mechanism): taxed via the aggregate delta, in full, this month.
    bonus: adjustmentEarnings > 0 ? adjustmentEarnings : undefined,
    epfEmployee: epf.employee,
    socsoEmployee: round2(socso.employee + eis.employee),
  });
  const hrd = hrdfLevy(round2(basicPay + allowanceTotal), ctx.numLocal);

  const netPay = round2(
    grossPay - epf.employee - socso.employee - eis.employee - pcb - adjustmentDeductions + claimsTotal,
  );
  const employerCost = round2(grossPay + epf.employer + socso.employer + eis.employer + hrd + claimsTotal);

  // ── Compliance warnings ──
  if (emp.employmentType === 'full-time' && emp.baseSalary < MINIMUM_WAGE) {
    ctx.warnings.push(
      `${emp.name}: basic ${emp.baseSalary.toFixed(2)} below minimum wage RM${MINIMUM_WAGE} (MWO 2024)`,
    );
  }
  if (otHours > MAX_OT_HOURS_MONTH) {
    ctx.warnings.push(
      `${emp.name}: OT ${otHours}h exceeds ${MAX_OT_HOURS_MONTH}h/month cap (OT Regulations 1980)`,
    );
  }

  // ── Itemized payslip lines (EA 1955 — itemized payslips mandatory) ──
  const basisLabel = PRORATION_LABELS[method];
  const lines: PayslipLine[] = [
    {
      label: `Days worked: ${basicPr.daysWorked} / ${basicPr.daysInBasis} (${basisLabel})`,
      amount: 0,
      kind: 'info',
    },
    { label: 'Basic salary', amount: round2(emp.baseSalary * factor), kind: 'earning' },
    ...(factor < 1
      ? [{
          label: `Proration — ${basicPr.daysWorked}/${basicPr.daysInBasis} ${basisLabel} × ${round2(factor * 100) / 100}`,
          amount: 0,
          kind: 'info' as const,
        }]
      : []),
    ...proratedAllowances.map((a) => ({ label: `Allowance — ${a.name}`, amount: round2(a.amount), kind: 'earning' as const })),
    ...(unpaidDeduction > 0
      ? [{ label: `Unpaid leave (${unpaidDays}d)`, amount: -unpaidDeduction, kind: 'deduction' as const }]
      : []),
    ...(otNormal > 0 ? [{ label: 'OT — normal day (1.5×)', amount: otNormal, kind: 'earning' as const }] : []),
    ...(otRest > 0 ? [{ label: 'OT — rest day (2.0×)', amount: otRest, kind: 'earning' as const }] : []),
    ...(otHoliday > 0 ? [{ label: 'OT — public holiday (3.0×)', amount: otHoliday, kind: 'earning' as const }] : []),
    ...cleanAdjustments.map((a) => ({
      label: adjustmentLabel(a),
      amount: a.kind === 'earning' ? round2(a.amount) : -round2(a.amount),
      kind: a.kind,
    })),
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
    runId: ctx.runId,
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
    daysWorked: basicPr.daysWorked,
    daysInBasis: basicPr.daysInBasis,
    prorationMethod: method,
    prorationFactor: factor,
    adjustments: cleanAdjustments,
    adjustmentEarnings,
    adjustmentDeductions,
  };
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
 *
 * Pass `{ draft: true }` to create an editable draft run (kakitangan-style
 * review step): claims are NOT stamped paid until `finalizePayrollRun`.
 */
export function runPayroll(
  month: string,
  employeeIds?: string[],
  runBy = 'system',
  options?: RunPayrollOptions,
): PayrollResult {
  const method = resolveProrationMethod();
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
  const claims = getCollection<Claim>('claims');

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
    status: options?.draft ? 'draft' : 'finalized',
    runAt: new Date().toISOString(),
    runBy,
    employeeCount: 0,
    totalGross: 0,
    totalNet: 0,
    totalEmployerCost: 0,
    warnings: [],
    prorationMethod: method,
  };

  const ctx = buildCtx(month, run.id, method, run.warnings);
  const payslips: Payslip[] = employees.map((emp) => computePayslip(emp, ctx));

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
  // paidInRunId never points at a deleted run either. DRAFT runs do NOT stamp
  // claims paid — that happens on finalize (QA: draft must be side-effect
  // free so undo/adjust cycles never strand a claim). Only written when changed.
  const paidSlipByEmp = new Map(payslips.map((p) => [p.employeeId, p]));
  const survivorEmpIds = new Set(survivingSlips.map((p) => p.employeeId));
  const isDraft = run.status === 'draft';
  const nextClaims = claims.map((c) => {
    if (!c.claimDate.startsWith(month)) return c;
    if (!isDraft && (c.status === 'approved' || c.status === 'paid') && paidSlipByEmp.has(c.employeeId)) {
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
    action: run.status === 'draft' ? 'payroll.draft' : 'payroll.run',
    entity: 'payrollRuns',
    entityId: run.id,
    detail: `${month}: ${run.employeeCount} payslips, net ${run.totalNet.toFixed(2)} (${run.status}, proration: ${PRORATION_LABELS[method]})`,
  });

  return { run, payslips };
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft-run editing (kakitangan-style per-employee review) + finalize + undo
// ─────────────────────────────────────────────────────────────────────────────

function findRun(runId: string): PayrollRun | undefined {
  return getCollection<PayrollRun>('payrollRuns').find((r) => r.id === runId);
}

/** Recompute a run's totals from its stored payslips and persist the run. */
function retallyRun(run: PayrollRun): PayrollRun {
  const slips = getCollection<Payslip>('payslips').filter((p) => p.runId === run.id);
  const next: PayrollRun = {
    ...run,
    employeeCount: slips.length,
    totalGross: round2(slips.reduce((s, p) => s + p.grossPay, 0)),
    totalNet: round2(slips.reduce((s, p) => s + p.netPay, 0)),
    totalEmployerCost: round2(slips.reduce((s, p) => s + p.employerCost, 0)),
  };
  setCollection(
    'payrollRuns',
    getCollection<PayrollRun>('payrollRuns').map((r) => (r.id === run.id ? next : r)),
  );
  return next;
}

/** Replace one payslip inside a draft run and retally. Returns the new slip. */
function replacePayslip(run: PayrollRun, slip: Payslip): Payslip {
  setCollection(
    'payslips',
    getCollection<Payslip>('payslips').map((p) => (p.id === slip.id ? slip : p)),
  );
  retallyRun(run);
  return slip;
}

/**
 * Recompute one employee's payslip inside a draft run, replacing their ad-hoc
 * adjustments (CP38 / Zakat / PTPTN / custom earnings & deductions). Returns
 * the recomputed payslip, or null when the run is missing / already finalized
 * / doesn't cover the employee.
 */
export function setPayslipAdjustments(
  runId: string,
  employeeId: string,
  adjustments: PayslipAdjustment[],
  actor = 'system',
): Payslip | null {
  const run = findRun(runId);
  if (!run || run.status !== 'draft') return null;
  const existing = payslipFor(runId, employeeId);
  const emp = getCollection<Employee>('employees').find((e) => e.id === employeeId);
  if (!existing || !emp) return null;
  const ctx = buildCtx(run.monthKey, runId, run.prorationMethod ?? resolveProrationMethod(), []);
  const recomputed = computePayslip(emp, ctx, adjustments);
  const slip = replacePayslip(run, { ...recomputed, id: existing.id });
  logAudit({
    actorName: actor,
    action: 'payroll.payslip.adjust',
    entity: 'payslips',
    entityId: slip.id,
    detail: `${run.monthKey} ${emp.name}: ${adjustments.length} adjustment(s), net ${slip.netPay.toFixed(2)}`,
  });
  return slip;
}

/**
 * Recompute one employee's payslip from defaults, dropping every ad-hoc
 * adjustment ('Reset employee' in the editor). Draft runs only.
 */
export function resetPayslipToDefaults(
  runId: string,
  employeeId: string,
  actor = 'system',
): Payslip | null {
  const run = findRun(runId);
  if (!run || run.status !== 'draft') return null;
  const existing = payslipFor(runId, employeeId);
  const emp = getCollection<Employee>('employees').find((e) => e.id === employeeId);
  if (!existing || !emp) return null;
  const ctx = buildCtx(run.monthKey, runId, run.prorationMethod ?? resolveProrationMethod(), []);
  const recomputed = computePayslip(emp, ctx, []);
  const slip = replacePayslip(run, { ...recomputed, id: existing.id });
  logAudit({
    actorName: actor,
    action: 'payroll.payslip.reset',
    entity: 'payslips',
    entityId: slip.id,
    detail: `${run.monthKey} ${emp.name}: reset to defaults, net ${slip.netPay.toFixed(2)}`,
  });
  return slip;
}

/**
 * Exclude an employee from a draft run ('exclude from run' toggle): their
 * payslip is removed and the run retallied. Draft runs only. Returns false
 * when the run is missing/finalized or the employee isn't in it.
 */
export function excludeEmployeeFromRun(runId: string, employeeId: string, actor = 'system'): boolean {
  const run = findRun(runId);
  if (!run || run.status !== 'draft') return false;
  const existing = payslipFor(runId, employeeId);
  if (!existing) return false;
  setCollection(
    'payslips',
    getCollection<Payslip>('payslips').filter((p) => p.id !== existing.id),
  );
  retallyRun(run);
  logAudit({
    actorName: actor,
    action: 'payroll.payslip.exclude',
    entity: 'payrollRuns',
    entityId: runId,
    detail: `${run.monthKey}: excluded employee ${employeeId} from the draft run`,
  });
  return true;
}

/**
 * Finalize a draft run: status draft → finalized, claims of the run's
 * employees are stamped 'paid' against this run, and the run is locked
 * (statutory exports / giro are UI-gated to finalized runs). Idempotent:
 * finalizing an already-finalized run is a no-op returning the run.
 */
export function finalizePayrollRun(runId: string, runBy = 'system'): PayrollRun | null {
  const run = findRun(runId);
  if (!run) return null;
  if (run.status === 'finalized') return run;
  const slips = getCollection<Payslip>('payslips').filter((p) => p.runId === runId);
  const empIds = new Set(slips.map((p) => p.employeeId));
  const claims = getCollection<Claim>('claims');
  const nextClaims = claims.map((c) =>
    c.claimDate.startsWith(run.monthKey) &&
    (c.status === 'approved' || c.status === 'paid') &&
    empIds.has(c.employeeId)
      ? { ...c, status: 'paid' as const, paidInRunId: runId }
      : c,
  );
  if (nextClaims.some((c, i) => c !== claims[i])) setCollection('claims', nextClaims);
  const finalized: PayrollRun = { ...run, status: 'finalized', finalizedAt: new Date().toISOString() };
  setCollection(
    'payrollRuns',
    getCollection<PayrollRun>('payrollRuns').map((r) => (r.id === runId ? finalized : r)),
  );
  logAudit({
    actorName: runBy,
    action: 'payroll.finalize',
    entity: 'payrollRuns',
    entityId: runId,
    detail: `${run.monthKey}: finalized ${slips.length} payslips, net ${run.totalNet.toFixed(2)}`,
  });
  return finalized;
}

/**
 * Undo a payroll run: deletes the run and ALL its payslips, reverts claims it
 * paid back to 'approved' (clearing paidInRunId), and audits the action.
 * YTD / PCB bases recompute naturally from the remaining payslips, and an
 * idempotent re-run of the same month reproduces identical payslip figures.
 * Returns false when the run doesn't exist.
 */
export function undoPayrollRun(runId: string, runBy = 'system'): boolean {
  const run = findRun(runId);
  if (!run) return false;
  const slips = getCollection<Payslip>('payslips');
  const removed = slips.filter((p) => p.runId === runId);
  setCollection('payslips', slips.filter((p) => p.runId !== runId));
  setCollection(
    'payrollRuns',
    getCollection<PayrollRun>('payrollRuns').filter((r) => r.id !== runId),
  );
  const claims = getCollection<Claim>('claims');
  const nextClaims = claims.map((c) =>
    c.status === 'paid' && c.paidInRunId === runId
      ? { ...c, status: 'approved' as const, paidInRunId: undefined }
      : c,
  );
  if (nextClaims.some((c, i) => c !== claims[i])) setCollection('claims', nextClaims);
  logAudit({
    actorName: runBy,
    action: 'payroll.undo',
    entity: 'payrollRuns',
    entityId: runId,
    detail: `${run.monthKey}: undid run — ${removed.length} payslip(s) deleted, paid claims reverted to approved`,
  });
  return true;
}
