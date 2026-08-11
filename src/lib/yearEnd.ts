/**
 * Year-end statutory pack + batch payslip distribution helpers.
 *
 * Pure aggregation over STORED payslips — no statutory rate is ever recomputed
 * here (rates live in lib/statutory.ts; monthly filings in StatutoryOutputs).
 * Only payslips from FINALIZED runs count: a draft run is internal HR review
 * material and never belongs in an annual return.
 *
 * Filing calendar (docs/research/statutory-rates.md §7.2/7.3):
 *  - EA form (CP8A) to employees: last day of February (see EAForm.tsx).
 *  - Form E (employer return) + CP8D (employee remuneration listing):
 *    due 31 March after the year of assessment; e-Filing grace typically
 *    to 30 April. Cross-checked by LHDN against EA forms and CP39 remittances.
 *  - CP21 / CP22A leaver notification: at least 30 days before cessation /
 *    departure (event-driven), with monies withheld pending tax clearance.
 *
 * Everything here is array-in / value-out so the vitest suite can exercise the
 * math without localStorage; pages wire collections in from useCollection.
 */
import type {
  Department, Employee, PayrollRun, Payslip, Position, Settings,
} from './types';
import { fmtDate, fmtRM, round2 } from './utils';
import { rowsToCsv, toCsv, type CsvValue } from './csv';

/** Fixed 2-decimal money for files — never localized, never 'RM'-prefixed. */
const num2 = (n: number): string => n.toFixed(2);

// ─────────────────────────────────────────────────────────────────────────────
// Year plumbing
// ─────────────────────────────────────────────────────────────────────────────

/** 'YYYY-MM' monthKeys Jan→Dec of a calendar year. */
export function monthsOfYear(year: string | number): string[] {
  const y = String(year);
  return Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
}

