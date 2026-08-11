/**
 * /approvals — unified approvals inbox (audit-business-value.md quick win).
 *
 * ONE screen aggregating every pending decision queue — leave, claims and
 * overtime — with live counts, rich rows, inline approve/reject and bulk
 * approve. Nothing is forked: queue/scoping rules come from ./model (mirrors
 * pages/leave ApprovalsQueue, pages/claims ApproverInbox and pages/attendance
 * OTManager) and every decision runs the SAME mutation path as its source
 * module (./useDecisions), so balances, audit and payroll integration behave
 * identically. The NotificationBell badge consumes the same
 * usePendingApprovals() hook, so bell counts always equal inbox counts.
 *
 * Roles: Admin/HR decide company-wide, Managers their own department; nobody
 * can decide their own request (rows stay visible but locked). Employees have
 * no nav item — on a direct visit they see their own pending requests,
 * read-only. A collapsible "Recently decided (7 days)" section closes each
 * queue, and an "All caught up" hero shows when a queue hits zero.
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  History,
  Inbox,
  Receipt,
  ShieldAlert,
  Timer,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCollection } from '@/lib/db';
import { calcOT, hourlyFromMonthly, MAX_OT_HOURS_MONTH } from '@/lib/statutory';
import type { Department, Employee, LeaveStatus } from '@/lib/types';
import { avatarTone, cn, fmtDate, fmtRM, initialsOf, round2 } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AttendanceX } from '@/pages/attendance/model';
import {
  categoryMetaOf,
  policyWarnings,
  resolvePolicy,
  type ClaimPolicyDoc,
  type ClaimRecord,
} from '@/pages/claims/claimPolicy';
import { LEAVE_TYPE_META, type LeaveRequestEx } from '@/pages/leave/leaveLogic';
import { ageInDays, type ApprovalKind } from './model';
import { useClaimDecisions, useLeaveDecisions, useOtDecisions } from './useDecisions';
import { usePendingApprovals } from './usePendingApprovals';

type TabKey = 'all' | ApprovalKind;

type DialogState =
  | { kind: 'leave'; action: 'approved' | 'rejected'; req: LeaveRequestEx }
  | { kind: 'leave-bulk'; reqs: LeaveRequestEx[] }
  | { kind: 'claims-approve'; claims: ClaimRecord[] }
  | { kind: 'claims-reject'; claim: ClaimRecord }
  | { kind: 'ot-reject'; rec: AttendanceX }
  | null;

const KINDS: ApprovalKind[] = ['leave', 'claims', 'ot'];

const SECTION_META: Record<ApprovalKind, { title: string; noun: string }> = {
  leave: { title: 'Leave requests', noun: 'leave requests' },
  claims: { title: 'Claims', noun: 'claims' },
  ot: { title: 'Overtime', noun: 'OT requests' },
};

const DAYTYPE_LABEL = {
  normal: 'Normal workday (1.5×)',
  rest: 'Rest day (2.0×)',
  holiday: 'Public holiday (3.0×)',
} as const;

function StatusPill({ status }: { status: LeaveStatus }) {
  const cls: Record<LeaveStatus, string> = {
    pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
    approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
    rejected: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
    cancelled: 'bg-stone-200 text-stone-600 dark:bg-stone-700/50 dark:text-stone-300',
  };
  return (
    <Badge variant="secondary" className={cn('shrink-0 capitalize', cls[status])}>
      {status}
    </Badge>
  );
}

/** Waiting age of a pending request; turns amber after 3 days. */
function AgeBadge({ at }: { at: string }) {
  const d = ageInDays(at);
  return (
    <span
      className={cn(
        'whitespace-nowrap text-[11px]',
        d >= 3 ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
      )}
    >
      {d === 0 ? 'today' : `${d}d waiting`}
    </span>
  );
}

