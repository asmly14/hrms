import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, CalendarClock, Hourglass } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { useAuth } from '@/lib/useAuth';
import { fmtDate } from '@/lib/utils';
import type { Department, Employee } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { EmployeeAvatar } from './EmployeeAvatar';
import {
  ExtendProbationDialog,
  ProbationHistoryButton,
} from './ProbationActions';
import { confirmProbationAction, lastExtension } from './probation';
import {
  deptName,
  probationDaysLeft,
  probationEndDate,
  probationProgress,
} from './helpers';

/**
 * Probation tracker strip — every employee on probation with days remaining
 * until their current end date (extension-aware, see helpers.ts), plus
 * one-click confirm and extend actions. Mutations are Admin/HR only.
 */
export function ProbationStrip() {
  const { role, user } = useAuth();
  const canConfirm = role === 'Admin' || role === 'HR';
  const actorName = user?.username ?? 'HR Admin';

  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const [extendTarget, setExtendTarget] = useState<Employee | null>(null);

  const onProbation = employees
    .filter((e) => e.status === 'probation')
    .sort((a, b) => probationDaysLeft(a) - probationDaysLeft(b));

  if (!canConfirm || onProbation.length === 0) return null;

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
          const daysLeft = probationDaysLeft(emp);
          const overdue = daysLeft < 0;
          const extension = emp.probationExtendedTo ? lastExtension(emp) : undefined;
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
                  <ProbationHistoryButton employee={emp} />
                </div>
                <div className="space-y-1">
                  <Progress value={probationProgress(emp) * 100} className="h-1.5" />
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      Ends {fmtDate(probationEndDate(emp))}
                    </span>
                    <span className={overdue ? 'font-medium text-red-700' : 'font-medium text-amber-700'}>
                      {overdue ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}
                    </span>
                  </div>
                  {emp.probationExtendedTo && (
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex cursor-help items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                            <CalendarClock className="h-3 w-3" />
                            Extended to {fmtDate(emp.probationExtendedTo)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          {extension?.reason
                            ? `Reason: ${extension.reason}`
                            : 'Extension on record — no reason given.'}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => confirmProbationAction(emp, actorName)}
                  >
                    <BadgeCheck className="mr-1.5 h-3.5 w-3.5 text-lime-700" />
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setExtendTarget(emp)}
                  >
                    <CalendarClock className="mr-1.5 h-3.5 w-3.5 text-amber-700" />
                    Extend…
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {extendTarget && (
        <ExtendProbationDialog
          employee={extendTarget}
          actorName={actorName}
          open={extendTarget !== null}
          onOpenChange={(open) => !open && setExtendTarget(null)}
        />
      )}
    </section>
  );
}
