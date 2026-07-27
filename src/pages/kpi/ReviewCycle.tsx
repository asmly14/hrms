/**
 * /kpi/reviews/:id — Review cycle detail. :id is the URL-encoded period.
 *
 * Wave 2:
 *   - Role gating (useAuth): self scores editable only by the review's
 *     employee; manager scores / potential / submit only by the assigned
 *     reviewer (Admin/HR oversee); everything locks on submit and hard-locks
 *     on acknowledge. Closed cycles are read-only.
 *   - Evidence: per-KPI comments for both self and manager scores, plus an
 *     overall self-review narrative.
 *   - Check-ins: dated 1:1 note thread per review ('checkins' collection).
 *   - Stored scores for deleted/archived KPIs are preserved on save (B11);
 *     KPI lookup never falls back to other periods (B10).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, ClipboardCheck, Lock,
  MessageSquare, Send, User,
} from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import { avatarTone, cn, fmtDate, initialsOf } from '@/lib/utils';
import type { Department, Employee } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import {
  bandFor100, managerDoneOf, score100to5, score5to100, selfDoneOf, weightTotal,
  weightedOverall, type KpiExt, type ReviewExt,
} from './lib';
import {
  canAcknowledge, canManagerScore, canSelfScore, canViewReview, checkinsForReview,
  cycleLocksScoring, useCheckins, useKpiCycles, type CheckIn,
} from '@/lib/kpiEngine';
import { useAuthSafe } from './useAuthSafe';

function ScorePicker({
  value, onChange, tone, disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  tone: 'self' | 'manager';
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          onClick={() => onChange(value === n ? 0 : n)} // click again to clear
          className={cn(
            'h-8 w-8 rounded-lg border text-sm font-medium transition-colors',
            value === n
              ? tone === 'self'
                ? 'border-stone-400 bg-stone-600 text-white'
                : 'border-amber-500 bg-amber-500 text-white'
              : 'bg-background hover:bg-muted',
            disabled && 'cursor-not-allowed opacity-50',
          )}
          aria-label={`Score ${n}`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

interface ScoringState {
  self: Record<string, number>;
  selfNote: Record<string, string>;
  mgr: Record<string, number>;
  mgrNote: Record<string, string>;
  potential: number;
  comments: string;
  selfComments: string;
}

export default function ReviewCycle() {
  const params = useParams();
  const period = decodeURIComponent(params.id ?? '');

  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: kpis } = useCollection<KpiExt>('kpis');
  const { items: reviews, update } = useCollection<ReviewExt>('reviews');
  const { items: cycles } = useKpiCycles();
  const { items: checkins, add: addCheckin } = useCheckins();
  const auth = useAuthSafe();

  const [scoring, setScoring] = useState<ReviewExt | null>(null);
  const [state, setState] = useState<ScoringState>({
    self: {}, selfNote: {}, mgr: {}, mgrNote: {}, potential: 0, comments: '', selfComments: '',
  });
  const [checkinReview, setCheckinReview] = useState<ReviewExt | null>(null);
  const [checkinNote, setCheckinNote] = useState('');

  const cycle = useMemo(() => cycles.find((c) => c.period === period), [cycles, period]);
  const scoringLockedByCycle = cycleLocksScoring(cycle);

  const cycleReviews = useMemo(() => {
    const mine = reviews.filter((r) => r.period === period);
    // Role scoping: employees see only their own reviews; managers their
    // scope + reviews they review; Admin/HR see everything (fail-open pre-auth).
    return mine.filter((r) => canViewReview(auth, r));
  }, [reviews, period, auth]);
  const cycleName = cycle?.name ?? cycleReviews.find((r) => r.cycleName)?.cycleName ?? period;

  const empOf = (id: string) => employees.find((e) => e.id === id);
  const deptName = (id?: string) => departments.find((d) => d.id === id)?.name ?? '—';

  /** KPIs scored in a review: prefer the review period; fall back ONLY to the
   *  KPIs the stored scores reference (never to other periods — B10). */
  function kpisFor(r: ReviewExt): KpiExt[] {
    const mine = kpis.filter((k) => k.employeeId === r.employeeId && k.status !== 'archived');
    const inPeriod = mine.filter((k) => k.period === r.period);
    if (inPeriod.length > 0) return inPeriod;
    const referenced = kpis.filter((k) => k.employeeId === r.employeeId && r.scores.some((s) => s.kpiId === k.id));
    return referenced;
  }

  const progress = useMemo(() => {
    let self = 0;
    let mgr = 0;
    cycleReviews.forEach((r) => {
      const count = kpisFor(r).length;
      if (selfDoneOf(r, count)) self += 1;
      if (managerDoneOf(r, count)) mgr += 1;
    });
    return { self, mgr, total: cycleReviews.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleReviews, kpis]);

  // Initialise scoring dialog state whenever a review is opened.
  useEffect(() => {
    if (!scoring) return;
    const self: Record<string, number> = {};
    const selfNote: Record<string, string> = {};
    scoring.selfScores?.forEach((s) => {
      self[s.kpiId] = s.score;
      if (s.comment) selfNote[s.kpiId] = s.comment;
    });
    const mgr: Record<string, number> = {};
    const mgrNote: Record<string, string> = {};
    scoring.scores.forEach((s) => {
      mgr[s.kpiId] = score100to5(s.score);
      if (s.comment) mgrNote[s.kpiId] = s.comment;
    });
    setState({
      self, selfNote, mgr, mgrNote,
      potential: scoring.potential ?? 0,
      comments: scoring.comments ?? '',
      selfComments: scoring.selfComments ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoring?.id]);

  const scoringKpis = scoring ? kpisFor(scoring) : [];
  const liveOverall100 = useMemo(() => {
    if (!scoring) return 0;
    const scored = scoringKpis.filter((k) => (state.mgr[k.id] ?? 0) > 0);
    const scores = scored.map((k) => ({ kpiId: k.id, score: score5to100(state.mgr[k.id]) }));
    // Renormalize over the SCORED weights so a partial draft isn't depressed.
    return weightedOverall(scores, scored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mgr, scoring, kpis]);

  const weights = weightTotal(scoringKpis);
  const allMgrScored = scoringKpis.length > 0 && scoringKpis.every((k) => (state.mgr[k.id] ?? 0) > 0);
  const allSelfScored = scoringKpis.length > 0 && scoringKpis.every((k) => (state.self[k.id] ?? 0) > 0);
  const band = bandFor100(liveOverall100);

  const maySelfScore = !!scoring && canSelfScore(auth, scoring) && !scoringLockedByCycle;
  const mayMgrScore = !!scoring && canManagerScore(auth, scoring) && !scoringLockedByCycle;
  const reviewLocked = !!scoring && (scoring.status !== 'draft' || scoringLockedByCycle);

  function saveSelf() {
    if (!scoring || !maySelfScore) return;
    const selfScores = [
      // Fresh self scores for the active KPI set…
      ...scoringKpis
        .filter((k) => (state.self[k.id] ?? 0) > 0)
        .map((k) => ({
          kpiId: k.id,
          score: state.self[k.id],
          comment: state.selfNote[k.id]?.trim() || undefined,
        })),
      // …plus preserved self scores for since-deleted/archived KPIs (B11).
      ...(scoring.selfScores ?? []).filter((s) => !scoringKpis.some((k) => k.id === s.kpiId)),
    ];
    update(scoring.id, {
      selfScores,
      selfComments: state.selfComments.trim() || undefined,
    });
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.selfReviewSave',
      entity: 'reviews', entityId: scoring.id,
      detail: `${empOf(scoring.employeeId)?.name ?? scoring.employeeId} · ${period} · self-review ${selfScores.length}/${scoringKpis.length}`,
    });
    setScoring(null);
  }

  function saveManager(stage: 'draft' | 'submit') {
    if (!scoring || !mayMgrScore) return;
    const scored = scoringKpis.filter((k) => (state.mgr[k.id] ?? 0) > 0);
    const scores = [
      ...scored.map((k) => ({
        kpiId: k.id,
        score: score5to100(state.mgr[k.id]),
        comment: state.mgrNote[k.id]?.trim() || undefined,
      })),
      // Preserve stored scores for since-deleted/archived KPIs (B11).
      ...scoring.scores.filter((s) => !scoringKpis.some((k) => k.id === s.kpiId)),
    ];
    const overall = weightedOverall(
      scored.map((k) => ({ kpiId: k.id, score: score5to100(state.mgr[k.id]) })),
      scored,
    );
    const isSubmit = stage === 'submit' && allMgrScored && weights === 100;
    update(scoring.id, {
      scores,
      potential: state.potential > 0 ? state.potential : undefined,
      comments: state.comments.trim() || undefined,
      overallScore: overall,
      status: isSubmit ? 'submitted' : 'draft',
    });
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module',
      action: isSubmit ? 'kpi.reviewSubmit' : 'kpi.reviewSave',
      entity: 'reviews',
      entityId: scoring.id,
      detail: `${empOf(scoring.employeeId)?.name ?? scoring.employeeId} · ${period} · ${(overall / 20).toFixed(1)}/5`,
    });
    setScoring(null);
  }

  function acknowledge(r: ReviewExt) {
    if (!canAcknowledge(auth, r) || scoringLockedByCycle) return;
    update(r.id, { status: 'acknowledged', acknowledgedAt: new Date().toISOString() });
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.reviewAck', entity: 'reviews', entityId: r.id,
      detail: `${empOf(r.employeeId)?.name ?? r.employeeId} · ${period}`,
    });
  }

  function postCheckin() {
    if (!checkinReview || !checkinNote.trim()) return;
    const isEmployee = auth?.employeeId === checkinReview.employeeId;
    const authorRole: CheckIn['authorRole'] = isEmployee ? 'employee' : 'manager';
    const authorName =
      (auth?.employeeId ? empOf(auth.employeeId)?.name : undefined) ??
      auth?.user?.username ??
      (isEmployee ? 'Employee' : 'Manager');
    addCheckin({
      reviewId: checkinReview.id,
      employeeId: checkinReview.employeeId,
      authorId: auth?.employeeId ?? undefined,
      authorName,
      authorRole,
      note: checkinNote.trim(),
      createdAt: new Date().toISOString(),
    });
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.checkin',
      entity: 'checkins', entityId: checkinReview.id,
      detail: `${authorName} · 1:1 note on ${empOf(checkinReview.employeeId)?.name ?? checkinReview.employeeId} (${period})`,
    });
    setCheckinNote('');
  }

  const stageChip = (r: ReviewExt, kpiCount: number) => {
    if (r.status === 'acknowledged') return { label: 'Acknowledged', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
    if (r.status === 'submitted') return { label: 'Awaiting acknowledgment', cls: 'bg-lime-100 text-lime-800 border-lime-200' };
    if (!selfDoneOf(r, kpiCount)) return { label: 'Self-review pending', cls: 'bg-stone-200 text-stone-700 border-stone-300' };
    return { label: 'Manager review pending', cls: 'bg-amber-100 text-amber-800 border-amber-200' };
  };

  if (reviews.length > 0 && cycleReviews.length === 0) {
    return (
      <div className="space-y-6">
        <Button asChild variant="ghost" size="sm">
          <Link to="/kpi"><ArrowLeft className="mr-1 h-4 w-4" /> Back to KPI</Link>
        </Button>
        <Empty className="rounded-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ClipboardCheck /></EmptyMedia>
            <EmptyTitle>Cycle not found</EmptyTitle>
            <EmptyDescription>No reviews exist for period “{period}”, or none are visible to your role.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/kpi"><ArrowLeft className="mr-1 h-4 w-4" /> Back to KPI</Link>
        </Button>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ClipboardCheck className="h-6 w-6 text-amber-600" />
          {cycleName}
          {scoringLockedByCycle && (
            <Badge variant="secondary" className="border bg-stone-200 text-stone-700 border-stone-300">
              <Lock className="mr-1 h-3 w-3" /> Closed
            </Badge>
          )}
        </h1>
        <p className="text-sm text-muted-foreground">
          Period {period} · self-review then manager review, scored 1–5 per KPI with auto-weighted totals.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Employees</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-semibold">{progress.total}</div></CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Self-review done</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="text-2xl font-semibold">{progress.self}/{progress.total}</div>
            <Progress value={progress.total ? (progress.self / progress.total) * 100 : 0} className="h-2" />
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Manager review done</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="text-2xl font-semibold">{progress.mgr}/{progress.total}</div>
            <Progress value={progress.total ? (progress.mgr / progress.total) * 100 : 0} className="h-2" />
          </CardContent>
        </Card>
      </div>

      {cycleReviews.length === 0 ? (
        <Empty className="rounded-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ClipboardCheck /></EmptyMedia>
            <EmptyTitle>No reviews in this cycle</EmptyTitle>
            <EmptyDescription>Create a cycle from the Review Cycles tab to populate this page.</EmptyDescription>
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
                    <th className="px-4 py-3 font-medium">Reviewer</th>
                    <th className="px-4 py-3 font-medium">Weights</th>
                    <th className="px-4 py-3 font-medium">Self</th>
                    <th className="px-4 py-3 font-medium">Manager</th>
                    <th className="px-4 py-3 font-medium">Score</th>
                    <th className="px-4 py-3 font-medium">Rating</th>
                    <th className="px-4 py-3 font-medium">Stage</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {cycleReviews.map((r) => {
                    const emp = empOf(r.employeeId);
                    const list = kpisFor(r);
                    const w = weightTotal(list);
                    const selfN = r.selfScores?.length ?? 0;
                    const mgrN = r.scores.filter((s) => s.score > 0).length;
                    const b = r.overallScore > 0 ? bandFor100(r.overallScore) : null;
                    const chip = stageChip(r, list.length);
                    const locked = r.status !== 'draft' || scoringLockedByCycle;
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(emp?.name ?? '?'))}>
                              {initialsOf(emp?.name ?? '?')}
                            </span>
                            <div>
                              <div className="font-medium">{emp?.name ?? r.employeeId}</div>
                              <div className="text-xs text-muted-foreground">{deptName(emp?.departmentId)}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{empOf(r.reviewerId)?.name ?? '—'}</td>
                        <td className="px-4 py-3">
                          {w === 100 ? (
                            <Badge variant="secondary" className="border bg-lime-100 text-lime-800 border-lime-200">100%</Badge>
                          ) : (
                            <Badge variant="secondary" className="border bg-orange-100 text-orange-800 border-orange-200">
                              <AlertTriangle className="mr-1 h-3 w-3" />{w}%
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{selfN}/{list.length}</td>
                        <td className="px-4 py-3 text-muted-foreground">{mgrN}/{list.length}</td>
                        <td className="px-4 py-3 font-medium">
                          {r.overallScore > 0 ? `${score100to5(r.overallScore).toFixed(1)} / 5` : '—'}
                        </td>
                        <td className="px-4 py-3">
                          {b && r.status !== 'draft' ? <Badge variant="outline" className={b.badge}>{b.label}</Badge> : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="secondary" className={cn('border', chip.cls)}>{chip.label}</Badge>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="outline" size="sm" onClick={() => setScoring(r)}>
                              {locked ? <><Lock className="mr-1 h-3.5 w-3.5" /> View</> : <>Score <ChevronRight className="ml-1 h-3.5 w-3.5" /></>}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setCheckinReview(r)}>
                              <MessageSquare className="mr-1 h-3.5 w-3.5" /> 1:1
                            </Button>
                            {r.status === 'submitted' && canAcknowledge(auth, r) && !scoringLockedByCycle && (
                              <Button variant="ghost" size="sm" onClick={() => acknowledge(r)}>
                                <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Acknowledge
                              </Button>
                            )}
                          </div>
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
            {cycleReviews.map((r) => {
              const emp = empOf(r.employeeId);
              const list = kpisFor(r);
              const b = r.overallScore > 0 && r.status !== 'draft' ? bandFor100(r.overallScore) : null;
              const chip = stageChip(r, list.length);
              const locked = r.status !== 'draft' || scoringLockedByCycle;
              return (
                <Card key={r.id} className="rounded-xl">
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-center gap-2.5">
                      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(emp?.name ?? '?'))}>
                        {initialsOf(emp?.name ?? '?')}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{emp?.name ?? r.employeeId}</div>
                        <div className="text-xs text-muted-foreground">{deptName(emp?.departmentId)} · reviewer {empOf(r.reviewerId)?.name ?? '—'}</div>
                      </div>
                      {b && <Badge variant="outline" className={b.badge}>{b.label}</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>Self {(r.selfScores?.length ?? 0)}/{list.length}</span><span>·</span>
                      <span>Manager {r.scores.filter((s) => s.score > 0).length}/{list.length}</span><span>·</span>
                      <span className="font-medium text-foreground">
                        {r.overallScore > 0 ? `${score100to5(r.overallScore).toFixed(1)} / 5` : 'Not scored'}
                      </span>
                      <Badge variant="secondary" className={cn('ml-auto border', chip.cls)}>{chip.label}</Badge>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="flex-1" onClick={() => setScoring(r)}>
                        {locked ? 'View' : 'Score'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setCheckinReview(r)}>1:1</Button>
                      {r.status === 'submitted' && canAcknowledge(auth, r) && !scoringLockedByCycle && (
                        <Button variant="ghost" size="sm" onClick={() => acknowledge(r)}>Acknowledge</Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* ── Scoring dialog ─────────────────────────────────────────────── */}
      <Dialog open={!!scoring} onOpenChange={(o) => !o && setScoring(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          {scoring && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <User className="h-5 w-5 text-amber-600" />
                  {empOf(scoring.employeeId)?.name ?? scoring.employeeId}
                </DialogTitle>
                <DialogDescription>
                  {period} · reviewer {empOf(scoring.reviewerId)?.name ?? '—'} · created {fmtDate(scoring.createdAt)}
                </DialogDescription>
              </DialogHeader>

              {reviewLocked && (
                <div className="flex items-start gap-2 rounded-lg border border-stone-300 bg-stone-100 px-3 py-2 text-xs text-stone-700">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {scoring.status === 'acknowledged'
                    ? 'This review has been acknowledged and is locked.'
                    : scoringLockedByCycle
                      ? 'This cycle is closed — scores are read-only.'
                      : 'This review has been submitted and is locked pending acknowledgment.'}
                </div>
              )}

              {weights !== 100 && !reviewLocked && (
                <div className="flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  KPI weights total {weights}% — they must equal 100% before the manager review can be submitted. Fix weights in the KPI Library tab.
                </div>
              )}

              <div className="space-y-4">
                {scoringKpis.length === 0 && (
                  <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                    No active KPIs for this employee in {period} — add them in the KPI Library tab first.
                  </p>
                )}
                {scoringKpis.map((k) => (
                  <div key={k.id} className="space-y-3 rounded-xl border p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{k.title}</div>
                        <div className="text-xs text-muted-foreground">
                          Target: {k.target}{k.unit ? ` · ${k.unit}` : ''}
                        </div>
                      </div>
                      <Badge variant="secondary">{k.weight}%</Badge>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Self score (1–5)</Label>
                        <ScorePicker
                          tone="self"
                          value={state.self[k.id] ?? 0}
                          disabled={!maySelfScore}
                          onChange={(v) => setState((s) => ({ ...s, self: { ...s.self, [k.id]: v } }))}
                        />
                        <Input
                          value={state.selfNote[k.id] ?? ''}
                          disabled={!maySelfScore}
                          onChange={(e) => setState((s) => ({ ...s, selfNote: { ...s.selfNote, [k.id]: e.target.value } }))}
                          placeholder="Self evidence / notes…"
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Manager score (1–5)</Label>
                        <ScorePicker
                          tone="manager"
                          value={state.mgr[k.id] ?? 0}
                          disabled={!mayMgrScore}
                          onChange={(v) => setState((s) => ({ ...s, mgr: { ...s.mgr, [k.id]: v } }))}
                        />
                        <Input
                          value={state.mgrNote[k.id] ?? ''}
                          disabled={!mayMgrScore}
                          onChange={(e) => setState((s) => ({ ...s, mgrNote: { ...s.mgrNote, [k.id]: e.target.value } }))}
                          placeholder="Manager evidence / comment…"
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                  </div>
                ))}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Potential (manager, 1–5) — feeds 9-box</Label>
                    <Select
                      value={state.potential > 0 ? String(state.potential) : ''}
                      onValueChange={(v) => setState((s) => ({ ...s, potential: Number(v) }))}
                      disabled={!mayMgrScore}
                    >
                      <SelectTrigger><SelectValue placeholder="Rate potential" /></SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <SelectItem key={n} value={String(n)}>{n} — {['Limited', 'Developing', 'Solid', 'High', 'Exceptional'][n - 1]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Manager overall comments</Label>
                    <Textarea
                      rows={2}
                      value={state.comments}
                      disabled={!mayMgrScore}
                      onChange={(e) => setState((s) => ({ ...s, comments: e.target.value }))}
                      placeholder="Strengths, gaps, development plan…"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>Self-review narrative (employee)</Label>
                  <Textarea
                    rows={2}
                    value={state.selfComments}
                    disabled={!maySelfScore}
                    onChange={(e) => setState((s) => ({ ...s, selfComments: e.target.value }))}
                    placeholder="Your summary of the period — wins, blockers, asks…"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-3">
                  <div className="text-sm">
                    <span className="text-muted-foreground">Weighted total: </span>
                    <span className="text-lg font-semibold">{score100to5(liveOverall100).toFixed(1)} / 5</span>
                    <span className="ml-2 text-xs text-muted-foreground">({liveOverall100}/100)</span>
                  </div>
                  {liveOverall100 > 0 && <Badge variant="outline" className={band.badge}>{band.label}</Badge>}
                </div>
              </div>

              <DialogFooter className="gap-2 sm:justify-between">
                <div className="text-xs text-muted-foreground">
                  {allSelfScored ? 'Self-review complete.' : 'Self-review pending.'}{' '}
                  {allMgrScored ? 'Manager scoring complete.' : 'Manager scoring pending.'}
                </div>
                <div className="flex gap-2">
                  {maySelfScore && (
                    <Button variant="outline" onClick={saveSelf}>Save self-review</Button>
                  )}
                  {mayMgrScore && (
                    <>
                      <Button variant="outline" onClick={() => saveManager('draft')}>Save manager draft</Button>
                      <Button onClick={() => saveManager('submit')} disabled={!allMgrScored || weights !== 100}>
                        Submit review
                      </Button>
                    </>
                  )}
                  {scoring.status === 'submitted' && canAcknowledge(auth, scoring) && !scoringLockedByCycle && (
                    <Button onClick={() => { acknowledge(scoring); setScoring(null); }}>
                      <CheckCircle2 className="mr-1 h-4 w-4" /> Acknowledge
                    </Button>
                  )}
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Check-in thread dialog ─────────────────────────────────────── */}
      <Dialog open={!!checkinReview} onOpenChange={(o) => { if (!o) { setCheckinReview(null); setCheckinNote(''); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {checkinReview && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-amber-600" />
                  1:1 check-ins — {empOf(checkinReview.employeeId)?.name ?? checkinReview.employeeId}
                </DialogTitle>
                <DialogDescription>
                  Dated notes shared between the employee and {empOf(checkinReview.reviewerId)?.name ?? 'the reviewer'} for {period}.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                {checkinsForReview(checkins, checkinReview.id).length === 0 ? (
                  <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                    No check-ins yet — start the thread with a progress note.
                  </p>
                ) : (
                  checkinsForReview(checkins, checkinReview.id).map((c) => (
                    <div
                      key={c.id}
                      className={cn(
                        'rounded-xl border px-3 py-2.5',
                        c.authorRole === 'manager' ? 'border-amber-200 bg-amber-50/60' : 'border-stone-200 bg-stone-50',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{c.authorName}</span>
                        <span>{fmtDate(c.createdAt)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm">{c.note}</p>
                    </div>
                  ))
                )}
              </div>

              {!scoringLockedByCycle && (
                <div className="flex items-start gap-2">
                  <Textarea
                    rows={2}
                    value={checkinNote}
                    onChange={(e) => setCheckinNote(e.target.value)}
                    placeholder="Add a dated check-in note…"
                  />
                  <Button size="icon" onClick={postCheckin} disabled={!checkinNote.trim()} aria-label="Post check-in">
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
