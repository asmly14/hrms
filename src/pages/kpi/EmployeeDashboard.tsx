/**
 * Employee Dashboard tab — per-employee performance view:
 *   - current-cycle progress (self / manager stages, weights, status)
 *   - score trend across cycles (line chart, draft-free)
 *   - radar chart of category scores for the latest submitted cycle
 *   - OKR progress for the current period
 *
 * Scoping: employees land on themselves and can only see themselves; managers
 * can pick anyone in their department; Admin/HR see everyone.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Gauge, UserRound } from 'lucide-react';
import {
  CartesianGrid, Line, LineChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis,
  Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { avatarTone, cn, initialsOf } from '@/lib/utils';
import type { Department, Employee } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import {
  KPI_CATEGORIES, bandFor100, managerDoneOf, score100to5, selfDoneOf, weightTotal,
  type KpiCategory, type KpiExt, type ReviewExt,
} from './lib';
import { isFinalReview, objectiveProgress, useObjectives } from '@/lib/kpiEngine';
import { useAuthSafe } from './useAuthSafe';

interface Props {
  employees: Employee[];
  departments: Department[];
  kpis: KpiExt[];
  reviews: ReviewExt[];
}

export default function EmployeeDashboard({ employees, departments, kpis, reviews }: Props) {
  const auth = useAuthSafe();
  const { items: objectives } = useObjectives();
  const [selected, setSelected] = useState<string>('');

  const empOf = (id: string) => employees.find((e) => e.id === id);
  const deptName = (id?: string) => departments.find((d) => d.id === id)?.name ?? '—';

  /** Employees the current user may inspect. */
  const options = useMemo(() => {
    const active = employees.filter((e) => e.status !== 'resigned');
    if (!auth) return active;
    return auth.scopeEmployees(active);
  }, [employees, auth]);

  const empId = selected || auth?.employeeId || options[0]?.id || '';
  const emp = empOf(empId);

  const myReviews = useMemo(
    () => reviews.filter((r) => r.employeeId === empId).sort((a, b) => a.period.localeCompare(b.period)),
    [reviews, empId],
  );
  const myKpis = useMemo(
    () => kpis.filter((k) => k.employeeId === empId && k.status !== 'archived'),
    [kpis, empId],
  );
  const myObjectives = useMemo(
    () => objectives.filter((o) => o.employeeId === empId && o.status === 'active'),
    [objectives, empId],
  );

  const latestReview = [...myReviews].reverse()[0];
  const latestKpis = latestReview ? myKpis.filter((k) => k.period === latestReview.period) : [];
  const latestWeights = weightTotal(latestKpis);
  const latestBand = latestReview && latestReview.overallScore > 0 ? bandFor100(latestReview.overallScore) : null;

  /** Score trend across cycles — final reviews only (draft-free). */
  const trend = useMemo(
    () =>
      myReviews
        .filter(isFinalReview)
        .map((r) => ({ period: r.period, score: score100to5(r.overallScore) })),
    [myReviews],
  );

  /** Radar: average manager score (1–5) per KPI category for the latest final review. */
  const radar = useMemo(() => {
    const final = [...myReviews].filter(isFinalReview).reverse()[0];
    if (!final) return [];
    const periodKpis = kpis.filter((k) => k.employeeId === empId && k.period === final.period);
    return KPI_CATEGORIES.map((cat: KpiCategory) => {
      const inCat = periodKpis.filter((k) => (k.category ?? 'Process') === cat);
      const scored = inCat
        .map((k) => final.scores.find((s) => s.kpiId === k.id)?.score ?? 0)
        .filter((s) => s > 0);
      const avg5 = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length / 20 : 0;
      return { category: cat, score: Math.round(avg5 * 10) / 10 };
    });
  }, [myReviews, kpis, empId]);

  const selfPct = latestReview && latestKpis.length
    ? Math.min(100, Math.round(((latestReview.selfScores?.length ?? 0) / latestKpis.length) * 100))
    : 0;
  const mgrPct = latestReview && latestKpis.length
    ? Math.min(100, Math.round((latestReview.scores.filter((s) => s.score > 0).length / latestKpis.length) * 100))
    : 0;

  if (!emp) {
    return (
      <Empty className="rounded-xl border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><UserRound /></EmptyMedia>
          <EmptyTitle>No employee in scope</EmptyTitle>
          <EmptyDescription>Your role has no employees to show a dashboard for.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-amber-600" />
          <h2 className="text-base font-semibold">Employee dashboard</h2>
        </div>
        <Select value={empId} onValueChange={setSelected}>
          <SelectTrigger className="ml-auto w-full sm:w-64"><SelectValue placeholder="Select employee" /></SelectTrigger>
          <SelectContent>
            {options.map((e) => (
              <SelectItem key={e.id} value={e.id}>{e.name} — {deptName(e.departmentId)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Header card */}
      <Card className="rounded-xl">
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <span className={cn('flex h-12 w-12 items-center justify-center rounded-full text-sm font-semibold', avatarTone(emp.name))}>
            {initialsOf(emp.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold">{emp.name}</div>
            <div className="text-sm text-muted-foreground">{deptName(emp.departmentId)}</div>
          </div>
          {latestReview && (
            <div className="flex items-center gap-3">
              {latestBand && latestReview.status !== 'draft' && (
                <Badge variant="outline" className={latestBand.badge}>{latestBand.label}</Badge>
              )}
              <Button asChild variant="outline" size="sm">
                <Link to={`/kpi/reviews/${encodeURIComponent(latestReview.period)}`}>
                  Open {latestReview.period} <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Current cycle progress */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Current cycle</CardTitle></CardHeader>
          <CardContent>
            {latestReview ? (
              <>
                <div className="text-2xl font-semibold">{latestReview.period}</div>
                <p className="mt-1 text-xs text-muted-foreground capitalize">
                  {latestReview.status} · weights {latestWeights}%
                  {latestWeights !== 100 && ' (must be 100%)'}
                </p>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">No review yet</div>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Self-review</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="text-2xl font-semibold">
              {latestReview ? (selfDoneOf(latestReview, latestKpis.length) ? 'Done' : `${selfPct}%`) : '—'}
            </div>
            <Progress value={selfPct} className="h-2" />
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Manager review</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="text-2xl font-semibold">
              {latestReview ? (managerDoneOf(latestReview, latestKpis.length) ? 'Done' : `${mgrPct}%`) : '—'}
            </div>
            <Progress value={mgrPct} className="h-2" />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Score trend */}
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle className="text-base">Score trend</CardTitle>
            <CardDescription>Weighted 1–5 score across submitted cycles.</CardDescription>
          </CardHeader>
          <CardContent>
            {trend.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
                No submitted reviews yet — the trend appears after the first cycle is submitted.
              </p>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="period" tickLine={false} axisLine={false} fontSize={12} />
                    <YAxis domain={[0, 5]} tickLine={false} axisLine={false} fontSize={12} />
                    <Tooltip formatter={(value) => [`${value} / 5`, 'Score']} />
                    <Line type="monotone" dataKey="score" stroke="#d97706" strokeWidth={2.5} dot={{ r: 4, fill: '#d97706' }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Category radar */}
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle className="text-base">Category radar</CardTitle>
            <CardDescription>Average manager score (1–5) per KPI category, latest submitted cycle.</CardDescription>
          </CardHeader>
          <CardContent>
            {radar.every((r) => r.score === 0) ? (
              <p className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
                No category scores yet — submit a manager review to populate the radar.
              </p>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radar} outerRadius="75%">
                    <PolarGrid stroke="var(--border)" />
                    <PolarAngleAxis dataKey="category" fontSize={12} />
                    <PolarRadiusAxis domain={[0, 5]} tick={false} axisLine={false} />
                    <Radar dataKey="score" stroke="#d97706" fill="#f59e0b" fillOpacity={0.35} />
                    <Tooltip formatter={(value) => [`${value} / 5`, 'Score']} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* OKR progress */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Active objectives</CardTitle>
          <CardDescription>OKR progress rolls up from key-result actuals.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {myObjectives.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              No active objectives — set them in the Objectives tab.
            </p>
          ) : (
            myObjectives.map((o) => {
              const pct = objectiveProgress(o);
              return (
                <div key={o.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate font-medium">{o.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{o.period} · {pct}%</span>
                  </div>
                  <Progress value={pct} className="h-2" />
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
