/**
 * Dashboard charts (recharts via the shadcn ChartContainer):
 *  - HeadcountByDepartment — bar, active employees per department
 *  - PayrollTrend          — line, employer cost over the last 6 runs
 *  - AttendanceRate        — area, daily attendance rate, last 14 days
 *  - ClaimsDonut           — donut, claim amounts by category
 */
import { useMemo, type ReactNode } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  Pie, PieChart, XAxis, YAxis,
} from 'recharts';
import { BarChart3, CalendarClock, Donut, TrendingUp } from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { useCollection } from '@/lib/db';
import { fmtRM, round2 } from '@/lib/utils';
import type { AttendanceRecord, Claim, Department, Employee, PayrollRun } from '@/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { addDays, estimateMonthlyEmployerCost, isoOf, shortDate, shortMonth } from '../lib';

function ChartCard({
  title, description, icon: Icon, children,
}: {
  title: string;
  description: string;
  icon: typeof BarChart3;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-amber-600" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function EmptyChart({ note }: { note: string }) {
  return (
    <div className="flex h-[240px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
      <BarChart3 className="h-6 w-6 text-muted-foreground/50" />
      <p className="max-w-[26ch] text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

// ── Headcount by department (bar) ────────────────────────────────────────────

const headcountConfig = {
  count: { label: 'Employees', color: '#d97706' },
} satisfies ChartConfig;

export function HeadcountByDepartment() {
  const { scopeEmployees } = useAuth();
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');

  const data = useMemo(() => {
    const active = scopeEmployees(employees).filter((e) => e.status !== 'resigned');
    return departments
      .map((d) => ({ name: d.name, count: active.filter((e) => e.departmentId === d.id).length }))
      .filter((d) => d.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [employees, departments, scopeEmployees]);

  return (
    <ChartCard
      title="Headcount by department"
      description="Active and probation employees"
      icon={BarChart3}
    >
      {data.every((d) => d.count === 0) ? (
        <EmptyChart note="No active employees yet — add employees to see the distribution." />
      ) : (
        <ChartContainer config={headcountConfig} className="h-[240px] w-full">
          <BarChart data={data} margin={{ left: -16, right: 8, top: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="name" tickLine={false} axisLine={false} interval={0} angle={-18} textAnchor="end" height={54} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} maxBarSize={44} />
          </BarChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}

// ── 6-month payroll cost trend (line) ────────────────────────────────────────

const trendConfig = {
  cost: { label: 'Employer cost', color: '#b45309' },
} satisfies ChartConfig;

export function PayrollTrend() {
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');
  const { items: employees } = useCollection<Employee>('employees');

  const data = useMemo(
    () =>
      [...runs]
        .filter((r) => r.status === 'finalized')
        .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
        .slice(-6)
        .map((r) => ({ month: shortMonth(r.monthKey), cost: round2(r.totalEmployerCost) })),
    [runs],
  );

  return (
    <ChartCard
      title="Payroll cost trend"
      description="Total employer cost from finalized runs (last 6)"
      icon={TrendingUp}
    >
      {data.length === 0 ? (
        <EmptyChart
          note={`No payroll runs yet — the trend appears after the first run. Estimated current cost: ${fmtRM(
            estimateMonthlyEmployerCost(employees),
          )} / month.`}
        />
      ) : (
        <ChartContainer config={trendConfig} className="h-[240px] w-full">
          <LineChart data={data} margin={{ left: 8, right: 12, top: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="month" tickLine={false} axisLine={false} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
            />
            <ChartTooltip
              content={<ChartTooltipContent formatter={(value) => fmtRM(Number(value))} />}
            />
            <Line
              type="monotone"
              dataKey="cost"
              stroke="var(--color-cost)"
              strokeWidth={2}
              dot={{ r: 3, fill: 'var(--color-cost)' }}
            />
          </LineChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}

// ── Attendance rate, last 14 days (area) ─────────────────────────────────────

const attendanceConfig = {
  rate: { label: 'Attendance rate', color: '#f59e0b' },
} satisfies ChartConfig;

export function AttendanceRate() {
  const { scopeByEmployee } = useAuth();
  const { items: attendance } = useCollection<AttendanceRecord>('attendance');

  const data = useMemo(() => {
    const visible = scopeByEmployee(attendance, (a) => a.employeeId);
    const today = new Date();
    const days: { day: string; rate: number | null }[] = [];
    for (let i = 13; i >= 0; i--) {
      const iso = isoOf(addDays(today, -i));
      // Scheduled = working-day records; rest days, public holidays and
      // approved-leave days are excluded so leave cannot deflate the rate.
      const recs = visible.filter(
        (a) => a.date === iso && a.status !== 'rest-day' && a.status !== 'holiday' && a.status !== 'leave',
      );
      const present = recs.filter((a) => a.status === 'present').length;
      const half = recs.filter((a) => a.status === 'half-day').length;
      days.push({
        day: shortDate(iso),
        rate: recs.length === 0 ? null : Math.round(((present + half * 0.5) / recs.length) * 1000) / 10,
      });
    }
    return days;
  }, [attendance, scopeByEmployee]);

  const anyData = data.some((d) => d.rate !== null);

  return (
    <ChartCard
      title="Attendance rate"
      description="Share of scheduled staff present, last 14 days"
      icon={CalendarClock}
    >
      {!anyData ? (
        <EmptyChart note="No attendance records in the last 14 days." />
      ) : (
        <ChartContainer config={attendanceConfig} className="h-[240px] w-full">
          <AreaChart data={data} margin={{ left: -8, right: 12, top: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="day" tickLine={false} axisLine={false} interval={2} />
            <YAxis domain={[0, 100]} unit="%" tickLine={false} axisLine={false} width={44} />
            <ChartTooltip
              content={<ChartTooltipContent formatter={(value) => `${Number(value)}%`} />}
            />
            <Area
              type="monotone"
              dataKey="rate"
              stroke="var(--color-rate)"
              fill="var(--color-rate)"
              fillOpacity={0.18}
              strokeWidth={2}
              connectNulls
            />
          </AreaChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}

// ── Claims by category (donut) ───────────────────────────────────────────────

const claimsConfig = {
  travel: { label: 'Travel', color: '#92400e' },
  meal: { label: 'Meals', color: '#b45309' },
  medical: { label: 'Medical', color: '#d97706' },
  parking: { label: 'Parking', color: '#f59e0b' },
  telephone: { label: 'Telephone', color: '#fbbf24' },
  training: { label: 'Training', color: '#a8a29e' },
  other: { label: 'Other', color: '#d6d3d1' },
} satisfies ChartConfig;

export function ClaimsDonut() {
  const { scopeByEmployee } = useAuth();
  const { items: claims } = useCollection<Claim>('claims');

  const data = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const c of scopeByEmployee(claims, (cl) => cl.employeeId)) {
      byCat.set(c.category, (byCat.get(c.category) ?? 0) + c.amount);
    }
    return [...byCat.entries()]
      .map(([category, amount]) => ({
        category,
        amount: round2(amount),
        fill: `var(--color-${category})`,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [claims, scopeByEmployee]);

  const total = data.reduce((s, d) => s + d.amount, 0);
  const visibleCount = scopeByEmployee(claims, (c) => c.employeeId).length;

  return (
    <ChartCard
      title="Claims by category"
      description={`${visibleCount} claims on record, all statuses`}
      icon={Donut}
    >
      {data.length === 0 ? (
        <EmptyChart note="No claims yet — submitted expenses will be grouped here." />
      ) : (
        <div className="relative">
          <ChartContainer config={claimsConfig} className="mx-auto h-[240px] w-full">
            <PieChart>
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    nameKey="category"
                    hideLabel
                    formatter={(value) => fmtRM(Number(value))}
                  />
                }
              />
              <Pie
                data={data}
                dataKey="amount"
                nameKey="category"
                innerRadius="58%"
                outerRadius="85%"
                strokeWidth={2}
              >
                {data.map((d) => (
                  <Cell key={d.category} fill={d.fill} />
                ))}
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="category" />} />
            </PieChart>
          </ChartContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-8">
            <span className="text-xs text-muted-foreground">Total</span>
            <span className="text-lg font-semibold">{fmtRM(total)}</span>
          </div>
        </div>
      )}
    </ChartCard>
  );
}
