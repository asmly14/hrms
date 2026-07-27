/**
 * Typed accessors over the mixed 'settings' collection (Wave 2).
 *
 * MULTI-TENANT: the 'settings' collection is tenant-scoped, so every accessor
 * automatically reads the ACTIVE company's records. The active company's
 * `Company.config` (CompanyConfig) acts as the seed-time base layer —
 * resolution order is: system defaults → Company.config → settings docs.
 * Exported API is unchanged from the single-tenant version.
 *
 * The settings collection holds the core `Settings` company singleton
 * (id 'company') plus `kind`-tagged extension records written by the
 * Settings module. Page modules MUST read admin config through these
 * accessors instead of re-parsing the collection themselves.
 *
 * Canonical storage contracts (reconciled in Wave 2 — docs/qa/settings-mobile.md):
 *  - Geofence locations  → `officeLocations` array ON the company singleton
 *    (B1: legacy `kind:'officeLocation'` records are honoured as a fallback
 *    until the Settings module migrates them onto the singleton).
 *  - Claim policy        → doc id 'claimPolicy' with the Claims module schema
 *    (B2: legacy per-category monthly caps on 'ext:payroll'.claimLimits are
 *    still surfaced via `monthlyLimits` so nothing written is lost).
 *  - Leave top-ups       → doc id 'ext:leaveTopups' (`days` per type) (B3).
 *  - Payroll cut-off     → doc id 'ext:payroll' (`cutoffDay`, `workingDaysBasis`).
 *
 * All accessors are pure reads with safe defaults — they never throw, never
 * write, and return the defaults when the records are absent (e.g. before
 * the seed or on a fresh install).
 */
import { getActiveCompany, getCollection } from './db';
import type { ClaimCategory, Settings } from './types';

/** Row shape of the mixed 'settings' collection. */
interface SettingsRow {
  id: string;
  kind?: string;
  [key: string]: unknown;
}

function settingsRows(): SettingsRow[] {
  return getCollection<SettingsRow>('settings');
}

/** Company singleton (id 'company'; `kind:'company'` tolerated). */
function companyRow(): SettingsRow | undefined {
  return settingsRows().find((r) => r.id === 'company' || r.kind === 'company');
}

function posNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function nonNegNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Office locations (attendance geofencing)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized geofence location — the shape every consumer should use. */
export interface OfficeLocationInfo {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** Geofence radius in metres. */
  radiusM: number;
}

const DEFAULT_RADIUS_M = 150;

function normalizeLocation(v: unknown): OfficeLocationInfo | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.lat !== 'number' || !Number.isFinite(r.lat)) return null;
  if (typeof r.lng !== 'number' || !Number.isFinite(r.lng)) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : `loc-${r.lat},${r.lng}`,
    name: typeof r.name === 'string' && r.name.trim() ? r.name : 'Office location',
    address: typeof r.address === 'string' ? r.address : '',
    lat: r.lat,
    lng: r.lng,
    radiusM: Math.round(posNum(r.radiusM, posNum(r.radiusMeters, DEFAULT_RADIUS_M))),
  };
}

/**
 * Geofence office locations. Canonical source: the company singleton's
 * `officeLocations` field (an explicitly empty array is a deliberate
 * "no geofences" configuration and is respected). Falls back to legacy
 * `kind:'officeLocation'` records (radiusMeters → radiusM) when the field
 * is absent. Returns [] when neither exists — callers apply their own
 * demo defaults if they need them.
 */
