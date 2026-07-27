/**
 * Shifts page — /attendance/shifts.
 * Shift CRUD (name/start/end/grace/break/work-days/rest-day), fixed employee
 * assignment, service-staff rotation patterns, and state-weekend rest-day hints.
 * Mutations are restricted to Admin/HR — Managers (and Employees) get a
 * read-only view of the roster.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, CalendarRange, Pencil, Plus, RefreshCcw, Trash2, Users2,
} from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import type { Employee, StateCode } from '@/lib/types';
import { fmtDate } from '@/lib/utils';
import { stateInfo, states } from '@/lib/holidays';
import {
  DAY_NAMES, getRotations, hhmmToMin, restDayHint, saveRotations, shiftHours,
  todayISO, useRotations, type AttendanceX, type RotationPlan, type ShiftX,
} from './model';
import { actorName, isAdminOrHR, useAuthSafe } from './useAuthSafe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const EMPTY_FORM = {
  name: '', startTime: '09:00', endTime: '18:00', breakMinutes: 60,
  graceMinutes: 10, workDays: [1, 2, 3, 4, 5] as number[], restDay: 0,
};

type ShiftForm = typeof EMPTY_FORM;

/** B9/B11: validate the shift form; returns an error message or ''. */
function shiftFormError(form: ShiftForm): string {
  if (form.startTime === form.endTime) {
    return 'Start and end time cannot be identical — that would define a 24h shift.';
  }
  let gross = hhmmToMin(form.endTime) - hhmmToMin(form.startTime);
  if (gross < 0) gross += 1440; // overnight shift
  if (form.breakMinutes >= gross) {
    return `Break (${form.breakMinutes}m) must be shorter than the gross shift duration (${gross}m).`;
  }
  if (form.workDays.includes(form.restDay)) {
    return `${DAY_NAMES[form.restDay]} is both a work day and the rest day — the rest day must fall outside the work days.`;
  }
  return '';
}

