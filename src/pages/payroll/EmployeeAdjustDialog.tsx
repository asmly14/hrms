/**
 * Kakitangan-style per-employee payslip editor for DRAFT payroll runs —
 * 4-column layout mirroring the Kakitangan monthly payroll calculator:
 *
 *  1. Basic earnings — salary type (Monthly/Daily/Hourly), rate, 'Worked'
 *     quantity, 'Full amount' override, include-in-payroll toggle.
 *  2. Additional earnings — pay-items catalog presets (lib/payItems.ts) with
 *     per-line EPF/SOCSO/EIS/PCB tag chips, statutory advice tooltips and
 *     one-click 'apply recommended'; custom lines supported.
 *  3. Deductions — statutory lines (EPF/SOCSO/EIS/PCB) with per-item opt-out
 *     checkboxes, amber compliance warnings and stored reasons, plus the
 *     existing CP38 / Zakat / PTPTN / custom deduction lines.
 *  4. Pay amount — live panel recomputed through payrollEngine.previewPayslip
 *     on every edit; NOTHING persists until 'Save adjustments'.
 *
 * All edits go through payrollEngine (updateDraftPayslip), which recomputes
 * statutory figures on the edited wages and retallies the run. Draft runs
 * only — the parent page never opens this for finalized runs.
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle, CircleMinus, Info, Plus, RotateCcw, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  adjustmentLabel, excludeEmployeeFromRun, previewPayslip, resetPayslipToDefaults,
  updateDraftPayslip,
} from '@/lib/payrollEngine';
import {
  applyRecommendedTags, newEarningFromPreset, payItemPreset, tagAdvice,
  PAY_ITEM_PRESETS,
} from '@/lib/payItems';
import { BENEFIT_TREATMENT_LABELS, benefitsForMonth } from '@/lib/benefits';
import { LEGACY_EARNING_TAGS } from '@/lib/statutory';
import { uid } from '@/lib/db';
import { cn, fmtRM, round2 } from '@/lib/utils';
import type {
  AdjustmentPreset, Employee, Payslip, PayslipAdjustment, PayslipEditInput,
  SalaryType, StatutoryOptOutKey, WageBaseTags,
} from '@/lib/types';
import { Money } from './components';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

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

// ─────────────────────────────────────────────────────────────────────────────
// Editor state
// ─────────────────────────────────────────────────────────────────────────────

interface BasicEditState {
  salaryType: SalaryType;
  /** true once the user explicitly picks a type (or one was saved before). */
  salaryTypeForced: boolean;
  /** Text inputs — '' means 'no override, use the engine-derived value'. */
  rate: string;
  workedQty: string;
  fullAmount: string;
}

type OptOutMap = Record<StatutoryOptOutKey, boolean>;

const NO_OPT_OUTS: OptOutMap = { epf: false, socso: false, eis: false, pcb: false };

const SALARY_TYPE_LABELS: Record<SalaryType, string> = {
  monthly: 'Monthly',
  daily: 'Daily',
  hourly: 'Hourly',
};

const WORKED_UNIT_LABELS: Record<SalaryType, string> = {
  monthly: 'month(s)',
  daily: 'day(s)',
  hourly: 'hour(s)',
};

const RATE_LABELS: Record<SalaryType, string> = {
  monthly: 'Monthly salary (RM)',
  daily: 'Daily rate (RM/day)',
  hourly: 'Hourly rate (RM/hour)',
};

const STATUTORY_DEDUCTIONS: {
  key: StatutoryOptOutKey;
  label: string;
  warning: string;
}[] = [
  {
    key: 'epf',
    label: 'EPF / KWSP',
    warning:
      'EPF is legally mandatory for eligible employees (EPF Act 1991) — opt out only with a written agreement or valid exemption.',
  },
  {
    key: 'socso',
    label: 'SOCSO / PERKESO',
    warning:
      'SOCSO coverage is legally mandatory for eligible employees (Act 4) — opt out only with a valid exemption.',
  },
  {
    key: 'eis',
    label: 'EIS / SIP',
    warning:
      'EIS coverage is legally mandatory for citizens/PRs aged 18–60 (Act 800) — opt out only with a valid exemption.',
  },
  {
    key: 'pcb',
    label: 'PCB / MTD',
    warning:
      'PCB withholding is mandatory under ITA 1967 s.83 — opt out only on LHDN direction (e.g. an amended CP39).',
  },
];

