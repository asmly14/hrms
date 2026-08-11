/**
 * Employee separation engine — pure, testable logic behind the directory's
 * Resign / VSS / Other-separation / Delete actions (single + bulk).
 *
 * Deliberately hook-free: it reads/writes collections through db.ts's
 * non-reactive getCollection/setCollection (which still notify subscribers),
 * so the same code path serves the React dialogs and node-based vitest runs.
 *
 * Storage contract notes:
 * - Offboarding cases live on the first-class registry collection
 *   'offboardingCases' (lib/lifecycle.ts — P1 registry unification).
 * - lib/auth.ts exposes no public "remove user" API (readUsers/writeUsers are
 *   private). Account removal therefore writes the documented global
 *   'hrms.users' key directly — same pattern as pages/superadmin/lib.ts.
 */
import {
  getActiveTenantId,
  getCollection,
  logAudit,
  setCollection,
  uid,
  type CollectionName,
} from '@/lib/db';
import {
  OFFBOARDING_REASON_LABELS,
  buildOffboardingCase,
  noticeWeeksFor,
  lastWorkingDayFor,
  type OffboardingCase,
  type OffboardingReason,
  type VssPackage,
} from '@/lib/lifecycle';
import type { UserAccount } from '@/lib/auth';
import type {
  AttendanceRecord,
  Claim,
  Department,
  Employee,
  KPI,
  KPIReview,
  LeaveBalance,
  LeaveRequest,
  Payslip,
} from '@/lib/types';
import { round2 } from '@/lib/utils';

/* ────────────────────────────────────────────────────────────
 * Spec & result types
 * ──────────────────────────────────────────────────────────── */

export type SeparationKind = 'resign' | 'vss' | 'other';

/** Reasons offered by the "Other separation" dialog. */
export type OtherSeparationReason =
  | 'contract-end'
  | 'retirement'
  | 'termination'
  | 'absconded';

export interface SeparationSpec {
  kind: SeparationKind;
  /** Required when kind === 'other'. */
  otherReason?: OtherSeparationReason;
  /** ISO date — notice date (defaults to today at apply time). */
  noticeDate: string;
  /** ISO date — shared across a bulk batch. */
  lastWorkingDay: string;
  remarks?: string;
  /** VSS package terms (kind === 'vss'). amount is derived — see computeVssAmount. */
  vss?: { months: number; lastDrawnSalary: number; terms?: string };
}

export const OTHER_SEPARATION_REASON_LABELS: Record<OtherSeparationReason, string> = {
  'contract-end': 'Contract end',
  retirement: 'Retirement',
  termination: 'Termination',
  absconded: 'Absconded',
};

/** Map a dialog spec onto the lifecycle OffboardingReason union. */
export function offboardingReasonFor(spec: SeparationSpec): OffboardingReason {
  if (spec.kind === 'resign') return 'resignation';
  if (spec.kind === 'vss') return 'vss';
  return spec.otherReason ?? 'termination';
}

/* ────────────────────────────────────────────────────────────
 * VSS math
 * ──────────────────────────────────────────────────────────── */

/** Ex-gratia payout = months × last drawn monthly salary (2dp). */
export function computeVssAmount(months: number, lastDrawnSalary: number): number {
  if (!Number.isFinite(months) || !Number.isFinite(lastDrawnSalary)) return 0;
  return round2(Math.max(0, months) * Math.max(0, lastDrawnSalary));
}

export function buildVssPackage(spec: NonNullable<SeparationSpec['vss']>): VssPackage {
  return {
    months: spec.months,
    amount: computeVssAmount(spec.months, spec.lastDrawnSalary),
    ...(spec.terms?.trim() ? { terms: spec.terms.trim() } : {}),
  };
}

/* ────────────────────────────────────────────────────────────
 * Guards
 * ──────────────────────────────────────────────────────────── */

/** True when any payslip exists for the employee (statutory records). */
export function hasPayslips(payslips: Payslip[], employeeId: string): boolean {
  return payslips.some((p) => p.employeeId === employeeId);
}

