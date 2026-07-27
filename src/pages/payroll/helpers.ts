/**
 * Shared helpers for the payroll module: month labels, CSV building,
 * Blob downloads and small date math. No statutory figures here — all
 * rates come from `@/lib/statutory` / `@/lib/payrollEngine`.
 */
import type { Employee } from '@/lib/types';

/** '2026-03' → 'March 2026'. */
export function monthLabel(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  if (!y || !m) return mk;
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function csvCell(v: string | number): string {
  let s = String(v);
  // B11 — formula-injection guard: cells starting with = + - @ would be
  // evaluated as formulas when opened in Excel; prefix an apostrophe so the
  // value opens as inert text instead.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text (CRLF, per RFC 4180). */
export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Download a text file via a Blob (BOM added for Excel compatibility). */
export function downloadTextFile(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob(['\ufeff' + text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Fixed 2-decimal money for files — never localized, never 'RM'-prefixed. */
export function num2(n: number): string {
  return n.toFixed(2);
}

export function empById(employees: Employee[]): Map<string, Employee> {
  return new Map(employees.map((e) => [e.id, e]));
}

/** Calendar days of [start,end] (ISO dates) overlapping month 'YYYY-MM'. */
export function overlapDaysInMonth(start: string, end: string, month: string): number {
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
