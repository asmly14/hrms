/**
 * Year-end statutory pack (/payroll/year-end) — the annual LHDN employer
 * filings, aggregated from FINALIZED payslips only (lib/yearEnd.ts):
 *
 *  - Form E  — employer return of remuneration (company totals + employee
 *              count), due 31 March, e-Filing grace typically 30 April;
 *  - CP8D    — per-employee remuneration listing filed together with Form E;
 *  - CP21    — leaver notification dataset (resignDate within the year),
 *              event-driven under ITA s.83 (≥ 30 days before cessation).
 *
 * Each dataset is previewed in-page and downloadable as CSV via @/lib/csv;
 * Form E additionally has a print-friendly view (same PrintAreaStyles
 * pattern as EAForm). A readiness checklist flags missing statutory numbers,
 * months without finalized runs and employees with no payslips before filing.
 * No statutory rate is recomputed here — figures come from stored payslips.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, Download, FileText,
  Printer, Wallet, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCollection } from '@/lib/db';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtRM, round2 } from '@/lib/utils';
import type {
  Employee, PayrollRun, Payslip, Settings as CompanySettings,
} from '@/lib/types';
import { OFFBOARDING_REASON_LABELS, type OffboardingCase } from '@/lib/lifecycle';
import {
  aggregateFinalizedYear, buildCp21Rows, buildCp8dRows, buildFormESummary,
  buildReadinessChecklist, cp21Csv, cp8dCsv, formECsv, yearEndDeadlines,
} from '@/lib/yearEnd';
import { monthLabel } from './helpers';
import { Money, PrintAreaStyles } from './components';
import { canSeeSensitive, useAuthSafe } from '@/lib/useAuthSafe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

const PRINT_AREA = 'form-e-print-area';

function detail(label: string, value: string) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground print-text-muted">{label}</p>
      <p className="text-sm font-medium">{value || '—'}</p>
    </div>
  );
}

function row(label: string, value: string) {
  return (
    <tr className="border-b border-dashed last:border-0">
      <td className="py-1.5 pr-2 text-sm">{label}</td>
      <td className="py-1.5 text-right text-sm font-medium tabular-nums">{value}</td>
    </tr>
  );
}

/** Warning badge with the full messages on hover (CP8D / CP21 rows). */
function WarningsBadge({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Badge
      variant="outline"
      className="ml-2 border-amber-400 text-amber-700 dark:text-amber-500"
      title={warnings.join('\n')}
    >
      <AlertTriangle className="mr-1 h-3 w-3" />
      {warnings.length} warning{warnings.length > 1 ? 's' : ''}
    </Badge>
  );
}

