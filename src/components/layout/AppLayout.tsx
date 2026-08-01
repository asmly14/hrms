/**
 * App shell: left sidebar (desktop) + bottom nav (mobile), topbar with
 * company stub, global search, notification bell (static demo), dark-mode
 * toggle (class strategy) and the role switcher that gates nav items.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Bell, Building2, Calendar, CalendarDays, ClipboardList, FileText, Gauge,
  LayoutDashboard, LogOut, Moon, Network, Receipt, ScrollText, Search, Settings,
  ShieldCheck, Sun, TrendingUp, UserRound, UserRoundCheck, UserRoundMinus,
  Users, Wallet, Workflow,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRole, type AppRole } from '@/lib/roleContext';
import { useAuth } from '@/lib/authContext';
import { useTenant } from '@/lib/tenantContext';
import { useCollection } from '@/lib/db';
import type { ModuleKey, Settings as CompanySettings } from '@/lib/types';
import { isModuleEnabled } from '@/pages/company/modules';
import { useCompanyBranding } from '@/pages/company/branding';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

export interface NavItem {
  path: string;
  title: string;
  icon: typeof LayoutDashboard;
  roles: AppRole[];
  /** Feature-gated by the active company's module toggles when set. */
  module?: ModuleKey;
  /** Visible ONLY to the system SuperAdmin session (auth-aware filter). */
  superAdminOnly?: boolean;
}

/** Single source of nav truth — module routes map onto these paths.
 *  Role gating: Admin/HR see everything; Manager gets dashboard, attendance,
 *  leave, claims, kpi, reports; Employee gets dashboard, attendance, leave,
 *  claims. (Payslips live under /payroll which is Admin/HR only.)
 *  Module gating: items tagged `module` disappear when the active company
 *  has that module disabled (Company Setup → Modules). */
export const NAV_ITEMS: NavItem[] = [
  { path: '/', title: 'Dashboard', icon: LayoutDashboard, roles: ['Admin', 'HR', 'Manager', 'Employee'] },
  { path: '/employees', title: 'Employees', icon: Users, roles: ['Admin', 'HR'] },
  { path: '/contracts', title: 'Contracts', icon: ScrollText, roles: ['Admin', 'HR'] },
  { path: '/org', title: 'Organization', icon: Network, roles: ['Admin', 'HR'] },
  { path: '/org/chart', title: 'Org Chart', icon: Workflow, roles: ['Admin', 'HR'] },
  { path: '/attendance', title: 'Attendance', icon: Calendar, roles: ['Admin', 'HR', 'Manager', 'Employee'], module: 'attendance' },
  { path: '/leave', title: 'Leave', icon: ClipboardList, roles: ['Admin', 'HR', 'Manager', 'Employee'], module: 'leave' },
  { path: '/holidays', title: 'Holidays', icon: CalendarDays, roles: ['Admin', 'HR'] },
  { path: '/claims', title: 'Claims', icon: Receipt, roles: ['Admin', 'HR', 'Manager', 'Employee'], module: 'claims' },
  { path: '/payroll', title: 'Payroll', icon: Wallet, roles: ['Admin', 'HR'], module: 'payroll' },
  { path: '/kpi', title: 'KPI', icon: Gauge, roles: ['Admin', 'HR', 'Manager'], module: 'kpi' },
  { path: '/insights/salary', title: 'Salary Insights', icon: TrendingUp, roles: ['Admin', 'HR'], module: 'insights' },
  { path: '/reports', title: 'Reports', icon: FileText, roles: ['Admin', 'HR', 'Manager'], module: 'reports' },
  { path: '/onboarding', title: 'Onboarding', icon: UserRoundCheck, roles: ['Admin', 'HR'], module: 'onboarding' },
  { path: '/offboarding', title: 'Offboarding', icon: UserRoundMinus, roles: ['Admin', 'HR'], module: 'offboarding' },
  { path: '/company', title: 'Company Setup', icon: Building2, roles: ['Admin', 'HR'] },
  { path: '/settings', title: 'Settings', icon: Settings, roles: ['Admin'] },
  { path: '/superadmin', title: 'Super Admin', icon: ShieldCheck, roles: ['Admin'], superAdminOnly: true },
];

const MOBILE_PATHS = ['/', '/attendance', '/leave', '/claims', '/kpi'];
const THEME_KEY = 'myhrms:theme';
const DEV_ROLE_OVERRIDE_KEY = 'myhrms:devRoleOverride';

/**
 * Nav visibility = role filter, then the auth-aware SuperAdmin filter, then
 * the per-company module gate. isModuleEnabled() is non-reactive, so callers
 * must render under a tenant subscription (AppLayout mounts one) to re-run
 * this filter immediately after a tenant switch.
 */
export function visibleNavItems(role: AppRole, isSuperAdmin: boolean): NavItem[] {
  return NAV_ITEMS.filter((i) => {
    if (i.superAdminOnly) return isSuperAdmin;
    if (!i.roles.includes(role)) return false;
    if (i.module && !isModuleEnabled(i.module)) return false;
    return true;
  });
}

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

