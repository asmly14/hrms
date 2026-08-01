/**
 * Salary history tab — compensation timeline (newest first) plus the
 * "Record change" dialog: previous salary auto-fills from the live
 * Employee.baseSalary, the % change is derived, and HR can optionally push
 * the new figure straight onto the employee record (payroll driver).
 */
import { useState } from 'react';
import { ArrowRight, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import {
  SALARY_CHANGE_REASON_LABELS,
  recordSalaryChange,
  salaryChangePercent,
  todayISO,
  type SalaryChangeReason,
} from '@/lib/employeeRecords';
import { cn, fmtDate, fmtRM } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { EmptyBlock, Field, SectionCard, type TabProps } from './shared';

export default function SalaryHistoryTab({ employee, file, readOnly, actorName }: TabProps) {
  const [open, setOpen] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [newSalary, setNewSalary] = useState('');
  const [reason, setReason] = useState<SalaryChangeReason>('annual-increment');
  const [approvedBy, setApprovedBy] = useState('');
  const [note, setNote] = useState('');
  const [applyToBase, setApplyToBase] = useState(true);

  const history = [...(file?.salaryHistory ?? [])].sort((a, b) =>
    b.effectiveDate.localeCompare(a.effectiveDate),
  );

  const parsed = Number(newSalary);
  const validNew = Number.isFinite(parsed) && parsed > 0;
  const pct = validNew ? salaryChangePercent(employee.baseSalary, parsed) : null;

  const reset = () => {
    setEffectiveDate(todayISO());
    setNewSalary('');
    setReason('annual-increment');
    setApprovedBy('');
    setNote('');
    setApplyToBase(true);
  };

  const submit = () => {
    if (!validNew || !effectiveDate) return;
    recordSalaryChange(
      employee,
      {
        effectiveDate,
        newSalary: parsed,
        reason,
        approvedBy,
        note,
        applyToBaseSalary: applyToBase,
      },
      actorName,
    );
    setOpen(false);
    reset();
  };

  if (history.length === 0 && readOnly) {
    return (
      <EmptyBlock
        icon={Wallet}
        title="No salary history"
        description="Increments, promotions and adjustments will appear here once HR records them."
      />
    );
  }

  return (
    <SectionCard
      title="Salary history"
      icon={Wallet}
      description={`Current base: ${fmtRM(employee.baseSalary)} / month`}
      actions={
        !readOnly && (
          <Button
            size="sm"
            className="bg-amber-600 text-white hover:bg-amber-700"
            onClick={() => {
              reset();
              setOpen(true);
            }}
          >
            Record change
          </Button>
        )
      }
    >
      {history.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No changes recorded yet — the first increment or promotion starts the timeline.
        </p>
      ) : (
        <ol className="relative space-y-4 border-l border-border/70 pl-5">
          {history.map((h) => {
            const up = h.changePercent > 0;
            const flat = h.changePercent === 0;
            return (
              <li key={h.id} className="relative">
                <span
                  className={cn(
                    'absolute -left-[27px] top-1 h-2.5 w-2.5 rounded-full',
                    flat ? 'bg-stone-300' : up ? 'bg-lime-500' : 'bg-red-500',
                  )}
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="text-sm font-medium">
                    {fmtRM(h.previousSalary)}
                    <ArrowRight className="mx-1 inline h-3.5 w-3.5 text-muted-foreground" />
                    {fmtRM(h.newSalary)}
                  </p>
                  <Badge
                    variant="outline"
                    className={cn(
                      'border-transparent',
                      flat
                        ? 'bg-stone-100 text-stone-600'
                        : up
                          ? 'bg-lime-100 text-lime-800'
                          : 'bg-red-100 text-red-800',
                    )}
                  >
                    {!flat &&
                      (up ? (
                        <TrendingUp className="mr-1 h-3.5 w-3.5" />
                      ) : (
                        <TrendingDown className="mr-1 h-3.5 w-3.5" />
                      ))}
                    {up ? '+' : ''}
                    {h.changePercent}%
                  </Badge>
                  <Badge variant="outline" className="border-transparent bg-stone-100 text-stone-700">
                    {SALARY_CHANGE_REASON_LABELS[h.reason]}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Effective {fmtDate(h.effectiveDate)}
                  {h.approvedBy ? ` · approved by ${h.approvedBy}` : ''}
                  {h.note ? ` · ${h.note}` : ''}
                </p>
              </li>
            );
          })}
        </ol>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record salary change</DialogTitle>
            <DialogDescription>
              Previous salary auto-fills from the current base ({fmtRM(employee.baseSalary)}); the %
              change is calculated for you.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Effective date *">
              <Input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </Field>
            <Field label={`New base salary (RM) — current ${fmtRM(employee.baseSalary)}`}>
              <Input
                inputMode="decimal"
                placeholder="5500"
                value={newSalary}
                onChange={(e) => setNewSalary(e.target.value)}
              />
            </Field>
            <Field label="Reason">
              <Select value={reason} onValueChange={(v) => setReason(v as SalaryChangeReason)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SALARY_CHANGE_REASON_LABELS) as SalaryChangeReason[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {SALARY_CHANGE_REASON_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Approved by">
              <Input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} />
            </Field>
            <Field label="Note" className="sm:col-span-2">
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>

          {pct !== null && (
            <p
              className={cn(
                'rounded-lg p-3 text-sm font-medium',
                pct > 0
                  ? 'bg-lime-50 text-lime-800'
                  : pct < 0
                    ? 'bg-red-50 text-red-800'
                    : 'bg-stone-50 text-stone-600',
              )}
            >
              {fmtRM(employee.baseSalary)} → {fmtRM(parsed)} ({pct > 0 ? '+' : ''}
              {pct}%)
            </p>
          )}

          <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
            <span>
              Update base salary on the employee record
              <span className="block text-xs text-muted-foreground">
                Applies the new figure to payroll from this record.
              </span>
            </span>
            <Switch checked={applyToBase} onCheckedChange={setApplyToBase} />
          </label>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={!validNew || !effectiveDate}
              onClick={submit}
            >
              Save change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