/**
 * Statutory retention guard: EPF Act 1991 / EA 1955 records must be kept
 * 6–7 years, so a paid employee's record cannot be hard-deleted. Returns the
 * human-readable block reason, or null when deletion is allowed.
 */
export function deleteBlockReason(payslips: Payslip[], employee: Employee): string | null {
  if (hasPayslips(payslips, employee.id)) {
    return 'has payslips on file — statutory payroll records must be retained 6–7 years (resign instead)';
  }
  return null;
}

/** Separation guard: already-resigned employees can't be separated again. */
export function separationBlockReason(employee: Employee): string | null {
  return employee.status === 'resigned' ? 'already resigned' : null;
}

/* ────────────────────────────────────────────────────────────
 * Payload construction (pure)
 * ──────────────────────────────────────────────────────────── */

export interface SeparationPayload {
  /** Shallow-merge patch for the employees collection. */
  employeePatch: Partial<Employee>;
  /** OffboardingCase payload (id assigned by the store). */
  casePayload: Omit<OffboardingCase, 'id'>;
}

/**
 * Build the employee patch + offboarding case for one separation.
 * Every separation path ends with status 'resigned' + resignDate = LWD;
 * absconded adds an explanatory note on the case (EA s.12(3) inquiry flag).
 */
export function buildSeparationPayload(
  employee: Employee,
  spec: SeparationSpec,
  leaveBalances: LeaveBalance[],
  claims: Claim[],
): SeparationPayload {
  const reason = offboardingReasonFor(spec);
  const notes =
    reason === 'absconded'
      ? [spec.remarks?.trim(), 'Marked as absconded — conduct EA s.12(3) inquiry before final exit.']
          .filter(Boolean)
          .join(' · ')
      : spec.remarks?.trim() || undefined;

  const casePayload = buildOffboardingCase({
    employee,
    reason,
    noticeDate: spec.noticeDate,
    lastWorkingDay: spec.lastWorkingDay,
    leaveBalances,
    claims,
    vssPackage: spec.kind === 'vss' && spec.vss ? buildVssPackage(spec.vss) : undefined,
    notes,
  });

  return {
    employeePatch: { status: 'resigned', resignDate: spec.lastWorkingDay },
    casePayload,
  };
}

/* ────────────────────────────────────────────────────────────
 * Stores (first-class registry collections — db.ts COLLECTIONS)
 * ──────────────────────────────────────────────────────────── */

const OFFBOARDING: CollectionName = 'offboardingCases';

export function getOffboardingCases(): OffboardingCase[] {
  return getCollection<OffboardingCase>(OFFBOARDING);
}

function addOffboardingCase(payload: Omit<OffboardingCase, 'id'>): OffboardingCase {
  const kase = { ...payload, id: uid() } as OffboardingCase;
  setCollection(OFFBOARDING, [...getOffboardingCases(), kase]);
  return kase;
}

/* ────────────────────────────────────────────────────────────
 * Apply — single & bulk
 * ──────────────────────────────────────────────────────────── */

export interface BulkItemResult {
  employeeId: string;
  name: string;
  /** Permanent-delete only: per-collection cascade counts for this employee. */
  cascade?: DeleteResult;
}

export interface BulkSkippedResult extends BulkItemResult {
  reason: string;
}

export interface BulkSeparationResult {
  succeeded: BulkItemResult[];
  skipped: BulkSkippedResult[];
}

/** Apply one separation (employee patch + case + audit). Assumes guards passed. */
export function applySeparation(
  employee: Employee,
  spec: SeparationSpec,
  actorName: string,
): SeparationPayload {
  const leaveBalances = getCollection<LeaveBalance>('leaveBalances');
  const claims = getCollection<Claim>('claims');
  const { employeePatch, casePayload } = buildSeparationPayload(
    employee,
    spec,
    leaveBalances,
    claims,
  );

  const employees = getCollection<Employee>('employees');
  setCollection(
    'employees',
    employees.map((e) => (e.id === employee.id ? { ...e, ...employeePatch } : e)),
  );
  const created = addOffboardingCase(casePayload);

  const reasonLabel = OFFBOARDING_REASON_LABELS[casePayload.reason];
  const vssNote = casePayload.vssPackage
    ? `; VSS package ${casePayload.vssPackage.months} mo × salary ≈ RM ${casePayload.vssPackage.amount.toLocaleString('en-MY')}`
    : '';
  logAudit({
    actorName,
    action: `employee.separate.${casePayload.reason}`,
    entity: 'employees',
    entityId: employee.id,
    detail: `${employee.name} separated (${reasonLabel}); notice ${spec.noticeDate}, LWD ${spec.lastWorkingDay}; offboarding case ${created.id}${vssNote}`,
  });

  return { employeePatch, casePayload };
}

