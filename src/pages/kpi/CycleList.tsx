/**
 * Review Cycles tab — first-class cycle entities ('cycles' collection) with a
 * stage machine (setup → self-review → manager-review → calibration →
 * acknowledged → closed), plus legacy periods derived from reviews that have
 * no cycle entity.
 *
 * Create-cycle wizard: assigns KPIs from the matching template pack to every
 * active employee in the chosen departments and opens a draft review for each.
 * Guards (Wave 2):
 *   - Re-run safe: employees with an existing review for the period are
 *     skipped BEFORE any KPI is created — no duplicates, no mid-cycle weight
 *     mutation.
 *   - Unified weight validator: materialization lands each employee at exactly
 *     100% (new items are renormalized around pre-existing KPIs; employees
 *     already at ≥100% with clashing titles are skipped with a warning).
 *   - Reviewer routing: Department.headId → dept-seniority pick → HR; never
 *     the employee themselves.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, CalendarRange, ChevronRight, ListChecks, Lock, Plus,
} from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import { cn } from '@/lib/utils';
import type { Department, Employee, Position } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import {
  TEMPLATE_PACKS, cycleStatsOf, empPeriodKey, packForDepartment, summariseCycle, weightTotal,
  type CycleSummary, type KpiExt, type ReviewExt, type TemplatePack,
} from './lib';
import {
  CYCLE_STAGE_LABELS, canAdvanceStage, canManageCycles, nextStage, renormalizeWeights,
  resolveReviewer, useKpiCycles, type KpiCycle,
} from '@/lib/kpiEngine';
import { useAuthSafe } from './useAuthSafe';

interface Props {
  employees: Employee[];
  departments: Department[];
  kpis: KpiExt[];
  reviews: ReviewExt[];
}

interface DraftWeights {
  [deptId: string]: { packKey: string; weights: number[] };
}

/** Stage badge tone per cycle stage. */
function stageBadge(stage: KpiCycle['stage']): string {
  switch (stage) {
    case 'setup':
      return 'bg-stone-200 text-stone-700 border-stone-300';
    case 'self-review':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'manager-review':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'calibration':
      return 'bg-lime-100 text-lime-800 border-lime-200';
    case 'acknowledged':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'closed':
      return 'bg-stone-300 text-stone-800 border-stone-400';
  }
}

