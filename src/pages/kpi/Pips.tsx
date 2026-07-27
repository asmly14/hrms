/**
 * PIPs tab — performance improvement plans. A PIP is usually triggered from a
 * 'Poor' rating (Outcomes tab) but can also be started manually here. Each
 * plan has improvement goals with due dates, dated check-in notes, and a
 * status flow: active → completed / cancelled.
 */
import { useMemo, useState } from 'react';
import {
  CalendarClock, CheckCircle2, ClipboardList, Plus, Send, XCircle,
} from 'lucide-react';
import { logAudit, uid } from '@/lib/db';
import { avatarTone, cn, fmtDate, initialsOf } from '@/lib/utils';
import type { Employee } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { canManagePip, usePips, type Pip, type PipGoal } from '@/lib/kpiEngine';
import { useAuthSafe } from './useAuthSafe';

interface Props {
  employees: Employee[];
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function statusBadge(s: Pip['status']): string {
  switch (s) {
    case 'active':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'completed':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'cancelled':
      return 'bg-stone-200 text-stone-700 border-stone-300';
  }
}

export default function Pips({ employees }: Props) {
  const { items: pips, add, update } = usePips();
  const auth = useAuthSafe();

  const [open, setOpen] = useState(false);
  const [empId, setEmpId] = useState('');
  const [endDate, setEndDate] = useState('');
  const [goalsText, setGoalsText] = useState('');
  const [detail, setDetail] = useState<Pip | null>(null);
  const [note, setNote] = useState('');

  const empOf = (id: string) => employees.find((e) => e.id === id);

  const visible = useMemo(() => {
    const sorted = [...pips].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!auth) return sorted;
    return auth.scopeByEmployee(sorted, (p) => p.employeeId);
  }, [pips, auth]);

  const employeeOptions = useMemo(() => {
    const active = employees.filter((e) => e.status !== 'resigned');
    const scoped = auth ? auth.scopeEmployees(active) : active;
    return scoped.filter((e) => canManagePip(auth, e.id));
  }, [employees, auth]);

  const goalProgress = (p: Pip) =>
    p.goals.length ? Math.round((p.goals.filter((g) => g.status === 'done').length / p.goals.length) * 100) : 0;

  function openCreate() {
    setEmpId(auth?.role === 'Employee' ? auth.employeeId ?? '' : '');
    const end = new Date();
    end.setDate(end.getDate() + 30);
    setEndDate(isoDate(end));
    setGoalsText('');
    setOpen(true);
  }

  function createPip() {
    if (!empId || !endDate) return;
    const goals: PipGoal[] = goalsText
      .split('\n')
      .map((g) => g.trim())
      .filter(Boolean)
      .map((title) => ({ id: uid(), title, dueDate: endDate, status: 'open' }));
    if (goals.length === 0) return;
    add({
      employeeId: empId,
      period: `${new Date().getFullYear()}-H1`,
      startDate: isoDate(new Date()),
      endDate,
      goals,
      notes: [],
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.pipCreate', entity: 'pips',
      detail: `PIP started for ${empOf(empId)?.name ?? empId} — ${goals.length} goals, due ${endDate}`,
    });
    setOpen(false);
  }

  function toggleGoal(p: Pip, goalId: string, done: boolean) {
    update(p.id, {
      goals: p.goals.map((g) => (g.id === goalId ? { ...g, status: done ? 'done' : 'open' } : g)),
    });
    // Keep the open detail dialog in sync with the store.
    setDetail((d) =>
      d && d.id === p.id
        ? { ...d, goals: d.goals.map((g) => (g.id === goalId ? { ...g, status: done ? 'done' : 'open' } : g)) }
        : d,
    );
  }