/**
 * Bulk separation — one shared spec for the batch, per-employee results.
 * Already-resigned employees are skipped (delete remains available to them).
 */
export function bulkSeparate(
  employees: Employee[],
  spec: SeparationSpec,
  actorName: string,
  onProgress?: (done: number, total: number) => void,
): BulkSeparationResult {
  const result: BulkSeparationResult = { succeeded: [], skipped: [] };
  employees.forEach((employee, i) => {
    const blocked = separationBlockReason(employee);
    if (blocked) {
      result.skipped.push({ employeeId: employee.id, name: employee.name, reason: blocked });
    } else {
      applySeparation(employee, spec, actorName);
      result.succeeded.push({ employeeId: employee.id, name: employee.name });
    }
    onProgress?.(i + 1, employees.length);
  });
  return result;
}

/* ────────────────────────────────────────────────────────────
 * Permanent delete (payslip-guarded, cascading)
 * ──────────────────────────────────────────────────────────── */

/** Documented mock-auth directory key (see lib/auth.ts header). */
const USERS_KEY = 'hrms.users';

/** Remove the employee's mock-auth account(s) for the active tenant, if any. */
function removeUserAccounts(employeeId: string): number {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    if (!raw) return 0;
    const users = JSON.parse(raw) as UserAccount[];
    const tenantId = getActiveTenantId();
    const kept = users.filter(
      (u) => !(u.employeeId === employeeId && u.companyId === tenantId),
    );
    if (kept.length === users.length) return 0;
    localStorage.setItem(USERS_KEY, JSON.stringify(kept));
    return users.length - kept.length;
  } catch {
    return 0; // storage unavailable — non-fatal in demo mode
  }
}

/** Remove every record linked to the employee from a keyed collection. */
function purgeCollection<T extends { id: string; employeeId?: string }>(
  name: CollectionName,
  employeeId: string,
): number {
  const items = getCollection<T>(name);
  const kept = items.filter((it) => it.employeeId !== employeeId);
  if (kept.length !== items.length) setCollection(name, kept);
  return items.length - kept.length;
}

/**
 * Rewrite rows matching `pred` via `patch` (reference cleanup — rows are
 * KEPT, only the dangling employee link is nulled). Returns the count.
 */
function cleanReferences<T extends { id: string }>(
  name: CollectionName,
  pred: (item: T) => boolean,
  patch: (item: T) => T,
): number {
  const items = getCollection<T>(name);
  let count = 0;
  const next = items.map((it) => {
    if (!pred(it)) return it;
    count += 1;
    return patch(it);
  });
  if (count > 0) setCollection(name, next);
  return count;
}

/* Minimal structural row shapes for module collections. Deliberately NOT
 * imported from the module libs (contracts/employeeRecords/onboardLinks/
 * kpiEngine/attendance model) so this engine stays decoupled from their
 * internals — the cascade only needs the linking keys. */
type ContractRow = { id: string; employeeId?: string };
type FeePaymentRow = { id: string; contractId: string };
type SubmissionRow = { id: string; employeeId?: string };
type CheckInRow = { id: string; employeeId?: string; authorId?: string };
type ReviewRow = { id: string; employeeId?: string; reviewerId?: string };
type ShiftAssignmentRow = { id: string; employeeIds?: string[] };

