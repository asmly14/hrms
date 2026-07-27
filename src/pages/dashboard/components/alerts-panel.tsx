/**
 * Alerts panel — compliance and workforce warnings:
 *  - full-time staff below the minimum wage (MINIMUM_WAGE)
 *  - employees over the monthly OT cap (MAX_OT_HOURS_MONTH) this month
 *  - probation periods ending within 30 days (3-month probation assumed)
 *  - foreign-worker EPF 2% + 2% mandatory-contribution reminder
 * Thresholds come from @/lib/statutory; nothing is hardcoded.
 */
import { Link } from 'react-router-dom';
import { AlertTriangle, CircleCheck, Globe, Hourglass, Timer, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { useCollection } from '@/lib/db';
import { MAX_OT_HOURS_MONTH, MINIMUM_WAGE } from '@/lib/statutory';
import { daysBetween, fmtRM, monthKey, round2 } from '@/lib/utils';
import type { AttendanceRecord, Employee } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { addMonths, isoOf, todayISO } from '../lib';

interface AlertItem {
  id: string;
  icon: typeof AlertTriangle;
  title: string;
  detail: string;
  to: string;
  count?: number;
}

export function AlertsPanel() {
  const { role, scopeEmployees, scopeByEmployee } = useAuth();
  const { items: employees } = useCollection<Employee>('employees');
  const { items: attendance } = useCollection<AttendanceRecord>('attendance');

  // Alerts name individuals — an Employee must never see other people's
  // wage/OT/probation facts. (The page also hides this panel for Employees;
  // this guard is defence-in-depth.)
  if (role === 'Employee') return null;

  const today = todayISO();
  const thisMonth = monthKey();
  // Scoped to the visible workforce: Admin/HR → everyone, Manager → own
  // department only, so alerts never reference anyone outside the scope.
  const active = scopeEmployees(employees).filter((e) => e.status !== 'resigned');
  const scopedAttendance = scopeByEmployee(attendance, (a) => a.employeeId);

  // 1. Below minimum wage (full-time only; MWO 2024)
  const belowWage = active.filter(
    (e) => e.employmentType === 'full-time' && e.baseSalary < MINIMUM_WAGE,
  );

  // 2. OT hours over the monthly cap this month (approved or not — the cap
  //    limits hours worked, not hours paid)
  const otByEmp = new Map<string, number>();
  for (const a of scopedAttendance) {
    if (a.date.startsWith(thisMonth) && a.otHours > 0) {
      otByEmp.set(a.employeeId, (otByEmp.get(a.employeeId) ?? 0) + a.otHours);
    }
  }
  const otOver = active
    .map((e) => ({ emp: e, hours: round2(otByEmp.get(e.id) ?? 0) }))
    .filter((x) => x.hours > MAX_OT_HOURS_MONTH);

  // 3. Probation: ending within 30 days OR already overdue (still 'probation'
  //    past join + 3 months — confirmation overdue is the riskier case).
  const probation = active
    .filter((e) => e.status === 'probation')
    .map((e) => {
      const end = addMonths(new Date(`${e.joinDate}T00:00:00`), 3);
      return { emp: e, daysLeft: daysBetween(today, isoOf(end)) };
    });
  const probationOverdue = probation
    .filter((x) => x.daysLeft < 0)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const probationEnding = probation
    .filter((x) => x.daysLeft >= 0 && x.daysLeft <= 30)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  // 4. Foreign workers on record → EPF 2% + 2% reminder
  const foreignCount = active.filter((e) => e.isForeignWorker).length;

  const alerts: AlertItem[] = [];
  if (probationOverdue.length > 0) {
    const worst = probationOverdue[0];
    alerts.push({
      id: 'probation-overdue',
      icon: Hourglass,
      title: 'Probation overdue',
      detail: `${worst.emp.name} is ${-worst.daysLeft}d past the 3-month mark${
        probationOverdue.length > 1 ? ` +${probationOverdue.length - 1} more` : ''
      } — confirm or extend`,
      to: '/employees',
      count: probationOverdue.length,
    });
  }
  if (belowWage.length > 0) {
    const names = belowWage.slice(0, 2).map((e) => e.name).join(', ');
    alerts.push({
      id: 'min-wage',
      icon: Wallet,
      title: 'Below minimum wage',
      detail: `${names}${belowWage.length > 2 ? ` +${belowWage.length - 2} more` : ''} under ${fmtRM(
        MINIMUM_WAGE,
      )} basic`,
      to: '/employees',
      count: belowWage.length,
    });
  }
  if (otOver.length > 0) {
    const top = [...otOver].sort((a, b) => b.hours - a.hours)[0];
    alerts.push({
      id: 'ot-cap',
      icon: Timer,
      title: 'OT over monthly cap',
      detail: `Highest: ${top.emp.name} at ${top.hours}h (cap ${MAX_OT_HOURS_MONTH}h)`,
      to: '/attendance',
      count: otOver.length,
    });
  }
  if (probationEnding.length > 0) {
    const next = probationEnding[0];
    alerts.push({
      id: 'probation',
      icon: Hourglass,
      title: 'Probation ending soon',
      detail: `${next.emp.name} ends in ${next.daysLeft}d — confirm or extend`,
      to: '/employees',
      count: probationEnding.length,
    });
  }
  if (foreignCount > 0) {
    alerts.push({
      id: 'foreign-epf',
      icon: Globe,
      title: 'Foreign-worker EPF applies',
      detail: `${foreignCount} foreign employee${foreignCount > 1 ? 's' : ''} — 2% + 2% EPF is mandatory (EPF (Amendment) Act 2025)`,
      to: '/employees',
    });
  }

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Alerts
        </CardTitle>
        <CardDescription>Statutory thresholds and workforce watch-outs</CardDescription>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CircleCheck className="h-6 w-6 text-lime-700" />
            <p className="text-sm font-medium">All clear</p>
            <p className="text-xs text-muted-foreground">
              No minimum-wage, OT-cap or probation issues right now.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {alerts.map((a) => (
              <li key={a.id}>
                <Link
                  to={a.to}
                  className="flex items-start gap-3 rounded-lg p-2 -m-2 transition-colors hover:bg-accent"
                >
                  <a.icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{a.title}</p>
                      {a.count !== undefined && (
                        <Badge variant="secondary" className="shrink-0">
                          {a.count}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{a.detail}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
