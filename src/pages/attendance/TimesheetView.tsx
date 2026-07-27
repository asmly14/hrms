/**
 * Timesheet — per-employee monthly grid: day × clock in/out, worked hours, OT.
 * Desktop renders a table; below md it collapses to day cards.
 * Scoped by role: Employee is locked to self, Manager sees own department.
 */
import { useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { useCollection } from '@/lib/db';
import type { Employee } from '@/lib/types';
import { monthKey } from '@/lib/utils';
import { isHoliday } from '@/lib/holidays';
import {
  DAY_NAMES, isLate, isScheduledWorkDay, shiftForEmployee, useRotations, workedHours,
  type AttendanceX, type ShiftX,
} from './model';
import { useAuthSafe } from './useAuthSafe';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface DayRow {
  date: string;
  dow: number;
  status: string;
  clockIn?: string;
  clockOut?: string;
  hours: number;
  otHours: number;
  otApprovedHours: number;
  late: boolean;
}

export default function TimesheetView() {
  const auth = useAuthSafe();
  const selfId = auth?.employeeId ?? null;
  const locked = !!auth && auth.role === 'Employee'; // Employee: own timesheet only
  const { items: employees } = useCollection<Employee>('employees');
  const { items: shifts } = useCollection<ShiftX>('shifts');
  const { items: attendance } = useCollection<AttendanceX>('attendance');
  const rotations = useRotations();

  // S2 fix: scope the selectable employees to the current user's visibility.
  const active = useMemo(() => {
    const visible = auth ? auth.scopeEmployees(employees) : employees;
    return visible
      .filter((e) => e.status !== 'resigned')
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, auth]);
  const [employeeId, setEmployeeId] = useState('');
  const [month, setMonth] = useState(monthKey());
  // Default to the auth-linked employee; Employee role is hard-locked to self.
  const emp = locked
    ? active.find((e) => e.id === selfId)
    : active.find((e) => e.id === employeeId) ?? active.find((e) => e.id === selfId) ?? active[0];

  const { rows, totals } = useMemo(() => {
    if (!emp) return { rows: [] as DayRow[], totals: { hours: 0, ot: 0, otApproved: 0, days: 0, late: 0 } };
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const rows: DayRow[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const dow = new Date(y, m - 1, d).getDay();
      const shift = shiftForEmployee(emp, shifts, rotations, date);
      const recs = attendance.filter((a) => a.employeeId === emp.id && a.date === date);
      const rec = recs.find((r) => r.clockIn) ?? recs[0];
      const hol = isHoliday(date, emp.state);
      const scheduled = isScheduledWorkDay(emp, shift, date);
      const hours = recs.reduce((s, r) => s + workedHours(r.clockIn, r.clockOut, shift?.breakMinutes ?? 0), 0);
      const ot = recs.reduce((s, r) => s + (r.otHours || 0), 0);
      // B12 fix: approved OT hours are tracked per record, not gated by a day-level boolean.
      const otApprHours = recs.reduce((s, r) => s + (r.otApproved ? r.otHours || 0 : 0), 0);
      let status: string;
      if (rec?.status === 'leave') status = 'Leave';
      else if (rec?.status === 'absent') status = 'Absent';
      else if (hol) status = `Holiday · ${hol.name}`;
      else if (rec?.clockIn) status = 'Present';
      else if (rec?.status === 'rest-day' || !scheduled) status = 'Rest day';
      else status = '—';
      rows.push({
        date, dow, status,
        clockIn: rec?.clockIn, clockOut: rec?.clockOut,
        hours, otHours: ot, otApprovedHours: otApprHours,
        late: rec?.clockIn ? isLate(rec.clockIn, shift) : false,
      });
    }
    const totals = rows.reduce(
      (t, r) => ({
        hours: t.hours + r.hours,
        ot: t.ot + r.otHours,
        otApproved: t.otApproved + r.otApprovedHours,
        days: t.days + (r.hours > 0 ? 1 : 0),
        late: t.late + (r.late ? 1 : 0),
      }),
      { hours: 0, ot: 0, otApproved: 0, days: 0, late: 0 },
    );
    return { rows, totals };
  }, [emp, month, attendance, shifts, rotations]);

  if (employees.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-10 text-sm text-muted-foreground">Loading timesheets…</CardContent>
      </Card>
    );
  }

  const statusChip = (r: DayRow) => {
    if (r.status === 'Present')
      return <Badge className="border-transparent bg-emerald-100 text-emerald-800">Present</Badge>;
    if (r.status === 'Absent')
      return <Badge className="border-transparent bg-rose-100 text-rose-800">Absent</Badge>;
    if (r.status === 'Leave')
      return <Badge className="border-transparent bg-stone-200 text-stone-700">Leave</Badge>;
    if (r.status.startsWith('Holiday'))
      return <Badge className="border-transparent bg-amber-100 text-amber-800" title={r.status}>Holiday</Badge>;
    if (r.status === 'Rest day') return <Badge variant="secondary">Rest day</Badge>;
    return <Badge variant="outline">—</Badge>;
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label>Employee</Label>
          {locked ? (
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
          {locked && !emp && (
            <p className="text-xs text-amber-700">
              Your account is not linked to an employee record — contact HR.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="ts-month">Month</Label>
          <Input id="ts-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: 'Days worked', value: String(totals.days) },
          { label: 'Worked hours', value: totals.hours.toFixed(1) },
          { label: 'Late days', value: String(totals.late) },
          { label: 'OT hours (all)', value: totals.ot.toFixed(1) },
          { label: 'OT approved', value: totals.otApproved.toFixed(1) },
        ].map((s) => (
          <Card key={s.label} className="rounded-xl">
            <CardContent className="py-4">
              <div className="text-xl font-semibold">{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Desktop table */}
      <Card className="hidden rounded-xl md:block">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4 text-amber-600" />
            {emp?.name} — {month}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Clock in</TableHead>
                <TableHead>Clock out</TableHead>
                <TableHead className="text-right">Hours</TableHead>
                <TableHead className="text-right">OT</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.date}>
                  <TableCell className="whitespace-nowrap">
                    {r.date.slice(8)} {DAY_NAMES[r.dow]}
                  </TableCell>
                  <TableCell>{statusChip(r)}</TableCell>
                  <TableCell className={r.late ? 'font-medium text-amber-700' : ''}>
                    {r.clockIn ?? '—'}{r.late && ' (late)'}
                  </TableCell>
                  <TableCell>{r.clockOut ?? '—'}</TableCell>
                  <TableCell className="text-right">{r.hours > 0 ? r.hours.toFixed(1) : '—'}</TableCell>
                  <TableCell className="text-right">
                    {r.otHours > 0 ? (
                      <span>
                        {r.otHours.toFixed(1)}h{' '}
                        <span className={r.otApprovedHours > 0 ? 'text-emerald-700' : 'text-muted-foreground'}>
                          {r.otApprovedHours > 0
                            ? r.otApprovedHours >= r.otHours
                              ? '✓'
                              : `✓ ${r.otApprovedHours.toFixed(1)}h`
                            : '(pending)'}
                        </span>
                      </span>
                    ) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Mobile day cards */}
      <div className="space-y-2 md:hidden">
        {rows.filter((r) => r.clockIn || r.status === 'Leave' || r.status === 'Absent').map((r) => (
          <Card key={r.date} className="rounded-xl">
            <CardContent className="flex items-center gap-3 py-3">
              <div className="w-12 text-center">
                <div className="text-lg font-semibold leading-none">{r.date.slice(8)}</div>
                <div className="text-[11px] text-muted-foreground">{DAY_NAMES[r.dow]}</div>
              </div>
              <div className="min-w-0 flex-1 text-sm">
                <div className={r.late ? 'font-medium text-amber-700' : ''}>
                  {r.clockIn ?? '—'} → {r.clockOut ?? '—'}{r.late && ' (late)'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {r.hours > 0 ? `${r.hours.toFixed(1)}h` : 'No hours'}
                  {r.otHours > 0 &&
                    ` · OT ${r.otHours.toFixed(1)}h ${
                      r.otApprovedHours > 0
                        ? r.otApprovedHours >= r.otHours
                          ? '✓'
                          : `✓ ${r.otApprovedHours.toFixed(1)}h`
                        : '(pending)'
                    }`}
                </div>
              </div>
              {statusChip(r)}
            </CardContent>
          </Card>
        ))}
        {rows.every((r) => !r.clockIn && r.status !== 'Leave' && r.status !== 'Absent') && (
          <Card className="rounded-xl">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No attendance entries recorded for this month yet.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
