/**
 * Extended settings store (M9).
 *
 * The core `Settings` type (src/lib/types.ts) is a fixed singleton with
 * id 'company'. Admin data lives in the SAME 'settings' collection, using
 * the canonical contracts that the rest of the app reads:
 *
 *  - Geofence locations  → `officeLocations` array ON the company singleton.
 *    This is the shape the Attendance module (`SettingsX.officeLocations`)
 *    and the wave-2 `lib/appSettings.ts getOfficeLocations()` helper read.
 *    Each entry carries both `radiusM` (attendance contract) and a mirrored
 *    `radiusMeters` (legacy settings name) so either reader works.
 *  - Claim policy        → document id 'claimPolicy' with the exact schema
 *    the Claims module (`resolvePolicy`) and `getClaimPolicy()` read:
 *    mileageRatePerKm / mealDailyLimit / medicalClaimLimit / phoneMonthlyLimit.
 *  - Leave top-ups       → document id 'ext:leaveTopups' (`days` per type),
 *    consumed by the core entitlement logic via `getLeaveTopUps()`.
 *  - Payroll admin       → document id 'ext:payroll' (cutoffDay read by
 *    `getPayrollCutoff()`, workingDaysBasis, HRD employer no is separate).
 *  - Company extras      → document id 'ext:company' (HRD Corp reg no).
 *
 * Wave-2 note: `lib/appSettings.ts` is being added by another agent this
 * wave, so this store writes the documented storage contract directly
 * instead of importing the helper (keeps this scope tsc-clean standalone).
 */
import { useEffect } from 'react';
import { getCollection, setCollection, uid, useCollection } from '@/lib/db';
import type { Settings } from '@/lib/types';

export const COMPANY_ID = 'company';
const COMPANY_EXTRAS_ID = 'ext:company';
const PAYROLL_POLICY_ID = 'ext:payroll';
const LEAVE_TOPUPS_ID = 'ext:leaveTopups';
/** Canonical claim-policy doc id — must match Claims' POLICY_DOC_ID. */
const CLAIM_POLICY_ID = 'claimPolicy';

/** Row shape used to read the mixed 'settings' collection. */
export interface SettingsRow {
  id: string;
  kind?: string;
  [key: string]: unknown;
}

/** Employer numbers that are not part of the core Settings type. */
export interface CompanyExtras {
  id: string;
  kind: 'companyExtras';
  hrdCorpRegNo: string;
}

/**
 * Payroll admin policy — cut-off day + ORP day basis.
 * (Per-category claim caps moved to the canonical 'claimPolicy' doc, which
 * is the schema the Claims module actually reads.)
 */
export interface PayrollPolicy {
  id: string;
  kind: 'payrollPolicy';
  cutoffDay: number;
  workingDaysBasis: number;
}

/**
 * Company claim policy — EXACT schema the Claims module's resolvePolicy()
 * reads from doc id 'claimPolicy' (and lib getClaimPolicy() mirrors).
 */
export interface ClaimPolicySettings {
  mileageRatePerKm: number; // RM per km
  mealDailyLimit: number; // RM per calendar day
  medicalClaimLimit: number; // RM per claim
  phoneMonthlyLimit: number; // RM per calendar month
}

/** Defaults mirror claims/claimPolicy.ts DEFAULT_POLICY so behaviour is unchanged. */
export const DEFAULT_CLAIM_POLICY: ClaimPolicySettings = {
  mileageRatePerKm: 0.8,
  mealDailyLimit: 50,
  medicalClaimLimit: 200,
  phoneMonthlyLimit: 100,
};

export type TopupLeaveType = 'annual' | 'sick' | 'hospitalization' | 'maternity' | 'paternity';

/** Company bonus leave days granted ON TOP of EA 1955 statutory minimums. */
export interface LeaveTopups {
  id: string;
  kind: 'leaveTopups';
  days: Record<TopupLeaveType, number>;
}

/**
 * Office / site location used for attendance geofencing. Stored on the
 * company singleton (`Settings.officeLocations`) — the shape the Attendance
 * module and lib getOfficeLocations() read. `radiusMeters` mirrors `radiusM`
 * for readers using the legacy settings field name.
 */
export interface OfficeLocation {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusM: number;
  radiusMeters: number;
}

/** Company singleton with the (extra-contract) geofence field. */
export type CompanySettings = Settings & { officeLocations?: OfficeLocation[] };

export const TOPUP_LEAVE_TYPES: { value: TopupLeaveType; label: string }[] = [
  { value: 'annual', label: 'Annual leave' },
  { value: 'sick', label: 'Sick leave' },
  { value: 'hospitalization', label: 'Hospitalization leave' },
  { value: 'maternity', label: 'Maternity leave' },
  { value: 'paternity', label: 'Paternity leave' },
];

function makeLocation(loc: { name: string; address: string; lat: number; lng: number; radiusM: number }): OfficeLocation {
  return { ...loc, id: uid(), radiusMeters: loc.radiusM };
}

