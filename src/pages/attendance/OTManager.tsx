/**
 * OT management — request form with live statutory pay preview + approval queue.
 * OT requests are attendance records with otRequested/otApproved; payrollEngine
 * pays ONLY records where otApproved === true.
 * Scoped by role: requests are always submitted as the signed-in employee
 * (no impersonation); the approval queue is scoped Admin/HR → all,
 * Manager → own department, Employee → own requests (read-only).
 * The 104h/month OT cap (Employment (Limitation of Overtime Work)
 * Regulations 1980) is enforced HARD at both request and approval time.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Hourglass, Timer, X } from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import type { Employee } from '@/lib/types';
import { fmtDate, fmtRM, monthKey, round2 } from '@/lib/utils';
import {
  calcOT, hourlyFromMonthly, orpFromMonthly, MAX_OT_HOURS_MONTH, OT_SALARY_THRESHOLD,
} from '@/lib/statutory';
import {
  otDayTypeFor, shiftForEmployee, todayISO, useRotations, type AttendanceX, type ShiftX,
} from './model';
import { actorName, useAuthSafe } from './useAuthSafe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const DAYTYPE_LABEL = { normal: 'Normal workday (1.5×)', rest: 'Rest day (2.0×)', holiday: 'Public holiday (3.0×)' } as const;

/** EA 1955 s.60A — total work day ceiling is 12h (≈4h OT on an 8h day); hard input ceiling 12h. */
const MAX_OT_HOURS_DAY = 12;

