/**
 * Unified approvals inbox — pure aggregation, scoping and OT-cap logic.
 *
 * SINGLE source of truth for "what is waiting for a decision" across the
 * three approvable modules; both the /approvals page and the NotificationBell
 * consume it (via ./usePendingApprovals) so their counts always match
 * (audit-business-value.md quick win). Every rule is mirrored from the source
 * module, never forked:
 *
 *   Leave    — pages/leave/components/ApprovalsQueue: status === 'pending',
 *              newest application first.
 *   Claims   — pages/claims/ApproverInbox: status === 'submitted',
 *              FIFO by submittedAt (fallback claimDate).
 *   Overtime — pages/attendance/OTManager: otRequested && !otApproved &&
 *              !otRejected && otHours > 0, newest work date first; the 104h
 *              monthly cap (Employment (Limitation of Overtime Work)
 *              Regulations 1980) is re-checked at approval time.
 *
 * Scoping mirrors lib/authContext exactly:
 *   SuperAdmin/Admin/HR → unrestricted; Manager → own department (+ self,
 *   fail closed when unlinked); Employee → own records only (fail closed).
 *   `permissive: true` reproduces the module pages' pre-auth demo behaviour
 *   (fail open) and is used only while no auth provider/session exists.
 *
 * Pure functions only — no React, no storage — so vitest can exercise the
 * aggregation math and scoping directly (see __tests__/pendingApprovals.test.ts).
 */
import { MAX_OT_HOURS_MONTH } from '@/lib/statutory';
import type { Employee } from '@/lib/types';
import { round2 } from '@/lib/utils';
import type { AttendanceX } from '@/pages/attendance/model';
import type { ClaimRecord } from '@/pages/claims/claimPolicy';
import type { LeaveRequestEx } from '@/pages/leave/leaveLogic';

export type ApprovalKind = 'leave' | 'claims' | 'ot';

/** "Recently decided" window shown per tab (7 days). */
export const RECENT_WINDOW_MS = 7 * 86_400_000;

/** Role + identity context for scoping (mirrors lib/authContext inputs). */
export interface ApprovalScope {
  /** Effective role; 'SuperAdmin' is treated as unrestricted like authContext. */
  role: string | null;
  /** Linked Employee id of the acting user (null for standalone accounts). */
  employeeId: string | null;
  /** Employee directory — needed to resolve a Manager's department. */
  employees: Employee[];
  /** Pre-auth demo mode (no provider/session): fail OPEN like module pages. */
  permissive: boolean;
}

/** Raw collections the aggregation reads (unscoped, unfiltered). */
export interface ApprovalData {
  leaves: LeaveRequestEx[];
  claims: ClaimRecord[];
  attendance: AttendanceX[];
}

/** Scoped queues, one per approvable module. */
export interface PendingQueues {
  leave: LeaveRequestEx[];
  claims: ClaimRecord[];
  ot: AttendanceX[];
}

/** Queue lengths — the badge numbers shared by the bell and the inbox. */
export interface ApprovalCounts {
  leave: number;
  claims: number;
  ot: number;
  total: number;
}

// ── Scoping (mirrors lib/authContext) ───────────────────────────────────────

/**
 * Set of employee ids visible under the scope, or `null` when unrestricted
 * (SuperAdmin/Admin/HR, or pre-auth permissive mode). Manager resolves the
 * department through their linked Employee record and fails closed to self
 * (or nothing) when unlinked; Employee sees only their own id.
 */
export function visibleEmployeeIds(scope: ApprovalScope): Set<string> | null {
  const { role, employeeId, employees, permissive } = scope;
  if (permissive || role === 'SuperAdmin' || role === 'Admin' || role === 'HR') {
    return null; // unrestricted
  }
  if (role === 'Manager') {
    const departmentId = employeeId
      ? employees.find((e) => e.id === employeeId)?.departmentId ?? null
      : null;
    if (!departmentId) return new Set(employeeId ? [employeeId] : []);
    const ids = employees
      .filter((e) => e.departmentId === departmentId)
      .map((e) => e.id);
    if (employeeId && !ids.includes(employeeId)) ids.push(employeeId);
    return new Set(ids);
  }
  // Employee (or unknown role): self only — fail closed when unlinked.
  return new Set(employeeId ? [employeeId] : []);
}

/** Filter any employeeId-carrying collection to the visible scope. */
export function scopeByEmployee<T>(
  list: T[],
  getEmpId: (item: T) => string,
  scope: ApprovalScope,
): T[] {
  const ids = visibleEmployeeIds(scope);
  if (ids === null) return list;
  return list.filter((item) => ids.has(getEmpId(item)));
}

// ── Pending queues (module-canonical filters + order) ───────────────────────

/** Leave queue: pending only, newest application first (ApprovalsQueue). */
export function pendingLeaveRequests(
  leaves: LeaveRequestEx[],
  scope: ApprovalScope,
): LeaveRequestEx[] {
  return scopeByEmployee(leaves, (l) => l.employeeId, scope)
    .filter((l) => l.status === 'pending')
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}

/** Claims queue: submitted only, FIFO by submittedAt (ApproverInbox). */
export function pendingClaims(
  claims: ClaimRecord[],
  scope: ApprovalScope,
): ClaimRecord[] {
  return scopeByEmployee(claims, (c) => c.employeeId, scope)
    .filter((c) => c.status === 'submitted')
    .sort((a, b) => (a.submittedAt ?? a.claimDate).localeCompare(b.submittedAt ?? b.claimDate));
}

