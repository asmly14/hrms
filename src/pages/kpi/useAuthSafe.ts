/**
 * Safe wrapper around `useAuth()` for the KPI module.
 *
 * The AuthProvider is wired into App.tsx in a later integration wave. Until
 * then `useAuth()` throws outside the provider — this hook catches that and
 * returns `null`, so KPI pages fail OPEN pre-integration (current demo
 * behaviour) and enforce role gating automatically once auth is live.
 *
 * The hook call itself is unconditional, so hook order is preserved.
 * (Same pattern as `pages/payroll/useAuthSafe.ts`.)
 */
import { useAuth, type AuthContextValue } from '@/lib/authContext';

export function useAuthSafe(): AuthContextValue | null {
  try {
    return useAuth();
  } catch {
    return null; // AuthProvider not mounted yet (pre-integration wave)
  }
}
