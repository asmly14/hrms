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
import type { BenefitTreatment, Payslip, PayslipAdjustment } from './types';

export const BENEFITS_COLLECTION = 'benefits';
export const BENEFIT_CATEGORIES_COLLECTION = 'benefitCategories';

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
  /** Employer-managed BIK category (BenefitCategory.id) this assignment
   *  belongs to. Absent on pre-category records — treated as uncategorized. */
  categoryId?: string;
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

/**
 * Statutory advice per treatment — the assign-dialog advice panel copy
 * (same advisory style as the pay-items catalog, payItems.ts).
 */
export const BENEFIT_TREATMENT_ADVICE: Record<BenefitTreatment, string> = {
  'nonStatutory-reimbursement':
    'Not wages: no EPF/SOCSO/EIS/PCB if this is a genuine reimbursement of an actual expense (paid in net, like a claim). CAUTION: restructured as a FIXED monthly allowance it becomes wages per case law and WOULD attract all statutory — use the taxable-allowance treatment instead.',
  'non-cash-bik':
    'Perquisite — taxable via TP2/EA s.13(1)(b), not EPF/SOCSO wages: the amount feeds the PCB annualization base only, never gross or net pay (research doc §6: BIK N/N/N, taxable Y).',
  'taxable-allowance':
    'Fixed cash allowance — attracts EPF + SOCSO + EIS + PCB: the amount joins gross and every statutory wage base.',
};

/* ────────────────────────────────────────────────────────────
 * BIK categories (employer-managed, per tenant)
 * ──────────────────────────────────────────────────────────── */

export type BenefitCategoryKind =
  | 'medical'
  | 'parking'
  | 'insurance'
  | 'wellness'
  | 'membership'
  | 'housing'
  | 'vehicle'
  | 'education'
  | 'other';

export const BENEFIT_CATEGORY_KIND_LABELS: Record<BenefitCategoryKind, string> = {
  medical: 'Medical',
  parking: 'Parking',
  insurance: 'Insurance',
  wellness: 'Wellness',
  membership: 'Membership',
  housing: 'Housing',
  vehicle: 'Vehicle',
  education: 'Education',
  other: 'Other',
};

/**
 * Employer-managed benefit-in-kind category. Persisted per tenant on the
 * `benefitCategories` registry collection; seeded with the statutory-default
 * catalog on first access. Categories are never hard-deleted (assignments
 * reference them) — employers deactivate instead.
 */
export interface BenefitCategory {
  id: string;
  name: string;
  kind: BenefitCategoryKind;
  /** Default statutory treatment pre-applied to new assignments. */
  defaultTreatment: BenefitTreatment;
  /** Advisory copy: PCB / income-tax treatment of this category. */
  pcbNote: string;
  /** Advisory copy: EPF/SOCSO/EIS wage-base treatment of this category. */
  epfNote: string;
  /** true = employer-created; false = seeded statutory default. */
  custom: boolean;
  active: boolean;
  createdAt: string; // ISO datetime
}

