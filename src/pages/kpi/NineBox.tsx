/**
 * 9-Box Grid tab — performance (weighted score, 1–5) vs potential (manager
 * rating, 1–5) on a 3×3 grid with employee initials and box labels.
 * Reviews without a potential rating are placed in the middle row (flagged).
 */
import { useMemo, useState } from 'react';
import { Grid3X3 } from 'lucide-react';
import type { Department, Employee } from '@/lib/types';
import { avatarTone, cn, initialsOf } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import { score100to5, type ReviewExt } from './lib';
import { isFinalReview } from '@/lib/kpiEngine';

interface Props {
  employees: Employee[];
  departments: Department[];
  reviews: ReviewExt[];
}

type Bucket = 0 | 1 | 2; // low / mid / high

function bucketOf(score5: number): Bucket {
  if (score5 >= 3.5) return 2;
  if (score5 >= 2.5) return 1;
  return 0;
}

/** Rows top→bottom = high→low potential; cols left→right = low→high performance. */
const BOX_LABELS: string[][] = [
  ['Enigma — coach for results', 'Growth talent — stretch them', 'Star — ready for more'],
  ['Inconsistent — unblock delivery', 'Core — solid contributor', 'High performer — key player'],
  ['Underperformer — action needed', 'Effective — near ceiling', 'Specialist — trusted expert'],
];

const BOX_TONES: string[][] = [
  ['bg-orange-50 border-orange-100', 'bg-lime-50 border-lime-100', 'bg-emerald-50 border-emerald-100'],
  ['bg-orange-50/60 border-orange-100/80', 'bg-stone-50 border-stone-100', 'bg-lime-50 border-lime-100'],
  ['bg-red-50 border-red-100', 'bg-stone-50 border-stone-100', 'bg-amber-50 border-amber-100'],
];

const AXIS_LOW_MID_HIGH = ['Low', 'Moderate', 'High'];

export default function NineBox({ employees, departments, reviews }: Props) {
  const periods = useMemo(
    () => [...new Set(reviews.map((r) => r.period))].sort().reverse(),
    [reviews],
  );
  const [period, setPeriod] = useState('');

  const activePeriod = period || periods[0] || '';
  // Draft-free: only submitted/acknowledged reviews are plotted (B3).
  const scoped = useMemo(
    () => reviews.filter((r) => r.period === activePeriod && isFinalReview(r)),
    [reviews, activePeriod],
  );

  const placed = useMemo(() => {
    return scoped.map((r) => {
      const perf = bucketOf(score100to5(r.overallScore));
      const hasPotential = (r.potential ?? 0) > 0;
      const pot = bucketOf(hasPotential ? (r.potential as number) : 3);
      return { review: r, perf, pot, hasPotential };
    });
  }, [scoped]);

  const empOf = (id: string) => employees.find((e) => e.id === id);
  const deptName = (id?: string) => departments.find((d) => d.id === id)?.name ?? '';
  const unrated = placed.filter((p) => !p.hasPotential).length;

  if (periods.length === 0) {
    return (
      <Empty className="rounded-xl border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Grid3X3 /></EmptyMedia>
          <EmptyTitle>No reviews yet</EmptyTitle>
          <EmptyDescription>The 9-box grid fills in once a review cycle has scored employees.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Grid3X3 className="h-4 w-4 text-amber-600" />
          <h2 className="text-base font-semibold">9-box talent grid</h2>
        </div>
        <Select value={activePeriod} onValueChange={setPeriod}>
          <SelectTrigger className="ml-auto w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {periods.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {scoped.length === 0 ? (
        <Empty className="rounded-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Grid3X3 /></EmptyMedia>
            <EmptyTitle>No scores in {activePeriod}</EmptyTitle>
            <EmptyDescription>Score reviews in the cycle detail page to populate the grid.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle className="text-base">Performance × Potential — {activePeriod}</CardTitle>
            <CardDescription>
              {scoped.length} employees plotted
              {unrated > 0 ? ` · ${unrated} without a potential rating (placed in the middle row)` : ''}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              {/* Y axis label */}
              <div className="flex w-6 items-center justify-center">
                <span className="-rotate-90 whitespace-nowrap text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Potential →
                </span>
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <TooltipProvider delayDuration={150}>
                  <div className="grid grid-cols-3 gap-2">
                    {BOX_LABELS.map((row, rowIdx) =>
                      row.map((label, colIdx) => {
                        const cell = placed.filter((p) => p.pot === (2 - rowIdx) && p.perf === colIdx);
                        return (
                          <div
                            key={`${rowIdx}-${colIdx}`}
                            className={cn('flex min-h-28 flex-col rounded-xl border p-2.5', BOX_TONES[rowIdx][colIdx])}
                          >
                            <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500">
                              {label}
                            </span>
                            <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
                              {cell.map(({ review, hasPotential }) => {
                                const emp = empOf(review.employeeId);
                                return (
                                  <Tooltip key={review.id}>
                                    <TooltipTrigger asChild>
                                      <span
                                        className={cn(
                                          'flex h-8 w-8 cursor-default items-center justify-center rounded-full text-[11px] font-semibold ring-2 ring-card',
                                          avatarTone(emp?.name ?? '?'),
                                          !hasPotential && 'opacity-60 ring-dashed',
                                        )}
                                      >
                                        {initialsOf(emp?.name ?? '?')}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p className="font-medium">{emp?.name ?? review.employeeId}</p>
                                      <p className="text-xs text-muted-foreground">
                                        {deptName(emp?.departmentId)} · {score100to5(review.overallScore).toFixed(1)}/5 performance
                                        {hasPotential ? ` · ${review.potential}/5 potential` : ' · potential not rated'}
                                      </p>
                                    </TooltipContent>
                                  </Tooltip>
                                );
                              })}
                            </div>
                          </div>
                        );
                      }),
                    )}
                  </div>
                </TooltipProvider>
                {/* X axis labels */}
                <div className="grid grid-cols-3 gap-2 text-center text-xs text-muted-foreground">
                  {AXIS_LOW_MID_HIGH.map((l) => <span key={l}>{l} performance</span>)}
                </div>
              </div>
            </div>
            <div className="mt-2 pl-9 text-center text-xs text-muted-foreground">
              ← Performance →
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
