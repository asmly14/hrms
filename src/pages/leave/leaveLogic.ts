/**
 * Leave domain logic for the M4 Leave module.
 *
 * Statutory basis (docs/research/employment-law.md §7–§10, §21):
 *  - Annual leave  — EA 1955 s.60E: 8 / 12 / 16 days for <2 / 2–<5 / ≥5 yrs service.
 *  - Sick leave    — EA 1955 s.60F: 14 / 18 / 22 days + SEPARATE 60-day
 *                    hospitalization pool (aggregate, 2022 amendment).
 *  - Maternity     — EA 1955 s.37(1): 98 consecutive days (allowance rules s.37(2)).
 *  - Paternity     — EA 1955 s.60FA: 7 consecutive days per confinement.
 *  - Part-time     — Employment (Part-Time Employees) Regulations 2010:
 *                    AL 6 / 8 / 11, SL 10 / 13 / 15 by the same service tiers.
 * Day counting: working days exclude the employee's state weekend and public
 * holidays (isWeekend / isHoliday from @/lib/holidays) — those days do not
 * consume leave balance. Maternity & paternity are calendar-day entitlements.
 */
import { isHoliday, isWeekend } from '@/lib/holidays';
import { getCollection } from '@/lib/db';
import { daysBetween } from '@/lib/utils';
import type {
  Employee, Holiday, LeaveBalance, LeaveRequest, LeaveType, StateCode,
} from '@/lib/types';

/** LeaveRequest plus M4-local fields persisted through the same collection. */
export type LeaveRequestEx = LeaveRequest & {
  /** Approver remark captured at decide time (contract gap: no field in LeaveRequest). */
  decisionRemarks?: string;
  /** Half-day portion when the request is a single half day. */
  halfDay?: 'am' | 'pm';
};

/** EA 1955 statutory constants (days). */
export const MATERNITY_DAYS = 98; // s.37(1), from 1 Jan 2023
export const PATERNITY_DAYS = 7; // s.60FA, from 1 Jan 2023
export const HOSPITALIZATION_DAYS = 60; // s.60F aggregate pool

/** Leave types that draw down a tracked LeaveBalance bucket. */
export type TrackedLeaveType = 'annual' | 'sick' | 'hospitalization';

/** Company bonus leave days granted ON TOP of EA 1955 statutory minimums (EA s.7). */
export interface LeaveTopUpDays {
  annual: number;
  sick: number;
  hospitalization: number;
  maternity: number;
  paternity: number;
}

const ZERO_TOPUPS: LeaveTopUpDays = {
  annual: 0, sick: 0, hospitalization: 0, maternity: 0, paternity: 0,
};

/**
 * Company leave top-ups from the extended settings record ('ext:leaveTopups',
 * written by Settings → Leave policy). Graceful fallback: any read or shape
 * problem yields zero top-ups, i.e. pure EA statutory minimums.
 */
export function leaveTopUps(): LeaveTopUpDays {
  try {
    const row = getCollection<{ id: string; kind?: string; days?: Record<string, unknown> }>('settings')
      .find((r) => r.id === 'ext:leaveTopups' || r.kind === 'leaveTopups');
    if (!row?.days) return ZERO_TOPUPS;
    const d = row.days;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    return {
      annual: num(d.annual),
      sick: num(d.sick),
      hospitalization: num(d.hospitalization),
      maternity: num(d.maternity),
      paternity: num(d.paternity),
    };
  } catch {
    return ZERO_TOPUPS;
  }
}

export const LEAVE_TYPE_META: Record<LeaveType, { label: string; chip: string; hint: string }> = {
  annual: {
    label: 'Annual',
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
    hint: 'EA 1955 s.60E — paid, tiered by service length.',
  },
  sick: {
    label: 'Sick',
    chip: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
    hint: 'EA 1955 s.60F — MC required; inform employer within 48 hours.',
  },
  hospitalization: {
    label: 'Hospitalization',
    chip: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
    hint: 'EA 1955 s.60F — separate 60-day aggregate pool.',
  },
  maternity: {
    label: 'Maternity',
    chip: 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-200',
    hint: 'EA 1955 s.37 — 98 consecutive days, paid at ORP.',
  },
  paternity: {
    label: 'Paternity',
    chip: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200',
    hint: 'EA 1955 s.60FA — 7 consecutive days per confinement.',
  },
  unpaid: {
    label: 'Unpaid',
    chip: 'bg-stone-200 text-stone-700 dark:bg-stone-700/50 dark:text-stone-200',
    hint: 'Deducted from payroll at ORP per day (s.60I).',
  },
  emergency: {
    label: 'Emergency',
    chip: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
    hint: 'Company policy — paid, not deducted from statutory balances.',
  },
  compassionate: {
    label: 'Compassionate',
    chip: 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-200',
    hint: 'Company policy — paid, not deducted from statutory balances.',
  },
};

