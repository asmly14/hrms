/**
 * Apply-for-leave form. Validates against the EA-tracked balance, blocks
 * overlapping requests, warns when the range spans public holidays (those
 * days are returned by countLeaveDays as non-consuming), and flags unpaid
 * leave's payroll impact at ORP (statutory orpFromMonthly — never hardcoded).
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, Info, Send } from 'lucide-react';
import { logAudit, type CollectionApi } from '@/lib/db';
import { orpFromMonthly } from '@/lib/statutory';
import { daysBetween, fmtDate, fmtRM, round2 } from '@/lib/utils';
import type { Employee, LeaveBalance, LeaveType } from '@/lib/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  balanceView, completedServiceYears, countLeaveDays, eaEntitlements, effectiveBalance,
  overlappingRequest, parseISO, pendingDaysFor, toISO,
  LEAVE_TYPE_META, LEAVE_TYPES, type LeaveRequestEx,
} from '../leaveLogic';
import { useAuthScope } from '../useAuthScope';

interface Props {
  employees: Employee[];
  leavesApi: CollectionApi<LeaveRequestEx>;
  balances: LeaveBalance[];
}

const todayISO = toISO(new Date());

export default function ApplyLeaveForm({ employees, leavesApi, balances }: Props) {
  const auth = useAuthScope();
  // B2: employees are scoped by role — Admin/HR see all, Manager own dept,
  // Employee self only (an Employee therefore applies only for themselves).
  const active = useMemo(
    () => auth.scopeEmployees(employees).filter((e) => e.status !== 'resigned'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [employees, auth.scopeEmployees],
  );
  const pickerLocked = auth.scoped && auth.role === 'Employee';

  const [employeeId, setEmployeeId] = useState(active[0]?.id ?? '');
  const [type, setType] = useState<LeaveType>('annual');
  const [startDate, setStartDate] = useState(todayISO);
  const [endDate, setEndDate] = useState(todayISO);
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const emp = active.find((e) => e.id === employeeId) ?? active[0];

  const calendarDaysType = type === 'maternity' || type === 'paternity';
  const halfDayAllowed = startDate === endDate && !calendarDaysType;

  const count = useMemo(
    () => (emp ? countLeaveDays(type, startDate, endDate, emp.state, halfDay && halfDayAllowed ? 'am' : undefined) : null),
    [emp, type, startDate, endDate, halfDay, halfDayAllowed],
  );

  const year = Number(startDate.slice(0, 4));
  const balance = emp ? effectiveBalance(emp, balances, year) : undefined;
  const pendingDays = emp ? pendingDaysFor(leavesApi.items, emp.id, type, year) : 0;
  const view = balance ? balanceView(balance, type, pendingDays) : undefined;
  const overlap = emp ? overlappingRequest(leavesApi.items, emp.id, startDate, endDate) : undefined;
  // Company top-up days for the selected type (0 for non-topped-up types).
  const topUpDays = useMemo(() => {
    if (!emp) return 0;
    if (type === 'annual' || type === 'sick' || type === 'hospitalization'
      || type === 'maternity' || type === 'paternity') {
      return eaEntitlements(emp).topUps[type];
    }
    return 0;
  }, [emp, type]);

  const errors: string[] = [];
  if (!startDate || !endDate) errors.push('Choose both start and end dates.');
  else if (endDate < startDate) errors.push('End date must be on or after the start date.');
  if (overlap) {
    errors.push(
      `Overlaps an existing ${overlap.status} request (${fmtDate(overlap.startDate)} – ${fmtDate(overlap.endDate)}).`,
    );
  }
  if (count && count.days <= 0 && !errors.length) {
    errors.push('The selected range contains no chargeable leave days (all rest days / public holidays).');
  }
  if (view?.tracked && count && count.days > view.available) {
    errors.push(
      `Insufficient ${LEAVE_TYPE_META[type].label.toLowerCase()} balance — ${view.available} day(s) available ` +
      `(after ${view.pending} pending), ${count.days} requested.`,
    );
  }
  if (type === 'maternity' && emp?.gender === 'male') errors.push('Maternity leave applies to female employees.');
  if (type === 'paternity' && emp?.gender === 'female') errors.push('Paternity leave applies to male employees.');

  // B7 — EA s.60FA paternity eligibility: married + ≥ 12 months service.
  // Surfaced as a blocking message alongside the gender check.
  if (type === 'paternity' && emp) {
    if (emp.maritalStatus !== 'married') {
      errors.push('Paternity leave (EA s.60FA) requires the employee to be married.');
    }
    const serviceYrs = completedServiceYears(emp.joinDate);
    if (serviceYrs < 1) {
      errors.push(
        `Paternity leave (EA s.60FA) requires at least 12 months of continuous service — currently ${serviceYrs < 1 ? 'under 1 year' : `${serviceYrs} yrs`}.`,
      );
    }
  }

  // B1 — payrollEngine deducts unpaid leave at ORP per CALENDAR day
  // (weekends/PHs inside the range included), so the estimate must count
  // calendar days too — not the chargeable working days above.
  const unpaidCalendarDays = useMemo(
    () => {
      if (type !== 'unpaid' || !startDate || !endDate || endDate < startDate) return 0;
      return daysBetween(parseISO(startDate), parseISO(endDate)) + 1;
    },
    [type, startDate, endDate],
  );
  const unpaidCost = type === 'unpaid' && emp
    ? round2(orpFromMonthly(emp.baseSalary) * unpaidCalendarDays)
    : 0;

  const canSubmit = errors.length === 0 && !!emp && !!count && count.days > 0;

  const onSubmit = () => {
    if (!emp || !count || !canSubmit) return;
    const req = leavesApi.add({
      employeeId: emp.id,
      type,
      startDate,
      endDate,
      days: count.days,
      reason: reason.trim() || undefined,
      status: 'pending',
      appliedAt: new Date().toISOString(),
      ...(halfDay && halfDayAllowed ? { halfDay: 'am' as const } : {}),
    });
    logAudit({
      actorName: auth.actor,
      action: 'leave.apply',
      entity: 'leaves',
      entityId: req.id,
      detail: `${emp.name} applied ${count.days}d ${type} (${startDate} → ${endDate})`,
    });
    setSubmitted(`${LEAVE_TYPE_META[type].label} leave submitted for ${emp.name} — ${count.days} day(s), pending approval.`);
    setReason('');
    setHalfDay(false);
  };

  if (!emp) return null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* Form */}
      <Card className="rounded-xl lg:col-span-3">
        <CardHeader>
          <CardTitle className="text-base">Apply for leave</CardTitle>
          <CardDescription>
            Requests go to the approval queue. Approved days update the balance automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="apply-employee">Employee</Label>
              {pickerLocked ? (
                <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
                  {emp?.name ?? '—'}
                  <span className="block text-xs text-muted-foreground">You can apply for yourself only.</span>
                </div>
              ) : (
                <Select value={emp?.id ?? ''} onValueChange={setEmployeeId}>
                  <SelectTrigger id="apply-employee"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {active.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="apply-type">Leave type</Label>
              <Select value={type} onValueChange={(v) => setType(v as LeaveType)}>
                <SelectTrigger id="apply-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LEAVE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{LEAVE_TYPE_META[t].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="apply-start">Start date</Label>
              <Input
                id="apply-start"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (endDate < e.target.value) setEndDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apply-end">End date</Label>
              <Input
                id="apply-end"
                type="date"
                min={startDate}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl border px-4 py-3">
            <div className="space-y-0.5">
              <Label htmlFor="half-day" className="text-sm font-medium">Half day</Label>
              <p className="text-xs text-muted-foreground">
                {halfDayAllowed ? 'Counts as 0.5 day (morning).' : 'Only for single-day, working-day leave types.'}
              </p>
            </div>
            <Switch
              id="half-day"
              checked={halfDay && halfDayAllowed}
              disabled={!halfDayAllowed}
              onCheckedChange={setHalfDay}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="apply-reason">Reason</Label>
            <Textarea
              id="apply-reason"
              placeholder="e.g. Family matter in Johor, MC attached…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>

          {errors.map((err) => (
            <Alert key={err} variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          ))}

          {type === 'unpaid' && count && count.days > 0 && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>Payroll impact (calendar-day deduction)</AlertTitle>
              <AlertDescription>
                Unpaid leave is deducted in payroll at the ordinary rate of pay (monthly salary ÷ 26)
                <strong> per calendar day</strong> — rest days and public holidays inside the range are
                deducted too, matching the payroll engine. Estimated deduction:{' '}
                <strong>{fmtRM(unpaidCost)}</strong> for {unpaidCalendarDays} calendar day(s)
                ({count.days} working day(s) of absence).
              </AlertDescription>
            </Alert>
          )}

          {submitted && (
            <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100">
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>{submitted}</AlertDescription>
            </Alert>
          )}

          <Button onClick={onSubmit} disabled={!canSubmit} className="w-full gap-1.5 sm:w-auto">
            <Send className="h-4 w-4" /> Submit request
          </Button>
        </CardContent>
      </Card>

      {/* Live summary */}
      <Card className="rounded-xl lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-amber-600" /> Request summary
          </CardTitle>
          <CardDescription>{LEAVE_TYPE_META[type].hint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-muted/60 p-3">
              <div className="text-2xl font-semibold">{count ? count.days : '—'}</div>
              <div className="text-xs text-muted-foreground">
                chargeable day(s){calendarDaysType ? ' (calendar)' : ' (working)'}
              </div>
            </div>
            <div className="rounded-xl bg-muted/60 p-3">
              <div className="text-2xl font-semibold">
                {view?.tracked ? view.available : '—'}
              </div>
              <div className="text-xs text-muted-foreground">
                {view?.tracked ? `available (${year})` : 'not balance-tracked'}
              </div>
            </div>
          </div>

          {view?.tracked && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>Entitled {view.entitled} (incl. carry-forward) · used {view.used} · pending {view.pending}</p>
            </div>
          )}

          {topUpDays > 0 && (
            <p className="text-xs text-muted-foreground">
              Entitlement includes +{topUpDays} company top-up day(s) on top of the EA statutory
              minimum (Settings → Leave policy).
            </p>
          )}

          {count && count.holidays.length > 0 && (
            <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Includes public holiday(s)</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {count.holidays.map((h) => (
                    <li key={`${h.date}-${h.name}`}>{h.name} — {fmtDate(h.date)}</li>
                  ))}
                </ul>
                <p className="mt-1">These days do not consume leave balance.</p>
              </AlertDescription>
            </Alert>
          )}

          {count && count.weekendDays > 0 && (
            <p className="text-xs text-muted-foreground">
              {count.weekendDays} rest day(s) in range — excluded ({emp.state} weekend rule).
            </p>
          )}

          {type === 'sick' && (
            <p className="text-xs text-muted-foreground">
              EA 1955 s.60F(2)(aa): inform the employer within 48 hours; MC from a registered
              practitioner is required for paid sick leave.
            </p>
          )}
          {type === 'maternity' && (
            <p className="text-xs text-muted-foreground">
              98 consecutive days (EA s.37). Allowance requires ≥ 90 days worked in the 9 months
              before confinement; notify the employer ≥ 60 days ahead (s.40).
            </p>
          )}
          {type === 'paternity' && (
            <p className="text-xs text-muted-foreground">
              7 consecutive days per confinement (EA s.60FA) — married male employees with at
              least 12 months of continuous service, up to 5 confinements.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