/** Next monthKey ('2026-12' → '2027-01'). */
function nextMonthKey(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Months the company is expected to have finalized for `year`, derived from
 * actual payroll activity: from the first month with any run/payslip through
 * December (past years) or the current month (current year). Empty when the
 * year has no activity at all or lies in the future.
 */
export function expectedMonths(
  year: string | number,
  runs: PayrollRun[],
  payslips: Payslip[],
  today: Date = new Date(),
): string[] {
  const y = String(year);
  const active = [
    ...new Set([
      ...runs.filter((r) => r.monthKey.startsWith(y)).map((r) => r.monthKey),
      ...payslips.filter((p) => p.monthKey.startsWith(y)).map((p) => p.monthKey),
    ]),
  ].sort();
  if (active.length === 0) return [];

  const curYear = String(today.getFullYear());
  if (y > curYear) return [];
  const curMk = `${curYear}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const last = y < curYear ? `${y}-12` : curMk;

  const out: string[] = [];
  for (let mk = active[0]!; mk <= last; mk = nextMonthKey(mk)) out.push(mk);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-employee annual totals (FINALIZED runs only)
// ─────────────────────────────────────────────────────────────────────────────

/** Payslips of a calendar year that belong to finalized runs, month-sorted. */
export function finalizedSlipsForYear(
  payslips: Payslip[],
  runs: PayrollRun[],
  year: string | number,
): Payslip[] {
  const y = String(year);
  const status = new Map(runs.map((r) => [r.id, r.status]));
  return payslips
    .filter((p) => p.monthKey.slice(0, 4) === y && status.get(p.runId) === 'finalized')
    .sort(
      (a, b) =>
        a.monthKey.localeCompare(b.monthKey) ||
        a.employeeId.localeCompare(b.employeeId) ||
        a.id.localeCompare(b.id),
    );
}

/** One row of the year-end aggregation: an employee's annual totals. */
export interface YearEndEmployeeTotals {
  employeeId: string;
  /** Number of finalized payslips counted (normally ≤ 12). */
  months: number;
  basic: number;
  allowances: number;
  ot: number;
  /** Annual gross remuneration (basic + allowances + OT; claims excluded). */
  gross: number;
  /** Non-statutory claim reimbursements — memo only, never taxable wages. */
  claims: number;
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  hrdLevy: number;
  net: number;
  employerCost: number;
  /** First / last finalized payslip month of the year ('YYYY-MM'). */
  firstMonth: string;
  lastMonth: string;
  /** Net pay of the last finalized payslip of the year (CP21 final pay). */
  lastNet: number;
}

/** Aggregate month-sorted slips into per-employee annual totals. */
export function aggregateSlips(slips: Payslip[]): YearEndEmployeeTotals[] {
  interface Acc extends Omit<YearEndEmployeeTotals, 'firstMonth' | 'lastMonth' | 'lastNet'> {
    firstMonth: string;
    lastMonth: string;
    lastNet: number;
  }
  const byEmp = new Map<string, Acc>();
  for (const p of slips) {
    let t = byEmp.get(p.employeeId);
    if (!t) {
      t = {
        employeeId: p.employeeId,
        months: 0,
        basic: 0, allowances: 0, ot: 0, gross: 0, claims: 0,
        epfEmployee: 0, epfEmployer: 0,
        socsoEmployee: 0, socsoEmployer: 0,
        eisEmployee: 0, eisEmployer: 0,
        pcb: 0, hrdLevy: 0, net: 0, employerCost: 0,
        firstMonth: p.monthKey, lastMonth: p.monthKey, lastNet: p.netPay,
      };
      byEmp.set(p.employeeId, t);
    }
    t.months += 1;
    t.basic += p.basicPay;
    t.allowances += p.allowances;
    t.ot += p.otPay;
    t.gross += p.grossPay;
    t.claims += p.claimsTotal;
    t.epfEmployee += p.epfEmployee;
    t.epfEmployer += p.epfEmployer;
    t.socsoEmployee += p.socsoEmployee;
    t.socsoEmployer += p.socsoEmployer;
    t.eisEmployee += p.eisEmployee;
    t.eisEmployer += p.eisEmployer;
    t.pcb += p.pcb;
    t.hrdLevy += p.hrdLevy;
    t.net += p.netPay;
    t.employerCost += p.employerCost;
    // Slips arrive month-sorted, so the last seen is the year's final payslip.
    if (p.monthKey < t.firstMonth) t.firstMonth = p.monthKey;
    if (p.monthKey >= t.lastMonth) {
      t.lastMonth = p.monthKey;
      t.lastNet = p.netPay;
    }
  }
  const money = (n: number) => round2(n);
  return [...byEmp.values()].map((t) => ({
    ...t,
    basic: money(t.basic),
    allowances: money(t.allowances),
    ot: money(t.ot),
    gross: money(t.gross),
    claims: money(t.claims),
    epfEmployee: money(t.epfEmployee),
    epfEmployer: money(t.epfEmployer),
    socsoEmployee: money(t.socsoEmployee),
    socsoEmployer: money(t.socsoEmployer),
    eisEmployee: money(t.eisEmployee),
    eisEmployer: money(t.eisEmployer),
    pcb: money(t.pcb),
    hrdLevy: money(t.hrdLevy),
    net: money(t.net),
    employerCost: money(t.employerCost),
    lastNet: money(t.lastNet),
  }));
}

/** A calendar year's finalized payslips → per-employee annual totals. */
export function aggregateFinalizedYear(
  payslips: Payslip[],
  runs: PayrollRun[],
  year: string | number,
): YearEndEmployeeTotals[] {
  return aggregateSlips(finalizedSlipsForYear(payslips, runs, year));
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation warnings (per employee row)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Statutory-ID completeness for one employee. IC / tax no. are LHDN-critical
 * (EA, CP8D, CP21); EPF / SOCSO numbers are needed for the contribution
 * listings. An employeeId with no record at all is a hard warning.
 */
export function employeeValidationWarnings(emp: Employee | undefined): string[] {
  if (!emp) return ['No employee record found'];
  const w: string[] = [];
  if (!emp.ic || !emp.ic.trim()) w.push('Missing NRIC / passport no.');
  if (!emp.taxNo || !emp.taxNo.trim()) w.push('Missing income tax no.');
  if (!emp.epfNo || !emp.epfNo.trim()) w.push('Missing EPF member no.');
  if (!emp.socsoNo || !emp.socsoNo.trim()) w.push('Missing SOCSO no.');
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// CP8D — employee remuneration listing filed with Form E
// ─────────────────────────────────────────────────────────────────────────────

export interface Cp8dRow {
  no: number;
  employeeId: string;
  name: string;
  ic: string;
  taxNo: string;
  epfNo: string;
  socsoNo: string;
  months: number;
  grossRemuneration: number;
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  netPay: number;
  warnings: string[];
}

/** Annual totals + employee directory → CP8D listing rows (name-sorted). */
export function buildCp8dRows(
  totals: YearEndEmployeeTotals[],
  employees: Employee[],
): Cp8dRow[] {
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const nameOf = (t: YearEndEmployeeTotals) => empMap.get(t.employeeId)?.name ?? t.employeeId;
  return [...totals]
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || a.employeeId.localeCompare(b.employeeId))
    .map((t, i) => {
      const emp = empMap.get(t.employeeId);
      return {
        no: i + 1,
        employeeId: t.employeeId,
        name: nameOf(t),
        ic: emp?.ic ?? '',
        taxNo: emp?.taxNo ?? '',
        epfNo: emp?.epfNo ?? '',
        socsoNo: emp?.socsoNo ?? '',
        months: t.months,
        grossRemuneration: t.gross,
        epfEmployee: t.epfEmployee,
        epfEmployer: t.epfEmployer,
        socsoEmployee: t.socsoEmployee,
        socsoEmployer: t.socsoEmployer,
        eisEmployee: t.eisEmployee,
        eisEmployer: t.eisEmployer,
        pcb: t.pcb,
        netPay: t.net,
        warnings: employeeValidationWarnings(emp),
      };
    });
}

export const CP8D_HEADERS = [
  'No', 'Employee Name', 'NRIC / Passport No', 'Income Tax No', 'EPF No', 'SOCSO No',
  'Months', 'Gross Remuneration (RM)', 'EPF Employee (RM)', 'EPF Employer (RM)',
  'SOCSO Employee (RM)', 'SOCSO Employer (RM)', 'EIS Employee (RM)', 'EIS Employer (RM)',
  'PCB / MTD (RM)', 'Net Pay (RM)',
];

/** CP8D data rows (fixed 2-decimal money), TOTAL row appended. */
export function cp8dCsvRows(rows: Cp8dRow[]): CsvValue[][] {
  const sum = (fn: (r: Cp8dRow) => number) => round2(rows.reduce((s, r) => s + fn(r), 0));
  return [
    ...rows.map((r) => [
      r.no, r.name, r.ic, r.taxNo, r.epfNo, r.socsoNo, r.months,
      num2(r.grossRemuneration), num2(r.epfEmployee), num2(r.epfEmployer),
      num2(r.socsoEmployee), num2(r.socsoEmployer),
      num2(r.eisEmployee), num2(r.eisEmployer),
      num2(r.pcb), num2(r.netPay),
    ]),
    [
      '', 'TOTAL', '', '', '', '', sum((r) => r.months),
      num2(sum((r) => r.grossRemuneration)), num2(sum((r) => r.epfEmployee)),
      num2(sum((r) => r.epfEmployer)), num2(sum((r) => r.socsoEmployee)),
      num2(sum((r) => r.socsoEmployer)), num2(sum((r) => r.eisEmployee)),
      num2(sum((r) => r.eisEmployer)), num2(sum((r) => r.pcb)), num2(sum((r) => r.netPay)),
    ],
  ];
}

/** Full CP8D CSV text (header + rows + TOTAL). */
export function cp8dCsv(rows: Cp8dRow[]): string {
  return toCsv(CP8D_HEADERS, cp8dCsvRows(rows));
}

// ─────────────────────────────────────────────────────────────────────────────
// Form E — employer annual return summary (LHDN e-Filing helper layout)
// ─────────────────────────────────────────────────────────────────────────────

export interface FormESummary {
  year: string;
  /** Employees with ≥ 1 finalized payslip (CP8D row count). */
  employeeCount: number;
  /** Payslip-month count across all employees (Σ months). */
  payslipMonths: number;
  /** Expected months per payroll activity that have a finalized run. */
  monthsFinalized: number;
  /** Expected months with NO finalized run (missing or still draft). */
  monthsMissingFinalized: string[];
  remuneration: {
    salary: number;
    allowances: number;
    overtime: number;
    gross: number;
    /** Non-taxable claim reimbursements — memo only. */
    claims: number;
  };
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  hrdLevy: number;
  net: number;
  employerCost: number;
}

/** Company-wide Form E figures from the per-employee annual totals. */
export function buildFormESummary(
  totals: YearEndEmployeeTotals[],
  runs: PayrollRun[],
  payslips: Payslip[],
  year: string | number,
  today: Date = new Date(),
): FormESummary {
  const y = String(year);
  const sum = (fn: (t: YearEndEmployeeTotals) => number) =>
    round2(totals.reduce((s, t) => s + fn(t), 0));
  const finalizedMks = new Set(
    runs.filter((r) => r.status === 'finalized' && r.monthKey.startsWith(y)).map((r) => r.monthKey),
  );
  const expected = expectedMonths(y, runs, payslips, today);
  const missing = expected.filter((mk) => !finalizedMks.has(mk));
  return {
    year: y,
    employeeCount: totals.length,
    payslipMonths: totals.reduce((s, t) => s + t.months, 0),
    monthsFinalized: expected.length - missing.length,
    monthsMissingFinalized: missing,
    remuneration: {
      salary: sum((t) => t.basic),
      allowances: sum((t) => t.allowances),
      overtime: sum((t) => t.ot),
      gross: sum((t) => t.gross),
      claims: sum((t) => t.claims),
    },
    epfEmployee: sum((t) => t.epfEmployee),
    epfEmployer: sum((t) => t.epfEmployer),
    socsoEmployee: sum((t) => t.socsoEmployee),
    socsoEmployer: sum((t) => t.socsoEmployer),
    eisEmployee: sum((t) => t.eisEmployee),
    eisEmployer: sum((t) => t.eisEmployer),
    pcb: sum((t) => t.pcb),
    hrdLevy: sum((t) => t.hrdLevy),
    net: sum((t) => t.net),
    employerCost: sum((t) => t.employerCost),
  };
}

/** Form E key/value rows in the LHDN e-Filing helper layout. */
export function formECsvRows(s: FormESummary, settings?: Settings): CsvValue[][] {
  const nextYear = String(Number(s.year) + 1);
  return [
    [`FORM E — RETURN OF EMPLOYER REMUNERATION (YEAR OF ASSESSMENT ${s.year})`],
    [],
    ['Employer name', settings?.companyName ?? ''],
    ['Employer registration no. (SSM)', settings?.companyRegNo ?? ''],
    ['Employer E no. (income tax employer no.)', settings?.taxEmployerNo ?? ''],
    ['EPF employer no.', settings?.epfEmployerNo ?? ''],
    ['SOCSO employer no.', settings?.socsoEmployerNo ?? ''],
    [],
    ['Number of employees (per CP8D)', s.employeeCount],
    ['Payslip-months aggregated', s.payslipMonths],
    ['Months finalized', s.monthsFinalized],
    [],
    ['Remuneration — salary, wages & leave pay (RM)', num2(s.remuneration.salary)],
    ['Remuneration — fixed allowances (RM)', num2(s.remuneration.allowances)],
    ['Remuneration — overtime (RM)', num2(s.remuneration.overtime)],
    ['Total gross remuneration (RM)', num2(s.remuneration.gross)],
    ['Memo: non-taxable claim reimbursements (RM)', num2(s.remuneration.claims)],
    [],
    ['Total PCB / MTD deducted (RM)', num2(s.pcb)],
    ['EPF — employee share (RM)', num2(s.epfEmployee)],
    ['EPF — employer share (RM)', num2(s.epfEmployer)],
    ['SOCSO — employee + employer (RM)', num2(round2(s.socsoEmployee + s.socsoEmployer))],
    ['EIS (SIP) — employee + employer (RM)', num2(round2(s.eisEmployee + s.eisEmployer))],
    ['HRD Corp levy (RM)', num2(s.hrdLevy)],
    ['Total net pay disbursed (RM)', num2(s.net)],
    ['Total employer cost (RM)', num2(s.employerCost)],
    [],
    ['Statutory due date', `31 March ${nextYear}`],
    ['e-Filing grace period until', `30 April ${nextYear}`],
  ];
}

/** Full Form E CSV text. */
export function formECsv(s: FormESummary, settings?: Settings): string {
  return rowsToCsv(formECsvRows(s, settings));
}

// ─────────────────────────────────────────────────────────────────────────────
// CP21 — leaver notification dataset (event-driven, ITA s.83)
// ─────────────────────────────────────────────────────────────────────────────

export interface Cp21Row {
  no: number;
  employeeId: string;
  name: string;
  ic: string;
  taxNo: string;
  /** ISO date of cessation (employee.resignDate). */
  leavingDate: string;
  /** Last finalized payslip month of the year ('—' when none). */
  finalMonth: string;
  /** Net pay of that last payslip; null when the year has no finalized slip. */
  finalNet: number | null;
  reason: string;
  warnings: string[];
}

/**
 * Employees whose resignDate falls inside `year` → CP21 notification rows.
 * `reasons` optionally maps employeeId → separation reason (e.g. from the
 * offboarding module); rows default to 'Resignation' / '—'.
 */
export function buildCp21Rows(
  employees: Employee[],
  totals: YearEndEmployeeTotals[],
  year: string | number,
  reasons?: ReadonlyMap<string, string>,
): Cp21Row[] {
  const y = String(year);
  const totalsByEmp = new Map(totals.map((t) => [t.employeeId, t]));
  return employees
    .filter((e) => e.resignDate && e.resignDate.slice(0, 4) === y)
    .sort(
      (a, b) =>
        (a.resignDate ?? '').localeCompare(b.resignDate ?? '') || a.name.localeCompare(b.name),
    )
    .map((e, i) => {
      const t = totalsByEmp.get(e.id);
      const warnings = employeeValidationWarnings(e);
      if (!t) warnings.push(`No finalized payslip in ${y} — final pay unknown`);
      return {
        no: i + 1,
        employeeId: e.id,
        name: e.name,
        ic: e.ic,
        taxNo: e.taxNo,
        leavingDate: e.resignDate ?? '',
        finalMonth: t?.lastMonth ?? '—',
        finalNet: t?.lastNet ?? null,
        reason: reasons?.get(e.id) ?? (e.status === 'resigned' ? 'Resignation' : '—'),
        warnings,
      };
    });
}

export const CP21_HEADERS = [
  'No', 'Employee Name', 'NRIC / Passport No', 'Income Tax No',
  'Leaving Date', 'Final Pay Month', 'Final Net Pay (RM)', 'Reason',
];

/** CP21 data rows (fixed 2-decimal money; blank final pay when unknown). */
export function cp21CsvRows(rows: Cp21Row[]): CsvValue[][] {
  return rows.map((r) => [
    r.no, r.name, r.ic, r.taxNo, r.leavingDate, r.finalMonth,
    r.finalNet === null ? '' : num2(r.finalNet), r.reason,
  ]);
}

/** Full CP21 CSV text (header + rows). */
export function cp21Csv(rows: Cp21Row[]): string {
  return toCsv(CP21_HEADERS, cp21CsvRows(rows));
}

// ─────────────────────────────────────────────────────────────────────────────
// Due dates + readiness checklist
// ─────────────────────────────────────────────────────────────────────────────

export interface YearEndDeadlines {
  /** ISO date Form E + CP8D are statutorily due: 31 March of year + 1. */
  formEDue: string;
  /** ISO date of the typical e-Filing grace deadline: 30 April of year + 1. */
  eFileGrace: string;
  /** Whole days from today to each deadline (negative = overdue). */
  daysToFormEDue: number;
  daysToEFileGrace: number;
}

/** Form E / CP8D filing deadlines for a year of assessment. */
export function yearEndDeadlines(year: string | number, today: Date = new Date()): YearEndDeadlines {
  const next = Number(year) + 1;
  const due = new Date(next, 2, 31); // 31 March
  const grace = new Date(next, 3, 30); // 30 April
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = (d: Date) => Math.round((d.getTime() - todayMid.getTime()) / 86_400_000);
  return {
    formEDue: `${next}-03-31`,
    eFileGrace: `${next}-04-30`,
    daysToFormEDue: days(due),
    daysToEFileGrace: days(grace),
  };
}

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** Employees employed at any point during `year` (join/leaver aware). */
export function employedDuringYear(employees: Employee[], year: string | number): Employee[] {
  const y = String(year);
  return employees.filter(
    (e) =>
      e.joinDate.slice(0, 4) <= y && (!e.resignDate || e.resignDate.slice(0, 4) >= y),
  );
}

/**
 * Pre-filing readiness checklist for the year-end pack: employer statutory
 * numbers, finalized-run coverage, employee coverage, and LHDN-critical IDs.
 */
export function buildReadinessChecklist(input: {
  year: string | number;
  employees: Employee[];
  totals: YearEndEmployeeTotals[];
  runs: PayrollRun[];
  payslips: Payslip[];
  settings?: Settings;
  today?: Date;
}): ReadinessItem[] {
  const { year, employees, totals, runs, payslips, settings } = input;
  const y = String(year);
  const items: ReadinessItem[] = [];

  // 1 — Employer statutory numbers needed on Form E / CP8D.
  const missingEmployer: string[] = [];
  if (!settings?.taxEmployerNo?.trim()) missingEmployer.push('income tax employer (E) no.');
  if (!settings?.epfEmployerNo?.trim()) missingEmployer.push('EPF employer no.');
  if (!settings?.socsoEmployerNo?.trim()) missingEmployer.push('SOCSO employer no.');
  items.push({
    key: 'employer-numbers',
    label: 'Employer statutory numbers',
    ok: missingEmployer.length === 0,
    detail:
      missingEmployer.length === 0
        ? 'E no., EPF and SOCSO employer numbers are on file.'
        : `Missing: ${missingEmployer.join(', ')} — fill them in under Settings.`,
  });

  // 2 — Months without a finalized run (draft or absent).
  const expected = expectedMonths(y, runs, payslips, input.today ?? new Date());
  const finalizedMks = new Set(
    runs.filter((r) => r.status === 'finalized' && r.monthKey.startsWith(y)).map((r) => r.monthKey),
  );
  const missing = expected.filter((mk) => !finalizedMks.has(mk));
  items.push({
    key: 'months-finalized',
    label: 'Months with finalized runs',
    ok: expected.length > 0 && missing.length === 0,
    detail:
      expected.length === 0
        ? `No payroll activity recorded in ${y} yet.`
        : missing.length === 0
          ? `All ${expected.length} expected month(s) are finalized.`
          : `Not finalized: ${missing.join(', ')} — finalize or run them before filing.`,
  });

  // 3 — Employees of the year with no finalized payslip.
  const covered = new Set(totals.map((t) => t.employeeId));
  const noSlips = employedDuringYear(employees, y).filter((e) => !covered.has(e.id));
  items.push({
    key: 'employee-coverage',
    label: 'Employees with year payslips',
    ok: noSlips.length === 0,
    detail:
      noSlips.length === 0
        ? 'Every employee of the year has at least one finalized payslip.'
        : `${noSlips.length} employee(s) with no finalized payslip in ${y}: ${noSlips
            .slice(0, 4)
            .map((e) => e.name)
            .join(', ')}${noSlips.length > 4 ? '…' : ''}`,
  });

  // 4 — LHDN-critical employee IDs (IC + income tax no.) on covered employees.
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const missingIds = totals.filter((t) => {
    const emp = empMap.get(t.employeeId);
    return !emp || !emp.ic?.trim() || !emp.taxNo?.trim();
  });
  items.push({
    key: 'employee-ids',
    label: 'Employee NRIC & income tax numbers',
    ok: missingIds.length === 0,
    detail:
      missingIds.length === 0
        ? 'Every CP8D row has an NRIC and an income tax number.'
        : `${missingIds.length} employee(s) missing NRIC or income tax no. — LHDN rejects incomplete CP8D rows.`,
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch payslip distribution (BatchPayslips page)
// ─────────────────────────────────────────────────────────────────────────────

export interface DistributionProgress {
  total: number;
  distributed: number;
  pending: number;
  /** 0–100; 0 when the run has no payslips. */
  percent: number;
}

/** Distribution status of a run's payslips (payslip.distributedAt). */
export function distributionProgress(slips: Payslip[]): DistributionProgress {
  const total = slips.length;
  const distributed = slips.filter((p) => !!p.distributedAt).length;
  return {
    total,
    distributed,
    pending: total - distributed,
    percent: total === 0 ? 0 : Math.round((distributed / total) * 100),
  };
}

export interface PayslipPdfInput {
  run: PayrollRun;
  /** Payslips to render — one employee per page, in the order given. */
  slips: Payslip[];
  employees: Employee[];
  departments: Department[];
  positions: Position[];
  settings?: Settings;
  /** When the PDF is generated (footer stamp). Defaults to now. */
  generatedAt?: Date;
}

export interface PayslipPdfResult {
  fileName: string;
  pageCount: number;
}

/** '2026-03' → 'March 2026' (local copy — helpers.ts is pages-owned). */
function pdfMonthLabel(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  if (!y || !m) return mk;
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/**
 * Render ONE multi-page payslip PDF (1 employee per page) for a finalized run,
 * mirroring the itemized PayslipPage layout: company header, employee +
 * statutory numbers, earnings / deductions / reimbursements, employer box,
 * YTD box, net pay, refNo. jsPDF is dynamically imported so the ~400 kB
 * parser cost only lands when HR actually exports.
 *
 * Returns the file name + page count; the caller triggers `doc.save` via the
 * returned payload — here the doc is saved inside for a single awaited call.
 */
export async function downloadPayslipsPdf(input: PayslipPdfInput): Promise<PayslipPdfResult> {
  const { jsPDF } = await import('jspdf');
  const { run, slips, employees, departments, positions, settings } = input;
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const deptMap = new Map(departments.map((d) => [d.id, d]));
  const posMap = new Map(positions.map((p) => [p.id, p]));
  const generatedAt = input.generatedAt ?? new Date();

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const PAGE_W = 210;
  const MARGIN = 14;
  const CW = PAGE_W - MARGIN * 2; // content width
  const COL_GAP = 8;
  const COL_W = (CW - COL_GAP) / 2;
  const RIGHT_X = MARGIN + COL_W + COL_GAP;

  const money = (n: number) => fmtRM(n);

  /** Label + right-aligned amount row inside a column. Returns next y. */
  function amountRow(
    x: number, w: number, y: number, label: string, amount: number,
    opts: { bold?: boolean; topBorder?: boolean; small?: boolean } = {},
  ): number {
    const size = opts.small ? 7.5 : 8.5;
    doc.setFontSize(size);
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    if (opts.topBorder) {
      doc.setDrawColor(160);
      doc.line(x, y - 3, x + w, y - 3);
    }
    doc.text(label, x, y);
    doc.text(money(amount), x + w, y, { align: 'right' });
    return y + (opts.small ? 4 : 4.6);
  }

  function sectionTitle(x: number, y: number, text: string): number {
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text(text, x, y);
    return y + 4.5;
  }

  function kvPair(x: number, y: number, label: string, value: string): void {
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120);
    doc.text(label.toUpperCase(), x, y);
    doc.setFontSize(8.5);
    doc.setTextColor(30);
    doc.text(value || '—', x, y + 3.2);
  }

  slips.forEach((slip, idx) => {
    if (idx > 0) doc.addPage();
    const emp = empMap.get(slip.employeeId);
    const dept = emp ? deptMap.get(emp.departmentId) : undefined;
    const pos = emp ? posMap.get(emp.positionId) : undefined;

    // ── Company header ───────────────────────────────────────────────
    let y = 18;
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text(settings?.companyName ?? 'ASM Tech Sdn Bhd', MARGIN, y);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110);
    doc.text(settings?.companyRegNo ?? '', MARGIN, y + 4);
    if (settings?.address) {
      doc.text(doc.splitTextToSize(settings.address, 90) as string[], MARGIN, y + 8);
    }
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('PAYSLIP', MARGIN + CW, y, { align: 'right' });
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110);
    doc.text(pdfMonthLabel(slip.monthKey), MARGIN + CW, y + 4.5, { align: 'right' });
    doc.setFontSize(6.5);
    doc.text('Itemized payslip — Employment Act 1955, s.25A', MARGIN + CW, y + 8.5, {
      align: 'right',
    });

    y = 33;
    doc.setDrawColor(180);
    doc.line(MARGIN, y, MARGIN + CW, y);

    // ── Employee + statutory numbers (3 columns of label/value) ──────
    const [wy, wm] = slip.monthKey.split('-').map(Number);
    const wagePeriod =
      wy && wm
        ? `${fmtDate(new Date(wy, wm - 1, 1))} – ${fmtDate(new Date(wy, wm, 0))}`
        : pdfMonthLabel(slip.monthKey);
    const colX = [MARGIN, MARGIN + CW / 3, MARGIN + (2 * CW) / 3];
    y += 6;
    kvPair(colX[0]!, y, 'Payslip no.', slip.refNo ?? slip.id);
    kvPair(colX[1]!, y, 'Employee', emp?.name ?? slip.employeeId);
    kvPair(colX[2]!, y, 'NRIC / passport', emp?.ic ?? '—');
    y += 9;
    kvPair(colX[0]!, y, 'Department', dept?.name ?? '—');
    kvPair(colX[1]!, y, 'Position', pos?.title ?? '—');
    kvPair(colX[2]!, y, 'Wage period', wagePeriod);
    y += 9;
    kvPair(colX[0]!, y, 'EPF no.', emp?.epfNo ?? '—');
    kvPair(colX[1]!, y, 'SOCSO no.', emp?.socsoNo ?? '—');
    kvPair(colX[2]!, y, 'Income tax no.', emp?.taxNo ?? '—');
    y += 9;
    kvPair(colX[0]!, y, 'Bank', emp ? `${emp.bankName} ${emp.bankAccount}`.trim() : '—');
    y += 10;

    // ── Earnings (left) + Deductions (right) ─────────────────────────
    const earnings = slip.lines.filter((l) => l.kind === 'earning' && !l.nonStatutory);
    const reimbursements = slip.lines.filter((l) => l.kind === 'earning' && l.nonStatutory);
    const deductions = slip.lines.filter((l) => l.kind === 'deduction');
    const employer = slip.lines.filter((l) => l.kind === 'employer');
    const infoLines = slip.lines.filter((l) => l.kind === 'info');
    const totalDeductions = round2(
      slip.epfEmployee + slip.socsoEmployee + slip.eisEmployee + slip.pcb +
        slip.unpaidLeaveDeduction + (slip.adjustmentDeductions ?? 0),
    );
    const employerTotal = round2(
      slip.epfEmployer + slip.socsoEmployer + slip.eisEmployer + slip.hrdLevy,
    );

    let ly = sectionTitle(MARGIN, y, 'Earnings');
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120);
    if (slip.otHours > 0) {
      doc.text(`Overtime worked this wage period: ${slip.otHours}h`, MARGIN, ly - 1);
      ly += 3.5;
    }
    for (const info of infoLines) {
      doc.text(doc.splitTextToSize(info.label, COL_W) as string[], MARGIN, ly - 1);
      ly += 3.5;
    }
    doc.setTextColor(30);
    for (const l of earnings) ly = amountRow(MARGIN, COL_W, ly, l.label, l.amount);
    ly = amountRow(MARGIN, COL_W, ly + 1.5, 'Gross pay', slip.grossPay, {
      bold: true, topBorder: true,
    });

    let ry = sectionTitle(RIGHT_X, y, 'Deductions');
    for (const l of deductions) {
      ry = amountRow(RIGHT_X, COL_W, ry, l.label, Math.abs(l.amount));
    }
    ry = amountRow(RIGHT_X, COL_W, ry + 1.5, 'Total deductions', totalDeductions, {
      bold: true, topBorder: true,
    });

    y = Math.max(ly, ry) + 4;

    // ── Reimbursements (non-statutory) ───────────────────────────────
    if (reimbursements.length > 0) {
      y = sectionTitle(MARGIN, y, 'Reimbursements (non-statutory)');
      doc.setFontSize(6.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(
        'Claim reimbursements — not subject to EPF / SOCSO / EIS / PCB and excluded from gross pay.',
        MARGIN, y - 1,
      );
      doc.setTextColor(30);
      y += 3.5;
      for (const l of reimbursements) y = amountRow(MARGIN, COL_W, y, l.label, l.amount);
      y = amountRow(MARGIN, COL_W, y + 1.5, 'Total reimbursements', slip.claimsTotal, {
        bold: true, topBorder: true,
      });
      y += 4;
    }

    // ── Net pay band ─────────────────────────────────────────────────
    doc.setFillColor(252, 246, 232); // warm amber tint
    doc.setDrawColor(220, 200, 170);
    doc.roundedRect(MARGIN, y - 4.5, CW, 13, 2, 2, 'FD');
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120);
    doc.text('NET PAY', MARGIN + 4, y + 1);
    doc.setFontSize(6.5);
    doc.text(`incl. ${money(slip.claimsTotal)} claim reimbursements`, MARGIN + 4, y + 5);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text(money(slip.netPay), MARGIN + CW - 4, y + 3.5, { align: 'right' });
    y += 13;

    // ── Employer contributions (left box) + YTD (right box) ──────────
    // Content is rendered first and the borders are stroked around the
    // measured bottoms, so the box always encloses every row.
    const boxTop = y + 1.5;

    let by = boxTop + 5;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('Employer contributions (not deducted from pay)', MARGIN + 3, by);
    by += 2.5;
    for (const l of employer) {
      by = amountRow(MARGIN + 3, COL_W - 6, by + 1.5, l.label, l.amount, { small: true });
    }
    by = amountRow(
      MARGIN + 3, COL_W - 6, by + 2, 'Total employer contributions', employerTotal,
      { bold: true, topBorder: true, small: true },
    );
    by = amountRow(
      MARGIN + 3, COL_W - 6, by + 1.5, 'Total employer cost', slip.employerCost,
      { bold: true, small: true },
    );

    let cy = boxTop + 5;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text(`Year to date (${slip.monthKey.slice(0, 4)})`, RIGHT_X + 3, cy);
    cy += 2.5;
    cy = amountRow(RIGHT_X + 3, COL_W - 6, cy + 1.5, 'Gross remuneration', slip.ytd.gross, { small: true });
    cy = amountRow(RIGHT_X + 3, COL_W - 6, cy, 'EPF (employee)', slip.ytd.epf, { small: true });
    cy = amountRow(RIGHT_X + 3, COL_W - 6, cy, 'SOCSO + EIS (employee)', slip.ytd.socso, { small: true });
    cy = amountRow(RIGHT_X + 3, COL_W - 6, cy, 'PCB / MTD deducted', slip.ytd.pcb, { small: true });
    cy = amountRow(RIGHT_X + 3, COL_W - 6, cy, 'Net pay', slip.ytd.net, { small: true });

    // Stroke-only rectangles drawn last: measured from the content bottoms.
    const boxH = Math.max(by, cy) - boxTop + 1.5;
    doc.setDrawColor(190);
    doc.rect(MARGIN, boxTop, COL_W, boxH);
    doc.rect(RIGHT_X, boxTop, COL_W, boxH);

    // ── Footer ───────────────────────────────────────────────────────
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(130);
    const footer =
      `Generated ${fmtDate(generatedAt)} by ${settings?.companyName ?? 'ASM Tech Sdn Bhd'} HRMS. ` +
      'Figures per EPF Act 1991, SOCSO Act 1969, EIS Act 2017, PSMB Act 2001 and LHDN PCB specification. ' +
      'Computer-generated — no signature required.';
    doc.text(doc.splitTextToSize(footer, CW) as string[], MARGIN, 285);
    doc.text(`Page ${idx + 1} of ${slips.length}`, MARGIN + CW, 293, { align: 'right' });
  });

  const fileName = `payslips-${run.monthKey}.pdf`;
  doc.save(fileName);
  return { fileName, pageCount: slips.length };
}
