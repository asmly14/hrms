/**
 * Decision hooks for the unified approvals inbox — every handler replicates
 * the EXISTING mutation path of its source module (same collection patches,
 * same balance updates, same audit actions, same toasts), so deciding here
 * behaves identically to deciding inside the module:
 *
 *   useLeaveDecisions → pages/leave/components/ApprovalsQueue.confirmDecision
 *     (status + decisionRemarks on the request; tracked types increment the
 *     employee's balance row — created from EA entitlements when missing —
 *     after a LIVE balance re-check that blocks negative balances, QA B5).
 *   useClaimDecisions → pages/claims/ApproverInbox.confirmApprove/confirmReject
 *     (per-claim update + claim.approve/claim.reject audit, plus the
 *     claim.bulk-approve summary audit for multi-approve).
 *   useOtDecisions    → pages/attendance/OTManager.decide (self-approval
 *     block, 104h/month cap re-checked at approval time, otApproved flips —
 *     the exact field payrollEngine pays on).
 */
import { useMemo } from 'react';
import { toast } from 'sonner';
import { logAudit, useCollection } from '@/lib/db';
import type { Employee, LeaveBalance } from '@/lib/types';
import { fmtDate, fmtRM, round2 } from '@/lib/utils';
import { actorName, useAuthSafe } from '@/lib/useAuthSafe';
import { MAX_OT_HOURS_MONTH } from '@/lib/statutory';
import type { AttendanceX } from '@/pages/attendance/model';
import { getActingAsId } from '@/pages/claims/actingAsStorage';
import { categoryMetaOf, type ClaimRecord } from '@/pages/claims/claimPolicy';
import {
  LEAVE_TYPE_META,
  balanceFor,
  balanceView,
  effectiveBalance,
  entitlementColumns,
  pendingDaysFor,
  usagePatch,
  type LeaveRequestEx,
} from '@/pages/leave/leaveLogic';
import { useAuthScope } from '@/pages/leave/useAuthScope';
import { approveWouldExceedOtCap } from './model';

export type LeaveAction = 'approved' | 'rejected';

export interface DecisionOutcome {
  ok: boolean;
  /** Why the decision was refused: self-approval block, balance, OT cap. */
  blocked?: 'self' | 'balance' | 'cap';
}

interface DecideOpts {
  /** Bulk loops pass quiet and raise one summary toast themselves. */
  quiet?: boolean;
}

// ── Leave (pages/leave ApprovalsQueue path) ─────────────────────────────────

