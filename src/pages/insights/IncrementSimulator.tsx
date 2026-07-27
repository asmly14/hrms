/**
 * M8 — Increment simulator.
 * Pick an employee, enter a proposed salary → live EPF/SOCSO/EIS/PCB deltas
 * from src/lib/statutory (plus HRD levy and total employer cost), so HR can
 * answer "what does a RM500 increment really cost?" in one glance.
 * Simulation only — nothing is persisted.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Calculator, PiggyBank, Wallet } from 'lucide-react';
import { useCollection } from '@/lib/db';
import * as payrollEngine from '@/lib/payrollEngine';
import { ytdFor } from '@/lib/payrollEngine';
import {
  MINIMUM_WAGE,
  PCB_RELIEFS,
  SOCSO_CEILING,
  annualTax,
  calcEIS,
  calcEPF,
  calcPCB,
  calcSOCSO,
  hrdfLevy,
} from '@/lib/statutory';
import { ageFromDob, cn, fmtRM, monthKey, round2 } from '@/lib/utils';
import type { Department, Employee, Payslip, Position } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

interface SimResult {
  gross: number;
  epfEE: number;
  epfER: number;
  socsoEE: number;
  socsoER: number;
  eisEE: number;
  eisER: number;
  pcb: number;
  hrd: number;
  net: number;
  cost: number;
}

type PcbYtd = { gross: number; epf: number; socso: number; pcb: number };

/**
 * The engine's TP3 carry-in helper (extracted from payrollEngine.ts this
 * wave). Documented signature: ytdForPcb(emp, month, grossPay, epfEE, socsoEE)
 * → the YTD to feed calcPCB for that candidate gross.
 */
type YtdForPcbFn = (
  emp: Employee,
  month: string,
  grossPay: number,
  epfEE: number,
  socsoEE: number,
) => PcbYtd;

const engineYtdForPcb = (payrollEngine as unknown as { ytdForPcb?: YtdForPcbFn }).ytdForPcb;

/**
 * Fallback replicating the engine's carry-in block (payrollEngine.ts) until
 * the core agent's ytdForPcb export lands: with no recorded runs before
 * `month`, assume the candidate package was earned since January so the
 * annualised PCB isn't understated mid-year. Each candidate gross gets its
 * own carry-in — this keeps the simulator identical to the engine (QA B1).
 */
function fallbackYtdForPcb(
  emp: Employee,
  ytdBase: ReturnType<typeof ytdFor>,
  monthIndex: number,
  grossPay: number,
  epfEE: number,
  socsoEE: number,
): PcbYtd {
  if (ytdBase.months === 0 && monthIndex > 1) {
    const m1 = monthIndex - 1;
    const n = 13 - monthIndex;
    const estGross = round2(grossPay * m1);
    const estEpf = round2(epfEE * m1);
    const estSocso = round2(socsoEE * m1);
    const epfRelief = Math.min(estEpf + epfEE * n, PCB_RELIEFS.epfCap);
    const socsoRelief = Math.min(estSocso + socsoEE * n, PCB_RELIEFS.socsoCap);
    const personal =
      PCB_RELIEFS.self +
      (emp.maritalStatus === 'married' ? PCB_RELIEFS.spouse : 0) +
      emp.children * PCB_RELIEFS.child;
    const taxEst = annualTax(Math.max(0, estGross + grossPay * n - epfRelief - socsoRelief - personal));
    return { gross: estGross, epf: estEpf, socso: estSocso, pcb: round2((taxEst * m1) / 12) };
  }
  return ytdBase;
}

interface SimRow {
  label: string;
  current: number;
  proposed: number;
  bold?: boolean;
  tone?: 'net' | 'cost';
}

const QUICK_PCTS = [3, 5, 8, 10];

const signedRM = (d: number) => (d >= 0 ? `+${fmtRM(d)}` : fmtRM(d));