function defaultLocations(): OfficeLocation[] {
  return [
    makeLocation({
      name: 'HQ — Menara ASM, Kuala Lumpur',
      address: 'Level 12, Menara ASM, Jalan Sultan Ismail, 50250 Kuala Lumpur',
      lat: 3.1516,
      lng: 101.7036,
      radiusM: 200,
    }),
    makeLocation({
      name: 'Shah Alam Operations Site',
      address: 'Persiaran Perbandaran, Section 14, 40000 Shah Alam, Selangor',
      lat: 3.0733,
      lng: 101.5185,
      radiusM: 300,
    }),
  ];
}

/** Legacy wave-1 location row (kind-tagged record, radiusMeters only). */
interface LegacyLocationRow {
  id: string;
  kind: 'officeLocation';
  name?: unknown;
  address?: unknown;
  lat?: unknown;
  lng?: unknown;
  radiusMeters?: unknown;
  radiusM?: unknown;
}

function migrateLegacyLocation(row: LegacyLocationRow): OfficeLocation {
  const radius =
    typeof row.radiusM === 'number' && Number.isFinite(row.radiusM) && row.radiusM > 0
      ? row.radiusM
      : typeof row.radiusMeters === 'number' && Number.isFinite(row.radiusMeters) && row.radiusMeters > 0
        ? row.radiusMeters
        : 150;
  return {
    id: typeof row.id === 'string' && row.id ? row.id : uid(),
    name: typeof row.name === 'string' && row.name.trim() ? row.name : 'Office location',
    address: typeof row.address === 'string' ? row.address : '',
    lat: typeof row.lat === 'number' && Number.isFinite(row.lat) ? row.lat : 0,
    lng: typeof row.lng === 'number' && Number.isFinite(row.lng) ? row.lng : 0,
    radiusM: Math.round(radius),
    radiusMeters: Math.round(radius),
  };
}

/**
 * Appends any missing extended records and migrates legacy geofence rows.
 * Idempotent — re-reads storage first, so it is safe under StrictMode
 * double effects and re-creates the records after a demo-data reseed.
 *
 * Locations: defaults are written ONTO the company singleton only when its
 * `officeLocations` field is absent (first init / post-reseed). An explicit
 * empty array (admin deleted every location) is respected and NEVER
 * re-seeded — the empty state stays reachable.
 */
function ensureExtendedRecords(): void {
  const current = getCollection<SettingsRow>('settings');
  if (current.length === 0) return; // seed not loaded yet — wait for it

  let next = current;
  let changed = false;
  const patch = (rows: SettingsRow[]) => {
    next = rows;
    changed = true;
  };

  if (!next.some((r) => r.id === COMPANY_EXTRAS_ID)) {
    patch([...next, { id: COMPANY_EXTRAS_ID, kind: 'companyExtras', hrdCorpRegNo: 'HRDCorp 012345678' }]);
  }
  if (!next.some((r) => r.id === PAYROLL_POLICY_ID)) {
    patch([
      ...next,
      {
        id: PAYROLL_POLICY_ID,
        kind: 'payrollPolicy',
        cutoffDay: 25,
        workingDaysBasis: 26, // EA 1955 s.60I — ORP = monthly wages / 26
      },
    ]);
  }
  if (!next.some((r) => r.id === LEAVE_TOPUPS_ID)) {
    patch([
      ...next,
      {
        id: LEAVE_TOPUPS_ID,
        kind: 'leaveTopups',
        days: { annual: 2, sick: 0, hospitalization: 0, maternity: 0, paternity: 0 },
      },
    ]);
  }
  if (!next.some((r) => r.id === CLAIM_POLICY_ID)) {
    patch([...next, { id: CLAIM_POLICY_ID, ...DEFAULT_CLAIM_POLICY }]);
  }

  // ── Geofence locations on the company singleton ─────────────────────────
  const legacyRows = next.filter((r) => r.kind === 'officeLocation') as unknown as LegacyLocationRow[];
  const company = next.find((r) => r.id === COMPANY_ID) as CompanySettings | undefined;
  let working = next;
  if (company && !Array.isArray(company.officeLocations)) {
    // First init (or post-reseed): migrate legacy rows if present, else seed
    // defaults. An existing empty array is deliberate — never re-seeded.
    const locations = legacyRows.length > 0 ? legacyRows.map(migrateLegacyLocation) : defaultLocations();
    working = working.map((r) =>
      r.id === COMPANY_ID ? ({ ...r, officeLocations: locations } as SettingsRow) : r,
    );
  }
  // Drop legacy kind-tagged rows only once the singleton field exists, so
  // they can never be the sole copy that gets deleted.
  const singletonHasLocations = working.some(
    (r) => r.id === COMPANY_ID && Array.isArray((r as unknown as CompanySettings).officeLocations),
  );
  if (legacyRows.length > 0 && singletonHasLocations) {
    working = working.filter((r) => r.kind !== 'officeLocation');
  }
  if (working !== next) patch(working);

  if (changed) setCollection('settings', next);
}

