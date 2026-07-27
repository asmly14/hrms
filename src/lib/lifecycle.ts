/**
 * Employee lifecycle engine — onboarding & offboarding.
 *
 * Owned by the Lifecycle module agent (Wave 1). Pure client-side: checklist
 * template engine + Malaysian statutory helpers (EA 1955 s.12 notice tiers,
 * Termination & Lay-Off Benefits Regulations 1980 schedule, LHDN CP22A timing)
 * + localStorage-backed stores that reuse the db.ts pub/sub mechanism.
 *
 * Storage note: db.ts `COLLECTIONS` is core-scaffold owned and cannot be
 * extended by this module, so lifecycle collections register their keys via a
 * typed cast — same `myhrms:` prefix, same reactive `useCollection` semantics.
 */
import { logAudit, uid, useCollection, type CollectionName } from './db';
import type { Claim, Employee, LeaveBalance } from './types';
import { round2 } from './utils';

/* ────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────── */

export type OnboardingCategory =
  | 'Documents'
  | 'IT & Assets'
  | 'Access'
  | 'Orientation'
  | 'Compliance';

export interface ChecklistItem {
  id: string;
  label: string;
  category: OnboardingCategory;
  done: boolean;
  doneBy?: string;
  doneAt?: string; // ISO datetime
}

export type OnboardingStatus = 'not-started' | 'in-progress' | 'completed';

export interface OnboardingChecklist {
  id: string;
  employeeId: string;
  template: string; // key of ONBOARDING_TEMPLATES
  items: ChecklistItem[];
  startDate: string; // ISO date — first working day
  buddyId?: string;
  status: OnboardingStatus;
  createdAt: string; // ISO datetime
}

export type OffboardingReason =
  | 'resignation'
  | 'retirement'
  | 'retrenchment'
  | 'termination';

export type ClearanceCategory =
  | 'Assets'
  | 'Access'
  | 'Knowledge Transfer'
  | 'Finance'
  | 'HR Admin';

export interface ClearanceItem {
  id: string;
  label: string;
  category: ClearanceCategory;
  done: boolean;
  doneBy?: string;
  doneAt?: string; // ISO datetime
}

export interface FinalPayBreakdown {
  /** Calendar days employed in the final month (1st → last working day). */
  daysWorkedInFinalMonth: number;
  daysInFinalMonth: number;
  proratedSalary: number;
  unusedLeaveDays: number;
  /** Unused annual leave × ORP (monthly salary ÷ 26). */
  leaveEncashment: number;
  /** Approved-but-unpaid claims reimbursable in the final run. */
  pendingClaims: number;
  /** Manual deductions (advances, unreturned-asset charges, etc.). */
  deductions: number;
  /** Estimated gross-to-net preview: salary + encashment + claims − deductions. */
  estimatedTotal: number;
}

export type OffboardingStatus =
  | 'notice-given'
  | 'clearance-in-progress'
  | 'cleared'
  | 'exited';

export interface OffboardingCase {
  id: string;
  employeeId: string;
  reason: OffboardingReason;
  noticeDate: string; // ISO date
  lastWorkingDay: string; // ISO date
  /** EA 1955 s.12(2) minimum notice in weeks (4 / 6 / 8 by service tier). */
  noticeWeeks: number;
  clearanceItems: ClearanceItem[];
  finalPay: FinalPayBreakdown;
  /** LHDN CP22A — employer must notify ≥ 30 days before cessation. */
  cp22aDueDate: string; // ISO date
  status: OffboardingStatus;
  createdAt: string; // ISO datetime
}

/* ────────────────────────────────────────────────────────────
 * Date helpers (local, ISO-date based)
 * ──────────────────────────────────────────────────────────── */

