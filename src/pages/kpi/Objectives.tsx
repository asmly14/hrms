/**
 * Objectives tab — OKR mode. Objectives carry measurable key results
 * (target / current / unit) with automatic progress roll-up, and can cascade:
 * a parent objective (company / department level) links to child objectives,
 * shown as a tree grouped by department.
 *
 * Classic weighted KPIs still live in the KPI Library; objectives complement
 * them for outcome-focused goal setting.
 */
import { useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, CornerDownRight, Pencil, Plus, Target, Trash2,
} from 'lucide-react';
import { logAudit, uid } from '@/lib/db';
import { avatarTone, cn, initialsOf } from '@/lib/utils';
import type { Department, Employee } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import {
  childObjectives, krProgress, objectiveProgress, useObjectives,
  type KeyResult, type Objective,
} from '@/lib/kpiEngine';
import { useAuthSafe } from './useAuthSafe';

interface Props {
  employees: Employee[];
  departments: Department[];
}

interface KrForm {
  id: string;
  title: string;
  target: string;
  current: string;
  unit: string;
}

interface ObjectiveForm {
  employeeId: string;
  period: string;
  title: string;
  description: string;
  parentId: string; // '' = root objective
  krs: KrForm[];
}

const emptyKr = (): KrForm => ({ id: uid(), title: '', target: '', current: '0', unit: '' });

const defaultPeriod = () => `${new Date().getFullYear()}-H1`;

function progressTone(pct: number): string {
  if (pct >= 80) return 'text-emerald-700';
  if (pct >= 50) return 'text-lime-700';
  if (pct >= 25) return 'text-amber-700';
  return 'text-stone-600';
}

