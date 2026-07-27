/**
 * Company Setup store — shared state helpers for the /company module.
 *
 * Everything here reads/writes the ACTIVE company's `Company.config` (and a
 * few top-level Company fields) via `upsertCompany()` + `refreshCompanies()`.
 * The tenant layer auto-scopes: regular Admin/HR users are pinned to their
 * own company; SuperAdmin edits whichever company they have entered.
 *
 * Resolution contract (docs/tenant-api.md §3): consumers layer
 *   system defaults → Company.config → tenant-scoped settings docs.
 * Where a legacy settings doc exists for the same knob (claim policy, leave
 * top-ups, payroll cut-off, company profile singleton), saves MIRROR the
 * value into that doc as well so older readers and the new config never
 * diverge (see `mirrorSettingsDoc` / `mirrorCompanySingleton`).
 */
import { useEffect } from 'react';
import { getCollection, logAudit, setCollection, upsertCompany } from '@/lib/db';
import { useTenant } from '@/lib/tenantContext';
import type { Company } from '@/lib/types';

/** Actor name stamped on audit entries made from the Company Setup module. */
export const COMPANY_ACTOR = 'Admin (demo)';

/** Row shape used to read the mixed tenant-scoped 'settings' collection. */
interface SettingsRow {
  id: string;
  kind?: string;
  [key: string]: unknown;
}

/**
 * Shallow-merge a patch into one settings doc of the ACTIVE tenant (created
 * when absent). Used to keep legacy settings docs in sync with values whose
 * canonical home is now `Company.config`.
 */
export function mirrorSettingsDoc(id: string, patch: Record<string, unknown>): void {
  const rows = getCollection<SettingsRow>('settings');
  if (rows.length === 0) return; // seed not loaded yet — nothing to mirror into
  const exists = rows.some((r) => r.id === id);
  const next = exists
    ? rows.map((r) => (r.id === id ? ({ ...r, ...patch } as SettingsRow) : r))
    : ([...rows, { id, ...patch }] as SettingsRow[]);
  setCollection('settings', next);
}

/**
 * Shallow-merge a patch into the company profile singleton (settings doc id
 * 'company') of the ACTIVE tenant — keeps the payslip/statutory-form readers
 * (which read the singleton) aligned with edits made on the Company record.
 */
export function mirrorCompanySingleton(patch: Record<string, unknown>): void {
  mirrorSettingsDoc('company', patch);
}

export interface CompanySetupApi {
  /** The active company, or null in the SuperAdmin system view / when unknown. */
  company: Company | null;
  /** True when no company is active (SuperAdmin system view). */
  isSystemView: boolean;
  /**
   * Apply a mutation to the active company, persist it via upsertCompany(),
   * refresh the tenant directory and write an audit entry.
   */
  save: (mutate: (company: Company) => Company, auditDetail: string) => void;
}

/** Root hook for every Company Setup section. */
export function useCompanySetup(): CompanySetupApi {
  const { activeCompany, isSystemView, refreshCompanies } = useTenant();

  const save = (mutate: (company: Company) => Company, auditDetail: string) => {
    if (!activeCompany) return;
    const next = mutate(activeCompany);
    upsertCompany(next);
    refreshCompanies();
    logAudit({
      actorName: COMPANY_ACTOR,
      action: 'company.config.update',
      entity: 'companies',
      entityId: next.id,
      detail: auditDetail,
    });
  };

  return { company: activeCompany, isSystemView, save };
}

/**
 * Unsaved-changes guard: warns on browser tab close / reload while `dirty`.
 * Sections also render an inline "unsaved changes" indicator off the same flag.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}

/** Small amber "unsaved changes" pill shown next to save actions. */
export const UNSAVED_HINT = 'You have unsaved changes';
