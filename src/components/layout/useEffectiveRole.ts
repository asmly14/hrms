/**
 * Effective-role hook, extracted from AppLayout so shell widgets can use it
 * without an import cycle. AppLayout re-exports it for existing consumers.
 */
import { useAuth } from '@/lib/useAuth';
import { useRole, type AppRole } from '@/lib/useRole';

const DEV_ROLE_OVERRIDE_KEY = 'myhrms:devRoleOverride';

/**
 * Effective role = dev-only override (localStorage 'myhrms:devRoleOverride' = '1')
 * OR the authenticated session role. Fails closed to 'Employee' when unknown.
 * See docs/auth-integration.md §3.
 */
export function useEffectiveRole(): { role: AppRole; devOverrideEnabled: boolean } {
  const { role: authRole } = useAuth();
  const { role: devRole } = useRole();
  let devEnabled = false;
  try {
    devEnabled =
      import.meta.env.DEV && localStorage.getItem(DEV_ROLE_OVERRIDE_KEY) === '1';
  } catch {
    devEnabled = false;
  }
  if (devEnabled) return { role: devRole, devOverrideEnabled: true };
  // SuperAdmin maps onto the Admin UI surface (full nav) until the dedicated
  // console arrives; AuthRole 'SuperAdmin' is not part of AppRole.
  const role: AppRole = authRole === 'SuperAdmin' ? 'Admin' : authRole ?? 'Employee';
  return { role, devOverrideEnabled: false };
}
