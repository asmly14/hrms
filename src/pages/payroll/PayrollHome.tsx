/**
 * Payroll home — run history + 'Run Payroll' wizard + EA form entry point.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ChevronRight, FileText, Landmark, Play, RefreshCw, Users, Wallet,
} from 'lucide-react';
import { useCollection } from '@/lib/db';
import { useRole } from '@/lib/roleContext';
import { useAuthSafe } from './useAuthSafe';
import { runPayroll } from '@/lib/payrollEngine';
import { fmtDate, fmtRM } from '@/lib/utils';
import type { Employee, PayrollRun, Payslip, Settings as CompanySettings } from '@/lib/types';
import { monthLabel } from './helpers';
import RunPayrollWizard from './RunPayrollWizard';
import EAFormDialog from './EAForm';
import { Money } from './components';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

export default function PayrollHome() {
  const navigate = useNavigate();
  const { role: stubRole } = useRole();
  const auth = useAuthSafe();
  // Session role wins for audit attribution; dev stub only pre-login demos.
  const role = auth?.role ?? stubRole;
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');
  const { items: employees } = useCollection<Employee>('employees');
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { items: settingsItems } = useCollection<CompanySettings>('settings');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [eaOpen, setEaOpen] = useState(false);
  const [rerunTarget, setRerunTarget] = useState<PayrollRun | null>(null);

  const sorted = useMemo(
    () =>
      [...runs].sort(
        (a, b) => b.monthKey.localeCompare(a.monthKey) || b.runAt.localeCompare(a.runAt),
      ),
    [runs],
  );

  // B12 — seed data loads asynchronously on first launch, but an empty
  // employees collection can also be real (e.g. after a settings reset).
  // Show skeletons only while the seed plausibly hasn't landed yet: settings
  // still empty AND within a short grace window. After that, show the empty
  // state instead of perpetual skeletons.
  const [graceExpired, setGraceExpired] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGraceExpired(true), 1500);
    return () => clearTimeout(t);
  }, []);
  const loading =
    employees.length === 0 && settingsItems.length === 0 && !graceExpired;

  // B5 — re-run scope = the employees covered by the original run (never
  // `undefined`, which would silently widen to ALL eligible employees).
  const rerunIds = useMemo(() => {
    if (!rerunTarget) return [];
    return [...new Set(
      payslips.filter((p) => p.runId === rerunTarget.id).map((p) => p.employeeId),
    )];
  }, [rerunTarget, payslips]);

  const confirmRerun = () => {
    if (!rerunTarget) return;
    const res = runPayroll(
      rerunTarget.monthKey,
      rerunIds.length > 0 ? rerunIds : undefined,
      role,
    );
    setRerunTarget(null);
    navigate(`/payroll/runs/${res.run.id}`);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Wallet className="h-6 w-6 text-amber-600" /> Payroll
          </h1>
          <p className="text-sm text-muted-foreground">
            Monthly payroll runs with EPF, SOCSO, EIS, PCB and HRD levy — computed by the statutory engine.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setEaOpen(true)}>
            <FileText className="h-4 w-4" /> EA form
          </Button>
          <Button onClick={() => setWizardOpen(true)}>
            <Play className="h-4 w-4" /> Run payroll
          </Button>
        </div>
      </div>

      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Run history</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : employees.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50">
                <Users className="h-6 w-6" />
              </span>
              <div>
                <p className="font-medium">No employees on file</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Payroll needs at least one employee record. Add employees first,
                  then run your first payroll.
                </p>
              </div>
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50">
                <Landmark className="h-6 w-6" />
              </span>
              <div>
                <p className="font-medium">No payroll runs yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Run your first payroll to generate itemized payslips and statutory outputs.
                </p>
              </div>
              <Button onClick={() => setWizardOpen(true)}>
                <Play className="h-4 w-4" /> Run payroll
              </Button>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead>Run at</TableHead>
                      <TableHead className="text-right">Employees</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                      <TableHead className="text-right">Employer cost</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">
                          <Link
                            to={`/payroll/runs/${r.id}`}
                            className="text-amber-700 underline-offset-4 hover:underline dark:text-amber-500"
                          >
                            {monthLabel(r.monthKey)}
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{fmtDate(r.runAt)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.employeeCount}</TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(r.totalGross)}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(r.totalNet)}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(r.totalEmployerCost)}</Money></TableCell>
                        <TableCell>
                          <Badge variant={r.status === 'finalized' ? 'secondary' : 'outline'}>
                            {r.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Re-run this month"
                              onClick={() => setRerunTarget(r)}
                            >
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" asChild>
                              <Link to={`/payroll/runs/${r.id}`}>
                                <ChevronRight className="h-4 w-4" />
                              </Link>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile cards */}
              <div className="space-y-3 md:hidden">
                {sorted.map((r) => (
                  <div key={r.id} className="rounded-xl border p-4">
                    <div className="flex items-center justify-between">
                      <Link
                        to={`/payroll/runs/${r.id}`}
                        className="font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-500"
                      >
                        {monthLabel(r.monthKey)}
                      </Link>
                      <Badge variant={r.status === 'finalized' ? 'secondary' : 'outline'}>
                        {r.status}
                      </Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">Employees</dt>
                        <dd className="tabular-nums">{r.employeeCount}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Run at</dt>
                        <dd>{fmtDate(r.runAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Net pay</dt>
                        <dd className="tabular-nums">{fmtRM(r.totalNet)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Employer cost</dt>
                        <dd className="tabular-nums">{fmtRM(r.totalEmployerCost)}</dd>
                      </div>
                    </dl>
                    <div className="mt-3 flex gap-2">
                      <Button variant="outline" size="sm" className="flex-1" onClick={() => setRerunTarget(r)}>
                        <RefreshCw className="h-4 w-4" /> Re-run
                      </Button>
                      <Button variant="outline" size="sm" className="flex-1" asChild>
                        <Link to={`/payroll/runs/${r.id}`}>View</Link>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* B5 — destructive re-run confirmation: payslips are replaced and
          approved claims are re-pointed to the new run. */}
      <AlertDialog open={rerunTarget !== null} onOpenChange={(o) => !o && setRerunTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Re-run {rerunTarget ? monthLabel(rerunTarget.monthKey) : ''} payroll?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This replaces the existing payslips for the{' '}
                  <strong>{rerunIds.length || rerunTarget?.employeeCount} employee(s)</strong>{' '}
                  covered by this run — the same scope as the original run, not the whole company.
                </p>
                <p>
                  Approved claims already marked as paid in this run will be re-pointed to the
                  new run. To pay a different set of employees, cancel and use{' '}
                  <strong>Run payroll</strong> instead — running a wider scope replaces more
                  payslips.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRerun}>
              <RefreshCw className="h-4 w-4" /> Re-run payroll
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RunPayrollWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCompleted={(runId) => navigate(`/payroll/runs/${runId}`)}
      />
      <EAFormDialog open={eaOpen} onOpenChange={setEaOpen} />
    </div>
  );
}
