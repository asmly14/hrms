/**
 * SeparationActions — Admin/HR dropdown menu + the four shared separation
 * dialogs (Resign / VSS / Other separation / Delete-permanently). Used by the
 * directory row menu, the employee detail header menu, and the bulk action
 * bar — the same dialogs serve single-employee and multi-employee batches.
 *
 * All writes go through ./separations (pure, storage-backed helpers); dialogs
 * only collect input, show previews, chunk large batches with progress, and
 * render the per-employee succeeded/skipped summary.
 */
import { useMemo, useState } from 'react';
import {
  CalendarClock,
  DoorOpen,
  FileSignature,
  HandCoins,
  Loader2,
  MoreHorizontal,
  Trash2,
  TriangleAlert,
  UserMinus,
} from 'lucide-react';
import type { Claim, Employee, LeaveBalance, Payslip } from '@/lib/types';
import { getCollection } from '@/lib/db';
import {
  computeFinalPay,
  noticeWeeksFor,
} from '@/lib/lifecycle';
import { fmtDate, fmtRM } from '@/lib/utils';
import {
  OTHER_SEPARATION_REASON_LABELS,
  bulkDelete,
  bulkSeparate,
  computeVssAmount,
  deleteBlockReason,
  suggestedLastWorkingDay,
  type BulkDeleteResult,
  type BulkItemResult,
  type BulkSeparationResult,
  type BulkSkippedResult,
  type OtherSeparationReason,
  type SeparationSpec,
} from './separations';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type DialogKind = 'resign' | 'vss' | 'other' | 'delete';
type Phase = 'form' | 'running' | 'done';

const CHUNK = 25;

