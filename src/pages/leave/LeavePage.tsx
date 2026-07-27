/**
 * /leave — Leave hub: balances (EA 1955 entitlements), apply, approvals, team calendar.
 */
import { useMemo } from 'react';
import { CalendarDays, ClipboardCheck, Plane, Wallet } from 'lucide-react';
import { useCollection } from '@/lib/db';
import type { Employee, LeaveBalance } from '@/lib/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import BalancesPanel from './components/BalancesPanel';
import ApplyLeaveForm from './components/ApplyLeaveForm';
import ApprovalsQueue from './components/ApprovalsQueue';
import TeamCalendar from './components/TeamCalendar';
import type { LeaveRequestEx } from './leaveLogic';
import { useAuthScope } from './useAuthScope';

export default function LeavePage() {
  const { canApprove, scopeByEmployee } = useAuthScope();
  const { items: employees } = useCollection<Employee>('employees');
  const leavesApi = useCollection<LeaveRequestEx>('leaves');
  const balancesApi = useCollection<LeaveBalance>('leaveBalances');

  const pendingCount = useMemo(
    () => scopeByEmployee(leavesApi.items, (l) => l.employeeId).filter((l) => l.status === 'pending').length,
    [leavesApi.items, scopeByEmployee],
  );

  // Seed data loads asynchronously on first launch — show a loading state.
  if (employees.length === 0) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Leave</h1>
        <p className="text-sm text-muted-foreground">
          Balances follow EA 1955 s.60E/60F tiers (part-time: 2010 Regulations), computed from
          each employee&apos;s join date. Public holidays and rest days never consume leave balance.
        </p>
      </div>

      <Tabs defaultValue="balances" className="space-y-6">
        <TabsList className="flex w-full flex-wrap justify-start gap-1 sm:w-auto">
          <TabsTrigger value="balances" className="gap-1.5">
            <Wallet className="h-4 w-4" /> Balances
          </TabsTrigger>
          <TabsTrigger value="apply" className="gap-1.5">
            <Plane className="h-4 w-4" /> Apply
          </TabsTrigger>
          <TabsTrigger value="approvals" className="gap-1.5" disabled={!canApprove}>
            <ClipboardCheck className="h-4 w-4" /> Approvals
            {canApprove && pendingCount > 0 && (
              <Badge variant="secondary" className="ml-1 bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="calendar" className="gap-1.5">
            <CalendarDays className="h-4 w-4" /> Team calendar
          </TabsTrigger>
        </TabsList>

        <TabsContent value="balances">
          <BalancesPanel employees={employees} balancesApi={balancesApi} />
        </TabsContent>
        <TabsContent value="apply">
          <ApplyLeaveForm employees={employees} leavesApi={leavesApi} balances={balancesApi.items} />
        </TabsContent>
        <TabsContent value="approvals">
          <ApprovalsQueue employees={employees} leavesApi={leavesApi} balancesApi={balancesApi} />
        </TabsContent>
        <TabsContent value="calendar">
          <TeamCalendar employees={employees} leaves={leavesApi.items} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
