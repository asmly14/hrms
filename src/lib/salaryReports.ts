/**
 * Salary report — multi-month salary analysis over FINALIZED payroll runs.
 *
 * Pure aggregation over STORED payslips — no statutory rate is ever recomputed
 * here (rates live in lib/statutory.ts; the payslips are the single source of
 * truth). Only payslips whose run is 'finalized' count: draft runs are
 * internal HR review material and never reach a cross-period salary report
 * (same rule as lib/yearEnd.ts and the dept-cost rollup).
 *
 * Period presets: monthly / quarterly (Q1–Q4) / half-yearly (H1/H2) / yearly /
 * custom month range — every preset resolves to an inclusive ascending list of
 * 'YYYY-MM' months via `resolveSalaryPeriod` (pure, unit-tested).
 *
 * `aggregateSalaryReport` is the array-in / value-out data-model builder the
 * vitest suite exercises; the page (src/pages/reports/SalaryReportPage.tsx)
 * wires `useCollection` arrays in, and lib/salaryReportPdf.ts renders the
 * model to PDF. CSV section packs are built here via @/lib/csv.
 */
import { round2 } from './utils';
import { toCsv, type CsvValue } from './csv';
import type {
  Company, Department, Employee, PayrollRun, Payslip, Settings,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Period selection — presets → inclusive month windows
// ─────────────────────────────────────────────────────────────────────────────

export type SalaryPeriodPreset = 'monthly' | 'quarterly' | 'half-yearly' | 'yearly' | 'custom';

/** Raw picker state from the UI (all fields optional per preset). */
export interface SalaryPeriodSelection {
  preset: SalaryPeriodPreset;
  /** monthly: 'YYYY-MM'. */
  month?: string;
  /** quarterly: 1–4 (+ year). */
  quarter?: 1 | 2 | 3 | 4;
  /** half-yearly: 1 | 2 (+ year). */
  half?: 1 | 2;
  /** quarterly / half-yearly / yearly. */
  year?: number;
  /** custom: inclusive 'YYYY-MM' range. */
  from?: string;
  to?: string;
}

/** A resolved, validated reporting window. */
export interface SalaryPeriod {
  preset: SalaryPeriodPreset;
  /** Every month of the window, ascending 'YYYY-MM'. */
  months: string[];
  /** First month of the window ('YYYY-MM'). */
  from: string;
  /** Last month of the window ('YYYY-MM'). */
  to: string;
  /** Human label: 'March 2026' · 'Q1 2026 (Jan – Mar)' · 'H2 2025 (Jul – Dec)' · '2026' · 'Nov 2025 – Feb 2026'. */
  label: string;
  /** Filename-safe tag: '2026-03' · '2026-Q1' · '2026-H2' · '2026' · '2025-11_2026-02'. */
  fileTag: string;
}

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Strict 'YYYY-MM' validation (rejects '2026-13', '2026-1', garbage). */
export function isMonthKey(mk: string | undefined): mk is string {
  return typeof mk === 'string' && MONTH_KEY_RE.test(mk);
}

/** '2026-12' → '2027-01'. */
function nextMonthKey(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Inclusive ascending month window; EMPTY when from > to. */
export function monthsBetween(from: string, to: string): string[] {
  if (!isMonthKey(from) || !isMonthKey(to) || from > to) return [];
  const out: string[] = [];
  for (let mk = from; mk <= to; mk = nextMonthKey(mk)) out.push(mk);
  return out;
}

/** '2026-03' → 'March 2026' (local copy — the other label helper is pages-owned). */
export function salaryMonthLabel(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  if (!y || !m) return mk;
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** '2026-03' → 'Mar 26' (tight axis/tooltip label). */
export function salaryMonthShort(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  if (!y || !m) return mk;
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

const MONTH_SHORTS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Inclusive window label across months: 'Nov 2025 – Feb 2026' (same year: 'Jan – Mar 2026'). */
function rangeLabel(from: string, to: string): string {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (from === to) return salaryMonthLabel(from);
  if (fy === ty) return `${MONTH_SHORTS[fm - 1]} – ${MONTH_SHORTS[tm - 1]} ${ty}`;
  return `${MONTH_SHORTS[fm - 1]} ${fy} – ${MONTH_SHORTS[tm - 1]} ${ty}`;
}

/**
 * Resolve a preset selection into a validated month window. Returns null when
 * the selection is incomplete or invalid (UI keeps the generate button off).
 */
export function resolveSalaryPeriod(sel: SalaryPeriodSelection): SalaryPeriod | null {
  switch (sel.preset) {
    case 'monthly': {
      if (!isMonthKey(sel.month)) return null;
      return {
        preset: sel.preset,
        months: [sel.month],
        from: sel.month,
        to: sel.month,
        label: salaryMonthLabel(sel.month),
        fileTag: sel.month,
      };
    }
    case 'quarterly': {
      const q = sel.quarter;
      const y = sel.year;
      if (!q || q < 1 || q > 4 || !y || !Number.isInteger(y)) return null;
      const startMonth = (q - 1) * 3 + 1;
      const from = `${y}-${String(startMonth).padStart(2, '0')}`;
      const months = monthsBetween(from, `${y}-${String(startMonth + 2).padStart(2, '0')}`);
      return {
        preset: sel.preset,
        months,
        from: months[0]!,
        to: months[months.length - 1]!,
        label: `Q${q} ${y} (${MONTH_SHORTS[startMonth - 1]} – ${MONTH_SHORTS[startMonth + 1]})`,
        fileTag: `${y}-Q${q}`,
      };
    }
    case 'half-yearly': {
      const h = sel.half;
      const y = sel.year;
      if ((h !== 1 && h !== 2) || !y || !Number.isInteger(y)) return null;
      const from = `${y}-${h === 1 ? '01' : '07'}`;
      const months = monthsBetween(from, `${y}-${h === 1 ? '06' : '12'}`);
      return {
        preset: sel.preset,
        months,
        from: months[0]!,
        to: months[months.length - 1]!,
        label: `H${h} ${y} (${MONTH_SHORTS[h === 1 ? 0 : 6]} – ${MONTH_SHORTS[h === 1 ? 5 : 11]})`,
        fileTag: `${y}-H${h}`,
      };
    }
    case 'yearly': {
      const y = sel.year;
      if (!y || !Number.isInteger(y) || y < 1900 || y > 2200) return null;
      const months = monthsBetween(`${y}-01`, `${y}-12`);
      return {
        preset: sel.preset,
        months,
        from: `${y}-01`,
        to: `${y}-12`,
        label: `Year ${y}`,
        fileTag: String(y),
      };
    }
    case 'custom': {
      if (!isMonthKey(sel.from) || !isMonthKey(sel.to)) return null;
      const months = monthsBetween(sel.from, sel.to);
      if (months.length === 0) return null; // from after to
      return {
        preset: sel.preset,
        months,
        from: sel.from,
        to: sel.to,
        label: rangeLabel(sel.from, sel.to),
        fileTag: `${sel.from}_${sel.to}`,
      };
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report model
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the monthly trend (one per period month, finalized or not). */
export interface SalaryMonthlyRow {
  month: string;        // 'YYYY-MM'
  label: string;        // 'Mar 26'
  /** A finalized payroll run exists for this month. */
  finalized: boolean;
  /** Finalized payslips counted this month. */
  payslips: number;
  /** Unique employees paid this month. */
  headcount: number;
  gross: number;
  net: number;
  employerCost: number;
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  hrdLevy: number;
  /** Loan installments actually deducted (Σ payslip loanDeductionTotal). */
  loans: number;
  /** Non-statutory cash reimbursements (claims + adjustment/benefit reimbursements). */
  claims: number;
}

/** One month inside an employee row's expansion (mini breakdown). */
export interface SalaryEmployeeMonth {
  month: string;        // 'YYYY-MM'
  gross: number;
  net: number;
  employerCost: number;
  epfEmployee: number;
  pcb: number;
  loans: number;
}

/** One row of the per-employee table (totals across the period). */
export interface SalaryEmployeeRow {
  employeeId: string;
  /** Human staff number (falls back to the internal id). */
  employeeNo: string;
  name: string;
  department: string;
  /** Finalized months the employee was paid in (≤ period length). */
  monthsPaid: number;
  gross: number;
  ot: number;
  allowances: number;
  epfEmployee: number;
  socsoEmployee: number;
  eisEmployee: number;
  pcb: number;
  loans: number;
  net: number;
  employerCost: number;
  /** gross ÷ monthsPaid — the salary-band histogram value. */
  avgMonthlyGross: number;
  /** Per-month mini breakdown, ascending (only months actually paid). */
  monthly: SalaryEmployeeMonth[];
}

/** One row of the department aggregation. */
export interface SalaryDeptRow {
  departmentId: string;
  name: string;
  /** Unique employees paid in the period. */
  employees: number;
  gross: number;
  net: number;
  employerCost: number;
  /** Share of the period's total employer cost, percent with 1 decimal. */
  pctOfCost: number;
}

/** Salary-band definition (bounds) — counts are filled by the aggregation. */
export interface SalaryBandDef {
  label: string;
  /** Exclusive lower bound (the first band starts at 0 inclusive). */
  min: number;
  /** Inclusive upper bound; null = no cap. */
  max: number | null;
}

export interface SalaryBand extends SalaryBandDef {
  /** Employees whose average monthly gross lands in the band. */
  count: number;
}

/**
 * Average-monthly-gross bands for the distribution histogram. Upper bounds are
 * INCLUSIVE (avg 3,000.00 lands in 'RM 2,000 – 3,000', 3,000.01 in the next
 * band); the last band is uncapped.
 */
export const SALARY_BAND_DEFS: SalaryBandDef[] = [
  { label: '≤ RM 2,000', min: 0, max: 2000 },
  { label: 'RM 2,000 – 3,000', min: 2000, max: 3000 },
  { label: 'RM 3,000 – 5,000', min: 3000, max: 5000 },
  { label: 'RM 5,000 – 8,000', min: 5000, max: 8000 },
  { label: 'RM 8,000 +', min: 8000, max: null },
];

/** Band index for an average monthly gross (upper bound inclusive). */
export function salaryBandIndex(avgMonthlyGross: number): number {
  const v = Math.max(0, avgMonthlyGross);
  for (let i = 0; i < SALARY_BAND_DEFS.length; i++) {
    const b = SALARY_BAND_DEFS[i]!;
    if (v > b.min && (b.max === null || v <= b.max)) return i;
  }
  // v === 0 lands in the first band (min 0 is inclusive there).
  return 0;
}

/** The full data model the page, the PDF and the CSV pack all render. */
export interface SalaryReportModel {
  period: SalaryPeriod;
  generatedAt: Date;
  // ── Company header (Company record first, Settings fallback) ──
  companyName: string;
  companyRegNo: string;
  companyCode: string;
  logoText: string;
  accentColor: string;
  // ── Coverage ──
  /** Months in the window (period.months.length). */
  expectedMonths: number;
  /** Period months that have a finalized run, ascending. */
  finalizedMonths: string[];
  /** Period months WITHOUT a finalized run (gap warning), ascending. */
  missingMonths: string[];
  hasGaps: boolean;
  /** Unique employees with ≥1 finalized payslip in the window. */
  employeesPaid: number;
  /** Finalized payslips counted. */
  payslipCount: number;
  totals: {
    gross: number;
    net: number;
    employerCost: number;
    epfEmployee: number;
    epfEmployer: number;
    socsoEmployee: number;
    socsoEmployer: number;
    eisEmployee: number;
    eisEmployer: number;
    pcb: number;
    hrdLevy: number;
    /** Loan installments recovered from net pay. */
    loans: number;
    /** Claims + non-statutory cash reimbursements paid out in net. */
    claims: number;
  };
  monthly: SalaryMonthlyRow[];
  /** Name-sorted per-employee period totals. */
  employees: SalaryEmployeeRow[];
  /** Employer-cost-desc department rollup. */
  departments: SalaryDeptRow[];
  bands: SalaryBand[];
  /** Top earners by period gross (≤ 10), name as tiebreak. */
  topEarners: SalaryEmployeeRow[];
}

/** Inputs for the pure aggregation — arrays in, value out, no storage reads. */
export interface SalaryReportInput {
  period: SalaryPeriod;
  runs: PayrollRun[];
  payslips: Payslip[];
  employees: Employee[];
  departments: Department[];
  /** Active Company record — branding + registration number. */
  company?: Company;
  settings?: Settings;
  /** Report stamp; defaults to now. */
  generatedAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the salary-report model for a resolved period. Pure — the same arrays
 * always produce the same model (given a fixed `generatedAt`).
 */
export function aggregateSalaryReport(input: SalaryReportInput): SalaryReportModel {
  const { period, runs, employees, departments } = input;
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const deptMap = new Map(departments.map((d) => [d.id, d]));

  // ── Finalized scope: a payslip counts only when its run is finalized ──
  const statusByRun = new Map(runs.map((r) => [r.id, r.status]));
  const finalizedRunMonths = new Set(
    runs.filter((r) => r.status === 'finalized').map((r) => r.monthKey),
  );
  const monthSet = new Set(period.months);
  const slips = input.payslips.filter(
    (p) => monthSet.has(p.monthKey) && statusByRun.get(p.runId) === 'finalized',
  );

  // ── Coverage / gap detection ──
  const finalizedMonths = period.months.filter((m) => finalizedRunMonths.has(m));
  const missingMonths = period.months.filter((m) => !finalizedRunMonths.has(m));

  // ── Headline totals (Σ stored payslip figures, each rounded to the sen) ──
  const sum = (fn: (p: Payslip) => number) => round2(slips.reduce((s, p) => s + fn(p), 0));
  const claimsOf = (p: Payslip) =>
    p.claimsTotal + (p.adjustmentReimbursements ?? 0) + (p.benefitReimbursements ?? 0);
  const loansOf = (p: Payslip) => p.loanDeductionTotal ?? 0;
  const totals: SalaryReportModel['totals'] = {
    gross: sum((p) => p.grossPay),
    net: sum((p) => p.netPay),
    employerCost: sum((p) => p.employerCost),
    epfEmployee: sum((p) => p.epfEmployee),
    epfEmployer: sum((p) => p.epfEmployer),
    socsoEmployee: sum((p) => p.socsoEmployee),
    socsoEmployer: sum((p) => p.socsoEmployer),
    eisEmployee: sum((p) => p.eisEmployee),
    eisEmployer: sum((p) => p.eisEmployer),
    pcb: sum((p) => p.pcb),
    hrdLevy: sum((p) => p.hrdLevy),
    loans: sum(loansOf),
    claims: sum(claimsOf),
  };

  // ── Monthly trend rows (one per period month; zero rows for gaps) ──
  const monthly: SalaryMonthlyRow[] = period.months.map((month) => {
    const ms = slips.filter((p) => p.monthKey === month);
    const msum = (fn: (p: Payslip) => number) => round2(ms.reduce((s, p) => s + fn(p), 0));
    return {
      month,
      label: salaryMonthShort(month),
      finalized: finalizedRunMonths.has(month),
      payslips: ms.length,
      headcount: new Set(ms.map((p) => p.employeeId)).size,
      gross: msum((p) => p.grossPay),
      net: msum((p) => p.netPay),
      employerCost: msum((p) => p.employerCost),
      epfEmployee: msum((p) => p.epfEmployee),
      epfEmployer: msum((p) => p.epfEmployer),
      socsoEmployee: msum((p) => p.socsoEmployee),
      socsoEmployer: msum((p) => p.socsoEmployer),
      eisEmployee: msum((p) => p.eisEmployee),
      eisEmployer: msum((p) => p.eisEmployer),
      pcb: msum((p) => p.pcb),
      hrdLevy: msum((p) => p.hrdLevy),
      loans: msum(loansOf),
      claims: msum(claimsOf),
    };
  });

  // ── Per-employee period totals + monthly mini breakdown ──
  interface EmpAcc extends Omit<SalaryEmployeeRow, 'avgMonthlyGross' | 'monthly'> {
    monthly: SalaryEmployeeMonth[];
  }
  const byEmp = new Map<string, EmpAcc>();
  const monthAsc = (a: string, b: string) => a.localeCompare(b);
  for (const p of [...slips].sort((a, b) => monthAsc(a.monthKey, b.monthKey))) {
    const emp = empMap.get(p.employeeId);
    let acc = byEmp.get(p.employeeId);
    if (!acc) {
      acc = {
        employeeId: p.employeeId,
        employeeNo: emp?.employeeNo ?? p.employeeId,
        name: emp?.name ?? p.employeeId,
        department: emp ? (deptMap.get(emp.departmentId)?.name ?? 'Unassigned') : 'Unknown',
        monthsPaid: 0,
        gross: 0, ot: 0, allowances: 0,
        epfEmployee: 0, socsoEmployee: 0, eisEmployee: 0, pcb: 0,
        loans: 0, net: 0, employerCost: 0,
        monthly: [],
      };
      byEmp.set(p.employeeId, acc);
    }
    acc.monthsPaid += 1;
    acc.gross = round2(acc.gross + p.grossPay);
    acc.ot = round2(acc.ot + p.otPay);
    acc.allowances = round2(acc.allowances + p.allowances);
    acc.epfEmployee = round2(acc.epfEmployee + p.epfEmployee);
    acc.socsoEmployee = round2(acc.socsoEmployee + p.socsoEmployee);
    acc.eisEmployee = round2(acc.eisEmployee + p.eisEmployee);
    acc.pcb = round2(acc.pcb + p.pcb);
    acc.loans = round2(acc.loans + loansOf(p));
    acc.net = round2(acc.net + p.netPay);
    acc.employerCost = round2(acc.employerCost + p.employerCost);
    acc.monthly.push({
      month: p.monthKey,
      gross: round2(p.grossPay),
      net: round2(p.netPay),
      employerCost: round2(p.employerCost),
      epfEmployee: round2(p.epfEmployee),
      pcb: round2(p.pcb),
      loans: round2(loansOf(p)),
    });
  }
  const employeeRows: SalaryEmployeeRow[] = [...byEmp.values()]
    .map((a) => ({
      ...a,
      avgMonthlyGross: a.monthsPaid > 0 ? round2(a.gross / a.monthsPaid) : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId));

  // ── Department rollup (unique employees per dept, employer-cost share) ──
  interface DeptAcc {
    departmentId: string;
    name: string;
    empIds: Set<string>;
    gross: number;
    net: number;
    employerCost: number;
  }
  const byDept = new Map<string, DeptAcc>();
  for (const p of slips) {
    const emp = empMap.get(p.employeeId);
    const deptId = emp?.departmentId ?? '';
    let d = byDept.get(deptId);
    if (!d) {
      d = {
        departmentId: deptId,
        name: deptMap.get(deptId)?.name ?? 'Unassigned',
        empIds: new Set(),
        gross: 0, net: 0, employerCost: 0,
      };
      byDept.set(deptId, d);
    }
    d.empIds.add(p.employeeId);
    d.gross = round2(d.gross + p.grossPay);
    d.net = round2(d.net + p.netPay);
    d.employerCost = round2(d.employerCost + p.employerCost);
  }
  const deptRows: SalaryDeptRow[] = [...byDept.values()]
    .map((d) => ({
      departmentId: d.departmentId,
      name: d.name,
      employees: d.empIds.size,
      gross: d.gross,
      net: d.net,
      employerCost: d.employerCost,
      pctOfCost:
        totals.employerCost > 0
          ? Math.round((d.employerCost / totals.employerCost) * 1000) / 10
          : 0,
    }))
    .sort((a, b) => b.employerCost - a.employerCost || a.name.localeCompare(b.name));

  // ── Distribution: salary bands on average monthly gross ──
  const bands: SalaryBand[] = SALARY_BAND_DEFS.map((def) => ({ ...def, count: 0 }));
  for (const r of employeeRows) bands[salaryBandIndex(r.avgMonthlyGross)]!.count += 1;

  // ── Top earners (period gross desc, name tiebreak, ≤ 10) ──
  const topEarners = [...employeeRows]
    .sort((a, b) => b.gross - a.gross || a.name.localeCompare(b.name))
    .slice(0, 10);

  const company = input.company;
  const settings = input.settings;
  return {
    period,
    generatedAt: input.generatedAt ?? new Date(),
    companyName: company?.name ?? settings?.companyName ?? 'ASM Tech Sdn Bhd',
    companyRegNo: company?.regNo ?? settings?.companyRegNo ?? '',
    companyCode: company?.code ?? 'COMPANY',
    logoText: company?.branding.logoText ?? company?.code ?? 'HR',
    accentColor: company?.branding.accentColor ?? '#b45309',
    expectedMonths: period.months.length,
    finalizedMonths,
    missingMonths,
    hasGaps: missingMonths.length > 0,
    employeesPaid: employeeRows.length,
    payslipCount: slips.length,
    totals,
    monthly,
    employees: employeeRows,
    departments: deptRows,
    bands,
    topEarners,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV pack — one file per section (summary / employees / monthly / departments)
// ─────────────────────────────────────────────────────────────────────────────

/** Fixed 2-decimal money for files — never localized, never 'RM'-prefixed. */
const num2 = (n: number): string => n.toFixed(2);

/** Company-code fragment shared by every export filename ('asm tech!' → 'ASM-TECH'). */
export function salaryReportCompanyTag(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'COMPANY';
}

export interface SalaryCsvFile {
  /** e.g. 'Salary-Report-ASM-2026-Q1-employees.csv'. */
  filename: string;
  csv: string;
}

/**
 * Build the four-section CSV pack from the model: period summary, employee
 * register, monthly trend, department rollup. Money columns are fixed
 * 2-decimal (num2) so finance can diff files across periods.
 */
export function salaryReportCsvs(
  model: Pick<
    SalaryReportModel,
    'period' | 'companyName' | 'companyCode' | 'generatedAt' |
    'expectedMonths' | 'finalizedMonths' | 'missingMonths' | 'employeesPaid' |
    'payslipCount' | 'totals' | 'monthly' | 'employees' | 'departments'
  >,
): SalaryCsvFile[] {
  const tag = `Salary-Report-${salaryReportCompanyTag(model.companyCode)}-${model.period.fileTag}`;
  const t = model.totals;

  // ── 1) Summary — key/value pairs + coverage ──
  const summaryRows: CsvValue[][] = [
    ['Company', model.companyName],
    ['Period', model.period.label],
    ['First month', model.period.from],
    ['Last month', model.period.to],
    ['Expected months', model.expectedMonths],
    ['Finalized months', model.finalizedMonths.length],
    ['Missing (not finalized) months', model.missingMonths.length],
    ['Missing month list', model.missingMonths.join(' ')],
    ['Employees paid (unique)', model.employeesPaid],
    ['Payslips counted', model.payslipCount],
    ['Gross wages (RM)', num2(t.gross)],
    ['Net pay (RM)', num2(t.net)],
    ['Employer cost (RM)', num2(t.employerCost)],
    ['EPF employee (RM)', num2(t.epfEmployee)],
    ['EPF employer (RM)', num2(t.epfEmployer)],
    ['SOCSO employee (RM)', num2(t.socsoEmployee)],
    ['SOCSO employer (RM)', num2(t.socsoEmployer)],
    ['EIS employee (RM)', num2(t.eisEmployee)],
    ['EIS employer (RM)', num2(t.eisEmployer)],
    ['PCB / MTD (RM)', num2(t.pcb)],
    ['HRD Corp levy (RM)', num2(t.hrdLevy)],
    ['Loans recovered (RM)', num2(t.loans)],
    ['Claims & reimbursements (RM)', num2(t.claims)],
  ];

  // ── 2) Employees — per-employee period totals ──
  const employeeRows: CsvValue[][] = model.employees.map((r) => [
    r.employeeNo,
    r.name,
    r.department,
    r.monthsPaid,
    num2(r.gross),
    num2(r.ot),
    num2(r.allowances),
    num2(r.epfEmployee),
    num2(r.socsoEmployee),
    num2(r.eisEmployee),
    num2(r.pcb),
    num2(r.loans),
    num2(r.net),
    num2(r.employerCost),
    num2(r.avgMonthlyGross),
  ]);

  // ── 3) Monthly trend — one row per period month (gaps included, flagged) ──
  const monthlyRows: CsvValue[][] = model.monthly.map((m) => [
    m.month,
    m.finalized ? 'finalized' : 'not finalized (excluded)',
    m.payslips,
    m.headcount,
    num2(m.gross),
    num2(m.net),
    num2(m.employerCost),
    num2(m.epfEmployee),
    num2(m.epfEmployer),
    num2(m.socsoEmployee),
    num2(m.socsoEmployer),
    num2(m.eisEmployee),
    num2(m.eisEmployer),
    num2(m.pcb),
    num2(m.hrdLevy),
    num2(m.loans),
    num2(m.claims),
  ]);

  // ── 4) Departments ──
  const deptRows: CsvValue[][] = model.departments.map((d) => [
    d.name,
    d.employees,
    num2(d.gross),
    num2(d.net),
    num2(d.employerCost),
    d.pctOfCost.toFixed(1),
  ]);

  return [
    {
      filename: `${tag}-summary.csv`,
      csv: toCsv(['Field', 'Value'], summaryRows),
    },
    {
      filename: `${tag}-employees.csv`,
      csv: toCsv(
        [
          'Employee No', 'Employee', 'Department', 'Months paid',
          'Gross (RM)', 'OT (RM)', 'Allowances (RM)',
          'EPF ee (RM)', 'SOCSO ee (RM)', 'EIS ee (RM)', 'PCB (RM)',
          'Loans (RM)', 'Net (RM)', 'Employer cost (RM)', 'Avg monthly gross (RM)',
        ],
        employeeRows,
      ),
    },
    {
      filename: `${tag}-monthly-trend.csv`,
      csv: toCsv(
        [
          'Month', 'Status', 'Payslips', 'Headcount',
          'Gross (RM)', 'Net (RM)', 'Employer cost (RM)',
          'EPF ee (RM)', 'EPF er (RM)', 'SOCSO ee (RM)', 'SOCSO er (RM)',
          'EIS ee (RM)', 'EIS er (RM)', 'PCB (RM)', 'HRD levy (RM)',
          'Loans (RM)', 'Claims & reimbursements (RM)',
        ],
        monthlyRows,
      ),
    },
    {
      filename: `${tag}-departments.csv`,
      csv: toCsv(
        ['Department', 'Employees', 'Gross (RM)', 'Net (RM)', 'Employer cost (RM)', '% of cost'],
        deptRows,
      ),
    },
  ];
}
