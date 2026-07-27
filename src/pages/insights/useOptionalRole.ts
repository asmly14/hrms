/**
 * Reads the auth role when an AuthProvider is mounted; returns null when the
 * provider isn't wired yet (pre-integration builds). Fail-open by design:
 * route-level guards land with the integration wave — this helper only backs
 * the in-page role guard card, never data exposure.
 *
 * `useAuth()` is called unconditionally every render (hook order is stable);
 * the try/catch only absorbs the "no provider" throw.
 */
import { useAuth } from '@/lib/authContext';
import type { AuthRole } from '@/lib/auth';

export function useOptionalRole(): AuthRole | null {
  try {
    return useAuth().role;
  } catch {
    return null;
  }
}
