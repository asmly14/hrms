import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** RM 1,234.56 — the ONLY currency formatter module agents should use. */
export function fmtRM(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}RM ${Math.abs(amount).toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** '2026-03-05' → '5 Mar 2026'. Accepts ISO date/datetime strings or Date. */
export function fmtDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Date → 'YYYY-MM'. Defaults to today. */
export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Whole days from a to b (b − a). Accepts ISO strings or Dates. */
export function daysBetween(a: string | Date, b: string | Date): number {
  const da = typeof a === 'string' ? new Date(a) : a;
  const db = typeof b === 'string' ? new Date(b) : b;
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** Age in whole years from an ISO date-of-birth, as of `asOf` (default today). */
export function ageFromDob(dob: string, asOf: Date = new Date()): number {
  const d = new Date(dob.length === 10 ? `${dob}T00:00:00` : dob);
  let age = asOf.getFullYear() - d.getFullYear();
  const mDiff = asOf.getMonth() - d.getMonth();
  if (mDiff < 0 || (mDiff === 0 && asOf.getDate() < d.getDate())) age -= 1;
  return age;
}

/** 'Ahmad Faizal' → 'AF' — for initials avatars (no external images). */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** Round to 2 decimal places (sen) — half-up, the payroll convention. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Deterministic avatar tint from a name (warm palette). */
export function avatarTone(name: string): string {
  const tones = [
    'bg-amber-100 text-amber-800',
    'bg-orange-100 text-orange-800',
    'bg-stone-200 text-stone-700',
    'bg-yellow-100 text-yellow-800',
    'bg-red-100 text-red-800',
    'bg-lime-100 text-lime-800',
  ];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 997;
  return tones[h % tones.length];
}
