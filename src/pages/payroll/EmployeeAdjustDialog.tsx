/**
 * Kakitangan-style per-employee payslip editor for DRAFT payroll runs.
 *
 * Lets HR step through one employee before finalize:
 *  - live Basic / Gross / Deductions / Net / Employer-contribution panel
 *  - ad-hoc additional earnings & deduction lines (presets: CP38, Zakat,
 *    PTPTN, custom) stored on the payslip
 *  - 'Reset employee' — recompute from defaults, dropping all adjustments
 *  - 'Exclude from run' — remove the employee from this draft run
 *
 * All edits go through payrollEngine, which recomputes statutory figures on
 * the adjusted wages and retallies the run. Draft runs only — the parent
 * page never opens this for finalized runs.
 */
import { useEffect, useMemo, useState } from 'react';
import { CircleMinus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  adjustmentLabel, excludeEmployeeFromRun, resetPayslipToDefaults, setPayslipAdjustments,
} from '@/lib/payrollEngine';
import { uid } from '@/lib/db';
import { PRORATION_LABELS } from '@/lib/workdays';
import { fmtRM, round2 } from '@/lib/utils';
import type { AdjustmentPreset, Employee, Payslip, PayslipAdjustment } from '@/lib/types';
import { Money } from './components';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  /** The CURRENT stored payslip for this employee in the draft run. */
  payslip: Payslip | undefined;
  employee: Employee | undefined;
  actor: string;
  /** Called after every successful engine edit so the page can react. */
  onChanged: () => void;
  /** Called when the employee is excluded from the run (dialog closes). */
  onExcluded: () => void;
}

const DEDUCTION_PRESETS: { value: AdjustmentPreset; label: string; hint: string }[] = [
  { value: 'cp38', label: 'CP38', hint: 'Additional LHDN tax deduction order' },
  { value: 'zakat', label: 'Zakat', hint: 'Tithes deducted from net pay' },
  { value: 'ptptn', label: 'PTPTN', hint: 'Study-loan repayment' },
  { value: 'custom', label: 'Custom deduction', hint: 'Any other deduction' },
];

const EARNING_PRESETS: { value: AdjustmentPreset; label: string; hint: string }[] = [
  { value: 'custom', label: 'Custom earning', hint: 'e.g. commission, arrears, incentive' },
];

