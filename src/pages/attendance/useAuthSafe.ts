/**
 * Safe wrapper around `useAuth()` for the attendance module.
 *
 * The AuthProvider is wired into App.tsx in a later integration wave. Until
 * then `useAuth()` throws outside the provider — this hook catches that and
 * returns `null`, so attendance pages fail OPEN pre-integration (current demo
 * behaviour: kiosk-style pickers, no scoping) and enforce role scoping
 * automatically once auth is live.
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

/** Pre-integration (null auth) behaves as Admin to preserve demo behaviour. */
export function isAdminOrHR(auth: AuthContextValue | null): boolean {
  return !auth || auth.role === 'Admin' || auth.role === 'HR';
}

/** Kiosk mode: Admin/HR (or pre-integration demo) may clock on behalf of any employee. */
export function isKiosk(auth: AuthContextValue | null): boolean {
  return isAdminOrHR(auth);
}

/** Display name for audit entries. */
export function actorName(auth: AuthContextValue | null): string {
  return auth?.user?.username ?? 'attendance module';
}
