/**
 * TrialExpiredBanner — amber banner shown to the SuperAdmin while working
 * INSIDE a tenant whose trial has expired (useTenant().trialStatus.expired).
 * Company users of such a tenant are already blocked at login (lib/auth.ts);
 * the banner tells the SuperAdmin why, and points to the Companies directory
 * where the trial clock / plan / status can be fixed. Mounted once in
 * AppLayout next to the SystemViewBanner. Renders nothing for regular
 * sessions, the system view, and non-expired tenants.
 */
import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { useTenant } from '@/lib/useTenant';

export default function TrialExpiredBanner() {
  const { isSuperAdmin } = useAuth();
  const { activeCompany, isSystemView, trialStatus } = useTenant();
  const navigate = useNavigate();
  if (!isSuperAdmin || isSystemView || !activeCompany || !trialStatus?.expired) return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-sm md:px-8">
        <span className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Trial expired — {activeCompany.name}&rsquo;s trial ended{' '}
          {trialStatus.trialEndsAt?.slice(0, 10)}. Company users are blocked at login; your
          SuperAdmin access is unaffected.
        </span>
        <button
          type="button"
          onClick={() => navigate('/superadmin')}
          className="ml-auto text-xs font-medium text-amber-800 underline-offset-4 hover:underline dark:text-amber-300"
        >
          Manage in Companies directory
        </button>
      </div>
    </div>
  );
}
