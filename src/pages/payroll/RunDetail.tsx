/**
 * Payroll run detail — per-employee payslip table with totals, warnings
 * panel, and the statutory outputs tab (EPF/SOCSO/EIS/CP39/HRD + bank giro).
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, ChevronRight, Search, Users, Wallet,
} from 'lucide-react';
import { useCollection } from '@/lib/db';
import { fmtDate, fmtRM, round2 } from '@/lib/utils';
import type {
  Employee, PayrollRun, Payslip, Settings as CompanySettings,
} from '@/lib/types';
import { empById, monthLabel } from './helpers';
import StatutoryOutputs from './StatutoryOutputs';
import { Money } from './components';
import { canSeeSensitive, useAuthSafe } from './useAuthSafe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

export default function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuthSafe();
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { items: employees } = useCollection<Employee>('employees');
  const { items: settingsItems } = useCollection<CompanySettings>('settings');
  const [query, setQuery] = useState('');

  const run = runs.find((r) => r.id === id);
  const empMap = useMemo(() => empById(employees), [employees]);
  const slips = useMemo(() => payslips.filter((p) => p.runId === id), [payslips, id]);

  // B2 — IC / bank details are HR-only; managers and employees never see them
  // on run rows (pre-integration, when auth is absent, behaviour is unchanged).
  const showSensitive = canSeeSensitive(auth);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return slips.filter((p) => {
      const e = empMap.get(p.employeeId);
      return `${e?.name ?? ''} ${e?.ic ?? ''}`.toLowerCase().includes(q);
    });
  }, [slips, empMap, query]);

  // B9 — footer totals follow the active filter so visible rows foot exactly.
  const totals = useMemo(() => {
    const sum = (fn: (p: Payslip) => number) => round2(filtered.reduce((s, p) => s + fn(p), 0));
    return {
      basic: sum((p) => p.basicPay),
      allowances: sum((p) => p.allowances),
      ot: sum((p) => p.otPay),
      gross: sum((p) => p.grossPay),
      epfEe: sum((p) => p.epfEmployee),
      epfEr: sum((p) => p.epfEmployer),
      socsoEe: sum((p) => p.socsoEmployee),
      socsoEr: sum((p) => p.socsoEmployer),
      eisEe: sum((p) => p.eisEmployee),
      eisEr: sum((p) => p.eisEmployer),
      pcb: sum((p) => p.pcb),
      hrd: sum((p) => p.hrdLevy),
      net: sum((p) => p.netPay),
      cost: sum((p) => p.employerCost),
    };
  }, [filtered]);

  if (!run) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <Wallet className="h-10 w-10 text-muted-foreground" />
        <p className="font-medium">Payroll run not found</p>
        <p className="text-sm text-muted-foreground">
          It may have been replaced by a re-run of the same month.
        </p>
        <Button variant="outline" asChild>
          <Link to="/payroll">
            <ArrowLeft className="h-4 w-4" /> Back to payroll
          </Link>
        </Button>
      </div>
    );
  }

  const stat = (label: string, value: string) => (
    <Card className="rounded-xl">
      <CardContent className="pt-5">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Button variant="ghost" size="sm" className="-ml-2" asChild>
            <Link to="/payroll">
              <ArrowLeft className="h-4 w-4" /> Payroll
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            Payroll run — {monthLabel(run.monthKey)}
          </h1>
          <p className="text-sm text-muted-foreground">
            Run {fmtDate(run.runAt)} by {run.runBy} ·{' '}
            <Badge variant={run.status === 'finalized' ? 'secondary' : 'outline'}>{run.status}</Badge>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stat('Employees', String(run.employeeCount))}
        {stat('Total gross', fmtRM(run.totalGross))}
        {stat('Total net pay', fmtRM(run.totalNet))}
        {stat('Employer cost', fmtRM(run.totalEmployerCost))}
      </div>

      {run.warnings.length > 0 && (
        <Alert className="border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-800 dark:text-amber-500">
            {run.warnings.length} compliance warning(s)
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {run.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="payslips">
        <TabsList>
          <TabsTrigger value="payslips">Payslips</TabsTrigger>
          <TabsTrigger value="statutory">Statutory outputs & bank giro</TabsTrigger>
        </TabsList>

        <TabsContent value="payslips" className="space-y-4">
          <div className="relative max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter by name or IC…"
              className="pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {slips.length === 0 ? (
            <Card className="rounded-xl">
              <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
                <Users className="h-8 w-8 text-muted-foreground" />
                <p className="font-medium">No payslips in this run</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right">Basic</TableHead>
                      <TableHead className="text-right">Allowances</TableHead>
                      <TableHead className="text-right">OT</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">EPF ee/er</TableHead>
                      <TableHead className="text-right">SOCSO ee/er</TableHead>
                      <TableHead className="text-right">EIS ee/er</TableHead>
                      <TableHead className="text-right">PCB</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                      <TableHead className="text-right">Employer cost</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <Link
                            to={`/payroll/payslip/${p.id}`}
                            className="font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-500"
                          >
                            {empMap.get(p.employeeId)?.name ?? 'Unknown'}
                          </Link>
                          <span className="block text-xs text-muted-foreground">
                            {showSensitive ? empMap.get(p.employeeId)?.ic : '—'}
                          </span>
                        </TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(p.basicPay)}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(p.allowances)}</Money></TableCell>
                        <TableCell className="text-right">
                          <Money>{fmtRM(p.otPay)}</Money>
                          {p.otHours > 0 && (
                            <span className="block text-xs text-muted-foreground">{p.otHours}h</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(p.grossPay)}</Money></TableCell>
                        <TableCell className="text-right">
                          <Money>{fmtRM(p.epfEmployee)}</Money>
                          <span className="text-muted-foreground"> / </span>
                          <Money>{fmtRM(p.epfEmployer)}</Money>
                        </TableCell>
                        <TableCell className="text-right">
                          <Money>{fmtRM(p.socsoEmployee)}</Money>
                          <span className="text-muted-foreground"> / </span>
                          <Money>{fmtRM(p.socsoEmployer)}</Money>
                        </TableCell>
                        <TableCell className="text-right">
                          <Money>{fmtRM(p.eisEmployee)}</Money>
                          <span className="text-muted-foreground"> / </span>
                          <Money>{fmtRM(p.eisEmployer)}</Money>
                        </TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(p.pcb)}</Money></TableCell>
                        <TableCell className="text-right font-medium"><Money>{fmtRM(p.netPay)}</Money></TableCell>
                        <TableCell className="text-right"><Money>{fmtRM(p.employerCost)}</Money></TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/payroll/payslip/${p.id}`}>
                              <ChevronRight className="h-4 w-4" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>
                        Total (
                        {filtered.length === slips.length
                          ? slips.length
                          : `${filtered.length} of ${slips.length}`}
                        )
                      </TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(totals.basic)}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(totals.allowances)}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(totals.ot)}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(totals.gross)}</Money></TableCell>
                      <TableCell className="text-right">
                        <Money>{fmtRM(totals.epfEe)}</Money>
                        <span className="text-muted-foreground"> / </span>
                        <Money>{fmtRM(totals.epfEr)}</Money>
                      </TableCell>
                      <TableCell className="text-right">
                        <Money>{fmtRM(totals.socsoEe)}</Money>
                        <span className="text-muted-foreground"> / </span>
                        <Money>{fmtRM(totals.socsoEr)}</Money>
                      </TableCell>
                      <TableCell className="text-right">
                        <Money>{fmtRM(totals.eisEe)}</Money>
                        <span className="text-muted-foreground"> / </span>
                        <Money>{fmtRM(totals.eisEr)}</Money>
                      </TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(totals.pcb)}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(totals.net)}</Money></TableCell>
                      <TableCell className="text-right"><Money>{fmtRM(totals.cost)}</Money></TableCell>
                      <TableCell />
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>

              {/* Mobile cards */}
              <div className="space-y-3 md:hidden">
                {filtered.map((p) => (
                  <Link
                    key={p.id}
                    to={`/payroll/payslip/${p.id}`}
                    className="block rounded-xl border p-4 transition-colors hover:bg-accent"
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{empMap.get(p.employeeId)?.name ?? 'Unknown'}</p>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Gross</p>
                        <p className="tabular-nums">{fmtRM(p.grossPay)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">PCB</p>
                        <p className="tabular-nums">{fmtRM(p.pcb)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Net</p>
                        <p className="font-medium tabular-nums">{fmtRM(p.netPay)}</p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
              {filtered.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No employees match "{query}".
                </p>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="statutory">
          <StatutoryOutputs
            run={run}
            slips={slips}
            empMap={empMap}
            settings={settingsItems[0]}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
