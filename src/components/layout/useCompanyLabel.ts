/**
 * Tenant-aware company label shared by the TopBar brand and the mobile "More"
 * sheet header. Extracted from AppLayout's TopBar so both stay in sync.
 */
import { useAuth } from '@/lib/useAuth';
import { useTenant } from '@/lib/useTenant';
import { useCollection } from '@/lib/db';
import type { Settings as CompanySettings } from '@/lib/types';

/**
 * The active company record wins; in the SuperAdmin system view there is no
 * tenant, so say so instead of showing the co-asm fallback data the db layer
 * resolves.
 */
export function useCompanyLabel(): string {
  const { isSuperAdmin } = useAuth();
  const { activeCompany, isSystemView } = useTenant();
  const { items: settingsItems } = useCollection<CompanySettings>('settings');
  const company = settingsItems[0];
  return isSystemView && isSuperAdmin
    ? 'System view'
    : activeCompany?.name ?? company?.companyName ?? 'MY HRMS';
}
