/**
 * Team leave calendar — month grid with one chip per employee on leave,
 * colored by leave type. Approved = solid chip; pending = dashed outline.
 * Click a day for the full list below the grid.
 */
import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { fmtDate } from '@/lib/utils';
import type { Department, Employee } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  LEAVE_TYPE_META, parseISO, toISO, type LeaveRequestEx,
} from '../leaveLogic';
import { useAuthScope } from '../useAuthScope';

interface Props {
  employees: Employee[];
  leaves: LeaveRequestEx[];
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_EXPAND_DAYS = 120; // maternity spans months — expand enough, not infinite

interface DayEntry {
  leave: LeaveRequestEx;
  name: string;
}

export default function TeamCalendar({ employees, leaves }: Props) {
  const auth = useAuthScope();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-based
  const [dept, setDept] = useState<string>('all');
  const [selectedISO, setSelectedISO] = useState<string>(toISO(now));
  const { items: deptRows } = useCollection<Department>('departments');

  const departments = useMemo(
    () => [...deptRows].sort((a, b) => a.name.localeCompare(b.name)),
    [deptRows],
  );

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  // B2 — scope rows by role first: Employee sees only their own leave,
  // Manager their department, Admin/HR everyone. The dept dropdown is an
  // Admin/HR-only refinement on top of that.
  const visible = useMemo(
    () => auth.scopeByEmployee(leaves, (l) => l.employeeId).filter((l) => {
      if (l.status !== 'approved' && l.status !== 'pending') return false;
      if (!auth.isHROrAdmin) return true; // scope already applied; no dept refinement
      if (dept === 'all') return true;
      return empById.get(l.employeeId)?.departmentId === dept;
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leaves, dept, empById, auth.scopeByEmployee, auth.isHROrAdmin],
  );

  // date ISO → entries for the visible month window (± expanded ranges)
  const dayMap = useMemo(() => {
    const map = new Map<string, DayEntry[]>();
    const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const monthEndDate = new Date(year, month + 1, 0);
    const monthEnd = toISO(monthEndDate);
    visible.forEach((l) => {
      const start = parseISO(l.startDate);
      const span = Math.min(
        Math.round((parseISO(l.endDate).getTime() - start.getTime()) / 86_400_000),
        MAX_EXPAND_DAYS,
      );
      for (let i = 0; i <= span; i += 1) {
        const d = new Date(start.getTime());
        d.setDate(d.getDate() + i);
        const iso = toISO(d);
        if (iso < monthStart || iso > monthEnd) continue;
        const list = map.get(iso) ?? [];
        list.push({ leave: l, name: empById.get(l.employeeId)?.name ?? l.employeeId });
        map.set(iso, list);
      }
    });
    return map;
  }, [visible, year, month, empById]);

  // 6-row Monday-first grid covering the month
  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // Mon=0
    const gridStart = new Date(year, month, 1 - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart.getTime());
      d.setDate(d.getDate() + i);
      return { iso: toISO(d), inMonth: d.getMonth() === month, day: d.getDate() };
    });
  }, [year, month]);

  const move = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  const today = toISO(now);
  const monthLabel = new Date(year, month, 1).toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
  const selectedEntries = dayMap.get(selectedISO) ?? [];

  return (
    <Card className="rounded-xl">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4 text-amber-600" /> Team calendar
          </CardTitle>
          <CardDescription>
            {auth.role === 'Employee'
              ? 'Your approved and pending leave.'
              : auth.role === 'Manager'
                ? 'Approved and pending leave in your department.'
                : 'Approved and pending leave across the team.'}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {auth.isHROrAdmin && (
            <Select value={dept} onValueChange={setDept}>
              <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" onClick={() => move(-1)} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[130px] text-center text-sm font-medium">{monthLabel}</span>
            <Button variant="outline" size="icon" onClick={() => move(1)} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Legend */}
        <div className="flex flex-wrap gap-2">
          {Object.entries(LEAVE_TYPE_META).map(([key, meta]) => (
            <Badge key={key} variant="secondary" className={cn('font-normal', meta.chip)}>
              {meta.label}
            </Badge>
          ))}
          <Badge variant="outline" className="border-dashed font-normal">Pending</Badge>
        </div>

        {/* Month grid */}
        <div className="overflow-hidden rounded-xl border">
          <div className="grid grid-cols-7 border-b bg-muted/50">
            {WEEKDAYS.map((w) => (
              <div key={w} className="px-1 py-2 text-center text-xs font-medium text-muted-foreground">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((c, i) => {
              const entries = dayMap.get(c.iso) ?? [];
              const isSelected = c.iso === selectedISO;
              return (
                <button
                  key={c.iso}
                  type="button"
                  onClick={() => setSelectedISO(c.iso)}
                  className={cn(
                    'flex min-h-[64px] flex-col gap-0.5 border-b p-1 text-left transition-colors sm:min-h-[88px] sm:p-1.5',
                    (i + 1) % 7 !== 0 && 'border-r',
                    !c.inMonth && 'bg-muted/30 text-muted-foreground/50',
                    isSelected ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full text-xs',
                      c.iso === today && 'bg-primary font-semibold text-primary-foreground',
                    )}
                  >
                    {c.day}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    {entries.slice(0, 2).map((en) => (
                      <span
                        key={en.leave.id}
                        className={cn(
                          'block truncate rounded px-1 py-0.5 text-[10px] leading-tight',
                          LEAVE_TYPE_META[en.leave.type].chip,
                          en.leave.status === 'pending' && 'border border-dashed border-current opacity-75',
                        )}
                        title={`${en.name} — ${LEAVE_TYPE_META[en.leave.type].label} (${en.leave.status})`}
                      >
                        {en.name.split(' ')[0]}
                      </span>
                    ))}
                    {entries.length > 2 && (
                      <span className="px-1 text-[10px] text-muted-foreground">+{entries.length - 2} more</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected day detail */}
        <div className="rounded-xl border p-4">
          <p className="text-sm font-medium">{fmtDate(selectedISO)}</p>
          {selectedEntries.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No one is on leave this day.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {selectedEntries.map((en) => (
                <li key={en.leave.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="secondary" className={cn(LEAVE_TYPE_META[en.leave.type].chip)}>
                    {LEAVE_TYPE_META[en.leave.type].label}
                  </Badge>
                  <span className="font-medium">{en.name}</span>
                  <span className="text-muted-foreground">
                    {fmtDate(en.leave.startDate)} → {fmtDate(en.leave.endDate)} · {en.leave.days}d
                  </span>
                  <Badge
                    variant="secondary"
                    className={cn(
                      en.leave.status === 'approved'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
                    )}
                  >
                    {en.leave.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
