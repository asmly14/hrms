/**
 * e-Claims module — shared metadata, company claim policy and limit checks.
 *
 * Policy limits (meal / medical / phone caps, mileage rate) are COMPANY policy,
 * not statutory figures. They are read from the 'settings' collection when a
 * document with id 'claimPolicy' exists (written by the Settings module),
 * otherwise module defaults below apply. Statutory money never appears here.
 */
import { fmtRM } from '@/lib/utils';
import type { Claim, ClaimCategory, ClaimStatus } from '@/lib/types';

/**
 * Module-local claim record. Adds approver remarks and the mileage breakdown
 * to the core Claim shape. The payroll engine only reads core fields and
 * spreads unknown fields through untouched, so the extension is safe.
 */
export type ClaimRecord = Claim & {
  decisionRemarks?: string;
  mileageKm?: number;
  mileageRate?: number;
};

/** UI-level category — 'mileage' is a guided flavour of the 'travel' category. */
export type UiCategory = ClaimCategory | 'mileage';

export interface CategoryMeta {
  id: UiCategory;
  label: string;
  /** Core ClaimCategory actually stored on the record. */
  claimCategory: ClaimCategory;
  /** Warm-palette hex used by charts and accent dots. */
  color: string;
}

export const CATEGORIES: CategoryMeta[] = [
  { id: 'travel', label: 'Travel', claimCategory: 'travel', color: '#b45309' },
  { id: 'mileage', label: 'Mileage', claimCategory: 'travel', color: '#92400e' },
  { id: 'meal', label: 'Meal & Entertainment', claimCategory: 'meal', color: '#d97706' },
  { id: 'medical', label: 'Medical', claimCategory: 'medical', color: '#dc2626' },
  { id: 'telephone', label: 'Phone & Internet', claimCategory: 'telephone', color: '#a16207' },
  { id: 'parking', label: 'Parking & Toll', claimCategory: 'parking', color: '#78716c' },
  { id: 'training', label: 'Training', claimCategory: 'training', color: '#4d7c0f' },
  { id: 'other', label: 'Other', claimCategory: 'other', color: '#a8a29e' },
];

/** Chart colours keyed by the core category (mileage folds into travel). */
export const CATEGORY_COLOR: Record<ClaimCategory, string> = {
  travel: '#b45309',
  meal: '#d97706',
  medical: '#dc2626',
  parking: '#78716c',
  telephone: '#a16207',
  training: '#4d7c0f',
  other: '#a8a29e',
};

export const CATEGORY_LABEL: Record<ClaimCategory, string> = {
  travel: 'Travel',
  meal: 'Meal & Entertainment',
  medical: 'Medical',
  parking: 'Parking & Toll',
  telephone: 'Phone & Internet',
  training: 'Training',
  other: 'Other',
};

/** Display category for a record — mileage claims show as 'Mileage'. */
export function categoryMetaOf(c: ClaimRecord): CategoryMeta {
  if (c.category === 'travel' && c.mileageKm != null) {
    return CATEGORIES.find((m) => m.id === 'mileage')!;
  }
  return CATEGORIES.find((m) => m.claimCategory === c.category && m.id !== 'mileage')
    ?? CATEGORIES[CATEGORIES.length - 1]!;
}

// ── Policy ──────────────────────────────────────────────────────────────────

export interface ClaimPolicy {
  mileageRatePerKm: number; // RM per km
  mealDailyLimit: number; // RM per calendar day
  medicalClaimLimit: number; // RM per claim
  phoneMonthlyLimit: number; // RM per calendar month
}

export const DEFAULT_POLICY: ClaimPolicy = {
  mileageRatePerKm: 0.8,
  mealDailyLimit: 50,
  medicalClaimLimit: 200,
  phoneMonthlyLimit: 100,
};

/** Document id the Settings module may write into the 'settings' collection. */
export const POLICY_DOC_ID = 'claimPolicy';

