/**
 * KPI Library tab — KPI CRUD (per-employee KPI records) plus role template
 * packs that can be assigned to an employee in one click. Weight totals are
 * validated per employee + period (must equal 100%).
 */
import { useMemo, useState } from 'react';
import {
  LibraryBig, Pencil, Plus, Search, Trash2, Wand2, AlertTriangle,
} from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import type { Department, Employee, KPIStatus, Position } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import {
  KPI_CATEGORIES, TEMPLATE_PACKS, categoryBadge, weightTotal,
  type KpiCategory, type KpiExt, type TemplatePack,
} from './lib';
import {
  canManageKpiModule, checkWeightTotal,
} from '@/lib/kpiEngine';
import { useAuthSafe } from './useAuthSafe';

interface Props {
  employees: Employee[];
  departments: Department[];
  positions: Position[];
  kpis: KpiExt[];
}

interface KpiForm {
  employeeId: string;
  title: string;
  description: string;
  category: KpiCategory;
  unit: string;
  target: string;
  weight: number;
  period: string;
  status: KPIStatus;
}

const emptyForm = (period: string): KpiForm => ({
  employeeId: '',
  title: '',
  description: '',
  category: 'Process',
  unit: '',
  target: '',
  weight: 20,
  period,
  status: 'active',
});

