/**
 * Submit / edit claim form (dialog). Covers all eight UI categories, a guided
 * km × rate mileage calculator, soft per-claim policy-limit warnings, and a
 * receipt upload placeholder (file label only — no binary is stored).
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calculator, Paperclip, Receipt, X } from 'lucide-react';
import type { Employee } from '@/lib/types';
import { logAudit, useCollection } from '@/lib/db';
import { fmtRM, round2 } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  CATEGORIES, categoryMetaOf, policyWarnings,
  type ClaimPolicy, type ClaimRecord, type UiCategory,
} from './claimPolicy';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Claimant — the employee the page is acting as. */
  employee: Employee;
  claims: ClaimRecord[];
  policy: ClaimPolicy;
  /** When set, the dialog edits this draft instead of creating a new claim. */
  editing?: ClaimRecord | null;
}

export default function ClaimFormDialog({ open, onOpenChange, employee, claims, policy, editing }: Props) {
  const { add, update } = useCollection<ClaimRecord>('claims');

  const [category, setCategory] = useState<UiCategory>('travel');
  const [claimDate, setClaimDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [kmStr, setKmStr] = useState('');
  const [rateStr, setRateStr] = useState(String(policy.mileageRatePerKm));
  const [receiptName, setReceiptName] = useState<string | undefined>(undefined);
  // Remount key for the uncontrolled file input so "remove receipt" also resets it.
  const [receiptKey, setReceiptKey] = useState(0);
  const [touched, setTouched] = useState(false);

  // Reset (or hydrate, when editing a draft) every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTouched(false);
    if (editing) {
      setCategory(categoryMetaOf(editing).id);
      setClaimDate(editing.claimDate);
      setDescription(editing.title);
      setAmountStr(String(editing.amount));
      setKmStr(editing.mileageKm != null ? String(editing.mileageKm) : '');
      setRateStr(editing.mileageRate != null ? String(editing.mileageRate) : String(policy.mileageRatePerKm));
      setReceiptName(editing.receiptName);
    } else {
      setCategory('travel');
      setClaimDate(todayIso());
      setDescription('');
      setAmountStr('');
      setKmStr('');
      setRateStr(String(policy.mileageRatePerKm));
      setReceiptName(undefined);
    }
  }, [open, editing, policy.mileageRatePerKm]);

  const isMileage = category === 'mileage';
  const meta = CATEGORIES.find((c) => c.id === category)!;

  const km = Number.parseFloat(kmStr);
  const rate = Number.parseFloat(rateStr);
  const mileageAmount = Number.isFinite(km) && Number.isFinite(rate) && km > 0 && rate > 0
    ? round2(km * rate)
    : 0;
  const amount = isMileage ? mileageAmount : round2(Number.parseFloat(amountStr) || 0);

  const warnings = useMemo(
    () =>
      policyWarnings(
        {
          employeeId: employee.id,
          category: meta.claimCategory,
          amount,
          claimDate,
          mileageRate: isMileage && Number.isFinite(rate) ? round2(rate) : undefined,
        },
        claims,
        policy,
        editing?.id,
      ),
    [employee.id, meta.claimCategory, amount, claimDate, isMileage, rate, claims, policy, editing?.id],
  );

  const errors: string[] = [];
  if (!claimDate) errors.push('Pick the expense date.');
  if (description.trim().length < 3) errors.push('Add a short description (min 3 characters).');
  if (isMileage) {
    if (!(km > 0)) errors.push('Enter the distance travelled in km.');
    if (!(rate > 0)) errors.push('Enter a mileage rate above RM 0/km.');
    // B6: km × rate can round down to RM 0.00 (e.g. 0.01 km × RM 0.01) — block it.
    if (km > 0 && rate > 0 && !(mileageAmount > 0)) {
      errors.push('Mileage amount rounds to RM 0.00 — check the distance and rate.');
    }
  } else if (!(amount > 0)) {
    errors.push('Enter an amount above RM 0.');
  }
  const valid = errors.length === 0;

  function persist(status: 'draft' | 'submitted') {
    if (!valid) {
      setTouched(true);
      return;
    }
    const base = {
      employeeId: employee.id,
      category: meta.claimCategory,
      title: description.trim(),
      amount,
      claimDate,
      receiptName,
      ...(isMileage ? { mileageKm: round2(km), mileageRate: round2(rate) } : {}),
    };
    if (editing) {
      update(editing.id, {
        ...base,
        status,
        ...(status === 'submitted' ? { submittedAt: new Date().toISOString() } : {}),
        // Any save transitions to draft/submitted — stale decision data must not survive (B8).
        decidedBy: undefined,
        decidedAt: undefined,
        decisionRemarks: undefined,
      });
      logAudit({
        actorId: employee.id,
        actorName: employee.name,
        action: status === 'submitted' ? 'claim.submit' : 'claim.update',
        entity: 'claims',
        entityId: editing.id,
        detail: `${meta.label} — ${fmtRM(amount)} (${base.title.slice(0, 60)})`,
      });
    } else {
      const saved = add({
        ...base,
        status,
        ...(status === 'submitted' ? { submittedAt: new Date().toISOString() } : {}),
      });
      logAudit({
        actorId: employee.id,
        actorName: employee.name,
        action: status === 'submitted' ? 'claim.submit' : 'claim.draft',
        entity: 'claims',
        entityId: saved.id,
        detail: `${meta.label} — ${fmtRM(amount)} (${base.title.slice(0, 60)})`,
      });
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-amber-600" />
            {editing ? 'Edit draft claim' : 'New claim'}
          </DialogTitle>
          <DialogDescription>
            Claiming as <span className="font-medium text-foreground">{employee.name}</span>. Approved
            claims are reimbursed in the next payroll run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="claim-category">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as UiCategory)}>
                <SelectTrigger id="claim-category" className="w-full">
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="claim-date">Expense date</Label>
              <Input
                id="claim-date"
                type="date"
                value={claimDate}
                max={todayIso()}
                onChange={(e) => setClaimDate(e.target.value)}
              />
            </div>
          </div>

          {isMileage ? (
            <div className="space-y-3 rounded-xl border border-dashed bg-muted/40 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Calculator className="h-3.5 w-3.5" /> Mileage calculator — distance × rate
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="claim-km">Distance (km)</Label>
                  <Input
                    id="claim-km"
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="e.g. 120"
                    value={kmStr}
                    onChange={(e) => setKmStr(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="claim-rate">Rate (RM/km)</Label>
                  <Input
                    id="claim-rate"
                    type="number"
                    min="0"
                    step="0.01"
                    value={rateStr}
                    onChange={(e) => setRateStr(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-sm">
                Claim amount:{' '}
                <span className="font-semibold tabular-nums">{fmtRM(mileageAmount)}</span>
                {Number.isFinite(km) && km > 0 && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({kmStr} km × {fmtRM(Number.isFinite(rate) ? rate : 0)}/km)
                  </span>
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="claim-amount">Amount (RM)</Label>
              <Input
                id="claim-amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="claim-desc">Description</Label>
            <Textarea
              id="claim-desc"
              rows={3}
              placeholder={
                isMileage
                  ? 'e.g. Site visit to Kuantan — return trip'
                  : 'e.g. Team lunch with distributor'
              }
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="claim-receipt">Receipt (placeholder — label stored only)</Label>
            <Input
              key={receiptKey}
              id="claim-receipt"
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => setReceiptName(e.target.files?.[0]?.name)}
            />
            {receiptName && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{receiptName}</span>
                <button
                  type="button"
                  onClick={() => {
                    setReceiptName(undefined);
                    setReceiptKey((k) => k + 1); // reset the uncontrolled file input too
                  }}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40"
                  aria-label="Remove receipt"
                >
                  <X className="h-3 w-3" /> Remove
                </button>
              </p>
            )}
          </div>

          {warnings.length > 0 && (
            <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Policy limit warning</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs opacity-80">
                  You can still submit — the approver will see these flags.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {touched && !valid && (
            <Alert className="border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Please fix before saving</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => persist('draft')}>
            Save as draft
          </Button>
          <Button onClick={() => persist('submitted')}>
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