/** Suggested default treatment + advice text per kind (custom-category form). */
export function suggestCategoryAdvice(kind: BenefitCategoryKind): {
  defaultTreatment: BenefitTreatment;
  pcbNote: string;
  epfNote: string;
} {
  switch (kind) {
    case 'parking':
      return {
        defaultTreatment: 'taxable-allowance',
        pcbNote:
          'A FIXED monthly parking allowance paid in cash is taxable wages (PCB on). If this is a pure reimbursement of actual parking against receipts, switch the treatment to non-statutory reimbursement.',
        epfNote:
          'Fixed parking allowances paid regularly attract EPF/SOCSO/EIS per case law — labels do not matter (research doc §6). Genuine reimbursements of actual expense attract none.',
      };
    case 'medical':
      return {
        defaultTreatment: 'non-cash-bik',
        pcbNote:
          'Employer-paid medical/health insurance premium is a perquisite — taxable via TP2 and reported on the EA form under s.13(1)(b).',
        epfNote: 'Not EPF/SOCSO/EIS wages (benefits-in-kind: N/N/N — research doc §6).',
      };
    case 'insurance':
      return {
        defaultTreatment: 'non-cash-bik',
        pcbNote:
          'Employer-paid insurance premium for the employee is a perquisite — taxable via TP2/EA s.13(1)(b).',
        epfNote: 'Not EPF/SOCSO/EIS wages (benefits-in-kind: N/N/N — research doc §6).',
      };
    case 'wellness':
      return {
        defaultTreatment: 'non-cash-bik',
        pcbNote:
          'Taxable via TP2/EA s.13(1)(b); certain wellness benefits may be exempt at tax filing. If paid as a cash subsidy, switch to taxable allowance.',
        epfNote: 'Not EPF/SOCSO/EIS wages when provided in kind.',
      };
    case 'membership':
      return {
        defaultTreatment: 'non-cash-bik',
        pcbNote:
          'Taxable via TP2/EA s.13(1)(b); professional-body subscriptions may be exempt at filing. Reimbursement against receipts may use the non-statutory treatment instead.',
        epfNote: 'Not EPF/SOCSO/EIS wages when paid directly to the body.',
      };
    case 'housing':
      return {
        defaultTreatment: 'non-cash-bik',
        pcbNote:
          'Employer-provided housing is taxable — value of living accommodation (VOLA, s.13(1)(c)) or housing benefit perquisite (s.13(1)(b)) via TP2.',
        epfNote: 'Not EPF/SOCSO/EIS wages (benefits-in-kind: N/N/N — research doc §6).',
      };
    case 'vehicle':
      return {
        defaultTreatment: 'non-cash-bik',
        pcbNote:
          'Company car BIK follows the LHDN prescribed-value table (car/fuel/driver) — taxable via TP2/EA s.13(1)(b).',
        epfNote: 'Not EPF/SOCSO/EIS wages (benefits-in-kind: N/N/N — research doc §6).',
      };
    case 'education':
      return {
        defaultTreatment: 'non-cash-bik',
        pcbNote:
          'Employer-paid education assistance is a perquisite — taxable via TP2 unless an exemption applies at tax filing.',
        epfNote: 'Not EPF/SOCSO/EIS wages when paid in kind.',
      };
    case 'other':
      return {
        defaultTreatment: 'non-cash-bik',
        pcbNote: 'Pick the statutory treatment that matches how this benefit is actually paid.',
        epfNote: 'Depends on the treatment chosen — see the advice panel in the assign dialog.',
      };
  }
}

function seedCategory(
  id: string,
  name: string,
  kind: BenefitCategoryKind,
  treatmentOverride?: BenefitTreatment,
  pcbNoteOverride?: string,
  epfNoteOverride?: string,
): BenefitCategory {
  const suggested = suggestCategoryAdvice(kind);
  return {
    id,
    name,
    kind,
    defaultTreatment: treatmentOverride ?? suggested.defaultTreatment,
    pcbNote: pcbNoteOverride ?? suggested.pcbNote,
    epfNote: epfNoteOverride ?? suggested.epfNote,
    custom: false,
    active: true,
    createdAt: '2025-01-01T00:00:00.000Z',
  };
}

/**
 * Statutory-default category catalog, seeded per tenant on first access.
 * Ids are deterministic (`bcat-*`) so seeding is idempotent and the preset
 * → category mapping (PRESET_CATEGORY_IDS) can reference them.
 */
