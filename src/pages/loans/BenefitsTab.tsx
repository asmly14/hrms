/**
 * Benefits tab of /loans — recurring-benefit CRUD per employee.
 * Admin/HR manage the full list; other roles see their own benefits
 * read-only. Presets carry the statutory-treatment advice (reimbursement vs
 * non-cash BIK vs taxable allowance); annual benefits pick their injection
 * month. Ending a benefit stops future payroll injections without touching
 * history.
 */
import { useMemo, useState } from 'react';
import { HeartPulse, Info, Pencil, Plus, Square } from 'lucide-react';
import {
  BENEFIT_PRESETS, BENEFIT_TREATMENT_LABELS, benefitPreset, createBenefit, endBenefit,
  updateBenefit, type BenefitInput, type RecurringBenefit,
} from '@/lib/benefits';
import { useCollection } from '@/lib/db';
import { toastError, toastSuccess } from '@/lib/toast';
import { fmtRM, monthKey } from '@/lib/utils';
import { useAuthSafe } from '@/lib/useAuthSafe';
import type { BenefitTreatment, Employee } from '@/lib/types';
import { monthLabel } from '@/pages/payroll/helpers';
import { Money } from '@/pages/payroll/components';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const STATUS_VARIANTS: Record<RecurringBenefit['status'], 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  ended: 'secondary',
  cancelled: 'outline',
};

interface Props {
  isHR: boolean;
  ownEmployeeId: string | null;
  employees: Employee[];
}