  function addNote() {
    if (!detail || !note.trim()) return;
    const authorName =
      (auth?.employeeId ? empOf(auth.employeeId)?.name : undefined) ?? auth?.user?.username ?? 'HR';
    const entry = { id: uid(), date: new Date().toISOString(), authorName, note: note.trim() };
    update(detail.id, { notes: [...detail.notes, entry] });
    setDetail({ ...detail, notes: [...detail.notes, entry] });
    setNote('');
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module', action: 'kpi.pipNote', entity: 'pips', entityId: detail.id,
      detail: `${authorName} · check-in on ${empOf(detail.employeeId)?.name ?? detail.employeeId}'s PIP`,
    });
  }

  function setStatus(p: Pip, status: Pip['status']) {
    update(p.id, { status });
    setDetail((d) => (d && d.id === p.id ? { ...d, status } : d));
    logAudit({
      actorName: auth?.user?.username ?? 'KPI module',
      action: status === 'completed' ? 'kpi.pipComplete' : 'kpi.pipCancel',
      entity: 'pips', entityId: p.id,
      detail: `${empOf(p.employeeId)?.name ?? p.employeeId} · PIP ${status}`,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-amber-600" />
          <h2 className="text-base font-semibold">Improvement plans</h2>
        </div>
        {employeeOptions.length > 0 && (
          <Button className="ml-auto" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" /> New PIP
          </Button>
        )}
      </div>

      {visible.length === 0 ? (
        <Empty className="rounded-xl border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ClipboardList /></EmptyMedia>
            <EmptyTitle>No improvement plans</EmptyTitle>
            <EmptyDescription>
              PIPs are started from a 'Poor' rating on the Outcomes tab, or manually here.
            </EmptyDescription>
          </EmptyHeader>
          {employeeOptions.length > 0 && (
            <Button onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" /> New PIP</Button>
          )}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {visible.map((p) => {
            const emp = empOf(p.employeeId);
            const pct = goalProgress(p);
            return (
              <Card key={p.id} className="rounded-xl">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(emp?.name ?? '?'))}>
                        {initialsOf(emp?.name ?? '?')}
                      </span>
                      <div>
                        <CardTitle className="text-base">{emp?.name ?? p.employeeId}</CardTitle>
                        <CardDescription>
                          {fmtDate(p.startDate)} → {fmtDate(p.endDate)} · {p.period}
                        </CardDescription>
                      </div>
                    </div>
                    <Badge variant="secondary" className={cn('border capitalize', statusBadge(p.status))}>{p.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Goals completed</span>
                      <span>{p.goals.filter((g) => g.status === 'done').length}/{p.goals.length}</span>
                    </div>
                    <Progress value={pct} className="h-2" />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <CalendarClock className="h-3.5 w-3.5" /> {p.notes.length} check-in note(s)
                    </span>
                    <Button variant="outline" size="sm" onClick={() => { setDetail(p); setNote(''); }}>
                      Open plan
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Create PIP dialog ──────────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New improvement plan</DialogTitle>
            <DialogDescription>Define measurable improvement goals and a review-by date.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Employee</Label>
              <Select value={empId} onValueChange={setEmpId}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>
                  {employeeOptions.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pip2-end">Review-by date</Label>
              <Input id="pip2-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pip2-goals">Improvement goals (one per line)</Label>
              <Textarea
                id="pip2-goals" rows={4} value={goalsText}
                onChange={(e) => setGoalsText(e.target.value)}
                placeholder={'e.g. Raise CSAT from 78% to ≥ 88%\nComplete service-excellence training'}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={createPip} disabled={!empId || !endDate || !goalsText.trim()}>Create PIP</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── PIP detail dialog ──────────────────────────────────────────── */}
      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) { setDetail(null); setNote(''); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <ClipboardList className="h-5 w-5 text-amber-600" />
                  {empOf(detail.employeeId)?.name ?? detail.employeeId}
                  <Badge variant="secondary" className={cn('border capitalize', statusBadge(detail.status))}>{detail.status}</Badge>
                </DialogTitle>
                <DialogDescription>
                  {fmtDate(detail.startDate)} → {fmtDate(detail.endDate)} · started from {detail.period}
                  {detail.reviewId ? ' review' : ' manual entry'}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Goals</Label>
                  {detail.goals.map((g) => (
                    <div key={g.id} className="flex items-start gap-2.5 rounded-lg border px-3 py-2.5">
                      <Checkbox
                        checked={g.status === 'done'}
                        disabled={detail.status !== 'active' || !canManagePip(auth, detail.employeeId)}
                        onCheckedChange={(v) => toggleGoal(detail, g.id, v === true)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className={cn('text-sm', g.status === 'done' && 'text-muted-foreground line-through')}>
                          {g.title}
                        </div>
                        <div className="text-xs text-muted-foreground">due {fmtDate(g.dueDate)}</div>
                      </div>
                      {g.status === 'done' && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />}
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Check-in notes</Label>
                  {detail.notes.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                      No check-ins recorded yet.
                    </p>
                  ) : (
                    detail.notes.map((n) => (
                      <div key={n.id} className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{n.authorName}</span>
                          <span>{fmtDate(n.date)}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{n.note}</p>
                      </div>
                    ))
                  )}
                  {detail.status === 'active' && canManagePip(auth, detail.employeeId) && (
                    <div className="flex items-start gap-2">
                      <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a dated check-in note…" />
                      <Button size="icon" onClick={addNote} disabled={!note.trim()} aria-label="Add note">
                        <Send className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {detail.status === 'active' && canManagePip(auth, detail.employeeId) && (
                <DialogFooter className="gap-2">
                  <Button variant="outline" onClick={() => setStatus(detail, 'cancelled')}>
                    <XCircle className="mr-1 h-4 w-4" /> Cancel plan
                  </Button>
                  <Button onClick={() => setStatus(detail, 'completed')}>
                    <CheckCircle2 className="mr-1 h-4 w-4" /> Mark completed
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
