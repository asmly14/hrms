/**
 * Approval workflow — pending queue with approve/reject + remarks, plus a
 * cancel flow for approved leave.
 *
 * Access (QA B2): Admin/HR decide everything; Managers decide their own
 * department (rows are scoped via mock auth); Employees have no approval
 * access. A user can never decide or cancel their OWN request.
 * Balance handling: approving a tracked type (annual / sick / hospitalization)
 * increments the used column of the employee's balance row for the leave year
 * (created from EA entitlements first when missing); cancelling restores it.
 * QA B5: the live balance is re-validated at approval time — an approval that
 * would push the balance negative is blocked with a clear error.
 * QA B6: approved leave can be cancelled before its start date; the tracked
 * days are returned to the balance and the cancel is audited.
 */
import { useMemo, useState } from 'react';
import { Ban, CalendarOff, Check, ClipboardCheck, ShieldAlert, X } from 'lucide-react';
import { logAudit, type CollectionApi } from '@/lib/db';
import { avatarTone, fmtDate, initialsOf } from '@/lib/utils';
import type { Employee, LeaveBalance, LeaveStatus } from '@/lib/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  balanceFor, balanceView, effectiveBalance, entitlementColumns, pendingDaysFor, toISO,
  usagePatch, LEAVE_TYPE_META, type LeaveRequestEx,
} from '../leaveLogic';
import { useAuthScope } from '../useAuthScope';

interface Props {
  employees: Employee[];
  leavesApi: CollectionApi<LeaveRequestEx>;
  balancesApi: CollectionApi<LeaveBalance>;
}

function StatusBadge({ status }: { status: LeaveStatus }) {
  const cls: Record<LeaveStatus, string> = {
    pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
    approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
    rejected: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
    cancelled: 'bg-stone-200 text-stone-600 dark:bg-stone-700/50 dark:text-stone-300',
  };
  return (
    <Badge variant="secondary" className={cn('capitalize', cls[status])}>
      {status}
    </Badge>
  );
}

interface Decision {
  request: LeaveRequestEx;
  action: 'approved' | 'rejected';
}

