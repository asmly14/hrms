/**
 * Payroll engine — runs a whole month end-to-end and persists results.
 *
 * Salary types (Employee.salaryType, per-run override in the draft editor):
 *  - monthly — fixed monthly salary; mid-month joiner/leaver proration and
 *    unpaid-leave deduction per the company's proration method (below).
 *  - daily   — dailyRate × worked days counted from attendance in the run's
 *    cut-off window (fallback rate baseSalary ÷ 26, EA 1955 s.60I).
 *  - hourly  — hourlyRate × worked base hours counted from attendance in the
 *    window (fallback baseSalary ÷ 26 ÷ 8). Approved OT hours are NOT base
 *    hours — they pay separately through the OT mechanism (never double-paid).
 *  Attendance counting rule: status 'present' = 1 day / standardDailyHours;
 *  'half-day' = 0.5 day / half the standard hours; a 'rest-day' or 'holiday'
 *  record carrying approved OT = 1 worked day (0 base hours — its OT hours
 *  pay via OT); 'absent'/'leave' = 0. Daily/hourly employees get no separate
 *  unpaid-leave deduction — unworked days are simply unpaid.
 *  A payslip-level `basicOverride` ('Full amount') replaces the computed
 *  basic outright for that run (audit-logged, shown as overridden).
 *
 * Wage-base tagging per scheme (docs/research/statutory-rates.md §6):
 *  - EPF base   = basic (after proration + unpaid-leave) + fixed allowances
 *                 + adjustment earning lines TAGGED epf                    (OT excluded)
 *  - SOCSO/EIS  = gross incl. OT + ad-hoc earning adjustments               (claims excluded)
 *                 — tagged lines join only when their socso/eis tag is on
 *  - HRD levy   = basic (after proration + unpaid-leave) + fixed allowances   (OT/bonus excluded)
 *  - PCB        = annualized on the normal-remuneration base (basic + fixed
 *                 allowances + OT + pcb-tagged normal lines + non-cash BIK);
 *                 additional remuneration (bonus/commission/director fees and
 *                 legacy untagged lines) is taxed via the LHDN aggregate
 *                 (bonus) mechanism, in full, this month.
 *  Backward compatibility: UNTAGGED earning lines keep the legacy behaviour —
 *  SOCSO/EIS bases ✓, EPF base ✗, PCB via the bonus mechanism with the legacy
 *  gross-inclusive annualization (unchanged figures for pre-tag payslips).
 * Claims reimbursements are paid in net but flagged nonStatutory; BIK/VOLA
 * lines are flagged nonCash (PCB base only — never gross or net).
 * Statutory opt-outs (excludeEpf/Socso/Eis/Pcb) zero BOTH the employee and
 * employer shares of that scheme for the run and are recorded on the payslip
 * with their reason; the payslip prints a zero '— opted out (reason)' line.
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
 * Cut-off (Company.config.payrollCutoffDay via appSettings.getPayrollCutoff):
 * attendance OT and claims pay only when dated on/before the wage month's
 * cut-off day; later-dated items roll into the next month's run — each run
 * covers (previous cut-off, this cut-off], see `payrollPeriodFor`.
 *
 * Payslip numbering: every payslip gets a human `refNo` —
 * `<numberFormats.payslipPrefix>-<YYYY-MM>-<NNNN>` (per-run sequence,
 * continued past surviving slips on partial re-runs). Legacy payslips without
 * refNo render their id.
 *
 * YTD / PCB basis: stored payslips of the year + the employee's TP3
 * `ytdCarryIn` when present (seeded for the first recorded run of the year);
 * employees who joined before this year with no history get a
 * current-package year-continuity estimate (PCB basis only — never printed);
 * genuine mid-year hires have a true zero YTD.
 */

import { getCollection, setCollection, uid, logAudit } from './db';
import { getPayrollCutoff, getPayslipPrefix } from './appSettings';
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
  PayrollRun, Payslip, PayslipAdjustment, PayslipEditInput, PayslipLine, SalaryType,
  Settings as CompanySettings, StatutoryOptOutKey, YTDCarryIn,
} from './types';