export const LEAVE_TYPES = Object.keys(LEAVE_TYPE_META) as LeaveType[];

export function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseISO(iso: string): Date {
  return new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
}

/** Completed years of continuous service (EA tiers run on service anniversaries). */
export function completedServiceYears(joinDate: string, asOf: Date = new Date()): number {
  const j = parseISO(joinDate);
  let yrs = asOf.getFullYear() - j.getFullYear();
  const mDiff = asOf.getMonth() - j.getMonth();
  if (mDiff < 0 || (mDiff === 0 && asOf.getDate() < j.getDate())) yrs -= 1;
  return Math.max(0, yrs);
}

export type ServiceTier = 0 | 1 | 2; // <2 yrs | 2–<5 yrs | ≥5 yrs

export function serviceTier(years: number): ServiceTier {
  return years >= 5 ? 2 : years >= 2 ? 1 : 0;
}

export const TIER_LABELS = ['< 2 yrs', '2–5 yrs', '≥ 5 yrs'] as const;

export interface Entitlements {
  annual: number;
  sick: number;
  hospitalization: number;
  maternity: number;
  paternity: number;
  partTime: boolean;
  serviceYears: number;
  tier: ServiceTier;
  /** Date the employee steps up to the next annual/sick tier, if any. */
  nextTierAt: string | null;
  /** Company top-up days already INCLUDED in the figures above. */
  topUps: LeaveTopUpDays;
}

/**
 * EA 1955 / Part-Time Regulations 2010 entitlements for an employee.
 * Full-time & contract → EA tiers; part-time → 2010 Regulations tiers.
 * Company top-up days (Settings → Leave policy) are added on top of the
 * statutory minimums (EA s.7 — more-favourable terms prevail).
 */
export function eaEntitlements(emp: Employee, asOf: Date = new Date()): Entitlements {
  const yrs = completedServiceYears(emp.joinDate, asOf);
  const tier = serviceTier(yrs);
  const partTime = emp.employmentType === 'part-time';
  const top = leaveTopUps();
  const annual = (partTime ? [6, 8, 11] : [8, 12, 16])[tier] + top.annual;
  const sick = (partTime ? [10, 13, 15] : [14, 18, 22])[tier] + top.sick;
  let nextTierAt: string | null = null;
  if (tier < 2) {
    const j = parseISO(emp.joinDate);
    const target = tier === 0 ? 2 : 5;
    nextTierAt = toISO(new Date(j.getFullYear() + target, j.getMonth(), j.getDate()));
  }
  return {
    annual, sick,
    hospitalization: HOSPITALIZATION_DAYS + top.hospitalization,
    maternity: MATERNITY_DAYS + top.maternity,
    paternity: PATERNITY_DAYS + top.paternity,
    partTime, serviceYears: yrs, tier, nextTierAt, topUps: top,
  };
}

export interface DayCount {
  /** Days that consume balance (working days, or calendar days for maternity/paternity). */
  days: number;
  workingDays: number;
  weekendDays: number;
  holidays: Holiday[];
}

const MAX_RANGE_DAYS = 400;

/**
 * Count leave consumption for a date range in the employee's work state.
 * Working-day types skip state weekends + public holidays (EA: a PH inside
 * annual/sick leave is substituted, not consumed). Maternity & paternity are
 * consecutive calendar days by statute.
 */
export function countLeaveDays(
  type: LeaveType,
  startISO: string,
  endISO: string,
  state: StateCode,
  halfDay?: 'am' | 'pm',
): DayCount {
  const holidays: Holiday[] = [];
  if (!startISO || !endISO || endISO < startISO) {
    return { days: 0, workingDays: 0, weekendDays: 0, holidays };
  }
  if (halfDay && startISO === endISO && type !== 'maternity' && type !== 'paternity') {
    const weekend = isWeekend(startISO, state);
    const h = isHoliday(startISO, state);
    if (h) holidays.push(h);
    // B3: a half day on a rest day / public holiday is not chargeable — the
    // day is already non-working, so it must not consume balance.
    const chargeable = !weekend && !h;
    return {
      days: chargeable ? 0.5 : 0,
      workingDays: chargeable ? 0.5 : 0,
      weekendDays: weekend ? 1 : 0,
      holidays,
    };
  }
  const start = parseISO(startISO);
  const end = parseISO(endISO);
  const calendarDays = Math.min(daysBetween(start, end) + 1, MAX_RANGE_DAYS);
  if (type === 'maternity' || type === 'paternity') {
    for (let i = 0; i < calendarDays; i += 1) {
      const d = new Date(start.getTime());
      d.setDate(d.getDate() + i);
      const h = isHoliday(d, state);
      if (h) holidays.push(h);
    }
    return { days: calendarDays, workingDays: calendarDays, weekendDays: 0, holidays };
  }
  let working = 0;
  let weekends = 0;
  for (let i = 0; i < calendarDays; i += 1) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + i);
    if (isWeekend(d, state)) { weekends += 1; continue; }
    const h = isHoliday(d, state);
    if (h) { holidays.push(h); continue; }
    working += 1;
  }
  return { days: working, workingDays: working, weekendDays: weekends, holidays };
}

