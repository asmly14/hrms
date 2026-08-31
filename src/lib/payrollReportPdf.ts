/**
 * Organisation payroll report — ONE owner-facing PDF for a whole payroll run.
 *
 * Pure aggregation over the run's STORED payslips — no statutory rate is ever
 * recomputed here (rates live in lib/statutory.ts; the run's payslips are the
 * single source of truth, finalized or not). The PDF is rendered client-side
 * with jsPDF, dynamically imported so the ~400 kB parser cost only lands when
 * HR actually exports (same pattern as lib/yearEnd.ts batch payslips).
 *
 * Layout (multi-page A4):
 *  1. Cover summary — company header (logoText/accent from the active Company
 *     record), run month + cut-off window, generated timestamp, headline
 *     stats, statutory totals table, notes.
 *  2. Department breakdown — per-department headcount/gross/net/employer cost
 *     + a horizontal bar chart drawn with jsPDF primitives (no image libs).
 *  3. Employee register — full per-employee table, ~20 rows/page in LANDSCAPE
 *     with a repeated header, override/opt-out markers, totals row on the
 *     last page.
 *  4. Exceptions — engine warnings (below minimum wage, OT > 104h, …),
 *     missing statutory numbers / bank details, the statutory opt-out list
 *     with reasons, and the manual-adjustments summary.
 *
 * `aggregateOrgReport` is the pure data-model builder (arrays in, value out)
 * the vitest suite exercises; `buildOrgReport(runId)` wires the db
 * collections in; `renderOrgReportPdf` returns the jsPDF doc without saving
 * (node smoke tests), and `downloadOrgReportPdf` is the one-call UI entry.
 */