export const DEFAULT_BENEFIT_CATEGORIES: BenefitCategory[] = [
  seedCategory('bcat-medical', 'Medical Insurance', 'medical'),
  seedCategory('bcat-group-insurance', 'Group Insurance', 'insurance'),
  seedCategory('bcat-parking', 'Parking Allowance', 'parking'),
  seedCategory('bcat-wellness', 'Gym / Wellness', 'wellness'),
  seedCategory('bcat-membership', 'Professional Membership', 'membership'),
  seedCategory(
    'bcat-childcare',
    'Childcare Subsidy',
    'other',
    'taxable-allowance',
    'A fixed monthly childcare subsidy paid in cash is taxable wages (PCB on). Childcare allowance may be income-tax exempt up to RM2,400/yr — the exemption is handled at tax filing, not in payroll bases.',
    'Fixed cash subsidies are wages: they attract EPF/SOCSO/EIS (research doc §6).',
  ),
  seedCategory('bcat-vehicle', 'Company Vehicle', 'vehicle'),
  seedCategory('bcat-housing', 'Housing Benefit', 'housing'),
  seedCategory('bcat-education', 'Education Assistance', 'education'),
];

/** Map the legacy preset keys onto their seeded category (custom → none). */
export const PRESET_CATEGORY_IDS: Record<string, string> = {
  'health-insurance': 'bcat-medical',
  'group-insurance': 'bcat-group-insurance',
  'gym-wellness': 'bcat-wellness',
  'professional-membership': 'bcat-membership',
  'childcare-subsidy': 'bcat-childcare',
};

/** Reverse map: seeded category → its preset key (else 'custom'). */
export const CATEGORY_PRESET_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(PRESET_CATEGORY_IDS).map(([preset, cat]) => [cat, preset]),
);

/**
 * Read the category registry, seeding the statutory-default catalog on first
 * access. Per-tenant via the registry collection; idempotent — the catalog is
 * only written when the collection is empty, and categories are never
 * hard-deleted (deactivation keeps the row), so the seed never re-fires.
 */
export function getBenefitCategories(): BenefitCategory[] {
  const existing = getCollection<BenefitCategory>(BENEFIT_CATEGORIES_COLLECTION);
  if (existing.length > 0) return existing;
  setCollection(BENEFIT_CATEGORIES_COLLECTION, [...DEFAULT_BENEFIT_CATEGORIES]);
  return [...DEFAULT_BENEFIT_CATEGORIES];
}

function saveBenefitCategories(items: BenefitCategory[]): void {
  setCollection(BENEFIT_CATEGORIES_COLLECTION, items);
}

/** Look up one category by id (undefined for unknown ids). */
export function benefitCategory(id: string | undefined): BenefitCategory | undefined {
  if (!id) return undefined;
  return getBenefitCategories().find((c) => c.id === id);
}

/** Active categories only — picker source for the assign dialog. */
export function activeBenefitCategories(): BenefitCategory[] {
  return getBenefitCategories().filter((c) => c.active);
}

export interface BenefitCategoryInput {
  name: string;
  kind: BenefitCategoryKind;
  defaultTreatment?: BenefitTreatment;
  pcbNote?: string;
  epfNote?: string;
}

function validateCategory(name: string, kind: BenefitCategoryKind): void {
  if (!name) throw new Error('Category name is required.');
  if (!(kind in BENEFIT_CATEGORY_KIND_LABELS)) {
    throw new Error(`Unknown benefit category kind '${kind}'.`);
  }
}

/**
 * Create a CUSTOM employer category. Treatment + advice text default to the
 * per-kind suggestion when omitted (the UI pre-fills exactly these).
 */
export function createBenefitCategory(input: BenefitCategoryInput, actor = 'system'): BenefitCategory {
  const name = input.name.trim();
  validateCategory(name, input.kind);
  const suggested = suggestCategoryAdvice(input.kind);
  const category: BenefitCategory = {
    id: uid(),
    name,
    kind: input.kind,
    defaultTreatment: input.defaultTreatment ?? suggested.defaultTreatment,
    pcbNote: input.pcbNote?.trim() || suggested.pcbNote,
    epfNote: input.epfNote?.trim() || suggested.epfNote,
    custom: true,
    active: true,
    createdAt: new Date().toISOString(),
  };
  saveBenefitCategories([...getBenefitCategories(), category]);
  logAudit({
    actorName: actor,
    action: 'benefitCategories.create',
    entity: BENEFIT_CATEGORIES_COLLECTION,
    entityId: category.id,
    detail: `${name} (${input.kind}) — default ${category.defaultTreatment}`,
  });
  return category;
}

