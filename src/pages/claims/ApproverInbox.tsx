/**
 * Approver inbox — FIFO queue of submitted claims with per-category totals,
 * policy-limit flags, approve/reject dialogs (remarks), and bulk approve.
 * Every decision is written to the audit log.
 *
 * The queue is scoped by the page: Admin/HR see all submitted claims, a
 * Manager only their own department's. An approver can never decide their
 * own claim — self rows are visible but locked, and the decision handlers
 * filter them out defensively. `decidedBy`/audit use the auth user's
 * identity (never the impersonated acting-as stub) once auth is wired.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCheck, Inbox, Paperclip, ShieldAlert, X } from 'lucide-react';
import type { Department, Employee } from '@/lib/types';
import { logAudit, useCollection } from '@/lib/db';
import { avatarTone, cn, fmtDate, fmtRM, initialsOf, round2 } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  CATEGORY_LABEL, categoryMetaOf, policyWarnings,
  type ClaimPolicy, type ClaimRecord,
} from './claimPolicy';

type DecisionDialog =
  | { mode: 'approve'; ids: string[] }
  | { mode: 'reject'; id: string }
  | null;

export default function ApproverInbox({
  actor,
  policy,
  claims,
}: {
  /**
   * Approver identity used for decidedBy + audit. Once auth is wired this is
   * the logged-in user (linked employee id, or the user id for standalone
   * Admin/HR accounts) — never the impersonated acting-as employee.
   */
  actor: { id: string; name: string };
  policy: ClaimPolicy;
  /** Claim pool already role-scoped by the page (Manager → own department). */
  claims: ClaimRecord[];
}) {
  const { update } = useCollection<ClaimRecord>('claims');
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DecisionDialog>(null);
  const [remarks, setRemarks] = useState('');

  const actorId = actor.id;
  /** An approver must never decide their own claim. */
  const isSelf = (c: ClaimRecord) => c.employeeId === actorId;

  const pending = useMemo(
    () =>
      claims
        .filter((c) => c.status === 'submitted')
        .sort((a, b) => (a.submittedAt ?? a.claimDate).localeCompare(b.submittedAt ?? b.claimDate)),
    [claims],
  );

  /** Claims this approver may actually decide (excludes their own). */
  const selectable = useMemo(
    () => pending.filter((c) => c.employeeId !== actorId),
    [pending, actorId],
  );

  const catTotals = useMemo(() => {
    const m = new Map<string, { count: number; total: number }>();
    for (const c of pending) {
      const cur = m.get(c.category) ?? { count: 0, total: 0 };
      m.set(c.category, { count: cur.count + 1, total: round2(cur.total + c.amount) });
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [pending]);

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const deptName = (id?: string) => departments.find((d) => d.id === id)?.name ?? '—';

  const flagsFor = (c: ClaimRecord) =>
    policyWarnings(
      {
        employeeId: c.employeeId,
        category: c.category,
        amount: c.amount,
        claimDate: c.claimDate,
        mileageRate: c.mileageRate,
      },
      claims,
      policy,
      c.id,
    );

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.id));
  const selectedClaims = selectable.filter((c) => selected.has(c.id));
  const selectedTotal = round2(selectedClaims.reduce((s, c) => s + c.amount, 0));

  function openApprove(ids: string[]) {
    setRemarks('');
    setDialog({ mode: 'approve', ids });
  }

  function openReject(id: string) {
    setRemarks('');
    setDialog({ mode: 'reject', id });
  }

  function confirmApprove() {
    if (!dialog || dialog.mode !== 'approve') return;
    const now = new Date().toISOString();
    const note = remarks.trim();
    // Defensive: never approve the approver's own claim, even if the UI let it through.
    const targets = pending.filter((c) => dialog.ids.includes(c.id) && c.employeeId !== actor.id);
    if (targets.length === 0) {
      setDialog(null);
      return;
    }
    for (const c of targets) {
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
        detail: `${categoryMetaOf(c).label} — ${fmtRM(c.amount)} for ${empById.get(c.employeeId)?.name ?? c.employeeId}${note ? ` · ${note}` : ''}`,
      });
    }
    if (targets.length > 1) {
      logAudit({
        actorId: actor.id,
        actorName: actor.name,
        action: 'claim.bulk-approve',
        entity: 'claims',
        detail: `${targets.length} claims approved in bulk, ${fmtRM(round2(targets.reduce((s, c) => s + c.amount, 0)))} total`,
      });
    }
    setSelected(new Set());
    setDialog(null);
  }

  function confirmReject() {
    if (!dialog || dialog.mode !== 'reject') return;
    const c = pending.find((x) => x.id === dialog.id);
    if (!c || c.employeeId === actor.id) {
      setDialog(null);
      return;
    }
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
      detail: `${categoryMetaOf(c).label} — ${fmtRM(c.amount)} for ${empById.get(c.employeeId)?.name ?? c.employeeId} · ${note}`,
    });
    setDialog(null);
  }

  const rejectTarget = dialog?.mode === 'reject' ? pending.find((c) => c.id === dialog.id) : undefined;

  const flagIcon = (c: ClaimRecord) => {
    const flags = flagsFor(c);
    if (flags.length === 0) return null;
    return (
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
    );
  };

  const rowActions = (c: ClaimRecord) => {
    if (isSelf(c)) {
      return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5 text-amber-600" /> Own claim — another approver must decide
        </span>
      );
    }
    return (
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" className="text-lime-700 hover:text-lime-800" onClick={() => openApprove([c.id])}>
          <Check className="h-3.5 w-3.5" /> Approve
        </Button>
        <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => openReject(c.id)}>
          <X className="h-3.5 w-3.5" /> Reject
        </Button>
      </div>
    );
  };

  const employeeCell = (c: ClaimRecord) => {
    const emp = empById.get(c.employeeId);
    const name = emp?.name ?? 'Unknown';
    return (
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarTone(name)}`}>
          {initialsOf(name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">{deptName(emp?.departmentId)}</p>
        </div>
      </div>
    );
  };

  const detailCell = (c: ClaimRecord) => {
    const meta = categoryMetaOf(c);
    return (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="gap-1.5 font-normal">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.color }} />
            {meta.label}
          </Badge>
          {flagIcon(c)}
        </div>
        <p className="mt-1 line-clamp-2 text-sm">{c.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>{fmtDate(c.claimDate)}</span>
          {c.mileageKm != null && <span>{c.mileageKm} km × {fmtRM(c.mileageRate ?? 0)}/km</span>}
          {c.receiptName && (
            <span className="inline-flex items-center gap-1">
              <Paperclip className="h-3 w-3" /> {c.receiptName}
            </span>
          )}
        </p>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Category totals for the pending queue */}
      {pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Queue totals</span>
          {catTotals.map(([cat, t]) => (
            <Badge key={cat} variant="secondary" className="gap-1.5 font-normal">
              {CATEGORY_LABEL[cat as keyof typeof CATEGORY_LABEL] ?? cat}
              <span className="font-semibold tabular-nums">{fmtRM(t.total)}</span>
              <span className="text-muted-foreground">· {t.count}</span>
            </Badge>
          ))}
        </div>
      )}

      {selectedClaims.length > 0 && (
        <div className="sticky top-14 z-10 flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 shadow-sm">
          <span className="text-sm">
            <span className="font-semibold">{selectedClaims.length}</span> selected ·{' '}
            <span className="font-semibold tabular-nums">{fmtRM(selectedTotal)}</span>
          </span>
          <Button size="sm" onClick={() => openApprove(selectedClaims.map((c) => c.id))}>
            <CheckCheck className="h-4 w-4" /> Approve selected
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {pending.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="py-10">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox className="h-5 w-5" />
                </EmptyMedia>
                <EmptyTitle>All caught up</EmptyTitle>
                <EmptyDescription>
                  No submitted claims are waiting for a decision right now.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── md+ : table ── */}
          <Card className="hidden rounded-xl md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(v) =>
                        setSelected(v === true ? new Set(selectable.map((c) => c.id)) : new Set())
                      }
                      disabled={selectable.length === 0}
                      aria-label="Select all decidable claims"
                    />
                  </TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead className="w-[34%]">Claim</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((c) => (
                  <TableRow key={c.id} className={cn(selected.has(c.id) && 'bg-amber-50/60 dark:bg-amber-950/20')}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(c.id)}
                        onCheckedChange={(v) => toggle(c.id, v === true)}
                        disabled={isSelf(c)}
                        aria-label={isSelf(c) ? 'You cannot decide your own claim' : 'Select claim'}
                      />
                    </TableCell>
                    <TableCell>{employeeCell(c)}</TableCell>
                    <TableCell>{detailCell(c)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {c.submittedAt ? fmtDate(c.submittedAt) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{fmtRM(c.amount)}</TableCell>
                    <TableCell className="text-right">{rowActions(c)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/* ── <md : cards ── */}
          <div className="space-y-3 md:hidden">
            {pending.map((c) => (
              <Card key={c.id} className={cn('rounded-xl', selected.has(c.id) && 'border-amber-400 bg-amber-50/60 dark:bg-amber-950/20')}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5">
                      <Checkbox
                        checked={selected.has(c.id)}
                        onCheckedChange={(v) => toggle(c.id, v === true)}
                        disabled={isSelf(c)}
                        aria-label={isSelf(c) ? 'You cannot decide your own claim' : 'Select claim'}
                        className="mt-1"
                      />
                      {employeeCell(c)}
                    </div>
                    <span className="text-base font-semibold tabular-nums">{fmtRM(c.amount)}</span>
                  </div>
                  {detailCell(c)}
                  <div className="flex items-center justify-between gap-2 border-t pt-3">
                    <span className="text-xs text-muted-foreground">
                      Submitted {c.submittedAt ? fmtDate(c.submittedAt) : '—'}
                    </span>
                    {rowActions(c)}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Approve dialog (single or bulk) */}
      <Dialog open={dialog?.mode === 'approve'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve {dialog?.mode === 'approve' && dialog.ids.length > 1 ? `${dialog.ids.length} claims` : 'claim'}?</DialogTitle>
            <DialogDescription>
              {dialog?.mode === 'approve' && (
                <>
                  Total <span className="font-medium text-foreground">{fmtRM(round2(
                    pending.filter((c) => dialog.ids.includes(c.id)).reduce((s, c) => s + c.amount, 0),
                  ))}</span>{' '}
                  will be marked approved and reimbursed in the next payroll run as non-statutory
                  claim lines.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="approve-remarks">Remarks (optional)</Label>
            <Textarea
              id="approve-remarks"
              rows={3}
              placeholder="e.g. Verified against project budget"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button onClick={confirmApprove}>
              <Check className="h-4 w-4" /> Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog (single, remarks required) */}
      <Dialog open={dialog?.mode === 'reject'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject claim?</DialogTitle>
            <DialogDescription>
              {rejectTarget && (
                <>
                  “{rejectTarget.title}” —{' '}
                  <span className="font-medium text-foreground">{fmtRM(rejectTarget.amount)}</span> by{' '}
                  {empById.get(rejectTarget.employeeId)?.name ?? 'Unknown'}. The employee will see your
                  reason and can rework the claim.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reject-remarks">Reason for rejection (required)</Label>
            <Textarea
              id="reject-remarks"
              rows={3}
              placeholder="e.g. Missing itemised receipt — please resubmit with the tax invoice"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={remarks.trim().length < 3}
              onClick={confirmReject}
            >
              <X className="h-4 w-4" /> Reject claim
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
