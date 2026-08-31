/**
 * Recurring benefits in kind — repeating non-salary compensation injected
 * into every payroll run automatically (e.g. Personal Health Insurance
 * reimbursement, group insurance premium BIK, gym/wellness subsidy).
 *
 * Statutory treatment is per-benefit (`BenefitTreatment`) and rides the SAME
 * wage-base tag path as the pay-items catalog (lib/payItems.ts →
 * payrollEngine's tagged-line accumulation, docs/research matrix §6):
 *
 *  - 'nonStatutory-reimbursement' — paid in NET, outside gross and ALL wage
 *    bases (mirrors the claims mechanism). Genuine reimbursements attract no
 *    EPF/SOCSO/EIS/PCB. CAUTION: the SAME amount restructured as a fixed
 *    monthly allowance IS wages per case law and WOULD attract statutory —
 *    every reimbursement preset carries that advice (same pattern as the
 *    petrol/parking presets in payItems.ts).
 *  - 'non-cash-bik' — benefit-in-kind: excluded from gross AND net, feeds
 *    the PCB annualization base only (TP2 declaration).
 *  - 'taxable-allowance' — cash wages: joins gross and every statutory base.
 *
 * Frequency: 'monthly' injects every run; 'annual' injects only in the
 * picked month (e.g. an insurance premium reimbursed every March). Benefits
 * are effective within [startMonth, endMonth?] inclusive.
 *
 * Engine lifecycle: benefits are derived from this collection at compute
 * time, so re-runs are idempotent by construction (nothing is stamped).
 * Draft payslips can SKIP a benefit for one run via the editor
 * (PayslipEditInput.excludeBenefitIds) — non-destructive: a reset re-adds
 * it, and the benefit record itself is never touched by payroll.
 *
 * Pure client-side: localStorage-backed on the first-class registry
 * collection `benefits` (lib/db.ts).
 */
import { getCollection, logAudit, setCollection, uid } from './db';
import { TAGS_ALL, TAGS_NONE } from './statutory';
import { round2 } from './utils';
import type { BenefitTreatment, PayslipAdjustment } from './types';

export const BENEFITS_COLLECTION = 'benefits';

/* ────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────── */

export type BenefitFrequency = 'monthly' | 'annual';

export type BenefitStatus = 'active' | 'ended' | 'cancelled';

export interface RecurringBenefit {
  id: string;
  employeeId: string;
  /** Preset key from BENEFIT_PRESETS, or 'custom'. */
  benefitKey: string;
  /** Display name (defaults to the preset label, editable for 'custom'). */
  name: string;
  /** RM per occurrence (per month, or per year for annual benefits). */
  amount: number;
  frequency: BenefitFrequency;
  /** 1–12 — required when frequency is 'annual' (the injection month). */
  annualMonth?: number;
  treatment: BenefitTreatment;
  /** First wage month the benefit applies, 'YYYY-MM' (inclusive). */
  startMonth: string;
  /** Last wage month (inclusive); absent = open-ended. */
  endMonth?: string;
  status: BenefitStatus;
  notes?: string;
  createdAt: string; // ISO datetime
}

/* ────────────────────────────────────────────────────────────
 * Preset catalog
 * ──────────────────────────────────────────────────────────── */

export interface BenefitPreset {
  key: string;
  label: string;
  treatment: BenefitTreatment;
  /** Advisory copy shown next to the treatment picker (payItems pattern). */
  advice: string;
}

const REIMBURSEMENT_CAUTION =
  'CAUTION: if this is restructured as a FIXED monthly allowance it becomes wages and WOULD attract EPF/SOCSO/EIS/PCB — in that case use a taxable-allowance treatment or the pay-items catalog instead (same advice pattern as the petrol/parking presets).';

export const BENEFIT_PRESETS: BenefitPreset[] = [
  {
    key: 'health-insurance',
    label: 'Personal Health Insurance',
    treatment: 'nonStatutory-reimbursement',
    advice:
      'Reimbursement of an employee-paid personal medical/health insurance premium is not wages: no EPF/SOCSO/EIS/PCB, paid in net like a claim — recommended non-statutory reimbursement. ' +
      REIMBURSEMENT_CAUTION,
  },
  {
    key: 'group-insurance',
    label: 'Group Insurance Premium',
    treatment: 'non-cash-bik',
    advice:
      'Employer-paid group term insurance premium for the employee is a benefit-in-kind: no EPF/SOCSO/EIS and never paid in cash, but taxable via TP2 — the amount feeds the PCB base only.',
  },
  {
    key: 'gym-wellness',
    label: 'Gym / Wellness',
    treatment: 'non-cash-bik',
    advice:
      'Employer-provided gym/wellness membership is a non-cash benefit-in-kind (taxable via TP2; certain wellness benefits may be exempt at tax filing). Recommended: non-cash BIK. If paid as a cash subsidy, switch to taxable allowance.',
  },
  {
    key: 'professional-membership',
    label: 'Professional Membership',
    treatment: 'non-cash-bik',
    advice:
      'Employer-paid professional body membership fees are a benefit-in-kind (PCB via TP2; professional-body subscriptions may be exempt at filing). Recommended: non-cash BIK. Reimbursement against receipts may use the non-statutory treatment instead.',
  },
  {
    key: 'childcare-subsidy',
    label: 'Childcare Subsidy',
    treatment: 'taxable-allowance',
    advice:
      'A fixed monthly childcare subsidy paid in cash is wages: it attracts EPF/SOCSO/EIS and PCB — recommended taxable allowance (all bases on). (Childcare allowance may be income-tax exempt up to RM2,400/yr; the exemption is handled at tax filing, not in payroll bases.)',
  },
  {
    key: 'custom',
    label: 'Custom benefit',
    treatment: 'non-cash-bik',
    advice: 'Custom recurring benefit — pick the statutory treatment that matches how it is paid.',
  },
];