export default function KpiLibrary({ employees, departments, positions, kpis }: Props) {
  const { add, update, remove } = useCollection<KpiExt>('kpis');
  const auth = useAuthSafe();
  const canManage = canManageKpiModule(auth);
  const activeEmps = useMemo(() => employees.filter((e) => e.status !== 'resigned'), [employees]);

  const [deptFilter, setDeptFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<KpiExt | null>(null);
  const [form, setForm] = useState<KpiForm>(emptyForm(`${new Date().getFullYear()}-H1`));
  const [deleting, setDeleting] = useState<KpiExt | null>(null);
  const [assignPack, setAssignPack] = useState<TemplatePack | null>(null);
  const [assignEmpId, setAssignEmpId] = useState('');
  const [assignPeriod, setAssignPeriod] = useState(`${new Date().getFullYear()}-H1`);

  const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? '—';
  const empDept = (id: string) => employees.find((e) => e.id === id)?.departmentId ?? '';
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? '—';
  const posTitle = (empId: string) => {
    const e = employees.find((x) => x.id === empId);
    return positions.find((p) => p.id === e?.positionId)?.title ?? '';
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return kpis.filter((k) => {
      if (deptFilter !== 'all' && empDept(k.employeeId) !== deptFilter) return false;
      if (!q) return true;
      return (
        k.title.toLowerCase().includes(q) ||
        empName(k.employeeId).toLowerCase().includes(q) ||
        (k.target ?? '').toLowerCase().includes(q)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kpis, deptFilter, query, employees]);

  const periods = useMemo(() => [...new Set(kpis.map((k) => k.period))].sort().reverse(), [kpis]);

  // Weight total for the employee+period currently in the form (live validation).
  // Excludes archived KPIs (same rule as the register badge and review page) and
  // counts the form weight only when the form status is not 'archived'.
  const formWeightTotal = useMemo(() => {
    const others = kpis.filter(
      (k) =>
        k.employeeId === form.employeeId &&
        k.period === form.period &&
        k.id !== editing?.id &&
        k.status !== 'archived',
    );
    return weightTotal(others) + (form.employeeId && form.status !== 'archived' ? form.weight : 0);
  }, [kpis, form.employeeId, form.period, form.weight, form.status, editing]);

  // Duplicate-title guard (same employee + period, case-insensitive).
  const duplicateTitle = useMemo(() => {
    const t = form.title.trim().toLowerCase();
    if (!t || !form.employeeId) return false;
    return kpis.some(
      (k) =>
        k.id !== editing?.id &&
        k.employeeId === form.employeeId &&
        k.period === form.period &&
        k.title.trim().toLowerCase() === t,
    );
  }, [kpis, form.title, form.employeeId, form.period, editing]);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm(periods[0] ?? `${new Date().getFullYear()}-H1`));
    setFormOpen(true);
  }

  function openEdit(k: KpiExt) {
    setEditing(k);
    setForm({
      employeeId: k.employeeId,
      title: k.title,
      description: k.description ?? '',
      category: k.category ?? 'Process',
      unit: k.unit ?? '',
      target: k.target,
      weight: k.weight,
      period: k.period,
      status: k.status,
    });
    setFormOpen(true);
  }

  function saveForm() {
    if (!form.employeeId || !form.title.trim()) return;
    // Unified weight validator: every CRUD write must land the employee's
    // non-archived KPIs for the period at exactly 100%.
    if (formWeightTotal !== 100) return;
    if (duplicateTitle) return;
    const payload = {
      employeeId: form.employeeId,
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      category: form.category,
      unit: form.unit.trim() || undefined,
      target: form.target.trim(),
      weight: form.weight,
      period: form.period.trim() || `${new Date().getFullYear()}-H1`,
      status: form.status,
    };
    if (editing) {
      // Never reassign employee / period on an existing KPI — that orphans
      // stored review scores which reference kpiId within a period scope.
      const { employeeId: _e, period: _p, ...rest } = payload;
      void _e; void _p;
      update(editing.id, rest);
      logAudit({ actorName: 'KPI module', action: 'kpi.update', entity: 'kpis', entityId: editing.id, detail: payload.title });
    } else {
      const created = add(payload);
      logAudit({ actorName: 'KPI module', action: 'kpi.create', entity: 'kpis', entityId: created.id, detail: payload.title });
    }
    setFormOpen(false);
  }

  function confirmDelete() {
    if (!deleting) return;
    remove(deleting.id);
    logAudit({ actorName: 'KPI module', action: 'kpi.delete', entity: 'kpis', entityId: deleting.id, detail: deleting.title });
    setDeleting(null);
  }

  // Live projection for the assign-pack dialog: which titles would be created
  // and where the employee's weight total lands afterwards.
  const packProjection = useMemo(() => {
    if (!assignPack || !assignEmpId) return null;
    const existing = kpis.filter(
      (k) => k.employeeId === assignEmpId && k.period === assignPeriod && k.status !== 'archived',
    );
    const fresh = assignPack.items.filter((it) => !existing.some((k) => k.title === it.title));
    const projected = weightTotal(existing) + weightTotal(fresh);
    return { existing, fresh, projected, check: checkWeightTotal([...existing, ...fresh.map((f) => ({ weight: f.weight, status: 'active' as const }))]) };
  }, [assignPack, assignEmpId, assignPeriod, kpis]);

  function applyPack() {
    if (!assignPack || !assignEmpId || !packProjection) return;
    // Unified weight validator: the pack must land the employee at exactly
    // 100% for the period (existing same-period KPIs included).
    if (packProjection.fresh.length === 0 || packProjection.projected !== 100) return;
    const periodValue = assignPeriod.trim() || `${new Date().getFullYear()}-H1`;
    packProjection.fresh.forEach((item) => {
      add({
        employeeId: assignEmpId,
        title: item.title,
        description: item.description,
        category: item.category,
        unit: item.unit,
        target: item.target,
        weight: item.weight,
        period: periodValue,
        status: 'active',
        templateKey: assignPack.key,
      });
    });
    logAudit({
      actorName: 'KPI module', action: 'kpi.assignPack', entity: 'kpis',
      detail: `${assignPack.label} → ${empName(assignEmpId)} (${packProjection.fresh.length} KPIs, ${periodValue})`,
    });
    setAssignPack(null);
    setAssignEmpId('');
  }

  const weightBadge = (empId: string, period: string) => {
    const total = weightTotal(kpis.filter((k) => k.employeeId === empId && k.period === period && k.status !== 'archived'));
    if (total === 100) return <Badge variant="secondary" className="border bg-lime-100 text-lime-800 border-lime-200">100%</Badge>;
    return (
      <Badge variant="secondary" className="border bg-orange-100 text-orange-800 border-orange-200">
        <AlertTriangle className="mr-1 h-3 w-3" /> {total}%
      </Badge>
    );
  };

  return (
    <div className="space-y-8">
      {/* ── Template packs ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-amber-600" />
          <h2 className="text-base font-semibold">Template packs by role</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATE_PACKS.map((pack) => (
            <Card key={pack.key} className="rounded-xl">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{pack.label}</CardTitle>
                <CardDescription>{pack.blurb}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-2">
                  {pack.items.map((item) => (
                    <li key={item.title} className="flex items-start justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium">{item.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {item.target} · {item.unit}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <Badge variant="outline" className={categoryBadge(item.category)}>{item.category}</Badge>
                        <Badge variant="secondary">{item.weight}%</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={!canManage}
                  onClick={() => {
                    setAssignPack(pack);
                    setAssignPeriod(periods[0] ?? `${new Date().getFullYear()}-H1`);
                  }}
                >
                  <Wand2 className="mr-1.5 h-3.5 w-3.5" /> Assign to employee
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ── KPI register ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <LibraryBig className="h-4 w-4 text-amber-600" />
            <h2 className="text-base font-semibold">KPI register</h2>
          </div>
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search KPI or employee…"
              className="pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Select value={deptFilter} onValueChange={setDeptFilter}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="Department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canManage && (
            <Button onClick={openAdd}>
              <Plus className="mr-1.5 h-4 w-4" /> New KPI
            </Button>
          )}
        </div>

        {filtered.length === 0 ? (
          <Empty className="rounded-xl border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><LibraryBig /></EmptyMedia>
              <EmptyTitle>No KPIs found</EmptyTitle>
              <EmptyDescription>
                {kpis.length === 0
                  ? 'Assign a template pack above or create a KPI to get started.'
                  : 'Try a different search or department filter.'}
              </EmptyDescription>
            </EmptyHeader>
            {kpis.length === 0 && canManage && (
              <Button onClick={openAdd}><Plus className="mr-1.5 h-4 w-4" /> New KPI</Button>
            )}
          </Empty>
        ) : (
          <>
            {/* md+ table */}
            <Card className="hidden rounded-xl md:block">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3 font-medium">KPI</th>
                      <th className="px-4 py-3 font-medium">Employee</th>
                      <th className="px-4 py-3 font-medium">Category</th>
                      <th className="px-4 py-3 font-medium">Target</th>
                      <th className="px-4 py-3 font-medium">Period</th>
                      <th className="px-4 py-3 font-medium">Weight</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((k) => (
                      <tr key={k.id} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="px-4 py-3">
                          <div className="font-medium">{k.title}</div>
                          {k.description && (
                            <div className="max-w-xs truncate text-xs text-muted-foreground">{k.description}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div>{empName(k.employeeId)}</div>
                          <div className="text-xs text-muted-foreground">{posTitle(k.employeeId)} · {deptName(empDept(k.employeeId))}</div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={categoryBadge(k.category)}>{k.category ?? 'Process'}</Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {k.target}{k.unit ? ` · ${k.unit}` : ''}
                        </td>
                        <td className="px-4 py-3">{k.period}</td>
                        <td className="px-4 py-3">{weightBadge(k.employeeId, k.period)}</td>
                        <td className="px-4 py-3">
                          <Badge variant={k.status === 'active' ? 'default' : 'secondary'} className="capitalize">{k.status}</Badge>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {canManage && (
                            <>
                              <Button variant="ghost" size="icon" onClick={() => openEdit(k)} aria-label="Edit KPI">
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" onClick={() => setDeleting(k)} aria-label="Delete KPI">
                                <Trash2 className="h-4 w-4 text-red-600" />
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* mobile cards */}
            <div className="space-y-3 md:hidden">
              {filtered.map((k) => (
                <Card key={k.id} className="rounded-xl">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium">{k.title}</div>
                        <div className="text-xs text-muted-foreground">{empName(k.employeeId)} · {deptName(empDept(k.employeeId))}</div>
                      </div>
                      <Badge variant="outline" className={categoryBadge(k.category)}>{k.category ?? 'Process'}</Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>Target: {k.target}</span>
                      <span>·</span><span>{k.period}</span>
                      <span>·</span><span className="capitalize">{k.status}</span>
                      {weightBadge(k.employeeId, k.period)}
                    </div>
                    <div className="flex justify-end gap-1">
                      {canManage && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(k)}>
                            <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleting(k)}>
                            <Trash2 className="mr-1 h-3.5 w-3.5 text-red-600" /> Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ── Add / edit dialog ──────────────────────────────────────────── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit KPI' : 'New KPI'}</DialogTitle>
            <DialogDescription>
              Weights per employee and period must total 100% before a review can be submitted.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="kpi-emp">Employee</Label>
              <Select value={form.employeeId} onValueChange={(v) => setForm({ ...form, employeeId: v })} disabled={!!editing}>
                <SelectTrigger id="kpi-emp"><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>
                  {activeEmps.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name} — {deptName(e.departmentId)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editing && (
                <p className="text-xs text-muted-foreground">
                  Employee and period are locked on edit so stored review scores stay linked.
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kpi-title">Title</Label>
              <Input id="kpi-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Revenue vs target" />
              {duplicateTitle && (
                <p className="text-xs text-orange-700">
                  A KPI with this title already exists for {empName(form.employeeId)} in {form.period}.
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kpi-desc">Description</Label>
              <Textarea id="kpi-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v as KpiCategory })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {KPI_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="kpi-unit">Unit</Label>
                <Input id="kpi-unit" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="RM, %, days…" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="kpi-target">Target</Label>
                <Input id="kpi-target" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="≤ 35 days" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="kpi-period">Period</Label>
                <Input id="kpi-period" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} placeholder="2026-H1" disabled={!!editing} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="kpi-weight">Weight (%)</Label>
                <Input
                  id="kpi-weight" type="number" min={0} max={100}
                  value={form.weight}
                  onChange={(e) => setForm({ ...form, weight: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as KPIStatus })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.employeeId && (
              <div
                className={
                  formWeightTotal === 100
                    ? 'rounded-lg border border-lime-200 bg-lime-50 px-3 py-2 text-xs text-lime-800'
                    : 'rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800'
                }
              >
                {formWeightTotal === 100
                  ? `Weights for ${empName(form.employeeId)} in ${form.period} will total 100%.`
                  : `Weights for ${empName(form.employeeId)} in ${form.period} will total ${formWeightTotal}% — saving is blocked until the total is exactly 100%.`}
                {formWeightTotal !== 100 && form.status !== 'archived' && (
                  <Button
                    variant="link"
                    size="sm"
                    className="ml-1 h-auto p-0 text-xs font-medium text-orange-900 underline"
                    onClick={() => {
                      const others = formWeightTotal - form.weight;
                      setForm({ ...form, weight: Math.max(0, Math.min(100, 100 - others)) });
                    }}
                  >
                    Auto-balance this KPI to {Math.max(0, Math.min(100, 100 - (formWeightTotal - form.weight)))}%
                  </Button>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button
              onClick={saveForm}
              disabled={!form.employeeId || !form.title.trim() || formWeightTotal !== 100 || duplicateTitle}
            >
              {editing ? 'Save changes' : 'Create KPI'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ─────────────────────────────────────────────── */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete KPI</AlertDialogTitle>
            <AlertDialogDescription>
              Remove “{deleting?.title}” for {deleting ? empName(deleting.employeeId) : ''}? Review scores that
              reference this KPI keep their stored values. After deletion the period's weight total will be{' '}
              {deleting
                ? weightTotal(kpis.filter((k) => k.employeeId === deleting.employeeId && k.period === deleting.period && k.status !== 'archived' && k.id !== deleting.id))
                : 0}% — rebalance the remaining KPIs back to 100%.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Assign template pack ───────────────────────────────────────── */}
      <Dialog open={!!assignPack} onOpenChange={(o) => !o && setAssignPack(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign “{assignPack?.label}” pack</DialogTitle>
            <DialogDescription>
              Creates {assignPack?.items.length ?? 0} KPIs (weights total {assignPack ? weightTotal(assignPack.items) : 0}%) for the selected employee. Existing titles are skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Employee</Label>
              <Select value={assignEmpId} onValueChange={setAssignEmpId}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>
                  {activeEmps.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name} — {deptName(e.departmentId)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pack-period">Period</Label>
              <Input id="pack-period" value={assignPeriod} onChange={(e) => setAssignPeriod(e.target.value)} placeholder="2026-H1" />
            </div>
            {packProjection && (
              <div
                className={
                  packProjection.projected === 100 && packProjection.fresh.length > 0
                    ? 'rounded-lg border border-lime-200 bg-lime-50 px-3 py-2 text-xs text-lime-800'
                    : 'rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800'
                }
              >
                {packProjection.fresh.length === 0
                  ? 'All pack titles already exist for this employee and period — nothing to add.'
                  : packProjection.projected === 100
                    ? `${packProjection.fresh.length} new KPI(s); existing titles are skipped. Weights will total exactly 100%.`
                    : `${packProjection.fresh.length} new KPI(s) would bring ${empName(assignEmpId)}'s ${assignPeriod} total to ${packProjection.projected}% (existing ${weightTotal(packProjection.existing)}% + pack ${weightTotal(packProjection.fresh)}%). Assignment is blocked — remove or rebalance the existing KPIs first.`}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignPack(null)}>Cancel</Button>
            <Button
              onClick={applyPack}
              disabled={!assignEmpId || !packProjection || packProjection.fresh.length === 0 || packProjection.projected !== 100}
            >
              Assign pack
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
