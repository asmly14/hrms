/**
 * Batch payslip distribution (/payroll/batch-payslips) — per FINALIZED run:
 *
 *  - employee checklist (all selected by default);
 *  - "Download all as PDF" — ONE multi-page A4 PDF generated client-side via
 *    jsPDF (dynamically imported, so the parser cost only lands on export),
 *    1 employee per page, rendering the same itemized layout as PayslipPage
 *    (company header, earnings / deductions / reimbursements, employer box,
 *    YTD, refNo);
 *  - "Mark as distributed" per employee per run, persisted on
 *    `payslip.distributedAt`, with a progress bar and completion toasts.
 *
 * Draft runs are never offered: payslips are official only once finalized.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, BadgeCheck, CheckSquare, FileDown, Loader2, Receipt, Send, Square,
  Undo2, Users, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCollection } from '@/lib/db';
import { distributionProgress, downloadPayslipsPdf } from '@/lib/yearEnd';
import { fmtDate, fmtRM } from '@/lib/utils';
import type {
  Department, Employee, PayrollRun, Payslip, Position, Settings as CompanySettings,
} from '@/lib/types';
import { empById, monthLabel } from './helpers';
import { Money } from './components';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

export default function BatchPayslips() {
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');
  const { items: payslips, update: updatePayslip } = useCollection<Payslip>('payslips');
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');
  const { items: settingsItems } = useCollection<CompanySettings>('settings');

  const finalizedRuns = useMemo(
    () =>
      runs
        .filter((r) => r.status === 'finalized')
        .sort(
          (a, b) =>
            b.monthKey.localeCompare(a.monthKey) ||
            (b.finalizedAt ?? b.runAt).localeCompare(a.finalizedAt ?? a.runAt),
        ),
    [runs],
  );

  const [runId, setRunId] = useState<string>('');
  const run = finalizedRuns.find((r) => r.id === runId) ?? finalizedRuns[0];

  const empMap = useMemo(() => empById(employees), [employees]);

  /** The selected run's payslips, employee-name sorted. */
  const slips = useMemo(() => {
    if (!run) return [];
    return payslips
      .filter((p) => p.runId === run.id)
      .sort((a, b) => {
        const an = empMap.get(a.employeeId)?.name ?? a.employeeId;
        const bn = empMap.get(b.employeeId)?.name ?? b.employeeId;
        return an.localeCompare(bn) || a.id.localeCompare(b.id);
      });
  }, [run, payslips, empMap]);

  // Employee checklist — all selected by default; reset when the run changes.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set(slips.map((p) => p.id)));
  }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- reset per run only

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const progress = useMemo(() => distributionProgress(slips), [slips]);
  const selectedSlips = useMemo(
    () => slips.filter((p) => selected.has(p.id)),
    [slips, selected],
  );

  const [generating, setGenerating] = useState(false);

  const handleDownloadPdf = async () => {
    if (!run || selectedSlips.length === 0 || generating) return;
    setGenerating(true);
    try {
      const result = await downloadPayslipsPdf({
        run,
        slips: selectedSlips,
        employees,
        departments,
        positions,
        settings: settingsItems[0],
      });
      toast.success('Payslip PDF ready', {
        description: `${result.pageCount} payslip(s), 1 employee per page → ${result.fileName}`,
      });
    } catch (err) {
      toast.error('PDF generation failed', {
        description: err instanceof Error ? err.message : 'Unknown error — please try again.',
      });
    } finally {
      setGenerating(false);
    }
  };

  const markDistributed = (targets: Payslip[], distributed: boolean) => {
    const stamp = new Date().toISOString();
    let changed = 0;
    for (const p of targets) {
      const already = !!p.distributedAt;
      if (distributed === already) continue;
      updatePayslip(p.id, distributed ? { distributedAt: stamp } : { distributedAt: undefined });
      changed += 1;
    }
    if (changed === 0) {
      toast.info(distributed ? 'Already marked as distributed' : 'Nothing to unmark');
      return;
    }
    toast.success(
      distributed ? 'Marked as distributed' : 'Distribution mark removed',
      {
        description: `${changed} payslip(s) for ${run ? monthLabel(run.monthKey) : ''} ${
          distributed ? `stamped ${fmtDate(stamp)}` : 'reset to pending'
        }.`,
      },
    );
  };

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Send className="h-6 w-6 text-amber-600" /> Batch payslip distribution
          </h1>
          <p className="text-sm text-muted-foreground">
            Export a finalized run's payslips as one multi-page PDF and track who has
            received theirs — EA 1955 s.25A itemized statements.
          </p>
        </div>
        <Button variant="ghost" size="sm" className="-ml-2" asChild>
          <Link to="/payroll">
            <ArrowLeft className="h-4 w-4" /> Payroll
          </Link>
        </Button>
      </div>

      {finalizedRuns.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent>
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50">
                <Wallet className="h-6 w-6" />
              </span>
              <div>
                <p className="font-medium">No finalized payroll runs yet</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Payslips become official only when a run is finalized. Run and finalize a
                  payroll month first, then come back to distribute its payslips.
                </p>
              </div>
              <Button variant="outline" asChild>
                <Link to="/payroll">Go to payroll</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── Run picker + distribution progress ───────────────────── */}
          <Card className="rounded-xl">
            <CardContent className="flex flex-wrap items-center gap-4 pt-6">
              <Select value={run?.id ?? ''} onValueChange={setRunId}>
                <SelectTrigger className="w-72">
                  <SelectValue placeholder="Select a finalized run…" />
                </SelectTrigger>
                <SelectContent>
                  {finalizedRuns.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {monthLabel(r.monthKey)} · {r.employeeCount} employee(s) · finalized{' '}
                      {fmtDate(r.finalizedAt ?? r.runAt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="min-w-56 flex-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {progress.distributed} of {progress.total} distributed
                  </span>
                  <span className="tabular-nums text-muted-foreground">{progress.percent}%</span>
                </div>
                <Progress value={progress.percent} className="mt-2" />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {progress.pending === 0
                    ? 'Every payslip in this run has been handed out.'
                    : `${progress.pending} payslip(s) still pending distribution.`}
                </p>
              </div>

              {progress.pending === 0 && progress.total > 0 && (
                <Badge variant="secondary" className="gap-1">
                  <BadgeCheck className="h-3.5 w-3.5" /> Fully distributed
                </Badge>
              )}
            </CardContent>
          </Card>

          {/* ── Employee checklist ───────────────────────────────────── */}
          <Card className="rounded-xl">
            <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-base">
                Payslips — {run ? monthLabel(run.monthKey) : ''}
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected(new Set(slips.map((p) => p.id)))}
                >
                  <CheckSquare className="h-4 w-4" /> All
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                  <Square className="h-4 w-4" /> None
                </Button>
                <Button
                  size="sm"
                  disabled={selectedSlips.length === 0 || generating}
                  onClick={handleDownloadPdf}
                >
                  {generating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FileDown className="h-4 w-4" />
                  )}
                  Download all as PDF ({selectedSlips.length})
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={selectedSlips.length === 0}
                  onClick={() => markDistributed(selectedSlips, true)}
                >
                  <BadgeCheck className="h-4 w-4" /> Mark as distributed ({selectedSlips.length})
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {slips.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <Users className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No payslips found for this run — it may have been re-run or undone.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Employee</TableHead>
                      <TableHead>Payslip no.</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">Net pay</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {slips.map((p) => {
                      const emp = empMap.get(p.employeeId);
                      const distributed = !!p.distributedAt;
                      return (
                        <TableRow key={p.id}>
                          <TableCell>
                            <Checkbox
                              aria-label={`Select ${emp?.name ?? p.employeeId}`}
                              checked={selected.has(p.id)}
                              onCheckedChange={(v) => toggle(p.id, v === true)}
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            {emp?.name ?? p.employeeId}
                            {emp?.employeeNo && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                {emp.employeeNo}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            <Link
                              to={`/payroll/payslip/${p.id}`}
                              className="text-amber-700 underline-offset-4 hover:underline dark:text-amber-500"
                            >
                              {p.refNo ?? p.id}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right"><Money>{fmtRM(p.grossPay)}</Money></TableCell>
                          <TableCell className="text-right"><Money>{fmtRM(p.netPay)}</Money></TableCell>
                          <TableCell>
                            {distributed ? (
                              <Badge variant="secondary" className="gap-1">
                                <BadgeCheck className="h-3 w-3" />
                                Distributed {fmtDate(p.distributedAt!)}
                              </Badge>
                            ) : (
                              <Badge variant="outline">Pending</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="sm" asChild title="Open payslip">
                                <Link to={`/payroll/payslip/${p.id}`}>
                                  <Receipt className="h-4 w-4" />
                                </Link>
                              </Button>
                              {distributed ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Remove distribution mark"
                                  onClick={() => markDistributed([p], false)}
                                >
                                  <Undo2 className="h-4 w-4" />
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Mark as distributed"
                                  onClick={() => markDistributed([p], true)}
                                >
                                  <BadgeCheck className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