/** Inclusive date-range overlap test. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** First pending/approved request of the employee overlapping [startISO, endISO]. */
export function overlappingRequest(
  leaves: LeaveRequestEx[],
  employeeId: string,
  startISO: string,
  endISO: string,
  excludeId?: string,
): LeaveRequestEx | undefined {
  return leaves.find(
    (l) => l.employeeId === employeeId
      && l.id !== excludeId
      && (l.status === 'pending' || l.status === 'approved')
      && rangesOverlap(l.startDate, l.endDate, startISO, endISO),
  );
}

/** Stored balance row for an employee-year, if any. */
export function balanceFor(
  balances: LeaveBalance[],
  employeeId: string,
  year: number,
): LeaveBalance | undefined {
  return balances.find((b) => b.employeeId === employeeId && b.year === year);
}

/**
 * Balance row for the year — the stored row, or a virtual row computed on the
 * fly from EA entitlements (as of 1 Jan of that year) when none exists yet.
 */
export function effectiveBalance(
  emp: Employee,
  balances: LeaveBalance[],
  year: number,
): LeaveBalance {
  const stored = balanceFor(balances, emp.id, year);
  if (stored) return stored;
  const ent = eaEntitlements(emp, new Date(year, 0, 1));
  return {
    id: `virtual-${emp.id}-${year}`,
    employeeId: emp.id,
    year,
    annualEntitled: ent.annual,
    annualUsed: 0,
    sickEntitled: ent.sick,
    sickUsed: 0,
    hospitalizationEntitled: ent.hospitalization,
    hospitalizationUsed: 0,
    carriedForward: 0,
  };
}

/** Days of `type` already pending for the employee in a year (not yet decided). */
export function pendingDaysFor(
  leaves: LeaveRequestEx[],
  employeeId: string,
  type: LeaveType,
  year: number,
  excludeId?: string,
): number {
  return leaves
    .filter(
      (l) => l.employeeId === employeeId
        && l.type === type
        && l.status === 'pending'
        && l.id !== excludeId
        && Number(l.startDate.slice(0, 4)) === year,
    )
    .reduce((s, l) => s + l.days, 0);
}

export interface BalanceView {
  tracked: boolean;
  entitled: number;
  used: number;
  pending: number;
  /** entitled + carriedForward − used − pending (tracked types only). */
  available: number;
}

/** Remaining view for one leave type against a balance row. */
export function balanceView(
  balance: LeaveBalance,
  type: LeaveType,
  pendingDays: number,
): BalanceView {
  if (type === 'annual') {
    const entitled = balance.annualEntitled + balance.carriedForward;
    return {
      tracked: true, entitled, used: balance.annualUsed, pending: pendingDays,
      available: entitled - balance.annualUsed - pendingDays,
    };
  }
  if (type === 'sick') {
    return {
      tracked: true, entitled: balance.sickEntitled, used: balance.sickUsed, pending: pendingDays,
      available: balance.sickEntitled - balance.sickUsed - pendingDays,
    };
  }
  if (type === 'hospitalization') {
    return {
      tracked: true, entitled: balance.hospitalizationEntitled, used: balance.hospitalizationUsed,
      pending: pendingDays, available: balance.hospitalizationEntitled - balance.hospitalizationUsed - pendingDays,
    };
  }
  return { tracked: false, entitled: 0, used: 0, pending: pendingDays, available: Infinity };
}

/** Apply approved days of a tracked type to a balance row (returns the patch). */
export function usagePatch(balance: LeaveBalance, type: LeaveType, days: number): Partial<LeaveBalance> {
  if (type === 'annual') return { annualUsed: balance.annualUsed + days };
  if (type === 'sick') return { sickUsed: balance.sickUsed + days };
  if (type === 'hospitalization') return { hospitalizationUsed: balance.hospitalizationUsed + days };
  return {};
}

/**
 * EA entitlement columns for an employee-year (as of 1 Jan). Components merge
 * these into an existing row (used columns kept) or a fresh row (used = 0).
 */
export function entitlementColumns(
  emp: Employee,
  year: number,
): Pick<LeaveBalance, 'annualEntitled' | 'sickEntitled' | 'hospitalizationEntitled'> {
  const ent = eaEntitlements(emp, new Date(year, 0, 1));
  return {
    annualEntitled: ent.annual,
    sickEntitled: ent.sick,
    hospitalizationEntitled: ent.hospitalization,
  };
}
