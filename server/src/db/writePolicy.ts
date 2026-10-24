/**
 * Field-level rules for SELF-SERVICE writes — a restricted user (Employee, or
 * a Manager acting on their own row) writing a record about themselves.
 *
 * Row ownership is enforced by assertWriteAllowed (collections.ts); these
 * policies stop the doc itself from carrying an approver's decision, which
 * would otherwise let staff self-approve leave, claims or overtime through the
 * generic CRUD API (and approved claims / OT are paid by the next payroll run).
 *
 * Each policy returns an error message, or null when the write is allowed.
 * `existing` is the stored row (undefined on create); `next` is the full doc
 * as it would be stored.
 */
export type Doc = Record<string, unknown>;
export type SelfWritePolicy = (existing: Doc | undefined, next: Doc) => string | null;

const isUnset = (v: unknown) => v === undefined || v === null;

/** JSON-level equality — docs are JSONB round-trips, so key order is irrelevant here. */
function same(a: unknown, b: unknown): boolean {
  if (isUnset(a) && isUnset(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Approver-owned fields may be kept as stored or cleared (resubmission wipes
 * the previous decision), never set to a new value by the record's subject.
 */
function keptOrCleared(existing: Doc | undefined, next: Doc, fields: string[]): string | null {
  for (const f of fields) {
    if (!isUnset(next[f]) && !same(existing?.[f], next[f])) {
      return `'${f}' is set by the approver and cannot be written on your own record.`;
    }
  }
  return null;
}

/** Leave (web: ApplyLeaveForm) — apply as pending; edit or withdraw while still pending. */
export const leaveSelfPolicy: SelfWritePolicy = (existing, next) => {
  if (!existing) {
    if (next.status !== 'pending') return 'New leave requests must be pending approval.';
  } else {
    if (existing.status !== 'pending') {
      return 'Only pending leave requests can be changed — ask HR to amend a decided request.';
    }
    if (next.status !== 'pending' && next.status !== 'cancelled') {
      return 'You can only edit or withdraw your own pending leave request.';
    }
  }
  return keptOrCleared(existing, next, ['decidedBy', 'decidedAt', 'decisionRemarks']);
};

const SELF_EDITABLE_CLAIM = new Set(['draft', 'submitted', 'rejected']);
const SELF_CLAIM_STATUS = new Set(['draft', 'submitted']);

/**
 * Claims (web: ClaimFormDialog / MyClaimsList) — save as draft or submit;
 * rejected claims may be reworked. Approved/paid claims are locked.
 */
export const claimSelfPolicy: SelfWritePolicy = (existing, next) => {
  if (existing && !SELF_EDITABLE_CLAIM.has(existing.status as string)) {
    return 'Approved or paid claims can no longer be changed.';
  }
  if (!SELF_CLAIM_STATUS.has(next.status as string)) {
    return 'Claims can only be saved as a draft or submitted for approval.';
  }
  return keptOrCleared(existing, next, ['decidedBy', 'decidedAt', 'decisionRemarks', 'paidInRunId']);
};

/**
 * Attendance (web: ClockPanel / OTManager) — clocking and OT requests are
 * self-service, OT approval is not. Approved OT is paid as recorded, so its
 * hours and day-type rate are frozen for the claimant.
 */
export const attendanceSelfPolicy: SelfWritePolicy = (existing, next) => {
  if (existing?.otApproved === true) {
    for (const f of ['otApproved', 'otHours', 'otDayType']) {
      if (!same(existing[f], next[f])) return 'Approved overtime can no longer be changed — contact HR.';
    }
    return null;
  }
  if (next.otApproved === true) return 'Overtime can only be approved by a manager or HR.';
  return null;
};

/** True when every field outside `allowed` is unchanged between the two docs. */
function onlyChanged(existing: Doc, next: Doc, allowed: string[]): boolean {
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  for (const k of keys) {
    if (!allowed.includes(k) && !same(existing[k], next[k])) return false;
  }
  return true;
}

/**
 * Reviews (web: kpiEngine canSelfScore / canAcknowledge) — the subject may
 * enter a self-assessment while draft and acknowledge once submitted; the
 * manager scores, overall score and status are the reviewer's.
 */
export const reviewSelfPolicy: SelfWritePolicy = (existing, next) => {
  if (!existing) return 'Reviews are opened by your manager or HR.';
  if (existing.status === 'draft') {
    return onlyChanged(existing, next, ['selfScores', 'selfComments'])
      ? null
      : 'On your own review you can only enter your self-assessment.';
  }
  if (existing.status === 'submitted') {
    if (next.status !== 'submitted' && next.status !== 'acknowledged') {
      return 'A submitted review can only be acknowledged.';
    }
    return onlyChanged(existing, next, ['status', 'acknowledgedAt'])
      ? null
      : 'A submitted review can only be acknowledged.';
  }
  return 'An acknowledged review is locked.';
};

/** Check-ins (web: ReviewCycle) — a subject's own notes are employee notes; manager notes stay the manager's. */
export const checkinSelfPolicy: SelfWritePolicy = (existing, next) => {
  if (existing?.authorRole === 'manager') return "Only the manager can change a manager's check-in.";
  if (next.authorRole === 'manager') return 'Check-ins on your own review are recorded as employee notes.';
  return null;
};
