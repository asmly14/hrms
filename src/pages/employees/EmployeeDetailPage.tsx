import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CalendarDays,
  FileText,
  FolderOpen,
  HeartPulse,
  Landmark,
  Pencil,
  Scale,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  User,
  UserMinus,
  UserX,
  Wallet,
} from 'lucide-react';
import { getCollection, useCollection } from '@/lib/db';
import { useAuth } from '@/lib/authContext';
import { useTenant } from '@/lib/tenantContext';
import { stateInfo } from '@/lib/holidays';
import { MINIMUM_WAGE } from '@/lib/statutory';
import { suggestSalary } from '@/lib/salaryBenchmark';
import { ageFromDob, cn, fmtDate, fmtRM } from '@/lib/utils';
import type { Department, Employee, LeaveBalance, Payslip, Position } from '@/lib/types';
import { displayCustomValue, getEmployeeCustomFields } from '@/pages/company/customFields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmployeeAvatar } from './EmployeeAvatar';
import { StatusBadge, TypeBadge } from './EmployeeBadges';
import { EmployeeFormDialog } from './EmployeeFormDialog';
import { SeparationMenu } from './SeparationActions';
import { carryInOf, customOf } from './types';
import {
  belowMinimumWage,
  deptName,
  maskAccount,
  maskIc,
  positionTitle,
  probationDaysLeft,
  probationEnd,
  probationProgress,
  serviceYears,
} from './helpers';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium text-foreground">{children}</dd>
    </div>
  );
}

