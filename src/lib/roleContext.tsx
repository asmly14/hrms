/**
 * App-wide role switcher (Admin / HR / Manager / Employee).
 * Controls which nav items AppLayout shows. Persisted to localStorage.
 * This is a demo stub — no authentication.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type AppRole = 'Admin' | 'HR' | 'Manager' | 'Employee';

const ROLE_KEY = 'myhrms:role';

interface RoleContextValue {
  role: AppRole;
  setRole: (role: AppRole) => void;
}

const RoleContext = createContext<RoleContextValue>({ role: 'Admin', setRole: () => undefined });

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

export function useRole(): RoleContextValue {
  return useContext(RoleContext);
}