export default function YearEndPack() {
  const auth = useAuthSafe();
  const showSensitive = canSeeSensitive(auth);
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');
  const { items: employees } = useCollection<Employee>('employees');
  const { items: settingsItems } = useCollection<CompanySettings>('settings');
  const { items: offboardingCases } = useCollection<OffboardingCase>('offboardingCases');

  const years = useMemo(() => {
    const set = new Set<string>(payslips.map((p) => p.monthKey.slice(0, 4)));
    set.add(String(new Date().getFullYear()));
    return [...set].sort().reverse();
  }, [payslips]);

  const [year, setYear] = useState<string>('');
  const effYear = year || years[0] || String(new Date().getFullYear());

  const settings = settingsItems[0];

  // ── Aggregation (finalized payslips only) ────────────────────────────
  const totals = useMemo(
    () => aggregateFinalizedYear(payslips, runs, effYear),
    [payslips, runs, effYear],
  );
  const formE = useMemo(
    () => buildFormESummary(totals, runs, payslips, effYear),
    [totals, runs, payslips, effYear],
  );
  const cp8dRows = useMemo(() => buildCp8dRows(totals, employees), [totals, employees]);
  const reasons = useMemo(
    () =>
      new Map<string, string>(
        offboardingCases.map((c) => [c.employeeId, OFFBOARDING_REASON_LABELS[c.reason] ?? c.reason]),
      ),
    [offboardingCases],
  );
  const cp21Rows = useMemo(
    () => buildCp21Rows(employees, totals, effYear, reasons),
    [employees, totals, effYear, reasons],
  );
  const readiness = useMemo(
    () =>
      buildReadinessChecklist({
        year: effYear, employees, totals, runs, payslips, settings,
      }),
    [effYear, employees, totals, runs, payslips, settings],
  );
  const deadlines = useMemo(() => yearEndDeadlines(effYear), [effYear]);

  const mask = (v: string) => (showSensitive ? v || '—' : '••••••');

  const dl = (filename: string, csv: string) => {
    downloadCsv(filename, csv);
    toast.success('Download started', { description: filename });
  };

  // ── Deadline banner tone ─────────────────────────────────────────────
  const banner = useMemo(() => {
    const nextYear = String(Number(effYear) + 1);
    if (deadlines.daysToEFileGrace < 0) {
      return {
        tone: 'overdue' as const,
        title: `Form E + CP8D for ${effYear} are overdue`,
        body: `The statutory deadline (31 March ${nextYear}) and the e-Filing grace period (30 April ${nextYear}) have both passed. File immediately via MyTax e-Filing — non-filing is an offence under ITA s.120.`,
      };
    }
    if (deadlines.daysToFormEDue < 0) {
      return {
        tone: 'grace' as const,
        title: `Statutory deadline passed — e-Filing grace until 30 April ${nextYear}`,
        body: `31 March ${nextYear} has passed, but LHDN typically grants e-Filing grace until 30 April ${nextYear} (${deadlines.daysToEFileGrace} day(s) left). File online now.`,
      };
    }
    return {
      tone: 'upcoming' as const,
      title: `Form E + CP8D due 31 March ${nextYear} (${deadlines.daysToFormEDue} day(s) left)`,
      body: `Submit via MyTax e-Filing by 31 March ${nextYear}; the e-Filing grace period typically runs to 30 April ${nextYear}. CP21 for leavers is event-driven — notify LHDN at least 30 days before cessation.`,
    };
  }, [deadlines, effYear]);

  const socsoTotal = (ee: number, er: number) => round2(ee + er);

  return (
    <div className="space-y-6">
      <PrintAreaStyles areaClass={PRINT_AREA} />

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <FileText className="h-6 w-6 text-amber-600" /> Year-end statutory pack
          </h1>
          <p className="text-sm text-muted-foreground">
            Form E, CP8D and CP21 aggregated from finalized payslips — the employer's
            annual LHDN filings for a year of assessment.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="-ml-2" asChild>
            <Link to="/payroll">
              <ArrowLeft className="h-4 w-4" /> Payroll
            </Link>
          </Button>
          <Select value={effYear} onValueChange={setYear}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Year" />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={y}>YA {y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Due-date banner ────────────────────────────────────────── */}
      <Alert
        className={
          banner.tone === 'overdue'
            ? 'border-red-300 bg-red-50 dark:border-red-900/40 dark:bg-red-950/30 print:hidden'
            : banner.tone === 'grace'
              ? 'border-amber-400 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30 print:hidden'
              : 'border-amber-200 bg-amber-50/60 dark:border-amber-900/30 dark:bg-amber-950/20 print:hidden'
        }
      >
        <CalendarClock
          className={`h-4 w-4 ${banner.tone === 'overdue' ? 'text-red-600' : 'text-amber-600'}`}
        />
        <AlertTitle
          className={
            banner.tone === 'overdue'
              ? 'text-red-800 dark:text-red-400'
              : 'text-amber-800 dark:text-amber-500'
          }
        >
          {banner.title}
        </AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          {banner.body}
        </AlertDescription>
      </Alert>

      {/* ── Readiness checklist ────────────────────────────────────── */}
      <Card className="rounded-xl print:hidden">
        <CardHeader>
          <CardTitle className="text-base">Filing readiness — {effYear}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 sm:grid-cols-2">
            {readiness.map((item) => (
              <li key={item.key} className="flex items-start gap-2.5 rounded-lg border p-3">
                {item.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                )}
                <div>
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {totals.length === 0 ? (
        <Card className="rounded-xl print:hidden">
          <CardContent>
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50">
                <Wallet className="h-6 w-6" />
              </span>
              <div>
                <p className="font-medium">No finalized payslips in {effYear}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  The year-end pack aggregates finalized payroll runs only. Run payroll and
                  finalize the months of {effYear} first — draft runs never enter annual returns.
                </p>
              </div>
              <Button variant="outline" asChild>
                <Link to="/payroll">Go to payroll</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="form-e" className="print:hidden">
          <TabsList>
            <TabsTrigger value="form-e">Form E</TabsTrigger>
            <TabsTrigger value="cp8d">CP8D ({cp8dRows.length})</TabsTrigger>
            <TabsTrigger value="cp21">CP21 ({cp21Rows.length})</TabsTrigger>
          </TabsList>

          {/* ── Form E ─────────────────────────────────────────────── */}
          <TabsContent value="form-e" className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Employer return of remuneration — LHDN e-Filing helper figures.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => dl(`form-e-${effYear}.csv`, formECsv(formE, settings))}
                >
                  <Download className="h-4 w-4" /> CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    toast.info('Opening print dialog…', {
                      description: `Form E ${effYear}. Choose "Save as PDF" to keep a copy.`,
                    });
                    window.print();
                  }}
                >
                  <Printer className="h-4 w-4" /> Print
                </Button>
              </div>
            </div>

            {formE.monthsMissingFinalized.length > 0 && (
              <Alert className="border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertTitle className="text-amber-800 dark:text-amber-500">
                  {formE.monthsMissingFinalized.length} month(s) not finalized
                </AlertTitle>
                <AlertDescription className="text-xs text-muted-foreground">
                  {formE.monthsMissingFinalized.map(monthLabel).join(', ')}{' '}
                  {formE.monthsMissingFinalized.length === 1 ? 'has' : 'have'} no finalized run —
                  the figures below exclude {formE.monthsMissingFinalized.length === 1 ? 'it' : 'them'}.
                </AlertDescription>
              </Alert>
            )}

            <div className={`${PRINT_AREA} rounded-xl border bg-card p-6`}>
              <div className="text-center">
                <p className="text-xs uppercase tracking-wide text-muted-foreground print-text-muted">
                  Borang E · Employer return
                </p>
                <p className="text-base font-semibold">
                  Return of Remuneration by an Employer — Year of Assessment {effYear}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground print-text-muted">
                  Income Tax Act 1967 s.83 · due 31 March {Number(effYear) + 1} · e-Filing grace
                  to 30 April {Number(effYear) + 1} · filed together with CP8D
                </p>
              </div>

              <Separator className="my-4" />

              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                {detail('Employer', settings?.companyName ?? 'ASM Tech Sdn Bhd')}
                {detail('SSM registration no.', settings?.companyRegNo ?? '—')}
                {detail('Employer E no.', settings?.taxEmployerNo ?? '—')}
                {detail('EPF employer no.', settings?.epfEmployerNo ?? '—')}
                {detail('SOCSO employer no.', settings?.socsoEmployerNo ?? '—')}
                {detail('Address', settings?.address ?? '—')}
              </div>

              <p className="mt-5 text-sm font-semibold">Return summary</p>
              <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                {detail('Employees per CP8D', String(formE.employeeCount))}
                {detail('Payslip-months aggregated', String(formE.payslipMonths))}
                {detail('Months finalized', String(formE.monthsFinalized))}
              </div>

              <div className="mt-5 grid gap-6 md:grid-cols-2">
                <div>
                  <p className="text-sm font-semibold">Remuneration (whole company)</p>
                  <table className="mt-2 w-full">
                    <tbody>
                      {row('Salary, wages & leave pay', fmtRM(formE.remuneration.salary))}
                      {row('Fixed allowances', fmtRM(formE.remuneration.allowances))}
                      {row('Overtime payments', fmtRM(formE.remuneration.overtime))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t font-semibold">
                        <td className="py-1.5 text-sm">Total gross remuneration</td>
                        <td className="py-1.5 text-right text-sm tabular-nums">
                          {fmtRM(formE.remuneration.gross)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                  {formE.remuneration.claims > 0 && (
                    <p className="mt-2 text-[11px] text-muted-foreground print-text-muted">
                      Memo: {fmtRM(formE.remuneration.claims)} of non-taxable claim reimbursements
                      were paid during {effYear} — excluded from remuneration.
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-sm font-semibold">Statutory deductions & contributions</p>
                  <table className="mt-2 w-full">
                    <tbody>
                      {row('Monthly tax deductions (PCB/MTD)', fmtRM(formE.pcb))}
                      {row('EPF — employee share', fmtRM(formE.epfEmployee))}
                      {row('EPF — employer share', fmtRM(formE.epfEmployer))}
                      {row('SOCSO — employee + employer', fmtRM(socsoTotal(formE.socsoEmployee, formE.socsoEmployer)))}
                      {row('EIS (SIP) — employee + employer', fmtRM(socsoTotal(formE.eisEmployee, formE.eisEmployer)))}
                      {row('HRD Corp levy', fmtRM(formE.hrdLevy))}
                      {row('Net pay disbursed', fmtRM(formE.net))}
                      {row('Total employer cost', fmtRM(formE.employerCost))}
                    </tbody>
                  </table>
                </div>
              </div>

              <Separator className="my-4" />
              <div className="flex items-end justify-between">
                <p className="max-w-sm text-[11px] text-muted-foreground print-text-muted">
                  Prepared from computerized payroll records (finalized runs only). Cross-checked
                  against EA forms and CP39 remittances before submission via MyTax e-Filing.
                </p>
                <div className="text-center">
                  <div className="h-10 w-44 border-b border-foreground/40" />
                  <p className="mt-1 text-[11px] text-muted-foreground print-text-muted">
                    Employer / authorized officer
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* ── CP8D ───────────────────────────────────────────────── */}
          <TabsContent value="cp8d" className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Employee remuneration listing filed with Form E — annual totals per employee,
                matching each employee's EA form.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => dl(`cp8d-${effYear}.csv`, cp8dCsv(cp8dRows))}
              >
                <Download className="h-4 w-4" /> CSV
              </Button>
            </div>

            <Card className="rounded-xl">
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">No</TableHead>
                      <TableHead>Employee</TableHead>
                      <TableHead>NRIC</TableHead>
                      <TableHead>Income tax no.</TableHead>
                      <TableHead className="text-right">Mo.</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">EPF ee</TableHead>
                      <TableHead className="text-right">EPF er</TableHead>
                      <TableHead className="text-right">SOCSO ee+er</TableHead>
                      <TableHead className="text-right">EIS ee+er</TableHead>
                      <TableHead className="text-right">PCB</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cp8dRows.map((r) => (
                      <TableRow key={r.employeeId}>
                        <TableCell>{r.no}</TableCell>
                        <TableCell className="font-medium">
                          {r.name}
                          <WarningsBadge warnings={r.warnings} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{mask(r.ic)}</TableCell>
                        <TableCell className="text-muted-foreground">{mask(r.taxNo)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.months}</TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(r.grossRemuneration)}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(r.epfEmployee)}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(r.epfEmployer)}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(socsoTotal(r.socsoEmployee, r.socsoEmployer))}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(socsoTotal(r.eisEmployee, r.eisEmployer))}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(r.pcb)}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(r.netPay)}</Money></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={5}>Total ({formE.employeeCount} employees)</TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(formE.remuneration.gross)}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(formE.epfEmployee)}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(formE.epfEmployer)}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(socsoTotal(formE.socsoEmployee, formE.socsoEmployer))}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(socsoTotal(formE.eisEmployee, formE.eisEmployer))}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(formE.pcb)}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(formE.net)}</Money></TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── CP21 ───────────────────────────────────────────────── */}
          <TabsContent value="cp21" className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="max-w-2xl text-sm text-muted-foreground">
                Leaver notification (ITA s.83) — employees who left during {effYear}. Notify LHDN
                at least 30 days before cessation / departure and withhold monies due pending tax
                clearance.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={cp21Rows.length === 0}
                onClick={() => dl(`cp21-${effYear}.csv`, cp21Csv(cp21Rows))}
              >
                <Download className="h-4 w-4" /> CSV
              </Button>
            </div>

            <Card className="rounded-xl">
              <CardContent className="pt-6">
                {cp21Rows.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                    <p className="font-medium">No leavers in {effYear}</p>
                    <p className="text-sm text-muted-foreground">
                      Nobody has a resignation date falling inside {effYear} — nothing to notify.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">No</TableHead>
                        <TableHead>Employee</TableHead>
                        <TableHead>NRIC</TableHead>
                        <TableHead>Income tax no.</TableHead>
                        <TableHead>Leaving date</TableHead>
                        <TableHead>Final pay month</TableHead>
                        <TableHead className="text-right">Final net pay</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cp21Rows.map((r) => (
                        <TableRow key={r.employeeId}>
                          <TableCell>{r.no}</TableCell>
                          <TableCell className="font-medium">
                            {r.name}
                            <WarningsBadge warnings={r.warnings} />
                          </TableCell>
                          <TableCell className="text-muted-foreground">{mask(r.ic)}</TableCell>
                          <TableCell className="text-muted-foreground">{mask(r.taxNo)}</TableCell>
                          <TableCell>{fmtDate(r.leavingDate)}</TableCell>
                          <TableCell>{r.finalMonth === '—' ? '—' : monthLabel(r.finalMonth)}</TableCell>
                          <TableCell className="text-right">
                            <Money>{r.finalNet === null ? '—' : fmtRM(r.finalNet)}</Money>
                          </TableCell>
                          <TableCell>{r.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
