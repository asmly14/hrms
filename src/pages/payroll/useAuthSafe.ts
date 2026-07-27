/**
 * Safe wrapper around `useAuth()` for the payroll module.
 *
 * The AuthProvider is wired into App.tsx in a later integration wave. Until
 * then `useAuth()` throws outside the provider — this hook catches that and
 * returns `null`, so payroll pages fail OPEN pre-integration (current demo
 * behaviour) and enforce role scoping automatically once auth is live.
 *
 * The hook call itself is unconditional, so hook order is preserved.
 */
import { useAuth, type AuthContextValue } from '@/lib/authContext';

export function useAuthSafe(): AuthContextValue | null {
  try {
    return useAuth();
  } catch {
    return null; // AuthProvider not mounted yet (pre-integration wave)
  }
}

/** True when the current session may see IC / bank details (Admin or HR). */
export function canSeeSensitive(auth: AuthContextValue | null): boolean {
  if (!auth) return true; // pre-integration: keep existing behaviour
  return auth.role === 'Admin' || auth.role === 'HR';
}