/** Per-collection row counts for records OWNED by the employee (hard-deleted). */
export interface CascadeDeleteCounts {
  attendance: number;
  leaves: number;
  claims: number;
  leaveBalances: number;
  kpis: number;
  /** Reviews where the employee was the SUBJECT. */
  reviews: number;
  contracts: number;
  /** Fee payments of the deleted contracts (linked via contractId). */
  contractFeePayments: number;
  employeeRecords: number;
  onboardingExtras: number;
  onboardingChecklists: number;
  offboardingCases: number;
  objectives: number;
  /** Check-ins where the employee was the review subject. */
  checkins: number;
  pips: number;
  userAccounts: number;
}

/** Per-collection counts for employee REFERENCES cleaned in place (rows kept). */
export interface CascadeCleanupCounts {
  /** onboardSubmissions.employeeId cleared — the submission (declaration +
   *  document bytes) is kept as the statutory intake record. */
  onboardSubmissions: number;
  /** reviews.reviewerId cleared on OTHER employees' reviews the deleted
   *  employee was assigned to score (admin/HR can still complete them). */
  reviewAssignments: number;
  /** checkins.authorId cleared on notes the employee left on other people's
   *  review threads (authorName stays denormalized on the note). */
  checkinAuthorships: number;
  /** departments.headId cleared. */
  departmentHeads: number;
  /** Fixed shift assignments (shifts.employeeIds entries) removed. */
  shiftAssignments: number;
  /** Rotation-plan memberships (attendance:rotations employeeIds) removed. */
  rotationMemberships: number;
}

export interface DeleteResult {
  removedLinked: CascadeDeleteCounts;
  cleanedRefs: CascadeCleanupCounts;
}

/** All-zero cascade counts (starting point for aggregation). */
export function emptyCascadeCounts(): DeleteResult {
  return {
    removedLinked: {
      attendance: 0,
      leaves: 0,
      claims: 0,
      leaveBalances: 0,
      kpis: 0,
      reviews: 0,
      contracts: 0,
      contractFeePayments: 0,
      employeeRecords: 0,
      onboardingExtras: 0,
      onboardingChecklists: 0,
      offboardingCases: 0,
      objectives: 0,
      checkins: 0,
      pips: 0,
      userAccounts: 0,
    },
    cleanedRefs: {
      onboardSubmissions: 0,
      reviewAssignments: 0,
      checkinAuthorships: 0,
      departmentHeads: 0,
      shiftAssignments: 0,
      rotationMemberships: 0,
    },
  };
}

/** Sum two DeleteResults field-by-field (bulk aggregation). */
export function addCascadeCounts(a: DeleteResult, b: DeleteResult): DeleteResult {
  const sum = <K extends string>(x: Record<K, number>, y: Record<K, number>): Record<K, number> => {
    const out = { ...x };
    (Object.keys(y) as K[]).forEach((k) => {
      out[k] = x[k] + y[k];
    });
    return out;
  };
  return {
    removedLinked: sum(a.removedLinked, b.removedLinked),
    cleanedRefs: sum(a.cleanedRefs, b.cleanedRefs),
  };
}

const REMOVED_LABELS: [keyof CascadeDeleteCounts, string][] = [
  ['attendance', 'attendance'],
  ['leaves', 'leaves'],
  ['claims', 'claims'],
  ['leaveBalances', 'leave balances'],
  ['kpis', 'KPIs'],
  ['reviews', 'reviews'],
  ['contracts', 'contracts'],
  ['contractFeePayments', 'fee payments'],
  ['employeeRecords', 'record files'],
  ['onboardingExtras', 'onboarding extras'],
  ['onboardingChecklists', 'onboarding checklists'],
  ['offboardingCases', 'offboarding cases'],
  ['objectives', 'objectives'],
  ['checkins', 'check-ins'],
  ['pips', 'PIPs'],
  ['userAccounts', 'user accounts'],
];

const CLEANED_LABELS: [keyof CascadeCleanupCounts, string][] = [
  ['onboardSubmissions', 'submission links'],
  ['reviewAssignments', 'reviewer assignments'],
  ['checkinAuthorships', 'check-in authorships'],
  ['departmentHeads', 'department-head refs'],
  ['shiftAssignments', 'shift assignments'],
  ['rotationMemberships', 'rotation memberships'],
];

