/**
 * Auth-scoping bridge for the Leave + Holidays module (Wave 2, QA B2).
 *
 * Prefers the Wave-1 mock auth (`@/lib/authContext.useAuth`) for role,
 * linked employeeId and data scoping. The AuthProvider is wired into the
 * app tree in a later integration wave — until then `useAuth` throws, and
 * this hook falls back to the legacy roleContext role with permissive
 * (unscoped) visibility so the module keeps working exactly as before.
 *
 * Scoping semantics once mock auth is active (from @/lib/authContext):
 *   - Admin / HR → see everything.
 *   - Manager    → own department only.
 *   - Employee   → own records only (fail closed when unlinked).
 */
import { useAuth, type AuthContextValue } from '@/lib/authContext';
import { useRole, type AppRole } from '@/lib/roleContext';
import type { Employee } from '@/lib/types';

export interface AuthScope {
  /** Effective role (mock-auth role when a session exists, else legacy role). */
  role: AppRole;
  /** Linked Employee id of the acting user; null for standalone accounts / pre-auth. */
  employeeId: string | null;
  /** True when mock-auth scoping is active (AuthProvider mounted). */
  scoped: boolean;
  canViewEmployee: (id: string) => boolean;
  scopeEmployees: (list: Employee[]) => Employee[];
  scopeByEmployee: <T>(list: T[], getEmpId: (item: T) => string) => T[];
  /** Audit actor label, e.g. "HR (demo)". */
  actor: string;
  /** Admin or HR — privileged manage/sync actions. */
  isHROrAdmin: boolean;
  /** Admin, HR or Manager — may see the approval queue. */
  canApprove: boolean;
}

const permissive = {
  canViewEmployee: (_id: string) => true,
  scopeEmployees: (list: Employee[]) => list,
  scopeByEmployee: <T,>(list: T[], _getEmpId: (item: T) => string) => list,
};

function build(role: AppRole, employeeId: string | null, scoped: boolean, auth: AuthContextValue | null): AuthScope {
  return {
    role,
    employeeId,
    scoped,
    canViewEmployee: auth ? auth.canViewEmployee : permissive.canViewEmployee,
    scopeEmployees: auth ? auth.scopeEmployees : permissive.scopeEmployees,
    scopeByEmployee: auth ? auth.scopeByEmployee : permissive.scopeByEmployee,
    actor: `${role} (demo)`,
    isHROrAdmin: role === 'Admin' || role === 'HR',
    canApprove: role === 'Admin' || role === 'HR' || role === 'Manager',
  };
}

export function useAuthScope(): AuthScope {
  const { role: legacyRole } = useRole();
  let auth: AuthContextValue | null = null;
  try {
    // AuthProvider lands in the integration wave; useAuth throws before that.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    auth = useAuth();
  } catch {
    auth = null;
  }
  if (!auth) return build(legacyRole, null, false, null);
  // AuthRole 'SuperAdmin' maps onto 'Admin' (full visibility) for AppRole consumers.
  const sessionRole: AppRole = auth.role === 'SuperAdmin' ? 'Admin' : auth.role ?? legacyRole;
  return build(sessionRole, auth.employeeId, true, auth);
}
