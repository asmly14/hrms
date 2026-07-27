/**
 * SuperAdmin → System overview: headline tenant stats (companies, employees,
 * status mix, estimated MRR) plus a headcount-per-company bar and a
 * companies-by-plan donut. All figures are read LIVE from each tenant's
 * namespaced storage via getCollection(name, tenantId).
 */
import { useMemo, type ReactNode } from 'react';
import {
  Activity, BarChart3, Building2, CircleDollarSign, Donut, PauseCircle,
  Sparkles, Users, type LucideIcon,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis,
} from 'recharts';
import { useTenant } from '@/lib/tenantContext';
import { fmtRM } from '@/lib/utils';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip,
  ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart';
import type { CompanyPlan } from '@/lib/types';
import { headcountOf, mrrOf, PLAN_LABELS, PLAN_RATES } from './lib';
import { EmptyState, StatCard } from './shared';

function ChartCard(props: {
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  const { title, description, icon: Icon, children } = props;
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

const headcountConfig = {
  count: { label: 'Employees', color: '#d97706' },
} satisfies ChartConfig;

const planConfig = {
  free: { label: PLAN_LABELS.free, color: '#a8a29e' },
  pro: { label: PLAN_LABELS.pro, color: '#d97706' },
  enterprise: { label: PLAN_LABELS.enterprise, color: '#92400e' },
} satisfies ChartConfig;

export default function OverviewSection() {
  const { companies } = useTenant();

  // Cross-tenant snapshot: re-read whenever the global directory changes
  // (create / edit / suspend / reseed all notify via TenantProvider).
  const stats = useMemo(() => {
    const rows = companies.map((company) => ({
      company,
      headcount: headcountOf(company.id),
      mrr: mrrOf(company),
    }));
    const byStatus = (s: string) => companies.filter((c) => c.status === s).length;
    return {
      rows,
      totalCompanies: companies.length,
      totalEmployees: rows.reduce((sum, r) => sum + r.headcount, 0),
      active: byStatus('active'),
      trial: byStatus('trial'),
      suspended: byStatus('suspended'),
      mrr: rows.reduce((sum, r) => sum + r.mrr, 0),
    };
  }, [companies]);

  const headcountData = useMemo(
    () =>
      stats.rows
        .map((r) => ({ name: r.company.code, count: r.headcount }))
        .sort((a, b) => b.count - a.count),
    [stats],
  );

  const planData = useMemo(() => {
    const counts = new Map<CompanyPlan, number>();
    for (const c of companies) counts.set(c.plan, (counts.get(c.plan) ?? 0) + 1);
    return (Object.keys(PLAN_LABELS) as CompanyPlan[])
      .filter((p) => (counts.get(p) ?? 0) > 0)
      .map((p) => ({ plan: p, count: counts.get(p) ?? 0, fill: `var(--color-${p})` }));
  }, [companies]);

  if (companies.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No companies yet"
        note="Create the first tenant from the Companies tab — the system overview comes alive once a company exists."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={Building2}
          label="Companies"
          value={String(stats.totalCompanies)}
          sub="tenants in the directory"
        />
        <StatCard
          icon={Users}
          label="Employees"
          value={String(stats.totalEmployees)}
          sub="non-resigned, all tenants"
          tone="bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300"
        />
        <StatCard
          icon={Activity}
          label="Active"
          value={String(stats.active)}
          sub="billed tenants"
          tone="bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-300"
        />
        <StatCard
          icon={Sparkles}
          label="Trial"
          value={String(stats.trial)}
          sub="evaluating"
          tone="bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300"
        />
        <StatCard
          icon={PauseCircle}
          label="Suspended"
          value={String(stats.suspended)}
          sub="access on hold"
          tone="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
        />
        <StatCard
          icon={CircleDollarSign}
          label="Est. MRR"
          value={`${fmtRM(stats.mrr)}`}
          sub={`Free RM0 · Pro RM${PLAN_RATES.pro} · Ent. RM${PLAN_RATES.enterprise} /emp/mo`}
          tone="bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="Headcount per company"
          description="Non-resigned employees, read live from each tenant"
          icon={BarChart3}
        >
          <ChartContainer config={headcountConfig} className="h-[260px] w-full">
            <BarChart data={headcountData} margin={{ left: -16, right: 8, top: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="name"
                tickLine={false}
                axisLine={false}
                interval={0}
                angle={-18}
                textAnchor="end"
                height={54}
              />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} maxBarSize={44} />
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="Companies by plan"
          description="Tenant distribution across billing plans"
          icon={Donut}
        >
          <div className="relative">
            <ChartContainer config={planConfig} className="mx-auto h-[260px] w-full">
              <PieChart>
                <ChartTooltip
                  content={<ChartTooltipContent nameKey="plan" hideLabel />}
                />
                <Pie
                  data={planData}
                  dataKey="count"
                  nameKey="plan"
                  innerRadius="58%"
                  outerRadius="85%"
                  strokeWidth={2}
                >
                  {planData.map((d) => (
                    <Cell key={d.plan} fill={d.fill} />
                  ))}
                </Pie>
                <ChartLegend content={<ChartLegendContent nameKey="plan" />} />
              </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-8">
              <span className="text-xs text-muted-foreground">Tenants</span>
              <span className="text-lg font-semibold">{stats.totalCompanies}</span>
            </div>
          </div>
        </ChartCard>
      </div>

      <p className="text-xs text-muted-foreground">
        MRR is an estimate: billable seats (non-resigned employees) × plan rate, active
        companies only. Trial and suspended tenants contribute RM 0.00.
      </p>
    </div>
  );
}