export function useLeaveDecisions() {
  const auth = useAuthScope();
  const leavesApi = useCollection<LeaveRequestEx>('leaves');
  const balancesApi = useCollection<LeaveBalance>('leaveBalances');
  const { items: employees } = useCollection<Employee>('employees');

  const empOf = useMemo(() => {
    const map = new Map(employees.map((e) => [e.id, e]));
    return (id: string) => map.get(id);
  }, [employees]);

  /**
   * Live balance re-check (leave module QA B5) — the same computation the
   * approval dialog runs. Returns ok + the available days for tracked types;
   * untracked types (unpaid/emergency/…) are always ok, and a missing employee
   * record skips the check entirely (ApprovalsQueue treats it as null check).
   */
  const balanceCheck = (req: LeaveRequestEx): { ok: boolean; available: number } => {
    const emp = empOf(req.employeeId);
    if (!emp) return { ok: true, available: Infinity };
    const year = Number(req.startDate.slice(0, 4));
    const bal = effectiveBalance(emp, balancesApi.items, year);
    const otherPending = pendingDaysFor(leavesApi.items, req.employeeId, req.type, year, req.id);
    const view = balanceView(bal, req.type, otherPending);
    if (!view.tracked) return { ok: true, available: Infinity };
    return { ok: req.days <= view.available, available: view.available };
  };

  /** ApprovalsQueue.confirmDecision — identical mutation/audit/toast path. */
  const decide = (
    req: LeaveRequestEx,
    action: LeaveAction,
    remarks: string,
    opts: DecideOpts = {},
  ): DecisionOutcome => {
    // B2 — never let the acting user decide their own request.
    if (auth.employeeId != null && req.employeeId === auth.employeeId) {
      return { ok: false, blocked: 'self' };
    }
    if (action === 'approved') {
      const check = balanceCheck(req);
      if (!check.ok) return { ok: false, blocked: 'balance' };
    }
    const decidedAt = new Date().toISOString();
    leavesApi.update(req.id, {
      status: action,
      decidedBy: auth.actor,
      decidedAt,
      decisionRemarks: remarks.trim() || undefined,
    });

    if (action === 'approved') {
      const year = Number(req.startDate.slice(0, 4));
      const emp = empOf(req.employeeId);
      let bal = balanceFor(balancesApi.items, req.employeeId, year);
      if (!bal && emp) {
        bal = balancesApi.add({
          employeeId: req.employeeId,
          year,
          ...entitlementColumns(emp, year),
          annualUsed: 0,
          sickUsed: 0,
          hospitalizationUsed: 0,
          carriedForward: 0,
        });
      }
      if (bal) {
        balancesApi.update(bal.id, usagePatch(bal, req.type, req.days));
      }
    }

    const name = empOf(req.employeeId)?.name ?? req.employeeId;
    logAudit({
      actorName: auth.actor,
      action: action === 'approved' ? 'leave.approve' : 'leave.reject',
      entity: 'leaves',
      entityId: req.id,
      detail: `${name} — ${LEAVE_TYPE_META[req.type].label} ${req.days}d (${req.startDate} → ${req.endDate})${remarks.trim() ? ` · ${remarks.trim()}` : ''}`,
    });
    if (!opts.quiet) {
      toast.success(action === 'approved' ? `Leave approved for ${name}` : `Leave rejected for ${name}`);
    }
    return { ok: true };
  };

  /**
   * Bulk approve — runs the same per-request mutation path as decide() but
   * against WORKING COPIES of the leaves/balances snapshots, so sequential
   * approvals in one batch see each other's effects (no double balance-row
   * creation for the same employee-year, pending-days math stays live).
   * Skipped requests (insufficient balance / own request) are reported, not
   * silently dropped. Toasts are raised by the caller as one summary.
   */
  const approveBulk = (
    reqs: LeaveRequestEx[],
    remarks: string,
  ): { approvedCount: number; approvedDays: number; skipped: { req: LeaveRequestEx; name: string; reason: 'balance' | 'self' }[] } => {
    const note = remarks.trim();
    const workingLeaves = [...leavesApi.items];
    const workingBalances = [...balancesApi.items];
    const skipped: { req: LeaveRequestEx; name: string; reason: 'balance' | 'self' }[] = [];
    let approvedCount = 0;
    let approvedDays = 0;
    for (const req of reqs) {
      const name = empOf(req.employeeId)?.name ?? req.employeeId;
      // B2 — never decide your own request.
      if (auth.employeeId != null && req.employeeId === auth.employeeId) {
        skipped.push({ req, name, reason: 'self' });
        continue;
      }
      const emp = empOf(req.employeeId);
      const year = Number(req.startDate.slice(0, 4));
      if (emp) {
        // B5 — live balance re-check against the working copies.
        const bal = effectiveBalance(emp, workingBalances, year);
        const otherPending = pendingDaysFor(workingLeaves, req.employeeId, req.type, year, req.id);
        const view = balanceView(bal, req.type, otherPending);
        if (view.tracked && req.days > view.available) {
          skipped.push({ req, name, reason: 'balance' });
          continue;
        }
      }
      const decidedAt = new Date().toISOString();
      leavesApi.update(req.id, {
        status: 'approved',
        decidedBy: auth.actor,
        decidedAt,
        decisionRemarks: note || undefined,
      });
      // Reflect the decision into the working leaves copy.
      const lIdx = workingLeaves.findIndex((l) => l.id === req.id);
      if (lIdx >= 0) workingLeaves[lIdx] = { ...workingLeaves[lIdx], status: 'approved', decidedAt };
      if (emp) {
        let bal = balanceFor(workingBalances, req.employeeId, year);
        if (!bal) {
          bal = balancesApi.add({
            employeeId: req.employeeId,
            year,
            ...entitlementColumns(emp, year),
            annualUsed: 0,
            sickUsed: 0,
            hospitalizationUsed: 0,
            carriedForward: 0,
          });
          workingBalances.push(bal);
        }
        const patch = usagePatch(bal, req.type, req.days);
        balancesApi.update(bal.id, patch);
        // Reflect the usage into the working balances copy.
        const bIdx = workingBalances.findIndex((b) => b.id === bal.id);
        if (bIdx >= 0) workingBalances[bIdx] = { ...bal, ...patch };
      }
      logAudit({
        actorName: auth.actor,
        action: 'leave.approve',
        entity: 'leaves',
        entityId: req.id,
        detail: `${name} — ${LEAVE_TYPE_META[req.type].label} ${req.days}d (${req.startDate} → ${req.endDate})${note ? ` · ${note}` : ''}`,
      });
      approvedCount += 1;
      approvedDays += req.days;
    }
    if (approvedCount > 1) {
      logAudit({
        actorName: auth.actor,
        action: 'leave.bulk-approve',
        entity: 'leaves',
        detail: `${approvedCount} leave requests approved in bulk, ${approvedDays}d total${note ? ` · ${note}` : ''}`,
      });
    }
    return { approvedCount, approvedDays, skipped };
  };

  return { decide, approveBulk, balanceCheck, canApprove: auth.canApprove, selfId: auth.employeeId };
}

