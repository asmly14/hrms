/**
 * Loans & Benefits — employee loans (borrow from the company, repay via
 * payroll deductions) and recurring benefits in kind (e.g. Personal Health
 * Insurance reimbursement), in one two-tab page.
 *
 * Role scoping:
 *  - Admin/HR — full registry: stats, create-loan dialog, loan detail sheet
 *    (ledger, statement print, settle-early / write-off), benefits CRUD.
 *  - Everyone else (Employee / Manager without HR) — READ-ONLY view of their
 *    OWN loans and benefits (the session's linked employeeId), reachable from
 *    the link on their employee records page. No mutations render at all.
 *
 * Payroll integration lives in lib/payrollEngine.ts: loan installments are
 * net-only deductions (EA 1955 s.24 50%-cap with deferral), benefits inject
 * per run honoring their statutory treatment.
 */
import { useMemo, useState } from 'react';
import { HandCoins, HeartPulse, Plus, Wallet } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { fmtRM, monthKey } from '@/lib/utils';
import { useEffectiveRole } from '@/components/layout/useEffectiveRole';
import { useAuthSafe } from '@/lib/useAuthSafe';
import { loanExposureStats, loansFor, getLoans, type EmployeeLoan } from '@/lib/loans';
import { benefitsFor, getBenefits } from '@/lib/benefits';
import type { Employee } from '@/lib/types';
import { monthLabel } from '@/pages/payroll/helpers';
import { Money } from '@/pages/payroll/components';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import CreateLoanDialog from './CreateLoanDialog';
import LoanDetailSheet from './LoanDetailSheet';
import BenefitsTab from './BenefitsTab';
import { LOAN_STATUS_LABELS, loanStatusVariant } from './loanUi';

