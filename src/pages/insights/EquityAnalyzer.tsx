/**
 * M8 — Internal equity analyzer.
 * Every employee's salary vs the suggestSalary median for their matched
 * role/state/seniority: compa-ratio column (color-coded), a salary vs
 * years-of-service scatter with the benchmark band, and department averages.
 * Benchmarks come from @/lib/salaryBenchmark — indicative market estimates.
 */
import { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipProps } from 'recharts';
import { Info } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { suggestSalary } from '@/lib/salaryBenchmark';
import { cn, fmtRM, round2 } from '@/lib/utils';
import type { Department, Employee, Position } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type CompaStatus = 'below' | 'in' | 'above';

const compaStatus = (c: number): CompaStatus => (c < 0.9 ? 'below' : c > 1.1 ? 'above' : 'in');

const COMPA_STYLE: Record<CompaStatus, { badge: string; dot: string; label: string }> = {
  below: { badge: 'border-transparent bg-red-100 text-red-800 hover:bg-red-100', dot: '#dc2626', label: 'Below range' },
  in: { badge: 'border-transparent bg-green-100 text-green-800 hover:bg-green-100', dot: '#16a34a', label: 'In range' },
  above: { badge: 'border-transparent bg-amber-100 text-amber-800 hover:bg-amber-100', dot: '#d97706', label: 'Above range' },
};

interface EquityRow {
  id: string;
  name: string;
  dept: string;
  deptId: string;
  role: string;
  years: number;
  salary: number;
  median: number;
  compa: number;
  matchedRole: string;
  status: CompaStatus;
}

interface BandPoint {
  years: number;
  min: number;
  median: number;
  max: number;
  bandBase: number;
  bandSpan: number;
}

interface ScatterPoint {
  id: string;
  name: string;
  role: string;
  years: number;
  salary: number;
  compa: number;
}

const ALL_ROLES = '__all';

/** Seniority prefixes are stripped so "Senior Software Engineer" hits the "Software Engineer" benchmark. */
const normalizeTitle = (title: string) => title.replace(/^(senior|junior|lead)\s+/i, '');

function EquityTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload.find((p) => p.dataKey === 'salary')?.payload as ScatterPoint | undefined;
  const band = payload.find((p) => p.dataKey === 'bandSpan')?.payload as BandPoint | undefined;
  return (
    <div className="max-w-[220px] rounded-lg border bg-card px-3 py-2 text-xs shadow-md">
      {point ? (
        <div className="space-y-0.5">
          <p className="font-semibold">{point.name}</p>
          <p className="text-muted-foreground">
            {point.role} · {point.years} yrs service
          </p>
          <p className="tabular-nums">
            {fmtRM(point.salary)} · compa-ratio {point.compa.toFixed(2)}
          </p>
        </div>
      ) : band ? (
        <div className="space-y-0.5">
          <p className="font-semibold">Benchmark @ {band.years} yrs</p>
          <p className="tabular-nums">
            {fmtRM(band.min)} – {fmtRM(band.max)}
          </p>
          <p className="text-muted-foreground tabular-nums">median {fmtRM(band.median)}</p>
        </div>
      ) : null}
    </div>
  );
}