export default function ShiftsPage() {
  const auth = useAuthSafe();
  // S9 fix: only Admin/HR may create/edit/delete shifts, assign staff, or
  // manage rotations. Pre-auth demo preserves full access.
  const canManage = isAdminOrHR(auth);
  const { items: employees } = useCollection<Employee>('employees');
  const { items: shifts, add, update, remove } = useCollection<ShiftX>('shifts');
  const { items: attendance } = useCollection<AttendanceX>('attendance');
  const rotations = useRotations();

  const active = useMemo(
    () => employees.filter((e) => e.status !== 'resigned').sort((a, b) => a.name.localeCompare(b.name)),
    [employees],
  );

  // ── Shift form dialog ──
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ShiftForm>(EMPTY_FORM);
  const [hintState, setHintState] = useState<StateCode>('KUL');

  // ── Delete confirmation (B10) ──
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // ── Assignment dialog ──
  const [assignShiftId, setAssignShiftId] = useState<string | null>(null);

  // ── Rotation plan form ──
  const [rotOpen, setRotOpen] = useState(false);
  const [rotName, setRotName] = useState('');
  const [rotShiftIds, setRotShiftIds] = useState<string[]>([]);
  const [rotWeeks, setRotWeeks] = useState('1');
  const [rotAnchor, setRotAnchor] = useState(todayISO());
  const [rotMembers, setRotMembers] = useState<string[]>([]);

  const openNew = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const openEdit = (s: ShiftX) => {
    setEditingId(s.id);
    setForm({
      name: s.name, startTime: s.startTime, endTime: s.endTime,
      breakMinutes: s.breakMinutes, graceMinutes: s.graceMinutes ?? 10,
      workDays: [...s.workDays], restDay: s.restDay,
    });
    setFormOpen(true);
  };

  const formError = shiftFormError(form);

  const saveShift = () => {
    if (!canManage || !form.name.trim() || form.workDays.length === 0 || formError) return;
    const payload = { ...form, name: form.name.trim(), workDays: [...form.workDays].sort() };
    if (editingId) {
      update(editingId, payload);
      logAudit({
        actorName: actorName(auth), action: 'attendance.shift-update', entity: 'shifts',
        entityId: editingId, detail: `Shift updated: ${payload.name} ${payload.startTime}–${payload.endTime}`,
      });
    } else {
      const created = add(payload as Omit<ShiftX, 'id'>);
      logAudit({
        actorName: actorName(auth), action: 'attendance.shift-create', entity: 'shifts',
        entityId: created.id, detail: `Shift created: ${payload.name} ${payload.startTime}–${payload.endTime}`,
      });
    }
    setFormOpen(false);
  };

  const toggleWorkDay = (d: number) => {
    setForm((f) => ({
      ...f,
      workDays: f.workDays.includes(d) ? f.workDays.filter((x) => x !== d) : [...f.workDays, d],
    }));
  };

  const applyStateRestDay = (code: StateCode) => {
    setHintState(code);
    // Fri–Sat weekend states → Friday (5) is the common weekly rest day; else Sunday (0).
    setForm((f) => ({ ...f, restDay: stateInfo(code).weekend === 'fri-sat' ? 5 : 0 }));
  };

  // ── Delete with confirmation + cascade (B10) ──
  const deleteTarget = deleteId ? shifts.find((s) => s.id === deleteId) : undefined;
  const deleteAttendanceRefs = deleteId ? attendance.filter((a) => a.shiftId === deleteId).length : 0;
  const deleteRotationRefs = deleteId ? rotations.filter((p) => p.shiftIds.includes(deleteId)) : [];

  const confirmDelete = () => {
    if (!canManage || !deleteTarget) return;
    remove(deleteTarget.id);
    // Cascade: drop the deleted shift from every rotation plan that uses it.
    const cleaned = getRotations().map((p) =>
      p.shiftIds.includes(deleteTarget.id)
        ? { ...p, shiftIds: p.shiftIds.filter((id) => id !== deleteTarget.id) }
        : p,
    );
    saveRotations(cleaned);
    logAudit({
      actorName: actorName(auth), action: 'attendance.shift-delete', entity: 'shifts',
      entityId: deleteTarget.id,
      detail:
        `Shift deleted: ${deleteTarget.name} ` +
        `(${(deleteTarget.employeeIds ?? []).length} assigned unassigned; ` +
        `${deleteRotationRefs.length} rotation plan(s) cleaned; ${deleteAttendanceRefs} historical attendance record(s) keep their stored times)`,
    });
    setDeleteId(null);
  };

  // ── Fixed assignment ──
  const assignedElsewhere = (empId: string, exceptShiftId: string) =>
    shifts.find((s) => s.id !== exceptShiftId && (s.employeeIds ?? []).includes(empId));

  const toggleAssign = (shiftId: string, empId: string, on: boolean) => {
    if (!canManage) return;
    const shift = shifts.find((s) => s.id === shiftId);
    if (!shift) return;
    if (on) {
      // Move: remove from any other shift first.
      const other = assignedElsewhere(empId, shiftId);
      if (other) {
        update(other.id, { employeeIds: (other.employeeIds ?? []).filter((id) => id !== empId) });
      }
      const next = new Set([...(shift.employeeIds ?? []), empId]);
      update(shiftId, { employeeIds: [...next] });
      logAudit({
        actorName: actorName(auth), action: 'attendance.shift-assign', entity: 'shifts',
        entityId: shiftId,
        detail: `${empName(empId)} assigned to ${shift.name}${other ? ` (moved from ${other.name})` : ''}`,
      });
    } else {
      update(shiftId, { employeeIds: (shift.employeeIds ?? []).filter((id) => id !== empId) });
      logAudit({
        actorName: actorName(auth), action: 'attendance.shift-unassign', entity: 'shifts',
        entityId: shiftId, detail: `${empName(empId)} unassigned from ${shift.name}`,
      });
    }
  };

  // ── Rotation plans ──
  const saveRotation = () => {
    if (!canManage || !rotName.trim() || rotShiftIds.length < 2 || rotMembers.length === 0) return;
    const plan: RotationPlan = {
      id: `rot-${Date.now().toString(36)}`,
      name: rotName.trim(),
      shiftIds: rotShiftIds,
      weeksEach: Math.max(1, Number(rotWeeks) || 1),
      anchorDate: rotAnchor,
      employeeIds: rotMembers,
    };
    saveRotations([...getRotations(), plan]);
    logAudit({
      actorName: actorName(auth), action: 'attendance.rotation-create', entity: 'shifts',
      entityId: plan.id, detail: `Rotation created: ${plan.name} (${plan.employeeIds.length} staff)`,
    });
    setRotOpen(false);
    setRotName('');
    setRotShiftIds([]);
    setRotMembers([]);
    setRotWeeks('1');
  };

  const deleteRotation = (id: string) => {
    if (!canManage) return;
    const plan = getRotations().find((p) => p.id === id);
    saveRotations(getRotations().filter((p) => p.id !== id));
    logAudit({
      actorName: actorName(auth), action: 'attendance.rotation-delete', entity: 'shifts',
      entityId: id, detail: `Rotation deleted: ${plan?.name ?? id}`,
    });
  };

  const currentShiftOfPlan = (p: RotationPlan): ShiftX | undefined => {
    const days = Math.floor((Date.parse(`${todayISO()}T00:00:00`) - Date.parse(`${p.anchorDate}T00:00:00`)) / 86_400_000);
    if (days < 0 || p.shiftIds.length === 0) return undefined;
    const idx = Math.floor(Math.floor(days / 7) / Math.max(1, p.weeksEach)) % p.shiftIds.length;
    return shifts.find((s) => s.id === p.shiftIds[idx]);
  };

  const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Shifts & rosters</h1>
          <p className="text-sm text-muted-foreground">
            {canManage
              ? 'Define shifts, assign employees, and manage rotating patterns for service staff.'
              : 'Read-only view of shifts and rotating patterns — contact HR for changes.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" className="gap-2 rounded-xl">
            <Link to="/attendance"><ArrowLeft className="h-4 w-4" /> Attendance</Link>
          </Button>
          {canManage && (
            <Button className="gap-2 rounded-xl" onClick={openNew}>
              <Plus className="h-4 w-4" /> New shift
            </Button>
          )}
        </div>
      </div>

      {/* Shift cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {shifts.map((s) => (
          <Card key={s.id} className="rounded-xl">
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle className="text-base">{s.name}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  {s.startTime}–{s.endTime} · {shiftHours(s).toFixed(1)}h net · break {s.breakMinutes}m ·
                  grace {s.graceMinutes ?? 10}m
                </p>
              </div>
              {canManage && (
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" aria-label="Assign employees" onClick={() => setAssignShiftId(s.id)}>
                    <Users2 className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Edit shift" onClick={() => openEdit(s)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Delete shift" onClick={() => setDeleteId(s.id)}>
                    <Trash2 className="h-4 w-4 text-rose-600" />
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {DAY_NAMES.map((d, i) => (
                  <Badge
                    key={d}
                    variant={s.workDays.includes(i) ? 'default' : 'outline'}
                    className={i === s.restDay ? 'ring-2 ring-amber-400' : ''}
                  >
                    {d}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Rest day: <strong>{DAY_NAMES[s.restDay]}</strong> (EA 1955 s.59 weekly rest day) ·{' '}
                {(s.employeeIds ?? []).length > 0
                  ? `${(s.employeeIds ?? []).length} assigned`
                  : 'No fixed assignment (default rules apply)'}
              </p>
              {(s.employeeIds ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {(s.employeeIds ?? []).slice(0, 6).map((id) => (
                    <Badge key={id} variant="secondary">{empName(id).split(' ').slice(0, 2).join(' ')}</Badge>
                  ))}
                  {(s.employeeIds ?? []).length > 6 && (
                    <Badge variant="outline">+{(s.employeeIds ?? []).length - 6} more</Badge>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {shifts.length === 0 && (
          <Card className="rounded-xl md:col-span-2">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No shifts defined yet — create one to get started.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Rotation plans */}
      <Card className="rounded-xl">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCcw className="h-4 w-4 text-amber-600" /> Rotating shift patterns
          </CardTitle>
          {canManage && (
            <Button variant="outline" size="sm" className="gap-1 rounded-lg" onClick={() => setRotOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> New rotation
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {rotations.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No rotation plans. Rotations cycle service staff through 2+ shifts (e.g. Shift A ↔ Shift B weekly).
            </p>
          )}
          {rotations.map((p) => {
            const current = currentShiftOfPlan(p);
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-800">
                  <CalendarRange className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.shiftIds.map((id) => shifts.find((s) => s.id === id)?.name ?? id).join(' → ')} ·
                    every {p.weeksEach}w · anchored {fmtDate(p.anchorDate)} · {p.employeeIds.length} staff
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.employeeIds.map((id) => (
                      <Badge key={id} variant="secondary">{empName(id).split(' ').slice(0, 2).join(' ')}</Badge>
                    ))}
                  </div>
                </div>
                {current && <Badge className="border-transparent bg-emerald-100 text-emerald-800">This week: {current.name}</Badge>}
                {canManage && (
                  <Button size="icon" variant="ghost" aria-label="Delete rotation" onClick={() => deleteRotation(p.id)}>
                    <Trash2 className="h-4 w-4 text-rose-600" />
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── Shift form dialog ── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit shift' : 'New shift'}</DialogTitle>
            <DialogDescription>Times are 24-hour. Overnight shifts (end before start) are supported.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="sf-name">Shift name</Label>
              <Input id="sf-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Service Shift C (night)" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sf-start">Start</Label>
              <Input id="sf-start" type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sf-end">End</Label>
              <Input id="sf-end" type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sf-break">Break (minutes)</Label>
              <Input id="sf-break" type="number" min={0} value={form.breakMinutes} onChange={(e) => setForm({ ...form, breakMinutes: Math.max(0, Number(e.target.value) || 0) })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sf-grace">Late grace (minutes)</Label>
              <Input id="sf-grace" type="number" min={0} value={form.graceMinutes} onChange={(e) => setForm({ ...form, graceMinutes: Math.max(0, Number(e.target.value) || 0) })} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Work days</Label>
              <div className="flex flex-wrap gap-3">
                {DAY_NAMES.map((d, i) => (
                  <label key={d} className="flex items-center gap-1.5 text-sm">
                    <Checkbox checked={form.workDays.includes(i)} onCheckedChange={() => toggleWorkDay(i)} />
                    {d}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Weekly rest day</Label>
              <Select value={String(form.restDay)} onValueChange={(v) => setForm({ ...form, restDay: Number(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAY_NAMES.map((d, i) => (
                    <SelectItem key={d} value={String(i)}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Suggest by state weekend</Label>
              <Select value={hintState} onValueChange={(v) => applyStateRestDay(v as StateCode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {states.map((st) => (
                    <SelectItem key={st.code} value={st.code}>{st.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{restDayHint(hintState)}</p>
            {formError && (
              <p className="rounded-lg border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 sm:col-span-2">
                {formError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button onClick={saveShift} disabled={!form.name.trim() || form.workDays.length === 0 || !!formError}>
              {editingId ? 'Save changes' : 'Create shift'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation dialog (B10) ── */}
      <Dialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete shift — {deleteTarget?.name}</DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            {(deleteTarget?.employeeIds ?? []).length > 0 && (
              <p>
                {(deleteTarget?.employeeIds ?? []).length} employee(s) currently assigned will be
                unassigned and fall back to default shift rules.
              </p>
            )}
            {deleteRotationRefs.length > 0 && (
              <p>
                Removed from rotation plan(s): {deleteRotationRefs.map((p) => p.name).join(', ')}.
              </p>
            )}
            {deleteAttendanceRefs > 0 && (
              <p>
                {deleteAttendanceRefs} historical attendance record(s) reference this shift — they keep
                their stored clock times and fall back to default shift rules going forward.
              </p>
            )}
            {(deleteTarget?.employeeIds ?? []).length === 0 &&
              deleteRotationRefs.length === 0 &&
              deleteAttendanceRefs === 0 && <p>No assignments or references — safe to delete.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button
              className="bg-rose-600 text-white hover:bg-rose-700"
              onClick={confirmDelete}
            >
              <Trash2 className="mr-1 h-4 w-4" /> Delete shift
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Assignment dialog ── */}
      <Dialog open={assignShiftId !== null} onOpenChange={(open) => !open && setAssignShiftId(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign employees — {shifts.find((s) => s.id === assignShiftId)?.name}</DialogTitle>
            <DialogDescription>
              Assigning an employee who already belongs to another shift moves them here.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {active.map((e) => {
              const shift = shifts.find((s) => s.id === assignShiftId);
              const checked = (shift?.employeeIds ?? []).includes(e.id);
              const elsewhere = assignShiftId ? assignedElsewhere(e.id, assignShiftId) : undefined;
              return (
                <label key={e.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/60">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => assignShiftId && toggleAssign(assignShiftId, e.id, v === true)}
                  />
                  <span className="flex-1">{e.name}</span>
                  {elsewhere && <span className="text-[11px] text-muted-foreground">from {elsewhere.name}</span>}
                </label>
              );
            })}
          </div>
          <DialogFooter>
            <Button onClick={() => setAssignShiftId(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Rotation dialog ── */}
      <Dialog open={rotOpen} onOpenChange={setRotOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New rotation pattern</DialogTitle>
            <DialogDescription>
              Members cycle through the chosen shifts in order, staying {rotWeeks} week(s) on each.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="rot-name">Pattern name</Label>
              <Input id="rot-name" value={rotName} onChange={(e) => setRotName(e.target.value)} placeholder="e.g. Service team A/B rotation" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Shift sequence (in order)</Label>
              <div className="flex flex-wrap items-center gap-2">
                {rotShiftIds.map((id, i) => (
                  <Badge key={`${id}-${i}`} variant="secondary" className="gap-1">
                    {i + 1}. {shifts.find((s) => s.id === id)?.name ?? id}
                    <button
                      className="ml-1 text-muted-foreground hover:text-rose-600"
                      onClick={() => setRotShiftIds(rotShiftIds.filter((_, j) => j !== i))}
                      aria-label="Remove shift"
                    >×</button>
                  </Badge>
                ))}
                <Select onValueChange={(v) => setRotShiftIds([...rotShiftIds, v])}>
                  <SelectTrigger className="h-8 w-44"><SelectValue placeholder="+ Add shift" /></SelectTrigger>
                  <SelectContent>
                    {shifts.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rot-weeks">Weeks on each shift</Label>
              <Input id="rot-weeks" type="number" min={1} value={rotWeeks} onChange={(e) => setRotWeeks(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rot-anchor">Anchor date (week 1)</Label>
              <Input id="rot-anchor" type="date" value={rotAnchor} onChange={(e) => setRotAnchor(e.target.value)} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Members ({rotMembers.length})</Label>
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border p-2">
                {active.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-muted/60">
                    <Checkbox
                      checked={rotMembers.includes(e.id)}
                      onCheckedChange={(v) =>
                        setRotMembers(v === true ? [...rotMembers, e.id] : rotMembers.filter((x) => x !== e.id))
                      }
                    />
                    {e.name}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotOpen(false)}>Cancel</Button>
            <Button onClick={saveRotation} disabled={!rotName.trim() || rotShiftIds.length < 2 || rotMembers.length === 0}>
              Create rotation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
