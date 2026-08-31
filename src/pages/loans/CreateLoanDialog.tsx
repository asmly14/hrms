/**
 * Create-loan dialog — employee picker, principal, repayment mode
 * (installment amount OR term in months, with live auto-calc of the other),
 * optional interest, first deduction month and reason. Validation errors
 * from lib/loans.createLoan surface inline.
 */
import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { annuityPayment, createLoan, type EmployeeLoan } from '@/lib/loans';
import { toastError, toastSuccess } from '@/lib/toast';
import { fmtRM, round2 } from '@/lib/utils';
import type { Employee } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[];
  actor: string;
  onCreated?: (loan: EmployeeLoan) => void;
}

function nextMonthNow(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function CreateLoanDialog({ open, onOpenChange, employees, actor, onCreated }: Props) {
  const [employeeId, setEmployeeId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [mode, setMode] = useState<'installment' | 'term'>('installment');
  const [installment, setInstallment] = useState('');
  const [termMonths, setTermMonths] = useState('');
  const [interestRate, setInterestRate] = useState('0');
  const [firstMonth, setFirstMonth] = useState(nextMonthNow());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const eligible = useMemo(
    () =>
      employees
        .filter((e) => e.status !== 'resigned')
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employees],
  );

  const principalNum = Number(principal) || 0;
  const rateNum = Number(interestRate) || 0;
  /** Live auto-calc of the mode's OTHER figure. */
  const derived = useMemo(() => {
    if (principalNum <= 0) return null;
    if (mode === 'term') {
      const n = Math.round(Number(termMonths));
      if (!Number.isFinite(n) || n < 1) return null;
      return round2(annuityPayment(principalNum, n, rateNum));
    }
    const inst = Number(installment);
    if (!Number.isFinite(inst) || inst <= 0) return null;
    if (rateNum > 0) return null; // interest-bearing terms derive at build time
    return Math.ceil(principalNum / inst);
  }, [principalNum, mode, termMonths, installment, rateNum]);

  function reset(): void {
    setEmployeeId('');
    setPrincipal('');
    setMode('installment');
    setInstallment('');
    setTermMonths('');
    setInterestRate('0');
    setFirstMonth(nextMonthNow());
    setReason('');
    setError(null);
  }

  function submit(): void {
    try {
      const loan = createLoan(
        {
          employeeId,
          principal: principalNum,
          ...(mode === 'installment'
            ? { installmentAmount: Number(installment) }
            : { termMonths: Math.round(Number(termMonths)) }),
          interestRate: rateNum,
          firstDeductionMonth: firstMonth,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
        actor,
      );
      toastSuccess(`Loan ${loan.refNo} created`, `${fmtRM(loan.principal)} · ${loan.termMonths}× ${fmtRM(loan.installmentAmount)} from ${loan.firstDeductionMonth}`);
      reset();
      onOpenChange(false);
      onCreated?.(loan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      toastError('Could not create loan', err);
    }
  }

  const valid =
    employeeId !== '' &&
    principalNum > 0 &&
    (mode === 'installment' ? Number(installment) > 0 : Math.round(Number(termMonths)) >= 1) &&
    /^\d{4}-\d{2}$/.test(firstMonth);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New employee loan</DialogTitle>
          <DialogDescription>
            The installment is deducted from the employee's net pay each month — never from EPF /
            SOCSO / EIS / PCB bases. Total deductions are capped at 50% of wages (EA 1955 s.24);
            any shortfall defers automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Employee</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
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

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="loan-principal">Principal (RM)</Label>
              <Input
                id="loan-principal"
                type="number"
                min="0"
                step="0.01"
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                placeholder="5000.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loan-interest">Interest (% p.a.)</Label>
              <Input
                id="loan-interest"
                type="number"
                min="0"
                step="0.01"
                value={interestRate}
                onChange={(e) => setInterestRate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Repayment</Label>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'installment' | 'term')} className="flex gap-4">
              <div className="flex items-center gap-2">
                <RadioGroupItem value="installment" id="mode-installment" />
                <Label htmlFor="mode-installment" className="font-normal">By installment</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="term" id="mode-term" />
                <Label htmlFor="mode-term" className="font-normal">By term (months)</Label>
              </div>
            </RadioGroup>
            <div className="grid grid-cols-2 gap-4 pt-1">
              {mode === 'installment' ? (
                <div className="space-y-2">
                  <Label htmlFor="loan-installment">Installment (RM / month)</Label>
                  <Input
                    id="loan-installment"
                    type="number"
                    min="0"
                    step="0.01"
                    value={installment}
                    onChange={(e) => setInstallment(e.target.value)}
                    placeholder="500.00"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="loan-term">Term (months)</Label>
                  <Input
                    id="loan-term"
                    type="number"
                    min="1"
                    step="1"
                    value={termMonths}
                    onChange={(e) => setTermMonths(e.target.value)}
                    placeholder="12"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="loan-first-month">First deduction month</Label>
                <Input
                  id="loan-first-month"
                  type="month"
                  value={firstMonth}
                  onChange={(e) => setFirstMonth(e.target.value)}
                />
              </div>
            </div>
            {derived !== null && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5" />
                {mode === 'term'
                  ? `Installment works out to ${fmtRM(derived)} per month (last month = remainder).`
                  : `Term works out to ${derived} months (last installment = remainder).`}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="loan-reason">Reason (optional)</Label>
            <Textarea
              id="loan-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Emergency family loan approved by management"
              rows={2}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!valid}>Create loan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
