/**
 * ⚠️ SYNC SUBSET — mirrors hrms-web/src/lib/utils.ts (only the functions the
 * server-side calc layer needs). Keep implementations byte-equivalent to the
 * web copies; `sync-calc` re-copies statutory.ts which imports round2 from
 * './utils' — do NOT rename this file or the round2 export.
 */

/** Round to 2 decimal places (sen) — half-up, the payroll convention. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Age in whole years from an ISO date-of-birth, as of `asOf` (default today). */
export function ageFromDob(dob: string, asOf: Date = new Date()): number {
  const d = new Date(dob.length === 10 ? `${dob}T00:00:00` : dob);
  let age = asOf.getFullYear() - d.getFullYear();
  const mDiff = asOf.getMonth() - d.getMonth();
  if (mDiff < 0 || (mDiff === 0 && asOf.getDate() < d.getDate())) age -= 1;
  return age;
}

/** Whole days from a to b (b − a). Accepts ISO strings or Dates. */
export function daysBetween(a: string | Date, b: string | Date): number {
  const da = typeof a === 'string' ? new Date(a) : a;
  const db = typeof b === 'string' ? new Date(b) : b;
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** Unique ID — mirrors hrms-web/src/lib/db.ts uid(). */
export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
