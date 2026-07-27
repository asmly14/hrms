/**
 * "My claims" list — every claim of the acting employee with its status
 * pipeline (draft → submitted → approved/rejected → paid). Table on md+,
 * cards on small screens. Drafts can be edited, submitted or deleted;
 * rejected claims can be sent back to draft for fixing.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check, CircleDollarSign, Clock3, Paperclip, Pencil, Plus, RotateCcw, Send, Trash2, Wallet, X,
} from 'lucide-react';
import type { Employee } from '@/lib/types';
import { logAudit, useCollection } from '@/lib/db';
import { cn, fmtDate, fmtRM } from '@/lib/utils';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { categoryMetaOf, STATUS_META, type ClaimRecord } from './claimPolicy';

/** Mini 3-node pipeline: Submitted → decision → Paid (rejected branch in red). */
function Pipeline({ status }: { status: ClaimRecord['status'] }) {
  const rejected = status === 'rejected';
  const step = status === 'draft' ? 0 : status === 'submitted' ? 1 : status === 'paid' ? 3 : 2;
  const nodes = [
    { label: 'Submitted', done: step >= 1, active: step === 1 },
    { label: rejected ? 'Rejected' : 'Approved', done: step >= 2, active: step === 2, danger: rejected },
    { label: 'Paid', done: step >= 3, active: step === 3 },
  ];
  return (
    <div className="flex items-center gap-1">
      {nodes.map((n, i) => (
        <div key={n.label} className="flex items-center gap-1">
          {i > 0 && <span className={cn('h-px w-3', n.done || nodes[i - 1]!.done ? 'bg-amber-500/60' : 'bg-border')} />}
          <span
            className={cn(
              'flex h-4 w-4 items-center justify-center rounded-full border text-[9px]',
              n.danger && n.done
                ? 'border-red-500 bg-red-500 text-white'
                : n.done
                  ? 'border-amber-600 bg-amber-600 text-white'
                  : 'border-border bg-background text-muted-foreground',
            )}
            title={n.label}
          >
            {n.done ? (n.danger ? <X className="h-2.5 w-2.5" /> : <Check className="h-2.5 w-2.5" />) : i + 1}
          </span>
          <span
            className={cn(
              'text-[10px] leading-none',
              n.active ? 'font-medium text-foreground' : 'text-muted-foreground',
              n.danger && n.done && 'text-red-600',
            )}
          >
            {n.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: ClaimRecord['status'] }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant="outline" className={cn('font-medium', meta.badgeClass)}>
      {meta.label}
    </Badge>
  );
}

function ReceiptChip({ name }: { name?: string }) {
  if (!name) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex max-w-[140px] cursor-help items-center gap-1 text-xs text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{name}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

interface Props {
  claims: ClaimRecord[]; // already filtered to the acting employee
  employee: Employee;
  onNew: () => void;
  onEdit: (claim: ClaimRecord) => void;
}

export default function MyClaimsList({ claims, employee, onNew, onEdit }: Props) {
  const { update, remove } = useCollection<ClaimRecord>('claims');
  const [pendingDelete, setPendingDelete] = useState<ClaimRecord | null>(null);

  const sorted = [...claims].sort((a, b) => b.claimDate.localeCompare(a.claimDate));

  function submitNow(c: ClaimRecord) {
    // Resubmission starts a fresh decision cycle — clear stale decision data (B8).
    update(c.id, {
      status: 'submitted',
      submittedAt: new Date().toISOString(),
      decidedBy: undefined,
      decidedAt: undefined,
      decisionRemarks: undefined,
    });
    logAudit({
      actorId: employee.id,
      actorName: employee.name,
      action: 'claim.submit',
      entity: 'claims',
      entityId: c.id,
      detail: `${categoryMetaOf(c).label} — ${fmtRM(c.amount)} (${c.title.slice(0, 60)})`,
    });
  }

  function backToDraft(c: ClaimRecord) {
    // Rework wipes the previous decision (the rejection reason stays in the audit log).
    update(c.id, {
      status: 'draft',
      decidedBy: undefined,
      decidedAt: undefined,
      decisionRemarks: undefined,
    });
    logAudit({
      actorId: employee.id,
      actorName: employee.name,
      action: 'claim.rework',
      entity: 'claims',
      entityId: c.id,
      detail: 'Rejected claim returned to draft for rework',
    });
  }

  function deleteDraft() {
    if (!pendingDelete) return;
    remove(pendingDelete.id);
    logAudit({
      actorId: employee.id,
      actorName: employee.name,
      action: 'claim.delete',
      entity: 'claims',
      entityId: pendingDelete.id,
      detail: `Draft deleted — ${categoryMetaOf(pendingDelete).label} ${fmtRM(pendingDelete.amount)}`,
    });
    setPendingDelete(null);
  }

  if (sorted.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-10">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleDollarSign className="h-5 w-5" />
              </EmptyMedia>
              <EmptyTitle>No claims yet</EmptyTitle>
              <EmptyDescription>
                Submit your first expense claim — approved claims are reimbursed automatically in the
                next payroll run.
              </EmptyDescription>
            </EmptyHeader>
            <Button onClick={onNew} className="mt-2">
              <Plus className="h-4 w-4" /> New claim
            </Button>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  const actionsFor = (c: ClaimRecord, compact = false) => (
    <div className={cn('flex items-center gap-1', compact && 'flex-wrap')}>
      {c.status === 'draft' && (
        <>
          <Button variant="ghost" size="sm" onClick={() => onEdit(c)}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => submitNow(c)}>
            <Send className="h-3.5 w-3.5" /> Submit
          </Button>
          <AlertDialog
            open={pendingDelete?.id === c.id}
            onOpenChange={(o) => !o && setPendingDelete(null)}
          >
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700"
                onClick={() => setPendingDelete(c)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
                <AlertDialogDescription>
                  “{c.title}” ({fmtRM(c.amount)}, {fmtDate(c.claimDate)}) will be permanently removed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={deleteDraft}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
      {c.status === 'submitted' && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" /> Awaiting decision
        </span>
      )}
      {c.status === 'approved' && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Wallet className="h-3.5 w-3.5" /> In next payroll run
        </span>
      )}
      {c.status === 'rejected' && (
        <Button variant="ghost" size="sm" onClick={() => backToDraft(c)}>
          <RotateCcw className="h-3.5 w-3.5" /> Rework as draft
        </Button>
      )}
      {c.status === 'paid' && (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-lime-700">
          <span className="inline-flex items-center gap-1">
            <Check className="h-3.5 w-3.5" /> Reimbursed
          </span>
          {c.paidInRunId && (
            <Link
              to={`/payroll/runs/${c.paidInRunId}`}
              className="text-amber-700 underline underline-offset-2 hover:text-amber-800"
            >
              View payroll run
            </Link>
          )}
        </span>
      )}
    </div>
  );

  const remarkLine = (c: ClaimRecord) =>
    c.status === 'rejected' && c.decisionRemarks ? (
      <p className="mt-0.5 line-clamp-2 text-xs text-red-600">Approver: {c.decisionRemarks}</p>
    ) : c.status === 'approved' && c.decisionRemarks ? (
      <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">Note: {c.decisionRemarks}</p>
    ) : null;

  return (
    <>
      {/* ── md+ : table ── */}
      <Card className="hidden rounded-xl md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Expense date</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="w-[30%]">Description</TableHead>
              <TableHead>Receipt</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Pipeline</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((c) => {
              const meta = categoryMetaOf(c);
              return (
                <TableRow key={c.id}>
                  <TableCell className="whitespace-nowrap">{fmtDate(c.claimDate)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="gap-1.5 font-normal">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.color }} />
                      {meta.label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <p className="line-clamp-2 text-sm">{c.title}</p>
                    {c.mileageKm != null && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {c.mileageKm} km × {fmtRM(c.mileageRate ?? 0)}/km
                      </p>
                    )}
                    {remarkLine(c)}
                  </TableCell>
                  <TableCell>
                    <ReceiptChip name={c.receiptName} />
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{fmtRM(c.amount)}</TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell>
                    <Pipeline status={c.status} />
                  </TableCell>
                  <TableCell className="text-right">{actionsFor(c)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {/* ── <md : cards ── */}
      <div className="space-y-3 md:hidden">
        {sorted.map((c) => {
          const meta = categoryMetaOf(c);
          return (
            <Card key={c.id} className="rounded-xl">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.color }} />
                    {meta.label}
                  </Badge>
                  <span className="text-base font-semibold tabular-nums">{fmtRM(c.amount)}</span>
                </div>
                <div>
                  <p className="text-sm font-medium">{c.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>{fmtDate(c.claimDate)}</span>
                    {c.mileageKm != null && (
                      <span>{c.mileageKm} km × {fmtRM(c.mileageRate ?? 0)}/km</span>
                    )}
                    {c.receiptName && (
                      <span className="inline-flex items-center gap-1">
                        <Paperclip className="h-3 w-3" /> {c.receiptName}
                      </span>
                    )}
                  </p>
                  {remarkLine(c)}
                </div>
                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={c.status} />
                    <Pipeline status={c.status} />
                  </div>
                  {actionsFor(c, true)}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
