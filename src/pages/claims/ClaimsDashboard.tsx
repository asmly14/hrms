/**
 * Claims dashboard strip — KPI stat cards, current-month category donut
 * (recharts) and top claimants. Read-only; all figures derive from the
 * role-scoped claims passed in (company-wide for Admin/HR, department for
 * Manager, own claims only for Employee). Drafts never count toward KPIs,
 * the donut or the leaderboard — they are private work-in-progress.
 */
import { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { CircleDollarSign, Clock3, Hourglass, Wallet } from 'lucide-react';
import type { ClaimCategory, Employee } from '@/lib/types';
import { avatarTone, cn, daysBetween, fmtRM, initialsOf, monthKey, round2 } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CATEGORY_COLOR, CATEGORY_LABEL, type ClaimRecord } from './claimPolicy';

interface DonutSlice {
  key: ClaimCategory;
  label: string;
  value: number;
  color: string;
}

function DonutTooltip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: DonutSlice }>;
}) {
  const slice = props.active ? props.payload?.[0]?.payload : undefined;
  if (!slice) return null;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-medium text-foreground">{slice.label}</p>
      <p className="text-muted-foreground">{fmtRM(slice.value)} this month</p>
    </div>
  );
}

export default function ClaimsDashboard({
  claims,
  employees,
  hideLeaderboard = false,
}: {
  /** Already role-scoped by the page (Employee → own claims only, etc.). */
  claims: ClaimRecord[];
  employees: Employee[];
  /** Employee role: personal stats only — the cross-employee leaderboard is hidden. */
  hideLeaderboard?: boolean;
}) {
  const stats = useMemo(() => {
    const mk = monthKey();
    // Drafts are private work-in-progress, not claimed spend (B9).
    const countable = claims.filter((c) => c.status !== 'rejected' && c.status !== 'draft');
    const monthClaims = countable.filter((c) => c.claimDate.startsWith(mk));
    const monthTotal = round2(monthClaims.reduce((s, c) => s + c.amount, 0));

    const pending = claims.filter((c) => c.status === 'submitted');
    const pendingTotal = round2(pending.reduce((s, c) => s + c.amount, 0));

    const approved = claims.filter((c) => c.status === 'approved');
    const approvedTotal = round2(approved.reduce((s, c) => s + c.amount, 0));

    const decided = claims.filter(
      (c) => c.submittedAt && c.decidedAt && c.status !== 'draft' && c.status !== 'submitted',
    );
    const avgDays =
      decided.length > 0
        ? decided.reduce((s, c) => s + Math.max(0, daysBetween(c.submittedAt!, c.decidedAt!)), 0) /
          decided.length
        : 0;

    // Donut — current month totals by core category.
    const byCat = new Map<ClaimCategory, number>();
    for (const c of monthClaims) byCat.set(c.category, round2((byCat.get(c.category) ?? 0) + c.amount));
    const donut: DonutSlice[] = [...byCat.entries()]
      .map(([key, value]) => ({ key, label: CATEGORY_LABEL[key], value, color: CATEGORY_COLOR[key] }))
      .sort((a, b) => b.value - a.value);

    // Top claimants (all-time, excluding rejected).
    const byEmp = new Map<string, number>();
    for (const c of countable) byEmp.set(c.employeeId, round2((byEmp.get(c.employeeId) ?? 0) + c.amount));
    const top = [...byEmp.entries()]
      .map(([employeeId, total]) => ({ employeeId, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    return { monthClaims, monthTotal, pending, pendingTotal, approved, approvedTotal, decided, avgDays, donut, top };
  }, [claims]);

  const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? 'Unknown';
  const maxTop = stats.top[0]?.total ?? 0;

  const cards = [
    {
      title: `Claimed in ${monthKey()}`,
      value: fmtRM(stats.monthTotal),
      icon: CircleDollarSign,
      hint: `${stats.monthClaims.length} claim${stats.monthClaims.length === 1 ? '' : 's'} this month`,
    },
    {
      title: 'Pending approval',
      value: fmtRM(stats.pendingTotal),
      icon: Hourglass,
      hint: `${stats.pending.length} awaiting a decision`,
    },
    {
      title: 'Approved · awaiting payroll',
      value: fmtRM(stats.approvedTotal),
      icon: Wallet,
      hint: `${stats.approved.length} to be reimbursed in the next run`,
    },
    {
      title: 'Avg processing time',
      value: stats.decided.length === 0 ? '—' : stats.avgDays < 1 ? '< 1 day' : `${stats.avgDays.toFixed(1)} days`,
      icon: Clock3,
      hint: `${stats.decided.length} claim${stats.decided.length === 1 ? '' : 's'} decided (submit → decision)`,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((s) => (
          <Card key={s.title} className="rounded-xl">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.title}</CardTitle>
              <s.icon className="h-4 w-4 text-amber-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{s.value}</div>
              <p className="mt-1 text-xs text-muted-foreground">{s.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className={cn('rounded-xl', hideLeaderboard ? 'lg:col-span-5' : 'lg:col-span-3')}>
          <CardHeader>
            <CardTitle className="text-base">This month by category</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.donut.length === 0 ? (
              <div className="flex h-56 flex-col items-center justify-center gap-2 text-center">
                <CircleDollarSign className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No claims recorded this month yet.</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 sm:flex-row">
                <div className="relative h-56 w-56 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={stats.donut}
                        dataKey="value"
                        nameKey="label"
                        innerRadius={62}
                        outerRadius={92}
                        paddingAngle={2}
                        strokeWidth={0}
                      >
                        {stats.donut.map((d) => (
                          <Cell key={d.key} fill={d.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<DonutTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Total</span>
                    <span className="text-lg font-semibold">{fmtRM(stats.monthTotal)}</span>
                  </div>
                </div>
                <ul className="w-full space-y-2">
                  {stats.donut.map((d) => (
                    <li key={d.key} className="flex items-center gap-2 text-sm">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.label}</span>
                      <span className="font-medium tabular-nums">{fmtRM(d.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {!hideLeaderboard && (
          <Card className="rounded-xl lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Top claimants</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.top.length === 0 ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2 text-center">
                  <CircleDollarSign className="h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">Nothing claimed yet.</p>
                </div>
              ) : (
                <ul className="space-y-4">
                  {stats.top.map((t, i) => {
                    const name = empName(t.employeeId);
                    return (
                      <li key={t.employeeId} className="space-y-1.5">
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${avatarTone(name)}`}
                          >
                            {initialsOf(name)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            <span className="mr-1 text-xs text-muted-foreground">#{i + 1}</span>
                            {name}
                          </span>
                          <span className="text-sm font-medium tabular-nums">{fmtRM(t.total)}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-amber-600/80"
                            style={{ width: `${maxTop > 0 ? Math.max(4, (t.total / maxTop) * 100) : 0}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