export default function ApprovalsQueue({ employees, leavesApi, balancesApi }: Props) {
  const auth = useAuthScope();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [cancelReq, setCancelReq] = useState<LeaveRequestEx | null>(null);
  const [remarks, setRemarks] = useState('');

  const todayISO = toISO(new Date());

  const empName = useMemo(() => {
    const map = new Map(employees.map((e) => [e.id, e]));
    return (id: string) => map.get(id);
  }, [employees]);

  // B2 — never let the acting user decide/cancel their own request.
  const isSelf = (l: LeaveRequestEx) => auth.employeeId != null && l.employeeId === auth.employeeId;

  // B2 — scope rows by role: Admin/HR all, Manager own department, Employee own.
  const scopedLeaves = useMemo(
    () => auth.scopeByEmployee(leavesApi.items, (l) => l.employeeId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leavesApi.items, auth.scopeByEmployee],
  );

  const sorted = useMemo(
    () => [...scopedLeaves].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt)),
    [scopedLeaves],
  );
  const pending = sorted.filter((l) => l.status === 'pending');
  const history = sorted.filter((l) => l.status !== 'pending');

  // B5 — live balance revalidation for an approval dialog (tracked types).
  const approvalCheck = useMemo(() => {
    if (!decision || decision.action !== 'approved') return null;
    const req = decision.request;
    const emp = empName(req.employeeId);
    if (!emp) return null;
    const year = Number(req.startDate.slice(0, 4));
    const bal = effectiveBalance(emp, balancesApi.items, year);
    const otherPending = pendingDaysFor(leavesApi.items, req.employeeId, req.type, year, req.id);
    const view = balanceView(bal, req.type, otherPending);
    if (!view.tracked) return null;
    return { view, ok: req.days <= view.available };
  }, [decision, empName, balancesApi.items, leavesApi.items]);

  // B2 — Employees (and unknown roles) never reach the approval workflow.
  if (!auth.canApprove) {
    return (
      <Card className="rounded-xl">
        <CardContent className="pt-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldAlert className="h-5 w-5" />
              </EmptyMedia>
              <EmptyTitle>No approval access</EmptyTitle>
              <EmptyDescription>
                Leave approvals are restricted to Admin, HR and Managers. Your own requests appear
                here once submitted — decisions are made by your approver.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  const confirmDecision = () => {
    if (!decision) return;
    const { request, action } = decision;
    if (isSelf(request)) return; // buttons are hidden — belt & braces
    if (action === 'approved' && approvalCheck && !approvalCheck.ok) return; // B5 block
    const decidedAt = new Date().toISOString();
    leavesApi.update(request.id, {
      status: action,
      decidedBy: auth.actor,
      decidedAt,
      decisionRemarks: remarks.trim() || undefined,
    });

    if (action === 'approved') {
      const year = Number(request.startDate.slice(0, 4));
      const emp = empName(request.employeeId);
      let bal = balanceFor(balancesApi.items, request.employeeId, year);
      if (!bal && emp) {
        bal = balancesApi.add({
          employeeId: request.employeeId,
          year,
          ...entitlementColumns(emp, year),
          annualUsed: 0,
          sickUsed: 0,
          hospitalizationUsed: 0,
          carriedForward: 0,
        });
      }
      if (bal) {
        balancesApi.update(bal.id, usagePatch(bal, request.type, request.days));
      }
    }

    const name = empName(request.employeeId)?.name ?? request.employeeId;
    logAudit({
      actorName: auth.actor,
      action: action === 'approved' ? 'leave.approve' : 'leave.reject',
      entity: 'leaves',
      entityId: request.id,
      detail: `${name} — ${LEAVE_TYPE_META[request.type].label} ${request.days}d (${request.startDate} → ${request.endDate})${remarks.trim() ? ` · ${remarks.trim()}` : ''}`,
    });
    setDecision(null);
    setRemarks('');
  };

  // B6 — cancel an approved request before it starts; restore the balance.
  const confirmCancel = () => {
    if (!cancelReq) return;
    if (isSelf(cancelReq)) return;
    leavesApi.update(cancelReq.id, {
      status: 'cancelled',
      decisionRemarks: remarks.trim()
        ? `Cancelled: ${remarks.trim()}`
        : cancelReq.decisionRemarks,
    });
    const year = Number(cancelReq.startDate.slice(0, 4));
    const bal = balanceFor(balancesApi.items, cancelReq.employeeId, year);
    if (bal) {
      balancesApi.update(bal.id, usagePatch(bal, cancelReq.type, -cancelReq.days));
    }
    const name = empName(cancelReq.employeeId)?.name ?? cancelReq.employeeId;
    logAudit({
      actorName: auth.actor,
      action: 'leave.cancel',
      entity: 'leaves',
      entityId: cancelReq.id,
      detail: `${name} — ${LEAVE_TYPE_META[cancelReq.type].label} ${cancelReq.days}d (${cancelReq.startDate} → ${cancelReq.endDate}) cancelled; ${cancelReq.days}d restored to balance${remarks.trim() ? ` · ${remarks.trim()}` : ''}`,
    });
    setCancelReq(null);
    setRemarks('');
  };

  const renderRequest = (l: LeaveRequestEx, actionable: boolean) => {
    const emp = empName(l.employeeId);
    const self = isSelf(l);
    const cancellable = !actionable && l.status === 'approved' && l.startDate > todayISO;
    return (
      <div key={l.id} className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarFallback className={cn('text-xs font-semibold', avatarTone(emp?.name ?? '?'))}>
              {initialsOf(emp?.name ?? '?')}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{emp?.name ?? l.employeeId}</span>
              <Badge variant="secondary" className={cn(LEAVE_TYPE_META[l.type].chip)}>
                {LEAVE_TYPE_META[l.type].label}
              </Badge>
              {l.halfDay && <Badge variant="outline">½ day</Badge>}
              {!actionable && <StatusBadge status={l.status} />}
            </div>
            <p className="text-sm text-muted-foreground">
              {fmtDate(l.startDate)} → {fmtDate(l.endDate)} · {l.days} day(s)
            </p>
            {l.reason && <p className="text-xs text-muted-foreground">“{l.reason}”</p>}
            <p className="text-xs text-muted-foreground">
              Applied {fmtDate(l.appliedAt)}
              {!actionable && l.decidedAt
                ? ` · decided ${fmtDate(l.decidedAt)} by ${l.decidedBy ?? '—'}`
                : ''}
            </p>
            {!actionable && l.decisionRemarks && (
              <p className="text-xs italic text-muted-foreground">Remark: {l.decisionRemarks}</p>
            )}
          </div>
        </div>
        {actionable && (
          self ? (
            <p className="shrink-0 text-xs italic text-muted-foreground sm:max-w-[140px]">
              You cannot decide your own request.
            </p>
          ) : (
            <div className="flex shrink-0 gap-2 sm:flex-col lg:flex-row">
              <Button size="sm" className="gap-1" onClick={() => setDecision({ request: l, action: 'approved' })}>
                <Check className="h-4 w-4" /> Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={() => setDecision({ request: l, action: 'rejected' })}
              >
                <X className="h-4 w-4" /> Reject
              </Button>
            </div>
          )
        )}
        {cancellable && (
          self ? null : (
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={() => { setCancelReq(l); setRemarks(''); }}
              >
                <Ban className="h-4 w-4" /> Cancel leave
              </Button>
            </div>
          )
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4 text-amber-600" /> Pending requests
            {pending.length > 0 && <Badge variant="secondary">{pending.length}</Badge>}
          </CardTitle>
          <CardDescription>
            Approving deducts from the employee&apos;s tracked balance (annual / sick /
            hospitalization) after a live balance re-check.
            {auth.role === 'Manager' ? ' Showing your department only.' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {pending.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarOff className="h-5 w-5" />
                </EmptyMedia>
                <EmptyTitle>All clear</EmptyTitle>
                <EmptyDescription>No leave requests waiting for a decision.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            pending.map((l) => renderRequest(l, true))
          )}
        </CardContent>
      </Card>

      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Decision history</CardTitle>
          <CardDescription>
            Approved, rejected and cancelled requests, most recent first. Approved leave can be
            cancelled until its start date — the days return to the balance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
          ) : (
            history.map((l) => renderRequest(l, false))
          )}
        </CardContent>
      </Card>

      {/* Approve / reject dialog */}
      <Dialog open={decision !== null} onOpenChange={(open) => { if (!open) { setDecision(null); setRemarks(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision?.action === 'approved' ? 'Approve' : 'Reject'} leave request
            </DialogTitle>
            <DialogDescription>
              {decision && (
                <>
                  {empName(decision.request.employeeId)?.name} — {LEAVE_TYPE_META[decision.request.type].label},{' '}
                  {fmtDate(decision.request.startDate)} → {fmtDate(decision.request.endDate)} ({decision.request.days} day(s)).
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {approvalCheck && !approvalCheck.ok && (
            <Alert variant="destructive">
              <ShieldAlert className="h-4 w-4" />
              <AlertDescription>
                Cannot approve — insufficient balance. {approvalCheck.view.available} day(s) available
                (after {approvalCheck.view.pending} pending), {decision?.request.days} requested.
                Approving would push the balance negative; reject or ask the employee to revise.
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="decision-remarks">Remarks (optional)</Label>
            <Textarea
              id="decision-remarks"
              placeholder="e.g. Approved — cover arranged with team lead."
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDecision(null); setRemarks(''); }}>
              Cancel
            </Button>
            <Button
              variant={decision?.action === 'rejected' ? 'destructive' : 'default'}
              disabled={Boolean(approvalCheck && !approvalCheck.ok)}
              onClick={confirmDecision}
            >
              Confirm {decision?.action === 'approved' ? 'approval' : 'rejection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel approved leave dialog */}
      <Dialog open={cancelReq !== null} onOpenChange={(open) => { if (!open) { setCancelReq(null); setRemarks(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel approved leave</DialogTitle>
            <DialogDescription>
              {cancelReq && (
                <>
                  {empName(cancelReq.employeeId)?.name} — {LEAVE_TYPE_META[cancelReq.type].label},{' '}
                  {fmtDate(cancelReq.startDate)} → {fmtDate(cancelReq.endDate)} ({cancelReq.days} day(s)).
                  The request is marked cancelled and the days are restored to the balance.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cancel-remarks">Reason (optional)</Label>
            <Textarea
              id="cancel-remarks"
              placeholder="e.g. Project timeline moved — leave no longer needed."
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCancelReq(null); setRemarks(''); }}>
              Keep leave
            </Button>
            <Button variant="destructive" onClick={confirmCancel}>
              Confirm cancellation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
