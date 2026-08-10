/**
 * Role context OBJECT + hook — split out of roleContext.tsx so the provider
 * file exports only components (react-refresh/only-export-components).
 * `RoleProvider` stays in `./roleContext`.
 */
import { createContext, useContext } from 'react';

export type AppRole = 'Admin' | 'HR' | 'Manager' | 'Employee';

export interface RoleContextValue {
  role: AppRole;
  setRole: (role: AppRole) => void;
}

export const RoleContext = createContext<RoleContextValue>({ role: 'Admin', setRole: () => undefined });

export function useRole(): RoleContextValue {
  return useContext(RoleContext);
}
