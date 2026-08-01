/**
 * Employee separation engine — pure, testable logic behind the directory's
 * Resign / VSS / Other-separation / Delete actions (single + bulk).
 *
 * Deliberately hook-free: it reads/writes collections through db.ts's
 * non-reactive getCollection/setCollection (which still notify subscribers),
 * so the same code path serves the React dialogs and node-based vitest runs.
 *
 * Storage contract notes:
 * - Offboarding cases live on the module-owned 'offboardingCases' key
 *   (same typed-cast pattern as lib/lifecycle.ts).
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
 * Stores (module-owned keys, same cast pattern as lifecycle.ts)
 * ──────────────────────────────────────────────────────────── */

const asCollection = (name: string) => name as CollectionName;

const OFFBOARDING = asCollection('offboardingCases');

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

export interface DeleteResult {
  removedLinked: { attendance: number; leaves: number; claims: number; leaveBalances: number; kpis: number; reviews: number; userAccounts: number };
}

/**
 * Permanently delete an employee: record + attendance / leaves / claims /
 * leave balances / KPIs / KPI reviews + mock-auth account. Caller MUST check
 * deleteBlockReason first — this function refuses (returns null) when the
 * payslip guard trips, as a defence-in-depth backstop.
 */
export function deleteEmployeeCascade(
  employee: Employee,
  actorName: string,
): DeleteResult | null {
  const payslips = getCollection<Payslip>('payslips');
  if (deleteBlockReason(payslips, employee)) return null;

  const removedLinked: DeleteResult['removedLinked'] = {
    attendance: purgeCollection<AttendanceRecord>('attendance', employee.id),
    leaves: purgeCollection<LeaveRequest>('leaves', employee.id),
    claims: purgeCollection<Claim>('claims', employee.id),
    leaveBalances: purgeCollection<LeaveBalance>('leaveBalances', employee.id),
    kpis: purgeCollection<KPI>('kpis', employee.id),
    reviews: purgeCollection<KPIReview>('reviews', employee.id),
    userAccounts: removeUserAccounts(employee.id),
  };

  setCollection(
    'employees',
    getCollection<Employee>('employees').filter((e) => e.id !== employee.id),
  );

  logAudit({
    actorName,
    action: 'employee.delete',
    entity: 'employees',
    entityId: employee.id,
    detail: `Permanently deleted ${employee.name} (+${removedLinked.attendance} attendance, ${removedLinked.leaves} leaves, ${removedLinked.claims} claims, ${removedLinked.leaveBalances} balances, ${removedLinked.kpis} KPIs, ${removedLinked.reviews} reviews, ${removedLinked.userAccounts} user account)`,
  });

  return { removedLinked };
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
    } else if (deleteEmployeeCascade(employee, actorName)) {
      result.succeeded.push({ employeeId: employee.id, name: employee.name });
    }
    onProgress?.(i + 1, employees.length);
  });
  return result;
}

/** EA s.12 notice suggestion for the Resign dialog (today → statutory LWD). */
export function suggestedLastWorkingDay(employee: Employee, noticeDate: string): string {
  return lastWorkingDayFor(noticeDate, noticeWeeksFor(employee.joinDate, noticeDate));
}
