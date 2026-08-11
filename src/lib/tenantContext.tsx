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
  useCallback, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import {
  getActiveTenantId, getCompanies, setActiveTenantId, subscribeTenant,
  seedTenantIfEmpty, trialStatusOf,
} from './db';
import { auditImpersonation, getSession } from './auth';
import { TenantContext, type TenantContextValue } from './useTenant';
import type { Company } from './types';

export type { TenantContextValue } from './useTenant';

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
    // Impersonation audit (audit-multitenant §4.2): a SuperAdmin ENTERING a
    // company is a cross-tenant access event — log it to the global system
    // audit. Skipped when re-selecting the already-active company.
    if (sessionIsSuperAdmin() && getActiveTenantId() !== companyId) {
      auditImpersonation('enter', companyId);
    }
    seedTenantIfEmpty(companyId); // first entry seeds demo data (idempotent)
    setActiveTenantId(companyId);
  }, []);

  const leaveCompany = useCallback(() => {
    if (!sessionIsSuperAdmin()) {
      console.warn('[tenant] leaveCompany() ignored: only SuperAdmin can enter the system view.');
      return;
    }
    // Impersonation audit: log the EXIT before clearing the pointer so the
    // entry still carries the company being left.
    const current = getActiveTenantId();
    if (current) auditImpersonation('exit', current);
    setActiveTenantId(null);
  }, []);

  const refreshCompanies = useCallback(() => {
    setCompanies(getCompanies());
  }, []);

  const activeCompany = useMemo(
    () => companies.find((c) => c.id === activeCompanyId) ?? null,
    [companies, activeCompanyId],
  );

  // Trial state of the ACTIVE company (null in system view). Drives the
  // SuperAdmin trial-expired banner; the login gate resolves it independently
  // in lib/auth.ts via the same trialStatusOf().
  const trialStatus = useMemo(
    () => (activeCompany ? trialStatusOf(activeCompany) : null),
    [activeCompany],
  );

  const value = useMemo<TenantContextValue>(
    () => ({
      companies,
      activeCompanyId,
      activeCompany,
      isSystemView: activeCompanyId === null,
      trialStatus,
      setActiveCompany,
      leaveCompany,
      refreshCompanies,
    }),
    [companies, activeCompanyId, activeCompany, trialStatus, setActiveCompany, leaveCompany, refreshCompanies],
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}