export interface PayrollResult {
  run: PayrollRun;
  payslips: Payslip[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Payroll cut-off period (Company.config.payrollCutoffDay → run window)
// ─────────────────────────────────────────────────────────────────────────────

/** Inclusive date window a payroll run covers for variable inputs. */
export interface PayrollPeriod {
  /** ISO date, inclusive — day after the PREVIOUS month's cut-off. */
  start: string;
  /** ISO date, inclusive — the wage month's cut-off day. */
  end: string;
  /** Effective cut-off day applied (clamped to 1–28 upstream). */
  cutoffDay: number;
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Cut-off window for a wage month: attendance/OT/claims dated AFTER the
 * company's cut-off day roll into the NEXT month's run, so every run covers
 * (previous cut-off, this cut-off] — e.g. cut-off 25, month 2026-08 covers
 * 2026-07-26 → 2026-08-25. The day is clamped to the month length as a
 * belt-and-braces guard (getPayrollCutoff already clamps to 1–28).
 */
export function payrollPeriodFor(month: string, cutoffDay: number): PayrollPeriod {
  const [y, m] = month.split('-').map(Number);
  const daysIn = (yy: number, mm: number) => new Date(yy, mm, 0).getDate();
  const day = Math.min(Math.max(1, Math.round(cutoffDay)), 31);
  const endDay = Math.min(day, daysIn(y, m));
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const prevCutDay = Math.min(day, daysIn(py, pm));
  const start = new Date(py, pm - 1, prevCutDay);
  start.setDate(start.getDate() + 1);
  return { start: isoOf(start), end: isoOf(new Date(y, m - 1, endDay)), cutoffDay: endDay };
}

/** True when an ISO date falls inside the period (inclusive both ends). */
export function inPayrollPeriod(dateISO: string, period: Pick<PayrollPeriod, 'start' | 'end'>): boolean {
  return dateISO >= period.start && dateISO <= period.end;
}

/**
 * Worked days in the cut-off window for DAILY-rated employees.
 * Counting rule: status 'present' = 1 day; 'half-day' = 0.5 day; a 'rest-day'
 * or 'holiday' record carrying approved OT counts 1 worked day (the employee
 * reported for work); 'absent' / 'leave' records never count.
 */
export function workedDaysInPeriod(
  attendance: AttendanceRecord[],
  employeeId: string,
  period: Pick<PayrollPeriod, 'start' | 'end'>,
): number {
  let days = 0;
  for (const a of attendance) {
    if (a.employeeId !== employeeId || !inPayrollPeriod(a.date, period)) continue;
    if (a.status === 'present') days += 1;
    else if (a.status === 'half-day') days += 0.5;
    else if ((a.status === 'rest-day' || a.status === 'holiday') && a.otApproved && a.otHours > 0) days += 1;
  }
  return days;
}

/**
 * Worked BASE hours in the cut-off window for HOURLY-rated employees:
 * 'present' = standardDailyHours (Settings, default 8); 'half-day' = half of
 * that; everything else = 0. Approved OT hours are deliberately NOT base
 * hours — they are paid separately through the OT mechanism (1.5×/2×/3×), so
 * they can never be double-paid.
 */
export function workedHoursInPeriod(
  attendance: AttendanceRecord[],
  employeeId: string,
  period: Pick<PayrollPeriod, 'start' | 'end'>,
  standardDailyHours = 8,
): number {
  let hours = 0;
  for (const a of attendance) {
    if (a.employeeId !== employeeId || !inPayrollPeriod(a.date, period)) continue;
    if (a.status === 'present') hours += standardDailyHours;
    else if (a.status === 'half-day') hours += standardDailyHours / 2;
  }
  return hours;
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
  /** Cut-off window for variable inputs (attendance OT + claims). */
  period: PayrollPeriod;
  attendance: AttendanceRecord[];
  leaves: LeaveRequest[];
  claims: Claim[];
  numLocal: number;
  /** Standard daily working hours (Settings.standardDailyHours, default 8) —
   *  base-hours unit for hourly-rated worked-hour counting. */
  standardDailyHours: number;
  warnings: string[];
}

function buildCtx(month: string, runId: string, method: PayrollProrationMethod, warnings: string[]): PayslipCtx {
  return {
    month,
    monthIndex: Number(month.split('-')[1]),
    runId,
    method,
    period: payrollPeriodFor(month, getPayrollCutoff().cutoffDay),
    attendance: getCollection<AttendanceRecord>('attendance'),
    leaves: getCollection<LeaveRequest>('leaves'),
    claims: getCollection<Claim>('claims'),
    numLocal: getCollection<Employee>('employees').filter(
      (e) => !e.isForeignWorker && e.status !== 'resigned',
    ).length,
    standardDailyHours:
      getCollection<CompanySettings>('settings')[0]?.standardDailyHours ?? 8,
    warnings,
  };
}

/**
 * Compute one employee's payslip for the month. Pure w.r.t. the collections
 * snapshotted in `ctx` (plus stored prior-month payslips for YTD/PCB) — used
 * by runPayroll for every employee and by the draft editor (adjust / reset /
 * preview) for a single employee. `edit` carries the kakitangan per-run
 * overrides: adjustment lines, salary type / rate / worked quantity, the
 * basic 'Full amount' override and statutory opt-outs; the empty edit
 * reproduces runPayroll's untouched output.
 */
function computePayslip(emp: Employee, ctx: PayslipCtx, edit: PayslipEditInput = {}): Payslip {
  const { month, monthIndex, method } = ctx;
  const age = ageFromDob(emp.dateOfBirth, new Date(`${month}-28T00:00:00`));
  const fixedAllowances = emp.fixedAllowances ?? [];
  const adjustments = edit.adjustments ?? [];
  const salaryType: SalaryType = edit.salaryType ?? emp.salaryType ?? 'monthly';

  // ── Basic pay per salary type ──
  // Joiner/leaver employment-window factor: drives fixed-allowance proration
  // for every salary type, and monthly basic unless 'Worked: N month(s)'
  // overrides it. Rates: per-run edit wins, then the employee record, then
  // the statutory fallbacks (ORP ÷ 26; hourly ÷ 26 ÷ 8).
  const basicPr = prorate(edit.rate ?? emp.baseSalary, emp, month, method);
  const employmentFactor = basicPr.factor;
  const monthlyRate = edit.rate ?? emp.baseSalary;
  const dailyRate = edit.rate ?? emp.dailyRate ?? emp.baseSalary / 26;
  const hourlyRate = edit.rate ?? emp.hourlyRate ?? (emp.baseSalary / 26) / 8;

  let basicComputed: number;
  let factor: number;             // recorded proration/employment factor
  let workedQty: number;          // months fraction | days | hours
  let workedUnit: 'month' | 'day' | 'hour';
  let rateUsed: number;
  let countedQty: number | null = null; // attendance-derived qty (daily/hourly)
  let unpaidDays = 0;
  let unpaidDeduction = 0;

  if (salaryType === 'monthly') {
    // ── Joiner/leaver proration (or the 'Worked: N month(s)' override) ──
    factor = edit.workedQty ?? employmentFactor;
    // ── Unpaid leave on the SAME basis as the proration method ──
    unpaidDays = unpaidLeaveDaysInMonth(ctx.leaves, emp.id, month, emp.state, method);
    const dailyForUnpaid =
      method === 'calendar' ? monthlyRate / calendarDaysInMonth(month) :
      method === 'working-days' ? monthlyRate / Math.max(1, workingDaysInMonth(month, emp.state)) :
      orpFromMonthly(monthlyRate);
    unpaidDeduction = round2(unpaidDays * dailyForUnpaid);
    basicComputed = round2(Math.max(0, round2(monthlyRate * factor) - unpaidDeduction));
    workedQty = round2(factor * 100) / 100;
    workedUnit = 'month';
    rateUsed = monthlyRate;
  } else if (salaryType === 'daily') {
    // ── Daily: rate × worked days counted from attendance in the window.
    // No separate unpaid-leave deduction — unworked days are simply unpaid. ──
    countedQty = workedDaysInPeriod(ctx.attendance, emp.id, ctx.period);
    workedQty = edit.workedQty ?? countedQty;
    workedUnit = 'day';
    rateUsed = dailyRate;
    basicComputed = round2(dailyRate * workedQty);
    factor = employmentFactor;
  } else {
    // ── Hourly: rate × worked BASE hours. Approved OT hours pay separately
    // through the OT mechanism below — never double-paid as base hours. ──
    countedQty = workedHoursInPeriod(ctx.attendance, emp.id, ctx.period, ctx.standardDailyHours);
    workedQty = edit.workedQty ?? countedQty;
    workedUnit = 'hour';
    rateUsed = hourlyRate;
    basicComputed = round2(hourlyRate * workedQty);
    factor = employmentFactor;
  }

  // ── 'Full amount' override: replaces the computed basic outright ──
  const hasBasicOverride =
    edit.basicOverride !== undefined && Number.isFinite(edit.basicOverride) && edit.basicOverride >= 0;
  const basicPay = hasBasicOverride ? round2(edit.basicOverride!) : basicComputed;

  // ── Fixed allowances, prorated by the same factor ──
  const proratedAllowances = fixedAllowances.map((a) => ({
    ...a,
    amount: round2(a.amount * factor),
  }));
  const allowanceTotal = round2(proratedAllowances.reduce((s, a) => s + a.amount, 0));

  // ── Approved OT from attendance, split by day type (1.5×/2×/3×) ──
  // Cut-off window: only records dated ≤ the company's cut-off day of the
  // wage month feed this run; later-dated records roll into the next run.
  // HRP follows the salary type: hourly rate as-is, daily ÷ 8, monthly ÷26÷8.
  const otRecords = ctx.attendance.filter(
    (a) => a.employeeId === emp.id && inPayrollPeriod(a.date, ctx.period) && a.otApproved && a.otHours > 0,
  );
  const otHours = round2(otRecords.reduce((s, a) => s + a.otHours, 0));
  const hrp =
    salaryType === 'hourly' ? hourlyRate :
    salaryType === 'daily' ? dailyRate / 8 :
    hourlyFromMonthly(monthlyRate);
  const otBy = (t: 'normal' | 'rest' | 'holiday') =>
    round2(otRecords.filter((a) => a.otDayType === t).reduce((s, a) => s + calcOT(hrp, a.otHours, t), 0));
  const otNormal = otBy('normal');
  const otRest = otBy('rest');
  const otHoliday = otBy('holiday');
  const otPay = round2(otNormal + otRest + otHoliday);

  // ── Approved claims in the cut-off window → non-statutory reimbursement ──
  // Include status 'paid' too: claims already reimbursed by an earlier run
  // of THIS month stay reimbursable on idempotent re-runs (the superseded
  // run is deleted below, so they must roll into the replacement payslip).
  const monthClaims = ctx.claims.filter(
    (c) => c.employeeId === emp.id && (c.status === 'approved' || c.status === 'paid') && inPayrollPeriod(c.claimDate, ctx.period),
  );
  const claimsTotal = round2(monthClaims.reduce((s, c) => s + c.amount, 0));

  // ── Ad-hoc editor adjustments (draft runs) ──
  // Earnings split three ways: gross-joining wages, non-statutory cash
  // reimbursements (paid in net, like claims), and non-cash BIK/VOLA (PCB
  // base only — never gross or net). Deductions reduce net pay only.
  const cleanAdjustments = adjustments.filter((a) => Number.isFinite(a.amount) && a.amount > 0);
  const earningLines = cleanAdjustments.filter((a) => a.kind === 'earning');
  const grossEarnings = earningLines.filter((a) => !a.nonStatutory && !a.nonCash);
  const adjustmentEarnings = round2(grossEarnings.reduce((s, a) => s + a.amount, 0));
  const adjustmentReimbursements = round2(
    earningLines.filter((a) => a.nonStatutory && !a.nonCash).reduce((s, a) => s + a.amount, 0),
  );
  const adjustmentNonCash = round2(
    earningLines.filter((a) => a.nonCash).reduce((s, a) => s + a.amount, 0),
  );
  const adjustmentDeductions = round2(
    cleanAdjustments.filter((a) => a.kind === 'deduction').reduce((s, a) => s + a.amount, 0),
  );

  // ── Statutory wage bases, accumulated per line tag (research doc §6) ──
  // UNTAGGED earning lines keep the legacy behaviour (SOCSO/EIS ✓, EPF ✗,
  // PCB additional remuneration) so pre-tag figures never drift; TAGGED
  // lines feed exactly the bases their tags mark.
  const untagged = grossEarnings.filter((a) => !a.tags);
  const tagged = grossEarnings.filter((a) => a.tags);
  const untaggedTotal = round2(untagged.reduce((s, a) => s + a.amount, 0));
  const taggedSum = (pick: (a: PayslipAdjustment) => boolean) =>
    round2(tagged.filter(pick).reduce((s, a) => s + a.amount, 0));

  const grossPay = round2(basicPay + allowanceTotal + otPay + adjustmentEarnings);
  const epfBase = round2(basicPay + allowanceTotal + taggedSum((a) => a.tags!.epf));
  const socsoBase = round2(basicPay + allowanceTotal + otPay + untaggedTotal + taggedSum((a) => a.tags!.socso));
  const eisBase = round2(basicPay + allowanceTotal + otPay + untaggedTotal + taggedSum((a) => a.tags!.eis));

  // ── Statutory opt-outs: zero BOTH shares of the opted-out scheme ──
  const excludeEpf = edit.excludeEpf === true;
  const excludeSocso = edit.excludeSocso === true;
  const excludeEis = edit.excludeEis === true;
  const excludePcb = edit.excludePcb === true;

  const epf = excludeEpf
    ? { employee: 0, employer: 0 }
    : calcEPF(epfBase, age, !emp.isForeignWorker, emp.isForeignWorker);
  const socso = excludeSocso
    ? { employee: 0, employer: 0, category: (age >= 60 ? 2 : 1) as 1 | 2 }
    : calcSOCSO(socsoBase, age);
  const eis = excludeEis
    ? { employee: 0, employer: 0 }
    : calcEIS(eisBase, age, !emp.isForeignWorker);

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

  // ── PCB base ──
  // With NO tagged lines anywhere, reproduce the legacy call exactly
  // (annualized on the gross; all adjustment earnings as additional
  // remuneration) so pre-tag figures never drift. Otherwise accumulate per
  // line: normal remuneration = basic + allowances + OT + pcb-tagged normal
  // lines + non-cash BIK (TP2); additional remuneration (bonus/commission/
  // director fees + legacy untagged lines) taxed via the aggregate delta.
  const hasTaggedLines = tagged.length > 0 || earningLines.some((a) => a.nonCash && a.tags);
  let pcbBase: number;
  let pcbAdditional: number;
  if (hasTaggedLines) {
    pcbBase = round2(
      basicPay + allowanceTotal + otPay +
      taggedSum((a) => a.tags!.pcb && !a.additionalRemuneration) +
      round2(earningLines.filter((a) => a.nonCash && a.tags?.pcb).reduce((s, a) => s + a.amount, 0)),
    );
    pcbAdditional = round2(
      taggedSum((a) => a.tags!.pcb && a.additionalRemuneration === true) + untaggedTotal,
    );
  } else {
    pcbBase = grossPay;
    pcbAdditional = adjustmentEarnings;
  }
  const pcb = excludePcb
    ? 0
    : calcPCB(hasTaggedLines ? pcbBase : grossPay, pcbBasis, {
        marital: emp.maritalStatus,
        children: emp.children,
        monthIndex,
        // Additional remuneration (LHDN bonus mechanism): taxed via the
        // aggregate delta, in full, this month.
        bonus: pcbAdditional > 0 ? pcbAdditional : undefined,
        epfEmployee: epf.employee,
        socsoEmployee: round2(socso.employee + eis.employee),
      });
  const hrd = hrdfLevy(round2(basicPay + allowanceTotal), ctx.numLocal);

  const netPay = round2(
    grossPay - epf.employee - socso.employee - eis.employee - pcb - adjustmentDeductions +
    claimsTotal + adjustmentReimbursements,
  );
  const employerCost = round2(
    grossPay + epf.employer + socso.employer + eis.employer + hrd + claimsTotal + adjustmentReimbursements,
  );

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
  const optOutSuffix = (key: StatutoryOptOutKey): string => {
    const reason = edit.optOutReasons?.[key]?.trim();
    return ` — opted out${reason ? ` (${reason})` : ''}`;
  };
  const workedInfoLines: PayslipLine[] = [];
  if (salaryType === 'monthly') {
    workedInfoLines.push({
      label: `Days worked: ${basicPr.daysWorked} / ${basicPr.daysInBasis} (${basisLabel})`,
      amount: 0,
      kind: 'info',
    });
    if (edit.workedQty !== undefined) {
      workedInfoLines.push({
        label: `Worked: ${workedQty} month(s) — overridden (joiner/leaver proration bypassed)`,
        amount: 0,
        kind: 'info',
      });
    }
  } else {
    workedInfoLines.push({
      label:
        `Worked: ${workedQty} ${workedUnit === 'day' ? 'day(s)' : 'hour(s)'} × ` +
        `RM ${rateUsed.toFixed(2)}/${workedUnit}` +
        (edit.workedQty !== undefined && countedQty !== null && countedQty !== workedQty
          ? ` — overridden (attendance counted ${countedQty})`
          : ''),
      amount: 0,
      kind: 'info',
    });
  }
  const basicLineAmount =
    salaryType === 'monthly' && !hasBasicOverride ? round2(monthlyRate * factor) : basicPay;
  const lines: PayslipLine[] = [
    ...workedInfoLines,
    {
      label: hasBasicOverride ? 'Basic salary (overridden)' : 'Basic salary',
      amount: basicLineAmount,
      kind: 'earning',
    },
    ...(salaryType === 'monthly' && factor < 1 && edit.workedQty === undefined
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
      ...(a.kind === 'earning' && (a.nonStatutory || a.nonCash) ? { nonStatutory: true as const } : {}),
      ...(a.kind === 'earning' && a.nonCash ? { nonCash: true as const } : {}),
    })),
    ...(excludeEpf
      ? [{ label: `EPF employee${optOutSuffix('epf')}`, amount: 0, kind: 'deduction' as const }]
      : [{ label: `EPF employee (${epfEmployeeRateLabel(emp, age)})`, amount: -epf.employee, kind: 'deduction' as const }]),
    ...(excludeSocso
      ? [{ label: `SOCSO employee${optOutSuffix('socso')}`, amount: 0, kind: 'deduction' as const }]
      : [{ label: 'SOCSO employee', amount: -socso.employee, kind: 'deduction' as const }]),
    ...(excludeEis
      ? [{ label: `EIS employee${optOutSuffix('eis')}`, amount: 0, kind: 'deduction' as const }]
      : [{ label: 'EIS employee', amount: -eis.employee, kind: 'deduction' as const }]),
    ...(excludePcb
      ? [{ label: `PCB / MTD${optOutSuffix('pcb')}`, amount: 0, kind: 'deduction' as const }]
      : [{ label: 'PCB / MTD', amount: -pcb, kind: 'deduction' as const }]),
    ...monthClaims.map((c) => ({
      label: `Claim — ${c.title}`,
      amount: round2(c.amount),
      kind: 'earning' as const,
      nonStatutory: true,
    })),
    ...(excludeEpf
      ? [{ label: `EPF employer${optOutSuffix('epf')}`, amount: 0, kind: 'employer' as const }]
      : [{ label: `EPF employer (${epfEmployerRateLabel(emp, age, epfBase)})`, amount: epf.employer, kind: 'employer' as const }]),
    ...(excludeSocso
      ? [{ label: `SOCSO employer${optOutSuffix('socso')}`, amount: 0, kind: 'employer' as const }]
      : [{ label: 'SOCSO employer', amount: socso.employer, kind: 'employer' as const }]),
    ...(excludeEis
      ? [{ label: `EIS employer${optOutSuffix('eis')}`, amount: 0, kind: 'employer' as const }]
      : [{ label: 'EIS employer', amount: eis.employer, kind: 'employer' as const }]),
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
    adjustmentReimbursements,
    adjustmentNonCash,
    salaryTypeUsed: salaryType,
    rateUsed,
    workedQty,
    workedUnit,
    ...(hasBasicOverride ? { basicOverride: basicPay } : {}),
    ...(edit.salaryType ? { salaryTypeOverride: edit.salaryType } : {}),
    ...(edit.rate !== undefined ? { rateOverride: edit.rate } : {}),
    ...(edit.workedQty !== undefined ? { workedQtyOverride: edit.workedQty } : {}),
    epfBase,
    socsoBase,
    eisBase,
    pcbBase,
    pcbAdditional,
    ...(excludeEpf ? { excludeEpf: true } : {}),
    ...(excludeSocso ? { excludeSocso: true } : {}),
    ...(excludeEis ? { excludeEis: true } : {}),
    ...(excludePcb ? { excludePcb: true } : {}),
    ...(excludeEpf || excludeSocso || excludeEis || excludePcb
      ? { optOutReasons: edit.optOutReasons ?? {} }
      : {}),
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
  run.cutoffDay = ctx.period.cutoffDay;
  const payslips: Payslip[] = employees.map((emp) => computePayslip(emp, ctx));

  // ── Persist: one run per month; non-targeted payslips survive on the new run ──
  const keptRuns = getCollection<PayrollRun>('payrollRuns').filter((r) => r.monthKey !== month);
  // Payslips of employees NOT targeted by this (partial) re-run survive and
  // are re-pointed to the new run id — payslip.runId never dangles (B1).
  const survivingSlips = allSlips
    .filter((p) => p.monthKey === month && !targetIds.has(p.employeeId))
    .map((p) => ({ ...p, runId: run.id }));

  // Human document numbers (numberFormats.payslipPrefix + month + per-run
  // sequence), e.g. 'ASM-PS-2026-08-0012'. Sequences continue after the
  // highest number held by surviving (non-targeted) payslips so partial
  // re-runs never collide; a full re-run reproduces the same numbers.
  // Legacy slips without refNo keep rendering their id (UI fallback).
  const refBase = `${getPayslipPrefix()}-${month}-`;
  const maxSeq = survivingSlips.reduce((max, p) => {
    const n = p.refNo?.startsWith(refBase) ? Number(p.refNo.slice(refBase.length)) : NaN;
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  payslips.forEach((p, i) => {
    p.refNo = `${refBase}${String(maxSeq + i + 1).padStart(4, '0')}`;
  });

  setCollection('payslips', [...otherMonthSlips, ...survivingSlips, ...payslips]);

  // Claims: targeted employees' approved/paid claims IN THE CUT-OFF WINDOW
  // are (re)stamped onto the new run; claims dated after the cut-off stay
  // 'approved' and roll into the next month's run untouched. Surviving
  // employees' already-paid claims follow their payslip so paidInRunId never
  // points at a deleted run either. DRAFT runs do NOT stamp claims paid —
  // that happens on finalize (QA: draft must be side-effect free so
  // undo/adjust cycles never strand a claim). Only written when changed.
  const paidSlipByEmp = new Map(payslips.map((p) => [p.employeeId, p]));
  const survivorEmpIds = new Set(survivingSlips.map((p) => p.employeeId));
  const isDraft = run.status === 'draft';
  const nextClaims = claims.map((c) => {
    if (!inPayrollPeriod(c.claimDate, ctx.period)) return c;
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
    detail: `${month}: ${run.employeeCount} payslips, net ${run.totalNet.toFixed(2)} (${run.status}, proration: ${PRORATION_LABELS[method]}, cut-off day ${run.cutoffDay})`,
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
 * Internal: recompute one employee's payslip inside a DRAFT run from the
 * given edit state and persist it (retallying the run). Returns null when
 * the run is missing / finalized / doesn't cover the employee. Callers log
 * their own audit action.
 */
function applyEdit(runId: string, employeeId: string, edit: PayslipEditInput): Payslip | null {
  const run = findRun(runId);
  if (!run || run.status !== 'draft') return null;
  const existing = payslipFor(runId, employeeId);
  const emp = getCollection<Employee>('employees').find((e) => e.id === employeeId);
  if (!existing || !emp) return null;
  const ctx = buildCtx(run.monthKey, runId, run.prorationMethod ?? resolveProrationMethod(), []);
  const recomputed = computePayslip(emp, ctx, edit);
  return replacePayslip(run, { ...recomputed, id: existing.id, refNo: existing.refNo });
}

/**
 * Recompute one employee's payslip inside a draft run from a full edit state
 * (kakitangan editor): adjustment lines, salary-type / rate / worked-quantity
 * overrides, basic 'Full amount' override and statutory opt-outs. Returns the
 * recomputed payslip, or null when the run is missing / already finalized /
 * doesn't cover the employee. Overrides are audit-logged in the detail line.
 */
export function updateDraftPayslip(
  runId: string,
  employeeId: string,
  edit: PayslipEditInput,
  actor = 'system',
): Payslip | null {
  const run = findRun(runId);
  if (!run || run.status !== 'draft') return null;
  const emp = getCollection<Employee>('employees').find((e) => e.id === employeeId);
  const slip = applyEdit(runId, employeeId, edit);
  if (!slip || !emp) return null;
  const flags: string[] = [];
  if (edit.basicOverride !== undefined) flags.push(`basic overridden to ${slip.basicPay.toFixed(2)}`);
  if (edit.salaryType) flags.push(`salary type ${edit.salaryType}`);
  if (edit.workedQty !== undefined) flags.push(`worked ${edit.workedQty} ${slip.workedUnit ?? ''}(s)`);
  const optOuts = (['epf', 'socso', 'eis', 'pcb'] as const).filter(
    (k) => edit[k === 'epf' ? 'excludeEpf' : k === 'socso' ? 'excludeSocso' : k === 'eis' ? 'excludeEis' : 'excludePcb'],
  );
  if (optOuts.length > 0) flags.push(`opted out: ${optOuts.join(', ').toUpperCase()}`);
  logAudit({
    actorName: actor,
    action: 'payroll.payslip.adjust',
    entity: 'payslips',
    entityId: slip.id,
    detail:
      `${run.monthKey} ${emp.name}: ${(edit.adjustments ?? []).length} adjustment(s)` +
      (flags.length > 0 ? `, ${flags.join(', ')}` : '') +
      `, net ${slip.netPay.toFixed(2)}`,
  });
  return slip;
}

/**
 * Live preview of one employee's draft payslip for an edit state WITHOUT
 * persisting anything — the editor's 'Pay amount' panel recomputes through
 * this on every keystroke, so what HR sees is exactly what Save will store.
 * Works for any run (read-only); returns null when run/employee is unknown.
 */
export function previewPayslip(
  runId: string,
  employeeId: string,
  edit: PayslipEditInput,
): Payslip | null {
  const run = findRun(runId);
  if (!run) return null;
  const emp = getCollection<Employee>('employees').find((e) => e.id === employeeId);
  if (!emp) return null;
  const existing = payslipFor(runId, employeeId);
  const ctx = buildCtx(run.monthKey, runId, run.prorationMethod ?? resolveProrationMethod(), []);
  const slip = computePayslip(emp, ctx, edit);
  return existing ? { ...slip, id: existing.id, refNo: existing.refNo } : slip;
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
  const emp = getCollection<Employee>('employees').find((e) => e.id === employeeId);
  const slip = applyEdit(runId, employeeId, { adjustments });
  if (!slip || !emp) return null;
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
 * adjustment AND every per-run override ('Reset employee' in the editor).
 * Draft runs only.
 */
export function resetPayslipToDefaults(
  runId: string,
  employeeId: string,
  actor = 'system',
): Payslip | null {
  const run = findRun(runId);
  if (!run || run.status !== 'draft') return null;
  const emp = getCollection<Employee>('employees').find((e) => e.id === employeeId);
  const slip = applyEdit(runId, employeeId, {});
  if (!slip || !emp) return null;
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
  // Stamp only claims inside the run's cut-off window (the cut-off captured
  // at run time wins; fall back to the current config for legacy runs) —
  // after-cut-off claims stay approved for the next run.
  const period = payrollPeriodFor(run.monthKey, run.cutoffDay ?? getPayrollCutoff().cutoffDay);
  const claims = getCollection<Claim>('claims');
  const nextClaims = claims.map((c) =>
    inPayrollPeriod(c.claimDate, period) &&
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
