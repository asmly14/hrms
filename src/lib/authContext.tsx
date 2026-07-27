/**
 * Auth context — React binding for the mock auth core (`src/lib/auth.ts`).
 *
 * Provides the current session user plus **data-scoping helpers** that every
 * module page should apply after reading a collection from `useCollection`.
 *
 * Scoping rules (WITHIN the active tenant — the db layer already scopes all
 * collections to the logged-in user's company):
 *   - SuperAdmin    → see everything (cross-company via TenantProvider).
 *   - Admin / HR    → see everything.
 *   - Manager     → see employees in their OWN department only
 *                   (department resolved via the linked Employee record).
 *   - Employee    → see only their own records.
 *
 * Usage pattern for module pages (see docs/auth-integration.md):
 *
 *   const { scopeByEmployee } = useAuth();
 *   const { items: attendance } = useCollection<AttendanceRecord>('attendance');
 *   const visible = scopeByEmployee(attendance, (a) => a.employeeId);
 *
 * The helpers are pure functions of (role, employeeId, department) so they
 * are trivially testable and safe to call inside useMemo.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import {
  currentUser, login as authLogin, logout as authLogout, seedUsers,
  type LoginResult, type PublicUser,
} from './auth';
import { useCollection } from './db';
import type { Employee } from './types';

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

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(() => currentUser());

  // Make sure the account directory exists on boot (idempotent, merge-based).
  useEffect(() => {
    seedUsers();
    // Re-resolve in case the directory was (re)built after the session.
    setUser(currentUser());
  }, []);

  const { items: employees } = useCollection<Employee>('employees');

  const login = useCallback((username: string, password: string): LoginResult => {
    const result = authLogin(username, password);
    if (result.ok) setUser(result.user);
    return result;
  }, []);

  const logout = useCallback(() => {
    authLogout();
    setUser(null);
  }, []);

  const role = user?.role ?? null;
  const employeeId = user?.employeeId ?? null;
  const companyId = user?.companyId ?? null;
  const isSuperAdmin = role === 'SuperAdmin';

  /** The manager's own departmentId (null for non-managers or unlinked). */
  const managerDepartmentId = useMemo(() => {
    if (role !== 'Manager' || !employeeId) return null;
    return employees.find((e) => e.id === employeeId)?.departmentId ?? null;
  }, [role, employeeId, employees]);

  /**
   * Set of employee ids the current user may see. `null` means "unrestricted"
   * (SuperAdmin/Admin/HR). Computed once per (role, employeeId, employees)
   * change so the scoping helpers below are cheap.
   */
  const visibleEmployeeIds = useMemo<Set<string> | null>(() => {
    if (role === 'SuperAdmin' || role === 'Admin' || role === 'HR') return null; // unrestricted
    if (role === 'Manager') {
      if (!managerDepartmentId) return new Set(employeeId ? [employeeId] : []);
      const ids = employees
        .filter((e) => e.departmentId === managerDepartmentId)
        .map((e) => e.id);
      if (employeeId && !ids.includes(employeeId)) ids.push(employeeId);
      return new Set(ids);
    }
    // Employee (or unknown role): self only.
    return new Set(employeeId ? [employeeId] : []);
  }, [role, employeeId, employees, managerDepartmentId]);

  const canViewEmployee = useCallback(
    (id: string): boolean => {
      if (visibleEmployeeIds === null) return true;
      return visibleEmployeeIds.has(id);
    },
    [visibleEmployeeIds],
  );

  const scopeEmployees = useCallback(
    (list: Employee[]): Employee[] => {
      if (visibleEmployeeIds === null) return list;
      return list.filter((e) => visibleEmployeeIds.has(e.id));
    },
    [visibleEmployeeIds],
  );

  const scopeByEmployee = useCallback(
    <T,>(list: T[], getEmpId: (item: T) => string): T[] => {
      if (visibleEmployeeIds === null) return list;
      return list.filter((item) => visibleEmployeeIds.has(getEmpId(item)));
    },
    [visibleEmployeeIds],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      role,
      employeeId,
      companyId,
      isSuperAdmin,
      isAuthenticated: user !== null,
      login,
      logout,
      canViewEmployee,
      scopeEmployees,
      scopeByEmployee,
    }),
    [user, role, employeeId, companyId, isSuperAdmin, login, logout, canViewEmployee, scopeEmployees, scopeByEmployee],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Access the auth context. Must be used inside <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