export default function BenefitsTab({ isHR, ownEmployeeId, employees }: Props) {
  const auth = useAuthSafe();
  const actor = auth?.user?.username ?? 'HR';
  const { items: benefits } = useCollection<RecurringBenefit>('benefits');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringBenefit | null>(null);

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const visible = useMemo(
    () =>
      (isHR ? benefits : benefits.filter((b) => b.employeeId === ownEmployeeId))
        .slice()
        .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt)),
    [benefits, isHR, ownEmployeeId],
  );

  return (
    <Card className="rounded-xl">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          {isHR ? 'Recurring benefits' : 'My benefits'}
        </CardTitle>
        {isHR && (
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> New benefit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50">
              <HeartPulse className="h-6 w-6" />
            </span>
            <p className="font-medium">{isHR ? 'No recurring benefits yet' : 'No benefits'}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {isHR
                ? 'Recurring benefits (e.g. Personal Health Insurance reimbursement) inject into payroll automatically each run.'
                : 'Recurring benefits granted by the company will appear here.'}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {isHR && <TableHead>Employee</TableHead>}
                <TableHead>Benefit</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Treatment</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Status</TableHead>
                {isHR && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((b) => (
                <TableRow key={b.id}>
                  {isHR && <TableCell>{empById.get(b.employeeId)?.name ?? b.employeeId}</TableCell>}
                  <TableCell className="font-medium">
                    {b.name}
                    {b.notes && <span className="block text-xs font-normal text-muted-foreground">{b.notes}</span>}
                  </TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(b.amount)}</Money></TableCell>
                  <TableCell>
                    {b.frequency === 'monthly' ? 'Monthly' : `Annual — ${MONTH_NAMES[(b.annualMonth ?? 1) - 1]}`}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs">{BENEFIT_TREATMENT_LABELS[b.treatment]}</span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {monthLabel(b.startMonth)} → {b.endMonth ? monthLabel(b.endMonth) : 'open'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[b.status]}>{b.status}</Badge>
                  </TableCell>
                  {isHR && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost" size="icon" aria-label={`Edit ${b.name}`}
                          onClick={() => {
                            setEditing(b);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {b.status === 'active' && (
                          <Button
                            variant="ghost" size="icon" aria-label={`End ${b.name}`}
                            onClick={() => {
                              endBenefit(b.id, actor, monthKey());
                              toastSuccess(`${b.name} ended`, 'It will not inject into future payroll runs.');
                            }}
                          >
                            <Square className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {isHR && (
        <BenefitFormDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          employees={employees}
          editing={editing}
          actor={actor}
        />
      )}
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────
 * Create / edit dialog
 * ──────────────────────────────────────────────────────────── */

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[];
  editing: RecurringBenefit | null;
  actor: string;
}

function BenefitFormDialog({ open, onOpenChange, employees, editing, actor }: DialogProps) {
  const [employeeId, setEmployeeId] = useState('');
  const [benefitKey, setBenefitKey] = useState('health-insurance');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<'monthly' | 'annual'>('monthly');
  const [annualMonth, setAnnualMonth] = useState('1');
  const [treatment, setTreatment] = useState<BenefitTreatment>('nonStatutory-reimbursement');
  const [startMonth, setStartMonth] = useState(monthKey());
  const [endMonth, setEndMonth] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const preset = benefitPreset(benefitKey);

  function resetFrom(b: RecurringBenefit | null): void {
    setEmployeeId(b?.employeeId ?? '');
    setBenefitKey(b?.benefitKey ?? 'health-insurance');
    setName(b?.name ?? '');
    setAmount(b ? String(b.amount) : '');
    setFrequency(b?.frequency ?? 'monthly');
    setAnnualMonth(String(b?.annualMonth ?? 1));
    setTreatment(b?.treatment ?? benefitPreset('health-insurance')!.treatment);
    setStartMonth(b?.startMonth ?? monthKey());
    setEndMonth(b?.endMonth ?? '');
    setNotes(b?.notes ?? '');
    setError(null);
  }

  function pickPreset(key: string): void {
    setBenefitKey(key);
    const p = benefitPreset(key);
    if (p) {
      setTreatment(p.treatment);
      if (!name || BENEFIT_PRESETS.some((x) => x.label === name)) setName('');
    }
  }

  function submit(): void {
    try {
      const input: BenefitInput = {
        employeeId,
        benefitKey,
        ...(name.trim() ? { name: name.trim() } : {}),
        amount: Number(amount),
        frequency,
        ...(frequency === 'annual' ? { annualMonth: Number(annualMonth) } : {}),
        treatment,
        startMonth,
        ...(endMonth ? { endMonth } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      if (editing) {
        updateBenefit(editing.id, input, actor);
        toastSuccess('Benefit updated');
      } else {
        createBenefit(input, actor);
        toastSuccess('Benefit created', 'It will inject into payroll runs automatically.');
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      toastError('Could not save benefit', err);
    }
  }

  const eligible = employees
    .filter((e) => e.status !== 'resigned')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const valid =
    employeeId !== '' &&
    Number(amount) > 0 &&
    /^\d{4}-\d{2}$/.test(startMonth) &&
    (endMonth === '' || /^\d{4}-\d{2}$/.test(endMonth));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) resetFrom(editing);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit benefit' : 'New recurring benefit'}</DialogTitle>
          <DialogDescription>
            Injected into every payroll run automatically (annual benefits only in their month).
            Draft payslips can skip a benefit for one run without deleting it here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Employee</Label>
              <Select value={employeeId} onValueChange={setEmployeeId} disabled={editing !== null}>
                <SelectTrigger><SelectValue placeholder="Pick an employee…" /></SelectTrigger>
                <SelectContent>
                  {eligible.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}{e.employeeNo ? ` (${e.employeeNo})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Preset</Label>
              <Select value={benefitKey} onValueChange={pickPreset}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BENEFIT_PRESETS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bf-name">Name</Label>
              <Input
                id="bf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={preset?.label ?? 'Custom benefit'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bf-amount">Amount (RM)</Label>
              <Input
                id="bf-amount" type="number" min="0" step="0.01"
                value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="150.00"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Frequency</Label>
            <RadioGroup
              value={frequency}
              onValueChange={(v) => setFrequency(v as 'monthly' | 'annual')}
              className="flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="monthly" id="bf-monthly" />
                <Label htmlFor="bf-monthly" className="font-normal">Monthly</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="annual" id="bf-annual" />
                <Label htmlFor="bf-annual" className="font-normal">Annual</Label>
              </div>
            </RadioGroup>
            {frequency === 'annual' && (
              <div className="pt-1">
                <Label htmlFor="bf-annual-month">Inject in month</Label>
                <Select value={annualMonth} onValueChange={setAnnualMonth}>
                  <SelectTrigger id="bf-annual-month" className="mt-1 w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Statutory treatment</Label>
            <Select value={treatment} onValueChange={(v) => setTreatment(v as BenefitTreatment)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(BENEFIT_TREATMENT_LABELS) as BenefitTreatment[]).map((t) => (
                  <SelectItem key={t} value={t}>{BENEFIT_TREATMENT_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {preset && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{preset.advice}</span>
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bf-start">Start month</Label>
              <Input id="bf-start" type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bf-end">End month (optional)</Label>
              <Input id="bf-end" type="month" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bf-notes">Notes (optional)</Label>
            <Textarea id="bf-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!valid}>{editing ? 'Save changes' : 'Create benefit'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