/**
 * Edit a category (name/kind/treatment/notes) or deactivate/reactivate it.
 * Deactivation keeps the record so existing assignments still resolve.
 * Returns null for unknown ids.
 */
export function updateBenefitCategory(
  id: string,
  patch: Partial<BenefitCategoryInput & { active: boolean }>,
  actor = 'system',
): BenefitCategory | null {
  const current = benefitCategory(id);
  if (!current) return null;
  const merged: BenefitCategory = {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name.trim() || current.name } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.defaultTreatment !== undefined ? { defaultTreatment: patch.defaultTreatment } : {}),
    ...(patch.pcbNote !== undefined ? { pcbNote: patch.pcbNote.trim() || current.pcbNote } : {}),
    ...(patch.epfNote !== undefined ? { epfNote: patch.epfNote.trim() || current.epfNote } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  };
  validateCategory(merged.name, merged.kind);
  saveBenefitCategories(getBenefitCategories().map((c) => (c.id === id ? merged : c)));
  logAudit({
    actorName: actor,
    action: 'benefitCategories.update',
    entity: BENEFIT_CATEGORIES_COLLECTION,
    entityId: id,
    detail:
      `${merged.name} updated — ${merged.kind}, default ${merged.defaultTreatment}` +
      (patch.active !== undefined ? `, ${patch.active ? 'reactivated' : 'deactivated'}` : ''),
  });
  return merged;
}

/**
 * Hard-delete a CUSTOM benefit category. Seeded statutory defaults can only
 * be deactivated (throws). Blocked while ANY benefit assignment references
 * the category (any status — assignments must keep resolving their category)
 * — the caller should offer deactivation instead. Audited.
 */
export function deleteBenefitCategory(id: string, actor = 'system'): boolean {
  const current = benefitCategory(id);
  if (!current) return false;
  if (!current.custom) {
    throw new Error(
      `'${current.name}' is a statutory default category — deactivate it instead of deleting.`,
    );
  }
  const referencing = getBenefits().filter((b) => b.categoryId === id);
  if (referencing.length > 0) {
    throw new Error(
      `'${current.name}' is used by ${referencing.length} benefit assignment${referencing.length === 1 ? '' : 's'} — reassign or delete those first, or deactivate the category.`,
    );
  }
  saveBenefitCategories(getBenefitCategories().filter((c) => c.id !== id));
  logAudit({
    actorName: actor,
    action: 'benefitCategories.delete',
    entity: BENEFIT_CATEGORIES_COLLECTION,
    entityId: id,
    detail: `${current.name} (${current.kind}) custom category hard-deleted`,
  });
  return true;
}

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
  /** Employer-managed BIK category (BenefitCategory.id). Auto-derived from the
   *  preset mapping when omitted; defaults the name/treatment for 'custom'. */
  categoryId?: string;
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
  // '' is the explicit CLEAR signal (edit path) — only validate real values.
  if (input.endMonth !== undefined && input.endMonth !== '') {
    if (!/^\d{4}-\d{2}$/.test(input.endMonth)) throw new Error('End month must be YYYY-MM.');
    if (input.endMonth < input.startMonth) throw new Error('End month cannot be before the start month.');
  }
  void treatment;
}

/** Resolve the category for an assignment: explicit id wins (validated;
 *  '' clears); otherwise the preset's mapped category; otherwise undefined.
 *  Triggers the per-tenant default-catalog seed on first use. */
function resolveCategoryId(categoryId: string | undefined, benefitKey: string): string | undefined {
  if (categoryId !== undefined) {
    if (categoryId === '') return undefined; // explicit clear
    if (!benefitCategory(categoryId)) {
      throw new Error(`Unknown benefit category '${categoryId}'.`);
    }
    return categoryId;
  }
  const mapped = PRESET_CATEGORY_IDS[benefitKey];
  return mapped && benefitCategory(mapped) ? mapped : undefined;
}

/** Create a recurring benefit (treatment defaults to the preset's, then the
 *  category's; name defaults to the preset label, then the category name). */
