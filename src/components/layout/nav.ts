/**
 * Nav model — the single source of truth for the app shell's sidebar, mobile
 * bottom nav (incl. the "More" sheet) and the global search's page results.
 *
 * Extracted from AppLayout so shell widgets (GlobalSearch, NotificationBell,
 * BottomNav) can import it without an AppLayout ↔ widget module cycle.
 * AppLayout re-exports this module's public API, so existing consumers
 * (`@/components/layout/AppLayout` importers in pages/**) keep working.
 *
 * Role gating: Admin/HR see everything; Manager gets dashboard, attendance,
 * leave, claims, kpi, reports; Employee gets dashboard, attendance, leave,
 * claims. (Payslips live under /payroll which is Admin/HR only.)
 * Module gating: items tagged `module` disappear when the active company has
 * that module disabled (Company Setup → Modules).
 */
import {
  Banknote, Building2, Calendar, CalendarDays, ClipboardList, FileText, Gauge,
  Inbox, LayoutDashboard, Network, Receipt, ScrollText, Settings, ShieldCheck,
  TrendingUp, UserRoundCheck, UserRoundMinus, Users, Wallet, Workflow,
} from 'lucide-react';
import type { AppRole } from '@/lib/roleContext';
import type { ModuleKey } from '@/lib/types';
import { isModuleEnabled } from '@/pages/company/modules';

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

export const NAV_ITEMS: NavItem[] = [
  { path: '/', title: 'Dashboard', icon: LayoutDashboard, roles: ['Admin', 'HR', 'Manager', 'Employee'] },
  // Unified approvals inbox — aggregates leave/claims/OT decision queues.
  // Approver roles only in nav; Employees opening /approvals directly see
  // their own pending requests (the route itself is not role-gated).
  { path: '/approvals', title: 'Approvals', icon: Inbox, roles: ['Admin', 'HR', 'Manager'] },
  { path: '/employees', title: 'Employees', icon: Users, roles: ['Admin', 'HR'] },
  { path: '/contracts', title: 'Contracts', icon: ScrollText, roles: ['Admin', 'HR'] },
  { path: '/org', title: 'Organization', icon: Network, roles: ['Admin', 'HR'] },
  { path: '/org/chart', title: 'Org Chart', icon: Workflow, roles: ['Admin', 'HR'] },
  { path: '/attendance', title: 'Attendance', icon: Calendar, roles: ['Admin', 'HR', 'Manager', 'Employee'], module: 'attendance' },
  { path: '/leave', title: 'Leave', icon: ClipboardList, roles: ['Admin', 'HR', 'Manager', 'Employee'], module: 'leave' },
  { path: '/holidays', title: 'Holidays', icon: CalendarDays, roles: ['Admin', 'HR'] },
  { path: '/claims', title: 'Claims', icon: Receipt, roles: ['Admin', 'HR', 'Manager', 'Employee'], module: 'claims' },
  { path: '/payroll', title: 'Payroll', icon: Wallet, roles: ['Admin', 'HR'], module: 'payroll' },
  // Employee self-service payslips (page: pages/payroll/MyPayslipsPage.tsx) —
  // visible to ALL roles; Admin/HR also have the full Payroll section above.
  { path: '/my-payslips', title: 'My Payslips', icon: Banknote, roles: ['Admin', 'HR', 'Manager', 'Employee'], module: 'payroll' },
  { path: '/kpi', title: 'KPI', icon: Gauge, roles: ['Admin', 'HR', 'Manager'], module: 'kpi' },
  { path: '/insights/salary', title: 'Salary Insights', icon: TrendingUp, roles: ['Admin', 'HR'], module: 'insights' },
  { path: '/reports', title: 'Reports', icon: FileText, roles: ['Admin', 'HR', 'Manager'], module: 'reports' },
  { path: '/onboarding', title: 'Onboarding', icon: UserRoundCheck, roles: ['Admin', 'HR'], module: 'onboarding' },
  { path: '/offboarding', title: 'Offboarding', icon: UserRoundMinus, roles: ['Admin', 'HR'], module: 'offboarding' },
  { path: '/company', title: 'Company Setup', icon: Building2, roles: ['Admin', 'HR'] },
  { path: '/settings', title: 'Settings', icon: Settings, roles: ['Admin'] },
  { path: '/superadmin', title: 'Super Admin', icon: ShieldCheck, roles: ['Admin'], superAdminOnly: true },
];

/** Primary mobile tabs; the 5th bottom-nav slot is the "More" sheet. */
export const MOBILE_PATHS = ['/', '/attendance', '/leave', '/claims', '/kpi'];

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
