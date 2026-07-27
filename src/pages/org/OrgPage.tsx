/**
 * /org — Organization structure manager (Admin / HR).
 *
 * Departments: full CRUD with head (employee picker), cost-centre code and
 * colour (extras persist to the designer's departmentProfiles collection),
 * live employee counts, and a delete guard that blocks while staff are
 * assigned and offers reassignment to another department.
 *
 * Positions: full CRUD with grade (L1–L8), reporting line, dotted-line
 * co-manager, market-linked salary band, headcount budget vs actual, and a
 * rich job description (summary, responsibilities, qualifications) with a
 * printable JD sheet. Extras persist to positionProfiles — lib/types.ts is
 * untouched.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2, CircleAlert, FileText, GitBranch, Pencil, Plus, Search, Trash2, Users,
} from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import { useTenant } from '@/lib/tenantContext';
import { useAuthScope } from '@/pages/leave/useAuthScope';
import {
  activeEmployees,
  benchmarkForPosition,
  collectDescendants,
  deptColor,
  directReports,
  effectiveGrade,
  headcountByPosition,
  isVacant,
  removeDepartmentProfile,
  removePositionProfile,
  resolveReportsTo,
  useDepartmentProfiles,
  usePositionProfiles,
  vacancyCount,
  type PositionProfile,
} from '@/lib/orgChart';
import { fmtRM } from '@/lib/utils';
import type { Department, Employee, Position } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import DepartmentDialog, { type DepartmentFormValues } from './components/DepartmentDialog';
import PositionDialog from './components/PositionDialog';
import JdSheet from './components/JdSheet';
import { EMPTY_POSITION_FORM, valuesFromPosition, type PositionFormValues } from './components/positionFormShared';

const LEVEL_LABEL: Record<Position['level'], string> = {
  junior: 'Junior', senior: 'Senior', lead: 'Lead', manager: 'Manager', exec: 'Executive',
};

export default function OrgPage() {
  const auth = useAuthScope();
  const { activeCompany } = useTenant();
  const departments = useCollection<Department>('departments');
  const positions = useCollection<Position>('positions');
  const employees = useCollection<Employee>('employees');
  const profiles = usePositionProfiles();
  const deptProfiles = useDepartmentProfiles();

  const hqState = activeCompany?.hqState ?? 'KUL';
  const companyName = activeCompany?.name ?? 'Company';
  const showDottedLine = activeCompany?.config?.orgChart?.showDottedLineReports ?? true;

  // ── Derived data ──────────────────────────────────────────────────────────
  const active = useMemo(() => activeEmployees(employees.items), [employees.items]);
  const headcounts = useMemo(() => headcountByPosition(employees.items), [employees.items]);
  const parentMap = useMemo(
    () => resolveReportsTo(positions.items, profiles.items, employees.items, departments.items),
    [positions.items, profiles.items, employees.items, departments.items],
  );
  const profileOf = useMemo(() => {
    const map = new Map<string, PositionProfile>();
    profiles.items.forEach((p) => map.set(p.positionId, p));
    return map;
  }, [profiles.items]);
  const deptOf = useMemo(() => {
    const map = new Map<string, Department>();
    departments.items.forEach((d) => map.set(d.id, d));
    return map;
  }, [departments.items]);
  const empById = useMemo(() => {
    const map = new Map<string, Employee>();
    active.forEach((e) => map.set(e.id, e));
    return map;
  }, [active]);
  const countsByDept = useMemo(() => {
    const map = new Map<string, number>();
    active.forEach((e) => map.set(e.departmentId, (map.get(e.departmentId) ?? 0) + 1));
    return map;
  }, [active]);
  const positionsByDept = useMemo(() => {
    const map = new Map<string, number>();
    positions.items.forEach((p) => map.set(p.departmentId, (map.get(p.departmentId) ?? 0) + 1));
    return map;
  }, [positions.items]);
  const totalVacancies = useMemo(
    () => positions.items.reduce((sum, p) => sum + vacancyCount(profileOf.get(p.id), headcounts.get(p.id) ?? 0), 0),
    [positions.items, profileOf, headcounts],
  );

  // ── Department CRUD ───────────────────────────────────────────────────────
  const [deptDialog, setDeptDialog] = useState<{ open: boolean; editing?: Department }>({ open: false });
  const [deptDelete, setDeptDelete] = useState<Department | null>(null);
  const [reassignTarget, setReassignTarget] = useState<string>('');

  const saveDepartment = (values: DepartmentFormValues) => {
    const editing = deptDialog.editing;
    if (editing) {
      departments.update(editing.id, {
        name: values.name, code: values.code, state: values.state, headId: values.headId,
      });
      deptProfiles.upsert(editing.id, { costCenter: values.costCenter || undefined, color: values.color });
      logAudit({ actorName: auth.actor, action: 'org.department.update', entity: 'departments', entityId: editing.id, detail: values.name });
    } else {
      const created = departments.add({ name: values.name, code: values.code, state: values.state, headId: values.headId });
      deptProfiles.upsert(created.id, { costCenter: values.costCenter || undefined, color: values.color });
      logAudit({ actorName: auth.actor, action: 'org.department.create', entity: 'departments', entityId: created.id, detail: values.name });
    }
  };

  const confirmDeleteDepartment = () => {
    const dept = deptDelete;
    if (!dept) return;
    const staff = active.filter((e) => e.departmentId === dept.id);
    const deptPositions = positions.items.filter((p) => p.departmentId === dept.id);
    if ((staff.length > 0 || deptPositions.length > 0) && !reassignTarget) return;
    if (staff.length > 0 || deptPositions.length > 0) {
      staff.forEach((e) => employees.update(e.id, { departmentId: reassignTarget }));
      deptPositions.forEach((p) => positions.update(p.id, { departmentId: reassignTarget }));
    }
    departments.remove(dept.id);
    removeDepartmentProfile(dept.id);
    logAudit({
      actorName: auth.actor, action: 'org.department.delete', entity: 'departments', entityId: dept.id,
      detail: staff.length > 0 || deptPositions.length > 0
        ? `${dept.name} — ${staff.length} employee(s) + ${deptPositions.length} position(s) reassigned`
        : dept.name,
    });
    setDeptDelete(null);
    setReassignTarget('');
  };

  // ── Position CRUD ─────────────────────────────────────────────────────────
  const [posDialog, setPosDialog] = useState<{ open: boolean; editing?: Position }>({ open: false });
  const [posDelete, setPosDelete] = useState<Position | null>(null);
  const [jdPosition, setJdPosition] = useState<Position | null>(null);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('all');

  const savePosition = (values: PositionFormValues) => {
    const editing = posDialog.editing;
    const profilePatch = {
      grade: values.grade,
      reportsToPositionId: values.reportsToPositionId,
      dottedLineReportsToPositionId: values.dottedLineReportsToPositionId,
      jobDescription: values.jobDescription,
      responsibilities: values.responsibilities,
      qualifications: values.qualifications,
      headcountBudget: values.headcountBudget,
    };
    if (editing) {
      positions.update(editing.id, {
        title: values.title, departmentId: values.departmentId, level: values.level,
        minSalary: values.minSalary, maxSalary: values.maxSalary,
      });
      profiles.upsert(editing.id, profilePatch);
      logAudit({ actorName: auth.actor, action: 'org.position.update', entity: 'positions', entityId: editing.id, detail: values.title });
    } else {
      const created = positions.add({
        title: values.title, departmentId: values.departmentId, level: values.level,
        minSalary: values.minSalary, maxSalary: values.maxSalary,
      });
      profiles.upsert(created.id, profilePatch);
      logAudit({ actorName: auth.actor, action: 'org.position.create', entity: 'positions', entityId: created.id, detail: values.title });
    }
  };

  const deleteHolders = posDelete ? active.filter((e) => e.positionId === posDelete.id) : [];
  const deleteChildren = posDelete ? directReports(parentMap, posDelete.id) : [];
  const confirmDeletePosition = () => {
    const pos = posDelete;
    if (!pos || deleteHolders.length > 0) return;
    const parent = parentMap[pos.id] ?? null;
    deleteChildren.forEach((childId) => profiles.upsert(childId, { reportsToPositionId: parent }));
    positions.remove(pos.id);
    removePositionProfile(pos.id);
    logAudit({
      actorName: auth.actor, action: 'org.position.delete', entity: 'positions', entityId: pos.id,
      detail: deleteChildren.length > 0 ? `${pos.title} — ${deleteChildren.length} report(s) re-parented` : pos.title,
    });
    setPosDelete(null);
  };

  const filteredPositions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return positions.items
      .filter((p) => (deptFilter === 'all' ? true : p.departmentId === deptFilter))
      .filter((p) => (q ? p.title.toLowerCase().includes(q) : true))
      .sort((a, b) => {
        const d = (deptOf.get(a.departmentId)?.name ?? '').localeCompare(deptOf.get(b.departmentId)?.name ?? '');
        return d !== 0 ? d : a.title.localeCompare(b.title);
      });
  }, [positions.items, search, deptFilter, deptOf]);

  const editingExcluded = useMemo(() => {
    if (!posDialog.editing) return new Set<string>();
    return new Set([posDialog.editing.id, ...collectDescendants(parentMap, posDialog.editing.id)]);
  }, [posDialog.editing, parentMap]);

  const jdProfile = jdPosition ? profileOf.get(jdPosition.id) : undefined;
  const jdBenchmark = jdPosition
    ? benchmarkForPosition(jdPosition.title, jdPosition.level, hqState, deptOf.get(jdPosition.departmentId)?.name)
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Organization</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Departments, positions and job descriptions for {companyName}. Reporting lines feed the
            interactive org chart.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/org/chart">
            <GitBranch className="mr-1.5 h-4 w-4" /> Open org chart
          </Link>
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" /> Departments</CardDescription>
            <CardTitle className="text-2xl">{departments.items.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" /> Positions</CardDescription>
            <CardTitle className="text-2xl">{positions.items.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Active headcount</CardDescription>
            <CardTitle className="text-2xl">{active.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5"><CircleAlert className="h-3.5 w-3.5" /> Open vacancies</CardDescription>
            <CardTitle className="text-2xl">{totalVacancies}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Tabs defaultValue="departments">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="departments">Departments</TabsTrigger>
          <TabsTrigger value="positions">Positions & JDs</TabsTrigger>
        </TabsList>

        {/* ── Departments ─────────────────────────────────────────────── */}
        <TabsContent value="departments">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-lg">Departments</CardTitle>
                <CardDescription>Cost centres, heads and colours shown across the org chart.</CardDescription>
              </div>
              <Button onClick={() => setDeptDialog({ open: true })}>
                <Plus className="mr-1.5 h-4 w-4" /> Add department
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Department</TableHead>
                    <TableHead>Cost centre</TableHead>
                    <TableHead>Head</TableHead>
                    <TableHead className="text-center">Employees</TableHead>
                    <TableHead className="text-center">Positions</TableHead>
                    <TableHead className="w-24 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {departments.items.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                        No departments yet — create the first one to start the org structure.
                      </TableCell>
                    </TableRow>
                  )}
                  {departments.items.map((d) => {
                    const profile = deptProfiles.items.find((p) => p.departmentId === d.id);
                    const head = d.headId ? empById.get(d.headId) : undefined;
                    return (
                      <TableRow key={d.id}>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <span
                              className="h-3.5 w-3.5 shrink-0 rounded-full"
                              style={{ backgroundColor: deptColor(d.id, deptProfiles.items) }}
                            />
                            <div>
                              <p className="font-medium leading-tight">{d.name}</p>
                              <p className="text-xs text-muted-foreground">{d.code}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {profile?.costCenter ? <Badge variant="outline">{profile.costCenter}</Badge> : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm">{head?.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-center">{countsByDept.get(d.id) ?? 0}</TableCell>
                        <TableCell className="text-center">{positionsByDept.get(d.id) ?? 0}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={() => setDeptDialog({ open: true, editing: d })} aria-label={`Edit ${d.name}`}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost" size="icon"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => { setDeptDelete(d); setReassignTarget(''); }}
                              aria-label={`Delete ${d.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Positions ───────────────────────────────────────────────── */}
        <TabsContent value="positions">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-lg">Positions & job descriptions</CardTitle>
                <CardDescription>Grades, reporting lines, salary bands and headcount budgets.</CardDescription>
              </div>
              <Button onClick={() => setPosDialog({ open: true })} disabled={departments.items.length === 0}>
                <Plus className="mr-1.5 h-4 w-4" /> Add position
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <div className="relative min-w-56 flex-1">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles…" className="pl-8" />
                </div>
                <Select value={deptFilter} onValueChange={setDeptFilter}>
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All departments</SelectItem>
                    {departments.items.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Position</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Reports to</TableHead>
                    <TableHead>Headcount</TableHead>
                    <TableHead>Salary band</TableHead>
                    <TableHead className="w-32 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPositions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                        No positions match. Add one to build the reporting tree.
                      </TableCell>
                    </TableRow>
                  )}
                  {filteredPositions.map((p) => {
                    const profile = profileOf.get(p.id);
                    const dept = deptOf.get(p.departmentId);
                    const actual = headcounts.get(p.id) ?? 0;
                    const budget = profile?.headcountBudget;
                    const vacant = isVacant(profile, actual);
                    const parentTitle = parentMap[p.id] ? positions.items.find((x) => x.id === parentMap[p.id])?.title : null;
                    const pct = typeof budget === 'number' && budget > 0 ? Math.min(100, (actual / budget) * 100) : null;
                    return (
                      <TableRow key={p.id}>
                        <TableCell>
                          <p className="font-medium leading-tight">{p.title}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Badge variant="secondary" className="text-[11px]">{effectiveGrade(p, profile)}</Badge>
                            <Badge variant="outline" className="text-[11px]">{LEVEL_LABEL[p.level]}</Badge>
                            {vacant && (
                              <Badge className="border border-dashed border-amber-500 bg-amber-50 text-[11px] text-amber-800 hover:bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300">
                                Vacant ×{vacancyCount(profile, actual)}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 text-sm">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dept ? deptColor(dept.id, deptProfiles.items) : '#a8a29e' }} />
                            {dept?.name ?? '—'}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{parentTitle ?? <span className="text-muted-foreground">Root</span>}</TableCell>
                        <TableCell>
                          <div className="w-28">
                            <p className="text-sm">
                              {actual}{typeof budget === 'number' ? ` / ${budget}` : ''}
                            </p>
                            {pct !== null && <Progress value={pct} className="mt-1 h-1.5" />}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          {fmtRM(p.minSalary)} – {fmtRM(p.maxSalary)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={() => setJdPosition(p)} aria-label={`View JD for ${p.title}`} title="View printable JD">
                              <FileText className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => setPosDialog({ open: true, editing: p })} aria-label={`Edit ${p.title}`}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost" size="icon"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => setPosDelete(p)}
                              aria-label={`Delete ${p.title}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Department dialog ─────────────────────────────────────────── */}
      {deptDialog.open && (
        <DepartmentDialog
          key={deptDialog.editing?.id ?? 'new'}
          open={deptDialog.open}
          onOpenChange={(open) => setDeptDialog((s) => ({ ...s, open }))}
          department={deptDialog.editing}
          initialCostCenter={deptDialog.editing ? deptProfiles.items.find((p) => p.departmentId === deptDialog.editing!.id)?.costCenter : undefined}
          initialColor={deptDialog.editing ? deptColor(deptDialog.editing.id, deptProfiles.items) : undefined}
          employees={[...active].sort((a, b) => a.name.localeCompare(b.name))}
          existingCodes={departments.items.filter((d) => d.id !== deptDialog.editing?.id).map((d) => d.code.toUpperCase())}
          onSubmit={saveDepartment}
        />
      )}

      {/* ── Position dialog ───────────────────────────────────────────── */}
      {posDialog.open && (
        <PositionDialog
          key={posDialog.editing?.id ?? 'new'}
          open={posDialog.open}
          onOpenChange={(open) => setPosDialog((s) => ({ ...s, open }))}
          title={posDialog.editing ? `Edit — ${posDialog.editing.title}` : 'New position'}
          description="Base fields plus the job description used by the org chart and printable JD sheet."
          initial={posDialog.editing ? valuesFromPosition(posDialog.editing, profileOf.get(posDialog.editing.id)) : EMPTY_POSITION_FORM}
          positions={positions.items}
          departments={departments.items}
          excludedParentIds={editingExcluded}
          hqState={hqState}
          showDottedLine={showDottedLine}
          onSubmit={savePosition}
        />
      )}

      {/* ── Department delete / reassign ──────────────────────────────── */}
      <AlertDialog open={Boolean(deptDelete)} onOpenChange={(open) => { if (!open) setDeptDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deptDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {deptDelete && ((countsByDept.get(deptDelete.id) ?? 0) > 0 || (positionsByDept.get(deptDelete.id) ?? 0) > 0) ? (
                  <>
                    <p>
                      {countsByDept.get(deptDelete.id) ?? 0} employee(s) and {positionsByDept.get(deptDelete.id) ?? 0}{' '}
                      position(s) are still assigned to this department. Choose where they should move before
                      deleting.
                    </p>
                    <Select value={reassignTarget} onValueChange={setReassignTarget}>
                      <SelectTrigger>
                        <SelectValue placeholder="Reassign to…" />
                      </SelectTrigger>
                      <SelectContent>
                        {departments.items.filter((d) => d.id !== deptDelete.id).map((d) => (
                          <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : (
                  <p>This department is empty and can be removed safely. This action cannot be undone.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={
                Boolean(deptDelete) &&
                ((countsByDept.get(deptDelete!.id) ?? 0) > 0 || (positionsByDept.get(deptDelete!.id) ?? 0) > 0) &&
                !reassignTarget
              }
              onClick={confirmDeleteDepartment}
            >
              Delete department
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Position delete / re-parent ───────────────────────────────── */}
      <AlertDialog open={Boolean(posDelete)} onOpenChange={(open) => { if (!open) setPosDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteHolders.length > 0 ? `${posDelete?.title} is occupied` : `Delete ${posDelete?.title}?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {deleteHolders.length > 0 ? (
                  <p>
                    {deleteHolders.length} active employee(s) hold this position
                    ({deleteHolders.slice(0, 4).map((e) => e.name).join(', ')}
                    {deleteHolders.length > 4 ? ', …' : ''}). Reassign them to another position first —
                    deletion is blocked to protect payroll and leave records.
                  </p>
                ) : deleteChildren.length > 0 ? (
                  <p>
                    {deleteChildren.length} position(s) report to {posDelete?.title}. They will be moved under{' '}
                    <strong>
                      {parentMap[posDelete!.id]
                        ? positions.items.find((x) => x.id === parentMap[posDelete!.id])?.title
                        : 'the organisation root'}
                    </strong>{' '}
                    before deletion.
                  </p>
                ) : (
                  <p>This position is vacant and has no reports. This action cannot be undone.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{deleteHolders.length > 0 ? 'Got it' : 'Cancel'}</AlertDialogCancel>
            {deleteHolders.length === 0 && (
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={confirmDeletePosition}
              >
                Delete position
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Printable JD sheet ────────────────────────────────────────── */}
      {jdPosition && (
        <JdSheet
          open={Boolean(jdPosition)}
          onOpenChange={(open) => { if (!open) setJdPosition(null); }}
          position={jdPosition}
          profile={jdProfile}
          department={deptOf.get(jdPosition.departmentId)}
          reportsToTitle={parentMap[jdPosition.id] ? positions.items.find((x) => x.id === parentMap[jdPosition.id])?.title : undefined}
          benchmarkMedian={jdBenchmark?.median}
          companyName={companyName}
          actual={headcounts.get(jdPosition.id) ?? 0}
        />
      )}
    </div>
  );
}