function useDarkMode() {
  const [dark, setDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem(THEME_KEY) === 'dark';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

function TopBar() {
  const { role, setRole } = useRole();
  const { role: effectiveRole, devOverrideEnabled } = useEffectiveRole();
  const { user, logout, isSuperAdmin } = useAuth();
  const { activeCompany, isSystemView } = useTenant();
  const { dark, toggle } = useDarkMode();
  const navigate = useNavigate();
  const { items: settingsItems } = useCollection<CompanySettings>('settings');
  const company = settingsItems[0];
  // Tenant-aware label: the active company record wins; in the SuperAdmin
  // system view there is no tenant, so say so instead of showing the
  // co-asm fallback data the db layer resolves.
  const companyLabel = isSystemView && isSuperAdmin
    ? 'System view'
    : activeCompany?.name ?? company?.companyName ?? 'MY HRMS';

  const signOut = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur md:px-6">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-semibold hover:bg-accent md:hidden lg:flex">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Building2 className="h-4 w-4" />
            </span>
            <span className="hidden sm:inline">{companyLabel}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Company</DropdownMenuLabel>
          <DropdownMenuItem>{companyLabel}</DropdownMenuItem>
          <DropdownMenuItem disabled className="text-muted-foreground">
            {isSystemView && isSuperAdmin
              ? 'No active company — pick one below'
              : activeCompany?.regNo ?? company?.companyRegNo ?? ''}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="relative ml-auto hidden w-full max-w-xs md:block">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search employees, pages…"
          className="pl-8"
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate('/employees');
          }}
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
            <Bell className="h-4 w-4" />
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="flex flex-col items-start gap-1">
            <span className="text-sm font-medium">Payroll reminder</span>
            <span className="text-xs text-muted-foreground">EPF/SOCSO/EIS/PCB submissions due on the 15th.</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="flex flex-col items-start gap-1">
            <span className="text-sm font-medium">3 leave requests pending</span>
            <span className="text-xs text-muted-foreground">Review under Leave → Approvals.</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="flex flex-col items-start gap-1">
            <span className="text-sm font-medium">Holiday data</span>
            <span className="text-xs text-muted-foreground">Islamic holiday dates are tentative pending official gazette.</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle dark mode">
        {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>

      {devOverrideEnabled ? (
        <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
          <SelectTrigger className="w-[118px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['Admin', 'HR', 'Manager', 'Employee'] as AppRole[]).map((r) => (
              <SelectItem key={r} value={r}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="hidden rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground sm:inline">
          {effectiveRole}
        </span>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UserRound className="h-4 w-4" />
            </span>
            <span className="hidden font-medium md:inline">{user?.username ?? 'Guest'}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex flex-col">
            <span>{user?.username ?? 'Not signed in'}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {user?.role ?? effectiveRole}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={signOut} className="gap-2">
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

function SideNav() {
  const { role } = useEffectiveRole();
  const { isSuperAdmin } = useAuth();
  const items = visibleNavItems(role, isSuperAdmin);
  return (
    <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 border-r bg-sidebar md:block">
      <nav className="flex flex-col gap-1 p-3">
        {items.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-sidebar-foreground hover:bg-accent hover:text-accent-foreground',
              )
            }
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.title}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

function BottomNav() {
  const { role } = useEffectiveRole();
  const { isSuperAdmin } = useAuth();
  const items = visibleNavItems(role, isSuperAdmin)
    .filter((i) => MOBILE_PATHS.includes(i.path) || i.path === '/')
    .slice(0, 5);
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 flex border-t bg-card md:hidden">
      {items.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.path === '/'}
          className={({ isActive }) =>
            cn(
              'flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium',
              isActive ? 'text-primary' : 'text-muted-foreground',
            )
          }
        >
          <item.icon className="h-5 w-5" />
          {item.title}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * SuperAdmin system-view banner: shown when the session has no active company
 * (isSystemView). Operational pages fall back to the co-asm namespace in this
 * state (docs/tenant-api.md) — the banner makes that explicit and offers a
 * company picker to enter a tenant, plus a shortcut to the Super Admin
 * console.
 */
function SystemViewBanner() {
  const { isSuperAdmin } = useAuth();
  const { isSystemView, companies, setActiveCompany } = useTenant();
  if (!isSuperAdmin || !isSystemView) return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-sm md:px-8">
        <span className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          Viewing system — enter a company to manage its data.
        </span>
        <Select onValueChange={(id) => setActiveCompany(id)}>
          <SelectTrigger className="h-8 w-56 bg-card text-xs">
            <SelectValue placeholder="Enter a company…" />
          </SelectTrigger>
          <SelectContent>
            {companies.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <NavLink
          to="/superadmin"
          className="ml-auto text-xs font-medium text-amber-800 underline-offset-4 hover:underline dark:text-amber-300"
        >
          Open Super Admin console
        </NavLink>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children?: ReactNode }) {
  // Applies the ACTIVE company's branding (accent color → shadcn CSS vars)
  // app-wide; re-runs automatically on every tenant switch. Mounted here
  // once so every page and the shell itself are themed.
  useCompanyBranding();
  // Tenant subscription: re-renders the shell (nav filters, topbar label,
  // banner) whenever the active company changes.
  useTenant();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar />
      <SystemViewBanner />
      <div className="flex">
        <SideNav />
        <main className="min-w-0 flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10">
          <div className="mx-auto w-full max-w-6xl">{children ?? <Outlet />}</div>
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
