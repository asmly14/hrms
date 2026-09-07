/**
 * Salary report PDF — ONE owner-facing multi-period PDF (month / quarter /
 * half-year / year / custom range), the cross-period sibling of
 * lib/payrollReportPdf.ts.
 *
 * Renders the pure `SalaryReportModel` from lib/salaryReports.ts (aggregation
 * is never recomputed here). jsPDF is dynamically imported so the ~400 kB
 * parser cost only lands when HR actually exports (same pattern as
 * lib/yearEnd.ts batch payslips and the org payroll report).
 *
 * Layout (multi-page A4):
 *  1. Cover summary — company header (logoText/accent from the active Company
 *     record), period label + coverage (finalized vs expected months, gap
 *     warning), headline stat cards, monthly trend chart drawn with jsPDF
 *     rect/line primitives (gross + net bars, employer-cost line — no image
 *     libs), statutory totals table.
 *  2. Employee register — per-employee period totals, ~20 rows/page in
 *     LANDSCAPE with a repeated header and a totals row on the last page.
 *  3. Department breakdown — per-department table + share-of-employer-cost
 *     horizontal bars (rect primitives).
 *  4. Insights — salary-band histogram (rect bars) + top-10 earners table.
 *
 * All text runs through `pdfSafe` (WinAnsi/cp1252 glyphs only — jsPDF's
 * standard helvetica cannot encode e.g. '≤' or CJK). Footers carry the
 * generated stamp + 'Page x of N' on every page.
 * Filename: `Salary-Report-<COMPANY>-<periodTag>.pdf`.
 */
import { fmtDate, fmtRM, round2 } from './utils';
import { salaryMonthLabel, salaryReportCompanyTag, type SalaryReportModel } from './salaryReports';
import type { jsPDF as JsPdfDoc } from 'jspdf';

// ─────────────────────────────────────────────────────────────────────────────
// WinAnsi sanitization — jsPDF standard fonts encode cp1252 only
// ─────────────────────────────────────────────────────────────────────────────

/** cp1252 punctuation beyond Latin-1 that helvetica CAN encode. */
const CP1252_EXTRA = new Set([
  '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', 'Ž',
  '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', 'ž', 'Ÿ',
]);

/** Known replacements for common non-WinAnsi glyphs. */
const PDF_CHAR_MAP: Record<string, string> = {
  '≤': '<=',
  '≥': '>=',
  '→': '->',
  '←': '<-',
  '−': '-',   // U+2212 minus
  '×': 'x',   // (U+00D7 is Latin-1 and survives; this covers any odd variant)
  '÷': '/',
  ' ': ' ',   // non-breaking space variant safety net
};

/**
 * Map a string to glyphs jsPDF's standard fonts can actually encode (cp1252):
 * Basic Latin + Latin-1 Supplement pass through, the cp1252 punctuation set
 * (– — … • † …) passes through, known math/arrow glyphs get ASCII fallbacks,
 * anything else (CJK, emoji, …) becomes '?'.
 */
export function pdfSafe(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0xff || CP1252_EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    out += PDF_CHAR_MAP[ch] ?? '?';
  }
  return out;
}

