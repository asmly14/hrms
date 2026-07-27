/**
 * Auth access that tolerates the provider being absent.
 *
 * `<AuthProvider>` is wired into App.tsx in a later integration wave. Until
 * then `useAuth()` throws (no provider in the tree); this wrapper catches that
 * and returns `null` so the module can fall back to the legacy role stub +
 * acting-as selector. Once the provider lands, the real session drives all
 * scoping/identity with zero further changes here.
 *
 * Hook-order safe: the underlying `useContext` runs unconditionally on every
 * render before any throw, so the call shape never changes between renders.
 */
import { useAuth, type AuthContextValue } from '@/lib/authContext';

export function useAuthSafe(): AuthContextValue | null {
  try {
    return useAuth();
  } catch {
    return null;
  }
}
