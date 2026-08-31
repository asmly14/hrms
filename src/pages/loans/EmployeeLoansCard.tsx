/**
 * Per-employee Loans & Benefits summary card — shown on the employee detail
 * (profile) page. Compact headline figures with a link through to /loans,
 * where Admin/HR get the full registry and the employee role gets a scoped
 * read-only view of their own records.
 */
import { Link } from 'react-router-dom';
import { ChevronRight, HandCoins, HeartPulse } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { fmtRM } from '@/lib/utils';
import type { EmployeeLoan } from '@/lib/loans';
import type { RecurringBenefit } from '@/lib/benefits';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function EmployeeLoansCard({ employeeId }: { employeeId: string }) {
  const { items: loans } = useCollection<EmployeeLoan>('loans');
  const { items: benefits } = useCollection<RecurringBenefit>('benefits');

  const activeLoans = loans.filter((l) => l.employeeId === employeeId && l.status === 'active');
  const activeBenefits = benefits.filter((b) => b.employeeId === employeeId && b.status === 'active');
  const outstanding = activeLoans.reduce((s, l) => s + l.remaining, 0);
  const monthlyInstallments = activeLoans.reduce((s, l) => s + l.installmentAmount, 0);

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <HandCoins className="h-4 w-4 text-amber-600" /> Loans &amp; benefits
          </span>
          <Link
            to="/loans"
            className="flex items-center gap-1 text-xs font-normal text-amber-700 underline-offset-4 hover:underline dark:text-amber-500"
          >
            Open <ChevronRight className="h-3 w-3" />
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {activeLoans.length === 0 && activeBenefits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active loans or recurring benefits.</p>
        ) : (
          <div className="space-y-2 text-sm">
            {activeLoans.length > 0 && (
              <p className="flex items-center gap-2">
                <HandCoins className="h-3.5 w-3.5 text-muted-foreground" />
                <span>
                  {activeLoans.length} active loan{activeLoans.length > 1 ? 's' : ''} —{' '}
                  <span className="tabular-nums">{fmtRM(outstanding)}</span> outstanding,{' '}
                  <span className="tabular-nums">{fmtRM(monthlyInstallments)}</span>/month
                </span>
              </p>
            )}
            {activeBenefits.length > 0 && (
              <p className="flex items-center gap-2">
                <HeartPulse className="h-3.5 w-3.5 text-muted-foreground" />
                <span>
                  {activeBenefits.length} recurring benefit{activeBenefits.length > 1 ? 's' : ''} —{' '}
                  {activeBenefits.map((b) => b.name).join(', ')}
                </span>
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