// ── Claims (pages/claims ApproverInbox path) ────────────────────────────────

export function useClaimDecisions() {
  const auth = useAuthSafe();
  const { update } = useCollection<ClaimRecord>('claims');
  const { items: employees } = useCollection<Employee>('employees');

  const empOf = useMemo(() => {
    const map = new Map(employees.map((e) => [e.id, e]));
    return (id: string) => map.get(id);
  }, [employees]);

  /**
   * Approver identity for decidedBy + audit — ClaimsPage's resolution: the
   * logged-in user (linked employee id, or the user id for standalone
   * Admin/HR accounts), never the impersonated acting-as employee. Pre-auth
   * demo falls back to the acting-as pointer (or the first employee), like
   * the legacy branch of ClaimsPage.
   */
  const actor = useMemo<{ id: string; name: string }>(() => {
    if (auth?.user) {
      return {
        id: auth.employeeId ?? auth.user.id,
        name: empOf(auth.employeeId ?? '')?.name ?? auth.user.username,
      };
    }
    const acting = employees.find((e) => e.id === getActingAsId()) ?? employees[0];
    return acting ? { id: acting.id, name: acting.name } : { id: 'unknown', name: 'Unknown' };
  }, [auth, employees, empOf]);

  /** ApproverInbox.confirmApprove — identical per-claim + bulk audit path. */
  const approve = (targets: ClaimRecord[], remarks: string): DecisionOutcome => {
    const now = new Date().toISOString();
    const note = remarks.trim();
    // Defensive: never approve the approver's own claim, even if the UI let it through.
    const decidable = targets.filter((c) => c.employeeId !== actor.id);
    if (decidable.length === 0) return { ok: false, blocked: 'self' };
    for (const c of decidable) {
      update(c.id, {
        status: 'approved',
        decidedBy: actor.id,
        decidedAt: now,
        // Empty remarks → clear any stale rejection remark from a previous cycle (B8).
        decisionRemarks: note ? note : undefined,
      });
      logAudit({
        actorId: actor.id,
        actorName: actor.name,
        action: 'claim.approve',
        entity: 'claims',
        entityId: c.id,
        detail: `${categoryMetaOf(c).label} — ${fmtRM(c.amount)} for ${empOf(c.employeeId)?.name ?? c.employeeId}${note ? ` · ${note}` : ''}`,
      });
    }
    if (decidable.length > 1) {
      logAudit({
        actorId: actor.id,
        actorName: actor.name,
        action: 'claim.bulk-approve',
        entity: 'claims',
        detail: `${decidable.length} claims approved in bulk, ${fmtRM(round2(decidable.reduce((s, c) => s + c.amount, 0)))} total`,
      });
    }
    toast.success(
      decidable.length > 1
        ? `${decidable.length} claims approved — ${fmtRM(round2(decidable.reduce((s, c) => s + c.amount, 0)))} total`
        : `Claim approved for ${empOf(decidable[0].employeeId)?.name ?? decidable[0].employeeId} — ${fmtRM(decidable[0].amount)}`,
    );
    return { ok: true };
  };

  /** ApproverInbox.confirmReject — identical mutation/audit/toast path. */
  const reject = (c: ClaimRecord, remarks: string): DecisionOutcome => {
    if (c.employeeId === actor.id) return { ok: false, blocked: 'self' };
    const note = remarks.trim();
    update(c.id, {
      status: 'rejected',
      decidedBy: actor.id,
      decidedAt: new Date().toISOString(),
      decisionRemarks: note,
    });
    logAudit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'claim.reject',
      entity: 'claims',
      entityId: c.id,
      detail: `${categoryMetaOf(c).label} — ${fmtRM(c.amount)} for ${empOf(c.employeeId)?.name ?? c.employeeId} · ${note}`,
    });
    toast.success(`Claim rejected for ${empOf(c.employeeId)?.name ?? c.employeeId} — ${fmtRM(c.amount)}`);
    return { ok: true };
  };

  return { approve, reject, actor };
}

