/**
 * My Payslips — employee self-service list of the LOGGED-IN employee's own
 * payslips, newest first. Each row links to the full itemized payslip at
 * /payroll/payslip/:id, whose ownership guard (B2) already allows self-view.
 *
 * Employee-friendly by construction:
 *  - strictly `payslip.employeeId === auth.employeeId` — no other employee's
 *    data is ever read into this page;
 *  - FINALIZED runs only — draft figures are internal HR review material and
 *    are never official until finalized.
 *
 * This is the natural landing destination for the Employee role; the
 * integration wave wires the '/my-payslips' nav item (see payroll/meta.ts).
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Receipt, UserRound, Wallet } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { fmtDate, fmtRM } from '@/lib/utils';
import type { PayrollRun, Payslip } from '@/lib/types';
import { monthLabel } from './helpers';
import { Money } from './components';
import { useAuthSafe } from './useAuthSafe';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

export default function MyPayslipsPage() {
  const auth = useAuthSafe();
  const employeeId = auth?.employeeId ?? null;
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');

  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);

  /** The logged-in employee's payslips from finalized runs, newest first. */
  const mine = useMemo(() => {
    if (!employeeId) return [];
    return payslips
      .filter((p) => p.employeeId === employeeId)
      .filter((p) => runById.get(p.runId)?.status === 'finalized')
      .sort(
        (a, b) =>
          b.monthKey.localeCompare(a.monthKey) ||
          (runById.get(b.runId)?.runAt ?? '').localeCompare(runById.get(a.runId)?.runAt ?? ''),
      );
  }, [payslips, runById, employeeId]);

  /** Pay date shown to the employee: when the run was finalized (or run). */
  const payDate = (p: Payslip): string => {
    const run = runById.get(p.runId);
    return fmtDate(run?.finalizedAt ?? run?.runAt ?? p.monthKey);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Wallet className="h-6 w-6 text-amber-600" /> My Payslips
        </h1>
        <p className="text-sm text-muted-foreground">
          Your itemized payslips — open any month to view or print the full breakdown.
        </p>
      </div>

      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Payslip history</CardTitle>
        </CardHeader>
        <CardContent>
          {!employeeId ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50">
                <UserRound className="h-6 w-6" />
              </span>
              <div>
                <p className="font-medium">No employee record linked</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Payslips are personal — sign in with an account linked to your employee
                  record and your payslips will appear here.
                </p>
              </div>
            </div>
          ) : mine.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50">
                <Receipt className="h-6 w-6" />
              </span>
              <div>
                <p className="font-medium">No payslips yet</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Once HR runs payroll they'll appear here.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead>Pay date</TableHead>
                      <TableHead className="text-right">Gross pay</TableHead>
                      <TableHead className="text-right">Net pay</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mine.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">
                          <Link
                            to={`/payroll/payslip/${p.id}`}
                            className="text-amber-700 underline-offset-4 hover:underline dark:text-amber-500"
                          >
                            {monthLabel(p.monthKey)}
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{payDate(p)}</TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(p.grossPay)}</Money></TableCell>
                        <TableCell className="text-right font-medium"><Money>{fmtRM(p.netPay)}</Money></TableCell>
                        <TableCell className="text-right">
                          <Link
                            to={`/payroll/payslip/${p.id}`}
                            aria-label={`Open payslip for ${monthLabel(p.monthKey)}`}
                          >
                            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile cards */}
              <div className="space-y-3 md:hidden">
                {mine.map((p) => (
                  <Link
                    key={p.id}
                    to={`/payroll/payslip/${p.id}`}
                    className="block rounded-xl border p-4 transition-colors hover:bg-accent"
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{monthLabel(p.monthKey)}</p>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Pay date</p>
                        <p>{payDate(p)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Gross</p>
                        <p className="tabular-nums">{fmtRM(p.grossPay)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Net</p>
                        <p className="font-medium tabular-nums">{fmtRM(p.netPay)}</p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
