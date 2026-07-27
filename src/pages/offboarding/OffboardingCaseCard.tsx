/**
 * One offboarding case card — clearance checklist, final-pay preview panel,
 * CP22A reminder, retrenchment schedule hint, and the "mark resigned" action
 * that flips the employee record to resigned + writes an audit entry.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, ChevronDown, FileWarning, UserMinus } from 'lucide-react';
import type { Employee } from '@/lib/types';
import { useCollection } from '@/lib/db';
import {
  CLEARANCE_CATEGORIES,
  OFFBOARDING_REASON_LABELS,
  OFFBOARDING_STATUS_LABELS,
  auditLifecycle,
  deriveOffboardingStatus,
  estimateRetrenchmentBenefit,
  useOffboardingCases,
  type ClearanceItem,
  type OffboardingCase,
} from '@/lib/lifecycle';
import { avatarTone, cn, fmtDate, fmtRM, initialsOf } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';

const REASON_STYLES: Record<OffboardingCase['reason'], string> = {
  resignation: 'border-stone-300 text-stone-600',
  retirement: 'border-lime-600 bg-lime-50 text-lime-700 dark:bg-lime-950/40',
  retrenchment: 'border-red-400 bg-red-50 text-red-700 dark:bg-red-950/40',
  termination: 'border-orange-500 bg-orange-50 text-orange-700 dark:bg-orange-950/40',
};

const STATUS_STYLES: Record<OffboardingCase['status'], string> = {
  'notice-given': 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/40',
  'clearance-in-progress': 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/40',
  cleared: 'border-lime-600 bg-lime-50 text-lime-700 dark:bg-lime-950/40',
  exited: 'border-stone-300 text-stone-500',
};

function daysUntil(iso: string): number {
  const today = new Date().toISOString().slice(0, 10);
  return Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000);
}

interface Props {
  kase: OffboardingCase;
  employee?: Employee;
  actorName: string;
}

export default function OffboardingCaseCard({ kase, employee, actorName }: Props) {
  const { update } = useOffboardingCases();
  const { update: updateEmployee } = useCollection<Employee>('employees');
  const [expanded, setExpanded] = useState(false);

  const done = kase.clearanceItems.filter((i) => i.done).length;
  const total = kase.clearanceItems.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const lwdIn = daysUntil(kase.lastWorkingDay);
  const cp22aIn = daysUntil(kase.cp22aDueDate);

  const grouped = useMemo(() => {
    const map = new Map<string, ClearanceItem[]>();
    CLEARANCE_CATEGORIES.forEach((c) => map.set(c, []));
    kase.clearanceItems.forEach((i) => map.get(i.category)?.push(i));
    return [...map.entries()].filter(([, items]) => items.length > 0);
  }, [kase.clearanceItems]);

  const retrenchment = useMemo(() => {
    if (kase.reason !== 'retrenchment' || !employee) return null;
    return estimateRetrenchmentBenefit(employee.baseSalary, employee.joinDate, kase.lastWorkingDay);
  }, [kase.reason, kase.lastWorkingDay, employee]);

  function toggle(itemId: string, checked: boolean) {
    const items = kase.clearanceItems.map((i) =>
      i.id === itemId
        ? {
            ...i,
            done: checked,
            doneBy: checked ? actorName : undefined,
            doneAt: checked ? new Date().toISOString() : undefined,
          }
        : i,
    );
    const status = deriveOffboardingStatus(items, kase.status);
    update(kase.id, { clearanceItems: items, status });
    const item = kase.clearanceItems.find((i) => i.id === itemId);
    auditLifecycle(
      checked ? 'offboarding.clearance-done' : 'offboarding.clearance-reopen',
      kase.id,
      `${checked ? 'Cleared' : 'Reopened'}: ${item?.label ?? itemId} (${employee?.name ?? kase.employeeId})`,
      actorName,
    );
  }

  function markResigned() {
    if (!employee) return;
    updateEmployee(employee.id, { status: 'resigned', resignDate: kase.lastWorkingDay });
    update(kase.id, { status: 'exited' });
    auditLifecycle(
      'employee.resigned',
      employee.id,
      `${employee.name} marked resigned (LWD ${kase.lastWorkingDay}, ${OFFBOARDING_REASON_LABELS[kase.reason].toLowerCase()}) via offboarding case`,
      actorName,
    );
  }

  const fp = kase.finalPay;

  return (
    <Card className="rounded-xl">
      <CardContent className="p-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-start gap-3 text-left"
        >
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
              avatarTone(employee?.name ?? '?'),
            )}
          >
            {initialsOf(employee?.name ?? '?')}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium">{employee?.name ?? 'Unknown employee'}</span>
              <Badge variant="outline" className={cn('text-xs', REASON_STYLES[kase.reason])}>
                {OFFBOARDING_REASON_LABELS[kase.reason]}
              </Badge>
              <Badge variant="outline" className={cn('text-xs', STATUS_STYLES[kase.status])}>
                {OFFBOARDING_STATUS_LABELS[kase.status]}
              </Badge>
            </div>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <CalendarClock className="h-3 w-3" />
              Notice {fmtDate(kase.noticeDate)} · LWD {fmtDate(kase.lastWorkingDay)}
              {kase.status !== 'exited' && (
                <span className={cn('font-medium', lwdIn < 0 ? 'text-red-600' : 'text-amber-700 dark:text-amber-500')}>
                  {' '}
                  ({lwdIn < 0 ? `${-lwdIn}d overdue` : lwdIn === 0 ? 'today' : `${lwdIn}d left`})
                </span>
              )}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Progress value={pct} className="h-2 flex-1" />
              <span className="text-xs font-medium text-muted-foreground">
                {done}/{total}
              </span>
            </div>
          </div>
          <ChevronDown
            className={cn(
              'mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </button>

        {expanded && (
          <div className="mt-4 space-y-5 border-t pt-4">
            {/* ── CP22A reminder ── */}
            <Alert
              className={cn(
                'rounded-xl',
                kase.status === 'exited'
                  ? 'border-stone-200'
                  : cp22aIn < 0
                    ? 'border-red-300 bg-red-50/60 dark:border-red-900/50 dark:bg-red-950/20'
                    : 'border-amber-300 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20',
              )}
            >
              <FileWarning className="h-4 w-4" />
              <AlertTitle className="text-sm">CP22A — LHDN cessation notice</AlertTitle>
              <AlertDescription className="text-xs">
                Employer must notify LHDN at least 30 days before cessation. Due{' '}
                <span className="font-medium text-foreground">{fmtDate(kase.cp22aDueDate)}</span>
                {kase.status !== 'exited' &&
                  (cp22aIn < 0 ? (
                    <span className="font-medium text-red-600"> — overdue by {-cp22aIn} day{-cp22aIn === 1 ? '' : 's'}, file immediately</span>
                  ) : (
                    <span> — {cp22aIn} day{cp22aIn === 1 ? '' : 's'} remaining</span>
                  ))}
                . Withhold final wages until IRB clearance where required.
              </AlertDescription>
            </Alert>

            {/* ── Retrenchment schedule hint ── */}
            {retrenchment && (
              <Alert className="rounded-xl border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900/50">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle className="text-sm">Lay-off benefit schedule (Reg. 6, 1980)</AlertTitle>
                <AlertDescription className="text-xs">
                  {retrenchment.eligible ? (
                    <>
                      {retrenchment.yearsOfService} yrs service → {retrenchment.daysPerYear} days'
                      wages/yr at {fmtRM(retrenchment.dailyRate)}/day → estimated{' '}
                      <span className="font-medium text-foreground">
                        {fmtRM(retrenchment.estimatedBenefit)}
                      </span>
                      , payable in addition to final pay.
                    </>
                  ) : (
                    <>Under 12 months' service — statutory benefit not due.</>
                  )}{' '}
                  Tiers: &lt;2 yrs 10 days · 2–5 yrs 15 days · ≥5 yrs 20 days per year of service.
              </AlertDescription>
            </Alert>
            )}

            {/* ── Clearance checklist ── */}
            <div className="space-y-4">
              {grouped.map(([category, items]) => (
                <div key={category}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-500">
                    {category}
                  </p>
                  <ul className="space-y-2">
                    {items.map((item) => (
                      <li key={item.id} className="flex items-start gap-2.5">
                        <Checkbox
                          id={`clr-${item.id}`}
                          checked={item.done}
                          onCheckedChange={(v) => toggle(item.id, v === true)}
                          className="mt-0.5"
                          disabled={kase.status === 'exited'}
                        />
                        <label
                          htmlFor={`clr-${item.id}`}
                          className={cn(
                            'flex-1 cursor-pointer text-sm leading-snug',
                            item.done && 'text-muted-foreground line-through',
                          )}
                        >
                          {item.label}
                          {item.done && item.doneAt && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {item.doneBy} · {fmtDate(item.doneAt)}
                            </span>
                          )}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {/* ── Final pay preview ── */}
            <div className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-500">
                Final pay preview
              </p>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    Prorated salary ({fp.daysWorkedInFinalMonth}/{fp.daysInFinalMonth} days)
                  </dt>
                  <dd className="font-medium">{fmtRM(fp.proratedSalary)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    Leave encashment ({fp.unusedLeaveDays} days × ORP)
                  </dt>
                  <dd className="font-medium">{fmtRM(fp.leaveEncashment)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Pending approved claims</dt>
                  <dd className="font-medium">{fmtRM(fp.pendingClaims)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Deductions</dt>
                  <dd className="font-medium text-red-600">−{fmtRM(fp.deductions)}</dd>
                </div>
                <Separator className="my-2" />
                <div className="flex justify-between gap-4">
                  <dt className="font-semibold">Estimated total</dt>
                  <dd className="font-semibold text-amber-700 dark:text-amber-500">
                    {fmtRM(fp.estimatedTotal)}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                Preview only — EPF / SOCSO / EIS / PCB on the final month are computed by the
                payroll run (EA 1955 s.20: all earned wages payable by the last day of contract).
                ORP = monthly salary ÷ 26.
              </p>
            </div>

            {/* ── Mark resigned ── */}
            {kase.status !== 'exited' && employee && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  {kase.status === 'cleared'
                    ? 'All clearance items done — ready to exit.'
                    : 'Clearance incomplete — you can still force the exit.'}
                </p>
                <Button
                  variant={kase.status === 'cleared' ? 'default' : 'outline'}
                  onClick={markResigned}
                  className={cn(
                    kase.status === 'cleared' && 'bg-amber-600 text-white hover:bg-amber-700',
                  )}
                >
                  <UserMinus className="mr-1.5 h-4 w-4" /> Mark employee resigned
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
