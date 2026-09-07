/**
 * Salary report (/reports/salary) — multi-period salary analysis over
 * FINALIZED payroll runs: monthly / quarterly / half-yearly / yearly presets
 * or a custom month range.
 *
 * On-screen sections: period summary header (coverage + gap warning + period
 * totals), monthly trend chart (gross + net bars, employer-cost line), a
 * searchable per-employee table with per-month expansion rows, department
 * aggregation with a donut, and distribution insights (salary-band histogram
 * + top-10 earners). Exports: one multi-page PDF (lib/salaryReportPdf.ts —
 * jsPDF dynamically imported there, so this page adds nothing heavy to the
 * eager bundle) and a four-file CSV pack (summary / employees / monthly
 * trend / departments) via @/lib/csv.
 *
 * All aggregation is pure in `@/lib/salaryReports` — this page only wires
 * collections, picker state and rendering. Route-gated to Admin/HR with the
 * 'reports' module gate (App.tsx).
 */
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Download,
  FileDown,
  FileSpreadsheet,
  Loader2,
  Search,
} from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
} from 'recharts';
import { getActiveCompany, useCollection } from '@/lib/db';
import { downloadCsv } from '@/lib/csv';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn, fmtRM, monthKey } from '@/lib/utils';
import type { Department, Employee, PayrollRun, Payslip, Settings } from '@/lib/types';
import {
  aggregateSalaryReport,
  resolveSalaryPeriod,
  salaryMonthLabel,
  salaryReportCsvs,
  type SalaryEmployeeRow,
  type SalaryPeriodPreset,
} from '@/lib/salaryReports';
import { downloadSalaryReportPdf } from '@/lib/salaryReportPdf';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
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

// ─────────────────────────────────────────────────────────────────────────────
// Small display helpers
// ─────────────────────────────────────────────────────────────────────────────

const shortRM = (v: number) =>
  `RM ${Number(v).toLocaleString('en-MY', { maximumFractionDigits: 0 })}`;

const PRESET_LABELS: Record<SalaryPeriodPreset, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  'half-yearly': 'Half-yearly',
  yearly: 'Yearly',
  custom: 'Custom range',
};

