/**
 * Additional-earnings preset catalog (kakitangan-style pay items).
 *
 * Every preset carries DEFAULT statutory wage-base tags (EPF / SOCSO / EIS /
 * PCB) plus advisory copy, derived from the tagging matrix in
 * docs/research/statutory-rates.md §6 ("Wages" definition by scheme). The
 * editor lets HR override tags per line; 'apply recommended' restores these
 * defaults. HRD levy has no tag — it stays on basic + fixed allowances only
 * (PSMB Act s.2 wage definition), so it is deliberately not a chip.
 *
 * Key asymmetries encoded (research doc §6):
 *  - OT is SOCSO/EIS-able but NOT EPF-able.
 *  - Annual bonus is EPF-able but NOT SOCSO/EIS-able; taxed as additional
 *    remuneration (LHDN aggregate/bonus mechanism).
 *  - BIK/VOLA is non-cash: excluded from gross and net, but taxable via TP2 —
 *    it feeds the PCB annualization base only.
 *  - Director's fee is NOT EPF/SOCSO/EIS wages (research doc §6: N/N/N/Y) —
 *    taxable only. (This follows the research doc where it differs from the
 *    original feature brief.)
 *  - Genuine expense reimbursements attract no contributions and are exempt
 *    up to limits; FIXED petrol/parking allowances paid regularly DO attract
 *    EPF/SOCSO per case law (labels do not matter) — the default tags stay
 *    OFF for reimbursement-style lines and the advice says when to turn on.
 */

import type { PayslipAdjustment, WageBaseTags } from './types';
import { TAGS_ALL, TAGS_NONE } from './statutory';
import { uid } from './db';
import { round2 } from './utils';

export interface PayItemPreset {
  /** Stable key stored on the adjustment line (PayslipAdjustment.itemKey). */
  key: string;
  label: string;
  /** Recommended wage-base tags (restore point for 'apply recommended'). */
  tags: WageBaseTags;
  /** Taxed via the LHDN additional-remuneration (bonus) mechanism. */
  additionalRemuneration?: boolean;
  /** Paid in net, outside gross and all wage bases (reimbursements). */
  nonStatutory?: boolean;
  /** Non-cash taxable benefit (BIK/VOLA): PCB base only, never net. */
  nonCash?: boolean;
  /** Advisory copy for the tag tooltip ('This item normally attracts EPF…'). */
  advice: string;
}

const FIXED_ALLOWANCE_ADVICE =
  'Fixed allowances paid regularly are wages: they normally attract EPF, SOCSO, EIS and PCB — recommended all on (statutory-rates.md §6).';

