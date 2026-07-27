/**
 * Outcomes tab — suggested increment % bands by rating, with RM ranges from
 * current base salary and a pointer to /insights/salary for benchmarking.
 * Bands: Outstanding 8–12% · Exceeds 5–8% · Meets 3–5% · Below 0–2% · Poor 0%.
 *
 * Wave 2: draft-free (submitted/acknowledged only), review status column, and
 * a PIP trigger — a 'Poor' rating can start a performance improvement plan
 * directly from the outcomes table.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ClipboardList, Info, TrendingUp } from 'lucide-react';
import { logAudit } from '@/lib/db';
import type { Employee } from '@/lib/types';
import { avatarTone, cn, fmtRM, initialsOf } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import { BANDS, bandFor100, score100to5, type ReviewExt } from './lib';
import { activePipFor, canManagePip, isFinalReview, usePips } from '@/lib/kpiEngine';
import { useAuthSafe } from './useAuthSafe';

interface Props {
  employees: Employee[];
  reviews: ReviewExt[];
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export default function Outcomes({ employees, reviews }: Props) {
  const auth = useAuthSafe();
  const { items: pips, add: addPip } = usePips();

  const periods = useMemo(
    () => [...new Set(reviews.map((r) => r.period))].sort().reverse(),
    [reviews],
  );
  const [period, setPeriod] = useState('');

  const [pipReview, setPipReview] = useState<ReviewExt | null>(null);
  const [pipEnd, setPipEnd] = useState('');
  const [pipGoals, setPipGoals] = useState('');

  const activePeriod = period || periods[0] || '';
  // Draft-free: only submitted/acknowledged reviews produce outcomes (B3).
  const scoped = useMemo(
    () =>
      reviews
        .filter((r) => r.period === activePeriod && isFinalReview(r))
        .sort((a, b) => b.overallScore - a.overallScore),
    [reviews, activePeriod],
  );

  const empOf = (id: string) => employees.find((e) => e.id === id);

  function openPip(r: ReviewExt) {
    setPipReview(r);
    const end = new Date();
    end.setDate(end.getDate() + 30);
    setPipEnd(isoDate(end));
    setPipGoals('');
  }

  function createPip() {
    if (!pipReview) return;
    const emp = empOf(pipReview.employeeId);
    const goals = pipGoals
      .split('\n')
      .map((g) => g.trim())
      .filter(Boolean)
      .map((title, i) => ({
        id: `goal-${i + 1}`,
        title,
        dueDate: pipEnd,
        status: 'open' as const,
      }));
    if (goals.length === 0) return;
    addPip({
      employeeId: pipReview.employeeId,
      reviewId: pipReview.id,
      period: pipReview.period,
      startDate: isoDate(new Date()),
      endDate: pipEnd,
      goals,
      notes: [],
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.pipCreate', entity: 'pips',
      detail: `PIP started for ${emp?.name ?? pipReview.employeeId} (${pipReview.period}) — ${goals.length} goals, due ${pipEnd}`,
    });
    setPipReview(null);
  }

  if (periods.length === 0) {
    return (
      <Empty className="rounded-xl border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><TrendingUp /></EmptyMedia>
          <EmptyTitle>No outcomes yet</EmptyTitle>
          <EmptyDescription>Complete a review cycle to see increment recommendations.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-amber-600" />
          <h2 className="text-base font-semibold">Review outcomes</h2>
        </div>
        <Select value={activePeriod} onValueChange={setPeriod}>
          <SelectTrigger className="ml-auto w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {periods.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Band reference */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {BANDS.map((b) => (
          <Card key={b.label} className="rounded-xl">
            <CardContent className="space-y-1.5 p-4">
              <Badge variant="outline" className={b.badge}>{b.label}</Badge>
              <div className="text-lg font-semibold">
                {b.increment[0] === b.increment[1] ? `${b.increment[0]}%` : `${b.increment[0]}–${b.increment[1]}%`}
              </div>
              <p className="text-xs text-muted-foreground">suggested increment</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="rounded-xl border-amber-200 bg-amber-50/60">
        <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-900">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Increment bands are guidelines — sense-check affordability against the payroll budget and validate each
            employee's position in the market range under{' '}
            <Link to="/insights/salary" className="inline-flex items-center gap-1 font-medium text-amber-800 underline-offset-4 hover:underline">
              Salary Insights <ArrowRight className="h-3 w-3" />
            </Link>{' '}
            before letters go out.
          </p>
        </CardContent>
      </Card>

      {scoped.length === 0 ? (
        <Empty className="rounded-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><TrendingUp /></EmptyMedia>
            <EmptyTitle>No submitted reviews in {activePeriod}</EmptyTitle>
            <EmptyDescription>Outcomes appear once manager reviews are submitted for this cycle.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {/* md+ table */}
          <Card className="hidden rounded-xl md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Employee</th>
                    <th className="px-4 py-3 font-medium">Score</th>
                    <th className="px-4 py-3 font-medium">Rating</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Increment band</th>
                    <th className="px-4 py-3 font-medium">Current basic</th>
                    <th className="px-4 py-3 font-medium">Suggested range (RM/mth)</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {scoped.map((r) => {
                    const emp = empOf(r.employeeId);
                    const band = bandFor100(r.overallScore);
                    const [lo, hi] = band.increment;
                    const salary = emp?.baseSalary ?? 0;
                    const pip = activePipFor(pips, r.employeeId);
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(emp?.name ?? '?'))}>
                              {initialsOf(emp?.name ?? '?')}
                            </span>
                            <span className="font-medium">{emp?.name ?? r.employeeId}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-medium">{score100to5(r.overallScore).toFixed(1)} / 5</td>
                        <td className="px-4 py-3"><Badge variant="outline" className={band.badge}>{band.label}</Badge></td>
                        <td className="px-4 py-3">
                          <Badge variant={r.status === 'acknowledged' ? 'default' : 'secondary'} className="capitalize">{r.status}</Badge>
                        </td>
                        <td className="px-4 py-3">{lo === hi ? `${lo}%` : `${lo}–${hi}%`}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtRM(salary)}</td>
                        <td className="px-4 py-3 font-medium">
                          {hi === 0
                            ? 'No increment'
                            : `${fmtRM((salary * lo) / 100)} – ${fmtRM((salary * hi) / 100)}`}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {band.label === 'Poor' && canManagePip(auth, r.employeeId) && (
                            pip ? (
                              <Badge variant="secondary" className="border bg-red-100 text-red-800 border-red-200">PIP active</Badge>
                            ) : (
                              <Button variant="outline" size="sm" onClick={() => openPip(r)}>
                                <ClipboardList className="mr-1 h-3.5 w-3.5" /> Start PIP
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* mobile cards */}
          <div className="space-y-3 md:hidden">
            {scoped.map((r) => {
              const emp = empOf(r.employeeId);
              const band = bandFor100(r.overallScore);
              const [lo, hi] = band.increment;
              const salary = emp?.baseSalary ?? 0;
              const pip = activePipFor(pips, r.employeeId);
              return (
                <Card key={r.id} className="rounded-xl">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-center gap-2.5">
                      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(emp?.name ?? '?'))}>
                        {initialsOf(emp?.name ?? '?')}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{emp?.name ?? r.employeeId}</div>
                        <div className="text-xs text-muted-foreground">{score100to5(r.overallScore).toFixed(1)} / 5 · basic {fmtRM(salary)}</div>
                      </div>
                      <Badge variant="outline" className={band.badge}>{band.label}</Badge>
                    </div>
                    <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                      <span className="text-muted-foreground">Suggested ({lo === hi ? `${lo}%` : `${lo}–${hi}%`}): </span>
                      <span className="font-medium">
                        {hi === 0 ? 'No increment' : `${fmtRM((salary * lo) / 100)} – ${fmtRM((salary * hi) / 100)} /mth`}
                      </span>
                    </div>
                    {band.label === 'Poor' && canManagePip(auth, r.employeeId) && (
                      pip ? (
                        <Badge variant="secondary" className="border bg-red-100 text-red-800 border-red-200">PIP active</Badge>
                      ) : (
                        <Button variant="outline" size="sm" className="w-full" onClick={() => openPip(r)}>
                          <ClipboardList className="mr-1 h-3.5 w-3.5" /> Start improvement plan
                        </Button>
                      )
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">How bands are derived</CardTitle>
          <CardDescription>Weighted 1–5 score → rating band → increment guideline.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
          <p>≥ 4.5 Outstanding → <Badge variant="secondary">8–12%</Badge></p>
          <p>≥ 3.5 Exceeds Expectations → <Badge variant="secondary">5–8%</Badge></p>
          <p>≥ 2.5 Meets Expectations → <Badge variant="secondary">3–5%</Badge></p>
          <p>≥ 1.5 Below Expectations → <Badge variant="secondary">0–2%</Badge></p>
          <p>&lt; 1.5 Poor → <Badge variant="secondary">0% + improvement plan</Badge></p>
        </CardContent>
      </Card>

      {/* ── Start PIP dialog ───────────────────────────────────────────── */}
      <Dialog open={!!pipReview} onOpenChange={(o) => !o && setPipReview(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Start improvement plan</DialogTitle>
            <DialogDescription>
              {pipReview ? `${empOf(pipReview.employeeId)?.name ?? pipReview.employeeId} · ${pipReview.period} · rated Poor (${score100to5(pipReview.overallScore).toFixed(1)}/5)` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="pip-end">Review-by date</Label>
              <Input id="pip-end" type="date" value={pipEnd} onChange={(e) => setPipEnd(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pip-goals">Improvement goals (one per line)</Label>
              <Textarea
                id="pip-goals"
                rows={4}
                value={pipGoals}
                onChange={(e) => setPipGoals(e.target.value)}
                placeholder={'e.g. Raise CSAT from 78% to ≥ 88%\nComplete service-excellence training'}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPipReview(null)}>Cancel</Button>
            <Button onClick={createPip} disabled={!pipEnd || !pipGoals.trim()}>Create PIP</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