/** Warm low-saturation donut palette (matches DeptCostChart). */
const DONUT_COLORS = ['#b45309', '#f59e0b', '#78716c', '#4d7c0f', '#ca8a04', '#9a3412', '#57534e'];

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function SalaryReportPage() {
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: settings } = useCollection<Settings>('settings');
  const company = getActiveCompany();

  // ── Period picker state ──
  const [preset, setPreset] = useState<SalaryPeriodPreset>('monthly');
  const [month, setMonth] = useState(monthKey());
  const [quarter, setQuarter] = useState<1 | 2 | 3 | 4>(1);
  const [half, setHalf] = useState<1 | 2>(1);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [from, setFrom] = useState(() => `${new Date().getFullYear()}-01`);
  const [to, setTo] = useState(monthKey());
  /** Until the user touches a picker, follow the latest finalized data month. */
  const [pickersTouched, setPickersTouched] = useState(false);

  /** Latest month with a finalized run — a sane default for the pickers. */
  const latestFinalizedMonth = useMemo(() => {
    const months = runs.filter((r) => r.status === 'finalized').map((r) => r.monthKey).sort();
    return months[months.length - 1] ?? null;
  }, [runs]);

  useEffect(() => {
    if (pickersTouched || !latestFinalizedMonth) return;
    const y = Number(latestFinalizedMonth.slice(0, 4));
    const m = Number(latestFinalizedMonth.slice(5, 7));
    setMonth(latestFinalizedMonth);
    setYear(y);
    setQuarter((Math.ceil(m / 3) as 1 | 2 | 3 | 4));
    setHalf(m <= 6 ? 1 : 2);
    setFrom(`${y}-01`);
    setTo(latestFinalizedMonth);
  }, [latestFinalizedMonth, pickersTouched]);

  /** Years present in payroll data (+ the current year), newest first. */
  const years = useMemo(() => {
    const set = new Set<number>([new Date().getFullYear()]);
    runs.forEach((r) => set.add(Number(r.monthKey.slice(0, 4))));
    payslips.forEach((p) => set.add(Number(p.monthKey.slice(0, 4))));
    return [...set].filter((y) => Number.isFinite(y)).sort((a, b) => b - a);
  }, [runs, payslips]);

  const period = useMemo(
    () => resolveSalaryPeriod({ preset, month, quarter, half, year, from, to }),
    [preset, month, quarter, half, year, from, to],
  );

  const model = useMemo(
    () =>
      period
        ? aggregateSalaryReport({
            period,
            runs,
            payslips,
            employees,
            departments,
            company,
            settings: settings.find((s) => s.id === 'company'),
          })
        : null,
    [period, runs, payslips, employees, departments, company, settings],
  );

  const csvFiles = useMemo(() => (model ? salaryReportCsvs(model) : []), [model]);

  // ── Export handlers ──
  const [generating, setGenerating] = useState(false);
  const handlePdf = async () => {
    if (!model || generating) return;
    setGenerating(true);
    try {
      const result = await downloadSalaryReportPdf(model);
      toastSuccess(
        `Salary report for ${model.period.label} downloaded`,
        `${result.pageCount} page(s), ${result.employeesPaid} employee(s) → ${result.fileName}`,
      );
    } catch (err) {
      toastError('PDF generation failed', err);
    } finally {
      setGenerating(false);
    }
  };

  const touch = <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      setPickersTouched(true);
      fn(...args);
    };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* Header + period picker */}
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-1">
          <Link to="/reports">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            All reports
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Salary report</h1>
        <p className="text-sm text-muted-foreground">
          Multi-period salary analysis — only <span className="font-medium">finalized</span> payroll
          runs count; draft runs and un-run months are excluded (and flagged).
        </p>
      </div>

      <Card className="rounded-xl">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
              <CalendarRange className="h-4 w-4" />
            </span>
            <div>
              <CardTitle className="text-base">Report period</CardTitle>
              <CardDescription>Pick a preset, then the exact window.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Preset</p>
            <Select value={preset} onValueChange={touch((v: string) => setPreset(v as SalaryPeriodPreset))}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRESET_LABELS) as SalaryPeriodPreset[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PRESET_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {preset === 'monthly' && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Month</p>
              <Input
                type="month"
                className="w-[160px]"
                value={month}
                onChange={touch((e: ChangeEvent<HTMLInputElement>) => setMonth(e.target.value))}
              />
            </div>
          )}

          {preset === 'quarterly' && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Quarter</p>
              <Select value={String(quarter)} onValueChange={touch((v: string) => setQuarter(Number(v) as 1 | 2 | 3 | 4))}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Q1 (Jan – Mar)</SelectItem>
                  <SelectItem value="2">Q2 (Apr – Jun)</SelectItem>
                  <SelectItem value="3">Q3 (Jul – Sep)</SelectItem>
                  <SelectItem value="4">Q4 (Oct – Dec)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {preset === 'half-yearly' && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Half</p>
              <Select value={String(half)} onValueChange={touch((v: string) => setHalf(Number(v) as 1 | 2))}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">H1 (Jan – Jun)</SelectItem>
                  <SelectItem value="2">H2 (Jul – Dec)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {(preset === 'quarterly' || preset === 'half-yearly' || preset === 'yearly') && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Year</p>
              <Select value={String(year)} onValueChange={touch((v: string) => setYear(Number(v)))}>
                <SelectTrigger className="w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {preset === 'custom' && (
            <>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">From month</p>
                <Input
                  type="month"
                  className="w-[160px]"
                  value={from}
                  onChange={touch((e: ChangeEvent<HTMLInputElement>) => setFrom(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">To month</p>
                <Input
                  type="month"
                  className="w-[160px]"
                  value={to}
                  onChange={touch((e: ChangeEvent<HTMLInputElement>) => setTo(e.target.value))}
                />
              </div>
            </>
          )}

          {period && (
            <Badge variant="secondary" className="mb-1 font-medium">
              {period.label} · {period.months.length} month{period.months.length === 1 ? '' : 's'}
            </Badge>
          )}
        </CardContent>
      </Card>

      {!period && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarRange />
            </EmptyMedia>
            <EmptyTitle>Pick a valid period</EmptyTitle>
            <EmptyDescription>
              The current selection does not resolve to a month window — for a custom range the
              start month must be on or before the end month.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {model && (
        <>
          {/* ── Summary header ── */}
          {model.hasGaps && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">
                  Coverage gap — {model.finalizedMonths.length} of {model.expectedMonths} months
                  finalized
                </p>
                <p className="mt-0.5 text-xs">
                  Payroll was not finalized for{' '}
                  {model.missingMonths.map(salaryMonthLabel).join(', ')}. Those months are excluded
                  from every total, chart and table below.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {(
              [
                ['Gross wages', model.totals.gross, `${model.payslipCount} payslips`],
                ['Net pay', model.totals.net, `incl. ${fmtRM(model.totals.claims)} claims`],
                ['Employer cost', model.totals.employerCost, 'gross + er. statutory + HRD'],
                ['EPF (ee + er)', model.totals.epfEmployee + model.totals.epfEmployer, 'KWSP'],
                ['SOCSO + EIS', model.totals.socsoEmployee + model.totals.socsoEmployer + model.totals.eisEmployee + model.totals.eisEmployer, 'PERKESO / SIP'],
                ['PCB + HRD', model.totals.pcb + model.totals.hrdLevy, 'MTD + HRD Corp levy'],
              ] as [string, number, string][]
            ).map(([label, value, sub]) => (
              <Card key={label} className="rounded-xl">
                <CardContent className="p-4">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{fmtRM(value)}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['Employees paid', String(model.employeesPaid), 'unique in period'],
                ['Months finalized', `${model.finalizedMonths.length}/${model.expectedMonths}`, model.hasGaps ? 'gaps — see warning' : 'full coverage'],
                ['Loans recovered', fmtRM(model.totals.loans), 'installments from net'],
                ['Claims reimbursed', fmtRM(model.totals.claims), 'non-statutory, in net'],
              ] as [string, string, string][]
            ).map(([label, value, sub]) => (
              <Card key={label} className="rounded-xl">
                <CardContent className="p-4">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {model.payslipCount === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileSpreadsheet />
                </EmptyMedia>
                <EmptyTitle>No finalized payroll in {model.period.label}</EmptyTitle>
                <EmptyDescription>
                  Salary reports read from the stored payslips of finalized runs. Run and finalize
                  payroll for these months from the Payroll module, then re-open this period.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {/* ── Trend chart ── */}
              <Card className="rounded-xl">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Monthly trend</CardTitle>
                  <CardDescription>
                    Gross and net pay per finalized month, with employer cost as the line. Gap
                    months show as zero.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={model.monthly} margin={{ top: 8, right: 16, bottom: 0, left: 8 }} barCategoryGap="28%">
                        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e7e5e4" />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis tickFormatter={shortRM} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={72} />
                        <Tooltip
                          formatter={(value: number, name: string) => [fmtRM(value), name]}
                          labelFormatter={(_l, payload) => {
                            const row = payload?.[0]?.payload as { month?: string; finalized?: boolean } | undefined;
                            if (!row?.month) return '';
                            return `${salaryMonthLabel(row.month)}${row.finalized ? '' : ' — not finalized'}`;
                          }}
                          cursor={{ fill: '#fafaf9' }}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="gross" name="Gross" fill="#f59e0b" isAnimationActive={false} />
                        <Bar dataKey="net" name="Net" fill="#4d7c0f" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                        <Line
                          type="monotone"
                          dataKey="employerCost"
                          name="Employer cost"
                          stroke="#b45309"
                          strokeWidth={2}
                          dot={{ r: 2.5 }}
                          isAnimationActive={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* ── Per-employee table ── */}
              <EmployeeTable rows={model.employees} />

              {/* ── Departments + donut ── */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="rounded-xl">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Department aggregation</CardTitle>
                    <CardDescription>
                      Period totals per department (unique employees paid, employer-cost share).
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Department</TableHead>
                            <TableHead className="text-right">Emps</TableHead>
                            <TableHead className="text-right">Gross</TableHead>
                            <TableHead className="text-right">Net</TableHead>
                            <TableHead className="text-right">Er. cost</TableHead>
                            <TableHead className="text-right">%</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {model.departments.map((d) => (
                            <TableRow key={d.departmentId || d.name}>
                              <TableCell className="font-medium">{d.name}</TableCell>
                              <TableCell className="text-right tabular-nums">{d.employees}</TableCell>
                              <TableCell className="text-right tabular-nums">{fmtRM(d.gross)}</TableCell>
                              <TableCell className="text-right tabular-nums">{fmtRM(d.net)}</TableCell>
                              <TableCell className="text-right tabular-nums">{fmtRM(d.employerCost)}</TableCell>
                              <TableCell className="text-right tabular-nums">{d.pctOfCost.toFixed(1)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-xl">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Employer cost share</CardTitle>
                    <CardDescription>Donut of the period&apos;s employer cost by department.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[280px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={model.departments}
                            dataKey="employerCost"
                            nameKey="name"
                            innerRadius="52%"
                            outerRadius="78%"
                            paddingAngle={2}
                            isAnimationActive={false}
                          >
                            {model.departments.map((d, i) => (
                              <Cell
                                key={d.departmentId || d.name}
                                fill={DONUT_COLORS[i % DONUT_COLORS.length]}
                              />
                            ))}
                          </Pie>
                          <Tooltip formatter={(value: number, name: string) => [fmtRM(value), name]} />
                          <Legend wrapperStyle={{ fontSize: 12 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* ── Distribution insights ── */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="rounded-xl">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Salary bands</CardTitle>
                    <CardDescription>
                      Employees banded by average monthly gross in the period (upper bounds
                      inclusive).
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[260px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={model.bands} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="24%">
                          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e7e5e4" />
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} axisLine={false} tickLine={false} />
                          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={32} />
                          <Tooltip formatter={(value: number) => [`${value} employee(s)`, 'Count']} cursor={{ fill: '#fafaf9' }} />
                          <Bar dataKey="count" name="Employees" fill="#b45309" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-xl">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Top earners</CardTitle>
                    <CardDescription>Top {model.topEarners.length} by period gross.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-8">#</TableHead>
                            <TableHead>Employee</TableHead>
                            <TableHead className="text-right">Months</TableHead>
                            <TableHead className="text-right">Gross</TableHead>
                            <TableHead className="text-right">Avg/mo</TableHead>
                            <TableHead className="text-right">Net</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {model.topEarners.map((r, i) => (
                            <TableRow key={r.employeeId}>
                              <TableCell className="tabular-nums">{i + 1}</TableCell>
                              <TableCell>
                                <span className="font-medium">{r.name}</span>
                                <span className="block text-xs text-muted-foreground">{r.department}</span>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{r.monthsPaid}</TableCell>
                              <TableCell className="text-right font-medium tabular-nums">{fmtRM(r.gross)}</TableCell>
                              <TableCell className="text-right tabular-nums">{fmtRM(r.avgMonthlyGross)}</TableCell>
                              <TableCell className="text-right tabular-nums">{fmtRM(r.net)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </>
          )}

          {/* ── Exports ── */}
          <Card className="rounded-xl">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Exports</CardTitle>
              <CardDescription>
                {model.payslipCount > 0
                  ? `One multi-page PDF report, plus the four-section CSV pack for ${model.period.label}.`
                  : 'Exports reflect the current (empty) period — finalize payroll months to fill them.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button onClick={handlePdf} disabled={generating}>
                {generating ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <FileDown className="mr-1.5 h-4 w-4" />
                )}
                PDF report
              </Button>
              {csvFiles.map((f) => (
                <Button
                  key={f.filename}
                  variant="outline"
                  onClick={() => {
                    downloadCsv(f.filename, f.csv);
                    toastSuccess('CSV downloaded', f.filename);
                  }}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {f.filename.endsWith('-summary.csv')
                    ? 'Summary CSV'
                    : f.filename.endsWith('-employees.csv')
                      ? 'Employees CSV'
                      : f.filename.endsWith('-monthly-trend.csv')
                        ? 'Monthly trend CSV'
                        : 'Departments CSV'}
                </Button>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-employee table (searchable, expandable per-month breakdown)
// ─────────────────────────────────────────────────────────────────────────────

function EmployeeTable({ rows }: { rows: SalaryEmployeeRow[] }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.employeeNo.toLowerCase().includes(q) ||
        r.department.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const COLS = 14;

  return (
    <Card className="rounded-xl">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Per-employee totals</CardTitle>
            <CardDescription>
              {filtered.length} of {rows.length} employee(s) · expand a row for the per-month
              breakdown.
            </CardDescription>
          </div>
          <div className="relative w-full md:w-64">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, no. or department…"
              className="pl-8"
              aria-label="Search employees"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Months</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">OT</TableHead>
                <TableHead className="text-right">Allow.</TableHead>
                <TableHead className="text-right">EPF ee</TableHead>
                <TableHead className="text-right">SOCSO ee</TableHead>
                <TableHead className="text-right">EIS ee</TableHead>
                <TableHead className="text-right">PCB</TableHead>
                <TableHead className="text-right">Loans</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">Er. cost</TableHead>
                <TableHead className="text-right">Avg gross</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => {
                const open = expanded.has(r.employeeId);
                return (
                  <EmployeeRows
                    key={r.employeeId}
                    row={r}
                    open={open}
                    onToggle={() => toggle(r.employeeId)}
                    colSpan={COLS}
                  />
                );
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={COLS} className="py-8 text-center text-sm text-muted-foreground">
                    No employees match “{query}”.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function EmployeeRows({
  row: r,
  open,
  onToggle,
  colSpan,
}: {
  row: SalaryEmployeeRow;
  open: boolean;
  onToggle: () => void;
  colSpan: number;
}) {
  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={onToggle}
        aria-expanded={open}
        data-testid={`salary-emp-${r.employeeId}`}
      >
        <TableCell className="w-8">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </TableCell>
        <TableCell>
          <span className="font-medium">{r.name}</span>
          <span className="block text-xs text-muted-foreground">
            {r.employeeNo} · {r.department}
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums">{r.monthsPaid}</TableCell>
        <TableCell className="text-right font-medium tabular-nums">{fmtRM(r.gross)}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtRM(r.ot)}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtRM(r.allowances)}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtRM(r.epfEmployee)}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtRM(r.socsoEmployee)}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtRM(r.eisEmployee)}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtRM(r.pcb)}</TableCell>
        <TableCell className={cn('text-right tabular-nums', r.loans > 0 && 'text-amber-700')}>
          {fmtRM(r.loans)}
        </TableCell>
        <TableCell className="text-right tabular-nums">{fmtRM(r.net)}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtRM(r.employerCost)}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtRM(r.avgMonthlyGross)}</TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={colSpan} className="p-0">
            <div className="px-6 py-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Per-month breakdown — {r.name} (finalized months only)
              </p>
              <div className="overflow-x-auto rounded-md border bg-card">
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">EPF ee</TableHead>
                      <TableHead className="text-right">PCB</TableHead>
                      <TableHead className="text-right">Loans</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                      <TableHead className="text-right">Er. cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.monthly.map((m) => (
                      <TableRow key={m.month}>
                        <TableCell className="font-medium">{salaryMonthLabel(m.month)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRM(m.gross)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRM(m.epfEmployee)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRM(m.pcb)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRM(m.loans)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRM(m.net)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRM(m.employerCost)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