export const PAY_ITEM_PRESETS: PayItemPreset[] = [
  {
    key: 'general-allowance',
    label: 'General allowance',
    tags: { ...TAGS_ALL },
    advice: FIXED_ALLOWANCE_ADVICE,
  },
  {
    key: 'transport',
    label: 'Transport allowance',
    tags: { ...TAGS_ALL },
    advice: FIXED_ALLOWANCE_ADVICE,
  },
  {
    key: 'phone',
    label: 'Phone allowance',
    tags: { ...TAGS_ALL },
    advice: FIXED_ALLOWANCE_ADVICE,
  },
  {
    key: 'meals',
    label: 'Meal allowance',
    tags: { ...TAGS_ALL },
    advice: FIXED_ALLOWANCE_ADVICE,
  },
  {
    key: 'childcare',
    label: 'Childcare allowance',
    tags: { ...TAGS_ALL },
    advice:
      'Allowances are wages: normally attract EPF, SOCSO, EIS and PCB — recommended all on. (Childcare allowance may be income-tax exempt up to RM2,400/yr; the exemption is handled at tax filing, not in payroll bases.)',
  },
  {
    key: 'hadir-attendance',
    label: 'Hadir — attendance allowance',
    tags: { ...TAGS_ALL },
    advice:
      'Attendance allowances paid regularly are wages: they normally attract EPF, SOCSO, EIS and PCB — recommended all on. (Non-fixed attendance incentives are excluded from the HRD levy wage base, which this app keeps on basic + fixed allowances only.)',
  },
  {
    key: 'hadir-meals',
    label: 'Hadir — meal allowance',
    tags: { ...TAGS_ALL },
    advice: FIXED_ALLOWANCE_ADVICE,
  },
  {
    key: 'petrol',
    label: 'Petrol allowance / mileage',
    tags: { ...TAGS_NONE },
    nonStatutory: true,
    advice:
      'Reimbursement-basis petrol/mileage attracts no EPF/SOCSO/EIS and is tax-exempt up to limits (e.g. official-duty travel RM6,000/yr) — recommended all off. CAUTION: a FIXED petrol allowance paid regularly is wages per case law and DOES attract EPF/SOCSO — if this is a fixed monthly amount, turn EPF/SOCSO/EIS/PCB on and untick "paid as reimbursement".',
  },
  {
    key: 'parking',
    label: 'Parking (reimbursement)',
    tags: { ...TAGS_NONE },
    nonStatutory: true,
    advice:
      'Reimbursement-basis parking attracts no EPF/SOCSO/EIS/PCB — recommended all off. CAUTION: a FIXED parking allowance paid regularly DOES attract EPF/SOCSO — turn the tags on for fixed amounts.',
  },
  {
    key: 'commission',
    label: 'Commission',
    tags: { ...TAGS_ALL },
    additionalRemuneration: true,
    advice:
      'Commissions attract EPF, SOCSO, EIS and PCB — recommended all on. Taxed as additional remuneration (LHDN aggregate method), so this month\u2019s PCB may spike.',
  },
  {
    key: 'bonus',
    label: 'Bonus',
    tags: { epf: true, socso: false, eis: false, pcb: true },
    additionalRemuneration: true,
    advice:
      'Annual bonus attracts EPF but NOT SOCSO/EIS; taxable as additional remuneration (LHDN aggregate method — expect a one-off PCB spike). Recommended: EPF + PCB on, SOCSO/EIS off (statutory-rates.md §6).',
  },
  {
    key: 'reward',
    label: 'Reward / incentive',
    tags: { ...TAGS_ALL },
    advice:
      'Incentives and rewards attract EPF, SOCSO, EIS and PCB — recommended all on (statutory-rates.md §6: incentives Y/Y/Y).',
  },
  {
    key: 'claims',
    label: 'Claims / expense reimbursement',
    tags: { ...TAGS_NONE },
    nonStatutory: true,
    advice:
      'Genuine expense reimbursements are not wages: no EPF/SOCSO/EIS and tax-exempt up to limits — recommended all off. Paid in net, outside gross.',
  },
  {
    key: 'director-fees',
    label: 'Director fees',
    tags: { epf: false, socso: false, eis: false, pcb: true },
    additionalRemuneration: true,
    advice:
      'Director\u2019s fees are NOT EPF/SOCSO/EIS wages (statutory-rates.md §6: N/N/N) but ARE taxable — recommended: PCB on only. Taxed as additional remuneration when paid ad hoc.',
  },
  {
    key: 'bik-vola',
    label: 'BIK / VOLA (non-cash)',
    tags: { epf: false, socso: false, eis: false, pcb: true },
    nonCash: true,
    advice:
      'Benefits-in-kind / value of living accommodation are non-cash: no EPF/SOCSO/EIS, excluded from gross and net pay, but taxable via TP2 — the amount feeds the PCB base only. Recommended: PCB on only.',
  },
  {
    key: 'overtime-manual',
    label: 'Overtime (manual entry)',
    tags: { epf: false, socso: true, eis: true, pcb: true },
    advice:
      'Overtime is SOCSO/EIS-able but NOT EPF-able (EPF Act s.2); fully taxable as normal remuneration. Recommended: SOCSO/EIS/PCB on, EPF off. Prefer approved attendance OT where possible — it is rated 1.5×/2×/3× automatically.',
  },
];

export const CUSTOM_PAY_ITEM_KEY = 'custom';

/** Look up a preset by key; undefined for 'custom' / unknown keys. */
export function payItemPreset(key: string | undefined): PayItemPreset | undefined {
  return PAY_ITEM_PRESETS.find((p) => p.key === key);
}

/**
 * Advisory tooltip copy for one tag chip of a preset, e.g. "This item normally
 * attracts EPF — recommended on". Falls back to the preset's full advice.
 */
export function tagAdvice(preset: PayItemPreset, tag: keyof WageBaseTags): string {
  const scheme = tag.toUpperCase();
  const on = preset.tags[tag];
  return `${preset.advice} — This item ${on ? 'normally attracts' : 'is normally excluded from'} ${scheme} (recommended ${on ? 'ON' : 'OFF'}).`;
}

/**
 * Build a new earning adjustment line from a preset (recommended tags
 * pre-applied). 'custom' yields an untagged legacy-behaviour line.
 */
export function newEarningFromPreset(
  preset: PayItemPreset | undefined,
  label: string,
  amount: number,
): PayslipAdjustment {
  const base: PayslipAdjustment = {
    id: uid(),
    kind: 'earning',
    preset: 'custom',
    label: label.trim() || preset?.label || 'Custom earning',
    amount: round2(amount),
  };
  if (!preset) return { ...base, itemKey: CUSTOM_PAY_ITEM_KEY };
  return {
    ...base,
    itemKey: preset.key,
    tags: { ...preset.tags },
    additionalRemuneration: preset.additionalRemuneration,
    nonStatutory: preset.nonStatutory,
    nonCash: preset.nonCash,
  };
}

/** Restore a line's recommended tags + flags from its preset (no-op for custom). */
export function applyRecommendedTags(a: PayslipAdjustment): PayslipAdjustment {
  const preset = payItemPreset(a.itemKey);
  if (!preset) return a;
  return {
    ...a,
    tags: { ...preset.tags },
    additionalRemuneration: preset.additionalRemuneration,
    nonStatutory: preset.nonStatutory,
    nonCash: preset.nonCash,
  };
}