/** OT queue: requested & undecided & >0h, newest work date first (OTManager). */
export function pendingOtRequests(
  attendance: AttendanceX[],
  scope: ApprovalScope,
): AttendanceX[] {
  return scopeByEmployee(attendance, (a) => a.employeeId, scope)
    .filter((a) => a.otRequested && !a.otApproved && !a.otRejected && a.otHours > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function buildPendingQueues(data: ApprovalData, scope: ApprovalScope): PendingQueues {
  return {
    leave: pendingLeaveRequests(data.leaves, scope),
    claims: pendingClaims(data.claims, scope),
    ot: pendingOtRequests(data.attendance, scope),
  };
}

// ── Recently decided (7 days) ───────────────────────────────────────────────

function tsOf(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  return new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).getTime();
}

function toLocalISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Leave approved/rejected within the window, newest decision first. */
export function recentLeaveDecisions(
  leaves: LeaveRequestEx[],
  scope: ApprovalScope,
  nowMs: number,
  windowMs: number = RECENT_WINDOW_MS,
): LeaveRequestEx[] {
  const cutoff = nowMs - windowMs;
  return scopeByEmployee(leaves, (l) => l.employeeId, scope)
    .filter(
      (l) => (l.status === 'approved' || l.status === 'rejected')
        && l.decidedAt !== undefined
        && tsOf(l.decidedAt) >= cutoff,
    )
    .sort((a, b) => tsOf(b.decidedAt) - tsOf(a.decidedAt));
}

/** Claims approved/rejected within the window, newest decision first. */
export function recentClaimDecisions(
  claims: ClaimRecord[],
  scope: ApprovalScope,
  nowMs: number,
  windowMs: number = RECENT_WINDOW_MS,
): ClaimRecord[] {
  const cutoff = nowMs - windowMs;
  return scopeByEmployee(claims, (c) => c.employeeId, scope)
    .filter(
      (c) => (c.status === 'approved' || c.status === 'rejected')
        && c.decidedAt !== undefined
        && tsOf(c.decidedAt) >= cutoff,
    )
    .sort((a, b) => tsOf(b.decidedAt) - tsOf(a.decidedAt));
}

/**
 * OT decided within the window, newest work date first. AttendanceX carries
 * no decidedAt (OTManager appends '· approved' to notes instead), so the
 * window is approximated by the OT date — same spirit as OTManager's
 * "decided this month" panel.
 */
export function recentOtDecisions(
  attendance: AttendanceX[],
  scope: ApprovalScope,
  nowMs: number,
  windowMs: number = RECENT_WINDOW_MS,
): AttendanceX[] {
  const cutoffISO = toLocalISO(new Date(nowMs - windowMs));
  return scopeByEmployee(attendance, (a) => a.employeeId, scope)
    .filter((a) => a.otRequested && (a.otApproved || a.otRejected) && a.date >= cutoffISO)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function buildRecentDecisions(
  data: ApprovalData,
  scope: ApprovalScope,
  nowMs: number,
  windowMs: number = RECENT_WINDOW_MS,
): PendingQueues {
  return {
    leave: recentLeaveDecisions(data.leaves, scope, nowMs, windowMs),
    claims: recentClaimDecisions(data.claims, scope, nowMs, windowMs),
    ot: recentOtDecisions(data.attendance, scope, nowMs, windowMs),
  };
}

// ── Counts / self-exclusion ─────────────────────────────────────────────────

/** Queue lengths; `total` is the number the bell badge and inbox share. */
export function countQueues(q: PendingQueues): ApprovalCounts {
  const leave = q.leave.length;
  const claims = q.claims.length;
  const ot = q.ot.length;
  return { leave, claims, ot, total: leave + claims + ot };
}

/**
 * Items the acting user may actually decide — their own rows stay visible in
 * the queue but locked (all three source modules block self-approval), so the
 * decidable subset excludes them.
 */
export function excludeSelf<T extends { employeeId: string }>(
  items: T[],
  employeeId: string | null,
): T[] {
  if (employeeId == null) return items;
  return items.filter((i) => i.employeeId !== employeeId);
}

// ── OT monthly cap (OTManager approval-time rule) ───────────────────────────

/** Approved OT hours for an employee in a month ('YYYY-MM'). */
export function approvedOtHoursFor(
  attendance: AttendanceX[],
  employeeId: string,
  month: string,
): number {
  return round2(
    attendance.reduce(
      (s, a) => s + (a.employeeId === employeeId && a.date.startsWith(month) && a.otApproved ? a.otHours || 0 : 0),
      0,
    ),
  );
}

/** Would approving this record breach the 104h monthly cap for that employee? */
export function approveWouldExceedOtCap(attendance: AttendanceX[], rec: AttendanceX): boolean {
  return approvedOtHoursFor(attendance, rec.employeeId, rec.date.slice(0, 7)) + (rec.otHours || 0)
    > MAX_OT_HOURS_MONTH;
}

// ── Row age ─────────────────────────────────────────────────────────────────

/**
 * Whole days a request has been waiting (appliedAt / submittedAt / OT date →
 * now). FLOORED — a request applied this morning is still "today" at noon —
 * and clamped at 0 so future-dated rows don't go negative.
 */
export function ageInDays(at: string, now: Date = new Date()): number {
  const from = new Date(at.length === 10 ? `${at}T00:00:00` : at).getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((now.getTime() - from) / 86_400_000));
}
