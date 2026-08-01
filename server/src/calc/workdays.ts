/**
 * Working-days & proration engine — SERVER PORT.
 *
 * ⚠️ SYNC NOTE: dependency-free port of hrms-web/src/lib/workdays.ts. The web
 * module reads the active company (lib/db) and effective holidays
 * (lib/holidays); here both are explicit parameters:
 *   - the proration method comes from the route (company config JSONB), and
 *   - `overrides` are the admin holiday overrides loaded from the holidays
 *     table, layered over the curated calendar (./holidays.ts port).
 * The logic below mirrors the web module function-for-function — re-port
 * manually when the web workdays.ts changes.
 */

import { round2 } from './utils';
import { getEffectiveHolidays, isWeekend } from './holidays';
import type { Holiday, PayrollProrationMethod, StateCode } from './types';

export type { PayrollProrationMethod };

/** Human-readable basis labels for payslips / UI. */
export const PRORATION_LABELS: Record<PayrollProrationMethod, string> = {
  calendar: 'calendar days',
  'working-days': 'working days',
  'fixed-26': 'fixed 26 days',
};

/** Proration method from a company's config JSONB ('calendar' when unconfigured). */
export function resolveProrationMethod(config: unknown): PayrollProrationMethod {
  const m = (config as { payrollProration?: string } | null | undefined)?.payrollProration;
  return m === 'working-days' || m === 'fixed-26' ? m : 'calendar';
}

function monthBounds(month: string): { start: Date; end: Date; days: number } {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(y ?? 1970, (m ?? 1) - 1, 1);
  const end = new Date(y ?? 1970, m ?? 1, 0);
  return { start, end, days: end.getDate() };
}

/** Calendar days in month 'YYYY-MM' (28–31). */
export function calendarDaysInMonth(month: string): number {
  return monthBounds(month).days;
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Working days in a month for a state: every calendar day that is neither a
 * weekend (fri-sat for JHR/KDH/KTN/TRG, sat-sun elsewhere) nor an effective
 * public holiday (base + in-lieu replacements, EA 1955 s.60D proviso).
 */
export function workingDaysInMonth(month: string, state: StateCode, overrides: Holiday[] = []): number {
  return workingDatesInRange(monthBounds(month).start, monthBounds(month).end, state, overrides).length;
}

/** Working-day dates (ISO) within [from, to] inclusive for a state. */
function workingDatesInRange(from: Date, to: Date, state: StateCode, overrides: Holiday[]): string[] {
  const out: string[] = [];
  const years = new Set([from.getFullYear(), to.getFullYear()]);
  const holidayDates = new Set<string>();
  for (const y of years) {
    for (const h of getEffectiveHolidays(y, state, overrides)) holidayDates.add(h.date);
  }
  const d = new Date(from.getTime());
  while (d <= to) {
    if (!isWeekend(d, state) && !holidayDates.has(toISO(d))) out.push(toISO(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Denominator of a proration basis for a month ('fixed-26' → 26). */
export function daysInBasis(
  month: string,
  state: StateCode,
  method: PayrollProrationMethod,
  overrides: Holiday[] = [],
): number {
  if (method === 'fixed-26') return 26;
  if (method === 'working-days') return workingDaysInMonth(month, state, overrides);
  return calendarDaysInMonth(month);
}

export interface EmploymentWindow {
  joinDate: string;
  resignDate?: string;
  state: StateCode;
}

/** Employment window [from, to] clipped to the month; null when not employed. */
function employmentWindow(emp: EmploymentWindow, month: string): { from: Date; to: Date } | null {
  const { start, end } = monthBounds(month);
  const join = new Date(`${emp.joinDate}T00:00:00`);
  const resign = emp.resignDate ? new Date(`${emp.resignDate}T00:00:00`) : null;
  const from = join > start ? join : start;
  const to = resign && resign < end ? resign : end;
  if (to < from) return null;
  return { from, to };
}

/**
 * Days of employment inside `month`, measured on the proration basis:
 *  - calendar     → calendar days from join/resign boundary
 *  - working-days → state-aware working days inside the employment window
 *  - fixed-26     → calendar days employed, capped at 26 (the ORP divisor)
 * Returns 0 when the employee was not employed at all during the month.
 */
export function employedDaysInMonth(
  emp: EmploymentWindow,
  month: string,
  method: PayrollProrationMethod,
  overrides: Holiday[] = [],
): number {
  const w = employmentWindow(emp, month);
  if (!w) return 0;
  if (method === 'working-days') return workingDatesInRange(w.from, w.to, emp.state, overrides).length;
  const calDays = Math.round((w.to.getTime() - w.from.getTime()) / 86_400_000) + 1;
  return method === 'fixed-26' ? Math.min(26, calDays) : calDays;
}

export interface ProrationResult {
  /** Prorated amount (round2). */
  amount: number;
  /** daysWorked ÷ daysInBasis, capped at 1. 1 = full month, no proration. */
  factor: number;
  daysWorked: number;
  daysInBasis: number;
  method: PayrollProrationMethod;
}

/**
 * Prorate a monthly amount for an employee in a month. Full-month employment
 * yields factor 1 and the untouched amount; mid-month joiners/leavers get
 * monthly × daysWorked ÷ daysInBasis on the configured basis.
 */
export function prorate(
  monthlyAmount: number,
  emp: EmploymentWindow,
  month: string,
  method: PayrollProrationMethod,
  overrides: Holiday[] = [],
): ProrationResult {
  const basis = daysInBasis(month, emp.state, method, overrides);
  const worked = employedDaysInMonth(emp, month, method, overrides);
  const factor = basis > 0 ? Math.min(1, worked / basis) : 1;
  return {
    amount: round2(monthlyAmount * factor),
    factor,
    daysWorked: worked,
    daysInBasis: basis,
    method,
  };
}

export interface UnpaidLeaveLike {
  employeeId: string;
  type: string;
  status: string;
  startDate: string;
  endDate: string;
}

/**
 * Unpaid-leave days to deduct for an employee in a month, counted on the SAME
 * basis as the proration method (consistency fix — previously always counted
 * calendar days and deducted at ORP ÷26 regardless of company policy):
 *  - calendar / fixed-26 → calendar days of approved unpaid leave in the month
 *  - working-days        → working days of approved unpaid leave in the month
 */
export function unpaidLeaveDaysInMonth(
  leaves: UnpaidLeaveLike[],
  employeeId: string,
  month: string,
  state: StateCode,
  method: PayrollProrationMethod,
  overrides: Holiday[] = [],
): number {
  const { start, end } = monthBounds(month);
  let days = 0;
  for (const l of leaves) {
    if (l.employeeId !== employeeId || l.type !== 'unpaid' || l.status !== 'approved') continue;
    const s = new Date(`${l.startDate}T00:00:00`);
    const e = new Date(`${l.endDate}T00:00:00`);
    const from = s > start ? s : start;
    const to = e < end ? e : end;
    if (to < from) continue;
    if (method === 'working-days') {
      days += workingDatesInRange(from, to, state, overrides).length;
    } else {
      days += Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    }
  }
  return days;
}
