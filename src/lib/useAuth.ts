/**
 * Auth context OBJECT + hook — split out of authContext.tsx so the provider
 * file exports only components (react-refresh/only-export-components). The
 * context value interface and the `useAuth` hook live here; `AuthProvider`
 * stays in `./authContext`.
 *
 * See `./authContext` for the scoping rules and usage pattern.
 */
import { createContext, useContext } from 'react';
import type { PublicUser } from './auth';
import type { Employee } from './types';
import type { LoginResult } from './auth';

export interface AuthContextValue {
  /** The logged-in user's public profile (null when logged out). */
  user: PublicUser | null;
  /** Convenience: user?.role ?? null. */
  role: PublicUser['role'] | null;
  /** Convenience: user?.employeeId ?? null — the linked Employee record id. */
  employeeId: string | null;
  /** Tenant of the logged-in account (null only for SuperAdmin). */
  companyId: string | null;
  /** True for the cross-company system SuperAdmin. */
  isSuperAdmin: boolean;
  /** True while a valid session exists. */
  isAuthenticated: boolean;
  /**
   * Attempt a login; updates context state on success.
   * Returns the same LoginResult as lib/auth so pages can show error states.
   */
  login: (username: string, password: string) => LoginResult;
  /** End the session and clear context state. */
  logout: () => void;
  /**
   * Can the current user view records belonging to employee `id`?
   * Admin/HR → always true. Manager → true when that employee is in the
   * manager's department. Employee → true only for their own id.
   */
  canViewEmployee: (id: string) => boolean;
  /**
   * Filter an Employee list to the visible scope.
   * Admin/HR → list unchanged. Manager → own department only.
   * Employee → only their own record.
   */
  scopeEmployees: (list: Employee[]) => Employee[];
  /**
   * Filter ANY collection that carries an employeeId to the visible scope.
   * This is the primary helper module pages should use:
   *
   *   scopeByEmployee(claims, (c) => c.employeeId)
   *
   * Admin/HR → list unchanged. Manager → rows whose employee is in the
   * manager's department. Employee → only rows for their own employeeId.
   * Accounts without a linked employee (standalone admin/hr) are unaffected
   * since they are Admin/HR-scoped anyway; a Manager/Employee account with
   * no employeeId sees nothing (fail closed).
   */
  scopeByEmployee: <T>(list: T[], getEmpId: (item: T) => string) => T[];
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** Access the auth context. Must be used inside <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