export interface SettingsData {
  /** false while the seed has not delivered the company singleton yet. */
  ready: boolean;
  company: CompanySettings | undefined;
  companyExtras: CompanyExtras | undefined;
  payrollPolicy: PayrollPolicy | undefined;
  claimPolicy: ClaimPolicySettings | undefined;
  leaveTopups: LeaveTopups | undefined;
  locations: OfficeLocation[];
  saveCompany: (patch: Partial<CompanySettings>) => void;
  saveCompanyExtras: (patch: Partial<Omit<CompanyExtras, 'id' | 'kind'>>) => void;
  savePayrollPolicy: (patch: Partial<Omit<PayrollPolicy, 'id' | 'kind'>>) => void;
  saveClaimPolicy: (patch: Partial<ClaimPolicySettings>) => void;
  saveLeaveTopups: (patch: Partial<Omit<LeaveTopups, 'id' | 'kind'>>) => void;
  addLocation: (loc: { name: string; address: string; lat: number; lng: number; radiusM: number }) => void;
  updateLocation: (id: string, patch: Partial<{ name: string; address: string; lat: number; lng: number; radiusM: number }>) => void;
  removeLocation: (id: string) => void;
}

export function useSettingsData(): SettingsData {
  const coll = useCollection<SettingsRow>('settings');
  const { items } = coll;

  // Runs after every render; the storage re-read keeps it a no-op once the
  // extended records exist.
  useEffect(() => {
    ensureExtendedRecords();
  });

  const company = items.find((r) => r.id === COMPANY_ID) as unknown as CompanySettings | undefined;
  const companyExtras = items.find((r) => r.id === COMPANY_EXTRAS_ID) as unknown as CompanyExtras | undefined;
  const payrollPolicy = items.find((r) => r.id === PAYROLL_POLICY_ID) as unknown as PayrollPolicy | undefined;
  const claimPolicyRow = items.find((r) => r.id === CLAIM_POLICY_ID) as
    | ({ id: string } & Partial<ClaimPolicySettings>)
    | undefined;
  const claimPolicy: ClaimPolicySettings | undefined = claimPolicyRow
    ? {
        mileageRatePerKm: claimPolicyRow.mileageRatePerKm ?? DEFAULT_CLAIM_POLICY.mileageRatePerKm,
        mealDailyLimit: claimPolicyRow.mealDailyLimit ?? DEFAULT_CLAIM_POLICY.mealDailyLimit,
        medicalClaimLimit: claimPolicyRow.medicalClaimLimit ?? DEFAULT_CLAIM_POLICY.medicalClaimLimit,
        phoneMonthlyLimit: claimPolicyRow.phoneMonthlyLimit ?? DEFAULT_CLAIM_POLICY.phoneMonthlyLimit,
      }
    : undefined;
  const leaveTopups = items.find((r) => r.id === LEAVE_TOPUPS_ID) as unknown as LeaveTopups | undefined;
  const locations = Array.isArray(company?.officeLocations) ? company.officeLocations : [];

  const writeLocations = (locs: OfficeLocation[]) => {
    coll.update(COMPANY_ID, { officeLocations: locs } as Partial<SettingsRow>);
  };

  return {
    ready: Boolean(company),
    company,
    companyExtras,
    payrollPolicy,
    claimPolicy,
    leaveTopups,
    locations,
    saveCompany: (patch) => coll.update(COMPANY_ID, patch as Partial<SettingsRow>),
    saveCompanyExtras: (patch) => coll.update(COMPANY_EXTRAS_ID, patch as Partial<SettingsRow>),
    savePayrollPolicy: (patch) => coll.update(PAYROLL_POLICY_ID, patch as Partial<SettingsRow>),
    saveClaimPolicy: (patch) => coll.update(CLAIM_POLICY_ID, patch as Partial<SettingsRow>),
    saveLeaveTopups: (patch) => coll.update(LEAVE_TOPUPS_ID, patch as Partial<SettingsRow>),
    addLocation: (loc) => {
      const stored = getCollection<SettingsRow>('settings');
      const comp = stored.find((r) => r.id === COMPANY_ID) as unknown as CompanySettings | undefined;
      const currentLocs = Array.isArray(comp?.officeLocations) ? comp.officeLocations : [];
      writeLocations([...currentLocs, makeLocation(loc)]);
    },
    updateLocation: (id, patch) => {
      const mirrored =
        patch.radiusM != null ? { ...patch, radiusMeters: Math.round(patch.radiusM) } : patch;
      writeLocations(
        locations.map((l) => (l.id === id ? ({ ...l, ...mirrored } as OfficeLocation) : l)),
      );
    },
    removeLocation: (id) => {
      // Writes an (possibly empty) array — ensureExtendedRecords respects an
      // explicit empty list and never resurrects defaults.
      writeLocations(locations.filter((l) => l.id !== id));
    },
  };
}
