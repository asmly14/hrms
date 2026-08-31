/**
 * Loan detail sheet — the loan's repayment ledger (scheduled / paid /
 * deferred per month, with payroll-run links), a printable statement view,
 * and the Admin/HR lifecycle actions: settle early, write off, cancel —
 * each behind a confirm dialog and audit-logged in lib/loans.ts.
 */
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Ban, FileWarning, Handshake, Printer } from 'lucide-react';
import {
  cancelLoan, loanStatement, settleEarly, writeOffLoan, type EmployeeLoan,
} from '@/lib/loans';
import { toastError, toastSuccess } from '@/lib/toast';
import { fmtDate, fmtRM } from '@/lib/utils';
import type { Employee } from '@/lib/types';
import { monthLabel } from '@/pages/payroll/helpers';
import { Money, PrintAreaStyles } from '@/pages/payroll/components';
import { LOAN_STATUS_LABELS, loanStatusVariant } from './loanUi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface Props {
  loan: EmployeeLoan | null;
  employee: Employee | undefined;
  /** Employee self-service: hides every mutation. */
  readOnly: boolean;
  actor: string;
  onOpenChange: (open: boolean) => void;
}

const PRINT_AREA = 'loan-statement-print';

const ENTRY_STATUS_LABELS = { pending: 'Pending', paid: 'Paid', deferred: 'Deferred' } as const;

export default function LoanDetailSheet({ loan, employee, readOnly, actor, onOpenChange }: Props) {
  const [confirm, setConfirm] = useState<'settle' | 'writeoff' | 'cancel' | null>(null);
  const statement = loan ? loanStatement(loan.id) : null;

  function act(kind: 'settle' | 'writeoff' | 'cancel'): void {
    if (!loan) return;
    try {
      if (kind === 'settle') {
        settleEarly(loan.id, actor);
        toastSuccess(`${loan.refNo} settled early`, 'The outstanding balance is marked paid off.');
      } else if (kind === 'writeoff') {
        writeOffLoan(loan.id, actor);
        toastSuccess(`${loan.refNo} written off`, 'Future installments will not be deducted.');
      } else {
        cancelLoan(loan.id, actor);
        toastSuccess(`${loan.refNo} cancelled`);
      }
    } catch (err) {
      toastError('Action failed', err);
    } finally {
      setConfirm(null);
    }
  }

  return (
    <Sheet open={loan !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {loan && statement && (
          <>
            <PrintAreaStyles areaClass={PRINT_AREA} />
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {loan.refNo}
                <Badge variant={loanStatusVariant(loan.status)}>{LOAN_STATUS_LABELS[loan.status]}</Badge>
              </SheetTitle>
              <SheetDescription>
                {employee?.name ?? loan.employeeId} · issued {fmtDate(loan.issueDate)}
                {loan.reason ? ` · ${loan.reason}` : ''}
              </SheetDescription>
            </SheetHeader>

            <div className={`mt-4 space-y-6 ${PRINT_AREA}`}>
              {/* Statement summary (print-friendly) */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground print-text-muted">Principal</p>
                  <p className="font-semibold tabular-nums">{fmtRM(statement.totals.principal)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground print-text-muted">Paid to date</p>
                  <p className="font-semibold tabular-nums">{fmtRM(statement.totals.paid)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground print-text-muted">Remaining</p>
                  <p className="font-semibold tabular-nums">{fmtRM(statement.totals.remaining)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground print-text-muted">Installment</p>
                  <p className="font-semibold tabular-nums">
                    {fmtRM(loan.installmentAmount)}
                    <span className="block text-xs font-normal text-muted-foreground print-text-muted">
                      {loan.interestRate > 0 ? `@ ${loan.interestRate}% p.a.` : 'interest-free'}
                    </span>
                  </p>
                </div>
              </div>

              {/* Repayment ledger */}
              <div>
                <h3 className="mb-2 text-sm font-semibold">Repayment ledger</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Scheduled</TableHead>
                      <TableHead className="text-right">Deducted</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Run</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.entries.map((e) => (
                      <TableRow key={e.month}>
                        <TableCell>{monthLabel(e.month)}</TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(e.amount)}</Money></TableCell>
                        <TableCell className="text-right">
                          <Money>{e.paidAmount !== undefined ? fmtRM(e.paidAmount) : '—'}</Money>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={e.status === 'paid' ? 'secondary' : e.status === 'deferred' ? 'destructive' : 'outline'}
                          >
                            {ENTRY_STATUS_LABELS[e.status]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {e.paidInRunId ? (
                            <Link
                              to={`/payroll/runs/${e.paidInRunId}`}
                              className="text-xs text-amber-700 underline-offset-4 hover:underline dark:text-amber-500"
                            >
                              View run
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground print-text-muted">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="mt-2 text-xs text-muted-foreground print-text-muted">
                  Statement generated {fmtDate(new Date())} · total scheduled {fmtRM(statement.totals.scheduled)} ·
                  approved by {loan.approvedBy}
                  {loan.statusNote ? ` · ${loan.statusNote}` : ''}
                </p>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Printer className="mr-2 h-4 w-4" /> Print statement
              </Button>
              {!readOnly && loan.status === 'active' && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setConfirm('settle')}>
                    <Handshake className="mr-2 h-4 w-4" /> Settle early
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirm('writeoff')}>
                    <FileWarning className="mr-2 h-4 w-4" /> Write off
                  </Button>
                  {loan.payments.length === 0 && (
                    <Button variant="ghost" size="sm" onClick={() => setConfirm('cancel')}>
                      <Ban className="mr-2 h-4 w-4" /> Cancel loan
                    </Button>
                  )}
                </>
              )}
            </div>

            <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {confirm === 'settle'
                      ? `Settle ${loan.refNo} early?`
                      : confirm === 'writeoff'
                        ? `Write off ${loan.refNo}?`
                        : `Cancel ${loan.refNo}?`}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {confirm === 'settle'
                      ? `The outstanding ${fmtRM(loan.remaining)} is recorded as paid off outside payroll (e.g. final settlement). The loan closes immediately.`
                      : confirm === 'writeoff'
                        ? `The outstanding ${fmtRM(loan.remaining)} is written off — no further installments will be deducted. This is audit-logged.`
                        : 'Cancelling marks the loan void. Only loans with no recorded payments can be cancelled.'}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Back</AlertDialogCancel>
                  <AlertDialogAction onClick={() => confirm && act(confirm)}>
                    Confirm
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