/** `Salary-Report-<COMPANY>-<periodTag>.pdf` — company code sanitized. */
export function salaryReportFileName(
  model: Pick<SalaryReportModel, 'companyCode' | 'period'>,
): string {
  return `Salary-Report-${salaryReportCompanyTag(model.companyCode)}-${model.period.fileTag}.pdf`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF rendering (jsPDF, dynamically imported — chunk stays lazy)
// ─────────────────────────────────────────────────────────────────────────────

/** Register pagination target (~20 rows per landscape page). */
export const SALARY_REGISTER_ROWS_PER_PAGE = 20;

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

export interface SalaryReportPdfResult {
  fileName: string;
  pageCount: number;
  employeesPaid: number;
}

/**
 * Render the full report into a jsPDF document WITHOUT saving — the node
 * smoke test inspects the returned doc; `downloadSalaryReportPdf` saves it.
 */
export async function renderSalaryReportPdf(model: SalaryReportModel): Promise<JsPdfDoc> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const accent = hexToRgb(model.accentColor);
  const PORTRAIT_W = 210;
  const LANDSCAPE_W = 297;
  const PM = 14; // portrait margin
  const LM = 10; // landscape margin
  const CW = PORTRAIT_W - PM * 2; // 182 portrait content width

  const sum = (nums: number[]) => nums.reduce((s, n) => s + n, 0);

  /** WinAnsi-safe text — every doc.text call in this renderer goes through T. */
  const T = (s: string): string => pdfSafe(s);

  /** Truncate text with an ellipsis to fit `maxW` at the current font. */
  function fit(text: string, maxW: number): string {
    const s = T(text);
    if (doc.getTextWidth(s) <= maxW) return s;
    let t = s;
    while (t.length > 1 && doc.getTextWidth(`${t}…`) > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  /** Slim running header for content pages; returns the content start y. */
  function contentHeader(pageW: number, margin: number, section: string): number {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(60);
    doc.text(T(`${model.companyName} — Salary report · ${model.period.label}`), margin, 12);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120);
    doc.text(T(section), pageW - margin, 12, { align: 'right' });
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
      if (aligns[i] === 'right') doc.text(T(label), cx + w - 1.5, y + h - 1.7, { align: 'right' });
      else doc.text(T(label), cx + 1.5, y + h - 1.7);
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
    if (model.companyRegNo) doc.text(T(model.companyRegNo), PM + 21, 26);

    doc.setFontSize(15);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('SALARY REPORT', PM + CW, 20, { align: 'right' });
    doc.setFontSize(10.5);
    doc.setFont('helvetica', 'normal');
    doc.text(fit(model.period.label, 90), PM + CW, 25.5, { align: 'right' });
    doc.setFontSize(7.5);
    doc.setTextColor(110);
    doc.text('Multi-period salary analysis — finalized runs only', PM + CW, 30, { align: 'right' });

    doc.setDrawColor(accent[0], accent[1], accent[2]);
    doc.setLineWidth(0.9);
    doc.line(PM, 36, PM + CW, 36);
    doc.setLineWidth(0.2);

    // Meta grid (3 × 2)
    const colX = [PM, PM + CW / 3, PM + (2 * CW) / 3];
    const kv = (x: number, y: number, label: string, value: string) => {
      doc.setFontSize(6.3);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(T(label.toUpperCase()), x, y);
      doc.setFontSize(8.5);
      doc.setTextColor(30);
      doc.text(fit(value || '—', CW / 3 - 6), x, y + 3.4);
    };
    kv(colX[0]!, 42, 'Period', model.period.label);
    kv(colX[1]!, 42, 'Months covered', `${model.expectedMonths} month(s)`);
    kv(colX[2]!, 42, 'Finalized', `${model.finalizedMonths.length} of ${model.expectedMonths} month(s)`);
    kv(colX[0]!, 51, 'Generated', fmtDate(model.generatedAt));
    kv(colX[1]!, 51, 'Payslips counted', String(model.payslipCount));
    kv(colX[2]!, 51, 'Employees paid', `${model.employeesPaid} unique`);

    // Gap warning box (amber) when any period month was never finalized
    let y = 58;
    if (model.hasGaps) {
      const missing = model.missingMonths.map(salaryMonthLabel).join(', ');
      const lines = doc.splitTextToSize(
        T(`Coverage gap — payroll not finalized for: ${missing}. ` +
          `Those months are excluded from every total, chart and table in this report.`),
        CW - 8,
      ) as string[];
      const boxH = 6 + lines.length * 3.4 + 2;
      doc.setFillColor(254, 243, 199);
      doc.setDrawColor(217, 160, 60);
      doc.roundedRect(PM, y, CW, boxH, 2, 2, 'FD');
      doc.setFontSize(7.3);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(146, 64, 14);
      doc.text(lines, PM + 4, y + 4.6);
      doc.setFont('helvetica', 'normal');
      y += boxH + 5;
    }

    // Headline stat cards (3 × 2)
    const t = model.totals;
    const statutoryAll = round2(
      t.epfEmployee + t.epfEmployer + t.socsoEmployee + t.socsoEmployer +
      t.eisEmployee + t.eisEmployer + t.pcb + t.hrdLevy,
    );
    const cardW = (CW - 12) / 3;
    const card = (i: number, yy: number, label: string, value: string, sub: string) => {
      const x = PM + i * (cardW + 6);
      doc.setFillColor(250, 247, 241);
      doc.setDrawColor(225, 215, 200);
      doc.roundedRect(x, yy, cardW, 17, 2, 2, 'FD');
      doc.setFontSize(6.3);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(T(label.toUpperCase()), x + 4, yy + 5);
      doc.setFontSize(11.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30);
      doc.text(fit(value, cardW - 8), x + 4, yy + 11);
      doc.setFontSize(6.2);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(130);
      doc.text(fit(sub, cardW - 8), x + 4, yy + 15.2);
    };
    card(0, y, 'Total gross', fmtRM(t.gross), `${model.finalizedMonths.length} finalized month(s)`);
    card(1, y, 'Total net pay', fmtRM(t.net), `incl. ${fmtRM(t.claims)} reimbursements`);
    card(2, y, 'Total employer cost', fmtRM(t.employerCost), 'gross + employer statutory + HRD');
    card(0, y + 23, 'Statutory & tax', fmtRM(statutoryAll), 'EPF + SOCSO + EIS + PCB + HRD (ee + er)');
    card(1, y + 23, 'Loans recovered', fmtRM(t.loans), 'installments deducted from net pay');
    card(2, y + 23, 'Claims reimbursed', fmtRM(t.claims), 'non-statutory, paid in net');
    y += 46;

    // Monthly trend chart — gross + net bars, employer-cost line (primitives)
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('Monthly trend', PM, y);
    y += 3;
    const chartH = 34;
    const n = model.monthly.length;
    const maxV = Math.max(
      1,
      ...model.monthly.flatMap((m) => [m.gross, m.net, m.employerCost]),
    );
    const groupW = CW / Math.max(1, n);
    const barW = Math.min(5.5, groupW / 3.2);
    const baseY = y + chartH;
    // Axis baseline + max gridline
    doc.setDrawColor(200, 190, 175);
    doc.line(PM, baseY, PM + CW, baseY);
    doc.setFontSize(5.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(140);
    doc.text(plain(maxV), PM, y + 1.5);
    const labelEvery = Math.max(1, Math.ceil(n / 12));
    const linePts: [number, number][] = [];
    model.monthly.forEach((m, i) => {
      const cx = PM + i * groupW + groupW / 2;
      const gH = (m.gross / maxV) * (chartH - 4);
      const nH = (m.net / maxV) * (chartH - 4);
      // Non-finalized gap months: outline only, no fill.
      if (m.finalized) {
        doc.setFillColor(245, 158, 11); // gross — amber
        if (gH > 0) doc.rect(cx - barW - 0.6, baseY - gH, barW, gH, 'F');
        doc.setFillColor(77, 124, 15); // net — olive
        if (nH > 0) doc.rect(cx + 0.6, baseY - nH, barW, nH, 'F');
      } else {
        doc.setDrawColor(217, 160, 60);
        doc.setFontSize(5.5);
        doc.setTextColor(180, 120, 40);
        doc.text(T('gap'), cx, baseY - 2, { align: 'center' });
      }
      linePts.push([cx, baseY - (m.employerCost / maxV) * (chartH - 4)]);
      if (i % labelEvery === 0) {
        doc.setFontSize(5.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(120);
        doc.text(T(m.label), cx, baseY + 3.2, { align: 'center' });
      }
    });
    // Employer-cost line (accent) + markers
    doc.setDrawColor(accent[0], accent[1], accent[2]);
    doc.setLineWidth(0.6);
    for (let i = 1; i < linePts.length; i++) {
      const [x1, y1] = linePts[i - 1]!;
      const [x2, y2] = linePts[i]!;
      doc.line(x1, y1, x2, y2);
    }
    doc.setLineWidth(0.2);
    doc.setFillColor(accent[0], accent[1], accent[2]);
    for (const [x, ly] of linePts) doc.circle(x, ly, 0.7, 'F');
    // Legend
    const legY = baseY + 7;
    const legend: [string, [number, number, number]][] = [
      ['Gross', [245, 158, 11]],
      ['Net', [77, 124, 15]],
      ['Employer cost', accent],
    ];
    let lx = PM;
    doc.setFontSize(6);
    legend.forEach(([label, col]) => {
      doc.setFillColor(col[0], col[1], col[2]);
      doc.rect(lx, legY - 2.2, 3, 2.2, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(80);
      doc.text(T(label), lx + 4, legY);
      lx += 4 + doc.getTextWidth(label) + 7;
    });
    y = legY + 6;

    // Statutory totals table
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('Statutory contributions & tax totals (period)', PM, y);
    y += 3;
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
      const ee = r[1];
      const er = r[2];
      const rowTotal = round2((ee ?? 0) + (er ?? 0));
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30);
      doc.text(T(r[0]), PM + 1.5, y + 3.6);
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
        T(`Figures are aggregated from the stored payslips of FINALIZED runs in the window — ` +
          `draft runs and non-finalized months never contribute. Loans recovered and claims ` +
          `reimbursed are net-pay movements, memo-level: loans are deducted from net, claims ` +
          `are paid inside net but outside gross and every statutory base.`),
        CW,
      ) as string[],
      PM, y,
    );
  }

  // ── Pages 2+: employee register (landscape) ──────────────────────────────
  function renderRegister(): void {
    const widths = [8, 58, 12, 22, 16, 16, 17, 17, 15, 15, 15, 22, 22, 22]; // = 277
    const labels = [
      '#', 'Employee', 'Months', 'Gross', 'OT', 'Allow.', 'EPF ee', 'SOCSO ee',
      'EIS ee', 'PCB', 'Loans', 'Net pay', 'Er. cost', 'Avg gross',
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
        LANDSCAPE_W, LM, `Employee register — ${model.employeesPaid} employee(s) · period totals in RM`,
      );
      tableHeaderRow(LM, y + 1, widths, labels, aligns);
      return y + 6;
    };

    const drawTotalRow = (y: number): void => {
      const t = model.totals;
      const ot = round2(model.employees.reduce((s, r) => s + r.ot, 0));
      const allow = round2(model.employees.reduce((s, r) => s + r.allowances, 0));
      doc.setDrawColor(150);
      doc.line(LM, y, LM + sum(widths), y);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.8);
      doc.setTextColor(30);
      doc.text(T(`TOTAL (${model.employeesPaid})`), LM + 1.5, y + 4);
      const vals = [
        '', plain(t.gross), plain(ot), plain(allow),
        plain(t.epfEmployee), plain(t.socsoEmployee), plain(t.eisEmployee), plain(t.pcb),
        plain(t.loans), plain(t.net), plain(t.employerCost), '',
      ];
      vals.forEach((v, i) => {
        if (v) doc.text(v, xRight(i + 2), y + 4, { align: 'right' });
      });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.8);
      doc.setTextColor(130);
      doc.text(
        T('Months = finalized months paid in the window · Loans = installments recovered from net · ' +
          'Avg gross = gross ÷ months paid. Only finalized runs contribute.'),
        LM, y + 8.5,
      );
    };

    let y = startPage();
    if (model.employees.length === 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(T('No finalized payslips in this period.'), LM, y + 6);
      return;
    }
    let onPage = 0;
    model.employees.forEach((r, i) => {
      if (onPage === SALARY_REGISTER_ROWS_PER_PAGE) {
        y = startPage();
        onPage = 0;
      }
      if (onPage % 2 === 1) {
        doc.setFillColor(250, 248, 244);
        doc.rect(LM, y, sum(widths), ROW_H, 'F');
      }
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30);
      doc.text(fit(r.name, 54), LM + widths[0]! + 1.5, y + 3);
      doc.setFontSize(6.5);
      doc.text(String(i + 1), LM + 1.5, y + 3);
      const cells = [
        String(r.monthsPaid), plain(r.gross), plain(r.ot), plain(r.allowances),
        plain(r.epfEmployee), plain(r.socsoEmployee), plain(r.eisEmployee), plain(r.pcb),
        plain(r.loans), plain(r.net), plain(r.employerCost), plain(r.avgMonthlyGross),
      ];
      cells.forEach((v, ci) => {
        doc.setFont('helvetica', ci === 9 ? 'bold' : 'normal');
        doc.text(v, xRight(ci + 2), y + 3, { align: 'right' });
      });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.5);
      doc.setTextColor(130);
      doc.text(fit(`${r.employeeNo} · ${r.department}`, 54), LM + widths[0]! + 1.5, y + 6);
      y += ROW_H;
      onPage += 1;
    });
    drawTotalRow(y + 1);
  }

  // ── Department page ──────────────────────────────────────────────────────
  function renderDepartments(): void {
    let y = contentHeader(PORTRAIT_W, PM, 'Department breakdown');
    if (model.departments.length === 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(T('No finalized payslips in this period — nothing to break down.'), PM, y + 6);
      return;
    }
    const widths = [62, 16, 30, 30, 28, 16]; // = 182
    tableHeaderRow(
      PM, y + 2, widths,
      ['Department', 'Emps', 'Gross (RM)', 'Net (RM)', 'Er. cost (RM)', '%'],
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
      doc.text(String(d.employees), xRight(1), y + 3.7, { align: 'right' });
      doc.text(plain(d.gross), xRight(2), y + 3.7, { align: 'right' });
      doc.text(plain(d.net), xRight(3), y + 3.7, { align: 'right' });
      doc.text(plain(d.employerCost), xRight(4), y + 3.7, { align: 'right' });
      doc.text(d.pctOfCost.toFixed(1), xRight(5), y + 3.7, { align: 'right' });
      y += 5.4;
    });
    doc.setDrawColor(150);
    doc.line(PM, y, PM + sum(widths), y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(30);
    doc.text('TOTAL', PM + 1.5, y + 3.9);
    doc.text(String(model.employeesPaid), xRight(1), y + 3.9, { align: 'right' });
    doc.text(plain(model.totals.gross), xRight(2), y + 3.9, { align: 'right' });
    doc.text(plain(model.totals.net), xRight(3), y + 3.9, { align: 'right' });
    doc.text(plain(model.totals.employerCost), xRight(4), y + 3.9, { align: 'right' });
    doc.text('100.0', xRight(5), y + 3.9, { align: 'right' });
    y += 12;

    // Share-of-employer-cost horizontal bars (rect primitives)
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Share of employer cost (period)', PM, y);
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
      doc.text(T(`${plain(d.employerCost)} · ${d.pctOfCost.toFixed(1)}%`), barX + maxBarW + 2.5, y + 3.2);
      y += 7.2;
    });
  }

  // ── Insights page: salary bands + top earners ────────────────────────────
  function renderInsights(): void {
    let y = contentHeader(PORTRAIT_W, PM, 'Distribution insights');

    // Salary-band histogram (avg monthly gross) — vertical rect bars
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('Salary bands — average monthly gross', PM, y);
    y += 4;
    const chartH = 40;
    const bandN = model.bands.length;
    const slotW = CW / bandN;
    const barW = Math.min(22, slotW - 14);
    const maxCount = Math.max(1, ...model.bands.map((b) => b.count));
    const baseY = y + chartH;
    doc.setDrawColor(200, 190, 175);
    doc.line(PM, baseY, PM + CW, baseY);
    model.bands.forEach((b, i) => {
      const cx = PM + i * slotW + slotW / 2;
      const h = (b.count / maxCount) * (chartH - 6);
      doc.setFillColor(accent[0], accent[1], accent[2]);
      if (h > 0) doc.rect(cx - barW / 2, baseY - h, barW, h, 'F');
      doc.setDrawColor(220, 210, 195);
      doc.rect(cx - barW / 2, y, barW, chartH - 0);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(60);
      doc.text(String(b.count), cx, baseY - h - 1.5, { align: 'center' });
      doc.setFontSize(6);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(110);
      doc.text(fit(b.label, slotW - 4), cx, baseY + 3.4, { align: 'center' });
    });
    doc.setFontSize(6.3);
    doc.setTextColor(130);
    doc.text(
      T(`${model.employeesPaid} employee(s) banded by period gross ÷ months paid (upper bounds inclusive).`),
      PM, baseY + 7.5,
    );
    y = baseY + 14;

    // Top-10 earners table
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text('Top earners (by period gross)', PM, y);
    y += 3;
    if (model.topEarners.length === 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(T('No finalized payslips in this period.'), PM, y + 4);
      return;
    }
    const widths = [8, 60, 40, 16, 22, 20, 16]; // = 182
    tableHeaderRow(
      PM, y, widths,
      ['#', 'Employee', 'Department', 'Months', 'Gross (RM)', 'Avg gross', 'Net (RM)'],
      ['left', 'left', 'left', 'right', 'right', 'right', 'right'],
    );
    y += 5;
    const xRight = (col: number) => PM + sum(widths.slice(0, col + 1)) - 1.5;
    model.topEarners.forEach((r, i) => {
      if (i % 2 === 1) {
        doc.setFillColor(250, 248, 244);
        doc.rect(PM, y, sum(widths), 5.4, 'F');
      }
      doc.setFontSize(7.3);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30);
      doc.text(String(i + 1), PM + 1.5, y + 3.7);
      doc.text(fit(r.name, widths[1]! - 4), PM + widths[0]! + 1.5, y + 3.7);
      doc.text(fit(r.department, widths[2]! - 4), PM + widths[0]! + widths[1]! + 1.5, y + 3.7);
      doc.text(String(r.monthsPaid), xRight(3), y + 3.7, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.text(plain(r.gross), xRight(4), y + 3.7, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.text(plain(r.avgMonthlyGross), xRight(5), y + 3.7, { align: 'right' });
      doc.text(plain(r.net), xRight(6), y + 3.7, { align: 'right' });
      y += 5.4;
    });
  }

  renderCover();
  renderRegister();
  doc.addPage('a4', 'portrait');
  renderDepartments();
  doc.addPage('a4', 'portrait');
  renderInsights();

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
      T(`Generated ${fmtDate(model.generatedAt)} · ${model.companyName} HRMS — computer-generated, no signature required.`),
      w === PORTRAIT_W ? PM : LM,
      h - 6,
    );
    doc.text(`Page ${i} of ${pageCount}`, w - (w === PORTRAIT_W ? PM : LM), h - 6, { align: 'right' });
  }

  doc.setProperties({
    title: `Salary report ${model.period.label} — ${model.companyName}`,
    subject: `Multi-period salary report for ${model.period.label} (finalized runs)`,
    author: model.companyName,
    creator: 'ASM Tech HRMS',
  });
  return doc;
}

/**
 * Render the model and trigger the browser download of
 * `Salary-Report-<COMPANY>-<periodTag>.pdf`. The model comes from
 * `aggregateSalaryReport` (lib/salaryReports.ts) — build it once in the page
 * and share it between the on-screen sections, this PDF and the CSV pack.
 */
export async function downloadSalaryReportPdf(
  model: SalaryReportModel,
): Promise<SalaryReportPdfResult> {
  const doc = await renderSalaryReportPdf(model);
  const fileName = salaryReportFileName(model);
  doc.save(fileName);
  return { fileName, pageCount: doc.getNumberOfPages(), employeesPaid: model.employeesPaid };
}
