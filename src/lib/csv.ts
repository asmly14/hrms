/**
 * CSV helpers for the whole app (reports center + payroll statutory outputs).
 * RFC-4180-ish escaping + UTF-8 BOM so Excel opens RM amounts correctly.
 *
 * Single implementation — previously duplicated between pages/reports/csv.ts
 * and pages/payroll/helpers.ts. Always goes through escapeCell, so every
 * export gets the formula-injection guard.
 */
export type CsvValue = string | number;

function escapeCell(value: CsvValue): string {
  const raw = String(value);
  // Formula-injection guard: cells starting with = + - @ open as formulas in
  // Excel/Sheets; prefix an apostrophe so they import as literal text.
  const s = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text (CRLF, per RFC 4180). */
export function rowsToCsv(rows: CsvValue[][]): string {
  return rows.map((r) => r.map(escapeCell).join(',')).join('\r\n');
}

/** Header labels + data rows → CSV text (CRLF, per RFC 4180). */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return rowsToCsv([headers, ...rows]);
}

/** Download a text file via a Blob (UTF-8 BOM added for Excel compatibility). */
export function downloadTextFile(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob(['﻿' + text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Trigger a browser download of CSV text as a .csv file. */
export function downloadCsv(filename: string, csv: string): void {
  downloadTextFile(filename, csv, 'text/csv');
}