export default function ApprovalsPage() {
  const {
    role, isApprover, employeeId, queues, decidable, recent, scopedData, counts,
  } = usePendingApprovals();
  const leaveDec = useLeaveDecisions();
  const claimDec = useClaimDecisions();
  const otDec = useOtDecisions();
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: settingsDocs } = useCollection<ClaimPolicyDoc>('settings');

  const [tab, setTab] = useState<TabKey>('all');
  const [selected, setSelected] = useState<Record<ApprovalKind, Set<string>>>({
    leave: new Set(),
    claims: new Set(),
    ot: new Set(),
  });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [remarks, setRemarks] = useState('');
  const [recentOpen, setRecentOpen] = useState<Record<ApprovalKind, boolean>>({
    leave: false,
    claims: false,
    ot: false,
  });

  const policy = useMemo(() => resolvePolicy(settingsDocs), [settingsDocs]);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const deptName = (id?: string) => departments.find((d) => d.id === id)?.name ?? '—';

  // Summary-strip subtotals (visible pending, including locked self rows).
  const leaveDaysTotal = useMemo(() => round2(queues.leave.reduce((s, l) => s + l.days, 0)), [queues.leave]);
  const claimsAmountTotal = useMemo(() => round2(queues.claims.reduce((s, c) => s + c.amount, 0)), [queues.claims]);
  const otHoursTotal = useMemo(() => round2(queues.ot.reduce((s, a) => s + (a.otHours || 0), 0)), [queues.ot]);

  // ── Selection helpers ─────────────────────────────────────────────────────

  const toggleOne = (kind: ApprovalKind, id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev[kind]);
      if (on) next.add(id);
      else next.delete(id);
      return { ...prev, [kind]: next };
    });

  const toggleAll = (kind: ApprovalKind, ids: string[], on: boolean) =>
    setSelected((prev) => ({ ...prev, [kind]: on ? new Set(ids) : new Set() }));

  const clearKind = (kind: ApprovalKind) =>
    setSelected((prev) => ({ ...prev, [kind]: new Set() }));

  // ── Dialog openers ────────────────────────────────────────────────────────

  const openLeave = (req: LeaveRequestEx, action: 'approved' | 'rejected') => {
    setRemarks('');
    setDialog({ kind: 'leave', action, req });
  };
  const openLeaveBulk = () => {
    const reqs = decidable.leave.filter((l) => selected.leave.has(l.id));
    if (reqs.length === 0) return;
    setRemarks('');
    setDialog({ kind: 'leave-bulk', reqs });
  };
  const openClaimsApprove = (claims: ClaimRecord[]) => {
    if (claims.length === 0) return;
    setRemarks('');
    setDialog({ kind: 'claims-approve', claims });
  };
  const openClaimsReject = (claim: ClaimRecord) => {
    setRemarks('');
    setDialog({ kind: 'claims-reject', claim });
  };
  const openOtReject = (rec: AttendanceX) => {
    setRemarks('');
    setDialog({ kind: 'ot-reject', rec });
  };

  // ── Decision confirms (module mutation paths via ./useDecisions) ──────────

  const confirmLeave = () => {
    if (!dialog) return;
    if (dialog.kind === 'leave') {
      const res = leaveDec.decide(dialog.req, dialog.action, remarks);
      if (!res.ok && res.blocked === 'balance') {
        toast.error('Cannot approve — insufficient balance.');
      }
    } else if (dialog.kind === 'leave-bulk') {
      const { approvedCount, skipped } = leaveDec.approveBulk(dialog.reqs, remarks);
      if (approvedCount > 0) {
        toast.success(`${approvedCount} leave request${approvedCount === 1 ? '' : 's'} approved`);
      }
      if (skipped.length > 0) {
        toast.error(
          `${skipped.length} skipped (insufficient balance or own request): ${skipped.map((s) => s.name).join(', ')}`,
        );
      }
      clearKind('leave');
    } else {
      return;
    }
    setDialog(null);
    setRemarks('');
  };

  const confirmClaimsApprove = () => {
    if (dialog?.kind !== 'claims-approve') return;
    claimDec.approve(dialog.claims, remarks);
    clearKind('claims');
    setDialog(null);
    setRemarks('');
  };

  const confirmClaimsReject = () => {
    if (dialog?.kind !== 'claims-reject') return;
    claimDec.reject(dialog.claim, remarks);
    setDialog(null);
    setRemarks('');
  };

  const confirmOtReject = () => {
    if (dialog?.kind !== 'ot-reject') return;
    otDec.decide(dialog.rec, false, remarks);
    setDialog(null);
    setRemarks('');
  };

  const bulkApproveOt = () => {
    const recs = decidable.ot.filter((r) => selected.ot.has(r.id));
    if (recs.length === 0) return;
    const { approved, skipped } = otDec.approveBulk(recs);
    if (approved > 0) toast.success(`${approved} OT request${approved === 1 ? '' : 's'} approved`);
    if (skipped.length > 0) {
      toast.error(
        `${skipped.length} skipped — would exceed the ${MAX_OT_HOURS_MONTH}h monthly OT cap: ${skipped
          .map((s) => empById.get(s.rec.employeeId)?.name ?? s.rec.employeeId)
          .join(', ')}`,
      );
    }
    clearKind('ot');
  };

  const openBulkApprove = (kind: ApprovalKind) => {
    if (kind === 'leave') openLeaveBulk();
    else if (kind === 'claims') openClaimsApprove(decidable.claims.filter((c) => selected.claims.has(c.id)));
    else bulkApproveOt();
  };

  // Live balance re-check for the single-leave approve dialog (module B5).
  const leaveApprovalCheck =
    dialog?.kind === 'leave' && dialog.action === 'approved' ? leaveDec.balanceCheck(dialog.req) : null;

  // ── Row action column ─────────────────────────────────────────────────────

  const rowActions = (
    isSelf: boolean,
    onApprove: () => void,
    onReject: () => void,
    approveDisabled = false,
    approveTitle?: string,
  ) => {
    if (!isApprover) {
      return (
        <p className="text-[11px] italic text-muted-foreground sm:max-w-[150px]">
          Waiting for a Manager/HR/Admin decision.
        </p>
      );
    }
    if (isSelf) {
      return (
        <p className="flex items-center gap-1 text-xs italic text-muted-foreground sm:max-w-[150px]">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          Own request — another approver must decide
        </p>
      );
    }
    return (
      <div className="flex shrink-0 gap-2">
        <Button size="sm" className="gap-1" onClick={onApprove} disabled={approveDisabled} title={approveTitle}>
          <Check className="h-3.5 w-3.5" /> Approve
        </Button>
        <Button size="sm" variant="outline" className="gap-1" onClick={onReject}>
          <X className="h-4 w-4" /> Reject
        </Button>
      </div>
    );
  };

  // ── Pending row renderers (one per module) ────────────────────────────────

  const renderLeaveRow = (l: LeaveRequestEx) => {
    const emp = empById.get(l.employeeId);
    const name = emp?.name ?? l.employeeId;
    const isSelf = employeeId != null && l.employeeId === employeeId;
    const isSel = selected.leave.has(l.id);
    return (
      <div
        key={l.id}
        className={cn(
          'flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center',
          isSel && 'bg-amber-50/60 dark:bg-amber-950/20',
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {isApprover && (
            <Checkbox
              className="mt-1.5"
              checked={isSel}
              disabled={isSelf}
              onCheckedChange={(v) => toggleOne('leave', l.id, v === true)}
              aria-label={isSelf ? 'You cannot decide your own request' : 'Select leave request'}
            />
          )}
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarFallback className={cn('text-xs font-semibold', avatarTone(name))}>
              {initialsOf(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{name}</span>
              <Badge variant="secondary" className={cn(LEAVE_TYPE_META[l.type].chip)}>
                {LEAVE_TYPE_META[l.type].label}
              </Badge>
              {l.halfDay && <Badge variant="outline">½ day</Badge>}
              <AgeBadge at={l.appliedAt} />
            </div>
            <p className="text-sm text-muted-foreground">
              {LEAVE_TYPE_META[l.type].label} leave · {fmtDate(l.startDate)} → {fmtDate(l.endDate)} ·{' '}
              {l.days} day(s) · {deptName(emp?.departmentId)}
            </p>
            {l.reason && <p className="text-xs text-muted-foreground">“{l.reason}”</p>}
            <p className="text-xs text-muted-foreground">Applied {fmtDate(l.appliedAt)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          {rowActions(isSelf, () => openLeave(l, 'approved'), () => openLeave(l, 'rejected'))}
        </div>
      </div>
    );
  };

  const renderClaimRow = (c: ClaimRecord) => {
    const emp = empById.get(c.employeeId);
    const name = emp?.name ?? c.employeeId;
    const meta = categoryMetaOf(c);
    const flags = policyWarnings(
      {
        employeeId: c.employeeId,
        category: c.category,
        amount: c.amount,
        claimDate: c.claimDate,
        mileageRate: c.mileageRate,
      },
      scopedData.claims,
      policy,
      c.id,
    );
    const isSelf = employeeId != null && c.employeeId === employeeId;
    const isSel = selected.claims.has(c.id);
    return (
      <div
        key={c.id}
        className={cn(
          'flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center',
          isSel && 'bg-amber-50/60 dark:bg-amber-950/20',
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {isApprover && (
            <Checkbox
              className="mt-1.5"
              checked={isSel}
              disabled={isSelf}
              onCheckedChange={(v) => toggleOne('claims', c.id, v === true)}
              aria-label={isSelf ? 'You cannot decide your own claim' : 'Select claim'}
            />
          )}
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarFallback className={cn('text-xs font-semibold', avatarTone(name))}>
              {initialsOf(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{name}</span>
              <Badge variant="outline" className="gap-1.5 font-normal">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.color }} />
                {meta.label}
              </Badge>
              {flags.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-help text-amber-600">
                      <AlertTriangle className="h-4 w-4" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <ul className="list-disc space-y-1 pl-4">
                      {flags.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              )}
              <AgeBadge at={c.submittedAt ?? c.claimDate} />
            </div>
            <p className="text-sm text-muted-foreground">
              {c.title} · {fmtDate(c.claimDate)} · {deptName(emp?.departmentId)}
              {c.mileageKm != null && ` · ${c.mileageKm} km × ${fmtRM(c.mileageRate ?? 0)}/km`}
            </p>
            <p className="text-xs text-muted-foreground">
              Submitted {c.submittedAt ? fmtDate(c.submittedAt) : '—'}
              {c.receiptName ? ` · receipt: ${c.receiptName}` : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3">
          <span className="text-sm font-semibold tabular-nums">{fmtRM(c.amount)}</span>
          {rowActions(isSelf, () => openClaimsApprove([c]), () => openClaimsReject(c))}
        </div>
      </div>
    );
  };

  const renderOtRow = (r: AttendanceX) => {
    const emp = empById.get(r.employeeId);
    const name = emp?.name ?? r.employeeId;
    const pay = emp ? calcOT(hourlyFromMonthly(emp.baseSalary), r.otHours, r.otDayType) : 0;
    const isSelf = employeeId != null && r.employeeId === employeeId;
    const isSel = selected.ot.has(r.id);
    // Approval-time 104h cap check — same rule OTManager applies per row.
    const capBlocked = otDec.wouldExceedCap(r);
    return (
      <div
        key={r.id}
        className={cn(
          'flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center',
          isSel && 'bg-amber-50/60 dark:bg-amber-950/20',
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {isApprover && (
            <Checkbox
              className="mt-1.5"
              checked={isSel}
              disabled={isSelf}
              onCheckedChange={(v) => toggleOne('ot', r.id, v === true)}
              aria-label={isSelf ? 'You cannot decide your own OT request' : 'Select OT request'}
            />
          )}
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarFallback className={cn('text-xs font-semibold', avatarTone(name))}>
              {initialsOf(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{name}</span>
              <Badge variant="secondary">{DAYTYPE_LABEL[r.otDayType]}</Badge>
              <AgeBadge at={r.date} />
            </div>
            <p className="text-sm text-muted-foreground">
              Overtime · {fmtDate(r.date)} · {r.otHours}h · {deptName(emp?.departmentId)}
            </p>
            {r.otRequestReason && (
              <p className="text-xs text-muted-foreground">“{r.otRequestReason}”</p>
            )}
            {isApprover && !isSelf && capBlocked && (
              <p className="flex items-start gap-1 text-[11px] text-rose-700">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                Approving {r.otHours}h would exceed the {MAX_OT_HOURS_MONTH}h monthly OT cap —
                reject or wait for next month.
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3">
          <span className="text-sm font-semibold tabular-nums text-amber-700">
            {emp ? fmtRM(pay) : '—'}
          </span>
          {rowActions(
            isSelf,
            () => otDec.decide(r, true),
            () => openOtReject(r),
            capBlocked,
            capBlocked ? `Approving would exceed the ${MAX_OT_HOURS_MONTH}h monthly cap` : undefined,
          )}
        </div>
      </div>
    );
  };

  // ── Recently decided rows ─────────────────────────────────────────────────

  const renderRecentLeave = (l: LeaveRequestEx) => (
    <div key={l.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
      <div className="min-w-0">
        <span className="font-medium">{empById.get(l.employeeId)?.name ?? l.employeeId}</span>{' '}
        <span className="text-muted-foreground">
          {LEAVE_TYPE_META[l.type].label} · {fmtDate(l.startDate)} → {fmtDate(l.endDate)}
          {l.decidedAt ? ` · decided ${fmtDate(l.decidedAt)}` : ''}
          {l.decidedBy ? ` by ${l.decidedBy}` : ''}
        </span>
        {l.decisionRemarks && (
          <p className="mt-0.5 truncate text-xs italic text-muted-foreground">{l.decisionRemarks}</p>
        )}
      </div>
      <StatusPill status={l.status} />
    </div>
  );

  const renderRecentClaim = (c: ClaimRecord) => (
    <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
      <div className="min-w-0">
        <span className="font-medium">{empById.get(c.employeeId)?.name ?? c.employeeId}</span>{' '}
        <span className="text-muted-foreground">
          {categoryMetaOf(c).label} · {c.title} · {fmtRM(c.amount)}
          {c.decidedAt ? ` · decided ${fmtDate(c.decidedAt)}` : ''}
        </span>
        {c.decisionRemarks && (
          <p className="mt-0.5 truncate text-xs italic text-muted-foreground">{c.decisionRemarks}</p>
        )}
      </div>
      <StatusPill status={c.status === 'paid' ? 'approved' : (c.status as LeaveStatus)} />
    </div>
  );

  const renderRecentOt = (r: AttendanceX) => (
    <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
      <div className="min-w-0">
        <span className="font-medium">{empById.get(r.employeeId)?.name ?? r.employeeId}</span>{' '}
        <span className="text-muted-foreground">
          {fmtDate(r.date)} · {r.otHours}h · {DAYTYPE_LABEL[r.otDayType]}
        </span>
      </div>
      <StatusPill status={r.otApproved ? 'approved' : 'rejected'} />
    </div>
  );

  // ── Section scaffolding ───────────────────────────────────────────────────

  /** Narrowed recent-row rendering (the union array can't narrow on `kind`). */
  const renderRecentItems = (kind: ApprovalKind) => {
    if (kind === 'leave') return recent.leave.map(renderRecentLeave);
    if (kind === 'claims') return recent.claims.map(renderRecentClaim);
    return recent.ot.map(renderRecentOt);
  };

  const renderRecent = (kind: ApprovalKind) => {
    const itemCount = recent[kind].length;
    const open = recentOpen[kind];
    return (
      <div className="rounded-xl border">
        <button
          type="button"
          onClick={() => setRecentOpen((p) => ({ ...p, [kind]: !p[kind] }))}
          className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={open}
        >
          <span className="flex items-center gap-2">
            <History className="h-4 w-4" /> Recently decided (7 days)
            <Badge variant="secondary" className="px-1.5">{itemCount}</Badge>
          </span>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        {open && (
          <div className="space-y-2 border-t px-4 py-3">
            {itemCount === 0 ? (
              <p className="text-sm text-muted-foreground">No decisions in the last 7 days.</p>
            ) : (
              renderRecentItems(kind)
            )}
          </div>
        )}
      </div>
    );
  };

  const bulkSubtotal = (kind: ApprovalKind): string => {
    if (kind === 'leave') {
      return `${round2(decidable.leave.filter((l) => selected.leave.has(l.id)).reduce((s, l) => s + l.days, 0))} days`;
    }
    if (kind === 'claims') {
      return fmtRM(round2(decidable.claims.filter((c) => selected.claims.has(c.id)).reduce((s, c) => s + c.amount, 0)));
    }
    return `${round2(decidable.ot.filter((r) => selected.ot.has(r.id)).reduce((s, r) => s + (r.otHours || 0), 0))}h`;
  };

  const renderSection = (kind: ApprovalKind) => {
    const meta = SECTION_META[kind];
    const itemCount = queues[kind].length;
    const decidableIds =
      kind === 'leave'
        ? decidable.leave.map((l) => l.id)
        : kind === 'claims'
          ? decidable.claims.map((c) => c.id)
          : decidable.ot.map((r) => r.id);
    const selectedSet = selected[kind];
    const selectedCount = decidableIds.filter((id) => selectedSet.has(id)).length;
    const allSelected = decidableIds.length > 0 && decidableIds.every((id) => selectedSet.has(id));
    const icon =
      kind === 'leave' ? (
        <CalendarClock className="h-4 w-4 text-amber-600" />
      ) : kind === 'claims' ? (
        <Receipt className="h-4 w-4 text-amber-600" />
      ) : (
        <Timer className="h-4 w-4 text-amber-600" />
      );
    return (
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold">{meta.title}</h2>
          <Badge variant="secondary">{itemCount}</Badge>
          {isApprover && decidableIds.length > 0 && (
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(v) => toggleAll(kind, decidableIds, v === true)}
                aria-label={`Select all decidable ${meta.noun}`}
              />
              Select all
            </label>
          )}
        </div>

        {isApprover && selectedCount > 0 && (
          <div className="sticky top-14 z-10 flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 shadow-sm">
            <span className="text-sm">
              <span className="font-semibold">{selectedCount}</span> selected ·{' '}
              <span className="font-semibold tabular-nums">{bulkSubtotal(kind)}</span>
            </span>
            <Button size="sm" onClick={() => openBulkApprove(kind)}>
              <CheckCheck className="h-4 w-4" /> Approve selected
            </Button>
            <Button variant="ghost" size="sm" onClick={() => clearKind(kind)}>
              Clear
            </Button>
          </div>
        )}

        <div className="space-y-3">
          {kind === 'leave'
            ? queues.leave.map(renderLeaveRow)
            : kind === 'claims'
              ? queues.claims.map(renderClaimRow)
              : queues.ot.map(renderOtRow)}
        </div>

        {renderRecent(kind)}
      </section>
    );
  };

  const caughtUpHero = (kind?: ApprovalKind) => (
    <Card className="rounded-xl">
      <CardContent className="py-12">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCircle2 className="h-5 w-5" />
            </EmptyMedia>
            <EmptyTitle>All caught up</EmptyTitle>
            <EmptyDescription>
              {kind
                ? `No ${SECTION_META[kind].noun} waiting for a decision right now.`
                : isApprover
                  ? 'No leave requests, claims or overtime are waiting for your decision right now.'
                  : 'You have no requests waiting for a decision right now.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  );

  // ── Main render ───────────────────────────────────────────────────────────

  // Seed data loads asynchronously on first launch — show a loading state.
  if (employees.length === 0) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const summaryCards: { kind: ApprovalKind; label: string; count: number; sub: string }[] = [
    {
      kind: 'leave',
      label: 'Leave',
      count: counts.leave,
      sub: counts.leave === 0 ? 'nothing pending' : `${leaveDaysTotal} day(s) requested`,
    },
    {
      kind: 'claims',
      label: 'Claims',
      count: counts.claims,
      sub: counts.claims === 0 ? 'nothing pending' : `${fmtRM(claimsAmountTotal)} claimed`,
    },
    {
      kind: 'ot',
      label: 'Overtime',
      count: counts.ot,
      sub: counts.ot === 0 ? 'nothing pending' : `${otHoursTotal}h requested`,
    },
  ];

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Inbox className="h-6 w-6 text-amber-600" /> Approvals
          {counts.total > 0 && (
            <Badge className="bg-amber-600 text-white hover:bg-amber-600">{counts.total}</Badge>
          )}
        </h1>
        <p className="text-sm text-muted-foreground">
          One inbox for every pending decision — leave, claims and overtime. Decisions here run the
          same paths as the module pages, so balances, audit and payroll behave identically.
          {role === 'Manager' ? ' Showing your department only.' : ''}
        </p>
      </div>

      {/* ── Summary strip (click a card to jump to its tab) ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {summaryCards.map((s) => (
          <button
            key={s.kind}
            type="button"
            onClick={() => setTab(s.kind)}
            className={cn(
              'rounded-xl border bg-card p-4 text-left transition-colors hover:border-amber-400',
              tab === s.kind && 'border-amber-400',
            )}
          >
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {s.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{s.count}</div>
            <div className="text-xs text-muted-foreground">{s.sub}</div>
          </button>
        ))}
      </div>

      {/* ── Employee direct-visit notice ── */}
      {!isApprover && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <ShieldAlert className="h-4 w-4" />
          <AlertDescription>
            These are your own requests waiting for a Manager/HR/Admin decision. Approvers decide
            them here or inside the Leave, Claims and Attendance modules.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Queues ── */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="space-y-4">
        <TabsList className="flex w-full flex-wrap justify-start gap-1 sm:w-auto">
          <TabsTrigger value="all" className="gap-1.5">
            <Inbox className="h-4 w-4" /> All
            {counts.total > 0 && <Badge variant="secondary" className="ml-1">{counts.total}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="leave" className="gap-1.5">
            <CalendarClock className="h-4 w-4" /> Leave
            {counts.leave > 0 && <Badge variant="secondary" className="ml-1">{counts.leave}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="claims" className="gap-1.5">
            <Receipt className="h-4 w-4" /> Claims
            {counts.claims > 0 && <Badge variant="secondary" className="ml-1">{counts.claims}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="ot" className="gap-1.5">
            <Timer className="h-4 w-4" /> OT
            {counts.ot > 0 && <Badge variant="secondary" className="ml-1">{counts.ot}</Badge>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-4 space-y-8">
          {counts.total === 0 && caughtUpHero()}
          {KINDS.map((kind) =>
            queues[kind].length > 0 ? (
              <div key={kind}>{renderSection(kind)}</div>
            ) : recent[kind].length > 0 ? (
              <div key={kind}>{renderRecent(kind)}</div>
            ) : null,
          )}
        </TabsContent>

        {KINDS.map((kind) => (
          <TabsContent key={kind} value={kind} className="mt-4 space-y-4">
            {queues[kind].length === 0 ? (
              <>
                {caughtUpHero(kind)}
                {renderRecent(kind)}
              </>
            ) : (
              renderSection(kind)
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* ── Leave decision dialog (single or bulk approve) ── */}
      <Dialog
        open={dialog?.kind === 'leave' || dialog?.kind === 'leave-bulk'}
        onOpenChange={(o) => {
          if (!o) {
            setDialog(null);
            setRemarks('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === 'leave-bulk'
                ? `Approve ${dialog.reqs.length} leave requests`
                : `${dialog?.kind === 'leave' && dialog.action === 'approved' ? 'Approve' : 'Reject'} leave request`}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === 'leave' && (
                <>
                  {empById.get(dialog.req.employeeId)?.name ?? dialog.req.employeeId} —{' '}
                  {LEAVE_TYPE_META[dialog.req.type].label}, {fmtDate(dialog.req.startDate)} →{' '}
                  {fmtDate(dialog.req.endDate)} ({dialog.req.days} day(s)).
                </>
              )}
              {dialog?.kind === 'leave-bulk' && (
                <>
                  Total{' '}
                  <span className="font-medium text-foreground">
                    {round2(dialog.reqs.reduce((s, r) => s + r.days, 0))} day(s)
                  </span>{' '}
                  across {dialog.reqs.length} requests will be marked approved and deducted from
                  each employee&apos;s tracked balance after a live balance re-check. Requests with
                  insufficient balance are skipped and reported.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === 'leave-bulk' && (
            <ul className="max-h-40 space-y-1 overflow-auto rounded-lg border p-2 text-sm">
              {dialog.reqs.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {empById.get(r.employeeId)?.name ?? r.employeeId} — {LEAVE_TYPE_META[r.type].label}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{r.days}d</span>
                </li>
              ))}
            </ul>
          )}
          {leaveApprovalCheck && !leaveApprovalCheck.ok && dialog?.kind === 'leave' && (
            <Alert variant="destructive">
              <ShieldAlert className="h-4 w-4" />
              <AlertDescription>
                Cannot approve — insufficient balance. {leaveApprovalCheck.available} day(s)
                available, {dialog.req.days} requested. Approving would push the balance negative;
                reject or ask the employee to revise.
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="approvals-leave-remarks">Remarks (optional)</Label>
            <Textarea
              id="approvals-leave-remarks"
              placeholder="e.g. Approved — cover arranged with team lead."
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialog(null);
                setRemarks('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant={dialog?.kind === 'leave' && dialog.action === 'rejected' ? 'destructive' : 'default'}
              disabled={Boolean(leaveApprovalCheck && !leaveApprovalCheck.ok)}
              onClick={confirmLeave}
            >
              {dialog?.kind === 'leave-bulk'
                ? 'Approve all'
                : `Confirm ${dialog?.kind === 'leave' && dialog.action === 'approved' ? 'approval' : 'rejection'}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Claims approve dialog (single or bulk) ── */}
      <Dialog
        open={dialog?.kind === 'claims-approve'}
        onOpenChange={(o) => {
          if (!o) {
            setDialog(null);
            setRemarks('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Approve {dialog?.kind === 'claims-approve' && dialog.claims.length > 1 ? `${dialog.claims.length} claims` : 'claim'}?
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === 'claims-approve' && (
                <>
                  Total{' '}
                  <span className="font-medium text-foreground">
                    {fmtRM(round2(dialog.claims.reduce((s, c) => s + c.amount, 0)))}
                  </span>{' '}
                  will be marked approved and reimbursed in the next payroll run as non-statutory
                  claim lines.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="approvals-claims-approve-remarks">Remarks (optional)</Label>
            <Textarea
              id="approvals-claims-approve-remarks"
              rows={3}
              placeholder="e.g. Verified against project budget"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setDialog(null);
                setRemarks('');
              }}
            >
              Cancel
            </Button>
            <Button onClick={confirmClaimsApprove}>
              <Check className="h-4 w-4" /> Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Claims reject dialog (remarks required) ── */}
      <Dialog
        open={dialog?.kind === 'claims-reject'}
        onOpenChange={(o) => {
          if (!o) {
            setDialog(null);
            setRemarks('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject claim?</DialogTitle>
            <DialogDescription>
              {dialog?.kind === 'claims-reject' && (
                <>
                  “{dialog.claim.title}” —{' '}
                  <span className="font-medium text-foreground">{fmtRM(dialog.claim.amount)}</span> by{' '}
                  {empById.get(dialog.claim.employeeId)?.name ?? 'Unknown'}. The employee will see
                  your reason and can rework the claim.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="approvals-claims-reject-remarks">Reason for rejection (required)</Label>
            <Textarea
              id="approvals-claims-reject-remarks"
              rows={3}
              placeholder="e.g. Missing itemised receipt — please resubmit with the tax invoice"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setDialog(null);
                setRemarks('');
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={remarks.trim().length < 3} onClick={confirmClaimsReject}>
              <X className="h-4 w-4" /> Reject claim
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── OT reject dialog (remark appended to the record notes) ── */}
      <Dialog
        open={dialog?.kind === 'ot-reject'}
        onOpenChange={(o) => {
          if (!o) {
            setDialog(null);
            setRemarks('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject OT request?</DialogTitle>
            <DialogDescription>
              {dialog?.kind === 'ot-reject' && (
                <>
                  {empById.get(dialog.rec.employeeId)?.name ?? dialog.rec.employeeId} —{' '}
                  {dialog.rec.otHours}h on {fmtDate(dialog.rec.date)} ({DAYTYPE_LABEL[dialog.rec.otDayType]}
                  ). Rejected OT is not paid by payroll; the employee can re-request with adjusted
                  hours.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="approvals-ot-reject-remarks">Reason (optional)</Label>
            <Textarea
              id="approvals-ot-reject-remarks"
              rows={3}
              placeholder="e.g. Deadline moved — OT no longer needed this week"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setDialog(null);
                setRemarks('');
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmOtReject}>
              <X className="h-4 w-4" /> Reject OT
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
