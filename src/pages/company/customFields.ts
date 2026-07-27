/**
 * Custom employee fields — shared contract between the Company Setup builder
 * (pages/company) and the Employees module renderer (pages/employees).
 *
 * The core `CustomField` type (lib/types.ts) intentionally has no `required`
 * flag; the builder persists it as an additive storage-level property
 * (localStorage is schemaless), so readers should go through
 * `getEmployeeCustomFields()` rather than reading config.customFields raw.
 *
 * Values are stored on the employee record under `custom: Record<string,
 * unknown>` keyed by field id — see pages/employees/types.ts `customOf()`.
 */
import type { Company, CustomField } from '@/lib/types';

/** CustomField as actually stored — core shape plus the additive flags. */
export type EmployeeCustomField = CustomField & { required?: boolean };

/** Employee record slice carrying custom field values. */
export type EmployeeCustomValues = Record<string, unknown>;

/** Custom fields defined for employees on the given company (safe on null). */
export function getEmployeeCustomFields(company: Company | null | undefined): EmployeeCustomField[] {
  const list = company?.config?.customFields;
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && f.appliesTo === 'employee') as EmployeeCustomField[];
}

/** Coerce a form string into the storage type for the field. */
export function coerceCustomValue(field: EmployeeCustomField, raw: string): unknown {
  const trimmed = raw.trim();
  if (field.type === 'number') {
    const n = Number(trimmed);
    return trimmed !== '' && Number.isFinite(n) ? n : undefined;
  }
  return trimmed === '' ? undefined : trimmed;
}

/** Format a stored custom value for display (detail profile). */
export function displayCustomValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}