export const CUSTOM_BENEFIT_KEY = 'custom';

/** Look up a preset by key; undefined for unknown keys. */
export function benefitPreset(key: string | undefined): BenefitPreset | undefined {
  return BENEFIT_PRESETS.find((p) => p.key === key);
}

export const BENEFIT_TREATMENT_LABELS: Record<BenefitTreatment, string> = {
  'nonStatutory-reimbursement': 'Non-statutory reimbursement (net only)',
  'non-cash-bik': 'Non-cash benefit-in-kind (PCB via TP2)',
  'taxable-allowance': 'Taxable allowance (all statutory bases)',
};

/* ────────────────────────────────────────────────────────────
 * Store helpers
 * ──────────────────────────────────────────────────────────── */

export function getBenefits(): RecurringBenefit[] {
  return getCollection<RecurringBenefit>(BENEFITS_COLLECTION);
}

function saveBenefits(items: RecurringBenefit[]): void {
  setCollection(BENEFITS_COLLECTION, items);
}

export function getBenefit(id: string): RecurringBenefit | undefined {
  return getBenefits().find((b) => b.id === id);
}

/* ────────────────────────────────────────────────────────────
 * CRUD
 * ──────────────────────────────────────────────────────────── */

export interface BenefitInput {
  employeeId: string;
  benefitKey: string;
  name?: string;
  amount: number;
  frequency: BenefitFrequency;
  annualMonth?: number;
  treatment?: BenefitTreatment;
  startMonth: string;
  endMonth?: string;
  notes?: string;
}

function validateBenefit(input: BenefitInput, treatment: BenefitTreatment, name: string): void {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Benefit amount must be a positive number.');
  }
  if (!name) throw new Error('Benefit name is required.');
  if (input.frequency === 'annual') {
    const m = input.annualMonth;
    if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 12) {
      throw new Error('Annual benefits need an injection month (1–12).');
    }
  }
  if (!/^\d{4}-\d{2}$/.test(input.startMonth)) {
    throw new Error('Start month must be YYYY-MM.');
  }
  if (input.endMonth !== undefined) {
    if (!/^\d{4}-\d{2}$/.test(input.endMonth)) throw new Error('End month must be YYYY-MM.');
    if (input.endMonth < input.startMonth) throw new Error('End month cannot be before the start month.');
  }
  void treatment;
}

/** Create a recurring benefit (treatment defaults to the preset's). */
export function createBenefit(input: BenefitInput, actor = 'system'): RecurringBenefit {
  const preset = benefitPreset(input.benefitKey);
  const name = (input.name?.trim() || preset?.label || 'Custom benefit').trim();
  const treatment = input.treatment ?? preset?.treatment ?? 'non-cash-bik';
  validateBenefit(input, treatment, name);
  const benefit: RecurringBenefit = {
    id: uid(),
    employeeId: input.employeeId,
    benefitKey: input.benefitKey,
    name,
    amount: round2(input.amount),
    frequency: input.frequency,
    ...(input.frequency === 'annual' ? { annualMonth: input.annualMonth } : {}),
    treatment,
    startMonth: input.startMonth,
    ...(input.endMonth ? { endMonth: input.endMonth } : {}),
    status: 'active',
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    createdAt: new Date().toISOString(),
  };
  saveBenefits([...getBenefits(), benefit]);
  logAudit({
    actorName: actor,
    action: 'benefits.create',
    entity: BENEFITS_COLLECTION,
    entityId: benefit.id,
    detail:
      `${name} for ${input.employeeId}: RM${benefit.amount.toFixed(2)} ` +
      `${input.frequency === 'annual' ? `annually (month ${input.annualMonth})` : 'monthly'} ` +
      `from ${input.startMonth}${input.endMonth ? ` to ${input.endMonth}` : ''} — ${treatment}`,
  });
  return benefit;
}

