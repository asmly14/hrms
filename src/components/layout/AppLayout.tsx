/**
 * App shell: left sidebar (desktop) + bottom nav with "More" sheet (mobile),
 * topbar with company stub, live global search, live notification bell,
 * dark-mode toggle (class strategy) and the role switcher that gates nav items.
 *
 * The nav model (NAV_ITEMS / visibleNavItems) lives in ./nav and the role
 * resolver in ./useEffectiveRole — import those directly (this module exports
 * only components so fast refresh keeps working).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Building2, LogOut, Menu, Moon, ShieldCheck, Sun, UserRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRole, type AppRole } from '@/lib/useRole';
import { useAuth } from '@/lib/useAuth';
import { useTenant } from '@/lib/useTenant';
import { useCollection } from '@/lib/db';
import type { Settings as CompanySettings } from '@/lib/types';
import { useCompanyBranding } from '@/pages/company/branding';
import TrialExpiredBanner from '@/pages/superadmin/TrialExpiredBanner';
import { MOBILE_PATHS, visibleNavItems } from './nav';
import { useEffectiveRole } from './useEffectiveRole';
import { useCompanyLabel } from './useCompanyLabel';
import NotificationBell from './NotificationBell';
import GlobalSearch from './GlobalSearch';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from '@/components/ui/sheet';

const THEME_KEY = 'myhrms:theme';

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
  const companyLabel = useCompanyLabel();
  // Extra detail line for the company dropdown (reg no / system-view note).
  const { items: settingsItems } = useCollection<CompanySettings>('settings');
  const company = settingsItems[0];

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

      <GlobalSearch />

      <NotificationBell />

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

/**
 * Mobile bottom nav: the first 4 MOBILE_PATHS items stay as one-tap tabs; the
 * 5th slot is "More", opening a Sheet with the FULL role-filtered nav list
 * (visibleNavItems) so every route is reachable on a phone. The sheet shows
 * the company label, highlights the active route and closes on navigate; the
 * More tab itself lights up when the current route lives only inside it.
 */
function BottomNav() {
  const { role } = useEffectiveRole();
  const { isSuperAdmin } = useAuth();
  const companyLabel = useCompanyLabel();
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const all = visibleNavItems(role, isSuperAdmin);
  const primary = all.filter((i) => MOBILE_PATHS.includes(i.path)).slice(0, 4);

  const pathActive = (path: string) =>
    path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
  const moreActive = !primary.some((i) => pathActive(i.path)) && all.some((i) => pathActive(i.path));

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 flex border-t bg-card md:hidden">
      {primary.map((item) => (
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

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetTrigger asChild>
          <button
            className={cn(
              'flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium',
              moreActive ? 'text-primary' : 'text-muted-foreground',
            )}
            aria-label="More navigation"
          >
            <Menu className="h-5 w-5" />
            More
          </button>
        </SheetTrigger>
        <SheetContent side="bottom" className="max-h-[75vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Building2 className="h-4 w-4" />
              </span>
              {companyLabel}
            </SheetTitle>
            <SheetDescription>All pages available to your role.</SheetDescription>
          </SheetHeader>
          <nav className="grid gap-1 pb-6">
            {all.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                onClick={() => setMoreOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-accent hover:text-accent-foreground',
                  )
                }
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.title}
              </NavLink>
            ))}
          </nav>
        </SheetContent>
      </Sheet>
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
      <TrialExpiredBanner />
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