export default function EmployeeAdjustDialog({
  open, onOpenChange, runId, payslip, employee, actor, onChanged, onExcluded,
}: Props) {
  const [adjustments, setAdjustments] = useState<PayslipAdjustment[]>([]);
  const [kind, setKind] = useState<'deduction' | 'earning'>('deduction');
  const [preset, setPreset] = useState<AdjustmentPreset>('cp38');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');

  // Sync the editor with the stored payslip whenever it changes (e.g. after
  // an engine recompute) or when the dialog opens for another employee.
  useEffect(() => {
    setAdjustments(payslip?.adjustments ?? []);
  }, [payslip?.id, payslip?.adjustments, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const presets = kind === 'deduction' ? DEDUCTION_PRESETS : EARNING_PRESETS;

  useEffect(() => {
    setPreset(kind === 'deduction' ? 'cp38' : 'custom');
  }, [kind]);

  // Live panel: mirror the engine's math on the EDITED adjustment list so the
  // figures move before saving. Statutory employee deductions stay as stored
  // (the engine recomputes them on save; earning adjustments shift them only
  // through PCB's additional-remuneration delta, which is approximated here).
  const live = useMemo(() => {
    if (!payslip) return null;
    const earn = round2(adjustments.filter((a) => a.kind === 'earning').reduce((s, a) => s + a.amount, 0));
    const ded = round2(adjustments.filter((a) => a.kind === 'deduction').reduce((s, a) => s + a.amount, 0));
    const baseGross = round2(payslip.grossPay - (payslip.adjustmentEarnings ?? 0));
    const baseNet = round2(
      payslip.netPay - (payslip.adjustmentEarnings ?? 0) + (payslip.adjustmentDeductions ?? 0),
    );
    const gross = round2(baseGross + earn);
    const deductions = round2(
      payslip.epfEmployee + payslip.socsoEmployee + payslip.eisEmployee + payslip.pcb +
      payslip.unpaidLeaveDeduction + ded,
    );
    const employer = round2(
      payslip.epfEmployer + payslip.socsoEmployer + payslip.eisEmployer + payslip.hrdLevy,
    );
    return {
      basic: payslip.basicPay,
      gross,
      deductions,
      net: round2(baseNet + earn - ded),
      employer,
      dirty:
        earn !== (payslip.adjustmentEarnings ?? 0) || ded !== (payslip.adjustmentDeductions ?? 0),
    };
  }, [payslip, adjustments]);

  if (!payslip || !employee) return null;

  const addLine = () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const text = label.trim() || presets.find((p) => p.value === preset)?.label || 'Adjustment';
    setAdjustments((cur) => [...cur, { id: uid(), kind, preset, label: text, amount: round2(amt) }]);
    setLabel('');
    setAmount('');
  };

  const save = () => {
    const next = setPayslipAdjustments(runId, employee.id, adjustments, actor);
    if (next) onChanged();
  };

  const reset = () => {
    const next = resetPayslipToDefaults(runId, employee.id, actor);
    if (next) onChanged();
  };

  const exclude = () => {
    if (excludeEmployeeFromRun(runId, employee.id, actor)) {
      onChanged();
      onExcluded();
    }
  };

  const factor = payslip.prorationFactor ?? 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Adjust — {employee.name}</DialogTitle>
          <DialogDescription>
            {payslip.monthKey} draft payslip · ad-hoc lines recompute statutory figures on save.
          </DialogDescription>
        </DialogHeader>

        {/* Live Basic / Gross / Deductions / Net / Employer panel */}
        {live && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <PanelStat label="Basic" value={fmtRM(live.basic)} />
            <PanelStat label="Gross" value={fmtRM(live.gross)} />
            <PanelStat label="Deductions" value={fmtRM(live.deductions)} />
            <PanelStat label="Net pay" value={fmtRM(live.net)} highlight />
            <PanelStat label="Employer contrib." value={fmtRM(live.employer)} />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Days worked: {payslip.daysWorked ?? '—'} / {payslip.daysInBasis ?? '—'} (
          {PRORATION_LABELS[payslip.prorationMethod ?? 'calendar']})
          {factor < 1 && (
            <Badge variant="secondary" className="ml-2">
              prorated ×{round2(factor * 100) / 100}
            </Badge>
          )}
        </p>

        <Separator />

        {/* Current adjustment lines */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Additional payments &amp; deductions</p>
          {adjustments.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None yet — add CP38, Zakat, PTPTN or a custom line below.
            </p>
          ) : (
            <ul className="space-y-1">
              {adjustments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {adjustmentLabel(a)}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {a.kind === 'earning' ? 'earning' : 'deduction'}
                    </span>
                  </span>
                  <Money className={a.kind === 'deduction' ? 'text-red-600 dark:text-red-400' : ''}>
                    {a.kind === 'deduction' ? '−' : ''}
                    {fmtRM(a.amount)}
                  </Money>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Remove line"
                    onClick={() => setAdjustments((cur) => cur.filter((x) => x.id !== a.id))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Add-line form */}
        <div className="space-y-3 rounded-xl border p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as 'deduction' | 'earning')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="deduction">Deduction</SelectItem>
                  <SelectItem value="earning">Additional earning</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Preset</Label>
              <Select value={preset} onValueChange={(v) => setPreset(v as AdjustmentPreset)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {presets.find((p) => p.value === preset)?.hint}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_120px_auto] items-end gap-2">
            <div className="space-y-1">
              <Label>Label</Label>
              <Input
                placeholder={preset === 'custom' ? 'e.g. Sales commission' : 'Optional note'}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Amount (RM)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={addLine} disabled={!Number(amount) || Number(amount) <= 0}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" onClick={reset} title="Recompute from defaults — drops all adjustments">
            <RotateCcw className="h-4 w-4" /> Reset employee
          </Button>
          <Button
            variant="ghost"
            className="text-red-600 hover:text-red-600 dark:text-red-400"
            onClick={exclude}
            title="Remove this employee from the draft run"
          >
            <CircleMinus className="h-4 w-4" /> Exclude from run
          </Button>
          <span className="flex-1" />
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={save} disabled={!live?.dirty}>Save adjustments</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PanelStat({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border p-2.5 ${highlight ? 'border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30' : ''}`}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