export default function OTManager() {
  const auth = useAuthSafe();
  const selfId = auth?.employeeId ?? null;
  const canApprove = !auth || auth.role === 'Admin' || auth.role === 'HR' || auth.role === 'Manager';
  const { items: employees } = useCollection<Employee>('employees');
  const { items: shifts } = useCollection<ShiftX>('shifts');
  const { items: attendance, add, update } = useCollection<AttendanceX>('attendance');
  const rotations = useRotations();

  // S5 fix: pre-auth demo keeps the picker; once signed in, requests are self-only.
  const requestLocked = !!auth;
  const active = useMemo(
    () => employees.filter((e) => e.status !== 'resigned').sort((a, b) => a.name.localeCompare(b.name)),
    [employees],
  );
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [hours, setHours] = useState('2');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');

  const emp = requestLocked
    ? employees.find((e) => e.id === selfId)
    : active.find((e) => e.id === employeeId) ?? active[0];
  const month = date.slice(0, 7);
  const today = todayISO();

  const shift = emp ? shiftForEmployee(emp, shifts, rotations, date) : undefined;
  const dayType = emp ? otDayTypeFor(emp, shift, date) : 'normal';
  // B4 fix: clamp to [0, 12] — the max={12} attribute alone does not stop typed values.
  const rawHrs = Number(hours) || 0;
  const hrs = Math.min(MAX_OT_HOURS_DAY, Math.max(0, rawHrs));
  const futureDate = date > today;

  // Live statutory preview — never hardcoded multipliers.
  const orp = emp ? orpFromMonthly(emp.baseSalary) : 0;
  const hrp = emp ? hourlyFromMonthly(emp.baseSalary) : 0;
  const preview = emp ? calcOT(hrp, hrs, dayType) : 0;
  const overThreshold = emp ? emp.baseSalary > OT_SALARY_THRESHOLD : false;

  // Month OT totals (approved + pending) for the 104h cap enforcement.
  const monthOT = useMemo(() => {
    if (!emp) return { approved: 0, pending: 0 };
    let approved = 0;
    let pending = 0;
    attendance.forEach((a) => {
      if (a.employeeId !== emp.id || !a.date.startsWith(month)) return;
      if (a.otApproved) approved += a.otHours || 0;
      else if (a.otRequested && !a.otRejected) pending += a.otHours || 0;
    });
    return { approved: round2(approved), pending: round2(pending) };
  }, [attendance, emp, month]);

  const wouldExceedCap = monthOT.approved + monthOT.pending + hrs > MAX_OT_HOURS_MONTH;

  /** Approved OT hours for any employee in a given month (approval-time cap check). */
  const approvedHoursFor = (empId: string, monthKeyOfRec: string): number =>
    round2(
      attendance.reduce(
        (s, a) => s + (a.employeeId === empId && a.date.startsWith(monthKeyOfRec) && a.otApproved ? a.otHours || 0 : 0),
        0,
      ),
    );

  /** Would approving this record breach the 104h monthly cap for that employee? */
  const approveWouldExceedCap = (rec: AttendanceX): boolean =>
    approvedHoursFor(rec.employeeId, rec.date.slice(0, 7)) + (rec.otHours || 0) > MAX_OT_HOURS_MONTH;

  // S3/S4 fix: queue + history are scoped (Admin/HR → all, Manager → own dept, Employee → self).
  const visibleAttendance = useMemo(
    () => (auth ? auth.scopeByEmployee(attendance, (a) => a.employeeId) : attendance),
    [attendance, auth],
  );
  const pendingQueue = useMemo(
    () =>
      visibleAttendance
        .filter((a) => a.otRequested && !a.otApproved && !a.otRejected && a.otHours > 0)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [visibleAttendance],
  );
  const decidedThisMonth = useMemo(
    () =>
      visibleAttendance
        .filter((a) => a.otRequested && (a.otApproved || a.otRejected) && a.date.startsWith(monthKey()))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 10),
    [visibleAttendance],
  );

  const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? id;

  const submit = () => {
    if (!emp || hrs <= 0) return;
    // B19 fix: no OT requests for future dates.
    if (futureDate) {
      setNotice('OT cannot be requested for a future date. Submit after the work is done.');
      return;
    }
    // B3 fix: hard block — the 104h/month cap is not advisory.
    if (wouldExceedCap) {
      setNotice(
        `Blocked: this request would exceed the ${MAX_OT_HOURS_MONTH}h monthly OT cap for ${month}. ` +
          'Split the work across months or ask HR for a Labour Department exemption.',
      );
      return;
    }
    const note = `OT request: ${reason.trim() || '—'} (${DAYTYPE_LABEL[dayType]})`;
    // B2 fix: exactly ONE attendance record per employee+date.
    // 1. Accumulate into an existing PENDING request for that day.
    const pendingSameDay = attendance.find(
      (a) => a.employeeId === emp.id && a.date === date && a.otRequested && !a.otApproved && !a.otRejected,
    );
    // 2. An already-approved OT day must not regress — block and refer to HR.
    const approvedSameDay = attendance.find(
      (a) => a.employeeId === emp.id && a.date === date && a.otRequested && a.otApproved,
    );
    // 3. A rejected request can be re-opened with the new hours (same record, no duplicate).
    const rejectedSameDay = attendance.find(
      (a) => a.employeeId === emp.id && a.date === date && a.otRequested && a.otRejected && !a.otApproved,
    );
    // 4. Any other same-day record (e.g. a clock record) absorbs the OT fields via update().
    const clockSameDay = attendance.find((a) => a.employeeId === emp.id && a.date === date);

    if (approvedSameDay) {
      setNotice(`OT for ${fmtDate(date)} is already approved — contact HR if the hours need to change.`);
      return;
    }
    if (pendingSameDay) {
      update(pendingSameDay.id, {
        otHours: round2((pendingSameDay.otHours || 0) + hrs),
        otDayType: dayType,
        otRequestReason: reason.trim() || pendingSameDay.otRequestReason,
        notes: pendingSameDay.notes ? `${pendingSameDay.notes}; ${note}` : note,
      });
      logAudit({
        actorName: actorName(auth), action: 'attendance.ot-request', entity: 'attendance',
        entityId: pendingSameDay.id,
        detail: `${emp.name} topped up pending OT by ${hrs}h on ${date}`,
      });
    } else if (rejectedSameDay) {
      update(rejectedSameDay.id, {
        otHours: hrs,
        otDayType: dayType,
        otApproved: false,
        otRejected: false,
        otRequested: true,
        otRequestReason: reason.trim(),
        notes: `${rejectedSameDay.notes ?? ''}; re-requested: ${note}`.trim(),
      });
      logAudit({
        actorName: actorName(auth), action: 'attendance.ot-request', entity: 'attendance',
        entityId: rejectedSameDay.id,
        detail: `${emp.name} re-requested ${hrs}h OT on ${date} after rejection`,
      });
    } else if (clockSameDay) {
      update(clockSameDay.id, {
        otHours: hrs,
        otDayType: dayType,
        otApproved: false,
        otRequested: true,
        otRejected: false,
        otRequestReason: reason.trim(),
        notes: clockSameDay.notes ? `${clockSameDay.notes}; ${note}` : note,
      });
      logAudit({
        actorName: actorName(auth), action: 'attendance.ot-request', entity: 'attendance',
        entityId: clockSameDay.id,
        detail: `${emp.name} requested ${hrs}h OT on ${date} (merged into clock record)`,
      });
    } else {
      const created = add({
        employeeId: emp.id,
        date,
        shiftId: shift?.id,
        status: dayType === 'normal' ? 'present' : dayType === 'rest' ? 'rest-day' : 'holiday',
        otHours: hrs,
        otDayType: dayType,
        otApproved: false,
        otRequested: true,
        otRejected: false,
        otRequestReason: reason.trim(),
        notes: note,
      } as Omit<AttendanceX, 'id'>);
      logAudit({
        actorName: actorName(auth), action: 'attendance.ot-request', entity: 'attendance',
        entityId: created.id,
        detail: `${emp.name} requested ${hrs}h OT on ${date}`,
      });
    }
    setNotice(`OT request submitted for ${emp.name} — ${hrs}h on ${fmtDate(date)}. A manager must approve it before it is paid.`);
    setReason('');
    setHours('2');
  };

  const decide = (rec: AttendanceX, approve: boolean) => {
    if (!canApprove) return;
    // Self-approval is never allowed — a second pair of eyes must decide.
    if (selfId && rec.employeeId === selfId) {
      setNotice('You cannot approve or reject your own OT request — another manager or HR must decide.');
      return;
    }
    // B3 fix: re-check the 104h monthly cap at approval time, per employee.
    if (approve && approveWouldExceedCap(rec)) {
      setNotice(
        `Blocked: approving ${rec.otHours}h would push ${empName(rec.employeeId)} past the ` +
          `${MAX_OT_HOURS_MONTH}h monthly OT cap for ${rec.date.slice(0, 7)}.`,
      );
      return;
    }
    update(rec.id, approve
      ? { otApproved: true, otRejected: false, notes: `${rec.notes ?? ''} · approved`.trim() }
      : { otApproved: false, otRejected: true, notes: `${rec.notes ?? ''} · rejected`.trim() });
    logAudit({
      actorName: actorName(auth),
      action: approve ? 'attendance.ot-approve' : 'attendance.ot-reject',
      entity: 'attendance',
      entityId: rec.id,
      detail: `${empName(rec.employeeId)} ${rec.otHours}h OT on ${rec.date} ${approve ? 'approved' : 'rejected'}`,
    });
  };

  if (employees.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-10 text-sm text-muted-foreground">Loading OT data…</CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Request form */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Timer className="h-4 w-4 text-amber-600" /> Request overtime
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Employee</Label>
              {requestLocked ? (
                <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm">
                  {emp?.name ?? '—'}
                </div>
              ) : (
                <Select value={emp?.id ?? ''} onValueChange={setEmployeeId}>
                  <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                  <SelectContent>
                    {active.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {requestLocked && (
                <p className="text-xs text-muted-foreground">
                  {emp
                    ? 'OT requests are submitted as yourself — no impersonation.'
                    : 'Your account is not linked to an employee record — contact HR.'}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ot-date">Date</Label>
              <Input
                id="ot-date" type="date" value={date} max={today}
                onChange={(e) => setDate(e.target.value)}
              />
              {futureDate && (
                <p className="text-xs text-amber-700">Future dates are not allowed for OT requests.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ot-hours">OT hours</Label>
              <Input id="ot-hours" type="number" min={0.5} max={MAX_OT_HOURS_DAY} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} />
              {rawHrs > MAX_OT_HOURS_DAY && (
                <p className="text-xs text-amber-700">
                  Clamped to {MAX_OT_HOURS_DAY}h — the EA 1955 s.60A daily work ceiling.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Day type (auto-detected)</Label>
              <div className="flex h-9 items-center">
                <Badge variant="secondary">{DAYTYPE_LABEL[dayType]}</Badge>
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ot-reason">Reason</Label>
            <Textarea
              id="ot-reason"
              rows={2}
              placeholder="e.g. Month-end closing, server migration window"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="space-y-1.5 rounded-xl bg-muted/60 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ordinary rate of pay (monthly ÷ 26)</span>
              <span className="font-medium">{fmtRM(orp)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Hourly rate of pay (ORP ÷ 8)</span>
              <span className="font-medium">{fmtRM(hrp)}</span>
            </div>
            <div className="flex justify-between border-t pt-1.5">
              <span className="font-medium">Estimated OT pay</span>
              <span className="font-semibold text-amber-700">{fmtRM(preview)}</span>
            </div>
          </div>

          {overThreshold && (
            <p className="text-xs text-muted-foreground">
              Basic salary exceeds {fmtRM(OT_SALARY_THRESHOLD)} — statutory OT rates under the EA First Schedule
              may not apply; payment above is per company policy.
            </p>
          )}

          <div className="text-xs text-muted-foreground">
            {month} OT so far: <strong>{monthOT.approved.toFixed(1)}h approved</strong>
            {monthOT.pending > 0 && <> + {monthOT.pending.toFixed(1)}h pending</>} of the {MAX_OT_HOURS_MONTH}h monthly cap.
          </div>

          {wouldExceedCap && (
            <Alert className="border-rose-300 bg-rose-50 text-rose-900">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Monthly OT cap reached</AlertTitle>
              <AlertDescription>
                This request would push {emp?.name.split(' ')[0]} past {MAX_OT_HOURS_MONTH}h of OT in {month}
                {' '}(Employment (Limitation of Overtime Work) Regulations 1980). Submission is blocked —
                split the work across months or ask HR for a Labour Department exemption.
              </AlertDescription>
            </Alert>
          )}
          {notice && <p className="text-sm text-emerald-700">{notice}</p>}

          <Button
            className="w-full rounded-xl"
            onClick={submit}
            disabled={!emp || hrs <= 0 || wouldExceedCap || futureDate}
          >
            Submit OT request
          </Button>
        </CardContent>
      </Card>

      {/* Approval queue */}
      <div className="space-y-4">
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Hourglass className="h-4 w-4 text-amber-600" /> Approval queue
              <Badge variant="secondary" className="ml-auto">{pendingQueue.length} pending</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingQueue.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No OT requests waiting for approval. Approved OT is the only OT that flows into payroll.
              </p>
            )}
            {pendingQueue.map((r) => {
              const e = employees.find((x) => x.id === r.employeeId);
              const pay = e ? calcOT(hourlyFromMonthly(e.baseSalary), r.otHours, r.otDayType) : 0;
              const isSelf = !!selfId && r.employeeId === selfId;
              const capBlocked = approveWouldExceedCap(r);
              return (
                <div key={r.id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">{empName(r.employeeId)}</div>
                      <div className="text-xs text-muted-foreground">
                        {fmtDate(r.date)} · {r.otHours}h · {DAYTYPE_LABEL[r.otDayType]}
                      </div>
                      {r.otRequestReason && (
                        <div className="mt-1 text-xs text-muted-foreground">“{r.otRequestReason}”</div>
                      )}
                    </div>
                    <div className="text-right text-sm font-semibold text-amber-700">{fmtRM(pay)}</div>
                  </div>
                  {canApprove ? (
                    isSelf ? (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        Your own request — another manager or HR must decide (no self-approval).
                      </p>
                    ) : (
                      <>
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm" className="gap-1 rounded-lg"
                            onClick={() => decide(r, true)}
                            disabled={capBlocked}
                            title={capBlocked ? `Approving would exceed the ${MAX_OT_HOURS_MONTH}h monthly cap` : undefined}
                          >
                            <Check className="h-3.5 w-3.5" /> Approve
                          </Button>
                          <Button size="sm" variant="outline" className="gap-1 rounded-lg" onClick={() => decide(r, false)}>
                            <X className="h-3.5 w-3.5" /> Reject
                          </Button>
                        </div>
                        {capBlocked && (
                          <p className="mt-2 flex items-start gap-1 text-[11px] text-rose-700">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            Approving {r.otHours}h would exceed the {MAX_OT_HOURS_MONTH}h monthly OT cap — reject or wait for next month.
                          </p>
                        )}
                      </>
                    )
                  ) : (
                    <p className="mt-2 text-[11px] text-muted-foreground">Waiting for a Manager/HR/Admin decision.</p>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        {decidedThisMonth.length > 0 && (
          <Card className="rounded-xl">
            <CardHeader>
              <CardTitle className="text-base">Decided this month</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {decidedThisMonth.map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                  <span>{empName(r.employeeId)} · {fmtDate(r.date)} · {r.otHours}h</span>
                  {r.otApproved ? (
                    <Badge className="border-transparent bg-emerald-100 text-emerald-800">Approved → payroll</Badge>
                  ) : (
                    <Badge className="border-transparent bg-rose-100 text-rose-800">Rejected</Badge>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
