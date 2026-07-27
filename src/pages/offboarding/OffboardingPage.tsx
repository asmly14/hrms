/**
 * Offboarding module — /offboarding.
 * Initiate exits from the active workforce, EA 1955 s.12 notice calculator,
 * clearance tracking, final-pay previews and CP22A reminders.
 */
import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, FileWarning, UserMinus, Users } from 'lucide-react';
import type { Employee } from '@/lib/types';
import { useCollection } from '@/lib/db';
import { useAuth } from '@/lib/authContext';
import { useOffboardingCases } from '@/lib/lifecycle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import InitiateOffboardingDialog from './InitiateOffboardingDialog';
import OffboardingCaseCard from './OffboardingCaseCard';

export default function OffboardingPage() {
  const { user, role } = useAuth();
  const actorName = user?.username ?? role ?? 'HR'; // session user for audit attribution
  const { items: employees } = useCollection<Employee>('employees');
  const { items: cases } = useOffboardingCases();

  const [tab, setTab] = useState<'active' | 'exited' | 'all'>('active');
  const [dialogOpen, setDialogOpen] = useState(false);

  const [grace, setGrace] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setGrace(false), 600);
    return () => clearTimeout(t);
  }, []);
  const loading = grace && employees.length === 0;

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const existingEmployeeIds = useMemo(() => new Set(cases.map((c) => c.employeeId)), [cases]);

  const sorted = useMemo(
    () =>
      [...cases].sort(
        (a, b) =>
          a.lastWorkingDay.localeCompare(b.lastWorkingDay) || b.createdAt.localeCompare(a.createdAt),
      ),
    [cases],
  );

  const active = sorted.filter((c) => c.status !== 'exited');
  const exited = sorted.filter((c) => c.status === 'exited');
  const visible = tab === 'all' ? sorted : tab === 'active' ? active : exited;

  const today = new Date().toISOString().slice(0, 10);
  const cp22aOverdue = active.filter((c) => c.cp22aDueDate < today).length;
  const leavingThisMonth = active.filter(
    (c) => c.lastWorkingDay.slice(0, 7) === today.slice(0, 7),
  ).length;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Offboarding</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Notice periods, clearance, final pay and CP22A — exits handled the Malaysian way.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="bg-amber-600 text-white hover:bg-amber-700">
          <UserMinus className="mr-1.5 h-4 w-4" /> Initiate offboarding
        </Button>
      </div>

      {/* ── Stat strip ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-xl">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-amber-100 p-2 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{active.length}</p>
              <p className="text-xs text-muted-foreground">Open exit cases</p>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-stone-200/70 p-2 text-stone-700 dark:bg-stone-800 dark:text-stone-300">
              <CalendarClock className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{leavingThisMonth}</p>
              <p className="text-xs text-muted-foreground">Leaving this month</p>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-red-100 p-2 text-red-700 dark:bg-red-950/60 dark:text-red-400">
              <FileWarning className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{cp22aOverdue}</p>
              <p className="text-xs text-muted-foreground">CP22A filings overdue</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Case list ── */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="active" className="gap-1.5">
            In progress
            <Badge variant="secondary" className="px-1.5">{active.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="exited" className="gap-1.5">
            Exited
            <Badge variant="secondary" className="px-1.5">{exited.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="py-12 text-center">
            <UserMinus className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {tab === 'exited'
                ? 'No completed exits yet.'
                : 'No offboarding cases — initiate one when notice is given.'}
            </p>
            {tab !== 'exited' && (
              <Button variant="outline" className="mt-4" onClick={() => setDialogOpen(true)}>
                <UserMinus className="mr-1.5 h-4 w-4" /> Initiate offboarding
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {visible.map((c) => (
            <OffboardingCaseCard
              key={c.id}
              kase={c}
              employee={empById.get(c.employeeId)}
              actorName={actorName}
            />
          ))}
        </div>
      )}

      <InitiateOffboardingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        employees={employees}
        existingEmployeeIds={existingEmployeeIds}
        actorName={actorName}
      />
    </div>
  );
}
