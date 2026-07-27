/**
 * Anomaly list — compliance sweep over attendance for a month:
 *  1. Missing clock-out (open records).
 *  2. Days exceeding 12 working hours (EA 1955 daily ceiling incl. OT).
 *  3. Work performed on a weekly rest day.
 * Scoped by role: Admin/HR → all, Manager → own department, Employee → self.
 * Backfill writes are limited to records inside the user's scope.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, MoonStar, ShieldAlert, Wrench } from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import type { Employee } from '@/lib/types';
import { fmtDate, monthKey } from '@/lib/utils';
import {
  hhmmToMin, isScheduledWorkDay, nowHHmm, shiftEndMin, shiftForEmployee, todayISO,
  useRotations, workedHours, type AttendanceX, type ShiftX,
} from './model';
import { actorName, useAuthSafe } from './useAuthSafe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Anomaly {
  key: string;
  kind: 'missing-out' | 'over-12h' | 'rest-day-work';
  empId: string;
  date: string;
  detail: string;
  record?: AttendanceX;
  fixable: boolean;
}

const KIND_META = {
  'missing-out': { label: 'Missing clock-out', icon: CalendarClock, cls: 'bg-amber-100 text-amber-800' },
  'over-12h': { label: '>12h day', icon: ShieldAlert, cls: 'bg-rose-100 text-rose-800' },
  'rest-day-work': { label: 'Rest-day work', icon: MoonStar, cls: 'bg-stone-200 text-stone-700' },
} as const;

/** Grace after shift end before a still-open today record counts as forgotten. */
const SAME_DAY_FLAG_BUFFER_MIN = 60;