export function createBenefit(input: BenefitInput, actor = 'system'): RecurringBenefit {
  // The 'custom' preset is a placeholder — its label/treatment must not
  // shadow the picked category's defaults (without a category the fallback
  // chain below lands on the same 'Custom benefit' / 'non-cash-bik' values,
  // so pre-category behaviour is unchanged).
  const preset = input.benefitKey === CUSTOM_BENEFIT_KEY ? undefined : benefitPreset(input.benefitKey);
  const categoryId = resolveCategoryId(input.categoryId, input.benefitKey);
  const category = benefitCategory(categoryId);
  const name = (input.name?.trim() || preset?.label || category?.name || 'Custom benefit').trim();
  const treatment = input.treatment ?? preset?.treatment ?? category?.defaultTreatment ?? 'non-cash-bik';
  validateBenefit(input, treatment, name);
  const benefit: RecurringBenefit = {
    id: uid(),
    employeeId: input.employeeId,
    benefitKey: input.benefitKey,
    ...(categoryId ? { categoryId } : {}),
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
      `from ${input.startMonth}${input.endMonth ? ` to ${input.endMonth}` : ''} — ${treatment}` +
      (category ? ` [${category.name}]` : ''),
  });
  return benefit;
}

/** Edit a benefit's commercial fields (amount/frequency/period/treatment/category).
 *  Explicit-clear semantics: endMonth '' removes the end date, notes '' clears
 *  the notes, name '' reverts to the preset label / category name, and
 *  switching frequency to 'monthly' drops annualMonth. Omitted keys stay
 *  untouched. */
export function updateBenefit(id: string, patch: Partial<BenefitInput>, actor = 'system'): RecurringBenefit | null {
  const current = getBenefit(id);
  if (!current) return null;
  const merged: RecurringBenefit = {
    ...current,
    ...(patch.benefitKey !== undefined ? { benefitKey: patch.benefitKey } : {}),
    ...(patch.amount !== undefined ? { amount: round2(patch.amount) } : {}),
    ...(patch.frequency !== undefined ? { frequency: patch.frequency } : {}),
    ...(patch.treatment !== undefined ? { treatment: patch.treatment } : {}),
    ...(patch.startMonth !== undefined ? { startMonth: patch.startMonth } : {}),
    ...(patch.endMonth !== undefined ? { endMonth: patch.endMonth || undefined } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes.trim() || undefined } : {}),
  };
  // Category change: resolve & validate the same way createBenefit does
  // ('' clears the assignment back to uncategorized).
  if (patch.categoryId !== undefined) {
    const resolved = resolveCategoryId(patch.categoryId, patch.benefitKey ?? current.benefitKey);
    if (resolved) merged.categoryId = resolved;
    else delete merged.categoryId;
  }
  // Name: '' is an explicit clear — revert to the preset label, then the
  // category name (createBenefit's fallback chain), then keep the old name.
  if (patch.name !== undefined) {
    const preset = merged.benefitKey === CUSTOM_BENEFIT_KEY ? undefined : benefitPreset(merged.benefitKey);
    const fallback = preset?.label || benefitCategory(merged.categoryId)?.name || current.name;
    merged.name = patch.name.trim() || fallback;
  }
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

/**
 * Hard-delete a benefit assignment (row removed entirely, unlike end/cancel
 * which keep a history row). Safe because payslips are SNAPSHOTS: computed
 * runs store their own benefit lines (Payslip.benefits) and payroll derives
 * injections from this collection at compute time only — the only other
 * reference is PayslipEditInput.excludeBenefitIds on draft payslips, which
 * simply filters live benefit ids, so a deleted id is ignored harmlessly.
 * Past payslips keep their history; only future injections stop. Audited.
 */
