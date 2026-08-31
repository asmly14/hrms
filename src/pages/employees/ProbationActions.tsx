/**
 * Probation actions shared by the tracker strip and the employee detail page:
 *  - ExtendProbationDialog — push the end date out (preset lengths or a custom
 *    date) with an optional reason; persists via ./probation and toasts.
 *  - ProbationTimeline — the append-only extend/confirm/terminate trail.
 *  - ProbationHistoryButton — compact popover wrapper around the timeline.
 */
import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { BadgeCheck, CalendarClock, History, Hourglass, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { fmtDate } from '@/lib/utils';
import type { Employee, ProbationHistoryEntry } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { addMonths, isoDate, probationEndDate } from './helpers';
import { extendProbation } from './probation';

const ACTION_LABEL: Record<ProbationHistoryEntry['action'], string> = {
  extended: 'Extended',
  confirmed: 'Confirmed',
  terminated: 'Terminated',
};

const ACTION_ICON: Record<ProbationHistoryEntry['action'], typeof Hourglass> = {
  extended: CalendarClock,
  confirmed: BadgeCheck,
  terminated: UserX,
};

/** Newest-first probation trail; empty state renders nothing. */
export function ProbationTimeline({ entries }: { entries: ProbationHistoryEntry[] }) {
  const sorted = [...entries].reverse();
  if (sorted.length === 0) {
    return <p className="text-xs text-muted-foreground">No probation actions recorded yet.</p>;
  }
  return (
    <ul className="space-y-2.5">
      {sorted.map((h, i) => {
        const Icon = ACTION_ICON[h.action];
        return (
          <li key={`${h.at}-${i}`} className="flex items-start gap-2.5 text-xs">
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {ACTION_LABEL[h.action]}: {fmtDate(h.fromEnd)} → {fmtDate(h.toEnd)}
              </p>
              {h.reason && <p className="text-muted-foreground">“{h.reason}”</p>}
              <p className="text-muted-foreground">
                by {h.by} · {fmtDate(h.at)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Compact popover listing the employee's probation history. */
export function ProbationHistoryButton({ employee }: { employee: Employee }) {
  const count = employee.probationHistory?.length ?? 0;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Probation history (${count})`}>
          <History className="h-3.5 w-3.5" />
          {count > 0 && <span className="ml-1 text-xs">{count}</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded-xl border border-border bg-popover p-3 shadow-md outline-none"
        >
          <p className="mb-2 text-xs font-semibold tracking-tight">
            Probation history — {employee.name}
          </p>
          <div className="max-h-56 overflow-y-auto">
            <ProbationTimeline entries={employee.probationHistory ?? []} />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type Length = '1' | '2' | '3' | '6' | 'custom';

export interface ExtendProbationDialogProps {
  employee: Employee;
  actorName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Extend probation: shows the current end date, offers +1/2/3/6 months from
 * it or a custom date, and an optional reason. Blocks non-forward dates.
 */
export function ExtendProbationDialog({
  employee,
  actorName,
  open,
  onOpenChange,
}: ExtendProbationDialogProps) {
  const [length, setLength] = useState<Length>('3');
  const [customDate, setCustomDate] = useState('');
  const [reason, setReason] = useState('');

  const currentEnd = probationEndDate(employee);
  const newEnd =
    length === 'custom' ? customDate : isoDate(addMonths(currentEnd, Number(length)));
  const valid = newEnd > currentEnd;

  function close(next: boolean) {
    if (!next) {
      setLength('3');
      setCustomDate('');
      setReason('');
    }
    onOpenChange(next);
  }

  function submit() {
    const next = extendProbation(employee, newEnd, actorName, reason);
    if (!next) {
      toast.error('Could not extend probation — pick a date after the current end date');
      return;
    }
    toast.success(`${employee.name}'s probation extended to ${fmtDate(newEnd)}`);
    close(false);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Extend probation — {employee.name}</DialogTitle>
          <DialogDescription>
            Current end date is <strong>{fmtDate(currentEnd)}</strong>. The extension and its
            reason are recorded on the employee's probation history.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label>Extension length</Label>
            <RadioGroup
              value={length}
              onValueChange={(v) => setLength(v as Length)}
              className="flex flex-wrap gap-3"
            >
              {(['1', '2', '3', '6', 'custom'] as const).map((opt) => (
                <div key={opt} className="flex items-center gap-1.5">
                  <RadioGroupItem value={opt} id={`ext-${opt}`} />
                  <Label htmlFor={`ext-${opt}`} className="font-normal">
                    {opt === 'custom' ? 'Custom date' : `+${opt} month${opt === '1' ? '' : 's'}`}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          {length === 'custom' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ext-custom">New end date</Label>
              <Input
                id="ext-custom"
                type="date"
                value={customDate}
                min={currentEnd}
                onChange={(e) => setCustomDate(e.target.value)}
              />
            </div>
          ) : (
            <p className="flex items-center gap-1.5 rounded-lg bg-stone-50 px-3 py-2 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              New end date: <span className="font-medium text-foreground">{fmtDate(newEnd)}</span>
            </p>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="ext-reason">Reason (optional)</Label>
            <Textarea
              id="ext-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Performance review pending, extended training period…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!valid}
            className="bg-amber-600 text-white hover:bg-amber-700"
          >
            <Hourglass className="mr-1.5 h-4 w-4" />
            Extend probation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