export default function IncrementSimulator() {
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');
  const { items: payslips } = useCollection<Payslip>('payslips');

  const active = useMemo(() => employees.filter((e) => e.status !== 'resigned'), [employees]);
  const [empId, setEmpId] = useState('');
  const emp = active.find((e) => e.id === empId) ?? active[0];
  const [salaryInput, setSalaryInput] = useState('');

  useEffect(() => {
    setSalaryInput(emp ? String(emp.baseSalary) : '');
    // Reset the proposal whenever the selected employee changes.
  }, [emp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const proposed = Number(salaryInput);
  const valid = emp != null && salaryInput.trim() !== '' && Number.isFinite(proposed) && proposed > 0;

  const sim = useMemo<{ now: SimResult; next: SimResult } | null>(() => {
    if (!emp || !valid) return null;
    const age = ageFromDob(emp.dateOfBirth);
    const citizen = !emp.isForeignWorker;
    const allowances = round2((emp.fixedAllowances ?? []).reduce((s, a) => s + a.amount, 0));
    const month = monthKey();
    const monthIndex = Number(month.slice(5, 7));
    const ytd = ytdFor(emp.id, month);
    const numLocal = employees.filter((e) => !e.isForeignWorker && e.status !== 'resigned').length;

    const at = (base: number): SimResult => {
      const gross = round2(base + allowances);
      const epf = calcEPF(gross, age, citizen, emp.isForeignWorker);
      const socso = calcSOCSO(gross, age);
      const eis = calcEIS(gross, age, citizen);
      const socsoEE = round2(socso.employee + eis.employee);
      // QA B1: feed calcPCB the same TP3-style carry-in the engine applies, so
      // simulated PCB levels and deltas match a real payroll run even with no
      // payslip history yet. Prefers the engine's ytdForPcb; local replica is
      // the graceful fallback until that export lands.
      const ytdPcb = engineYtdForPcb
        ? engineYtdForPcb(emp, month, gross, epf.employee, socsoEE)
        : fallbackYtdForPcb(emp, ytd, monthIndex, gross, epf.employee, socsoEE);
      const pcb = calcPCB(gross, ytdPcb, {
        marital: emp.maritalStatus,
        children: emp.children,
        monthIndex,
        epfEmployee: epf.employee,
        socsoEmployee: socsoEE,
      });
      const hrd = hrdfLevy(gross, numLocal);
      return {
        gross,
        epfEE: epf.employee,
        epfER: epf.employer,
        socsoEE: socso.employee,
        socsoER: socso.employer,
        eisEE: eis.employee,
        eisER: eis.employer,
        pcb,
        hrd,
        net: round2(gross - epf.employee - socso.employee - eis.employee - pcb),
        cost: round2(gross + epf.employer + socso.employer + eis.employer + hrd),
      };
    };
    return { now: at(emp.baseSalary), next: at(proposed) };
  }, [emp, valid, proposed, employees, payslips]);

  if (employees.length > 0 && !emp) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Calculator />
          </EmptyMedia>
          <EmptyTitle>No active employees</EmptyTitle>
          <EmptyDescription>There is no active employee to simulate an increment for.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const rows: SimRow[] = sim
    ? [
        { label: 'Gross salary (basic + fixed allowances)', current: sim.now.gross, proposed: sim.next.gross },
        { label: 'EPF — employee', current: sim.now.epfEE, proposed: sim.next.epfEE },
        { label: 'SOCSO — employee', current: sim.now.socsoEE, proposed: sim.next.socsoEE },
        { label: 'EIS — employee', current: sim.now.eisEE, proposed: sim.next.eisEE },
        { label: 'PCB / MTD', current: sim.now.pcb, proposed: sim.next.pcb },
        { label: 'Net take-home pay', current: sim.now.net, proposed: sim.next.net, bold: true, tone: 'net' },
        { label: 'EPF — employer', current: sim.now.epfER, proposed: sim.next.epfER },
        { label: 'SOCSO — employer', current: sim.now.socsoER, proposed: sim.next.socsoER },
        { label: 'EIS — employer', current: sim.now.eisER, proposed: sim.next.eisER },
        { label: 'HRD Corp levy', current: sim.now.hrd, proposed: sim.next.hrd },
        { label: 'Total employer cost', current: sim.now.cost, proposed: sim.next.cost, bold: true, tone: 'cost' },
      ]
    : [];

  const costDelta = sim ? round2(sim.next.cost - sim.now.cost) : 0;
  const netDelta = sim ? round2(sim.next.net - sim.now.net) : 0;
  // QA B8: guard the ÷0 when the employee has a zero/blank base salary.
  const pct = emp && valid && emp.baseSalary > 0 ? ((proposed - emp.baseSalary) / emp.baseSalary) * 100 : 0;
  const belowMinWage = emp != null && valid && emp.employmentType === 'full-time' && proposed < MINIMUM_WAGE;
  const dept = emp ? departments.find((d) => d.id === emp.departmentId)?.name ?? '—' : '—';
  const posTitle = emp ? positions.find((p) => p.id === emp.positionId)?.title ?? '—' : '—';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Inputs */}
        <Card className="rounded-xl lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Propose an increment</CardTitle>
            <CardDescription>Statutory deltas update live as you type.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="sim-emp">Employee</Label>
              <Select value={emp?.id ?? ''} onValueChange={setEmpId}>
                <SelectTrigger id="sim-emp">
                  <SelectValue placeholder="Pick an employee" />
                </SelectTrigger>
                <SelectContent>
                  {active.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {emp && (
                <p className="text-xs text-muted-foreground">
                  {posTitle} · {dept} · current base {fmtRM(emp.baseSalary)}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="sim-salary">Proposed monthly base salary (RM)</Label>
              <Input
                id="sim-salary"
                inputMode="decimal"
                value={salaryInput}
                onChange={(e) => setSalaryInput(e.target.value)}
                placeholder="e.g. 5200"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {QUICK_PCTS.map((p) => (
                  <Button
                    key={p}
                    variant="outline"
                    size="sm"
                    disabled={!emp}
                    onClick={() => emp && setSalaryInput(String(Math.round(emp.baseSalary * (1 + p / 100))))}
                  >
                    +{p}%
                  </Button>
                ))}
              </div>
            </div>

            {emp && valid && (
              <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
                <span className="tabular-nums">{fmtRM(emp.baseSalary)}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium tabular-nums">{fmtRM(proposed)}</span>
                {emp.baseSalary > 0 && (
                  <Badge
                    className={cn(
                      'ml-auto border-transparent tabular-nums',
                      pct >= 0 ? 'bg-green-100 text-green-800 hover:bg-green-100' : 'bg-red-100 text-red-800 hover:bg-red-100',
                    )}
                  >
                    {pct >= 0 ? '+' : ''}
                    {pct.toFixed(1)}%
                  </Badge>
                )}
              </div>
            )}

            {belowMinWage && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-xs text-red-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  Below the national minimum wage of {fmtRM(MINIMUM_WAGE)}/month for full-time
                  employees (Minimum Wages Order 2024).
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Hero deltas */}
        <Card className="rounded-xl lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">What it really costs</CardTitle>
            <CardDescription>
              Employer cost vs employee take-home, per month, after statutory contributions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sim ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-1 rounded-xl border px-4 py-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Wallet className="h-3.5 w-3.5 text-amber-600" /> Employer cost
                  </div>
                  <p className="text-xl font-semibold tabular-nums">{signedRM(costDelta)}</p>
                  <p className="text-xs text-muted-foreground">per month</p>
                </div>
                <div className="space-y-1 rounded-xl border px-4 py-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <PiggyBank className="h-3.5 w-3.5 text-amber-600" /> Employee take-home
                  </div>
                  <p className="text-xl font-semibold tabular-nums">{signedRM(netDelta)}</p>
                  <p className="text-xs text-muted-foreground">per month, after EPF/SOCSO/EIS/PCB</p>
                </div>
                <div className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs text-amber-800">
                    <Calculator className="h-3.5 w-3.5" /> Annualised cost
                  </div>
                  <p className="text-xl font-semibold tabular-nums">{signedRM(round2(costDelta * 12))}</p>
                  <p className="text-xs text-amber-800/80">per year to the company</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Calculator className="h-6 w-6 text-amber-500" />
                <p className="text-sm font-medium">Enter a proposed salary</p>
                <p className="max-w-xs text-sm text-muted-foreground">
                  The simulator computes EPF, SOCSO, EIS, PCB and HRD levy for current vs proposed
                  salary and shows the deltas.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Breakdown table */}
      {sim && (
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle className="text-base">Statutory breakdown</CardTitle>
            <CardDescription>
              Current vs proposed for {emp?.name}. Excludes OT, unpaid-leave proration and claims
              reimbursements — figures may differ from a stored payslip for the same month.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Component</TableHead>
                    <TableHead className="text-right">Current</TableHead>
                    <TableHead className="text-right">Proposed</TableHead>
                    <TableHead className="text-right">Δ / month</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const d = round2(r.proposed - r.current);
                    return (
                      <TableRow
                        key={r.label}
                        className={cn(
                          r.bold && 'bg-muted/60 font-medium',
                          r.tone === 'cost' && 'border-t-2',
                        )}
                      >
                        <TableCell className={cn(r.bold && 'font-semibold')}>{r.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRM(r.current)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRM(r.proposed)}</TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            d === 0 && 'text-muted-foreground',
                            d > 0 && r.tone === 'net' && 'font-medium text-green-700',
                            d > 0 && r.tone === 'cost' && 'font-medium text-amber-700',
                            d < 0 && 'text-red-600',
                          )}
                        >
                          {d === 0 ? '—' : signedRM(d)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              Indicative simulation — nothing is saved. Rates come from src/lib/statutory.ts (EPF
              Third Schedule banding, SOCSO/EIS ceiling {fmtRM(SOCSO_CEILING)}, LHDN computerized
              PCB). PCB uses year-to-date figures from stored payslips for {monthKey()}; with no
              runs yet this year, a TP3-style carry-in estimate (current package since January) is
              applied — the same basis the payroll engine uses.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