function parseDate(iso: string): Date {
  return new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function addDays(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Whole years of service from joinDate to asOf (default today). */
export function yearsOfService(joinDate: string, asOf: string = toISODate(new Date())): number {
  const j = parseDate(joinDate);
  const a = parseDate(asOf);
  let years = a.getFullYear() - j.getFullYear();
  if (a.getMonth() < j.getMonth() || (a.getMonth() === j.getMonth() && a.getDate() < j.getDate())) {
    years -= 1;
  }
  return Math.max(0, years);
}

/* ────────────────────────────────────────────────────────────
 * EA 1955 s.12(2) notice tiers & CP22A timing
 * ──────────────────────────────────────────────────────────── */

/**
 * Minimum statutory notice (weeks) based on length of service at notice date:
 * < 2 yrs → 4 weeks; 2 – <5 yrs → 6 weeks; ≥ 5 yrs → 8 weeks. (EA 1955 s.12(2))
 */
export function noticeWeeksFor(joinDate: string, asOf?: string): number {
  const yrs = yearsOfService(joinDate, asOf);
  if (yrs < 2) return 4;
  if (yrs < 5) return 6;
  return 8;
}

/** Last working day = day before the notice period runs out. */
export function lastWorkingDayFor(noticeDate: string, noticeWeeks: number): string {
  return addDays(noticeDate, noticeWeeks * 7 - 1);
}

/** CP22A must reach LHDN at least 30 days before the cessation date. */
export function cp22aDueDateFor(lastWorkingDay: string): string {
  return addDays(lastWorkingDay, -30);
}

/* ────────────────────────────────────────────────────────────
 * Retrenchment benefits — Employment (Termination and Lay-Off
 * Benefits) Regulations 1980, Reg. 6 (≥ 12 months' service)
 * ──────────────────────────────────────────────────────────── */

/** Days' wages per year of service: 10 / 15 / 20 by tier. */
export function retrenchmentDaysPerYear(years: number): number {
  if (years < 2) return 10;
  if (years < 5) return 15;
  return 20;
}

export interface RetrenchmentEstimate {
  eligible: boolean; // ≥ 12 months' continuous service
  yearsOfService: number;
  daysPerYear: number;
  /** Daily rate = last drawn monthly wages ÷ 26 (Reg. 6). */
  dailyRate: number;
  estimatedBenefit: number;
}

export function estimateRetrenchmentBenefit(
  monthlyWages: number,
  joinDate: string,
  exitDate: string,
): RetrenchmentEstimate {
  const years = yearsOfService(joinDate, exitDate);
  const months =
    years * 12 +
    (parseDate(exitDate).getMonth() - parseDate(joinDate).getMonth() + 12) % 12;
  const eligible = months >= 12;
  const daysPerYear = retrenchmentDaysPerYear(years);
  const dailyRate = round2(monthlyWages / 26);
  return {
    eligible,
    yearsOfService: years,
    daysPerYear,
    dailyRate,
    estimatedBenefit: eligible ? round2(dailyRate * daysPerYear * years) : 0,
  };
}

/* ────────────────────────────────────────────────────────────
 * Checklist templates
 * ──────────────────────────────────────────────────────────── */

export interface OnboardingTemplate {
  key: string;
  label: string;
  description: string;
  items: { label: string; category: OnboardingCategory }[];
}

export const ONBOARDING_TEMPLATES: OnboardingTemplate[] = [
  {
    key: 'standard',
    label: 'Standard — Full-time',
    description: 'Default 16-step journey for permanent hires.',
    items: [
      // Pre-boarding documents (Documents)
      { label: 'NRIC / passport copy received', category: 'Documents' },
      { label: 'Bank account details for salary (EA s.25)', category: 'Documents' },
      { label: 'EPF (KWSP) membership number captured', category: 'Documents' },
      { label: 'SOCSO number captured', category: 'Documents' },
      { label: 'Income tax number (LHDN) captured', category: 'Documents' },
      { label: 'TP3 form — previous-employer remuneration details', category: 'Documents' },
      // Compliance
      { label: 'Offer letter & employment contract signed', category: 'Compliance' },
      { label: 'Statutory registrations verified (EPF / SOCSO / EIS / PCB)', category: 'Compliance' },
      { label: 'EA 1955 particulars of employment acknowledged', category: 'Compliance' },
      // IT & Assets
      { label: 'Laptop & equipment issued', category: 'IT & Assets' },
      { label: 'Staff ID / access card issued', category: 'IT & Assets' },
      // Access
      { label: 'Company email account created', category: 'Access' },
      { label: 'HRMS & payroll portal access granted', category: 'Access' },
      { label: 'Shared drives / team tools access granted', category: 'Access' },
      // Orientation
      { label: 'Day-one orientation & office tour completed', category: 'Orientation' },
      { label: 'Introduced to buddy & department team', category: 'Orientation' },
      { label: 'Probation goals & 30-60-90 plan agreed', category: 'Orientation' },
    ],
  },
  {
    key: 'contract',
    label: 'Contract / Fixed-term',
    description: 'Lean 10-step path for contract staff.',
    items: [
      { label: 'NRIC / passport copy received', category: 'Documents' },
      { label: 'Bank account details for salary', category: 'Documents' },
      { label: 'EPF / SOCSO / tax numbers captured', category: 'Documents' },
      { label: 'TP3 form — previous-employer remuneration details', category: 'Documents' },
      { label: 'Fixed-term contract signed (end date stated)', category: 'Compliance' },
      { label: 'Statutory registrations verified (EPF / SOCSO / EIS / PCB)', category: 'Compliance' },
      { label: 'Equipment issued (deposit recorded if any)', category: 'IT & Assets' },
      { label: 'Company email & HRMS access granted', category: 'Access' },
      { label: 'Reporting line & project scope briefed', category: 'Orientation' },
      { label: 'End-of-contract terms explained', category: 'Orientation' },
    ],
  },
];

export const ONBOARDING_CATEGORIES: OnboardingCategory[] = [
  'Documents',
  'IT & Assets',
  'Access',
  'Orientation',
  'Compliance',
];

export interface ClearanceTemplate {
  key: string;
  label: string;
  items: { label: string; category: ClearanceCategory }[];
}

export const CLEARANCE_TEMPLATES: ClearanceTemplate[] = [
  {
    key: 'standard-exit',
    label: 'Standard exit clearance',
    items: [
      { label: 'Laptop, monitor & peripherals returned', category: 'Assets' },
      { label: 'Access card / staff ID surrendered', category: 'Assets' },
      { label: 'Company phone / SIM returned', category: 'Assets' },
      { label: 'Email account deactivated', category: 'Access' },
      { label: 'HRMS & payroll portal access revoked', category: 'Access' },
      { label: 'Shared drives, SaaS & VPN access revoked', category: 'Access' },
      { label: 'Handover document completed & acknowledged', category: 'Knowledge Transfer' },
      { label: 'Ongoing tasks reassigned to successor', category: 'Knowledge Transfer' },
      { label: 'Outstanding claims & advances settled', category: 'Finance' },
      { label: 'Final pay computed & approved', category: 'Finance' },
      { label: 'CP22A filed with LHDN (≥ 30 days before exit)', category: 'HR Admin' },
      { label: 'Exit interview conducted', category: 'HR Admin' },
      { label: 'Service / relieving letter issued', category: 'HR Admin' },
    ],
  },
];

export const CLEARANCE_CATEGORIES: ClearanceCategory[] = [
  'Assets',
  'Access',
  'Knowledge Transfer',
  'Finance',
  'HR Admin',
];

/* ────────────────────────────────────────────────────────────
 * Builders & computations
 * ──────────────────────────────────────────────────────────── */

export function deriveOnboardingStatus(items: ChecklistItem[]): OnboardingStatus {
  const done = items.filter((i) => i.done).length;
  if (done === 0) return 'not-started';
  if (done === items.length) return 'completed';
  return 'in-progress';
}

export function deriveOffboardingStatus(
  items: ClearanceItem[],
  current: OffboardingStatus,
): OffboardingStatus {
  if (current === 'exited') return 'exited';
  const done = items.filter((i) => i.done).length;
  if (done === items.length && items.length > 0) return 'cleared';
  if (done > 0) return 'clearance-in-progress';
  return 'notice-given';
}

export function buildOnboardingChecklist(
  employeeId: string,
  templateKey: string,
  startDate: string,
  buddyId?: string,
): Omit<OnboardingChecklist, 'id'> {
  const tpl =
    ONBOARDING_TEMPLATES.find((t) => t.key === templateKey) ?? ONBOARDING_TEMPLATES[0]!;
  const items: ChecklistItem[] = tpl.items.map((it) => ({
    id: uid(),
    label: it.label,
    category: it.category,
    done: false,
  }));
  return {
    employeeId,
    template: tpl.key,
    items,
    startDate,
    buddyId: buddyId || undefined,
    status: 'not-started',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Final pay preview (EA 1955 s.20 — all earned wages payable by the day the
 * contract ends). Convention: incomplete-month salary prorated by calendar
 * days; leave encashment at ORP = monthly salary ÷ 26.
 */
export function computeFinalPay(input: {
  employee: Employee;
  lastWorkingDay: string;
  leaveBalances: LeaveBalance[];
  claims: Claim[];
  deductions?: number;
}): FinalPayBreakdown {
  const { employee, lastWorkingDay, leaveBalances, claims } = input;
  const lwd = parseDate(lastWorkingDay);
  const daysInFinalMonth = new Date(lwd.getFullYear(), lwd.getMonth() + 1, 0).getDate();
  const daysWorkedInFinalMonth = lwd.getDate();
  const proratedSalary = round2(
    (employee.baseSalary * daysWorkedInFinalMonth) / daysInFinalMonth,
  );

  const year = lwd.getFullYear();
  const bal = leaveBalances.find((b) => b.employeeId === employee.id && b.year === year);
  const unusedLeaveDays = bal
    ? Math.max(0, bal.annualEntitled + bal.carriedForward - bal.annualUsed)
    : 0;
  const orp = employee.baseSalary / 26;
  const leaveEncashment = round2(unusedLeaveDays * orp);

  const pendingClaims = round2(
    claims
      .filter((c) => c.employeeId === employee.id && c.status === 'approved')
      .reduce((s, c) => s + c.amount, 0),
  );

  const deductions = round2(Math.max(0, input.deductions ?? 0));
  const estimatedTotal = round2(proratedSalary + leaveEncashment + pendingClaims - deductions);

  return {
    daysWorkedInFinalMonth,
    daysInFinalMonth,
    proratedSalary,
    unusedLeaveDays,
    leaveEncashment,
    pendingClaims,
    deductions,
    estimatedTotal,
  };
}

export function buildOffboardingCase(input: {
  employee: Employee;
  reason: OffboardingReason;
  noticeDate: string;
  /** Optional override; defaults to EA s.12 statutory last working day. */
  lastWorkingDay?: string;
  leaveBalances: LeaveBalance[];
  claims: Claim[];
  deductions?: number;
}): Omit<OffboardingCase, 'id'> {
  const { employee, reason, noticeDate } = input;
  const noticeWeeks = noticeWeeksFor(employee.joinDate, noticeDate);
  const lastWorkingDay = input.lastWorkingDay || lastWorkingDayFor(noticeDate, noticeWeeks);
  const tpl = CLEARANCE_TEMPLATES[0]!;
  const clearanceItems: ClearanceItem[] = tpl.items.map((it) => ({
    id: uid(),
    label: it.label,
    category: it.category,
    done: false,
  }));
  return {
    employeeId: employee.id,
    reason,
    noticeDate,
    lastWorkingDay,
    noticeWeeks,
    clearanceItems,
    finalPay: computeFinalPay({
      employee,
      lastWorkingDay,
      leaveBalances: input.leaveBalances,
      claims: input.claims,
      deductions: input.deductions,
    }),
    cp22aDueDate: cp22aDueDateFor(lastWorkingDay),
    status: 'notice-given',
    createdAt: new Date().toISOString(),
  };
}

/* ────────────────────────────────────────────────────────────
 * Reactive stores — reuse db.ts pub/sub on module-owned keys.
 * ──────────────────────────────────────────────────────────── */

const asCollection = (name: string) => name as CollectionName;

export function useOnboardingChecklists() {
  return useCollection<OnboardingChecklist>(asCollection('onboardingChecklists'));
}

export function useOffboardingCases() {
  return useCollection<OffboardingCase>(asCollection('offboardingCases'));
}

/* ────────────────────────────────────────────────────────────
 * Status transitions with audit trail
 * ──────────────────────────────────────────────────────────── */

export function auditLifecycle(
  action: string,
  entityId: string | undefined,
  detail: string,
  actorName = 'HR Admin',
): void {
  logAudit({ actorName, action, entity: 'lifecycle', entityId, detail });
}

export const OFFBOARDING_REASON_LABELS: Record<OffboardingReason, string> = {
  resignation: 'Resignation',
  retirement: 'Retirement',
  retrenchment: 'Retrenchment',
  termination: 'Termination',
};

export const OFFBOARDING_STATUS_LABELS: Record<OffboardingStatus, string> = {
  'notice-given': 'Notice given',
  'clearance-in-progress': 'Clearance in progress',
  cleared: 'Cleared',
  exited: 'Exited',
};

export const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  completed: 'Completed',
};