const DEDUCTION_PRESETS: { value: AdjustmentPreset; label: string; hint: string }[] = [
  { value: 'cp38', label: 'CP38', hint: 'Additional LHDN tax deduction order' },
  { value: 'zakat', label: 'Zakat', hint: 'Tithes deducted from net pay' },
  { value: 'ptptn', label: 'PTPTN', hint: 'Study-loan repayment' },
  { value: 'custom', label: 'Custom deduction', hint: 'Any other deduction' },
];

/** Statutory employee-share amount for a scheme, from the preview slip. */
function statutoryAmount(p: Payslip, key: StatutoryOptOutKey): number {
  return key === 'epf' ? p.epfEmployee : key === 'socso' ? p.socsoEmployee : key === 'eis' ? p.eisEmployee : p.pcb;
}

export default function EmployeeAdjustDialog({
  open, onOpenChange, runId, payslip, employee, actor, onChanged, onExcluded,
}: Props) {
  const [basic, setBasic] = useState<BasicEditState>({
    salaryType: 'monthly', salaryTypeForced: false, rate: '', workedQty: '', fullAmount: '',
  });
  const [adjustments, setAdjustments] = useState<PayslipAdjustment[]>([]);
  const [optOuts, setOptOuts] = useState<OptOutMap>(NO_OPT_OUTS);
  const [reasons, setReasons] = useState<Partial<Record<StatutoryOptOutKey, string>>>({});
  /** Recurring-benefit ids skipped for THIS run only (engine re-adds on reset). */
  const [excludedBenefitIds, setExcludedBenefitIds] = useState<string[]>([]);

  // Add-earning form state
  const [earnPresetKey, setEarnPresetKey] = useState(PAY_ITEM_PRESETS[0]!.key);
  const [earnLabel, setEarnLabel] = useState('');
  const [earnAmount, setEarnAmount] = useState('');
  // Add-deduction form state
  const [dedPreset, setDedPreset] = useState<AdjustmentPreset>('cp38');
  const [dedLabel, setDedLabel] = useState('');
  const [dedAmount, setDedAmount] = useState('');

  // Sync the editor with the stored payslip whenever it changes (e.g. after
  // an engine recompute) or when the dialog opens for another employee.
  // Render-phase adjust keyed on a signature of every persisted edit field —
  // the same identity check the old effect's dep array made, without the
  // cascading post-commit update.
  const signature = payslip
    ? JSON.stringify([
        payslip.id, payslip.adjustments, payslip.basicOverride, payslip.salaryTypeOverride,
        payslip.rateOverride, payslip.workedQtyOverride, payslip.excludeEpf, payslip.excludeSocso,
        payslip.excludeEis, payslip.excludePcb, payslip.optOutReasons, payslip.excludedBenefitIds, open,
      ])
    : `closed-${open}`;
  const [syncedSig, setSyncedSig] = useState<string | null>(null);
  if (signature !== syncedSig) {
    setSyncedSig(signature);
    if (payslip && employee) {
      setBasic({
        salaryType: payslip.salaryTypeOverride ?? employee.salaryType ?? 'monthly',
        salaryTypeForced: payslip.salaryTypeOverride !== undefined,
        rate: payslip.rateOverride !== undefined ? String(payslip.rateOverride) : '',
        workedQty: payslip.workedQtyOverride !== undefined ? String(payslip.workedQtyOverride) : '',
        fullAmount: payslip.basicOverride !== undefined ? String(payslip.basicOverride) : '',
      });
      setAdjustments(payslip.adjustments ?? []);
      setOptOuts({
        epf: payslip.excludeEpf === true,
        socso: payslip.excludeSocso === true,
        eis: payslip.excludeEis === true,
        pcb: payslip.excludePcb === true,
      });
      setReasons(payslip.optOutReasons ?? {});
      setExcludedBenefitIds(payslip.excludedBenefitIds ?? []);
    }
  }

  /** The edit state the current UI represents (fixed key order for diffing). */
  const editInput = useMemo<PayslipEditInput>(() => ({
    adjustments,
    ...(basic.salaryTypeForced ? { salaryType: basic.salaryType } : {}),
    ...(basic.rate.trim() !== '' && Number.isFinite(Number(basic.rate)) ? { rate: Number(basic.rate) } : {}),
    ...(basic.workedQty.trim() !== '' && Number.isFinite(Number(basic.workedQty))
      ? { workedQty: Number(basic.workedQty) } : {}),
    ...(basic.fullAmount.trim() !== '' && Number.isFinite(Number(basic.fullAmount))
      ? { basicOverride: Number(basic.fullAmount) } : {}),
    ...(optOuts.epf ? { excludeEpf: true } : {}),
    ...(optOuts.socso ? { excludeSocso: true } : {}),
    ...(optOuts.eis ? { excludeEis: true } : {}),
    ...(optOuts.pcb ? { excludePcb: true } : {}),
    optOutReasons: reasons,
    ...(excludedBenefitIds.length > 0 ? { excludeBenefitIds: excludedBenefitIds } : {}),
  }), [adjustments, basic, optOuts, reasons, excludedBenefitIds]);

  /** The edit state persisted on the stored payslip (same key order). */
  const storedEdit = useMemo<PayslipEditInput>(() => ({
    adjustments: payslip?.adjustments ?? [],
    ...(payslip?.salaryTypeOverride ? { salaryType: payslip.salaryTypeOverride } : {}),
    ...(payslip?.rateOverride !== undefined ? { rate: payslip.rateOverride } : {}),
    ...(payslip?.workedQtyOverride !== undefined ? { workedQty: payslip.workedQtyOverride } : {}),
    ...(payslip?.basicOverride !== undefined ? { basicOverride: payslip.basicOverride } : {}),
    ...(payslip?.excludeEpf ? { excludeEpf: true } : {}),
    ...(payslip?.excludeSocso ? { excludeSocso: true } : {}),
    ...(payslip?.excludeEis ? { excludeEis: true } : {}),
    ...(payslip?.excludePcb ? { excludePcb: true } : {}),
    optOutReasons: payslip?.optOutReasons ?? {},
    ...((payslip?.excludedBenefitIds?.length ?? 0) > 0 ? { excludeBenefitIds: payslip!.excludedBenefitIds } : {}),
  }), [payslip]);

  const dirty = JSON.stringify(editInput) !== JSON.stringify(storedEdit);

  // Live 'Pay amount' panel: full engine recompute of the edit state — the
  // preview is EXACTLY what Save will persist (no client-side approximation).
  const preview = useMemo(
    () => (payslip && employee ? previewPayslip(runId, employee.id, editInput) : null),
    [payslip, employee, runId, editInput],
  );

  if (!payslip || !employee) return null;

  const live = preview ?? payslip;
  const earnPreset = payItemPreset(earnPresetKey);
  const workedUnit = WORKED_UNIT_LABELS[basic.salaryType];
  const liveDeductions = round2(
    live.epfEmployee + live.socsoEmployee + live.eisEmployee + live.pcb +
    live.unpaidLeaveDeduction + (live.adjustmentDeductions ?? 0) + (live.loanDeductionTotal ?? 0),
  );
  const liveAdditional = round2(live.otPay + (live.adjustmentEarnings ?? 0));
  const liveReimbursements = round2(
    live.claimsTotal + (live.adjustmentReimbursements ?? 0) + (live.benefitReimbursements ?? 0),
  );
  /** This month's recurring benefits (engine-injected; skippable per run). */
  const monthBenefits = benefitsForMonth(employee.id, payslip.monthKey);

  const setSalaryType = (v: SalaryType) => {
    // Rate & worked-qty semantics change with the type — clear those
    // overrides so the engine re-derives them for the new type.
    setBasic((cur) => ({ ...cur, salaryType: v, salaryTypeForced: true, rate: '', workedQty: '' }));
  };

  const addEarning = () => {
    const amt = Number(earnAmount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    setAdjustments((cur) => [...cur, newEarningFromPreset(earnPreset, earnLabel, amt)]);
    setEarnLabel('');
    setEarnAmount('');
  };

  const addDeduction = () => {
    const amt = Number(dedAmount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const text = dedLabel.trim() || DEDUCTION_PRESETS.find((p) => p.value === dedPreset)?.label || 'Deduction';
    setAdjustments((cur) => [...cur, { id: uid(), kind: 'deduction', preset: dedPreset, label: text, amount: round2(amt) }]);
    setDedLabel('');
    setDedAmount('');
  };

  const patchAdjustment = (id: string, patch: Partial<PayslipAdjustment>) =>
    setAdjustments((cur) => cur.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const toggleTag = (a: PayslipAdjustment, tag: keyof WageBaseTags) => {
    const cur = a.tags ?? LEGACY_EARNING_TAGS;
    patchAdjustment(a.id, { tags: { ...cur, [tag]: !cur[tag] } });
  };

  const save = () => {
    const next = updateDraftPayslip(runId, employee.id, editInput, actor);
    if (next) {
      toast.success(`Adjustments saved for ${employee.name}`, {
        description: 'Statutory figures recomputed on the edited wages.',
      });
      onChanged();
    } else {
      toast.error(`Could not save adjustments for ${employee.name}`);
    }
  };

  const reset = () => {
    const next = resetPayslipToDefaults(runId, employee.id, actor);
    if (next) {
      toast.success(`${employee.name} reset to defaults`, {
        description: 'All adjustment lines and per-run overrides were dropped.',
      });
      onChanged();
    } else {
      toast.error(`Could not reset ${employee.name}`);
    }
  };

  const exclude = () => {
    if (excludeEmployeeFromRun(runId, employee.id, actor)) {
      toast.success(`${employee.name} excluded from this run`, {
        description: 'Their draft payslip was removed; the run totals were retallied.',
      });
      onChanged();
      onExcluded();
    } else {
      toast.error(`Could not exclude ${employee.name} from this run`);
    }
  };

  const earningLines = adjustments.filter((a) => a.kind === 'earning');
  const deductionLines = adjustments.filter((a) => a.kind === 'deduction');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Adjust — {employee.name}</DialogTitle>
          <DialogDescription>
            {payslip.monthKey} draft payslip · the Pay amount panel recomputes live; nothing is
            stored until you save.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.3fr)_minmax(0,1.05fr)_minmax(0,0.9fr)]">
          {/* ── 1. Basic earnings ── */}
          <section className="space-y-3 rounded-xl border p-3">
            <p className="text-sm font-medium">Basic earnings</p>

            <div className="space-y-1">
              <Label>Salary type</Label>
              <Select value={basic.salaryType} onValueChange={(v) => setSalaryType(v as SalaryType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(SALARY_TYPE_LABELS) as SalaryType[]).map((t) => (
                    <SelectItem key={t} value={t}>{SALARY_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(employee.salaryType ?? 'monthly') !== basic.salaryType && (
                <p className="text-[11px] text-amber-700 dark:text-amber-500">
                  Overrides the employee default ({SALARY_TYPE_LABELS[employee.salaryType ?? 'monthly']})
                  for this run only.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label>{RATE_LABELS[basic.salaryType]}</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder={live.rateUsed !== undefined ? live.rateUsed.toFixed(2) : '0.00'}
                value={basic.rate}
                onChange={(e) => setBasic((cur) => ({ ...cur, rate: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground">
                Blank = default RM {defaultRateFor(employee, basic.salaryType).toFixed(2)}
                {basic.salaryType === 'daily' && !employee.dailyRate ? ' (base ÷ 26)' : ''}
                {basic.salaryType === 'hourly' && !employee.hourlyRate ? ' (base ÷ 26 ÷ 8)' : ''}.
              </p>
            </div>

            <div className="space-y-1">
              <Label>Worked: {workedUnit}</Label>
              <Input
                type="number"
                min="0"
                step={basic.salaryType === 'monthly' ? '0.01' : basic.salaryType === 'daily' ? '0.5' : '1'}
                placeholder={live.workedQty !== undefined ? String(live.workedQty) : '—'}
                value={basic.workedQty}
                onChange={(e) => setBasic((cur) => ({ ...cur, workedQty: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground">
                {basic.salaryType === 'monthly'
                  ? 'Blank = joiner/leaver proration. Enter a months fraction (e.g. 0.5) to override it.'
                  : `Blank = attendance count in the cut-off window (${live.workedQty ?? '—'} ${workedUnit}).`}
              </p>
            </div>

            <div className="space-y-1">
              <Label>Full amount (RM)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder={live.basicOverride === undefined ? live.basicPay.toFixed(2) : undefined}
                value={basic.fullAmount}
                onChange={(e) => setBasic((cur) => ({ ...cur, fullAmount: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground">
                Directly replaces the computed basic for this run — audit-logged and badged as
                overridden on the payslip.
              </p>
            </div>

            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <Label htmlFor="include-toggle" className="text-sm">Include in this payroll</Label>
              <Switch id="include-toggle" checked onCheckedChange={(v) => { if (!v) exclude(); }} />
            </div>
          </section>

          {/* ── 2. Additional earnings ── */}
          <section className="space-y-3 rounded-xl border p-3">
            <p className="text-sm font-medium">Additional earnings</p>

            {earningLines.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None yet — add allowances, commission, bonus, OT, BIK/VOLA or a reimbursement below.
              </p>
            ) : (
              <ul className="space-y-2">
                {earningLines.map((a) => {
                  const preset = payItemPreset(a.itemKey);
                  const tags = a.tags ?? LEGACY_EARNING_TAGS;
                  return (
                    <li key={a.id} className="space-y-1.5 rounded-lg border px-2.5 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-sm">{a.label}</span>
                        {a.nonCash && <Badge variant="secondary" className="text-[10px]">non-cash</Badge>}
                        {a.nonStatutory && !a.nonCash && (
                          <Badge variant="secondary" className="text-[10px]">reimbursement</Badge>
                        )}
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          className="h-7 w-24 text-right"
                          value={a.amount}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isFinite(v) && v >= 0) patchAdjustment(a.id, { amount: round2(v) });
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-1.5"
                          title={preset ? 'Apply recommended tags' : 'Custom line — no preset recommendation'}
                          disabled={!preset}
                          onClick={() => patchAdjustment(a.id, applyRecommendedTags(a))}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-1.5"
                          title="Remove line"
                          onClick={() => setAdjustments((cur) => cur.filter((x) => x.id !== a.id))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-1">
                        {(['epf', 'socso', 'eis', 'pcb'] as const).map((tag) => (
                          <TagChip
                            key={tag}
                            tag={tag}
                            on={tags[tag]}
                            advice={
                              preset
                                ? tagAdvice(preset, tag)
                                : `Custom line. Untagged lines keep the legacy behaviour: SOCSO/EIS on, EPF off, PCB as additional remuneration. Toggling sets an explicit per-line tag.`
                            }
                            onToggle={() => toggleTag(a, tag)}
                          />
                        ))}
                        {preset && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="ml-0.5 h-3.5 w-3.5 cursor-help text-muted-foreground" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs text-xs">{preset.advice}</TooltipContent>
                          </Tooltip>
                        )}
                        {a.additionalRemuneration && (
                          <span className="ml-1 text-[10px] text-muted-foreground">additional remuneration</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Add-earning form */}
            <div className="space-y-2 rounded-lg border border-dashed p-2.5">
              <div className="space-y-1">
                <Label>Preset</Label>
                <Select value={earnPresetKey} onValueChange={setEarnPresetKey}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAY_ITEM_PRESETS.map((p) => (
                      <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                    ))}
                    <SelectItem value="custom">Custom earning</SelectItem>
                  </SelectContent>
                </Select>
                {earnPreset && (
                  <p className="text-[11px] text-muted-foreground">{earnPreset.advice}</p>
                )}
              </div>
              <div className="grid grid-cols-[1fr_96px_auto] items-end gap-2">
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input
                    placeholder={earnPreset?.label ?? 'e.g. Sales commission'}
                    value={earnLabel}
                    onChange={(e) => setEarnLabel(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>RM</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={earnAmount}
                    onChange={(e) => setEarnAmount(e.target.value)}
                  />
                </div>
                <Button variant="outline" size="sm" onClick={addEarning} disabled={!Number(earnAmount) || Number(earnAmount) <= 0}>
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>
            </div>

            {/* Recurring benefits this run — engine-injected; unticking skips
                the benefit for THIS run only (reset re-adds it). */}
            {monthBenefits.length > 0 && (
              <div className="space-y-2 rounded-lg border p-2.5">
                <p className="text-xs font-medium text-muted-foreground">Recurring benefits this run</p>
                <ul className="space-y-1.5">
                  {monthBenefits.map((b) => {
                    const excluded = excludedBenefitIds.includes(b.id);
                    return (
                      <li key={b.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`benefit-${b.id}`}
                          checked={!excluded}
                          onCheckedChange={(c) =>
                            setExcludedBenefitIds((cur) =>
                              c === true ? cur.filter((id) => id !== b.id) : [...cur, b.id],
                            )
                          }
                        />
                        <Label htmlFor={`benefit-${b.id}`} className="flex-1 cursor-pointer text-sm font-normal">
                          Benefit — {b.name}
                          <span className="ml-1 text-xs text-muted-foreground">
                            {fmtRM(b.amount)} · {BENEFIT_TREATMENT_LABELS[b.treatment]}
                          </span>
                        </Label>
                        {excluded && <Badge variant="outline" className="text-[10px]">skipped this run</Badge>}
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[11px] text-muted-foreground">
                  Managed under Loans &amp; Benefits — skipping here never edits the benefit itself.
                </p>
              </div>
            )}
          </section>

          {/* ── 3. Deductions ── */}
          <section className="space-y-3 rounded-xl border p-3">
            <p className="text-sm font-medium">Deductions</p>

            {/* Statutory lines with per-item opt-outs */}
            <ul className="space-y-2">
              {STATUTORY_DEDUCTIONS.map((s) => {
                const excluded = optOuts[s.key];
                return (
                  <li key={s.key} className="space-y-1.5 rounded-lg border px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`optout-${s.key}`}
                        checked={excluded}
                        onCheckedChange={(c) =>
                          setOptOuts((cur) => ({ ...cur, [s.key]: c === true }))
                        }
                      />
                      <Label htmlFor={`optout-${s.key}`} className="flex-1 cursor-pointer text-sm font-normal">
                        {s.label}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {excluded ? 'opted out' : fmtRM(statutoryAmount(live, s.key))}
                        </span>
                      </Label>
                      <span className="text-xs text-muted-foreground">opt out</span>
                    </div>
                    {excluded && (
                      <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-900/40 dark:bg-amber-950/30">
                        <p className="flex items-start gap-1.5 text-[11px] text-amber-800 dark:text-amber-500">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {s.warning}
                        </p>
                        <Input
                          placeholder="Reason (stored on the payslip)…"
                          className="h-7 bg-card text-xs"
                          value={reasons[s.key] ?? ''}
                          onChange={(e) =>
                            setReasons((cur) => ({ ...cur, [s.key]: e.target.value }))
                          }
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* CP38 / Zakat / PTPTN / custom deduction lines */}
            {deductionLines.length > 0 && (
              <ul className="space-y-1">
                {deductionLines.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{adjustmentLabel(a)}</span>
                    <Money className="text-red-600 dark:text-red-400">−{fmtRM(a.amount)}</Money>
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

            {/* Add-deduction form */}
            <div className="space-y-2 rounded-lg border border-dashed p-2.5">
              <div className="space-y-1">
                <Label>Preset</Label>
                <Select value={dedPreset} onValueChange={(v) => setDedPreset(v as AdjustmentPreset)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DEDUCTION_PRESETS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {DEDUCTION_PRESETS.find((p) => p.value === dedPreset)?.hint}
                </p>
              </div>
              <div className="grid grid-cols-[1fr_96px_auto] items-end gap-2">
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input
                    placeholder={dedPreset === 'custom' ? 'e.g. Advance recovery' : 'Optional note'}
                    value={dedLabel}
                    onChange={(e) => setDedLabel(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>RM</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={dedAmount}
                    onChange={(e) => setDedAmount(e.target.value)}
                  />
                </div>
                <Button variant="outline" size="sm" onClick={addDeduction} disabled={!Number(dedAmount) || Number(dedAmount) <= 0}>
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>
            </div>
          </section>

          {/* ── 4. Pay amount (live preview) ── */}
          <aside className="h-fit space-y-2 rounded-xl border bg-accent/40 p-3 xl:sticky xl:top-0">
            <p className="text-sm font-medium">Pay amount</p>
            <PanelRow
              label="Basic"
              value={fmtRM(live.basicPay)}
              badge={live.basicOverride !== undefined ? 'overridden' : undefined}
            />
            <PanelRow label={`Additional${live.otPay > 0 ? ` (OT ${live.otHours}h)` : ''}`} value={fmtRM(liveAdditional)} />
            <PanelRow label="Gross pay" value={fmtRM(live.grossPay)} strong />
            <PanelRow label="Deductions" value={`−${fmtRM(liveDeductions)}`} />
            {liveReimbursements > 0 && (
              <PanelRow label="Reimbursements" value={`+${fmtRM(liveReimbursements)}`} />
            )}
            {(live.adjustmentNonCash ?? 0) > 0 && (
              <p className="text-[11px] text-muted-foreground">
                BIK/VOLA {fmtRM(live.adjustmentNonCash!)} feeds PCB only — not paid in cash.
              </p>
            )}
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/30">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Net pay</span>
                <Money className="text-base font-bold">{fmtRM(live.netPay)}</Money>
              </div>
            </div>
            <div className="space-y-1 border-t pt-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Employer contributions
              </p>
              <PanelRow label="EPF" value={fmtRM(live.epfEmployer)} small muted={live.excludeEpf} />
              <PanelRow label="SOCSO" value={fmtRM(live.socsoEmployer)} small muted={live.excludeSocso} />
              <PanelRow label="EIS" value={fmtRM(live.eisEmployer)} small muted={live.excludeEis} />
              <PanelRow label="HRD levy" value={fmtRM(live.hrdLevy)} small />
              <PanelRow
                label="Total employer cost"
                value={fmtRM(live.employerCost)}
                small
                strong
              />
            </div>
          </aside>
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" onClick={reset} title="Recompute from defaults — drops all adjustments and overrides">
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
          <Button onClick={save} disabled={!dirty}>Save adjustments</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small building blocks
// ─────────────────────────────────────────────────────────────────────────────

/** Default rate for a salary type: employee rate, else statutory fallbacks. */
function defaultRateFor(emp: Employee, st: SalaryType): number {
  if (st === 'daily') return emp.dailyRate ?? round2(emp.baseSalary / 26);
  if (st === 'hourly') return emp.hourlyRate ?? round2(emp.baseSalary / 26 / 8);
  return emp.baseSalary;
}

/** One wage-base tag chip (EPF/SOCSO/EIS/PCB) with the statutory advice tooltip. */
function TagChip({
  tag, on, advice, onToggle,
}: {
  tag: keyof WageBaseTags;
  on: boolean;
  advice: string;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide transition-colors',
            on
              ? 'border-amber-500 bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400'
              : 'border-border text-muted-foreground opacity-60 hover:opacity-100',
          )}
        >
          {tag.toUpperCase()}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{advice}</TooltipContent>
    </Tooltip>
  );
}

function PanelRow({
  label, value, badge, strong = false, small = false, muted = false,
}: {
  label: string;
  value: string;
  badge?: string;
  strong?: boolean;
  small?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn('text-muted-foreground', small ? 'text-[11px]' : 'text-xs')}>
        {label}
        {badge && (
          <Badge variant="outline" className="ml-1.5 border-amber-400 text-[10px] text-amber-700 dark:text-amber-500">
            {badge}
          </Badge>
        )}
      </span>
      <Money className={cn(small ? 'text-xs' : 'text-sm', strong && 'font-semibold', muted && 'line-through opacity-60')}>
        {value}
      </Money>
    </div>
  );
}