/** Run a bulk op in small chunks so large batches report live progress. */
async function runChunked(
  targets: Employee[],
  fn: (slice: Employee[]) => { succeeded: BulkItemResult[]; skipped: BulkSkippedResult[] },
  onProgress: (done: number, total: number) => void,
): Promise<{ succeeded: BulkItemResult[]; skipped: BulkSkippedResult[] }> {
  const agg = { succeeded: [] as BulkItemResult[], skipped: [] as BulkSkippedResult[] };
  for (let i = 0; i < targets.length; i += CHUNK) {
    const r = fn(targets.slice(i, i + CHUNK));
    agg.succeeded.push(...r.succeeded);
    agg.skipped.push(...r.skipped);
    onProgress(Math.min(i + CHUNK, targets.length), targets.length);
    // Yield so the progress paint lands between chunks.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return agg;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Shared result summary rendered after a bulk op finishes. */
function ResultSummary({
  result,
  verb,
}: {
  result: BulkSeparationResult | BulkDeleteResult;
  verb: string;
}) {
  return (
    <div className="space-y-3 py-2">
      <p className="text-sm">
        <span className="font-semibold text-lime-700">{result.succeeded.length}</span> {verb}
        {result.skipped.length > 0 && (
          <>
            {' · '}
            <span className="font-semibold text-amber-700">{result.skipped.length}</span> skipped
          </>
        )}
      </p>
      {result.succeeded.length > 0 && (
        <div className="max-h-32 overflow-y-auto rounded-lg border border-border p-2.5 text-xs text-muted-foreground">
          {result.succeeded.map((s) => (
            <p key={s.employeeId}>✓ {s.name}</p>
          ))}
        </div>
      )}
      {result.skipped.length > 0 && (
        <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 text-xs">
          {result.skipped.map((s) => (
            <p key={s.employeeId}>
              <span className="font-medium text-foreground">{s.name}</span>
              <span className="text-amber-800"> — {s.reason}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressLine({ done, total }: { done: number; total: number }) {
  return (
    <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
      Processing {done} of {total}…
    </p>
  );
}

interface DialogProps {
  targets: Employee[];
  actorName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}

/** Name line shown at the top of every dialog so scope is unambiguous. */
function TargetLine({ targets }: { targets: Employee[] }) {
  return (
    <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-muted-foreground">
      {targets.length === 1
        ? targets[0]!.name
        : `${targets.length} employees selected — one shared set of terms applies to the whole batch.`}
    </p>
  );
}

/* ── Resign ─────────────────────────────────────────────────────────────── */

function ResignDialog({ targets, actorName, open, onOpenChange, onCompleted }: DialogProps) {
  const separable = useMemo(() => targets.filter((t) => t.status !== 'resigned'), [targets]);
  const [noticeDate, setNoticeDate] = useState(today());
  const first = separable[0];
  const suggested = first ? suggestedLastWorkingDay(first, noticeDate) : '';
  const [lwd, setLwd] = useState('');
  const [remarks, setRemarks] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<BulkSeparationResult | null>(null);

  const effectiveLwd = lwd || suggested;

  async function submit() {
    setPhase('running');
    const spec: SeparationSpec = {
      kind: 'resign',
      noticeDate,
      lastWorkingDay: effectiveLwd,
      remarks: remarks.trim() || undefined,
    };
    const r = await runChunked(
      targets,
      (slice) => bulkSeparate(slice, spec, actorName),
      (done, total) => setProgress({ done, total }),
    );
    setResult(r);
    setPhase('done');
  }

  function close(next: boolean) {
    if (!next && phase === 'done') onCompleted();
    if (!next) {
      setPhase('form');
      setResult(null);
      setLwd('');
      setRemarks('');
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Resign {targets.length > 1 ? `(${targets.length} employees)` : targets[0]?.name}</DialogTitle>
          <DialogDescription>
            Sets status to Resigned, records the resignation date, and opens an offboarding case
            (reason: Resignation) so the exit flows through the clearance checklist.
          </DialogDescription>
        </DialogHeader>

        {phase === 'form' && (
          <div className="grid gap-4 py-2">
            <TargetLine targets={targets} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="res-notice">Notice date</Label>
                <Input
                  id="res-notice"
                  type="date"
                  value={noticeDate}
                  onChange={(e) => {
                    setNoticeDate(e.target.value);
                    setLwd(''); // re-suggest from the new notice date
                  }}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="res-lwd">Last working day</Label>
                <Input
                  id="res-lwd"
                  type="date"
                  value={effectiveLwd}
                  onChange={(e) => setLwd(e.target.value)}
                />
                {first && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CalendarClock className="h-3 w-3" />
                    EA s.12 suggests {fmtDate(suggested)} ({noticeWeeksFor(first.joinDate, noticeDate)}{' '}
                    weeks' notice{targets.length > 1 ? `, based on ${first.name}` : ''})
                  </p>
                )}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="res-remarks">Remarks (optional)</Label>
              <Textarea
                id="res-remarks"
                rows={2}
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Reason for leaving, handover notes…"
              />
            </div>
            {separable.length < targets.length && (
              <p className="flex items-start gap-1.5 text-xs text-amber-800">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {targets.length - separable.length} already-resigned employee(s) will be skipped
                (use Delete for those records instead).
              </p>
            )}
          </div>
        )}
        {phase === 'running' && <ProgressLine done={progress.done} total={progress.total} />}
        {phase === 'done' && result && <ResultSummary result={result} verb="resigned" />}

        <DialogFooter>
          {phase === 'form' && (
            <>
              <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
              <Button
                onClick={submit}
                disabled={separable.length === 0 || !noticeDate || !effectiveLwd}
                className="bg-amber-600 text-white hover:bg-amber-700"
              >
                <UserMinus className="mr-1.5 h-4 w-4" />
                Confirm resignation{targets.length > 1 ? ` (${separable.length})` : ''}
              </Button>
            </>
          )}
          {phase === 'done' && <Button onClick={() => close(false)}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── VSS ────────────────────────────────────────────────────────────────── */

function VssDialog({ targets, actorName, open, onOpenChange, onCompleted }: DialogProps) {
  const separable = useMemo(() => targets.filter((t) => t.status !== 'resigned'), [targets]);
  const single = targets.length === 1 ? targets[0] : undefined;
  const [noticeDate] = useState(today());
  const [lwd, setLwd] = useState(() =>
    targets.length > 0 ? suggestedLastWorkingDay(targets[0]!, today()) : '',
  );
  const [months, setMonths] = useState('1');
  const [salary, setSalary] = useState(() => String(single?.baseSalary ?? ''));
  const [terms, setTerms] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<BulkSeparationResult | null>(null);

  const monthsNum = Number.parseFloat(months) || 0;
  const salaryNum = Number.parseFloat(salary) || 0;
  const payout = computeVssAmount(monthsNum, single ? salaryNum : 0);

  /** Statutory final-pay preview for a single target. */
  const finalPayPreview = useMemo(() => {
    if (!single || !lwd) return null;
    return computeFinalPay({
      employee: single,
      lastWorkingDay: lwd,
      leaveBalances: getCollection<LeaveBalance>('leaveBalances'),
      claims: getCollection<Claim>('claims'),
    });
  }, [single, lwd]);

  async function submit() {
    setPhase('running');
    const specFor = (emp: Employee): SeparationSpec => ({
      kind: 'vss',
      noticeDate,
      lastWorkingDay: lwd,
      remarks: terms.trim() || undefined,
      vss: {
        months: monthsNum,
        // Bulk: months × each employee's own last drawn salary. Single: editable input.
        lastDrawnSalary: single ? salaryNum : emp.baseSalary,
        terms: terms.trim() || undefined,
      },
    });
    const r = await runChunked(
      targets,
      (slice) => {
        const agg: BulkSeparationResult = { succeeded: [], skipped: [] };
        for (const emp of slice) {
          const one = bulkSeparate([emp], specFor(emp), actorName);
          agg.succeeded.push(...one.succeeded);
          agg.skipped.push(...one.skipped);
        }
        return agg;
      },
      (done, total) => setProgress({ done, total }),
    );
    setResult(r);
    setPhase('done');
  }

  function close(next: boolean) {
    if (!next && phase === 'done') onCompleted();
    if (!next) {
      setPhase('form');
      setResult(null);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Voluntary Separation Scheme {targets.length > 1 ? `(${targets.length} employees)` : targets[0]?.name}
          </DialogTitle>
          <DialogDescription>
            Records the VSS package on the offboarding case, sets status to Resigned, and previews
            the ex-gratia payout alongside statutory final pay.
          </DialogDescription>
        </DialogHeader>

        {phase === 'form' && (
          <div className="grid gap-4 py-2">
            <TargetLine targets={targets} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="vss-months">Ex-gratia months</Label>
                <Input
                  id="vss-months"
                  type="number"
                  min="0"
                  step="0.5"
                  value={months}
                  onChange={(e) => setMonths(e.target.value)}
                />
              </div>
              {single ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="vss-salary">Last drawn salary (RM)</Label>
                  <Input
                    id="vss-salary"
                    type="number"
                    min="0"
                    step="0.01"
                    value={salary}
                    onChange={(e) => setSalary(e.target.value)}
                  />
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label>Salary basis</Label>
                  <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
                    Months × each employee's own base salary
                  </p>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="vss-lwd">Last working day</Label>
                <Input id="vss-lwd" type="date" value={lwd} onChange={(e) => setLwd(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="vss-terms">Package terms / benefits note (optional)</Label>
              <Textarea
                id="vss-terms"
                rows={2}
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                placeholder="e.g. 3 months' medical coverage extension, outplacement support…"
              />
            </div>

            {/* ── Payout + statutory final pay preview ── */}
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700">
                <HandCoins className="h-3.5 w-3.5" /> Payout preview
              </p>
              {single ? (
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">
                      VSS ex-gratia ({monthsNum || 0} mo × {fmtRM(salaryNum)})
                    </dt>
                    <dd className="font-semibold text-amber-800">{fmtRM(payout)}</dd>
                  </div>
                  {finalPayPreview && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Statutory final pay (est.)</dt>
                      <dd className="font-medium">{fmtRM(finalPayPreview.estimatedTotal)}</dd>
                    </div>
                  )}
                  {finalPayPreview && (
                    <div className="flex justify-between gap-4 border-t border-amber-200/70 pt-1.5">
                      <dt className="font-medium">Indicative total</dt>
                      <dd className="font-semibold text-amber-800">
                        {fmtRM(payout + finalPayPreview.estimatedTotal)}
                      </dd>
                    </div>
                  )}
                </dl>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Each employee's case stores {monthsNum || 0} month(s) × their own base salary;
                  the exact payout and statutory final-pay preview appear on their offboarding
                  case card.
                </p>
              )}
            </div>
          </div>
        )}
        {phase === 'running' && <ProgressLine done={progress.done} total={progress.total} />}
        {phase === 'done' && result && <ResultSummary result={result} verb="separated via VSS" />}

        <DialogFooter>
          {phase === 'form' && (
            <>
              <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
              <Button
                onClick={submit}
                disabled={separable.length === 0 || !lwd || monthsNum <= 0 || (single ? salaryNum <= 0 : false)}
                className="bg-amber-600 text-white hover:bg-amber-700"
              >
                <FileSignature className="mr-1.5 h-4 w-4" />
                Confirm VSS{targets.length > 1 ? ` (${separable.length})` : ''}
              </Button>
            </>
          )}
          {phase === 'done' && <Button onClick={() => close(false)}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Other separation ───────────────────────────────────────────────────── */

function OtherSeparationDialog({ targets, actorName, open, onOpenChange, onCompleted }: DialogProps) {
  const separable = useMemo(() => targets.filter((t) => t.status !== 'resigned'), [targets]);
  const [reason, setReason] = useState<OtherSeparationReason>('contract-end');
  const [noticeDate] = useState(today());
  const [lwd, setLwd] = useState(() =>
    targets.length > 0 ? suggestedLastWorkingDay(targets[0]!, today()) : '',
  );
  const [remarks, setRemarks] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<BulkSeparationResult | null>(null);

  async function submit() {
    setPhase('running');
    const spec: SeparationSpec = {
      kind: 'other',
      otherReason: reason,
      noticeDate,
      lastWorkingDay: lwd,
      remarks: remarks.trim() || undefined,
    };
    const r = await runChunked(
      targets,
      (slice) => bulkSeparate(slice, spec, actorName),
      (done, total) => setProgress({ done, total }),
    );
    setResult(r);
    setPhase('done');
  }

  function close(next: boolean) {
    if (!next && phase === 'done') onCompleted();
    if (!next) {
      setPhase('form');
      setResult(null);
      setRemarks('');
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Other separation {targets.length > 1 ? `(${targets.length} employees)` : targets[0]?.name}
          </DialogTitle>
          <DialogDescription>
            Contract end, retirement, termination or abscondment — each opens its own offboarding
            case and updates the employee status.
          </DialogDescription>
        </DialogHeader>

        {phase === 'form' && (
          <div className="grid gap-4 py-2">
            <TargetLine targets={targets} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="oth-reason">Reason</Label>
                <Select value={reason} onValueChange={(v) => setReason(v as OtherSeparationReason)}>
                  <SelectTrigger id="oth-reason"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(OTHER_SEPARATION_REASON_LABELS) as OtherSeparationReason[]).map((r) => (
                      <SelectItem key={r} value={r}>{OTHER_SEPARATION_REASON_LABELS[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="oth-lwd">Last working day</Label>
                <Input id="oth-lwd" type="date" value={lwd} onChange={(e) => setLwd(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="oth-remarks">Remarks (optional)</Label>
              <Textarea
                id="oth-remarks"
                rows={2}
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder={
                  reason === 'absconded'
                    ? 'Last seen date, contact attempts, show-cause letter reference…'
                    : 'Context for this separation…'
                }
              />
            </div>
            {reason === 'absconded' && (
              <p className="flex items-start gap-1.5 rounded-lg border border-orange-200 bg-orange-50/60 p-2.5 text-xs text-orange-900">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Absconded employees are flagged on the case — conduct the EA s.12(3) inquiry
                before treating the contract as terminated.
              </p>
            )}
          </div>
        )}
        {phase === 'running' && <ProgressLine done={progress.done} total={progress.total} />}
        {phase === 'done' && result && <ResultSummary result={result} verb="separated" />}

        <DialogFooter>
          {phase === 'form' && (
            <>
              <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
              <Button
                onClick={submit}
                disabled={separable.length === 0 || !lwd}
                className="bg-amber-600 text-white hover:bg-amber-700"
              >
                <DoorOpen className="mr-1.5 h-4 w-4" />
                Confirm separation{targets.length > 1 ? ` (${separable.length})` : ''}
              </Button>
            </>
          )}
          {phase === 'done' && <Button onClick={() => close(false)}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Delete (permanent) ─────────────────────────────────────────────────── */

function DeleteDialog({ targets, actorName, open, onOpenChange, onCompleted }: DialogProps) {
  const single = targets.length === 1 ? targets[0] : undefined;
  const [confirmText, setConfirmText] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<BulkDeleteResult | null>(null);

  /** Payslip guard evaluated up-front so blocked records are shown pre-confirm. */
  const blocked = useMemo(() => {
    const payslips = getCollection<Payslip>('payslips');
    return targets
      .map((t) => ({ target: t, reason: deleteBlockReason(payslips, t) }))
      .filter((x): x is { target: Employee; reason: string } => x.reason !== null);
  }, [targets]);
  const deletable = targets.filter((t) => !blocked.some((b) => b.target.id === t.id));

  const expected = single ? single.name : String(deletable.length);
  const confirmed = confirmText.trim() === expected && deletable.length > 0;

  async function submit() {
    setPhase('running');
    const r = await runChunked(
      deletable,
      (slice) => bulkDelete(slice, actorName),
      (done, total) => setProgress({ done, total }),
    );
    // Surface up-front blocked employees alongside runtime skips.
    r.skipped = [
      ...blocked.map((b) => ({ employeeId: b.target.id, name: b.target.name, reason: b.reason })),
      ...r.skipped,
    ];
    setResult(r);
    setPhase('done');
  }

  function close(next: boolean) {
    if (!next && phase === 'done') onCompleted();
    if (!next) {
      setPhase('form');
      setResult(null);
      setConfirmText('');
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-red-700">
            Permanently delete {single ? single.name : `${targets.length} employees`}?
          </DialogTitle>
          <DialogDescription>
            Removes the employee record together with their attendance, leave requests, claims,
            leave balances, KPIs and user account. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {phase === 'form' && (
          <div className="grid gap-4 py-2">
            {blocked.length > 0 && (
              <div className="space-y-1.5 rounded-xl border border-red-200 bg-red-50/60 p-3 text-xs text-red-900">
                <p className="flex items-start gap-1.5 font-medium">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {blocked.length === 1 ? 'This record' : `${blocked.length} record(s)`} cannot be
                  deleted — payslips exist and statutory payroll records must be retained 6–7
                  years (EPF Act 1991 / EA 1955). Resign the employee instead to preserve the
                  audit trail.
                </p>
                {blocked.map((b) => (
                  <p key={b.target.id} className="pl-5">· {b.target.name}</p>
                ))}
              </div>
            )}
            {deletable.length > 0 ? (
              <div className="grid gap-1.5">
                <Label htmlFor="del-confirm">
                  Type <span className="font-semibold text-foreground">{expected}</span> to confirm
                  {single ? '' : ` (${deletable.length} deletable record${deletable.length === 1 ? '' : 's'})`}
                </Label>
                <Input
                  id="del-confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={expected}
                  autoComplete="off"
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing to delete — every selected record is protected by the payslip retention
                guard. Use Resign instead.
              </p>
            )}
          </div>
        )}
        {phase === 'running' && <ProgressLine done={progress.done} total={progress.total} />}
        {phase === 'done' && result && <ResultSummary result={result} verb="deleted permanently" />}

        <DialogFooter>
          {phase === 'form' && (
            <>
              <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
              <Button
                onClick={submit}
                disabled={!confirmed}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                <Trash2 className="mr-1.5 h-4 w-4" />
                Delete permanently
              </Button>
            </>
          )}
          {phase === 'done' && <Button onClick={() => close(false)}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Menu ───────────────────────────────────────────────────────────────── */

export interface SeparationMenuProps {
  /** 1..n targets — single employee (row/detail) or the bulk selection. */
  targets: Employee[];
  actorName: string;
  /** Optional custom trigger; defaults to a ghost ⋯ icon button. */
  trigger?: React.ReactNode;
  /** Called after any dialog completes with changes (e.g. clear selection, navigate away). */
  onCompleted?: () => void;
  align?: 'start' | 'center' | 'end';
}

export function SeparationMenu({
  targets,
  actorName,
  trigger,
  onCompleted,
  align = 'end',
}: SeparationMenuProps) {
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const allResigned = targets.every((t) => t.status === 'resigned');
  const completed = () => onCompleted?.();

  const dialogProps = (kind: DialogKind): DialogProps => ({
    targets,
    actorName,
    open: dialog === kind,
    onOpenChange: (open) => !open && setDialog(null),
    onCompleted: completed,
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button variant="ghost" size="icon" aria-label="Separation actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-56">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {targets.length === 1 ? targets[0]!.name : `${targets.length} selected`}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={allResigned} onSelect={() => setDialog('resign')}>
            <UserMinus className="mr-2 h-4 w-4" /> Resign…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={allResigned} onSelect={() => setDialog('vss')}>
            <FileSignature className="mr-2 h-4 w-4" /> VSS…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={allResigned} onSelect={() => setDialog('other')}>
            <DoorOpen className="mr-2 h-4 w-4" /> Other separation…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-red-700 focus:text-red-800"
            onSelect={() => setDialog('delete')}
          >
            <Trash2 className="mr-2 h-4 w-4" /> Delete (permanent)…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ResignDialog {...dialogProps('resign')} />
      <VssDialog {...dialogProps('vss')} />
      <OtherSeparationDialog {...dialogProps('other')} />
      <DeleteDialog {...dialogProps('delete')} />
    </>
  );
}