export function deleteBenefit(id: string, actor = 'system'): boolean {
  const current = getBenefit(id);
  if (!current) return false;
  saveBenefits(getBenefits().filter((b) => b.id !== id));
  logAudit({
    actorName: actor,
    action: 'benefits.delete',
    entity: BENEFITS_COLLECTION,
    entityId: id,
    detail: `${current.name} (${current.employeeId}) hard-deleted — was ${current.status}, RM${current.amount.toFixed(2)} ${current.frequency}`,
  });
  return true;
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

/* ────────────────────────────────────────────────────────────
 * Employer-level summary & EA form aggregation
 * ──────────────────────────────────────────────────────────── */

export interface BenefitSummary {
  month: string;
  /** Benefits with status 'active' (regardless of their window). */
  activeCount: number;
  /** Benefits actually injecting in `month` (window + frequency matched). */
  injectableCount: number;
  /** RM injecting in `month`, split by statutory treatment. */
  byTreatment: Record<BenefitTreatment, number>;
  /** Total RM injecting in `month` (all treatments). */
  totalMonth: number;
}

/**
 * Employer-level BIK summary strip data: how many active benefits exist and
 * what injects into the given wage month, split by treatment (reimbursement /
 * non-cash BIK / taxable allowance). Pure read — derived from the collection,
 * so it can never drift from what payroll actually injects.
 */
export function benefitSummary(month: string): BenefitSummary {
  const monthIndex = Number(month.split('-')[1]);
  const active = getBenefits().filter((b) => b.status === 'active');
  const injectable = active.filter(
    (b) =>
      b.startMonth <= month &&
      (b.endMonth === undefined || b.endMonth >= month) &&
      (b.frequency === 'monthly' || b.annualMonth === monthIndex),
  );
  const byTreatment: Record<BenefitTreatment, number> = {
    'nonStatutory-reimbursement': 0,
    'non-cash-bik': 0,
    'taxable-allowance': 0,
  };
  for (const b of injectable) byTreatment[b.treatment] = round2(byTreatment[b.treatment] + b.amount);
  return {
    month,
    activeCount: active.length,
    injectableCount: injectable.length,
    byTreatment,
    totalMonth: round2(injectable.reduce((s, b) => s + b.amount, 0)),
  };
}

export interface EABikItem {
  /** Benefit / adjustment display name (grouping key). */
  name: string;
  /** Annual total RM across the year's payslips. */
  total: number;
  /** Distinct wage months the item appeared in. */
  months: number;
}

export interface EABikTotals {
  items: EABikItem[];
  total: number;
}

/**
 * EA form s.13(1)(b) aggregation: annual BENEFITS-IN-KIND totals for one
 * employee's year of payslips, listed separately from cash remuneration per
 * the LHDN EA structure. Two non-cash sources are aggregated:
 *  - recurring-benefit entries with treatment 'non-cash-bik'
 *    (Payslip.benefits), and
 *  - editor non-cash earning lines (Payslip.adjustments with nonCash, e.g.
 *    the pay-items 'BIK / VOLA (non-cash)' preset).
 * Reimbursement and taxable-allowance benefits are EXCLUDED — the former are
 * non-taxable memo items, the latter are already inside cash gross.
 * Pure function over stored payslips; no rates are recomputed.
 */
export function eaBikTotals(payslips: Payslip[]): EABikTotals {
  const byName = new Map<string, { total: number; months: Set<string> }>();
  const add = (name: string, amount: number, monthKey: string): void => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const entry = byName.get(name) ?? { total: 0, months: new Set<string>() };
    entry.total = round2(entry.total + amount);
    entry.months.add(monthKey);
    byName.set(name, entry);
  };
  for (const p of payslips) {
    for (const b of p.benefits ?? []) {
      if (b.treatment === 'non-cash-bik') add(b.name, b.amount, p.monthKey);
    }
    for (const a of p.adjustments ?? []) {
      if (a.kind === 'earning' && a.nonCash) add(a.label, a.amount, p.monthKey);
    }
  }
  const items: EABikItem[] = [...byName.entries()]
    .map(([name, v]) => ({ name, total: v.total, months: v.months.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { items, total: round2(items.reduce((s, i) => s + i.total, 0)) };
}
