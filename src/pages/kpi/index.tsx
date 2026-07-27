/**
 * /kpi — KPI & Performance hub.
 * Tabs: KPI Library · Review Cycles · Objectives (OKR) · My Dashboard ·
 * Calibration · 9-Box Grid · Outcomes · PIPs.
 *
 * Wave 2: pending-action badges (self / manager / acknowledgment / PIPs)
 * computed from the current role; hub stats are draft-free (submitted and
 * acknowledged reviews only).
 */
import { useMemo } from 'react';
import {
  BellRing, ClipboardList, Gauge, Grid3X3, LibraryBig, ListChecks, Scale,
  Target, TrendingUp, UserRound,
} from 'lucide-react';
import { useCollection } from '@/lib/db';
import type { Department, Employee, Position } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import KpiLibrary from './KpiLibrary';
import CycleList from './CycleList';
import Objectives from './Objectives';
import EmployeeDashboard from './EmployeeDashboard';
import Calibration from './Calibration';
import NineBox from './NineBox';
import Outcomes from './Outcomes';
import Pips from './Pips';
import { bandFor100, empPeriodKey, score100to5, type KpiExt, type ReviewExt } from './lib';
import { computePendingActions, isFinalReview, usePips } from '@/lib/kpiEngine';
import { useAuthSafe } from './useAuthSafe';

export default function KpiPage() {
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');
  const { items: kpis } = useCollection<KpiExt>('kpis');
  const { items: reviews } = useCollection<ReviewExt>('reviews');
  const { items: pips } = usePips();
  const auth = useAuthSafe();

  const loading = employees.length === 0 && kpis.length === 0 && reviews.length === 0;

  const stats = useMemo(() => {
    const activeKpis = kpis.filter((k) => k.status === 'active').length;
    const periods = [...new Set(reviews.map((r) => r.period))].sort().reverse();
    const latest = periods[0];
    // Draft-free: only submitted/acknowledged reviews feed the hub average.
    const latestReviews = latest ? reviews.filter((r) => r.period === latest && isFinalReview(r)) : [];
    const avg100 = latestReviews.length
      ? Math.round(latestReviews.reduce((s, r) => s + r.overallScore, 0) / latestReviews.length)
      : 0;
    const submitted = reviews.filter((r) => r.status !== 'draft').length;
    return { activeKpis, cycleCount: periods.length, latest, avg100, reviewCount: reviews.length, submitted };
  }, [kpis, reviews]);

  /** Pending actions for the notification-style badges (role-aware). */
  const pending = useMemo(() => {
    const countMap = new Map<string, number>();
    kpis.forEach((k) => {
      if (k.status === 'archived') return;
      const key = empPeriodKey(k.employeeId, k.period);
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    });
    return computePendingActions(
      auth,
      reviews,
      (r) => countMap.get(empPeriodKey(r.employeeId, r.period)) ?? 0,
      pips,
    );
  }, [auth, reviews, kpis, pips]);

  const pendingTotal = pending.selfPending + pending.managerPending + pending.ackPending;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const latestBand = stats.avg100 > 0 ? bandFor100(stats.avg100) : null;

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Gauge className="h-6 w-6 text-amber-600" />
          KPI &amp; Performance
        </h1>
        <p className="text-sm text-muted-foreground">
          KPI library, staged review cycles, OKRs with cascading goals, check-ins, calibration, 9-box, outcomes and improvement plans.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="rounded-xl">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active KPIs</CardTitle>
            <LibraryBig className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{stats.activeKpis}</div>
            <p className="mt-1 text-xs text-muted-foreground">{kpis.length} total in library</p>
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Review cycles</CardTitle>
            <ListChecks className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{stats.cycleCount}</div>
            <p className="mt-1 text-xs text-muted-foreground">{stats.reviewCount} individual reviews</p>
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Latest cycle avg</CardTitle>
            <TrendingUp className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {stats.avg100 > 0 ? `${score100to5(stats.avg100).toFixed(1)} / 5` : '—'}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {stats.latest ? `${stats.latest}${latestBand ? ` · ${latestBand.label}` : ''} (submitted only)` : 'No scored reviews yet'}
            </p>
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completion</CardTitle>
            <Scale className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {stats.reviewCount ? `${Math.round((stats.submitted / stats.reviewCount) * 100)}%` : '—'}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">reviews submitted or acknowledged</p>
          </CardContent>
        </Card>
      </div>

      {/* Pending actions — notification-style badges */}
      <Card className="rounded-xl border-amber-200 bg-amber-50/50">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
          <span className="flex items-center gap-2 text-sm font-medium">
            <BellRing className="h-4 w-4 text-amber-600" />
            Pending actions
          </span>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Self-reviews to complete
            <Badge variant={pending.selfPending > 0 ? 'default' : 'secondary'}>{pending.selfPending}</Badge>
          </span>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Manager reviews to score
            <Badge variant={pending.managerPending > 0 ? 'default' : 'secondary'}>{pending.managerPending}</Badge>
          </span>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Awaiting acknowledgment
            <Badge variant={pending.ackPending > 0 ? 'default' : 'secondary'}>{pending.ackPending}</Badge>
          </span>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Active PIPs
            <Badge variant={pending.activePips > 0 ? 'default' : 'secondary'}>{pending.activePips}</Badge>
          </span>
          {pendingTotal === 0 && (
            <span className="text-xs text-emerald-700">All caught up — nothing waiting on you.</span>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="library" className="space-y-6">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-muted/60 p-1 md:w-auto">
          <TabsTrigger value="library" className="gap-1.5">
            <LibraryBig className="h-3.5 w-3.5" /> KPI Library
          </TabsTrigger>
          <TabsTrigger value="cycles" className="gap-1.5">
            <ListChecks className="h-3.5 w-3.5" /> Review Cycles
          </TabsTrigger>
          <TabsTrigger value="objectives" className="gap-1.5">
            <Target className="h-3.5 w-3.5" /> Objectives
          </TabsTrigger>
          <TabsTrigger value="dashboard" className="gap-1.5">
            <UserRound className="h-3.5 w-3.5" /> My Dashboard
          </TabsTrigger>
          <TabsTrigger value="calibration" className="gap-1.5">
            <Scale className="h-3.5 w-3.5" /> Calibration
          </TabsTrigger>
          <TabsTrigger value="ninebox" className="gap-1.5">
            <Grid3X3 className="h-3.5 w-3.5" /> 9-Box Grid
          </TabsTrigger>
          <TabsTrigger value="outcomes" className="gap-1.5">
            <TrendingUp className="h-3.5 w-3.5" /> Outcomes
          </TabsTrigger>
          <TabsTrigger value="pips" className="gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" /> PIPs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="library">
          <KpiLibrary employees={employees} departments={departments} positions={positions} kpis={kpis} />
        </TabsContent>
        <TabsContent value="cycles">
          <CycleList employees={employees} departments={departments} kpis={kpis} reviews={reviews} />
        </TabsContent>
        <TabsContent value="objectives">
          <Objectives employees={employees} departments={departments} />
        </TabsContent>
        <TabsContent value="dashboard">
          <EmployeeDashboard employees={employees} departments={departments} kpis={kpis} reviews={reviews} />
        </TabsContent>
        <TabsContent value="calibration">
          <Calibration employees={employees} reviews={reviews} />
        </TabsContent>
        <TabsContent value="ninebox">
          <NineBox employees={employees} departments={departments} reviews={reviews} />
        </TabsContent>
        <TabsContent value="outcomes">
          <Outcomes employees={employees} reviews={reviews} />
        </TabsContent>
        <TabsContent value="pips">
          <Pips employees={employees} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
