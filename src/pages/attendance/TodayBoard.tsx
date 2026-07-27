/**
 * Today board — who's in / late / absent / on leave for the current day.
 * Late = clock-in after shift start + grace (default 10 min).
 * Scoped by role: Admin/HR see everyone, Manager own department, Employee self only.
 */
import { useMemo } from 'react';
import { CalendarX2, Clock3, Hourglass, UserCheck, UserX, Palmtree } from 'lucide-react';
import { useCollection } from '@/lib/db';
import type { Employee, LeaveRequest } from '@/lib/types';
import { avatarTone, cn, initialsOf } from '@/lib/utils';
import { isHoliday, isWeekend } from '@/lib/holidays';
import {
  isLate, isScheduledWorkDay, nowHHmm, hhmmToMin, shiftEndMin, shiftForEmployee, todayISO,
  useRotations, type AttendanceX, type ShiftX,
} from './model';
import { useAuthSafe } from './useAuthSafe';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type BoardStatus = 'in' | 'late' | 'absent' | 'awaiting' | 'leave' | 'off';

interface Row {
  emp: Employee;
  status: BoardStatus;
  clockIn?: string;
  shiftLabel: string;
}

const STATUS_CHIP: Record<BoardStatus, { label: string; cls: string }> = {
  in: { label: 'In', cls: 'bg-emerald-100 text-emerald-800' },
  late: { label: 'Late', cls: 'bg-amber-100 text-amber-800' },
  absent: { label: 'Absent', cls: 'bg-rose-100 text-rose-800' },
  awaiting: { label: 'Not in yet', cls: 'bg-muted text-muted-foreground' },
  leave: { label: 'On leave', cls: 'bg-stone-200 text-stone-700' },
  off: { label: 'Off day', cls: 'bg-muted text-muted-foreground' },
};

export default function TodayBoard() {
  const auth = useAuthSafe();
  const { items: employees } = useCollection<Employee>('employees');
  const { items: shifts } = useCollection<ShiftX>('shifts');
  const { items: attendance } = useCollection<AttendanceX>('attendance');
  const { items: leaves } = useCollection<LeaveRequest>('leaves');
  const rotations = useRotations();

  // S1 fix: scope the board to the current user's visible employees.
  const visibleEmployees = useMemo(
    () => (auth ? auth.scopeEmployees(employees) : employees),
    [employees, auth],
  );

  const today = todayISO();
  const rows = useMemo<Row[]>(() => {
    const nowMin = hhmmToMin(nowHHmm());
    return visibleEmployees
      .filter((e) => e.status !== 'resigned')
      .map((emp) => {
        const shift = shiftForEmployee(emp, shifts, rotations, today);
        const shiftLabel = shift ? `${shift.name} · ${shift.startTime}` : 'No shift';
        const rec = attendance.find((a) => a.employeeId === emp.id && a.date === today);
        const onLeave =
          rec?.status === 'leave' ||
          leaves.some(
            (l) => l.employeeId === emp.id && l.status === 'approved' && l.startDate <= today && l.endDate >= today,
          );
        const scheduled = isScheduledWorkDay(emp, shift, today) && !isHoliday(today, emp.state);

        let status: BoardStatus;
        if (onLeave) status = 'leave';
        else if (rec?.clockIn) status = isLate(rec.clockIn, shift) ? 'late' : 'in';
        else if (!scheduled) status = 'off';
        // B7 fix: only mark Absent once the shift has actually ended; intra-day
        // the employee is "Not in yet" (they may still arrive and be Late).
        else if (shift && nowMin > shiftEndMin(shift)) status = 'absent';
        else status = 'awaiting'; // scheduled, shift still running (or hasn't started)
        return { emp, status, clockIn: rec?.clockIn, shiftLabel };
      })
      .sort((a, b) => {
        const order: Record<BoardStatus, number> = { late: 0, absent: 1, awaiting: 2, in: 3, leave: 4, off: 5 };
        return order[a.status] - order[b.status] || a.emp.name.localeCompare(b.emp.name);
      });
  }, [visibleEmployees, shifts, attendance, leaves, rotations, today]);

  const counts = useMemo(() => {
    const c: Record<BoardStatus, number> = { in: 0, late: 0, absent: 0, awaiting: 0, leave: 0, off: 0 };
    rows.forEach((r) => { c[r.status] += 1; });
    return c;
  }, [rows]);

  // B6 fix: no hardcoded state — evaluate across the states of visible staff.
  const scopedStates = useMemo(
    () => [...new Set(visibleEmployees.filter((e) => e.status !== 'resigned').map((e) => e.state))],
    [visibleEmployees],
  );
  const holiday = scopedStates.map((s) => isHoliday(today, s)).find((h) => h) ?? null;
  const weekend = scopedStates.some((s) => isWeekend(today, s));

  if (employees.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-10 text-sm text-muted-foreground">Loading today’s board…</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {([
          { k: 'in' as const, icon: UserCheck, label: 'Clocked in' },
          { k: 'late' as const, icon: Clock3, label: 'Late' },
          { k: 'absent' as const, icon: UserX, label: 'Absent' },
          { k: 'awaiting' as const, icon: Hourglass, label: 'Not in yet' },
          { k: 'leave' as const, icon: CalendarX2, label: 'On leave' },
          { k: 'off' as const, icon: Palmtree, label: 'Off day' },
        ]).map(({ k, icon: Icon, label }) => (
          <Card key={k} className="rounded-xl">
            <CardContent className="flex items-center gap-3 py-4">
              <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg', STATUS_CHIP[k].cls)}>
                <Icon className="h-4 w-4" />
              </span>
              <div>
                <div className="text-xl font-semibold">{counts[k]}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {(holiday || weekend) && (
        <p className="text-xs text-muted-foreground">
          {holiday
            ? `Today is ${holiday.name} (public holiday).`
            : 'Today is a weekend day for some staff (weekend patterns differ by state).'}{' '}
          Staff on shifts that include today are still expected.
        </p>
      )}

      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">
            {auth && auth.role === 'Employee' ? 'Your attendance today' : 'Today’s attendance'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {rows.map((r) => (
            <div
              key={r.emp.id}
              className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5"
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  avatarTone(r.emp.name),
                )}
              >
                {initialsOf(r.emp.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.emp.name}</div>
                <div className="truncate text-xs text-muted-foreground">{r.shiftLabel}</div>
              </div>
              {r.clockIn && <span className="text-xs text-muted-foreground">{r.clockIn}</span>}
              <Badge className={cn('border-transparent', STATUS_CHIP[r.status].cls)}>
                {STATUS_CHIP[r.status].label}
              </Badge>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No active employees found.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
