/**
 * Quick actions — shortcut cards into the main module routes, filtered by
 * role (mirrors the nav role gates in AppLayout): /employees and /payroll
 * are Admin/HR-only and are never advertised to Managers or Employees.
 */
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarCheck, Receipt, Users, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import type { AuthRole } from '@/lib/auth';
import { Card, CardContent } from '@/components/ui/card';

const ALL_ROLES: AuthRole[] = ['Admin', 'HR', 'Manager', 'Employee'];

const ACTIONS = [
  {
    to: '/employees',
    icon: Users,
    title: 'Employees',
    desc: 'Directory, profiles & documents',
    roles: ['Admin', 'HR'] as AuthRole[],
  },
  {
    to: '/attendance',
    icon: CalendarCheck,
    title: 'Attendance',
    desc: 'Clock-ins, shifts & OT approval',
    roles: ALL_ROLES,
  },
  {
    to: '/claims',
    icon: Receipt,
    title: 'Claims',
    desc: 'Submissions, approvals & payouts',
    roles: ALL_ROLES,
  },
  {
    to: '/payroll',
    icon: Wallet,
    title: 'Payroll',
    desc: 'Monthly runs & payslips',
    roles: ['Admin', 'HR'] as AuthRole[],
  },
] as const;

export function QuickActions() {
  const { role } = useAuth();
  const visible = ACTIONS.filter((a) => role !== null && a.roles.includes(role));

  if (visible.length === 0) return null;

  return (
    <section aria-label="Quick actions" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {visible.map((a) => (
        <Link key={a.to} to={a.to} className="group">
          <Card className="h-full rounded-xl transition-colors group-hover:border-amber-600/40 group-hover:bg-accent/50">
            <CardContent className="flex items-center gap-3 py-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <a.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{a.title}</p>
                <p className="truncate text-xs text-muted-foreground">{a.desc}</p>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-amber-700" />
            </CardContent>
          </Card>
        </Link>
      ))}
    </section>
  );
}
