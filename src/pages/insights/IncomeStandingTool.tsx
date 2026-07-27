/**
 * M8 — "Where does this salary stand?" tool.
 * Places a monthly gross income on the DOSM HIS 2024 B40/M40/T20 ladder
 * (with B1–T2 sub-bands), compares it with the national median individual
 * wage, the state's own thresholds and the state's household deciles, and
 * flags the T15 subsidy-policy zone. Household-based DOSM classes applied to
 * an individual salary — disclosed as a proxy in the UI.
 */
import { useMemo, useState } from 'react';
import { Flag, Info, Landmark, Scale } from 'lucide-react';
import { states } from '@/lib/holidays';
import {
  NATIONAL_MEDIAN_WAGE,
  STATE_INCOME_THRESHOLDS,
  incomeClass,
  stateDecilePlacement,
  type IncomeBand,
} from '@/lib/salaryBenchmark';
import { cn, fmtRM } from '@/lib/utils';
import type { StateCode } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
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

const BAND_STYLE: Record<IncomeBand, { badge: string; blurb: string }> = {
  B40: {
    badge: 'border-transparent bg-stone-200 text-stone-800 hover:bg-stone-200',
    blurb: 'Bottom 40% of Malaysian households (up to RM5,859/month).',
  },
  M40: {
    badge: 'border-transparent bg-amber-100 text-amber-800 hover:bg-amber-100',
    blurb: 'Middle 40% of Malaysian households (RM5,860–12,679/month).',
  },
  T20: {
    badge: 'border-transparent bg-green-100 text-green-800 hover:bg-green-100',
    blurb: 'Top 20% of Malaysian households (RM12,680+/month).',
  },
};

/** Scale is drawn 0 → RM20k; incomes above are pinned to the end. */
const SCALE_MAX = 20000;
const B40_CEILING = 5859;
const T20_FLOOR = 12680;