export default function EquityAnalyzer() {
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');

  const [deptFilter, setDeptFilter] = useState(ALL_ROLES);
  const [scatterRole, setScatterRole] = useState(ALL_ROLES);

  const rows = useMemo<EquityRow[]>(
    () =>
      employees
        .filter((e) => e.status !== 'resigned')
        .map((e) => {
          const pos = positions.find((p) => p.id === e.positionId);
          const dept = departments.find((d) => d.id === e.departmentId);
          const years = Math.round(((Date.now() - Date.parse(e.joinDate)) / (365.25 * 86_400_000)) * 10) / 10;
          const title = pos?.title ?? 'Staff';
          const s = suggestSalary(normalizeTitle(title), years, e.state, dept?.name);
          const compa = s.median > 0 ? e.baseSalary / s.median : 1;
          return {
            id: e.id,
            name: e.name,
            dept: dept?.name ?? '—',
            deptId: e.departmentId,
            role: title,
            years,
            salary: e.baseSalary,
            median: s.median,
            compa,
            matchedRole: s.matchedRole,
            status: compaStatus(compa),
          };
        })
        .sort((a, b) => a.compa - b.compa),
    [employees, positions, departments],
  );

  const filtered = useMemo(
    () => (deptFilter === ALL_ROLES ? rows : rows.filter((r) => r.deptId === deptFilter)),
    [rows, deptFilter],
  );

  const counts = useMemo(
    () => ({
      below: rows.filter((r) => r.status === 'below').length,
      in: rows.filter((r) => r.status === 'in').length,
      above: rows.filter((r) => r.status === 'above').length,
    }),
    [rows],
  );

  /** Benchmark band at the Klang-Valley baseline (×1.00) so the shape is comparable. */
  const band = useMemo<BandPoint[]>(() => {
    const roleForBand = scatterRole === ALL_ROLES ? 'All roles (generic)' : scatterRole;
    return Array.from({ length: 21 }, (_, y) => {
      const s = suggestSalary(roleForBand, y, 'KUL');
      return {
        years: y,
        min: s.min,
        median: s.median,
        max: s.max,
        bandBase: s.min,
        bandSpan: s.max - s.min,
      };
    });
  }, [scatterRole]);

  const scatterPoints = useMemo<ScatterPoint[]>(
    () =>
      rows
        .filter((r) => scatterRole === ALL_ROLES || r.matchedRole === scatterRole)
        .map((r) => ({ id: r.id, name: r.name, role: r.role, years: r.years, salary: r.salary, compa: r.compa })),
    [rows, scatterRole],
  );

  const matchedRoles = useMemo(
    () => [...new Set(rows.map((r) => r.matchedRole))].sort(),
    [rows],
  );

  const deptStats = useMemo(
    () =>
      departments
        .map((d) => {
          const rs = rows.filter((r) => r.deptId === d.id);
          if (rs.length === 0) return null;
          return {
            code: d.code,
            name: d.name,
            headcount: rs.length,
            avgSalary: round2(rs.reduce((s, r) => s + r.salary, 0) / rs.length),
            avgMedian: round2(rs.reduce((s, r) => s + r.median, 0) / rs.length),
            avgCompa: rs.reduce((s, r) => s + r.compa, 0) / rs.length,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [departments, rows],
  );

  return (
    <div className="space-y-6">
      {/* Summary chips */}
      <div className="grid grid-cols-3 gap-3">
        {(['below', 'in', 'above'] as const).map((k) => (
          <Card key={k} className="rounded-xl">
            <CardContent className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-2xl font-semibold tabular-nums">{counts[k]}</p>
                <p className="text-xs text-muted-foreground">{COMPA_STYLE[k].label}</p>
              </div>
              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: COMPA_STYLE[k].dot }} />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Scatter with benchmark band */}
      <Card className="rounded-xl">
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">Salary vs years of service</CardTitle>
              <CardDescription>
                Each dot is an employee, colored by compa-ratio; the band is the benchmark range.
              </CardDescription>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Benchmark band for</Label>
              <Select value={scatterRole} onValueChange={setScatterRole}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_ROLES}>All roles (generic band)</SelectItem>
                  {matchedRoles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={band} margin={{ top: 8, right: 16, bottom: 24, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" vertical={false} />
                <XAxis
                  dataKey="years"
                  type="number"
                  domain={[0, 20]}
                  tickCount={11}
                  tick={{ fontSize: 11 }}
                  label={{ value: 'Years of service', position: 'insideBottom', offset: -14, fontSize: 11 }}
                />
                <YAxis
                  type="number"
                  domain={[0, 'auto']}
                  width={44}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => `${Math.round(Number(v) / 1000)}k`}
                />
                <Tooltip content={<EquityTooltip />} />
                <Area dataKey="bandBase" stackId="band" stroke="none" fill="transparent" isAnimationActive={false} />
                <Area dataKey="bandSpan" stackId="band" stroke="none" fill="#fef3c7" name="Benchmark band" />
                <Line
                  dataKey="median"
                  stroke="#d97706"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  dot={false}
                  name="Benchmark median"
                />
                <Scatter data={scatterPoints} dataKey="salary" name="Employees">
                  {scatterPoints.map((p) => (
                    <Cell key={p.id} fill={COMPA_STYLE[compaStatus(p.compa)].dot} fillOpacity={0.85} />
                  ))}
                </Scatter>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted-foreground">
            Band = {scatterRole === ALL_ROLES ? 'generic Malaysian benchmark' : `${scatterRole} benchmark`} at the
            Klang Valley baseline (×1.00); individual rows below apply each employee&apos;s own state wage factor.
            Dots: red below range (compa &lt; 0.90), green in range (0.90–1.10), amber above (&gt; 1.10).
          </p>
        </CardContent>
      </Card>

      {/* Department averages */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Department averages</CardTitle>
          <CardDescription>Average base salary vs average benchmark median.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={deptStats} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" vertical={false} />
                <XAxis dataKey="code" tick={{ fontSize: 11 }} />
                <YAxis
                  width={44}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => `${Math.round(Number(v) / 1000)}k`}
                />
                <Tooltip
                  formatter={(value, name) => [
                    fmtRM(Number(value)),
                    name === 'avgSalary' ? 'Avg salary' : 'Avg benchmark median',
                  ]}
                />
                <Bar dataKey="avgSalary" name="Avg salary" fill="#f59e0b" radius={[6, 6, 0, 0]} />
                <Bar dataKey="avgMedian" name="Avg benchmark median" fill="#d6d3d1" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-amber-500" /> Avg salary
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-stone-300" /> Avg benchmark median
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {deptStats.map((d) => (
              <div key={d.code} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                <div>
                  <p className="font-medium">{d.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.headcount} staff · avg {fmtRM(d.avgSalary)}
                  </p>
                </div>
                <Badge className={cn('font-medium tabular-nums', COMPA_STYLE[compaStatus(d.avgCompa)].badge)}>
                  {d.avgCompa.toFixed(2)}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Compa-ratio table */}
      <Card className="rounded-xl">
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">Employee compa-ratios</CardTitle>
              <CardDescription>
                Salary ÷ benchmark median for the matched role, state and seniority. Sorted lowest first.
              </CardDescription>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Department</Label>
              <Select value={deptFilter} onValueChange={setDeptFilter}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_ROLES}>All departments</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Yrs</TableHead>
                  <TableHead className="text-right">Salary</TableHead>
                  <TableHead className="text-right">Benchmark median</TableHead>
                  <TableHead className="text-right">Δ vs median</TableHead>
                  <TableHead className="text-right">Compa-ratio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => {
                  const delta = round2(r.salary - r.median);
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <p className="font-medium">{r.name}</p>
                        <p className="text-xs text-muted-foreground">{r.dept}</p>
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.role}
                        {r.matchedRole !== r.role && r.matchedRole !== 'Generic' && (
                          <span className="block text-xs text-muted-foreground">benchmark: {r.matchedRole}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.years}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtRM(r.salary)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtRM(r.median)}</TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          delta < 0 ? 'text-red-600' : delta > 0 ? 'text-amber-700' : 'text-muted-foreground',
                        )}
                      >
                        {delta >= 0 ? '+' : ''}
                        {fmtRM(delta)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge className={cn('font-medium tabular-nums', COMPA_STYLE[r.status].badge)}>
                          {r.compa.toFixed(2)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {filtered.map((r) => (
              <div key={r.id} className="space-y-2 rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{r.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.role} · {r.dept} · {r.years} yrs
                    </p>
                  </div>
                  <Badge className={cn('font-medium tabular-nums', COMPA_STYLE[r.status].badge)}>
                    {r.compa.toFixed(2)}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-sm">
                  <p className="text-xs text-muted-foreground">Salary</p>
                  <p className="text-right tabular-nums">{fmtRM(r.salary)}</p>
                  <p className="text-xs text-muted-foreground">Benchmark median</p>
                  <p className="text-right tabular-nums">{fmtRM(r.median)}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              Benchmarks are indicative market estimates from the researched 2025–2026 dataset
              (62 roles × 13 industries, Klang-Valley baseline — not a paid survey). Matching
              uses the job title — seniority prefixes stripped — with a department fallback;
              resigned employees are excluded.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