export default function AnomalyList() {
  const auth = useAuthSafe();
  const { items: employees } = useCollection<Employee>('employees');
  const { items: shifts } = useCollection<ShiftX>('shifts');
  const { items: attendance, update } = useCollection<AttendanceX>('attendance');
  const rotations = useRotations();
  const [month, setMonth] = useState(monthKey());
  const [fixedMsg, setFixedMsg] = useState('');

  const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? id;

  const anomalies = useMemo<Anomaly[]>(() => {
    const today = todayISO();
    const nowMin = hhmmToMin(nowHHmm());
    const out: Anomaly[] = [];
    const empById = new Map(employees.map((e) => [e.id, e]));
    // S7 fix: scan only attendance inside the current user's visible scope.
    const scoped = auth ? auth.scopeByEmployee(attendance, (a) => a.employeeId) : attendance;
    // Group the month's records by employee+date.
    const byDay = new Map<string, AttendanceX[]>();
    scoped.forEach((a) => {
      if (!a.date.startsWith(month)) return;
      const k = `${a.employeeId}|${a.date}`;
      byDay.set(k, [...(byDay.get(k) ?? []), a]);
    });
    for (const [k, recs] of byDay) {
      const [empId, date] = k.split('|');
      const emp = empById.get(empId);
      // B14 fix: resigned employees are excluded (consistent with boards/selectors).
      if (!emp || emp.status === 'resigned') continue;
      const shift = shiftForEmployee(emp, shifts, rotations, date);
      const withIn = recs.filter((r) => r.clockIn);

      // 1. Missing clock-out — past dates always; same-day once the shift has
      //    been over for SAME_DAY_FLAG_BUFFER_MIN (B15 fix).
      const shiftEndedToday =
        date === today && shift && nowMin > shiftEndMin(shift) + SAME_DAY_FLAG_BUFFER_MIN;
      for (const r of withIn) {
        if (!r.clockOut && (date < today || shiftEndedToday)) {
          // B13 fix: only fixable when a shift end time is resolvable (no 18:00 guesswork).
          out.push({
            key: `mo-${r.id}`, kind: 'missing-out', empId, date, record: r, fixable: !!shift,
            detail: shift
              ? `Clocked in ${r.clockIn}, never clocked out.`
              : `Clocked in ${r.clockIn}, never clocked out (no resolvable shift — set clock-out manually).`,
          });
        }
      }
      // 2. >12h total presence on one day (EA daily ceiling incl. OT).
      const totalHours = recs.reduce((s, r) => s + workedHours(r.clockIn, r.clockOut, shift?.breakMinutes ?? 0), 0);
      if (totalHours > 12) {
        out.push({
          key: `o12-${k}`, kind: 'over-12h', empId, date, fixable: false,
          detail: `${totalHours.toFixed(1)}h on the clock — exceeds the EA 1955 daily ceiling of 12h (incl. OT).`,
        });
      }
      // 3. Worked on weekly rest day (unscheduled day with a clock-in).
      if (withIn.length > 0 && shift && !isScheduledWorkDay(emp, shift, date)) {
        out.push({
          key: `rd-${k}`, kind: 'rest-day-work', empId, date, fixable: false,
          detail: `Worked on rest day (${shift.name} rest pattern). Ensure rest-day OT (2.0×) is approved.`,
        });
      }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }, [attendance, auth, employees, shifts, rotations, month]);

  // S8 fix: only records inside the user's scope can be backfilled (the scan
  // itself is scoped), and only when a shift end time is resolvable (B13).
  const fixMissingOut = (a: Anomaly) => {
    if (!a.record) return;
    if (auth && !auth.canViewEmployee(a.empId)) return; // defense-in-depth
    const emp = employees.find((e) => e.id === a.empId);
    const shift = emp ? shiftForEmployee(emp, shifts, rotations, a.date) : undefined;
    if (!shift) {
      setFixedMsg(`Cannot backfill ${empName(a.empId)} on ${fmtDate(a.date)} — no resolvable shift end time.`);
      return;
    }
    update(a.record.id, {
      clockOut: shift.endTime,
      notes: `${a.record.notes ?? ''} · clock-out backfilled to shift end by ${actorName(auth)}`.trim(),
    });
    logAudit({
      actorName: actorName(auth),
      action: 'attendance.backfill-clock-out',
      entity: 'attendance',
      entityId: a.record.id,
      detail: `Backfilled clock-out to ${shift.endTime} for ${empName(a.empId)} on ${a.date}`,
    });
    setFixedMsg(`Backfilled clock-out for ${empName(a.empId)} on ${fmtDate(a.date)}.`);
  };

  const counts = {
    'missing-out': anomalies.filter((a) => a.kind === 'missing-out').length,
    'over-12h': anomalies.filter((a) => a.kind === 'over-12h').length,
    'rest-day-work': anomalies.filter((a) => a.kind === 'rest-day-work').length,
  };

  if (employees.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-10 text-sm text-muted-foreground">Scanning attendance…</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="an-month">Month</Label>
          <Input id="an-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div className="flex gap-2 pb-0.5">
          {(Object.keys(KIND_META) as (keyof typeof KIND_META)[]).map((k) => (
            <Badge key={k} variant="secondary" className="gap-1">
              {KIND_META[k].label}: {counts[k]}
            </Badge>
          ))}
        </div>
      </div>

      {fixedMsg && <p className="text-sm text-emerald-700">{fixedMsg}</p>}

      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            {auth && auth.role === 'Employee' ? `Your anomalies — ${month}` : `Anomalies — ${month}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {anomalies.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              All clear — no attendance anomalies detected for {month}.
            </p>
          )}
          {anomalies.map((a) => {
            const meta = KIND_META[a.kind];
            const Icon = meta.icon;
            return (
              <div key={a.key} className="flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${meta.cls}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {empName(a.empId)} · {fmtDate(a.date)}
                  </div>
                  <div className="text-xs text-muted-foreground">{a.detail}</div>
                </div>
                <Badge className={`border-transparent ${meta.cls}`}>{meta.label}</Badge>
                {a.fixable && (
                  <Button size="sm" variant="outline" className="gap-1 rounded-lg" onClick={() => fixMissingOut(a)}>
                    <Wrench className="h-3.5 w-3.5" /> Backfill to shift end
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
