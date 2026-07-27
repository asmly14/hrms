/**
 * M8 — Compare states tool.
 * One salary, re-expressed across all 16 states/FT at purchasing-power parity
 * (colAdjustedSalary on the Numbeo-based COL index, KUL = 100), with COL index
 * bars and a federal take-home note: EPF/SOCSO/EIS/PCB are identical in every
 * state — only living costs move.
 */
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Info, MapPin, Wallet } from 'lucide-react';
import { states } from '@/lib/holidays';
import { COST_OF_LIVING, colAdjustedSalary } from '@/lib/salaryBenchmark';
import { calcEIS, calcEPF, calcPCB, calcSOCSO } from '@/lib/statutory';
import { cn, fmtRM, round2 } from '@/lib/utils';
import type { StateCode } from '@/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const shortRM = (v: number) => `RM ${Number(v).toLocaleString('en-MY', { maximumFractionDigits: 0 })}`;

interface CompareRow {
  state: StateCode;
  stateName: string;
  index: number;
  basket: number;
  adjusted: number;
  estimated: boolean;
}

export default function StateCompareTool() {
  const [salaryInput, setSalaryInput] = useState('5000');
  const [fromState, setFromState] = useState<StateCode>('KUL');

  const amount = Number(salaryInput);
  const valid = salaryInput.trim() !== '' && Number.isFinite(amount) && amount > 0;

  const rows = useMemo<CompareRow[]>(() => {
    if (!valid) return [];
    return COST_OF_LIVING.map((c) => ({
      state: c.state,
      stateName: c.stateName,
      index: c.index,
      basket: c.basket,
      adjusted: colAdjustedSalary(amount, fromState, c.state),
      estimated: c.estimated,
    })).sort((a, b) => b.index - a.index);
  }, [amount, valid, fromState]);

  /**
   * Federal take-home estimate — statutory deductions do not vary by state.
   * Assumes: Malaysian citizen, below 60, single, no children, January with
   * no prior YTD (standard LHDN annualised PCB).
   */
  const takeHome = useMemo(() => {
    if (!valid) return null;
    const epf = calcEPF(amount, 30, true, false);
    const socso = calcSOCSO(amount, 30);
    const eis = calcEIS(amount, 30, true);
    const pcb = calcPCB(
      amount,
      { gross: 0, epf: 0, socso: 0, pcb: 0 },
      {
        marital: 'single',
        children: 0,
        monthIndex: 1,
        epfEmployee: epf.employee,
        socsoEmployee: round2(socso.employee + eis.employee),
      },
    );
    return {
      epf: epf.employee,
      socso: socso.employee,
      eis: eis.employee,
      pcb,
      net: round2(amount - epf.employee - socso.employee - eis.employee - pcb),
    };
  }, [amount, valid]);

  const fromName = states.find((s) => s.code === fromState)?.name ?? fromState;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* Inputs + take-home note */}
      <Card className="rounded-xl lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Compare states</CardTitle>
          <CardDescription>
            What is this salary worth in living-cost terms elsewhere in Malaysia?
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="cmp-salary">Monthly gross salary (RM)</Label>
            <Input
              id="cmp-salary"
              inputMode="decimal"
              value={salaryInput}
              onChange={(e) => setSalaryInput(e.target.value)}
              placeholder="e.g. 5000"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cmp-from">Currently paid in</Label>
            <Select value={fromState} onValueChange={(v) => setFromState(v as StateCode)}>
              <SelectTrigger id="cmp-from">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {states.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {takeHome && (
            <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
                <Wallet className="h-4 w-4" /> Take-home is the same in every state
              </div>
              <p className="text-2xl font-semibold tabular-nums text-amber-900">
                {fmtRM(takeHome.net)}
                <span className="ml-1 text-sm font-normal text-amber-800/80">/ month</span>
              </p>
              <p className="text-xs text-amber-900/80">
                On {fmtRM(amount)} gross: EPF −{fmtRM(takeHome.epf)}, SOCSO −{fmtRM(takeHome.socso)},
                EIS −{fmtRM(takeHome.eis)}, PCB −{fmtRM(takeHome.pcb)}. EPF, SOCSO, EIS and PCB are
                federal schemes — identical nationwide. Only the cost of living changes by state.
                Estimate assumes a single Malaysian employee, no children, below 60.
              </p>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              Conversion uses the pure cost-of-living ratio (Numbeo basket, Kuala Lumpur = 100).
              Wage <em>offers</em> vary less than living costs — the salary suggestion tool applies
              the researched wage-market factors instead.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Chart + index bars */}
      <Card className="rounded-xl lg:col-span-3">
        <CardHeader>
          <CardTitle className="text-base">
            {valid ? `${shortRM(amount)} from ${fromName}, state by state` : 'Enter a salary'}
          </CardTitle>
          <CardDescription>
            Equivalent gross in each state to keep the same purchasing power (KUL = 100).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {valid && rows.length > 0 ? (
            <>
              <div className="h-[260px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" vertical={false} />
                    <XAxis dataKey="state" tick={{ fontSize: 10 }} interval={0} />
                    <YAxis
                      width={48}
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: number) => `${Math.round(Number(v) / 1000)}k`}
                    />
                    <Tooltip
                      formatter={(value, _name, item) => [
                        fmtRM(Number(value)),
                        `${(item.payload as CompareRow).stateName} (index ${(item.payload as CompareRow).index})`,
                      ]}
                    />
                    <Bar dataKey="adjusted" name="Equivalent salary" radius={[6, 6, 0, 0]}>
                      {rows.map((r) => (
                        <Cell key={r.state} fill={r.state === fromState ? '#d97706' : '#fbbf24'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="space-y-1.5">
                {rows.map((r) => (
                  <div
                    key={r.state}
                    className={cn(
                      'grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 sm:grid-cols-[160px_1fr_110px_110px]',
                      r.state === fromState && 'bg-amber-50',
                    )}
                  >
                    <p className="text-sm font-medium">
                      {r.stateName}
                      {r.estimated && <span className="text-amber-600"> *</span>}
                      {r.state === fromState && (
                        <span className="ml-1.5 text-xs font-normal text-amber-700">(current)</span>
                      )}
                    </p>
                    <div className="col-span-2 h-2 overflow-hidden rounded-full bg-stone-200 sm:col-span-1">
                      <div
                        className={cn('h-full rounded-full', r.state === fromState ? 'bg-amber-600' : 'bg-amber-400')}
                        style={{ width: `${Math.min(100, r.index)}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums sm:text-right">
                      index {r.index}
                    </p>
                    <p className="text-sm font-semibold tabular-nums sm:text-right">{shortRM(r.adjusted)}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                * Components partly estimated (sparse Numbeo coverage) — treat as ±15%. COL index
                and baskets: single-person modest standard, accessed Jul 2026.
              </p>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <MapPin className="h-6 w-6 text-amber-500" />
              <p className="text-sm font-medium">Enter a monthly gross salary</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                The tool converts it across all 16 states and federal territories at
                purchasing-power parity.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