export function getOfficeLocations(): OfficeLocationInfo[] {
  const company = companyRow() as (Settings & { officeLocations?: unknown[] }) | undefined;
  if (Array.isArray(company?.officeLocations)) {
    return company.officeLocations
      .map(normalizeLocation)
      .filter((l): l is OfficeLocationInfo => l !== null);
  }
  return settingsRows()
    .filter((r) => r.kind === 'officeLocation')
    .map(normalizeLocation)
    .filter((l): l is OfficeLocationInfo => l !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Effective company claim policy. The four scalar fields mirror the Claims
 * module schema (doc id 'claimPolicy'); `monthlyLimits` surfaces the legacy
 * per-category monthly caps from 'ext:payroll'.claimLimits so either
 * convention's edits are visible through one accessor (QA settings B2).
 */
export interface ClaimPolicyInfo {
  mileageRatePerKm: number;   // RM per km
  mealDailyLimit: number;     // RM per calendar day
  medicalClaimLimit: number;  // RM per claim
  phoneMonthlyLimit: number;  // RM per calendar month
  /** Per-category monthly caps (legacy settings convention). */
  monthlyLimits: Record<ClaimCategory, number>;
}

/** Module defaults — identical to claims/claimPolicy.ts DEFAULT_POLICY. */
export const DEFAULT_CLAIM_POLICY = {
  mileageRatePerKm: 0.8,
  mealDailyLimit: 50,
  medicalClaimLimit: 200,
  phoneMonthlyLimit: 100,
} as const;

/** Legacy monthly-cap defaults (settings module wave-1 seed values). */
export const DEFAULT_CLAIM_LIMITS: Record<ClaimCategory, number> = {
  travel: 500,
  meal: 300,
  medical: 1000,
  parking: 150,
  telephone: 100,
  training: 2000,
  other: 200,
};

/** Merge: defaults → active company's config.claimPolicy → settings docs. */
export function getClaimPolicy(): ClaimPolicyInfo {
  const cfg = getActiveCompany()?.config.claimPolicy ?? {};
  const rows = settingsRows();
  const doc = rows.find((r) => r.id === 'claimPolicy');
  const payroll = rows.find((r) => r.id === 'ext:payroll');
  const legacyLimits = (payroll?.claimLimits ?? {}) as Partial<Record<ClaimCategory, unknown>>;
  const monthlyLimits = { ...DEFAULT_CLAIM_LIMITS };
  (Object.keys(monthlyLimits) as ClaimCategory[]).forEach((k) => {
    monthlyLimits[k] = posNum(legacyLimits[k], monthlyLimits[k]);
  });
  return {
    mileageRatePerKm: posNum(doc?.mileageRatePerKm, posNum(cfg.mileageRatePerKm, DEFAULT_CLAIM_POLICY.mileageRatePerKm)),
    mealDailyLimit: posNum(doc?.mealDailyLimit, posNum(cfg.mealDailyLimit, DEFAULT_CLAIM_POLICY.mealDailyLimit)),
    medicalClaimLimit: posNum(doc?.medicalClaimLimit, posNum(cfg.medicalClaimLimit, DEFAULT_CLAIM_POLICY.medicalClaimLimit)),
    phoneMonthlyLimit: posNum(doc?.phoneMonthlyLimit, posNum(cfg.phoneMonthlyLimit, DEFAULT_CLAIM_POLICY.phoneMonthlyLimit)),
    monthlyLimits,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leave top-ups (company days ON TOP of EA 1955 statutory tiers)
// ─────────────────────────────────────────────────────────────────────────────

export type TopupLeaveType = 'annual' | 'sick' | 'hospitalization' | 'maternity' | 'paternity';

/** Bonus leave days per type, granted on top of the EA statutory minimums. */
export type LeaveTopupsMap = Record<TopupLeaveType, number>;

/** Zero top-ups — the default when no policy record exists. */
export const ZERO_LEAVE_TOPUPS: LeaveTopupsMap = {
  annual: 0,
  sick: 0,
  hospitalization: 0,
  maternity: 0,
  paternity: 0,
};

/**
 * Company leave top-ups. Base layer: the active company's
 * config.leaveTopUps; overridden by doc id 'ext:leaveTopups' (`days` per
 * type). Consumed by the leave module's entitlement computation (QA settings
 * B3). Missing/invalid values fall back to 0 (never negative).
 */
export function getLeaveTopUps(): LeaveTopupsMap {
  const cfg = getActiveCompany()?.config.leaveTopUps ?? {};
  const doc = settingsRows().find((r) => r.id === 'ext:leaveTopups');
  const days = (doc?.days ?? {}) as Partial<Record<TopupLeaveType, unknown>>;
  const out = { ...ZERO_LEAVE_TOPUPS };
  (Object.keys(out) as TopupLeaveType[]).forEach((k) => {
    out[k] = nonNegNum(days[k], nonNegNum(cfg[k], 0));
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payroll cut-off
// ─────────────────────────────────────────────────────────────────────────────

/** Payroll admin cut-off config from doc id 'ext:payroll'. */
export interface PayrollCutoffInfo {
  /** Day of month (1–28) when attendance/OT/claims close for the month. */
  cutoffDay: number;
  /** ORP day basis (EA 1955 s.60I — 26). */
  workingDaysBasis: number;
}

export const DEFAULT_PAYROLL_CUTOFF: PayrollCutoffInfo = {
  cutoffDay: 25,
  workingDaysBasis: 26,
};

/**
 * Payroll cut-off config. cutoffDay base layer: the active company's
 * config.payrollCutoffDay; overridden by doc id 'ext:payroll'. workingDaysBasis
 * defaults to the settings module's seed value.
 */
export function getPayrollCutoff(): PayrollCutoffInfo {
  const cfgDay = getActiveCompany()?.config.payrollCutoffDay;
  const doc = settingsRows().find((r) => r.id === 'ext:payroll');
  return {
    cutoffDay: Math.min(28, Math.max(1, Math.round(posNum(doc?.cutoffDay, posNum(cfgDay, DEFAULT_PAYROLL_CUTOFF.cutoffDay))))),
    workingDaysBasis: posNum(doc?.workingDaysBasis, DEFAULT_PAYROLL_CUTOFF.workingDaysBasis),
  };
}