/** Edit a benefit's commercial fields (amount/frequency/period/treatment). */
export function updateBenefit(id: string, patch: Partial<BenefitInput>, actor = 'system'): RecurringBenefit | null {
  const current = getBenefit(id);
  if (!current) return null;
  const merged: RecurringBenefit = {
    ...current,
    ...(patch.benefitKey !== undefined ? { benefitKey: patch.benefitKey } : {}),
    ...(patch.name !== undefined ? { name: patch.name.trim() || current.name } : {}),
    ...(patch.amount !== undefined ? { amount: round2(patch.amount) } : {}),
    ...(patch.frequency !== undefined ? { frequency: patch.frequency } : {}),
    ...(patch.treatment !== undefined ? { treatment: patch.treatment } : {}),
    ...(patch.startMonth !== undefined ? { startMonth: patch.startMonth } : {}),
    ...(patch.endMonth !== undefined ? { endMonth: patch.endMonth || undefined } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes.trim() || undefined } : {}),
  };
  // Annual-month coherence after the merge.
  if (merged.frequency === 'annual') {
    merged.annualMonth = patch.annualMonth ?? current.annualMonth;
  } else {
    delete merged.annualMonth;
  }
  validateBenefit(
    { ...merged, annualMonth: merged.annualMonth },
    merged.treatment,
    merged.name,
  );
  saveBenefits(getBenefits().map((b) => (b.id === id ? merged : b)));
  logAudit({
    actorName: actor,
    action: 'benefits.update',
    entity: BENEFITS_COLLECTION,
    entityId: id,
    detail: `${merged.name} (${merged.employeeId}) updated — RM${merged.amount.toFixed(2)} ${merged.frequency}, ${merged.treatment}`,
  });
  return merged;
}

/** End a benefit (stops future injections; history preserved). */
export function endBenefit(id: string, actor = 'system', endMonth?: string): RecurringBenefit | null {
  const current = getBenefit(id);
  if (!current || current.status !== 'active') return current ?? null;
  const next: RecurringBenefit = {
    ...current,
    status: 'ended',
    ...(endMonth ? { endMonth } : {}),
  };
  saveBenefits(getBenefits().map((b) => (b.id === id ? next : b)));
  logAudit({
    actorName: actor,
    action: 'benefits.end',
    entity: BENEFITS_COLLECTION,
    entityId: id,
    detail: `${current.name} (${current.employeeId}) ended${endMonth ? ` after ${endMonth}` : ''}`,
  });
  return next;
}

/** Cancel a benefit created by mistake (before it ever paid). */
export function cancelBenefit(id: string, actor = 'system'): RecurringBenefit | null {
  const current = getBenefit(id);
  if (!current) return null;
  const next: RecurringBenefit = { ...current, status: 'cancelled' };
  saveBenefits(getBenefits().map((b) => (b.id === id ? next : b)));
  logAudit({
    actorName: actor,
    action: 'benefits.cancel',
    entity: BENEFITS_COLLECTION,
    entityId: id,
    detail: `${current.name} (${current.employeeId}) cancelled`,
  });
  return next;
}

/* ────────────────────────────────────────────────────────────
 * Queries & engine mapping
 * ──────────────────────────────────────────────────────────── */

/** All benefits for an employee (any status), newest first. */
export function benefitsFor(employeeId: string): RecurringBenefit[] {
  return getBenefits()
    .filter((b) => b.employeeId === employeeId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Benefits injectable into a wage month's run: active, within
 * [startMonth, endMonth?], and matching the frequency (monthly always;
 * annual only in its picked month).
 */
export function benefitsForMonth(employeeId: string, month: string): RecurringBenefit[] {
  const monthIndex = Number(month.split('-')[1]);
  return getBenefits()
    .filter(
      (b) =>
        b.employeeId === employeeId &&
        b.status === 'active' &&
        b.startMonth <= month &&
        (b.endMonth === undefined || b.endMonth >= month) &&
        (b.frequency === 'monthly' || b.annualMonth === monthIndex),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Map a benefit onto the pay-items wage-base path: the returned adjustment
 * shape feeds payrollEngine's tagged-line accumulation exactly like a
 * catalog preset line (reimbursement → non-statutory; BIK → non-cash PCB;
 * taxable allowance → all tags on).
 */
export function benefitAsAdjustment(b: RecurringBenefit): PayslipAdjustment {
  const base = {
    id: `benefit-${b.id}`,
    kind: 'earning' as const,
    preset: 'custom' as const,
    label: `Benefit — ${b.name}`,
    amount: round2(b.amount),
    itemKey: `benefit:${b.benefitKey}`,
  };
  if (b.treatment === 'nonStatutory-reimbursement') {
    return { ...base, tags: { ...TAGS_NONE }, nonStatutory: true };
  }
  if (b.treatment === 'non-cash-bik') {
    return { ...base, tags: { epf: false, socso: false, eis: false, pcb: true }, nonCash: true };
  }
  return { ...base, tags: { ...TAGS_ALL } };
}
