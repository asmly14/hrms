/**
 * M8 — report → CSV serialization for the Reports center.
 * Cell escaping / downloads live in `@/lib/csv` (single implementation,
 * formula-injection guard included); this module only maps BuiltReport shape.
 */
import { toCsv, type CsvValue } from '@/lib/csv';
import type { BuiltReport, ReportColumn, ReportRow } from './reportBuilders';

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
