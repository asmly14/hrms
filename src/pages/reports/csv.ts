/**
 * M8 — CSV helpers for the Reports center.
 * RFC-4180-ish escaping + UTF-8 BOM so Excel opens RM amounts correctly.
 */
import type { BuiltReport, ReportColumn, ReportRow } from './reportBuilders';

export type CsvValue = string | number;

function escapeCell(value: CsvValue): string {
  const raw = String(value);
  // Formula-injection guard: cells starting with = + - @ open as formulas in
  // Excel/Sheets; prefix an apostrophe so they import as literal text.
  const s = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [headers, ...rows].map((r) => r.map(escapeCell).join(',')).join('\r\n');
}

/** Serialize a built report (including its totals row) to CSV text. */
export function reportCsv(report: BuiltReport): string {
  const cell = (col: ReportColumn, row: ReportRow): CsvValue => {
    const v = row[col.key];
    if (v == null) return '';
    if (typeof v === 'number' && col.format === 'money') return v.toFixed(2);
    return v;
  };
  const rows = report.rows.map((r) => report.columns.map((c) => cell(c, r)));
  const t = report.totalRow;
  if (t) rows.push(report.columns.map((c) => cell(c, t)));
  return toCsv(report.columns.map((c) => c.label), rows);
}

/** Trigger a browser download of CSV text as a file. */
export function downloadCsv(filename: string, csv: string): void {
  // UTF-8 BOM prefix so Excel detects the encoding.
  const blob = new Blob([String.fromCharCode(0xfeff) + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
