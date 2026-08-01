/**
 * Server-side payroll engine — a faithful DB-backed port of
 * hrms-web/src/lib/payrollEngine.ts (post-proration version). The calculation
 * pipeline (proration, wage bases, EPF/SOCSO/EIS/PCB/HRD, OT splits, unpaid
 * leave on the same basis, adjustments, YTD/PCB basis, warnings, payslip
 * lines, draft/finalize/undo lifecycle) is intentionally line-for-line
 * identical to the browser engine so both produce the same payslips for the
 * same inputs.
 *
 * ⚠️ SYNC NOTE: when the web payrollEngine changes, mirror the change here.
 * Statutory math lives in ./statutory.ts (sync-calc copy); proration in
 * ./workdays.ts and holidays in ./holidays.ts (manual ports of the web
 * modules — web-only lookups replaced by explicit parameters).
 *
 * Data access: a snapshot of the tenant's collections is loaded from Postgres
 * by the caller (routes/payroll.ts) inside a transaction; this module is pure
 * computation + a changeset, which the route persists.
 */
import {
  calcEPF, calcSOCSO, calcEIS, calcPCB, calcOT, hrdfLevy, annualTax, PCB_RELIEFS,
  hourlyFromMonthly, orpFromMonthly, MINIMUM_WAGE, MAX_OT_HOURS_MONTH,
} from './statutory';
import {
  PRORATION_LABELS, calendarDaysInMonth, prorate,
  unpaidLeaveDaysInMonth, workingDaysInMonth,
} from './workdays';
import { ageFromDob, round2, uid } from './utils';
import type {
  AttendanceRecord, Claim, Employee, Holiday, LeaveRequest, PayrollProrationMethod,
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

/** Everything the engine needs, loaded once for the company. */
export interface PayrollSnapshot {
  employees: Employee[];
  attendance: AttendanceRecord[];
  leaves: LeaveRequest[];
  claims: Claim[];
  payrollRuns: PayrollRun[];
  payslips: Payslip[];
  /** Admin holiday overrides (holidays table rows with isOverride). */
  holidayOverrides: Holiday[];
  /** Company proration method (resolved from companies.config by the route). */
  prorationMethod: PayrollProrationMethod;
}

/** What the caller must persist (inside the same transaction). */
export interface PayrollChangeset {
  run: PayrollRun;
  /** New payslips for targeted employees. */
  payslips: Payslip[];
  /** Ids of THIS month's prior payslips belonging to targeted employees (delete). */
  replacedSlipIds: string[];
  /** Surviving month payslips (non-targeted employees) re-pointed to run.id. */
  survivorSlipIds: string[];
  /** Prior run ids of the month being replaced (delete). */
  priorRunIds: string[];
  /** Claim updates: id → patch. */
  claimPatches: { id: string; status: Claim['status']; paidInRunId: string | null }[];
}

/** YTD statutory totals from stored payslips of the same calendar year, before `month`. */
function ytdFor(snapshot: PayrollSnapshot, employeeId: string, month: string): YtdBasis {
  const year = month.slice(0, 4);
  const slips = snapshot.payslips.filter(
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
  snapshot: PayrollSnapshot;
  month: string;
  monthIndex: number;
  runId: string;
  method: PayrollProrationMethod;
  numLocal: number;
  warnings: string[];
}

function buildCtx(
  snapshot: PayrollSnapshot,
  month: string,
  runId: string,
  method: PayrollProrationMethod,
  warnings: string[],
): PayslipCtx {
  return {
    snapshot,
    month,
    monthIndex: Number(month.split('-')[1]),
    runId,
    method,
    numLocal: snapshot.employees.filter(
      (e) => !e.isForeignWorker && e.status !== 'resigned',
    ).length,
    warnings,
  };
}

/**
 * Compute one employee's payslip for the month. Pure w.r.t. the collections
 * snapshotted in `ctx` — used by computePayrollRun for every employee and by
 * the draft-editor changesets for a single employee.
 */
function computePayslip(emp: Employee, ctx: PayslipCtx, adjustments: PayslipAdjustment[] = []): Payslip {
  const { snapshot, month, monthIndex, method } = ctx;
  const overrides = snapshot.holidayOverrides;
  const age = ageFromDob(emp.dateOfBirth, new Date(`${month}-28T00:00:00`));
  const fixedAllowances = emp.fixedAllowances ?? [];

  // ── Joiner/leaver proration (basic + fixed allowances, same factor) ──
  const basicPr = prorate(emp.baseSalary, emp, month, method, overrides);
  const factor = basicPr.factor;
  const proratedAllowances = fixedAllowances.map((a) => ({
    ...a,
    amount: round2(a.amount * factor),
  }));
  const allowanceTotal = round2(proratedAllowances.reduce((s, a) => s + a.amount, 0));

  // ── Unpaid leave on the SAME basis as the proration method ──
  const unpaidDays = unpaidLeaveDaysInMonth(snapshot.leaves, emp.id, month, emp.state, method, overrides);
  const dailyRate =
    method === 'calendar' ? emp.baseSalary / calendarDaysInMonth(month) :
    method === 'working-days' ? emp.baseSalary / Math.max(1, workingDaysInMonth(month, emp.state, overrides)) :
    orpFromMonthly(emp.baseSalary);
  const unpaidDeduction = round2(unpaidDays * dailyRate);
  const basicPay = round2(Math.max(0, basicPr.amount - unpaidDeduction));

  // ── Approved OT from attendance, split by day type (1.5×/2×/3×) ──
  const otRecords = snapshot.attendance.filter(
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
  // of THIS month stay reimbursable on idempotent re-runs.
  const monthClaims = snapshot.claims.filter(
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
  const recordedYtd = ytdFor(snapshot, emp.id, month);
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
    // Printed YTD: recorded payslips + TP3 carry-in (never the estimate).
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
 * Runs payroll for a month ('YYYY-MM') against a tenant snapshot. Behaviour
 * mirrors hrms-web/src/lib/payrollEngine.ts runPayroll — see that file's
 * docblock for the full contract (eligibility, re-run integrity, survivor
 * re-pointing, claim stamping, whole-month totals, draft mode).
 */
export function computePayrollRun(
  snapshot: PayrollSnapshot,
  month: string,
  employeeIds?: string[],
  runBy = 'system',
  options?: RunPayrollOptions,
): PayrollChangeset {
  const method = snapshot.prorationMethod;
  const eligibilityWarnings: string[] = [];
  const employees = snapshot.employees.filter((e) => {
    if (employeeIds && !employeeIds.includes(e.id)) return false;
    // Joined after the payroll month → not payable for it (QA payroll B13).
    if (e.joinDate.slice(0, 7) > month) {
      eligibilityWarnings.push(
        `${e.name}: joined ${e.joinDate} — after payroll month ${month}; excluded from this run.`,
      );
      return false;
    }
    if (e.status === 'resigned') {
      if (!e.resignDate) {
        eligibilityWarnings.push(
          `${e.name}: status is resigned but no resignation date is on record — included in this run; set the date to stop future runs.`,
        );
        return true;
      }
      return e.resignDate.slice(0, 7) >= month;
    }
    return true; // active + probation
  });
  const { claims } = snapshot;

  // Re-run integrity (QA payroll B1): capture prior runs of the month BEFORE
  // they are replaced.
  const targetIds = new Set(employees.map((e) => e.id));
  const priorRunIds = snapshot.payrollRuns.filter((r) => r.monthKey === month).map((r) => r.id);
  const priorRunIdSet = new Set(priorRunIds);
  const monthSlips = snapshot.payslips.filter((p) => p.monthKey === month);

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

  const ctx = buildCtx(snapshot, month, run.id, method, run.warnings);
  const payslips: Payslip[] = employees.map((emp) => computePayslip(emp, ctx));

  // ── Persist plan: one run per month; non-targeted payslips survive ──
  const replacedSlipIds = monthSlips.filter((p) => targetIds.has(p.employeeId)).map((p) => p.id);
  const survivingSlips = monthSlips.filter((p) => !targetIds.has(p.employeeId));

  // Claims: targeted employees' approved/paid claims are (re)stamped onto the
  // new run; surviving employees' already-paid claims follow their payslip.
  // DRAFT runs do NOT stamp claims paid — that happens on finalize.
  const paidSlipByEmp = new Map(payslips.map((p) => [p.employeeId, p]));
  const survivorEmpIds = new Set(survivingSlips.map((p) => p.employeeId));
  const isDraft = run.status === 'draft';
  const claimPatches: PayrollChangeset['claimPatches'] = [];
  for (const c of claims) {
    if (!c.claimDate.startsWith(month)) continue;
    if (!isDraft && (c.status === 'approved' || c.status === 'paid') && paidSlipByEmp.has(c.employeeId)) {
      if (c.status !== 'paid' || c.paidInRunId !== run.id) {
        claimPatches.push({ id: c.id, status: 'paid', paidInRunId: run.id });
      }
      continue;
    }
    if (
      c.status === 'paid' &&
      survivorEmpIds.has(c.employeeId) &&
      c.paidInRunId !== undefined &&
      priorRunIdSet.has(c.paidInRunId)
    ) {
      claimPatches.push({ id: c.id, status: 'paid', paidInRunId: run.id });
    }
  }

  // Run totals reflect the WHOLE month (new payslips + re-pointed survivors).
  const allMonthSlips = [...survivingSlips, ...payslips];
  run.employeeCount = allMonthSlips.length;
  run.totalGross = round2(allMonthSlips.reduce((s, p) => s + p.grossPay, 0));
  run.totalNet = round2(allMonthSlips.reduce((s, p) => s + p.netPay, 0));
  run.totalEmployerCost = round2(allMonthSlips.reduce((s, p) => s + p.employerCost, 0));
  run.warnings.unshift(...eligibilityWarnings);

  return {
    run,
    payslips,
    replacedSlipIds,
    survivorSlipIds: survivingSlips.map((p) => p.id),
    priorRunIds,
    claimPatches,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft-run editing + finalize + undo (changeset-returning ports)
// ─────────────────────────────────────────────────────────────────────────────

/** Recompute a run's totals from a set of payslips (web: retallyRun). */
export function retallyRun(run: PayrollRun, slips: Payslip[]): PayrollRun {
  return {
    ...run,
    employeeCount: slips.length,
    totalGross: round2(slips.reduce((s, p) => s + p.grossPay, 0)),
    totalNet: round2(slips.reduce((s, p) => s + p.netPay, 0)),
    totalEmployerCost: round2(slips.reduce((s, p) => s + p.employerCost, 0)),
  };
}

export interface PayslipEditChangeset {
  run: PayrollRun;          // retallied
  payslip: Payslip;         // the recomputed slip (existing id preserved)
  removedSlipId?: string;   // set for exclude
}

function draftContext(
  snapshot: PayrollSnapshot,
  run: PayrollRun,
): { emp: (id: string) => Employee | undefined; slip: (id: string) => Payslip | undefined; runSlips: Payslip[] } {
  return {
    emp: (id) => snapshot.employees.find((e) => e.id === id),
    slip: (id) => snapshot.payslips.find((p) => p.runId === run.id && p.employeeId === id),
    runSlips: snapshot.payslips.filter((p) => p.runId === run.id),
  };
}

/**
 * Recompute one employee's payslip inside a draft run with new adjustments
 * (web: setPayslipAdjustments). Returns null when the run is missing /
 * already finalized / doesn't cover the employee.
 */
export function computePayslipAdjustments(
  snapshot: PayrollSnapshot,
  runId: string,
  employeeId: string,
  adjustments: PayslipAdjustment[],
): PayslipEditChangeset | null {
  const run = snapshot.payrollRuns.find((r) => r.id === runId);
  if (!run || run.status !== 'draft') return null;
  const { emp, slip, runSlips } = draftContext(snapshot, run);
  const existing = slip(employeeId);
  const employee = emp(employeeId);
  if (!existing || !employee) return null;
  const ctx = buildCtx(snapshot, run.monthKey, runId, run.prorationMethod ?? snapshot.prorationMethod, []);
  const recomputed = { ...computePayslip(employee, ctx, adjustments), id: existing.id };
  const nextSlips = runSlips.map((p) => (p.id === existing.id ? recomputed : p));
  return { run: retallyRun(run, nextSlips), payslip: recomputed };
}

/** Recompute one employee's payslip from defaults (web: resetPayslipToDefaults). */
export function computePayslipReset(
  snapshot: PayrollSnapshot,
  runId: string,
  employeeId: string,
): PayslipEditChangeset | null {
  return computePayslipAdjustments(snapshot, runId, employeeId, []);
}

/** Remove an employee's payslip from a draft run (web: excludeEmployeeFromRun). */
export function computeExcludeFromRun(
  snapshot: PayrollSnapshot,
  runId: string,
  employeeId: string,
): PayslipEditChangeset | null {
  const run = snapshot.payrollRuns.find((r) => r.id === runId);
  if (!run || run.status !== 'draft') return null;
  const { slip, runSlips } = draftContext(snapshot, run);
  const existing = slip(employeeId);
  if (!existing) return null;
  const nextSlips = runSlips.filter((p) => p.id !== existing.id);
  return { run: retallyRun(run, nextSlips), payslip: existing, removedSlipId: existing.id };
}

export interface FinalizeChangeset {
  run: PayrollRun;
  claimPatches: { id: string; status: Claim['status']; paidInRunId: string }[];
}

/**
 * Finalize a draft run (web: finalizePayrollRun): status → finalized, claims
 * of the run's employees stamped 'paid'. Idempotent — an already-finalized
 * run returns itself with no claim patches.
 */
export function computeFinalizeRun(snapshot: PayrollSnapshot, runId: string): FinalizeChangeset | null {
  const run = snapshot.payrollRuns.find((r) => r.id === runId);
  if (!run) return null;
  if (run.status === 'finalized') return { run, claimPatches: [] };
  const slips = snapshot.payslips.filter((p) => p.runId === runId);
  const empIds = new Set(slips.map((p) => p.employeeId));
  const claimPatches = snapshot.claims
    .filter(
      (c) =>
        c.claimDate.startsWith(run.monthKey) &&
        (c.status === 'approved' || c.status === 'paid') &&
        empIds.has(c.employeeId) &&
        (c.status !== 'paid' || c.paidInRunId !== runId),
    )
    .map((c) => ({ id: c.id, status: 'paid' as const, paidInRunId: runId }));
  const finalized: PayrollRun = { ...run, status: 'finalized', finalizedAt: new Date().toISOString() };
  return { run: finalized, claimPatches };
}

/** What an undo must revert (web: undoPayrollRun). */
export interface UndoPlan {
  runIds: string[];
  payslipIds: string[];
  claimIds: string[];
}

/**
 * Plan the undo of payroll runs — the explicit `runId`, or the latest run for
 * `month`. Payslips of the deleted runs go with them; claims those runs paid
 * return to 'approved' with paidInRunId cleared. YTD/PCB bases recompute
 * naturally from the remaining payslips.
 */
export function planPayrollUndo(
  snapshot: Pick<PayrollSnapshot, 'payrollRuns' | 'payslips' | 'claims'>,
  month: string,
  runId?: string,
): UndoPlan {
  let runIds: string[];
  if (runId) {
    runIds = snapshot.payrollRuns.some((r) => r.id === runId) ? [runId] : [];
  } else {
    const runs = snapshot.payrollRuns
      .filter((r) => r.monthKey === month)
      .sort((a, b) => b.runAt.localeCompare(a.runAt));
    runIds = runs[0] ? [runs[0].id] : [];
  }
  if (runIds.length === 0) return { runIds: [], payslipIds: [], claimIds: [] };
  const runIdSet = new Set(runIds);
  const payslipIds = snapshot.payslips.filter((p) => runIdSet.has(p.runId)).map((p) => p.id);
  const claimIds = snapshot.claims
    .filter((c) => c.status === 'paid' && c.paidInRunId !== undefined && runIdSet.has(c.paidInRunId))
    .map((c) => c.id);
  return { runIds, payslipIds, claimIds };
}