export default function LoansPage() {
  const { role } = useEffectiveRole();
  const auth = useAuthSafe();
  const isHR = role === 'Admin' || role === 'HR';
  const ownEmployeeId = auth?.employeeId ?? null;

  const { items: employees } = useCollection<Employee>('employees');
  // Subscribe to both collections so the page live-refreshes on changes.
  const { items: loans } = useCollection<EmployeeLoan>('loans');
  useCollection('benefits');

  const [createOpen, setCreateOpen] = useState(false);
  const [detailLoanId, setDetailLoanId] = useState<string | null>(null);

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const thisMonth = monthKey();

  /** Admin/HR see the whole registry; others see only their own loans. */
  const visibleLoans = useMemo(
    () =>
      (isHR ? loans : loans.filter((l) => l.employeeId === ownEmployeeId))
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [loans, isHR, ownEmployeeId],
  );

  const stats = useMemo(() => loanExposureStats(thisMonth), [thisMonth, loans]); // eslint-disable-line react-hooks/exhaustive-deps
  const ownActive = useMemo(
    () => (ownEmployeeId ? loansFor(ownEmployeeId).filter((l) => l.status === 'active') : []),
    [ownEmployeeId, loans], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const detailLoan = detailLoanId ? getLoans().find((l) => l.id === detailLoanId) ?? null : null;
  // Employee role: count their benefits for the tab label.
  const ownBenefitCount = ownEmployeeId ? benefitsFor(ownEmployeeId).length : 0;
  void getBenefits; // (collection subscription above drives re-render)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <HandCoins className="h-6 w-6 text-amber-600" /> Loans &amp; Benefits
          </h1>
          <p className="text-sm text-muted-foreground">
            {isHR
              ? 'Employee loans repaid through payroll (EA 1955 s.24 capped) and recurring benefits in kind.'
              : 'Your loans and recurring benefits — repayments are deducted from your net pay.'}
          </p>
        </div>
        {isHR && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New loan
          </Button>
        )}
      </div>

      <Tabs defaultValue="loans">
        <TabsList>
          <TabsTrigger value="loans">
            Loans{!isHR && ownActive.length > 0 ? ` (${ownActive.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="benefits">
            Benefits{!isHR && ownBenefitCount > 0 ? ` (${ownBenefitCount})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="loans" className="mt-4 space-y-4">
          {isHR ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Card className="rounded-xl">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <HandCoins className="h-4 w-4" /> Active loans
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">{stats.activeLoans}</p>
                </CardContent>
              </Card>
              <Card className="rounded-xl">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Wallet className="h-4 w-4" /> Total outstanding
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">{fmtRM(stats.totalOutstanding)}</p>
                </CardContent>
              </Card>
              <Card className="rounded-xl">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <HeartPulse className="h-4 w-4" /> Deductions — {monthLabel(thisMonth)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular-nums">{fmtRM(stats.scheduledThisMonth)}</p>
                </CardContent>
              </Card>
            </div>
          ) : (
            ownActive.length > 0 && (
              <Card className="rounded-xl">
                <CardContent className="flex flex-wrap gap-6 p-5">
                  <div>
                    <p className="text-xs text-muted-foreground">Active loans</p>
                    <p className="text-xl font-semibold tabular-nums">{ownActive.length}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Outstanding</p>
                    <p className="text-xl font-semibold tabular-nums">
                      {fmtRM(ownActive.reduce((s, l) => s + l.remaining, 0))}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Monthly installment</p>
                    <p className="text-xl font-semibold tabular-nums">
                      {fmtRM(ownActive.reduce((s, l) => s + l.installmentAmount, 0))}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )
          )}

          <Card className="rounded-xl">
            <CardHeader>
              <CardTitle className="text-base">{isHR ? 'Loan registry' : 'My loans'}</CardTitle>
            </CardHeader>
            <CardContent>
              {visibleLoans.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-12 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50">
                    <HandCoins className="h-6 w-6" />
                  </span>
                  <p className="font-medium">{isHR ? 'No loans yet' : 'No loans'}</p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {isHR
                      ? 'Create a loan to start deducting installments from payroll.'
                      : 'If the company grants you a loan it will appear here.'}
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      {isHR && <TableHead>Employee</TableHead>}
                      <TableHead className="text-right">Principal</TableHead>
                      <TableHead className="text-right">Remaining</TableHead>
                      <TableHead className="text-right">Installment</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleLoans.map((loan) => (
                      <TableRow
                        key={loan.id}
                        className="cursor-pointer"
                        onClick={() => setDetailLoanId(loan.id)}
                      >
                        <TableCell className="font-medium">{loan.refNo}</TableCell>
                        {isHR && (
                          <TableCell>{empById.get(loan.employeeId)?.name ?? loan.employeeId}</TableCell>
                        )}
                        <TableCell className="text-right"><Money>{fmtRM(loan.principal)}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(loan.remaining)}</Money></TableCell>
                        <TableCell className="text-right">
                          <Money>{fmtRM(loan.installmentAmount)}</Money>
                          <span className="block text-xs text-muted-foreground">
                            × {loan.termMonths} months{loan.interestRate > 0 ? ` @ ${loan.interestRate}%` : ''}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={loanStatusVariant(loan.status)}>
                            {LOAN_STATUS_LABELS[loan.status]}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="benefits" className="mt-4">
          <BenefitsTab isHR={isHR} ownEmployeeId={ownEmployeeId} employees={employees} />
        </TabsContent>
      </Tabs>

      {isHR && (
        <CreateLoanDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          employees={employees}
          actor={auth?.user?.username ?? 'HR'}
          onCreated={(loan) => setDetailLoanId(loan.id)}
        />
      )}
      <LoanDetailSheet
        loan={detailLoan}
        employee={detailLoan ? empById.get(detailLoan.employeeId) : undefined}
        readOnly={!isHR}
        actor={auth?.user?.username ?? 'HR'}
        onOpenChange={(open) => !open && setDetailLoanId(null)}
      />
    </div>
  );
}