function InfoCard({ title, icon: Icon, children }: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-amber-600" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border/60">{children}</dl>
      </CardContent>
    </Card>
  );
}

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { role, employeeId, canViewEmployee, user } = useAuth();
  /** Sensitive data (salary, full NRIC/bank) and mutations: Admin/HR only. */
  const isHR = role === 'Admin' || role === 'HR';
  const actorName = user?.username ?? 'HR Admin';

  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');
  const { items: leaveBalances } = useCollection<LeaveBalance>('leaveBalances');
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { activeCompany } = useTenant();

  const [editOpen, setEditOpen] = useState(false);

  const emp = employees.find((e) => e.id === id);

  const years = useMemo(() => (emp ? serviceYears(emp.joinDate) : 0), [emp]);
  const benchmark = useMemo(() => {
    if (!emp) return null;
    return suggestSalary(
      positionTitle(positions, emp.positionId),
      years,
      emp.state,
      deptName(departments, emp.departmentId),
    );
  }, [emp, positions, departments, years]);

  if (!emp) {
    return (
      <Card className="rounded-xl">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserX className="h-5 w-5" />
            </EmptyMedia>
            <EmptyTitle>Employee not found</EmptyTitle>
            <EmptyDescription>
              This record may have been removed. Head back to the directory.
            </EmptyDescription>
          </EmptyHeader>
          <Link to="/employees">
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to employees
            </Button>
          </Link>
        </Empty>
      </Card>
    );
  }

  // Employee role may only ever see their own record.
  if (role === 'Employee' && emp.id !== employeeId) {
    return <Navigate to={employeeId ? `/employees/${employeeId}` : '/'} replace />;
  }

  // Managers are limited to their own department; anything else is off-limits.
  if (!canViewEmployee(emp.id)) {
    return (
      <Card className="rounded-xl">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheck className="h-5 w-5" />
            </EmptyMedia>
            <EmptyTitle>No access to this record</EmptyTitle>
            <EmptyDescription>
              This employee is outside your department. Head back to your directory view.
            </EmptyDescription>
          </EmptyHeader>
          <Link to="/employees">
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to employees
            </Button>
          </Link>
        </Empty>
      </Card>
    );
  }

  const isOwnRecord = emp.id === employeeId;
  const position = positionTitle(positions, emp.positionId);
  const department = deptName(departments, emp.departmentId);
  const allowances = emp.fixedAllowances ?? [];
  const allowanceTotal = allowances.reduce((s, a) => s + a.amount, 0);
  const carryIn = carryInOf(emp);
  // Company-defined custom fields (built in /company → Custom Fields).
  const customFields = getEmployeeCustomFields(activeCompany);
  const customValues = customOf(emp);
  const balances = leaveBalances
    .filter((b) => b.employeeId === emp.id)
    .sort((a, b) => b.year - a.year);
  const balance = balances[0];
  const slips = payslips
    .filter((p) => p.employeeId === emp.id)
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey));

  const daysLeft = emp.status === 'probation' ? probationDaysLeft(emp.joinDate) : null;

  // After a permanent delete, leave the now-dangling detail route.
  const onSeparationCompleted = () => {
    if (!getCollection<Employee>('employees').some((x) => x.id === emp.id)) {
      navigate('/employees');
    }
  };

  // Benchmark comparison chip (market median for role / seniority / state).
  let benchChip: { label: string; cls: string; icon: typeof TrendingUp } | null = null;
  if (benchmark && benchmark.median > 0) {
    const diff = emp.baseSalary - benchmark.median;
    const pct = Math.round((diff / benchmark.median) * 100);
    if (Math.abs(pct) <= 5) {
      benchChip = { label: `At market median (${fmtRM(benchmark.median)})`, cls: 'bg-stone-100 text-stone-700', icon: Scale };
    } else if (pct < 0) {
      benchChip = { label: `${Math.abs(pct)}% below median (${fmtRM(benchmark.median)})`, cls: 'bg-amber-100 text-amber-800', icon: TrendingDown };
    } else {
      benchChip = { label: `${pct}% above median (${fmtRM(benchmark.median)})`, cls: 'bg-lime-100 text-lime-800', icon: TrendingUp };
    }
  }

  const leaveRows = balance
    ? ([
        { label: 'Annual leave', entitled: balance.annualEntitled + balance.carriedForward, used: balance.annualUsed, note: balance.carriedForward > 0 ? `incl. ${balance.carriedForward}d carried forward` : undefined },
        { label: 'Sick leave', entitled: balance.sickEntitled, used: balance.sickUsed, note: undefined },
        { label: 'Hospitalization', entitled: balance.hospitalizationEntitled, used: balance.hospitalizationUsed, note: 'aggregate incl. sick days (EA s.60F)' },
      ] as const)
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-2">
        <Link to="/employees" aria-label="Back to employees">
          <Button variant="ghost" size="icon" className="mt-0.5 shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <Card className="flex-1 rounded-xl">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
            <EmployeeAvatar name={emp.name} size="lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <h1 className="truncate text-xl font-semibold tracking-tight">{emp.name}</h1>
              <p className="text-sm text-muted-foreground">
                {position} · {department} · {stateInfo(emp.state).name}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <StatusBadge status={emp.status} />
                <TypeBadge type={emp.employmentType} />
                {emp.isForeignWorker && (
                  <Badge variant="outline" className="border-transparent bg-orange-100 text-orange-800">
                    Foreign worker
                  </Badge>
                )}
                {daysLeft !== null && (
                  <Badge
                    variant="outline"
                    className={cn(
                      'border-transparent',
                      daysLeft < 0 ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800',
                    )}
                  >
                    {daysLeft < 0
                      ? `Probation ${Math.abs(daysLeft)}d overdue`
                      : `Probation ends in ${daysLeft}d`}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {/* Records link is visible to every role — the records page self-gates. */}
              <Link to={`/employees/${emp.id}/records`}>
                <Button variant="outline">
                  <FolderOpen className="mr-1.5 h-4 w-4" /> Records
                </Button>
              </Link>
              {isHR && (
                <>
                  <Button variant="outline" onClick={() => setEditOpen(true)}>
                    <Pencil className="mr-1.5 h-4 w-4" /> Edit
                  </Button>
                  <SeparationMenu
                    targets={[emp]}
                    actorName={actorName}
                    onCompleted={onSeparationCompleted}
                    trigger={
                      <Button variant="outline">
                        <UserMinus className="mr-1.5 h-4 w-4" /> Separation
                      </Button>
                    }
                  />
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="personal">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="personal">Personal</TabsTrigger>
          <TabsTrigger value="employment">Employment</TabsTrigger>
          <TabsTrigger value="statutory">Statutory</TabsTrigger>
          <TabsTrigger value="bank">Bank</TabsTrigger>
          {isHR && <TabsTrigger value="compensation">Compensation</TabsTrigger>}
          <TabsTrigger value="leave">Leave</TabsTrigger>
          {(isHR || isOwnRecord) && <TabsTrigger value="payslips">Payslips</TabsTrigger>}
        </TabsList>

        {/* ── Personal ── */}
        <TabsContent value="personal" className="mt-4 space-y-4">
          <InfoCard title="Personal details" icon={User}>
            <Row label="NRIC / Passport">{isHR ? emp.ic : maskIc(emp.ic)}</Row>
            <Row label="Date of birth">
              {fmtDate(emp.dateOfBirth)} ({ageFromDob(emp.dateOfBirth)} yrs)
            </Row>
            <Row label="Gender">{emp.gender === 'male' ? 'Male' : 'Female'}</Row>
            <Row label="Marital status">
              {emp.maritalStatus.charAt(0).toUpperCase() + emp.maritalStatus.slice(1)}
            </Row>
            <Row label="Children (PCB relief)">{emp.children}</Row>
            <Row label="Email">
              <a className="text-amber-700 hover:underline underline-offset-4" href={`mailto:${emp.email}`}>
                {emp.email}
              </a>
            </Row>
            <Row label="Phone">{emp.phone}</Row>
          </InfoCard>
          {customFields.length > 0 && (
            <InfoCard title="Additional information" icon={FileText}>
              {customFields.map((f) => (
                <Row key={f.id} label={f.label}>
                  {displayCustomValue(customValues[f.id])}
                </Row>
              ))}
            </InfoCard>
          )}
        </TabsContent>

        {/* ── Employment ── */}
        <TabsContent value="employment" className="mt-4 space-y-4">
          <InfoCard title="Employment" icon={CalendarDays}>
            <Row label="Department">{department}</Row>
            <Row label="Position">{position}</Row>
            <Row label="System role">
              {emp.role.charAt(0).toUpperCase() + emp.role.slice(1)}
            </Row>
            <Row label="Employment type">
              {emp.employmentType === 'full-time' ? 'Full-time' : emp.employmentType === 'part-time' ? 'Part-time' : 'Contract'}
            </Row>
            <Row label="Join date">{fmtDate(emp.joinDate)}</Row>
            <Row label="Length of service">{years.toFixed(1)} years</Row>
            <Row label="Work location">{stateInfo(emp.state).name}</Row>
            {emp.status === 'resigned' && emp.resignDate && (
              <Row label="Resignation date">{fmtDate(emp.resignDate)}</Row>
            )}
          </InfoCard>
          {emp.status === 'probation' && (
            <Card className="rounded-xl border-amber-200 bg-amber-50/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <BadgeCheck className="h-4 w-4 text-amber-600" />
                  Probation
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Progress value={probationProgress(emp.joinDate) * 100} className="h-1.5" />
                <p className="text-sm text-muted-foreground">
                  Assumed {daysLeft !== null && daysLeft < 0 ? 'ended' : 'ends'}{' '}
                  {fmtDate(probationEnd(emp.joinDate))} (3-month policy from join date)
                  {daysLeft !== null && (
                    <span className={daysLeft < 0 ? 'font-medium text-red-700' : 'font-medium text-amber-700'}>
                      {' '}— {daysLeft < 0 ? `${Math.abs(daysLeft)} days overdue for confirmation` : `${daysLeft} days remaining`}
                    </span>
                  )}
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Statutory ── */}
        <TabsContent value="statutory" className="mt-4 space-y-4">
          <InfoCard title="Statutory numbers" icon={ShieldCheck}>
            <Row label="EPF / KWSP member no.">{emp.epfNo || '—'}</Row>
            <Row label="SOCSO / PERKESO no.">{emp.socsoNo || '—'}</Row>
            <Row label="Income tax no.">{emp.taxNo || '—'}</Row>
            <Row label="Foreign worker">{emp.isForeignWorker ? 'Yes' : 'No'}</Row>
          </InfoCard>
          {emp.isForeignWorker && (
            <Card className="rounded-xl border-orange-200 bg-orange-50/60">
              <CardContent className="flex items-start gap-2.5 p-4 text-sm text-orange-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Foreign-worker EPF applies: <strong>2% employee + 2% employer</strong>, mandatory
                  from 1 Oct 2025 (EPF (Amendment) Act 2025). Statutory deductions on payslips are
                  computed automatically from this flag.
                </p>
              </CardContent>
            </Card>
          )}
          {isHR && carryIn && (
            <InfoCard title={`TP3 carry-in · YA ${carryIn.year}`} icon={FileText}>
              <Row label="YTD gross (prior employer)">{fmtRM(carryIn.gross)}</Row>
              <Row label="YTD employee EPF">{fmtRM(carryIn.epf)}</Row>
              <Row label="YTD employee SOCSO + EIS">{fmtRM(carryIn.socso)}</Row>
              <Row label="YTD PCB / MTD deducted">{fmtRM(carryIn.pcb)}</Row>
              {carryIn.note && <Row label="Note">{carryIn.note}</Row>}
            </InfoCard>
          )}
        </TabsContent>

        {/* ── Bank ── */}
        <TabsContent value="bank" className="mt-4">
          <InfoCard title="Bank account (salary credit)" icon={Landmark}>
            <Row label="Bank">{emp.bankName || '—'}</Row>
            <Row label="Account number">
              {emp.bankAccount ? (isHR ? emp.bankAccount : maskAccount(emp.bankAccount)) : '—'}
            </Row>
          </InfoCard>
        </TabsContent>

        {/* ── Compensation (Admin/HR only) ── */}
        {isHR && (
        <TabsContent value="compensation" className="mt-4 space-y-4">
          <InfoCard title="Compensation" icon={Wallet}>
            <Row label="Base salary">{fmtRM(emp.baseSalary)} / month</Row>
            {allowances.map((a) => (
              <Row key={a.name} label={`Allowance — ${a.name}`}>{fmtRM(a.amount)}</Row>
            ))}
            <Row label="Total fixed package">
              <span className="text-amber-800">{fmtRM(emp.baseSalary + allowanceTotal)} / month</span>
            </Row>
          </InfoCard>

          {belowMinimumWage(emp.baseSalary) && emp.employmentType !== 'part-time' && (
            <Card className="rounded-xl border-red-200 bg-red-50/60">
              <CardContent className="flex items-start gap-2.5 p-4 text-sm text-red-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Base salary is below the {fmtRM(MINIMUM_WAGE)} national minimum wage
                  (Minimum Wages Order 2024). Review before the next payroll run.
                </p>
              </CardContent>
            </Card>
          )}

          {belowMinimumWage(emp.baseSalary) && emp.employmentType === 'part-time' && (
            <Card className="rounded-xl border-amber-200 bg-amber-50/60">
              <CardContent className="flex items-start gap-2.5 p-4 text-sm text-amber-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Part-time pay is below the {fmtRM(MINIMUM_WAGE)} monthly minimum wage.
                  MWO 2024 applies to part-timers pro-rated by agreed hours — verify the
                  hourly equivalent complies before the next payroll run.
                </p>
              </CardContent>
            </Card>
          )}

          {benchmark && benchChip && (
            <Card className="rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Scale className="h-4 w-4 text-amber-600" />
                  Market benchmark
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn('border-transparent px-2.5 py-1 text-xs', benchChip.cls)}>
                    <benchChip.icon className="mr-1 h-3.5 w-3.5" />
                    {benchChip.label}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    vs. {benchmark.matchedRole} · {benchmark.band} yrs band · {stateInfo(emp.state).name}
                  </span>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  {(
                    [
                      ['P25', benchmark.percentile25],
                      ['Median', benchmark.median],
                      ['P75', benchmark.percentile75],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-stone-50 p-3">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-0.5 text-sm font-semibold">{fmtRM(value)}</dd>
                    </div>
                  ))}
                </dl>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {benchmark.drivers.map((d) => (
                    <li key={d}>· {d}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </TabsContent>
        )}

        {/* ── Leave ── */}
        <TabsContent value="leave" className="mt-4">
          {!balance ? (
            <Card className="rounded-xl">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HeartPulse className="h-5 w-5" />
                  </EmptyMedia>
                  <EmptyTitle>No leave balances</EmptyTitle>
                  <EmptyDescription>
                    Leave entitlements appear here once the leave module allocates this year's balances.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </Card>
          ) : (
            <Card className="rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <HeartPulse className="h-4 w-4 text-amber-600" />
                  Leave balances · {balance.year}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                {leaveRows.map((r) => {
                  const remaining = Math.max(0, r.entitled - r.used);
                  return (
                    <div key={r.label} className="space-y-1.5">
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="font-medium">{r.label}</span>
                        <span className="text-muted-foreground">
                          <span className="font-semibold text-foreground">{remaining}</span>
                          {' '}of {r.entitled} days left
                        </span>
                      </div>
                      <Progress value={r.entitled > 0 ? (r.used / r.entitled) * 100 : 0} className="h-1.5" />
                      <p className="text-xs text-muted-foreground">
                        {r.used} used{r.note ? ` · ${r.note}` : ''}
                      </p>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Payslips (Admin/HR, or the employee's own record) ── */}
        {(isHR || isOwnRecord) && (
        <TabsContent value="payslips" className="mt-4">
          {slips.length === 0 ? (
            <Card className="rounded-xl">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText className="h-5 w-5" />
                  </EmptyMedia>
                  <EmptyTitle>No payslips yet</EmptyTitle>
                  <EmptyDescription>
                    Payslip history appears here after the first payroll run that includes this employee.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </Card>
          ) : (
            <Card className="rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4 text-amber-600" />
                  Payslip history
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {slips.map((p) => (
                  <Link
                    key={p.id}
                    to={`/payroll/payslip/${p.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 transition-colors hover:border-amber-300 hover:bg-stone-50"
                  >
                    <div>
                      <p className="text-sm font-medium">{fmtDate(`${p.monthKey}-01`)}</p>
                      <p className="text-xs text-muted-foreground">
                        EPF {fmtRM(p.epfEmployee)} · SOCSO {fmtRM(p.socsoEmployee)} · EIS {fmtRM(p.eisEmployee)} · PCB {fmtRM(p.pcb)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold">{fmtRM(p.netPay)} net</p>
                      <p className="text-xs text-muted-foreground">{fmtRM(p.grossPay)} gross</p>
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>
        )}
      </Tabs>

      {isHR && (
        <EmployeeFormDialog open={editOpen} onOpenChange={setEditOpen} employee={emp} />
      )}
    </div>
  );
}
