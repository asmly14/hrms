import { Link } from 'react-router-dom';
import { BadgeCheck, Hourglass } from 'lucide-react';
import { useCollection, logAudit } from '@/lib/db';
import { useAuth } from '@/lib/authContext';
import { fmtDate } from '@/lib/utils';
import type { Department, Employee } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { EmployeeAvatar } from './EmployeeAvatar';
import {
  deptName,
  probationDaysLeft,
  probationEnd,
  probationProgress,
} from './helpers';

/**
 * Probation tracker strip — every employee on probation with days remaining
 * until their assumed 3-month confirmation date (see helpers.ts note), plus a
 * one-click confirm action that flips status to active.
 * Confirming is a mutation, so the strip renders for Admin/HR only.
 */
export function ProbationStrip() {
  const { role, user } = useAuth();
  const canConfirm = role === 'Admin' || role === 'HR';

  const { items: employees, update } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');

  const onProbation = employees
    .filter((e) => e.status === 'probation')
    .sort((a, b) => probationDaysLeft(a.joinDate) - probationDaysLeft(b.joinDate));

  if (!canConfirm || onProbation.length === 0) return null;

  const confirm = (emp: Employee) => {
    update(emp.id, { status: 'active' });
    logAudit({
      actorName: user?.username ?? 'HR Admin',
      action: 'employee.confirm',
      entity: 'employees',
      entityId: emp.id,
      detail: `${emp.name} confirmed in role after probation`,
    });
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Hourglass className="h-4 w-4 text-amber-600" />
        <h2 className="text-sm font-semibold tracking-tight">
          Probation tracker
        </h2>
        <span className="text-xs text-muted-foreground">
          {onProbation.length} employee{onProbation.length > 1 ? 's' : ''} pending confirmation
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1 md:grid md:grid-cols-2 md:overflow-visible lg:grid-cols-3">
        {onProbation.map((emp) => {
          const daysLeft = probationDaysLeft(emp.joinDate);
          const overdue = daysLeft < 0;
          return (
            <Card key={emp.id} className="min-w-[260px] rounded-xl">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center gap-3">
                  <EmployeeAvatar name={emp.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/employees/${emp.id}`}
                      className="block truncate text-sm font-medium text-foreground hover:text-amber-700 hover:underline underline-offset-4"
                    >
                      {emp.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {deptName(departments, emp.departmentId)}
                    </p>
                  </div>
                </div>
                <div className="space-y-1">
                  <Progress value={probationProgress(emp.joinDate) * 100} className="h-1.5" />
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      Ends {fmtDate(probationEnd(emp.joinDate))}
                    </span>
                    <span className={overdue ? 'font-medium text-red-700' : 'font-medium text-amber-700'}>
                      {overdue ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}
                    </span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => confirm(emp)}
                >
                  <BadgeCheck className="mr-1.5 h-3.5 w-3.5 text-lime-700" />
                  Confirm employment
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
