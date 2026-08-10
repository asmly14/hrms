/**
 * App-wide role switcher (Admin / HR / Manager / Employee).
 * Controls which nav items AppLayout shows. Persisted to localStorage.
 * This is a demo stub — no authentication.
 *
 * The context object + `useRole` hook live in `./useRole` (split so this file
 * exports only components for fast refresh).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { RoleContext, type AppRole } from './useRole';

export type { AppRole, RoleContextValue } from './useRole';

const ROLE_KEY = 'myhrms:role';

export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<AppRole>(() => {
    try {
      return (localStorage.getItem(ROLE_KEY) as AppRole) || 'Admin';
    } catch {
      return 'Admin';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(ROLE_KEY, role);
    } catch {
      /* ignore */
    }
  }, [role]);

  return <RoleContext.Provider value={{ role, setRole: setRoleState }}>{children}</RoleContext.Provider>;
}