function nonZeroParts<K extends string>(counts: Record<K, number>, labels: [K, string][]): string[] {
  return labels.filter(([k]) => counts[k] > 0).map(([k, label]) => `${counts[k]} ${label}`);
}

/** Human-readable one-liner of a cascade result ("purged …; cleared …"). */
export function summarizeCascadeCounts(result: DeleteResult): string {
  const removed = nonZeroParts(result.removedLinked, REMOVED_LABELS);
  const cleaned = nonZeroParts(result.cleanedRefs, CLEANED_LABELS);
  const segments: string[] = [];
  if (removed.length > 0) segments.push(`purged ${removed.join(', ')}`);
  if (cleaned.length > 0) segments.push(`cleared ${cleaned.join(', ')}`);
  return segments.length > 0 ? segments.join('; ') : 'no linked records';
}

/**
 * Permanently delete an employee with a full cross-registry cascade
 * (audit-database §3.1 — the 9+ previously-orphaned collections). Caller
 * MUST check deleteBlockReason first — this function refuses (returns null)
 * when the payslip guard trips, as a defence-in-depth backstop.
 *
 * Cascade policy
 * ──────────────
 * HARD-DELETED (rows owned by the employee, keyed by employeeId):
 *   attendance, leaves, claims, leaveBalances, kpis, reviews (subject),
 *   contracts (+ their contractFeePayments via contractId), employeeRecords,
 *   onboardingExtras, onboardingChecklists, offboardingCases, objectives,
 *   checkins (subject), pips, mock-auth user accounts.
 *
 * CLEANED IN PLACE (row belongs to someone/something else — reference
 * nulled, record kept):
 *   - onboardSubmissions.employeeId — submission + document bytes are kept
 *     as the intake record (declaration trail); only the link to the gone
 *     employee record is dropped. The originating onboardLink carries no
 *     employeeId and keeps its truthful 'approved' status.
 *   - reviews.reviewerId on OTHER employees' reviews — unassigned ('');
 *     admin/HR can still manager-score them (kpiEngine fails open to HR).
 *   - checkins.authorId — the note stays on the other employee's thread with
 *     its denormalized authorName; only the id link is dropped.
 *   - departments.headId — department keeps existing, headless.
 *   - shifts.employeeIds / attendance:rotations employeeIds — fixed
 *     assignments and rotation memberships removed.
 *
 * UNTOUCHED BY DESIGN:
 *   payslips + payrollRuns (statutory payroll history — the guard blocks the
 *   delete outright when the employee has payslips), cycles (department
 *   scoped, no employeeId), positionProfiles / departmentProfiles / positions
 *   (position/department keyed — no employee references), onboardLinks (no
 *   employeeId field), holidays / settings (global), audit (append-only
 *   trail — including this deletion).
 */
