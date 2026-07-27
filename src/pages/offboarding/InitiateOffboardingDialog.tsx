/**
 * Initiate offboarding dialog — pick employee + reason + notice date.
 * Live EA 1955 s.12 calculator: notice weeks → last working day → CP22A due.
 * Retrenchment shows the 1980 Regulations benefit schedule hint.
 */
import { useMemo, useState } from 'react';
import { Calculator } from 'lucide-react';
import type { Claim, Employee, LeaveBalance } from '@/lib/types';
import { useCollection } from '@/lib/db';
import {
  OFFBOARDING_REASON_LABELS,
  auditLifecycle,
  buildOffboardingCase,
  cp22aDueDateFor,
  estimateRetrenchmentBenefit,
  lastWorkingDayFor,
  noticeWeeksFor,
  useOffboardingCases,
  yearsOfService,
  type OffboardingReason,
} from '@/lib/lifecycle';
import { fmtDate, fmtRM } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[];
  existingEmployeeIds: Set<string>;
  actorName: string;
}

export default function InitiateOffboardingDialog({
  open,
  onOpenChange,
  employees,
  existingEmployeeIds,
  actorName,
}: Props) {
  const { add } = useOffboardingCases();
  const { items: leaveBalances } = useCollection<LeaveBalance>('leaveBalances');
  const { items: claims } = useCollection<Claim>('claims');

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [employeeId, setEmployeeId] = useState('');
  const [reason, setReason] = useState<OffboardingReason>('resignation');
  const [noticeDate, setNoticeDate] = useState(today);
  const [deductions, setDeductions] = useState('0');

  const candidates = useMemo(
    () =>
      employees
        .filter((e) => e.status !== 'resigned' && !existingEmployeeIds.has(e.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employees, existingEmployeeIds],
  );

  const employee = employees.find((e) => e.id === employeeId);

  const calc = useMemo(() => {
    if (!employee || !noticeDate) return null;
    const weeks = noticeWeeksFor(employee.joinDate, noticeDate);
    const lwd = lastWorkingDayFor(noticeDate, weeks);
    return {
      years: yearsOfService(employee.joinDate, noticeDate),
      weeks,
      lastWorkingDay: lwd,
      cp22aDue: cp22aDueDateFor(lwd),
    };
  }, [employee, noticeDate]);

  const retrenchment = useMemo(() => {
    if (!employee || reason !== 'retrenchment' || !calc) return null;
    return estimateRetrenchmentBenefit(employee.baseSalary, employee.joinDate, calc.lastWorkingDay);
  }, [employee, reason, calc]);

  function reset() {
    setEmployeeId('');
    setReason('resignation');
    setNoticeDate(today);
    setDeductions('0');
  }

  function submit() {
    if (!employee || !noticeDate) return;
    const payload = buildOffboardingCase({
      employee,
      reason,
      noticeDate,
      leaveBalances,
      claims,
      deductions: Number.parseFloat(deductions) || 0,
    });
    const created = add(payload);
    auditLifecycle(
      'offboarding.initiate',
      created.id,
      `${OFFBOARDING_REASON_LABELS[reason]} initiated for ${employee.name}; notice ${noticeDate}, LWD ${payload.lastWorkingDay}`,
      actorName,
    );
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Initiate offboarding</DialogTitle>
          <DialogDescription>
            Notice period, clearance and final-pay preview are computed automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="off-emp">Employee</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger id="off-emp">
                <SelectValue placeholder="Select active employee…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.length === 0 && (
                  <SelectItem value="__none" disabled>
                    No eligible employees
                  </SelectItem>
                )}
                {candidates.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name} · joined {fmtDate(e.joinDate)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="off-reason">Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as OffboardingReason)}>
                <SelectTrigger id="off-reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(OFFBOARDING_REASON_LABELS) as OffboardingReason[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {OFFBOARDING_REASON_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="off-notice">Notice date</Label>
              <Input
                id="off-notice"
                type="date"
                value={noticeDate}
                onChange={(e) => setNoticeDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="off-ded">Known deductions (RM)</Label>
            <Input
              id="off-ded"
              type="number"
              min="0"
              step="0.01"
              value={deductions}
              onChange={(e) => setDeductions(e.target.value)}
              placeholder="Advances, unreturned assets…"
            />
          </div>

          {/* ── EA s.12 calculator ── */}
          {calc && employee && (
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-500">
                <Calculator className="h-3.5 w-3.5" /> EA 1955 s.12 notice calculator
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Service at notice</dt>
                <dd className="text-right font-medium">{calc.years} yr{calc.years === 1 ? '' : 's'}</dd>
                <dt className="text-muted-foreground">Statutory notice</dt>
                <dd className="text-right font-medium">{calc.weeks} weeks</dd>
                <dt className="text-muted-foreground">Last working day</dt>
                <dd className="text-right font-medium">{fmtDate(calc.lastWorkingDay)}</dd>
                <dt className="text-muted-foreground">CP22A due to LHDN</dt>
                <dd className="text-right font-medium">{fmtDate(calc.cp22aDue)}</dd>
              </dl>
            </div>
          )}

          {/* ── Retrenchment benefit hint ── */}
          {retrenchment && (
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs text-muted-foreground dark:border-stone-800 dark:bg-stone-900/50">
              <p className="mb-1 font-medium text-foreground">
                Termination &amp; Lay-Off Benefits Regulations 1980 (Reg. 6)
              </p>
              {retrenchment.eligible ? (
                <p>
                  {retrenchment.yearsOfService} yrs service →{' '}
                  <span className="font-medium text-foreground">
                    {retrenchment.daysPerYear} days' wages per year
                  </span>{' '}
                  at {fmtRM(retrenchment.dailyRate)}/day (wages ÷ 26) → estimated benefit{' '}
                  <span className="font-medium text-foreground">
                    {fmtRM(retrenchment.estimatedBenefit)}
                  </span>
                  . Schedule: &lt;2 yrs = 10 days, 2–5 yrs = 15 days, ≥5 yrs = 20 days per year of
                  service.
                </p>
              ) : (
                <p>
                  Under 12 months' continuous service — statutory lay-off benefit not due under
                  Reg. 6 (schedule: 10 / 15 / 20 days' wages per year for &lt;2 / 2–5 / ≥5 yrs).
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!employee || !noticeDate}
            className="bg-amber-600 text-white hover:bg-amber-700"
          >
            Create case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