export default function Objectives({ employees, departments }: Props) {
  const { items: objectives, add, update } = useObjectives();
  const auth = useAuthSafe();

  const [period, setPeriod] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Objective | null>(null);
  const [form, setForm] = useState<ObjectiveForm>({
    employeeId: '', period: defaultPeriod(), title: '', description: '', parentId: '', krs: [emptyKr()],
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const empOf = (id: string) => employees.find((e) => e.id === id);
  const deptName = (id?: string) => departments.find((d) => d.id === id)?.name ?? '—';

  /** Objectives the current user may see (fail-open pre-integration). */
  const visible = useMemo(() => {
    if (!auth) return objectives;
    return auth.scopeByEmployee(objectives, (o) => o.employeeId);
  }, [objectives, auth]);

  const periods = useMemo(
    () => [...new Set(visible.map((o) => o.period))].sort().reverse(),
    [visible],
  );
  const activePeriod = period || periods[0] || defaultPeriod();

  const inPeriod = useMemo(
    () => visible.filter((o) => o.period === activePeriod && o.status !== 'cancelled'),
    [visible, activePeriod],
  );

  /** Objective owner, their manager/HR may edit; Admin/HR edit all. */
  function canEdit(o: Objective): boolean {
    if (!auth) return true;
    if (auth.role === 'Admin' || auth.role === 'HR') return true;
    return auth.employeeId === o.employeeId || auth.canViewEmployee(o.employeeId);
  }

  const canCreate = !auth || auth.role !== 'Employee' || !!auth.employeeId;

  function openAdd(parentId = '') {
    setEditing(null);
    setForm({
      employeeId: auth?.employeeId ?? '',
      period: activePeriod,
      title: '', description: '', parentId, krs: [emptyKr()],
    });
    setFormOpen(true);
  }

  function openEdit(o: Objective) {
    setEditing(o);
    setForm({
      employeeId: o.employeeId,
      period: o.period,
      title: o.title,
      description: o.description ?? '',
      parentId: o.parentId ?? '',
      krs: o.keyResults.map((kr) => ({
        id: kr.id, title: kr.title, target: String(kr.target), current: String(kr.current), unit: kr.unit ?? '',
      })),
    });
    setFormOpen(true);
  }

  function saveForm() {
    if (!form.employeeId || !form.title.trim()) return;
    const krs: KeyResult[] = form.krs
      .filter((k) => k.title.trim())
      .map((k) => ({
        id: k.id,
        title: k.title.trim(),
        target: Math.max(0, Number(k.target) || 0),
        current: Math.max(0, Number(k.current) || 0),
        unit: k.unit.trim() || undefined,
      }));
    if (krs.length === 0) return;
    const payload = {
      employeeId: form.employeeId,
      departmentId: empOf(form.employeeId)?.departmentId,
      period: form.period.trim() || defaultPeriod(),
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      parentId: form.parentId || undefined,
      keyResults: krs,
    };
    if (editing) {
      update(editing.id, payload);
      logAudit({ actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.objectiveUpdate', entity: 'objectives', entityId: editing.id, detail: payload.title });
    } else {
      const created = add({ ...payload, status: 'active', createdAt: new Date().toISOString() });
      logAudit({ actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.objectiveCreate', entity: 'objectives', entityId: created.id, detail: payload.title });
    }
    setFormOpen(false);
  }

  function setStatus(o: Objective, status: Objective['status']) {
    update(o.id, { status });
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module', action: `kpi.objective${status === 'completed' ? 'Complete' : 'Cancel'}`,
      entity: 'objectives', entityId: o.id, detail: o.title,
    });
  }

  /** Quick KR check-in: bump the current value of one key result. */
  function bumpKr(o: Objective, krId: string, value: number) {
    update(o.id, {
      keyResults: o.keyResults.map((kr) => (kr.id === krId ? { ...kr, current: Math.max(0, value) } : kr)),
    });
  }

  // ── Cascade tree: roots (no parent) with nested children, grouped by dept ──
  const roots = inPeriod.filter((o) => !o.parentId || !inPeriod.some((p) => p.id === o.parentId));
  const rootsByDept = useMemo(() => {
    const m = new Map<string, Objective[]>();
    roots.forEach((o) => {
      const dept = o.departmentId ?? empOf(o.employeeId)?.departmentId ?? '';
      m.set(dept, [...(m.get(dept) ?? []), o]);
    });
    return [...m.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inPeriod]);

  function KrList({ o }: { o: Objective }) {
    const editable = canEdit(o) && o.status === 'active';
    return (
      <ul className="space-y-2">
        {o.keyResults.map((kr) => {
          const pct = krProgress(kr);
          return (
            <li key={kr.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{kr.title}</span>
                <span className={cn('shrink-0 text-xs font-semibold', progressTone(pct))}>{pct}%</span>
              </div>
              <div className="flex items-center gap-2">
                <Progress value={pct} className="h-1.5 flex-1" />
                {editable ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Input
                      type="number"
                      className="h-7 w-20 px-1.5 text-right text-xs"
                      value={kr.current}
                      onChange={(e) => bumpKr(o, kr.id, Number(e.target.value) || 0)}
                      aria-label={`Current value for ${kr.title}`}
                    />
                    / {kr.target}{kr.unit ? ` ${kr.unit}` : ''}
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {kr.current} / {kr.target}{kr.unit ? ` ${kr.unit}` : ''}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  function ObjectiveCard({ o, depth = 0 }: { o: Objective; depth?: number }) {
    const pct = objectiveProgress(o);
    const emp = empOf(o.employeeId);
    const kids = childObjectives(inPeriod, o.id);
    const isCollapsed = collapsed[o.id];
    return (
      <div className={cn('space-y-2', depth > 0 && 'ml-4 border-l-2 border-amber-200 pl-3 sm:ml-6 sm:pl-4')}>
        <Card className={cn('rounded-xl', o.status === 'completed' && 'opacity-70')}>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start gap-2.5">
              {depth > 0 && <CornerDownRight className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />}
              <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(emp?.name ?? '?'))}>
                {initialsOf(emp?.name ?? '?')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{o.title}</span>
                  {o.status === 'completed' && <Badge variant="secondary" className="border bg-emerald-100 text-emerald-800 border-emerald-200">Done</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {emp?.name ?? o.employeeId} · {deptName(o.departmentId ?? emp?.departmentId)} · {o.period}
                </div>
              </div>
              <span className={cn('text-sm font-semibold', progressTone(pct))}>{pct}%</span>
            </div>
            {o.description && <p className="text-xs text-muted-foreground">{o.description}</p>}
            <KrList o={o} />
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {canEdit(o) && o.status === 'active' && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(o)}>
                    <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setStatus(o, 'completed')}>Mark done</Button>
                  <Button variant="ghost" size="sm" onClick={() => setStatus(o, 'cancelled')}>Cancel</Button>
                </>
              )}
              {canEdit(o) && (
                <Button variant="ghost" size="sm" onClick={() => openAdd(o.id)}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Cascade
                </Button>
              )}
              {kids.length > 0 && (
                <Button
                  variant="ghost" size="sm" className="ml-auto"
                  onClick={() => setCollapsed((c) => ({ ...c, [o.id]: !c[o.id] }))}
                >
                  {isCollapsed ? <ChevronRight className="mr-1 h-3.5 w-3.5" /> : <ChevronDown className="mr-1 h-3.5 w-3.5" />}
                  {kids.length} aligned
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
        {!isCollapsed && kids.map((k) => <ObjectiveCard key={k.id} o={k} depth={depth + 1} />)}
      </div>
    );
  }

  /** Employee options for the form: self for Employee role, scope for others. */
  const employeeOptions = useMemo(() => {
    const active = employees.filter((e) => e.status !== 'resigned');
    if (!auth) return active;
    return auth.scopeEmployees(active);
  }, [employees, auth]);

  /** Parent options: any visible objective in the same period (not self). */
  const parentOptions = inPeriod.filter((o) => o.id !== editing?.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-amber-600" />
          <h2 className="text-base font-semibold">Objectives &amp; key results</h2>
        </div>
        <Select value={activePeriod} onValueChange={setPeriod}>
          <SelectTrigger className="ml-auto w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[...new Set([defaultPeriod(), ...periods])].map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canCreate && (
          <Button onClick={() => openAdd()}>
            <Plus className="mr-1.5 h-4 w-4" /> New objective
          </Button>
        )}
      </div>

      {inPeriod.length === 0 ? (
        <Empty className="rounded-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Target /></EmptyMedia>
            <EmptyTitle>No objectives for {activePeriod}</EmptyTitle>
            <EmptyDescription>
              Create an objective with measurable key results, then cascade it down the org.
            </EmptyDescription>
          </EmptyHeader>
          {canCreate && (
            <Button onClick={() => openAdd()}><Plus className="mr-1.5 h-4 w-4" /> New objective</Button>
          )}
        </Empty>
      ) : (
        <div className="space-y-6">
          {rootsByDept.map(([deptId, list]) => (
            <section key={deptId || 'none'} className="space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground">{deptName(deptId)}</h3>
              {list.map((o) => <ObjectiveCard key={o.id} o={o} />)}
            </section>
          ))}
        </div>
      )}

      {/* ── Add / edit objective dialog ────────────────────────────────── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit objective' : 'New objective'}</DialogTitle>
            <DialogDescription>
              An objective needs at least one measurable key result. Progress rolls up automatically from KR actuals.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Owner</Label>
                <Select value={form.employeeId} onValueChange={(v) => setForm({ ...form, employeeId: v })} disabled={!!editing}>
                  <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                  <SelectContent>
                    {employeeOptions.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name} — {deptName(e.departmentId)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="obj-period">Period</Label>
                <Input id="obj-period" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="obj-title">Objective</Label>
              <Input id="obj-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Delight our enterprise customers" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="obj-desc">Description (optional)</Label>
              <Textarea id="obj-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>Aligned to parent objective (cascade)</Label>
              <Select value={form.parentId || 'none'} onValueChange={(v) => setForm({ ...form, parentId: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue placeholder="None — root objective" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None — root objective</SelectItem>
                  {parentOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.title} ({empOf(o.employeeId)?.name ?? o.employeeId})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Key results</Label>
                <Button variant="outline" size="sm" onClick={() => setForm({ ...form, krs: [...form.krs, emptyKr()] })}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add KR
                </Button>
              </div>
              {form.krs.map((kr, idx) => (
                <div key={kr.id} className="grid grid-cols-[1fr_5rem_5rem_4.5rem_2rem] items-center gap-2">
                  <Input
                    value={kr.title}
                    onChange={(e) => setForm({ ...form, krs: form.krs.map((x) => (x.id === kr.id ? { ...x, title: e.target.value } : x)) })}
                    placeholder={`Key result ${idx + 1}`}
                  />
                  <Input
                    type="number" value={kr.target} placeholder="Target"
                    onChange={(e) => setForm({ ...form, krs: form.krs.map((x) => (x.id === kr.id ? { ...x, target: e.target.value } : x)) })}
                  />
                  <Input
                    type="number" value={kr.current} placeholder="Current"
                    onChange={(e) => setForm({ ...form, krs: form.krs.map((x) => (x.id === kr.id ? { ...x, current: e.target.value } : x)) })}
                  />
                  <Input
                    value={kr.unit} placeholder="Unit"
                    onChange={(e) => setForm({ ...form, krs: form.krs.map((x) => (x.id === kr.id ? { ...x, unit: e.target.value } : x)) })}
                  />
                  <Button
                    variant="ghost" size="icon"
                    disabled={form.krs.length <= 1}
                    onClick={() => setForm({ ...form, krs: form.krs.filter((x) => x.id !== kr.id) })}
                    aria-label="Remove key result"
                  >
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">Columns: title · target · current · unit.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button
              onClick={saveForm}
              disabled={!form.employeeId || !form.title.trim() || !form.krs.some((k) => k.title.trim())}
            >
              {editing ? 'Save changes' : 'Create objective'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
