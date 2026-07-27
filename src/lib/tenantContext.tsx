/**
 * Tenant context — React binding over the multi-tenant db layer.
 *
 * The ACTIVE company determines which physical storage namespace every
 * `useCollection` / `getCollection` / `setCollection` call touches
 * (see lib/db.ts). This provider exposes that state to the UI:
 *
 *   const { activeCompany, companies, setActiveCompany, leaveCompany } = useTenant();
 *
 * Rules:
 *  - Regular users (Admin/HR/Manager/Employee) are PINNED to their account's
 *    companyId — setActiveCompany/leaveCompany are no-ops for them.
 *  - SuperAdmin has no fixed company: setActiveCompany(id) "enters" a company
 *    (all pages then scope to it automatically); leaveCompany() returns to the
 *    system view (activeCompanyId === null, isSystemView === true).
 *
 * Login (lib/auth.ts) sets the active tenant directly on the db layer; this
 * provider subscribes to those changes, so no manual sync is needed.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import {
  getActiveTenantId, getCompanies, setActiveTenantId, subscribeTenant,
  seedTenantIfEmpty,
} from './db';
import { getSession } from './auth';
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

const TenantContext = createContext<TenantContextValue | null>(null);

/** Is the current session a SuperAdmin? (Read fresh — survives provider ordering.) */
function sessionIsSuperAdmin(): boolean {
  return getSession()?.role === 'SuperAdmin';
}

/** Company pinned to the current session (null for SuperAdmin / logged out). */
function sessionCompanyId(): string | null {
  return getSession()?.companyId ?? null;
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const [companies, setCompanies] = useState<Company[]>(() => getCompanies());
  const [activeCompanyId, setActiveCompanyIdState] = useState<string | null>(() =>
    getActiveTenantId(),
  );

  // Stay in sync when the active tenant is changed outside React (auth login,
  // devtools) — db.setActiveTenantId notifies subscribers.
  useEffect(
    () =>
      subscribeTenant(() => {
        setActiveCompanyIdState(getActiveTenantId());
        setCompanies(getCompanies());
      }),
    [],
  );

  // Pin regular sessions to their own company. A SuperAdmin session keeps
  // whatever view it had (system view after fresh login).
  useEffect(() => {
    const pinned = sessionCompanyId();
    if (!sessionIsSuperAdmin() && pinned && getActiveTenantId() !== pinned) {
      setActiveTenantId(pinned);
    }
  }, []);

  const setActiveCompany = useCallback((companyId: string) => {
    if (!sessionIsSuperAdmin() && sessionCompanyId() !== companyId) {
      // Regular users are pinned to their own company — ignore the switch.
      console.warn(`[tenant] setActiveCompany('${companyId}') ignored: session is pinned to another company.`);
      return;
    }
    seedTenantIfEmpty(companyId); // first entry seeds demo data (idempotent)
    setActiveTenantId(companyId);
  }, []);

  const leaveCompany = useCallback(() => {
    if (!sessionIsSuperAdmin()) {
      console.warn('[tenant] leaveCompany() ignored: only SuperAdmin can enter the system view.');
      return;
    }
    setActiveTenantId(null);
  }, []);

  const refreshCompanies = useCallback(() => {
    setCompanies(getCompanies());
  }, []);

  const activeCompany = useMemo(
    () => companies.find((c) => c.id === activeCompanyId) ?? null,
    [companies, activeCompanyId],
  );

  const value = useMemo<TenantContextValue>(
    () => ({
      companies,
      activeCompanyId,
      activeCompany,
      isSystemView: activeCompanyId === null,
      setActiveCompany,
      leaveCompany,
      refreshCompanies,
    }),
    [companies, activeCompanyId, activeCompany, setActiveCompany, leaveCompany, refreshCompanies],
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

/** Access the tenant context. Must be used inside <TenantProvider>. */
export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used within <TenantProvider>');
  return ctx;
}