export default function IncomeStandingTool() {
  const [salaryInput, setSalaryInput] = useState('5000');
  const [state, setState] = useState<StateCode>('KUL');

  const amount = Number(salaryInput);
  const valid = salaryInput.trim() !== '' && Number.isFinite(amount) && amount >= 0;

  const result = useMemo(() => (valid ? incomeClass(amount) : null), [amount, valid]);
  const placement = useMemo(
    () => (valid ? stateDecilePlacement(amount, state) : null),
    [amount, valid, state],
  );
  const stateThresholds = STATE_INCOME_THRESHOLDS[state];
  const stateName = states.find((s) => s.code === state)?.name ?? state;
  const markerPct = valid ? Math.min(100, (amount / SCALE_MAX) * 100) : 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* Inputs + verdict */}
      <Card className="rounded-xl lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Where does this salary stand?</CardTitle>
          <CardDescription>
            DOSM household-income classification (HIS 2024), with national and state context.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="stand-salary">Monthly gross income (RM)</Label>
            <Input
              id="stand-salary"
              inputMode="decimal"
              value={salaryInput}
              onChange={(e) => setSalaryInput(e.target.value)}
              placeholder="e.g. 5000"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="stand-state">State (for local context)</Label>
            <Select value={state} onValueChange={(v) => setState(v as StateCode)}>
              <SelectTrigger id="stand-state">
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

          {result && (
            <div className="space-y-3 rounded-xl border px-4 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={cn('px-3 py-1 text-base font-semibold', BAND_STYLE[result.band].badge)}>
                  {result.band}
                </Badge>
                <Badge variant="outline" className="px-2.5 py-1 text-sm">
                  Sub-group {result.subBand}
                </Badge>
                {result.t15Zone && (
                  <Badge className="border-transparent bg-red-100 text-red-800 hover:bg-red-100">
                    <Flag className="mr-1 h-3 w-3" /> T15 policy zone
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{BAND_STYLE[result.band].blurb}</p>
              <p className="text-sm">
                <span className="font-semibold tabular-nums">{result.vsNationalMedian.toFixed(2)}×</span>{' '}
                the national median individual wage ({fmtRM(result.nationalMedian)}, DOSM 2024).
              </p>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              DOSM classes are defined on <strong>household</strong> gross income — applying them to
              an individual salary is a proxy. A dual-income household of two RM4,000 earners is
              M40, not B40. Figures ignore household size and dependents.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Scale + state context */}
      <Card className="rounded-xl lg:col-span-3">
        <CardHeader>
          <CardTitle className="text-base">National ladder &amp; state context</CardTitle>
          <CardDescription>
            B40/M40/T20 thresholds (HIS {result?.surveyYear ?? 2024}) and where the income lands in{' '}
            {stateName}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {valid && result ? (
            <>
              {/* National scale */}
              <div className="space-y-2">
                <div className="relative h-8 w-full overflow-hidden rounded-full">
                  <div className="absolute inset-y-0 left-0 bg-stone-300" style={{ width: `${(B40_CEILING / SCALE_MAX) * 100}%` }} />
                  <div
                    className="absolute inset-y-0 bg-amber-300"
                    style={{
                      left: `${(B40_CEILING / SCALE_MAX) * 100}%`,
                      width: `${((T20_FLOOR - B40_CEILING) / SCALE_MAX) * 100}%`,
                    }}
                  />
                  <div
                    className="absolute inset-y-0 bg-green-300"
                    style={{
                      left: `${(T20_FLOOR / SCALE_MAX) * 100}%`,
                      width: `${((SCALE_MAX - T20_FLOOR) / SCALE_MAX) * 100}%`,
                    }}
                  />
                  <div
                    className="absolute inset-y-0 w-1 bg-stone-900"
                    style={{ left: `calc(${markerPct}% - 2px)` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>RM 0</span>
                  <span>B40 ends {fmtRM(B40_CEILING)}</span>
                  <span>T20 from {fmtRM(T20_FLOOR)}</span>
                  <span>RM 20k+</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  The dark marker is this income on the national household ladder.
                </p>
              </div>

              {/* Context cards */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 rounded-xl border px-4 py-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Landmark className="h-4 w-4 text-amber-600" /> National context
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Median individual wage {fmtRM(NATIONAL_MEDIAN_WAGE)}/month (DOSM Salaries &amp;
                    Wages 2024). 27.4% of formal-sector employees earned below RM2,000 (Mar 2025).
                  </p>
                </div>
                <div className="space-y-1.5 rounded-xl border px-4 py-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Scale className="h-4 w-4 text-amber-600" /> {stateName} context
                  </div>
                  <p className="text-sm text-muted-foreground">
                    On the {stateName} household ladder this sits at the D{placement?.decile} rung
                    (median {fmtRM(placement?.decileMedian ?? 0)}) — higher than roughly{' '}
                    {Math.round(((placement?.decile ?? 1) - 1) * 10)}% of households in the state.
                  </p>
                  {stateThresholds?.b40Ceiling != null && (
                    <p className="text-sm text-muted-foreground">
                      {stateName} B40 ceiling: {fmtRM(stateThresholds.b40Ceiling)} — this income is{' '}
                      {amount > stateThresholds.b40Ceiling ? 'above' : 'within'} it.
                    </p>
                  )}
                  {stateThresholds?.t20Floor != null && (
                    <p className="text-sm text-muted-foreground">
                      {stateName} T20 floor: {fmtRM(stateThresholds.t20Floor)} — this income is{' '}
                      {amount >= stateThresholds.t20Floor
                        ? `${fmtRM(amount - stateThresholds.t20Floor)} above it`
                        : `${fmtRM(stateThresholds.t20Floor - amount)} below it`}
                      .
                    </p>
                  )}
                </div>
              </div>

              {result.t15Zone && (
                <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-xs text-red-800">
                  <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p>
                    T15 policy zone (≈RM14,000+/month household, HIS 2024): the Budget 2025–2026
                    subsidy-retargeting band used for measures like BUDI95 RON95 eligibility.
                    Thresholds are under government review (locality and household size may be
                    incorporated) — treat this as a policy flag, not a stable statistic.
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Scale className="h-6 w-6 text-amber-500" />
              <p className="text-sm font-medium">Enter a monthly gross income</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                The tool places it on the B40/M40/T20 ladder with national and state context.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
