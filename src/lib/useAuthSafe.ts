/**
 * Safe wrapper around `useAuth()` that tolerates the provider being absent.
 *
 * `<AuthProvider>` is wired into App.tsx, but pages rendered outside it (or
 * before it mounts) would see `useAuth()` throw; this hook catches that and
 * returns `null`, so modules fail OPEN pre-integration (demo behaviour) and
 * enforce role scoping automatically once a real session is present.
 *
 * The hook call itself is unconditional, so hook order is preserved.
 *
 * Consolidated from the four divergent per-module copies (attendance, claims,
 * kpi, payroll) — this is the union of their helpers.
 */
import { useAuth, type AuthContextValue } from '@/lib/useAuth';

export function useAuthSafe(): AuthContextValue | null {
  try {
    return useAuth();
  } catch {
    return null; // AuthProvider not mounted (pre-integration wave)
  }
}

/** True when the current session may see IC / bank details (Admin or HR). */
export function canSeeSensitive(auth: AuthContextValue | null): boolean {
  if (!auth) return true; // pre-integration: keep existing behaviour
  return auth.role === 'Admin' || auth.role === 'HR';
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