// ── Overtime (pages/attendance OTManager path) ──────────────────────────────

export function useOtDecisions() {
  const auth = useAuthSafe();
  const { items: attendance, update } = useCollection<AttendanceX>('attendance');
  const { items: employees } = useCollection<Employee>('employees');
  const selfId = auth?.employeeId ?? null;

  const empName = useMemo(() => {
    const map = new Map(employees.map((e) => [e.id, e.name]));
    return (id: string) => map.get(id) ?? id;
  }, [employees]);

  /**
   * Approval-time 104h cap check against the FULL attendance collection —
   * identical to OTManager.approveWouldExceedCap.
   */
  const wouldExceedCap = (rec: AttendanceX): boolean => approveWouldExceedOtCap(attendance, rec);

  /** OTManager.decide — identical mutation/audit/toast path (+optional reject remark). */
  const decide = (
    rec: AttendanceX,
    approve: boolean,
    remarks: string = '',
    opts: DecideOpts = {},
  ): DecisionOutcome => {
    // Self-approval is never allowed — a second pair of eyes must decide.
    if (selfId && rec.employeeId === selfId) {
      if (!opts.quiet) toast.error('You cannot approve or reject your own OT request.');
      return { ok: false, blocked: 'self' };
    }
    // B3: re-check the 104h monthly cap at approval time, per employee.
    if (approve && wouldExceedCap(rec)) {
      if (!opts.quiet) {
        toast.error(`Approving would push ${empName(rec.employeeId)} past the ${MAX_OT_HOURS_MONTH}h monthly OT cap.`);
      }
      return { ok: false, blocked: 'cap' };
    }
    const note = remarks.trim();
    update(rec.id, approve
      ? { otApproved: true, otRejected: false, notes: `${rec.notes ?? ''} · approved${note ? `: ${note}` : ''}`.trim() }
      : { otApproved: false, otRejected: true, notes: `${rec.notes ?? ''} · rejected${note ? `: ${note}` : ''}`.trim() });
    logAudit({
      actorName: actorName(auth),
      action: approve ? 'attendance.ot-approve' : 'attendance.ot-reject',
      entity: 'attendance',
      entityId: rec.id,
      detail: `${empName(rec.employeeId)} ${rec.otHours}h OT on ${rec.date} ${approve ? 'approved' : 'rejected'}${note ? ` · ${note}` : ''}`,
    });
    if (!opts.quiet) {
      toast.success(
        approve
          ? `OT approved for ${empName(rec.employeeId)} — ${rec.otHours}h on ${fmtDate(rec.date)}`
          : `OT rejected for ${empName(rec.employeeId)} — ${rec.otHours}h on ${fmtDate(rec.date)}`,
      );
    }
    return { ok: true };
  };

  /**
   * Bulk approve — same per-record mutation path as decide() but with the
   * 104h cap re-checked against a WORKING COPY of the attendance snapshot, so
   * sequential approvals in one batch see each other's approved hours.
   * Cap-blocked / own records are reported as skipped. Caller raises toasts.
   */
  const approveBulk = (
    recs: AttendanceX[],
  ): { approved: number; skipped: { rec: AttendanceX; reason: 'self' | 'cap' }[] } => {
    const working = [...attendance];
    const skipped: { rec: AttendanceX; reason: 'self' | 'cap' }[] = [];
    let approved = 0;
    for (const rec of recs) {
      if (selfId && rec.employeeId === selfId) {
        skipped.push({ rec, reason: 'self' });
        continue;
      }
      // B3: re-check the 104h monthly cap per employee, batch-aware.
      if (approveWouldExceedOtCap(working, rec)) {
        skipped.push({ rec, reason: 'cap' });
        continue;
      }
      update(rec.id, { otApproved: true, otRejected: false, notes: `${rec.notes ?? ''} · approved`.trim() });
      logAudit({
        actorName: actorName(auth),
        action: 'attendance.ot-approve',
        entity: 'attendance',
        entityId: rec.id,
        detail: `${empName(rec.employeeId)} ${rec.otHours}h OT on ${rec.date} approved`,
      });
      const idx = working.findIndex((a) => a.id === rec.id);
      if (idx >= 0) working[idx] = { ...working[idx], otApproved: true };
      approved += 1;
    }
    return { approved, skipped };
  };

  return { decide, approveBulk, wouldExceedCap, selfId };
}