/** Structural shape of the optional policy doc (module-local, read-only here). */
export interface ClaimPolicyDoc {
  id: string;
  mileageRatePerKm?: number;
  mealDailyLimit?: number;
  medicalClaimLimit?: number;
  phoneMonthlyLimit?: number;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── Core appSettings bridge (Wave 2) ────────────────────────────────────────
// The core agent adds `getClaimPolicy()` in '@/lib/appSettings' this wave.
// Resolve it optionally (empty glob match when the file hasn't landed yet) so
// this module compiles and behaves identically with or without it. When the
// helper is present its values win over the settings doc; malformed values
// are ignored and fall through to the doc/default chain.

interface AppSettingsLike {
  getClaimPolicy?: () => unknown;
}

const appSettings = Object.values(
  import.meta.glob('../../lib/appSettings.ts', { eager: true }),
)[0] as AppSettingsLike | undefined;

function policyFromAppSettings(): Partial<ClaimPolicy> {
  try {
    const v = appSettings?.getClaimPolicy?.();
    if (!v || typeof v !== 'object') return {};
    const r = v as Record<string, unknown>;
    const out: Partial<ClaimPolicy> = {};
    const keys = [
      'mileageRatePerKm', 'mealDailyLimit', 'medicalClaimLimit', 'phoneMonthlyLimit',
    ] as const;
    for (const k of keys) {
      if (typeof r[k] === 'number') out[k] = r[k] as number;
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge policy sources: appSettings helper → settings doc → module defaults. */
export function resolvePolicy(docs: ClaimPolicyDoc[]): ClaimPolicy {
  const lib = policyFromAppSettings();
  const d = docs.find((x) => x.id === POLICY_DOC_ID);
  return {
    mileageRatePerKm: num(lib.mileageRatePerKm ?? d?.mileageRatePerKm, DEFAULT_POLICY.mileageRatePerKm),
    mealDailyLimit: num(lib.mealDailyLimit ?? d?.mealDailyLimit, DEFAULT_POLICY.mealDailyLimit),
    medicalClaimLimit: num(lib.medicalClaimLimit ?? d?.medicalClaimLimit, DEFAULT_POLICY.medicalClaimLimit),
    phoneMonthlyLimit: num(lib.phoneMonthlyLimit ?? d?.phoneMonthlyLimit, DEFAULT_POLICY.phoneMonthlyLimit),
  };
}

// ── Soft limit checks ───────────────────────────────────────────────────────

export interface ClaimDraftInput {
  employeeId: string;
  category: ClaimCategory;
  amount: number;
  claimDate: string; // ISO date
  /** Set for mileage claims so the rate can be checked against the policy rate. */
  mileageRate?: number;
}

/**
 * Soft policy warnings for a claim — never blocks submission, but approvers
 * see the same flags in their inbox. `excludeId` skips the record itself when
 * editing or flagging an existing claim.
 */
export function policyWarnings(
  draft: ClaimDraftInput,
  existing: ClaimRecord[],
  policy: ClaimPolicy,
  excludeId?: string,
): string[] {
  const warns: string[] = [];
  if (!draft.claimDate || !(draft.amount > 0)) return warns;
  // Limits reflect actually-submitted spend — drafts and rejected claims don't count.
  const mine = existing.filter(
    (c) =>
      c.employeeId === draft.employeeId &&
      c.id !== excludeId &&
      c.status !== 'rejected' &&
      c.status !== 'draft',
  );

  if (draft.category === 'meal') {
    const dayTotal = mine
      .filter((c) => c.category === 'meal' && c.claimDate === draft.claimDate)
      .reduce((s, c) => s + c.amount, 0);
    if (dayTotal + draft.amount > policy.mealDailyLimit) {
      warns.push(
        `Meal claims on this date would total ${fmtRM(dayTotal + draft.amount)} — above the ${fmtRM(policy.mealDailyLimit)}/day policy limit.`,
      );
    }
  }

  if (draft.category === 'medical' && draft.amount > policy.medicalClaimLimit) {
    warns.push(
      `Medical claim is above the ${fmtRM(policy.medicalClaimLimit)} per-claim policy limit.`,
    );
  }

  // Mileage stays editable for exceptions, but an above-policy rate is flagged.
  if (
    draft.category === 'travel' &&
    draft.mileageRate != null &&
    draft.mileageRate > policy.mileageRatePerKm
  ) {
    warns.push(
      `Mileage rate of ${fmtRM(draft.mileageRate)}/km is above the ${fmtRM(policy.mileageRatePerKm)}/km policy rate — the approver will be asked to verify it.`,
    );
  }

  if (draft.category === 'telephone') {
    const mk = draft.claimDate.slice(0, 7);
    const monthTotal = mine
      .filter((c) => c.category === 'telephone' && c.claimDate.startsWith(mk))
      .reduce((s, c) => s + c.amount, 0);
    if (monthTotal + draft.amount > policy.phoneMonthlyLimit) {
      warns.push(
        `Phone & internet claims for ${mk} would total ${fmtRM(monthTotal + draft.amount)} — above the ${fmtRM(policy.phoneMonthlyLimit)}/month policy limit.`,
      );
    }
  }

  return warns;
}

// ── Status pipeline ─────────────────────────────────────────────────────────

export const STATUS_META: Record<ClaimStatus, { label: string; badgeClass: string }> = {
  draft: { label: 'Draft', badgeClass: 'border-stone-300 bg-stone-100 text-stone-600' },
  submitted: { label: 'Submitted', badgeClass: 'border-amber-300 bg-amber-100 text-amber-800' },
  approved: { label: 'Approved', badgeClass: 'border-lime-300 bg-lime-100 text-lime-800' },
  rejected: { label: 'Rejected', badgeClass: 'border-red-300 bg-red-100 text-red-700' },
  paid: { label: 'Paid', badgeClass: 'border-lime-600 bg-lime-600 text-white' },
};