export function deleteEmployeeCascade(
  employee: Employee,
  actorName: string,
): DeleteResult | null {
  const payslips = getCollection<Payslip>('payslips');
  if (deleteBlockReason(payslips, employee)) return null;

  // Contracts first: fee payments hang off contractId, so capture the doomed
  // contract ids before purging them.
  const contracts = getCollection<ContractRow>('contracts');
  const ownedContracts = contracts.filter((c) => c.employeeId === employee.id);
  if (ownedContracts.length > 0) {
    setCollection(
      'contracts',
      contracts.filter((c) => c.employeeId !== employee.id),
    );
  }
  const ownedContractIds = new Set(ownedContracts.map((c) => c.id));
  const feePayments = getCollection<FeePaymentRow>('contractFeePayments');
  const keptFeePayments = feePayments.filter((p) => !ownedContractIds.has(p.contractId));
  if (keptFeePayments.length !== feePayments.length) {
    setCollection('contractFeePayments', keptFeePayments);
  }

  const removedLinked: CascadeDeleteCounts = {
    attendance: purgeCollection<AttendanceRecord>('attendance', employee.id),
    leaves: purgeCollection<LeaveRequest>('leaves', employee.id),
    claims: purgeCollection<Claim>('claims', employee.id),
    leaveBalances: purgeCollection<LeaveBalance>('leaveBalances', employee.id),
    kpis: purgeCollection<KPI>('kpis', employee.id),
    reviews: purgeCollection<KPIReview>('reviews', employee.id),
    contracts: ownedContracts.length,
    contractFeePayments: feePayments.length - keptFeePayments.length,
    employeeRecords: purgeCollection('employeeRecords', employee.id),
    onboardingExtras: purgeCollection('onboardingExtras', employee.id),
    onboardingChecklists: purgeCollection('onboardingChecklists', employee.id),
    offboardingCases: purgeCollection<OffboardingCase>(OFFBOARDING, employee.id),
    objectives: purgeCollection('objectives', employee.id),
    checkins: purgeCollection<CheckInRow>('checkins', employee.id),
    pips: purgeCollection('pips', employee.id),
    userAccounts: removeUserAccounts(employee.id),
  };

  // Reference cleanup runs AFTER the purges so rows owned by the employee are
  // already gone and only other people's records are rewritten.
  const cleanedRefs: CascadeCleanupCounts = {
    onboardSubmissions: cleanReferences<SubmissionRow>(
      'onboardSubmissions',
      (s) => s.employeeId === employee.id,
      (s) => ({ ...s, employeeId: undefined }),
    ),
    reviewAssignments: cleanReferences<ReviewRow>(
      'reviews',
      (r) => r.reviewerId === employee.id,
      (r) => ({ ...r, reviewerId: '' }),
    ),
    checkinAuthorships: cleanReferences<CheckInRow>(
      'checkins',
      (c) => c.authorId === employee.id,
      (c) => ({ ...c, authorId: undefined }),
    ),
    departmentHeads: cleanReferences<Department>(
      'departments',
      (d) => d.headId === employee.id,
      (d) => ({ ...d, headId: undefined }),
    ),
    shiftAssignments: cleanReferences<ShiftAssignmentRow>(
      'shifts',
      (s) => (s.employeeIds ?? []).includes(employee.id),
      (s) => ({ ...s, employeeIds: (s.employeeIds ?? []).filter((x) => x !== employee.id) }),
    ),
    rotationMemberships: cleanReferences<ShiftAssignmentRow>(
      'attendance:rotations',
      (p) => (p.employeeIds ?? []).includes(employee.id),
      (p) => ({ ...p, employeeIds: (p.employeeIds ?? []).filter((x) => x !== employee.id) }),
    ),
  };

  setCollection(
    'employees',
    getCollection<Employee>('employees').filter((e) => e.id !== employee.id),
  );

  const result: DeleteResult = { removedLinked, cleanedRefs };

  logAudit({
    actorName,
    action: 'employee.delete',
    entity: 'employees',
    entityId: employee.id,
    detail: `Permanently deleted ${employee.name} (${summarizeCascadeCounts(result)})`,
  });

  return result;
}

export interface BulkDeleteResult {
  succeeded: BulkItemResult[];
  skipped: BulkSkippedResult[];
}

/** Bulk permanent delete — payslip-holding employees are skipped. */
export function bulkDelete(
  employees: Employee[],
  actorName: string,
  onProgress?: (done: number, total: number) => void,
): BulkDeleteResult {
  const result: BulkDeleteResult = { succeeded: [], skipped: [] };
  const payslips = getCollection<Payslip>('payslips');
  employees.forEach((employee, i) => {
    const blocked = deleteBlockReason(payslips, employee);
    if (blocked) {
      result.skipped.push({ employeeId: employee.id, name: employee.name, reason: blocked });
    } else {
      const cascade = deleteEmployeeCascade(employee, actorName);
      if (cascade) {
        result.succeeded.push({ employeeId: employee.id, name: employee.name, cascade });
      }
    }
    onProgress?.(i + 1, employees.length);
  });
  return result;
}

/** EA s.12 notice suggestion for the Resign dialog (today → statutory LWD). */
export function suggestedLastWorkingDay(employee: Employee, noticeDate: string): string {
  return lastWorkingDayFor(noticeDate, noticeWeeksFor(employee.joinDate, noticeDate));
}
