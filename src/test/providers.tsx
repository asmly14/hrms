/**
 * The standard provider stack used by module pages (mirrors App.tsx).
 * Kept component-only so react-refresh lint stays clean.
 */
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/authContext';
import { RoleProvider } from '@/lib/roleContext';
import { TenantProvider } from '@/lib/tenantContext';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <RoleProvider>
      <TenantProvider>
        <AuthProvider>{children}</AuthProvider>
      </TenantProvider>
    </RoleProvider>
  );
}