export default function CycleList({ employees, departments, kpis, reviews }: Props) {
  const { add: addKpi } = useCollection<KpiExt>('kpis');
  const { add: addReview } = useCollection<ReviewExt>('reviews');
  const { items: positions } = useCollection<Position>('positions');
  const { items: cycleEntities, add: addCycle, update: updateCycle } = useKpiCycles();
  const auth = useAuthSafe();
  const mayManage = canManageCycles(auth);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [period, setPeriod] = useState(`${new Date().getFullYear()}-H1`);
  const [deptIds, setDeptIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<DraftWeights>({});

  /** Per-employee, per-period non-archived KPI count (B8 fix). */
  const kpiCountByEmpPeriod = useMemo(() => {
    const m = new Map<string, number>();
    kpis.forEach((k) => {
      if (k.status === 'archived') return;
      const key = empPeriodKey(k.employeeId, k.period);
      m.set(key, (m.get(key) ?? 0) + 1);
    });
    return m;
  }, [kpis]);

  const countFor = (empId: string, p: string) => kpiCountByEmpPeriod.get(empPeriodKey(empId, p)) ?? 0;

  /** Legacy derived cycles: periods with reviews but no first-class entity. */
  const legacyCycles = useMemo<CycleSummary[]>(() => {
    const entityPeriods = new Set(cycleEntities.map((c) => c.period));
    const periods = [...new Set(reviews.map((r) => r.period))].filter((p) => !entityPeriods.has(p));
    return periods
      .map((p) => summariseCycle(p, reviews, kpiCountByEmpPeriod))
      .sort((a, b) => b.period.localeCompare(a.period));
  }, [reviews, kpiCountByEmpPeriod, cycleEntities]);

  const entitySummaries = useMemo(() => {
    return cycleEntities
      .map((c) => ({
        cycle: c,
        summary: summariseCycle(c.period, reviews.filter((r) => r.cycleId === c.id), kpiCountByEmpPeriod),
      }))
      .sort((a, b) => b.cycle.period.localeCompare(a.cycle.period));
  }, [cycleEntities, reviews, kpiCountByEmpPeriod]);

  function toggleDept(id: string) {
    setDeptIds((prev) => {
      const next = prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id];
      setDraft((d) => {
        const copy = { ...d };
        next.forEach((deptId) => {
          if (!copy[deptId]) {
            const pack = packForDepartment(deptId);
            copy[deptId] = { packKey: pack.key, weights: pack.items.map((i) => i.weight) };
          }
        });
        Object.keys(copy).forEach((k) => {
          if (!next.includes(k)) delete copy[k];
        });
        return copy;
      });
      return next;
    });
  }

  function setPack(deptId: string, packKey: string) {
    const pack = TEMPLATE_PACKS.find((p) => p.key === packKey) ?? TEMPLATE_PACKS[0];
    setDraft((d) => ({ ...d, [deptId]: { packKey: pack.key, weights: pack.items.map((i) => i.weight) } }));
  }

  function setWeight(deptId: string, idx: number, value: number) {
    setDraft((d) => {
      const cur = d[deptId];
      if (!cur) return d;
      const weights = cur.weights.map((w, i) => (i === idx ? Math.max(0, Math.min(100, value)) : w));
      return { ...d, [deptId]: { ...cur, weights } };
    });
  }

  const packOf = (deptId: string): TemplatePack =>
    TEMPLATE_PACKS.find((p) => p.key === draft[deptId]?.packKey) ?? packForDepartment(deptId);

  const targetEmployees = useMemo(
    () => employees.filter((e) => e.status !== 'resigned' && deptIds.includes(e.departmentId)),
    [employees, deptIds],
  );

  const periodTaken = useMemo(
    () => cycleEntities.some((c) => c.period === period.trim()),
    [cycleEntities, period],
  );

  /** Dry-run materialization plan: who gets KPIs, who is skipped and why.
   *  Re-run safe by construction — planned before a single write happens. */
  const plan = useMemo(() => {
    const p = period.trim();
    let willCreate = 0;
    let skippedExisting = 0;
    let skippedConflict = 0;
    targetEmployees.forEach((emp) => {
      if (reviews.some((r) => r.employeeId === emp.id && r.period === p)) {
        skippedExisting += 1;
        return;
      }
      const existing = kpis.filter(
        (k) => k.employeeId === emp.id && k.period === p && k.status !== 'archived',
      );
      const pack = packOf(emp.departmentId);
      const fresh = pack.items.filter((it) => !existing.some((k) => k.title === it.title));
      if (fresh.length === 0) {
        willCreate += 1; // review only; KPIs already in place
        return;
      }
      const existingTotal = weightTotal(existing);
      if (existingTotal >= 100) {
        skippedConflict += 1; // would push the employee over 100%
        return;
      }
      willCreate += 1;
    });
    return { willCreate, skippedExisting, skippedConflict };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetEmployees, reviews, kpis, period, draft]);

  const weightsOk = deptIds.length > 0 && deptIds.every((id) => {
    const w = draft[id]?.weights ?? [];
    return w.reduce((s, x) => s + x, 0) === 100;
  });

  const canCreate =
    name.trim().length > 0 &&
    period.trim().length > 0 &&
    !periodTaken &&
    targetEmployees.length > 0 &&
    plan.willCreate > 0 &&
    weightsOk;

  function createCycle() {
    if (!canCreate) return;
    const p = period.trim();
    const now = new Date().toISOString();

    const cycle = addCycle({
      name: name.trim(),
      period: p,
      departmentIds: deptIds,
      stage: 'setup',
      stageHistory: [{ stage: 'setup', at: now, by: auth?.user?.username ?? 'KPI module' }],
      createdAt: now,
      createdBy: auth?.user?.username,
    });

    let kpiCreated = 0;
    let reviewCreated = 0;
    let skipped = 0;
    targetEmployees.forEach((emp) => {
      // Dedup FIRST: an employee with an existing review for the period is
      // skipped entirely — re-running never duplicates KPIs or mutates weights.
      const already = reviews.some((r) => r.employeeId === emp.id && r.period === p);
      if (already) {
        skipped += 1;
        return;
      }
      const dept = emp.departmentId;
      const pack = packOf(dept);
      const weights = draft[dept]?.weights ?? pack.items.map((i) => i.weight);
      const existing = kpis.filter(
        (k) => k.employeeId === emp.id && k.period === p && k.status !== 'archived',
      );
      const existingTotal = weightTotal(existing);
      const freshIdx = pack.items
        .map((item, i) => ({ item, i }))
        .filter(({ item }) => !existing.some((k) => k.title === item.title));

      if (freshIdx.length > 0) {
        if (existingTotal >= 100) {
          // Unified validator: materialization must not exceed 100%.
          skipped += 1;
          return;
        }
        // Renormalize the NEW items around the pre-existing KPIs so the
        // employee lands at exactly 100% (title-skip safe).
        const freshWeights = renormalizeWeights(freshIdx.map(({ i }) => weights[i] ?? pack.items[i].weight));
        const remaining = 100 - existingTotal;
        const scaled = renormalizeWeights(freshWeights.map((w) => (w * remaining) / 100));
        freshIdx.forEach(({ item }, j) => {
          addKpi({
            employeeId: emp.id,
            title: item.title,
            description: item.description,
            category: item.category,
            unit: item.unit,
            target: item.target,
            weight: scaled[j] ?? item.weight,
            period: p,
            status: 'active',
            templateKey: pack.key,
          });
          kpiCreated += 1;
        });
      }

      const reviewerId = resolveReviewer(emp, { employees, departments, positions });
      addReview({
        employeeId: emp.id,
        // resolveReviewer never returns the employee themselves; '' = unrouted
        // (shown as '—') rather than an invalid self-review.
        reviewerId: reviewerId ?? '',
        period: p,
        scores: [],
        overallScore: 0,
        comments: '',
        status: 'draft',
        createdAt: now,
        cycleName: cycle.name,
        cycleId: cycle.id,
        selfScores: [],
      });
      reviewCreated += 1;
    });
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.cycleCreate', entity: 'cycles', entityId: cycle.id,
      detail: `${cycle.name} (${p}): ${reviewCreated} reviews, ${kpiCreated} KPIs across ${deptIds.length} departments${skipped ? ` · ${skipped} skipped (existing review/weight conflict)` : ''}`,
    });
    setOpen(false);
    setName('');
    setDeptIds([]);
    setDraft({});
  }

  function advance(cycle: KpiCycle) {
    const next = nextStage(cycle.stage);
    if (!next) return;
    const stats = cycleStatsOf(
      reviews.filter((r) => r.cycleId === cycle.id),
      (r) => countFor(r.employeeId, r.period),
    );
    const guard = canAdvanceStage(cycle, stats);
    if (!guard.ok) return;
    const now = new Date().toISOString();
    updateCycle(cycle.id, {
      stage: next,
      stageHistory: [...cycle.stageHistory, { stage: next, at: now, by: auth?.user?.username ?? 'KPI module' }],
    });
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.cycleStage', entity: 'cycles', entityId: cycle.id,
      detail: `${cycle.name}: ${CYCLE_STAGE_LABELS[cycle.stage]} → ${CYCLE_STAGE_LABELS[next]}`,
    });
  }

  const empty = entitySummaries.length === 0 && legacyCycles.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-amber-600" />
          <h2 className="text-base font-semibold">Review cycles</h2>
        </div>
        {mayManage && (
          <Button className="ml-auto" onClick={() => setOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New cycle
          </Button>
        )}
      </div>

      {empty ? (
        <Empty className="rounded-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarRange /></EmptyMedia>
            <EmptyTitle>No review cycles yet</EmptyTitle>
            <EmptyDescription>
              Create a cycle to assign KPIs to departments and start self + manager reviews.
            </EmptyDescription>
          </EmptyHeader>
          {mayManage && (
            <Button onClick={() => setOpen(true)}><Plus className="mr-1.5 h-4 w-4" /> New cycle</Button>
          )}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {entitySummaries.map(({ cycle, summary: c }) => {
            const selfPct = c.total ? Math.round((c.selfDone / c.total) * 100) : 0;
            const mgrPct = c.total ? Math.round((c.managerDone / c.total) * 100) : 0;
            const stats = cycleStatsOf(
              reviews.filter((r) => r.cycleId === cycle.id),
              (r) => countFor(r.employeeId, r.period),
            );
            const guard = canAdvanceStage(cycle, stats);
            const next = nextStage(cycle.stage);
            return (
              <Card key={cycle.id} className="rounded-xl">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{cycle.name}</CardTitle>
                      <CardDescription>Period {cycle.period} · {c.total} employees</CardDescription>
                    </div>
                    <Badge variant="secondary" className={cn('border', stageBadge(cycle.stage))}>
                      {cycle.stage === 'closed' && <Lock className="mr-1 h-3 w-3" />}
                      {CYCLE_STAGE_LABELS[cycle.stage]}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Stage stepper */}
                  <div className="flex flex-wrap items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {(['setup', 'self-review', 'manager-review', 'calibration', 'acknowledged', 'closed'] as const).map((s, i, arr) => (
                      <span key={s} className="flex items-center gap-1">
                        <span className={cn(
                          'rounded-full px-2 py-0.5',
                          s === cycle.stage ? 'bg-amber-100 text-amber-800' : 'bg-muted/60',
                        )}>
                          {CYCLE_STAGE_LABELS[s]}
                        </span>
                        {i < arr.length - 1 && <ChevronRight className="h-3 w-3" />}
                      </span>
                    ))}
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Self-review</span><span>{c.selfDone}/{c.total}</span>
                    </div>
                    <Progress value={selfPct} className="h-2" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Manager review</span><span>{c.managerDone}/{c.total}</span>
                    </div>
                    <Progress value={mgrPct} className="h-2" />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
                    <span>
                      {c.avg100 > 0 ? `Avg score ${(c.avg100 / 20).toFixed(1)} / 5` : 'Not scored yet'}
                      {c.acknowledged > 0 ? ` · ${c.acknowledged} acknowledged` : ''}
                    </span>
                    <div className="flex items-center gap-2">
                      {mayManage && next && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!guard.ok}
                          title={guard.ok ? `Advance to ${CYCLE_STAGE_LABELS[next]}` : guard.reason}
                          onClick={() => advance(cycle)}
                        >
                          {guard.ok ? `Advance → ${CYCLE_STAGE_LABELS[next]}` : guard.reason}
                        </Button>
                      )}
                      <Button asChild variant="outline" size="sm">
                        <Link to={`/kpi/reviews/${encodeURIComponent(cycle.period)}`}>
                          Open cycle <ArrowRight className="ml-1 h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {legacyCycles.map((c) => {
            const selfPct = c.total ? Math.round((c.selfDone / c.total) * 100) : 0;
            const mgrPct = c.total ? Math.round((c.managerDone / c.total) * 100) : 0;
            return (
              <Card key={c.period} className="rounded-xl">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{c.name}</CardTitle>
                      <CardDescription>Period {c.period} · {c.total} employees</CardDescription>
                    </div>
                    <Badge variant="secondary" className="border bg-stone-200 text-stone-700 border-stone-300">
                      Legacy cycle
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Self-review</span><span>{c.selfDone}/{c.total}</span>
                    </div>
                    <Progress value={selfPct} className="h-2" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Manager review</span><span>{c.managerDone}/{c.total}</span>
                    </div>
                    <Progress value={mgrPct} className="h-2" />
                  </div>
                  <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                    <span>
                      {c.avg100 > 0 ? `Avg score ${(c.avg100 / 20).toFixed(1)} / 5` : 'Not scored yet'}
                      {c.acknowledged > 0 ? ` · ${c.acknowledged} acknowledged` : ''}
                    </span>
                    <Button asChild variant="outline" size="sm">
                      <Link to={`/kpi/reviews/${encodeURIComponent(c.period)}`}>
                        Open cycle <ArrowRight className="ml-1 h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Create cycle wizard ────────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New review cycle</DialogTitle>
            <DialogDescription>
              Assign KPIs from template packs to every active employee in the selected departments, then run self-review and manager-review stages. Weights per department must total 100%.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="cyc-name">Cycle name</Label>
                <Input id="cyc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 Mid-Year Review" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cyc-period">Period</Label>
                <Input id="cyc-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-H1" />
                {periodTaken && (
                  <p className="text-xs text-orange-700">A cycle already exists for this period.</p>
                )}
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Departments</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {departments.map((d) => {
                  const checked = deptIds.includes(d.id);
                  return (
                    <label
                      key={d.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                        checked ? 'border-amber-300 bg-amber-50' : 'hover:bg-muted/50',
                      )}
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleDept(d.id)} />
                      <span className="font-medium">{d.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {employees.filter((e) => e.departmentId === d.id && e.status !== 'resigned').length} staff
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {deptIds.map((deptId) => {
              const pack = packOf(deptId);
              const weights = draft[deptId]?.weights ?? [];
              const total = weights.reduce((s, x) => s + x, 0);
              const dept = departments.find((d) => d.id === deptId);
              return (
                <div key={deptId} className="space-y-3 rounded-xl border p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-semibold">{dept?.name ?? deptId}</span>
                    <select
                      className="ml-auto h-9 rounded-md border bg-background px-2 text-sm"
                      value={pack.key}
                      onChange={(e) => setPack(deptId, e.target.value)}
                      aria-label={`Template pack for ${dept?.name ?? deptId}`}
                    >
                      {TEMPLATE_PACKS.map((p) => (
                        <option key={p.key} value={p.key}>{p.label}</option>
                      ))}
                    </select>
                    <Badge
                      variant="secondary"
                      className={cn('border', total === 100
                        ? 'bg-lime-100 text-lime-800 border-lime-200'
                        : 'bg-orange-100 text-orange-800 border-orange-200')}
                    >
                      Total {total}%
                    </Badge>
                  </div>
                  <div className="space-y-2">
                    {pack.items.map((item, i) => (
                      <div key={item.title} className="flex items-center gap-3 text-sm">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{item.title}</span>
                          <span className="block text-xs text-muted-foreground">{item.target}</span>
                        </div>
                        <div className="flex w-24 items-center gap-1">
                          <Input
                            type="number" min={0} max={100}
                            value={weights[i] ?? item.weight}
                            onChange={(e) => setWeight(deptId, i, Number(e.target.value) || 0)}
                            className="h-8 text-right"
                          />
                          <span className="text-xs text-muted-foreground">%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {deptIds.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {plan.willCreate} employee(s) will receive KPIs (renormalized to 100% where titles already exist) and a
                draft review routed to their department head.
                {plan.skippedExisting > 0 && ` ${plan.skippedExisting} skipped — review already exists for this period.`}
                {plan.skippedConflict > 0 && ` ${plan.skippedConflict} skipped — existing KPIs already total ≥100%.`}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={createCycle} disabled={!canCreate}>
              Create cycle
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