import { getActiveCompany, getCollection } from './db';
import { getPayrollCutoff } from './appSettings';
import { payrollPeriodFor } from './payrollEngine';
import { PRORATION_LABELS } from './workdays';
import { employeeValidationWarnings } from './yearEnd';
import { fmtDate, fmtRM, round2 } from './utils';
import type { jsPDF as JsPdfDoc } from 'jspdf';
import type {
  Company, Department, Employee, PayrollProrationMethod, PayrollRun, Payslip, Settings,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Data model
// ─────────────────────────────────────────────────────────────────────────────

/** Register markers — appended to the employee name, legend on the last page. */
export const MARKER_BASIC_OVERRIDE = '¹'; // basic 'Full amount' override applied
export const MARKER_SALARY_TYPE = '²';    // daily- or hourly-rated payslip
export const MARKER_OPT_OUT = '³';        // statutory opt-out (employee + employer zeroed)
export const MARKER_ADJUSTED = '†';       // manual adjustment lines present

/** Legend line printed under the register's totals row. */
export const ORG_REPORT_MARKER_LEGEND =
  `${MARKER_BASIC_OVERRIDE} basic overridden · ${MARKER_SALARY_TYPE} daily/hourly-rated · ` +
  `${MARKER_OPT_OUT} statutory opt-out · ${MARKER_ADJUSTED} manual adjustments`;

/** One row of the employee register (all amounts RM, rounded to the sen). */
export interface OrgReportEmployeeRow {
  employeeId: string;
  /** Human staff number (falls back to the internal id). */
  employeeNo: string;
  name: string;
  department: string;
  /** '26/26' (monthly, daysWorked/daysInBasis), '22 d' (daily), '176 h' (hourly). */
  daysLabel: string;
  basic: number;
  allowances: number;
  ot: number;
  gross: number;
  epfEmployee: number;
  socsoEmployee: number;
  eisEmployee: number;
  pcb: number;
  /** Non-statutory deduction adjustments (unpaid leave is already inside basic). */
  otherDeductions: number;
  net: number;
  employerCost: number;
  /** Register markers actually used on this row (subset of MARKER_*). */
  markers: string[];
  /** Human-readable footnote fragments behind the markers. */
  footnotes: string[];
}

/** One row of the department breakdown. */
export interface OrgReportDeptRow {
  departmentId: string;
  name: string;
  headcount: number;
  gross: number;
  net: number;
  employerCost: number;
  /** Share of the run's total employer cost, percent with 1 decimal. */
  pctOfTotalCost: number;
}

/** A single exceptions-page warning line. */
export interface OrgReportWarning {
  /** 'engine' = frozen on the run at run/finalize time; 'data' = computed now. */
  source: 'engine' | 'data';
  /** Employee display name (may be '' for run-level engine warnings). */
  employee: string;
  detail: string;
}

/** One employee's statutory opt-out entry (exceptions page). */
export interface OrgReportOptOut {
  employee: string;
  /** e.g. ['EPF', 'PCB'] — both shares of each scheme were zeroed. */
  schemes: string[];
  /** 'EPF: reason · PCB: —' — stored reasons, em-dash when none was recorded. */
  reason: string;
}

/** One employee's manual-adjustments entry (exceptions page). */
export interface OrgReportAdjustment {
  employee: string;
  lines: number;
  earnings: number;
  deductions: number;
  /** Non-statutory cash reimbursements (paid in net, outside gross). */
  reimbursements: number;
}

/** The full data model the PDF renders. */
export interface OrgReportModel {
  runId: string;
  monthKey: string;
  /** 'March 2026'. */
  monthLabel: string;
  status: PayrollRun['status'];
  runAt: string;
  runBy: string;
  finalizedAt?: string;
  generatedAt: Date;
  // ── Company header (Company record first, Settings fallback) ──
  companyName: string;
  companyRegNo: string;
  companyCode: string;
  logoText: string;
  accentColor: string;
  // ── Run context ──
  period: { start: string; end: string; cutoffDay: number };
  prorationMethod: PayrollProrationMethod;
  /** Human label of the proration method, e.g. 'calendar days'. */
  prorationLabel: string;
  // ── Headline stats ──
  headcount: number;
  totals: {
    basic: number;
    allowances: number;
    ot: number;
    gross: number;
    /** Σ EPF ee + SOCSO ee + EIS ee + PCB + deduction adjustments. */
    deductions: number;
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
    /** Non-statutory claim reimbursements (memo — paid in net, outside gross). */
    claims: number;
    /** Memo — already deducted inside the prorated basic, never re-subtracted. */
    unpaidLeave: number;
    adjustmentDeductions: number;
    adjustmentReimbursements: number;
  };
  averageNet: number;
  medianNet: number;
  departments: OrgReportDeptRow[];
  employees: OrgReportEmployeeRow[];
  warnings: OrgReportWarning[];
  optOuts: OrgReportOptOut[];
  adjustments: OrgReportAdjustment[];
}

/** Inputs for the pure aggregation — array-in / value-out, no storage reads. */
export interface OrgReportInput {
  run: PayrollRun;
  /** The run's payslips (pass exactly the slips to report on). */
  slips: Payslip[];
  employees: Employee[];
  departments: Department[];
  settings?: Settings;
  /** Active Company record — branding + registration number. */
  company?: Company;
  /** Report stamp; defaults to now. */
  generatedAt?: Date;
  /** Effective cut-off day; defaults to run.cutoffDay, then 25. */
  cutoffDay?: number;
}

/** '2026-03' → 'March 2026' (local copy — helpers.ts is pages-owned). */
function orgMonthLabel(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  if (!y || !m) return mk;
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Median of a numeric list (0 for empty), rounded to the sen. */
function medianOf(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? round2(s[mid]!) : round2((s[mid - 1]! + s[mid]!) / 2);
}

/** '26/26' for monthly payslips, '22 d' / '176 h' for daily/hourly-rated. */
function daysLabelFor(p: Payslip): string {
  const st = p.salaryTypeUsed ?? 'monthly';
  if (st === 'monthly') {
    return p.daysWorked !== undefined && p.daysInBasis !== undefined
      ? `${p.daysWorked}/${p.daysInBasis}`
      : '—';
  }
  return p.workedQty !== undefined ? `${p.workedQty} ${st === 'daily' ? 'd' : 'h'}` : '—';
}

/** Opted-out statutory schemes of a payslip, upper-case labels. */
function optOutSchemesOf(p: Payslip): string[] {
  return [
    p.excludeEpf ? 'EPF' : null,
    p.excludeSocso ? 'SOCSO' : null,
    p.excludeEis ? 'EIS' : null,
    p.excludePcb ? 'PCB' : null,
  ].filter((s): s is string => s !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the report data model from the run + its stored payslips. Pure — the
 * same arrays always produce the same model (given a fixed `generatedAt`).
 */
export function aggregateOrgReport(input: OrgReportInput): OrgReportModel {
  const { run, slips, employees, departments } = input;
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const deptMap = new Map(departments.map((d) => [d.id, d]));
  const cutoffDay = input.cutoffDay ?? run.cutoffDay ?? 25;
  const period = payrollPeriodFor(run.monthKey, cutoffDay);
  const method: PayrollProrationMethod = run.prorationMethod ?? 'calendar';

  // ── Headline totals (Σ stored payslip figures, each rounded to the sen) ──
  const sum = (fn: (p: Payslip) => number) => round2(slips.reduce((s, p) => s + fn(p), 0));
  const epfEmployee = sum((p) => p.epfEmployee);
  const socsoEmployee = sum((p) => p.socsoEmployee);
  const eisEmployee = sum((p) => p.eisEmployee);
  const pcb = sum((p) => p.pcb);
  const adjustmentDeductions = sum((p) => p.adjustmentDeductions ?? 0);
  const totals: OrgReportModel['totals'] = {
    basic: sum((p) => p.basicPay),
    allowances: sum((p) => p.allowances),
    ot: sum((p) => p.otPay),
    gross: sum((p) => p.grossPay),
    deductions: round2(epfEmployee + socsoEmployee + eisEmployee + pcb + adjustmentDeductions),
    net: sum((p) => p.netPay),
    employerCost: sum((p) => p.employerCost),
    epfEmployee,
    epfEmployer: sum((p) => p.epfEmployer),
    socsoEmployee,
    socsoEmployer: sum((p) => p.socsoEmployer),
    eisEmployee,
    eisEmployer: sum((p) => p.eisEmployer),
    pcb,
    hrdLevy: sum((p) => p.hrdLevy),
    claims: sum((p) => p.claimsTotal),
    unpaidLeave: sum((p) => p.unpaidLeaveDeduction),
    adjustmentDeductions,
    adjustmentReimbursements: sum((p) => p.adjustmentReimbursements ?? 0),
  };

  const headcount = slips.length;
  const averageNet = headcount > 0 ? round2(totals.net / headcount) : 0;
  const medianNet = medianOf(slips.map((p) => p.netPay));

  // ── Department rollup (employer-cost share, sorted desc) ──
  interface DeptAcc {
    departmentId: string;
    name: string;
    headcount: number;
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
        headcount: 0, gross: 0, net: 0, employerCost: 0,
      };
      byDept.set(deptId, d);
    }
    d.headcount += 1;
    d.gross += p.grossPay;
    d.net += p.netPay;
    d.employerCost += p.employerCost;
  }
  const deptRows: OrgReportDeptRow[] = [...byDept.values()]
    .map((d) => ({
      ...d,
      gross: round2(d.gross),
      net: round2(d.net),
      employerCost: round2(d.employerCost),
      pctOfTotalCost:
        totals.employerCost > 0
          ? Math.round((d.employerCost / totals.employerCost) * 1000) / 10
          : 0,
    }))
    .sort((a, b) => b.employerCost - a.employerCost || a.name.localeCompare(b.name));

  // ── Employee register rows (name-sorted, markers + footnotes) ──
  const employeeRows: OrgReportEmployeeRow[] = slips
    .map((p) => {
      const emp = empMap.get(p.employeeId);
      const markers: string[] = [];
      const footnotes: string[] = [];
      if (p.basicOverride !== undefined) {
        markers.push(MARKER_BASIC_OVERRIDE);
        footnotes.push('basic overridden');
      }
      const st = p.salaryTypeUsed ?? emp?.salaryType ?? 'monthly';
      if (st !== 'monthly') {
        markers.push(MARKER_SALARY_TYPE);
        footnotes.push(`${st}-rated`);
      }
      const optOuts = optOutSchemesOf(p);
      if (optOuts.length > 0) {
        markers.push(MARKER_OPT_OUT);
        footnotes.push(`opted out: ${optOuts.join(', ')}`);
      }
      const adjLines = p.adjustments?.length ?? 0;
      if (adjLines > 0) {
        markers.push(MARKER_ADJUSTED);
        footnotes.push(`${adjLines} adjustment line(s)`);
      }
      return {
        employeeId: p.employeeId,
        employeeNo: emp?.employeeNo ?? p.employeeId,
        name: emp?.name ?? p.employeeId,
        department: emp ? (deptMap.get(emp.departmentId)?.name ?? 'Unassigned') : 'Unknown',
        daysLabel: daysLabelFor(p),
        basic: round2(p.basicPay),
        allowances: round2(p.allowances),
        ot: round2(p.otPay),
        gross: round2(p.grossPay),
        epfEmployee: round2(p.epfEmployee),
        socsoEmployee: round2(p.socsoEmployee),
        eisEmployee: round2(p.eisEmployee),
        pcb: round2(p.pcb),
        otherDeductions: round2(p.adjustmentDeductions ?? 0),
        net: round2(p.netPay),
        employerCost: round2(p.employerCost),
        markers,
        footnotes,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId));

  // ── Exceptions: engine warnings + data-completeness warnings ──
  const warnings: OrgReportWarning[] = [];
  for (const w of run.warnings) {
    const i = w.indexOf(': ');
    warnings.push({
      source: 'engine',
      employee: i > 0 ? w.slice(0, i) : '',
      detail: i > 0 ? w.slice(i + 2) : w,
    });
  }
  const seenData = new Set<string>();
  for (const p of slips) {
    const emp = empMap.get(p.employeeId);
    const issues = employeeValidationWarnings(emp);
    if (emp && (!emp.bankName.trim() || !emp.bankAccount.trim())) {
      issues.push('Missing bank details');
    }
    for (const detail of issues) {
      const key = `${p.employeeId}|${detail}`;
      if (seenData.has(key)) continue;
      seenData.add(key);
      warnings.push({ source: 'data', employee: emp?.name ?? p.employeeId, detail });
    }
  }

  // ── Exceptions: statutory opt-outs with their stored reasons ──
  const optOuts: OrgReportOptOut[] = slips
    .filter((p) => optOutSchemesOf(p).length > 0)
    .map((p) => {
      const schemes = optOutSchemesOf(p);
      const reason = schemes
        .map((s) => {
          const key = s.toLowerCase() as 'epf' | 'socso' | 'eis' | 'pcb';
          const r = p.optOutReasons?.[key]?.trim();
          return `${s}: ${r || '—'}`;
        })
        .join(' · ');
      return {
        employee: empMap.get(p.employeeId)?.name ?? p.employeeId,
        schemes,
        reason,
      };
    })
    .sort((a, b) => a.employee.localeCompare(b.employee));

  // ── Exceptions: manual adjustments summary ──
  const adjustments: OrgReportAdjustment[] = slips
    .filter((p) => (p.adjustments?.length ?? 0) > 0)
    .map((p) => ({
      employee: empMap.get(p.employeeId)?.name ?? p.employeeId,
      lines: p.adjustments!.length,
      earnings: round2(p.adjustmentEarnings ?? 0),
      deductions: round2(p.adjustmentDeductions ?? 0),
      reimbursements: round2(p.adjustmentReimbursements ?? 0),
    }))
    .sort((a, b) => a.employee.localeCompare(b.employee));

  const company = input.company;
  const settings = input.settings;
  return {
    runId: run.id,
    monthKey: run.monthKey,
    monthLabel: orgMonthLabel(run.monthKey),
    status: run.status,
    runAt: run.runAt,
    runBy: run.runBy,
    ...(run.finalizedAt ? { finalizedAt: run.finalizedAt } : {}),
    generatedAt: input.generatedAt ?? new Date(),
    companyName: company?.name ?? settings?.companyName ?? 'ASM Tech Sdn Bhd',
    companyRegNo: company?.regNo ?? settings?.companyRegNo ?? '',
    companyCode: company?.code ?? 'COMPANY',
    logoText: company?.branding.logoText ?? company?.code ?? 'HR',
    accentColor: company?.branding.accentColor ?? '#b45309',
    period,
    prorationMethod: method,
    prorationLabel: PRORATION_LABELS[method],
    headcount,
    totals,
    averageNet,
    medianNet,
    departments: deptRows,
    employees: employeeRows,
    warnings,
    optOuts,
    adjustments,
  };
}

/**
 * db-backed model builder: reads the active tenant's collections and the
 * active Company record. Returns null when the run no longer exists.
 */
export function buildOrgReport(
  runId: string,
  opts: { generatedAt?: Date } = {},
): OrgReportModel | null {
  const run = getCollection<PayrollRun>('payrollRuns').find((r) => r.id === runId);
  if (!run) return null;
  return aggregateOrgReport({
    run,
    slips: getCollection<Payslip>('payslips').filter((p) => p.runId === runId),
    employees: getCollection<Employee>('employees'),
    departments: getCollection<Department>('departments'),
    settings: getCollection<Settings>('settings').find((s) => s.id === 'company'),
    company: getActiveCompany(),
    generatedAt: opts.generatedAt,
    cutoffDay: run.cutoffDay ?? getPayrollCutoff().cutoffDay,
  });
}

/** `Payroll-Report-<COMPANY>-<YYYY-MM>.pdf` — company code sanitized. */
export function orgReportFileName(model: Pick<OrgReportModel, 'companyCode' | 'monthKey'>): string {
  const code =
    model.companyCode.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
    'COMPANY';
  return `Payroll-Report-${code}-${model.monthKey}.pdf`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF rendering (jsPDF, dynamically imported — chunk stays lazy)
// ─────────────────────────────────────────────────────────────────────────────

/** Register pagination target (~20 rows per landscape page). */
export const REGISTER_ROWS_PER_PAGE = 20;

/** '#b45309' → [180, 83, 9]; invalid input falls back to the warm amber default. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [180, 83, 9];
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Grouped money for dense tables — '12,345.67', no RM prefix. */
function plain(n: number): string {
  return n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface OrgReportPdfResult {
  fileName: string;
  pageCount: number;
  headcount: number;
}

/**
 * Render the full report into a jsPDF document WITHOUT saving — the node
 * smoke test inspects the returned doc; `downloadOrgReportPdf` saves it.
 */
export async function renderOrgReportPdf(model: OrgReportModel): Promise<JsPdfDoc> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const accent = hexToRgb(model.accentColor);
  const PORTRAIT_W = 210;
  const LANDSCAPE_W = 297;
  const PM = 14; // portrait margin
  const LM = 10; // landscape margin
  const CW = PORTRAIT_W - PM * 2; // 182 portrait content width

  const sum = (nums: number[]) => nums.reduce((s, n) => s + n, 0);

  /** Truncate text with an ellipsis to fit `maxW` at the current font. */
  function fit(text: string, maxW: number): string {
    if (doc.getTextWidth(text) <= maxW) return text;
    let t = text;
    while (t.length > 1 && doc.getTextWidth(`${t}…`) > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  /** Slim running header for content pages; returns the content start y. */
  function contentHeader(pageW: number, margin: number, section: string): number {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(60);
    doc.text(`${model.companyName} — Payroll report · ${model.monthLabel}`, margin, 12);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120);
    doc.text(section, pageW - margin, 12, { align: 'right' });
    doc.setDrawColor(accent[0], accent[1], accent[2]);
    doc.setLineWidth(0.8);
    doc.line(margin, 15, pageW - margin, 15);
    doc.setLineWidth(0.2);
    return 21;
  }

  /** Filled column-header band for a table; labels right-aligned per `aligns`. */
  function tableHeaderRow(
    x: number, y: number, widths: number[], labels: string[], aligns: ('left' | 'right')[], h = 5,
  ): void {
    doc.setFillColor(240, 234, 224);
    doc.rect(x, y, sum(widths), h, 'F');
    doc.setFontSize(6.3);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(60);
    let cx = x;
    labels.forEach((label, i) => {
      const w = widths[i]!;
      if (aligns[i] === 'right') doc.text(label, cx + w - 1.5, y + h - 1.7, { align: 'right' });
      else doc.text(label, cx + 1.5, y + h - 1.7);
      cx += w;
    });
  }

  // ── Page 1: cover summary ────────────────────────────────────────────────
  function renderCover(): void {
    // Logo block (accent) + company identity
    doc.setFillColor(accent[0], accent[1], accent[2]);
    doc.roundedRect(PM, 14, 17, 17, 2.5, 2.5, 'F');
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255);
    doc.text(fit(model.logoText.toUpperCase(), 14), PM + 8.5, 24.2, { align: 'center' });
    doc.setFontSize(14);
    doc.setTextColor(30);
    doc.text(fit(model.companyName, 120), PM + 21, 21);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110);
    if (model.companyRegNo) doc.text(model.companyRegNo, PM + 21, 26);

    doc.setFontSize(15);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('PAYROLL REPORT', PM + CW, 20, { align: 'right' });
    doc.setFontSize(10.5);
    doc.setFont('helvetica', 'normal');
    doc.text(model.monthLabel, PM + CW, 25.5, { align: 'right' });
    doc.setFontSize(7.5);
    doc.setTextColor(110);
    doc.text('Organisation payroll summary', PM + CW, 30, { align: 'right' });

    doc.setDrawColor(accent[0], accent[1], accent[2]);
    doc.setLineWidth(0.9);
    doc.line(PM, 36, PM + CW, 36);
    doc.setLineWidth(0.2);

    // Meta grid (3 × 3)
    const colX = [PM, PM + CW / 3, PM + (2 * CW) / 3];
    const kv = (x: number, y: number, label: string, value: string) => {
      doc.setFontSize(6.3);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(label.toUpperCase(), x, y);
      doc.setFontSize(8.5);
      doc.setTextColor(30);
      doc.text(fit(value || '—', CW / 3 - 6), x, y + 3.4);
    };
    kv(colX[0]!, 42, 'Wage month', model.monthLabel);
    kv(colX[1]!, 42, 'Cut-off period', `${fmtDate(model.period.start)} – ${fmtDate(model.period.end)}`);
    kv(colX[2]!, 42, 'Cut-off day', `Day ${model.period.cutoffDay} of month`);
    kv(colX[0]!, 51, 'Run at', fmtDate(model.runAt));
    kv(colX[1]!, 51, 'Run by', model.runBy);
    kv(colX[2]!, 51, 'Finalized at', model.finalizedAt ? fmtDate(model.finalizedAt) : '—');
    kv(colX[0]!, 60, 'Generated', fmtDate(model.generatedAt));
    kv(colX[1]!, 60, 'Payslips', String(model.headcount));
    kv(colX[2]!, 60, 'Status', model.status.toUpperCase());

    // Headline stat cards (3 × 2)
    const t = model.totals;
    const cardW = (CW - 12) / 3;
    const card = (i: number, y: number, label: string, value: string, sub: string) => {
      const x = PM + i * (cardW + 6);
      doc.setFillColor(250, 247, 241);
      doc.setDrawColor(225, 215, 200);
      doc.roundedRect(x, y, cardW, 17, 2, 2, 'FD');
      doc.setFontSize(6.3);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(label.toUpperCase(), x + 4, y + 5);
      doc.setFontSize(11.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30);
      doc.text(fit(value, cardW - 8), x + 4, y + 11);
      doc.setFontSize(6.2);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(130);
      doc.text(fit(sub, cardW - 8), x + 4, y + 15.2);
    };
    card(0, 68, 'Headcount paid', String(model.headcount), 'payslips in this run');
    card(1, 68, 'Total gross', fmtRM(t.gross), 'basic + allowances + OT');
    card(2, 68, 'Total deductions', fmtRM(t.deductions), 'EPF + SOCSO + EIS + PCB + adj.');
    card(0, 91, 'Total net pay', fmtRM(t.net), `incl. ${fmtRM(t.claims)} reimbursements`);
    card(1, 91, 'Total employer cost', fmtRM(t.employerCost), 'gross + employer statutory + HRD');
    card(2, 91, 'Average net pay', fmtRM(model.averageNet), `Median ${fmtRM(model.medianNet)}`);

    // Statutory totals table
    let y = 118;
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('Statutory contributions & tax totals', PM, y);
    y += 4;
    const widths = [70, 36, 36, 40];
    tableHeaderRow(PM, y, widths, ['Scheme', 'Employee (RM)', 'Employer (RM)', 'Total (RM)'], ['left', 'right', 'right', 'right']);
    const statRows: [string, number | null, number | null][] = [
      ['EPF (KWSP)', t.epfEmployee, t.epfEmployer],
      ['SOCSO (PERKESO)', t.socsoEmployee, t.socsoEmployer],
      ['EIS (SIP)', t.eisEmployee, t.eisEmployer],
      ['PCB / MTD', t.pcb, null],
      ['HRD Corp levy', null, t.hrdLevy],
    ];
    y += 5;
    statRows.forEach((r, i) => {
      if (i % 2 === 1) {
        doc.setFillColor(250, 248, 244);
        doc.rect(PM, y, sum(widths), 5.2, 'F');
      }
      const ee = r[1] === null ? null : r[1];
      const er = r[2] === null ? null : r[2];
      const rowTotal = round2((ee ?? 0) + (er ?? 0));
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30);
      doc.text(r[0], PM + 1.5, y + 3.6);
      doc.text(ee === null ? '—' : plain(ee), PM + widths[0]! + widths[1]! - 1.5, y + 3.6, { align: 'right' });
      doc.text(er === null ? '—' : plain(er), PM + widths[0]! + widths[1]! + widths[2]! - 1.5, y + 3.6, { align: 'right' });
      doc.text(plain(rowTotal), PM + sum(widths) - 1.5, y + 3.6, { align: 'right' });
      y += 5.2;
    });
    const eeSum = round2(t.epfEmployee + t.socsoEmployee + t.eisEmployee + t.pcb);
    const erSum = round2(t.epfEmployer + t.socsoEmployer + t.eisEmployer + t.hrdLevy);
    doc.setDrawColor(150);
    doc.line(PM, y, PM + sum(widths), y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(30);
    doc.text('TOTAL', PM + 1.5, y + 3.8);
    doc.text(plain(eeSum), PM + widths[0]! + widths[1]! - 1.5, y + 3.8, { align: 'right' });
    doc.text(plain(erSum), PM + widths[0]! + widths[1]! + widths[2]! - 1.5, y + 3.8, { align: 'right' });
    doc.text(plain(round2(eeSum + erSum)), PM + sum(widths) - 1.5, y + 3.8, { align: 'right' });
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(130);
    doc.text(
      doc.splitTextToSize(
        `Memo: claim reimbursements ${fmtRM(t.claims)} are paid in net but sit outside gross and every ` +
        `statutory base; unpaid-leave deductions ${fmtRM(t.unpaidLeave)} are already reflected in the ` +
        `prorated basic and are never subtracted twice.`,
        CW,
      ) as string[],
      PM, y,
    );
    y += 8;

    // Notes box
    const noteLines: string[] = [
      `Proration method: ${model.prorationLabel} — applied to joiner/leaver pay and unpaid-leave deductions.`,
      `Cut-off: day ${model.period.cutoffDay} — attendance, OT and claims dated ${fmtDate(model.period.start)} ` +
        `to ${fmtDate(model.period.end)} are paid in this run; later-dated items roll into the next run.`,
      `Register markers: ${ORG_REPORT_MARKER_LEGEND}.`,
      'Figures are aggregated from this run\'s stored payslips — statutory rates are never recomputed by this report.',
    ];
    if (model.status === 'draft') {
      noteLines.push('DRAFT RUN — figures are internal review material, not an official payroll record.');
    }
    const wrapped = noteLines.flatMap(
      (n) => doc.splitTextToSize(`•  ${n}`, CW - 10) as string[],
    );
    const boxH = 8 + wrapped.length * 3.4 + 3;
    doc.setFillColor(252, 250, 246);
    doc.setDrawColor(225, 215, 200);
    doc.roundedRect(PM, y, CW, boxH, 2, 2, 'FD');
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('Notes', PM + 4, y + 5.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(80);
    doc.text(wrapped, PM + 4, y + 10);
  }

  // ── Page 2: department breakdown ─────────────────────────────────────────
  function renderDepartments(): void {
    let y = contentHeader(PORTRAIT_W, PM, 'Department breakdown');
    if (model.departments.length === 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text('No payslips in this run — nothing to break down.', PM, y + 6);
      return;
    }
    const widths = [62, 14, 30, 30, 30, 16];
    tableHeaderRow(
      PM, y + 2, widths,
      ['Department', 'HC', 'Gross (RM)', 'Net (RM)', 'Er. cost (RM)', '%'],
      ['left', 'right', 'right', 'right', 'right', 'right'],
    );
    y += 7;
    const xRight = (col: number) => PM + sum(widths.slice(0, col + 1)) - 1.5;
    model.departments.forEach((d, i) => {
      if (i % 2 === 1) {
        doc.setFillColor(250, 248, 244);
        doc.rect(PM, y, sum(widths), 5.4, 'F');
      }
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30);
      doc.text(fit(d.name, widths[0]! - 4), PM + 1.5, y + 3.7);
      doc.text(String(d.headcount), xRight(1), y + 3.7, { align: 'right' });
      doc.text(plain(d.gross), xRight(2), y + 3.7, { align: 'right' });
      doc.text(plain(d.net), xRight(3), y + 3.7, { align: 'right' });
      doc.text(plain(d.employerCost), xRight(4), y + 3.7, { align: 'right' });
      doc.text(d.pctOfTotalCost.toFixed(1), xRight(5), y + 3.7, { align: 'right' });
      y += 5.4;
    });
    // Totals row
    doc.setDrawColor(150);
    doc.line(PM, y, PM + sum(widths), y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(30);
    doc.text('TOTAL', PM + 1.5, y + 3.9);
    doc.text(String(model.headcount), xRight(1), y + 3.9, { align: 'right' });
    doc.text(plain(model.totals.gross), xRight(2), y + 3.9, { align: 'right' });
    doc.text(plain(model.totals.net), xRight(3), y + 3.9, { align: 'right' });
    doc.text(plain(model.totals.employerCost), xRight(4), y + 3.9, { align: 'right' });
    doc.text('100.0', xRight(5), y + 3.9, { align: 'right' });
    y += 12;

    // Horizontal bar chart — share of employer cost (jsPDF primitives only)
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Share of employer cost', PM, y);
    y += 5;
    const maxCost = Math.max(...model.departments.map((d) => d.employerCost));
    const barX = PM + 48;
    const maxBarW = 100;
    model.departments.forEach((d) => {
      const barW = maxCost > 0 ? (d.employerCost / maxCost) * maxBarW : 0;
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(60);
      doc.text(fit(d.name, 44), PM, y + 3.2);
      doc.setFillColor(accent[0], accent[1], accent[2]);
      if (barW > 0) doc.rect(barX, y, barW, 4.2, 'F');
      doc.setDrawColor(220, 210, 195);
      doc.rect(barX, y, maxBarW, 4.2);
      doc.setFontSize(6.5);
      doc.setTextColor(90);
      doc.text(`${plain(d.employerCost)} · ${d.pctOfTotalCost.toFixed(1)}%`, barX + maxBarW + 2.5, y + 3.2);
      y += 7.2;
    });
  }

  // ── Pages 3+: employee register (landscape) ──────────────────────────────
  function renderRegister(): void {
    const widths = [8, 70, 12, 19, 16, 16, 19, 16, 15, 14, 15, 15, 21, 21]; // = 277
    const labels = [
      '#', 'Employee', 'Days', 'Basic', 'Allow.', 'OT', 'Gross',
      'EPF ee', 'SOCSO ee', 'EIS ee', 'PCB', 'Other ded.', 'Net pay', 'Er. cost',
    ];
    const aligns: ('left' | 'right')[] = [
      'left', 'left', 'right', 'right', 'right', 'right', 'right',
      'right', 'right', 'right', 'right', 'right', 'right', 'right',
    ];
    const ROW_H = 7.2;
    const xRight = (col: number) => LM + sum(widths.slice(0, col + 1)) - 1.5;

    const startPage = (): number => {
      doc.addPage('a4', 'landscape');
      const y = contentHeader(
        LANDSCAPE_W, LM, `Employee register — ${model.headcount} employee(s) · amounts in RM`,
      );
      tableHeaderRow(LM, y + 1, widths, labels, aligns);
      return y + 6;
    };

    const drawTotalRow = (y: number): void => {
      const t = model.totals;
      doc.setDrawColor(150);
      doc.line(LM, y, LM + sum(widths), y);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.8);
      doc.setTextColor(30);
      doc.text(`TOTAL (${model.headcount})`, LM + 1.5, y + 4);
      const vals = [
        '', plain(t.basic), plain(t.allowances), plain(t.ot), plain(t.gross),
        plain(t.epfEmployee), plain(t.socsoEmployee), plain(t.eisEmployee), plain(t.pcb),
        plain(t.adjustmentDeductions), plain(t.net), plain(t.employerCost),
      ];
      vals.forEach((v, i) => {
        if (v) doc.text(v, xRight(i + 2), y + 4, { align: 'right' });
      });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.8);
      doc.setTextColor(130);
      doc.text(ORG_REPORT_MARKER_LEGEND, LM, y + 8.5);
      doc.text(
        'Days column: worked/basis days (monthly), days worked (daily), hours worked (hourly). ' +
        'Other ded. = non-statutory deduction adjustments; unpaid leave is already inside the prorated basic.',
        LM, y + 11.8,
      );
    };

    let y = startPage();
    if (model.employees.length === 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text('No payslips in this run.', LM, y + 6);
      return;
    }
    let onPage = 0;
    model.employees.forEach((r, i) => {
      if (onPage === REGISTER_ROWS_PER_PAGE) {
        y = startPage();
        onPage = 0;
      }
      if (onPage % 2 === 1) {
        doc.setFillColor(250, 248, 244);
        doc.rect(LM, y, sum(widths), ROW_H, 'F');
      }
      // Line 1: name (+ accent markers) and money values
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30);
      const name = fit(r.name, r.markers.length > 0 ? 44 : 50);
      doc.text(name, LM + widths[0]! + 1.5, y + 3);
      if (r.markers.length > 0) {
        doc.setTextColor(accent[0], accent[1], accent[2]);
        doc.setFont('helvetica', 'bold');
        doc.text(
          r.markers.join(''),
          LM + widths[0]! + 1.5 + doc.getTextWidth(name) + 0.8,
          y + 3,
        );
        doc.setFont('helvetica', 'normal');
      }
      doc.setFontSize(6.5);
      doc.setTextColor(30);
      doc.text(String(i + 1), LM + 1.5, y + 3);
      const cells = [
        r.daysLabel, plain(r.basic), plain(r.allowances), plain(r.ot), plain(r.gross),
        plain(r.epfEmployee), plain(r.socsoEmployee), plain(r.eisEmployee), plain(r.pcb),
        plain(r.otherDeductions), plain(r.net), plain(r.employerCost),
      ];
      cells.forEach((v, ci) => {
        doc.setFont('helvetica', ci === 10 ? 'bold' : 'normal');
        doc.text(v, xRight(ci + 2), y + 3, { align: 'right' });
      });
      // Line 2: staff no · department
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.5);
      doc.setTextColor(130);
      doc.text(fit(`${r.employeeNo} · ${r.department}`, 66), LM + widths[0]! + 1.5, y + 6);
      y += ROW_H;
      onPage += 1;
    });
    drawTotalRow(y + 1);
  }

  // ── Last page(s): exceptions ─────────────────────────────────────────────
  function renderExceptions(): void {
    let y = contentHeader(PORTRAIT_W, PM, 'Exceptions & adjustments');
    const ensureSpace = (needed: number): void => {
      if (y + needed > 272) {
        doc.addPage('a4', 'portrait');
        y = contentHeader(PORTRAIT_W, PM, 'Exceptions & adjustments (continued)');
      }
    };
    const section = (title: string): void => {
      ensureSpace(14);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30);
      doc.text(title, PM, y + 4);
      y += 8.5;
    };
    const bullet = (text: string): void => {
      const lines = doc.splitTextToSize(text, CW - 8) as string[];
      ensureSpace(lines.length * 3.5 + 1.5);
      doc.setFontSize(7.3);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(60);
      doc.text(lines, PM + 4, y);
      doc.setFillColor(accent[0], accent[1], accent[2]);
      doc.circle(PM + 1.2, y - 1.1, 0.55, 'F');
      y += lines.length * 3.5 + 1.2;
    };
    const none = (): void => {
      doc.setFontSize(7.3);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(140);
      doc.text('None.', PM + 4, y);
      y += 5;
    };

    const engineWarnings = model.warnings.filter((w) => w.source === 'engine');
    const dataWarnings = model.warnings.filter((w) => w.source === 'data');

    section(`Compliance warnings (${engineWarnings.length})`);
    if (engineWarnings.length === 0) none();
    engineWarnings.forEach((w) =>
      bullet(`${w.employee ? `${w.employee}: ` : ''}${w.detail}`));

    y += 3;
    section(`Missing statutory numbers & bank details (${dataWarnings.length})`);
    if (dataWarnings.length === 0) none();
    dataWarnings.forEach((w) => bullet(`${w.employee}: ${w.detail}`));

    y += 3;
    section(`Statutory opt-outs (${model.optOuts.length})`);
    if (model.optOuts.length === 0) none();
    model.optOuts.forEach((o) =>
      bullet(`${o.employee} — ${o.schemes.join(', ')} — ${o.reason}`));

    y += 3;
    section(`Manual adjustments (${model.adjustments.length})`);
    if (model.adjustments.length === 0) none();
    model.adjustments.forEach((a) => {
      const parts = [
        `earnings +${fmtRM(a.earnings)}`,
        `deductions -${fmtRM(a.deductions)}`,
      ];
      if (a.reimbursements > 0) parts.push(`reimbursements ${fmtRM(a.reimbursements)}`);
      bullet(`${a.employee} — ${a.lines} line(s): ${parts.join(' · ')}`);
    });
    if (model.adjustments.length > 0) {
      const totalLines = model.adjustments.reduce((s, a) => s + a.lines, 0);
      ensureSpace(6);
      doc.setFontSize(6.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(130);
      doc.text(
        `${totalLines} adjustment line(s) across the run — earnings ` +
        `${fmtRM(round2(model.adjustments.reduce((s, a) => s + a.earnings, 0)))}, deductions ` +
        `${fmtRM(round2(model.adjustments.reduce((s, a) => s + a.deductions, 0)))}.`,
        PM + 4, y,
      );
    }
  }

  renderCover();
  doc.addPage('a4', 'portrait');
  renderDepartments();
  renderRegister();
  doc.addPage('a4', 'portrait');
  renderExceptions();

  // Footer on every page: generated stamp + page x of N.
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const w = doc.internal.pageSize.getWidth();
    const h = doc.internal.pageSize.getHeight();
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(140);
    doc.text(
      `Generated ${fmtDate(model.generatedAt)} · ${model.companyName} HRMS — computer-generated, no signature required.`,
      w === PORTRAIT_W ? PM : LM,
      h - 6,
    );
    doc.text(`Page ${i} of ${pageCount}`, w - (w === PORTRAIT_W ? PM : LM), h - 6, { align: 'right' });
  }

  doc.setProperties({
    title: `Payroll report ${model.monthLabel} — ${model.companyName}`,
    subject: `Organisation payroll report for ${model.monthLabel} (run ${model.runId})`,
    author: model.companyName,
    creator: 'ASM Tech HRMS',
  });
  return doc;
}

/**
 * Build the report model for a run, render it and trigger the browser
 * download of `Payroll-Report-<COMPANY>-<YYYY-MM>.pdf`. Returns null when
 * the run no longer exists (caller toasts the failure).
 */
export async function downloadOrgReportPdf(
  runId: string,
  opts: { generatedAt?: Date } = {},
): Promise<OrgReportPdfResult | null> {
  const model = buildOrgReport(runId, opts);
  if (!model) return null;
  const doc = await renderOrgReportPdf(model);
  const fileName = orgReportFileName(model);
  doc.save(fileName);
  return { fileName, pageCount: doc.getNumberOfPages(), headcount: model.headcount };
}
