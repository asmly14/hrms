/**
 * Tenant context OBJECT + hook — split out of tenantContext.tsx so the
 * provider file exports only components (react-refresh/only-export-components).
 * `TenantProvider` stays in `./tenantContext`; see it for the tenant rules.
 */
import { createContext, useContext } from 'react';
import type { Company } from './types';

export interface TenantContextValue {
  /** All companies in the global directory. */
  companies: Company[];
  /** Active tenant id; null in the SuperAdmin system view. */
  activeCompanyId: string | null;
  /** The active Company record (null in system view / when unknown). */
  activeCompany: Company | null;
  /** True when a SuperAdmin session has no company selected. */
  isSystemView: boolean;
  /**
   * Enter a company. SuperAdmin may enter any company; regular users can only
   * (re)select their own. Seeds the tenant's demo data on first entry.
   */
  setActiveCompany: (companyId: string) => void;
  /** SuperAdmin: leave the current company and return to the system view. */
  leaveCompany: () => void;
  /** Re-read the company directory from storage (after create/update). */
  refreshCompanies: () => void;
}

export const TenantContext = createContext<TenantContextValue | null>(null);

/** Access the tenant context. Must be used inside <TenantProvider>. */
export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used within <TenantProvider>');
  return ctx;
}
