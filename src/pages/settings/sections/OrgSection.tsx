/**
 * Settings → Organization: CRUD for departments and positions with live
 * employee counts from the 'employees' collection.
 */
import { useState, type FormEvent } from 'react';
import { Briefcase, Network, Pencil, Plus, Trash2 } from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import { states, stateInfo } from '@/lib/holidays';
import { fmtRM } from '@/lib/utils';
import type { Department, Employee, Position, PositionLevel, StateCode } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DEMO_ACTOR, Field, SectionCard, numOr } from '../shared';

const POSITION_LEVELS: PositionLevel[] = ['junior', 'senior', 'lead', 'manager', 'exec'];

/* ─────────────────────────── Departments ─────────────────────────── */

interface DeptForm {
  name: string;
  code: string;
  state: StateCode;
}

function DepartmentsCard({ employees }: { employees: Employee[] }) {
  const { items: departments, add, update, remove } = useCollection<Department>('departments');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [deleting, setDeleting] = useState<Department | null>(null);
  const [form, setForm] = useState<DeptForm>({ name: '', code: '', state: 'KUL' });

  const countFor = (id: string) => employees.filter((e) => e.departmentId === id).length;

  const openAdd = () => {
    setEditing(null);
    setForm({ name: '', code: '', state: 'KUL' });
    setDialogOpen(true);
  };
  const openEdit = (d: Department) => {
    setEditing(d);
    setForm({ name: d.name, code: d.code, state: d.state });
    setDialogOpen(true);
  };

  const valid = form.name.trim().length > 0 && form.code.trim().length > 0;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const patch = { name: form.name.trim(), code: form.code.trim().toUpperCase(), state: form.state };
    if (editing) {
      update(editing.id, patch);
      logAudit({ actorName: DEMO_ACTOR, action: 'department.update', entity: 'departments', entityId: editing.id, detail: patch.name });
    } else {
      const created = add(patch);
      logAudit({ actorName: DEMO_ACTOR, action: 'department.create', entity: 'departments', entityId: created.id, detail: patch.name });
    }
    setDialogOpen(false);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    remove(deleting.id);
    logAudit({ actorName: DEMO_ACTOR, action: 'department.delete', entity: 'departments', entityId: deleting.id, detail: deleting.name });
    setDeleting(null);
  };

  return (
    <SectionCard
      icon={Network}
      title="Departments"
      description={`${departments.length} departments · employees are reassigned before a department can be deleted.`}
      action={
        <Button size="sm" onClick={openAdd}>
          <Plus className="mr-1.5 h-4 w-4" /> Add department
        </Button>
      }
    >
      {/* Desktop table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Department</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Employees</TableHead>
              <TableHead className="w-[100px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments.map((d) => {
              const count = countFor(d.id);
              return (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{d.code}</Badge>
                  </TableCell>
                  <TableCell>{stateInfo(d.state).name}</TableCell>
                  <TableCell className="text-right">{count}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Edit ${d.name}`} onClick={() => openEdit(d)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${d.name}`}
                        disabled={count > 0}
                        title={count > 0 ? 'Reassign employees first' : 'Delete department'}
                        onClick={() => setDeleting(d)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {departments.map((d) => {
          const count = countFor(d.id);
          return (
            <div key={d.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{d.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {d.code} · {stateInfo(d.state).name} · {count} employee{count === 1 ? '' : 's'}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon" aria-label={`Edit ${d.name}`} onClick={() => openEdit(d)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${d.name}`}
                  disabled={count > 0}
                  onClick={() => setDeleting(d)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit department' : 'Add department'}</DialogTitle>
              <DialogDescription>Departments group employees and positions for reporting.</DialogDescription>
            </DialogHeader>
            <Field label="Department name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Engineering" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Code">
                <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="ENG" />
              </Field>
              <Field label="State">
                <Select value={form.state} onValueChange={(v) => setForm({ ...form, state: v as StateCode })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {states.map((s) => (
                      <SelectItem key={s.code} value={s.code}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid}>
                {editing ? 'Save changes' : 'Add department'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the department permanently. Positions linked to it remain but will show no department.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

/* ─────────────────────────── Positions ─────────────────────────── */

interface PosForm {
  title: string;
  departmentId: string;
  level: PositionLevel;
  minSalary: string;
  maxSalary: string;
}

function PositionsCard({ employees }: { employees: Employee[] }) {
  const { items: positions, add, update, remove } = useCollection<Position>('positions');
  const { items: departments } = useCollection<Department>('departments');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Position | null>(null);
  const [deleting, setDeleting] = useState<Position | null>(null);
  const [form, setForm] = useState<PosForm>({ title: '', departmentId: '', level: 'junior', minSalary: '', maxSalary: '' });

  const countFor = (id: string) => employees.filter((e) => e.positionId === id).length;
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? '—';

  const openAdd = () => {
    setEditing(null);
    setForm({ title: '', departmentId: departments[0]?.id ?? '', level: 'junior', minSalary: '', maxSalary: '' });
    setDialogOpen(true);
  };
  const openEdit = (p: Position) => {
    setEditing(p);
    setForm({ title: p.title, departmentId: p.departmentId, level: p.level, minSalary: String(p.minSalary), maxSalary: String(p.maxSalary) });
    setDialogOpen(true);
  };

  const min = numOr(form.minSalary, NaN);
  const max = numOr(form.maxSalary, NaN);
  const rangeInvalid = Number.isFinite(min) && Number.isFinite(max) && min > max;
  const valid = form.title.trim().length > 0 && form.departmentId.length > 0 && Number.isFinite(min) && Number.isFinite(max) && !rangeInvalid;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const patch = { title: form.title.trim(), departmentId: form.departmentId, level: form.level, minSalary: min, maxSalary: max };
    if (editing) {
      update(editing.id, patch);
      logAudit({ actorName: DEMO_ACTOR, action: 'position.update', entity: 'positions', entityId: editing.id, detail: patch.title });
    } else {
      const created = add(patch);
      logAudit({ actorName: DEMO_ACTOR, action: 'position.create', entity: 'positions', entityId: created.id, detail: patch.title });
    }
    setDialogOpen(false);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    remove(deleting.id);
    logAudit({ actorName: DEMO_ACTOR, action: 'position.delete', entity: 'positions', entityId: deleting.id, detail: deleting.title });
    setDeleting(null);
  };

  return (
    <SectionCard
      icon={Briefcase}
      title="Positions"
      description={`${positions.length} positions · salary bands feed the Salary Insights benchmarks.`}
      action={
        <Button size="sm" onClick={openAdd} disabled={departments.length === 0}>
          <Plus className="mr-1.5 h-4 w-4" /> Add position
        </Button>
      }
    >
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Position</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Level</TableHead>
              <TableHead className="text-right">Salary band</TableHead>
              <TableHead className="text-right">Employees</TableHead>
              <TableHead className="w-[100px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((p) => {
              const count = countFor(p.id);
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.title}</TableCell>
                  <TableCell>{deptName(p.departmentId)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{p.level}</Badge>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {fmtRM(p.minSalary)} – {fmtRM(p.maxSalary)}
                  </TableCell>
                  <TableCell className="text-right">{count}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Edit ${p.title}`} onClick={() => openEdit(p)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${p.title}`}
                        disabled={count > 0}
                        title={count > 0 ? 'Reassign employees first' : 'Delete position'}
                        onClick={() => setDeleting(p)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 md:hidden">
        {positions.map((p) => {
          const count = countFor(p.id);
          return (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{p.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {deptName(p.departmentId)} · <span className="capitalize">{p.level}</span> · {count} employee{count === 1 ? '' : 's'}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {fmtRM(p.minSalary)} – {fmtRM(p.maxSalary)}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon" aria-label={`Edit ${p.title}`} onClick={() => openEdit(p)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${p.title}`}
                  disabled={count > 0}
                  onClick={() => setDeleting(p)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit position' : 'Add position'}</DialogTitle>
              <DialogDescription>Positions carry the salary band used by payroll sanity checks.</DialogDescription>
            </DialogHeader>
            <Field label="Position title">
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Software Engineer" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Department">
                <Select value={form.departmentId} onValueChange={(v) => setForm({ ...form, departmentId: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select department" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Level">
                <Select value={form.level} onValueChange={(v) => setForm({ ...form, level: v as PositionLevel })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POSITION_LEVELS.map((l) => (
                      <SelectItem key={l} value={l} className="capitalize">
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Min salary (RM / month)">
                <Input type="number" min={0} step={100} value={form.minSalary} onChange={(e) => setForm({ ...form, minSalary: e.target.value })} />
              </Field>
              <Field label="Max salary (RM / month)">
                <Input type="number" min={0} step={100} value={form.maxSalary} onChange={(e) => setForm({ ...form, maxSalary: e.target.value })} />
              </Field>
            </div>
            {rangeInvalid ? <p className="text-xs text-destructive">Minimum salary cannot exceed maximum salary.</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid}>
                {editing ? 'Save changes' : 'Add position'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.title}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the position permanently.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

export default function OrgSection() {
  const { items: employees } = useCollection<Employee>('employees');
  return (
    <div className="space-y-6">
      <DepartmentsCard employees={employees} />
      <PositionsCard employees={employees} />
    </div>
  );
}
