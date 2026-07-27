/**
 * M8 — Salary Suggestion tool.
 * Inputs: industry → role (cascading benchmark dropdowns + free text),
 * seniority years, state, department. Output: min/median/max/p25/p75 range
 * chart, the matched role's job description, qualifications, hiring-demand
 * badge, a cost-of-living note for the chosen state, and the adjustment
 * drivers. Benchmarks come from @/lib/salaryBenchmark — never hardcoded.
 */
import { useMemo, useState } from 'react';
import { Briefcase, Flame, GraduationCap, Info, MapPin, ScrollText, Sparkles, TrendingUp } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { states } from '@/lib/holidays';
import {
  colForState,
  listIndustries,
  listRoles,
  suggestSalary,
  type DemandLevel,
} from '@/lib/salaryBenchmark';
import { fmtRM } from '@/lib/utils';
import type { Department, StateCode } from '@/lib/types';
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
import { Slider } from '@/components/ui/slider';
import SalaryRangeChart from './SalaryRangeChart';

const CUSTOM_ROLE = '__custom';
const AUTO_DEPT = '__auto';

function driverIcon(driver: string) {
  if (driver.toLowerCase().includes('factor') || driver.toLowerCase().includes('baseline')) return MapPin;
  if (driver.startsWith('Benchmark') || driver.startsWith('No exact')) return Briefcase;
  return Info;
}

const DEMAND_STYLE: Record<DemandLevel, { badge: string; label: string }> = {
  'very-high': { badge: 'border-transparent bg-green-100 text-green-800 hover:bg-green-100', label: 'Very high demand' },
  high: { badge: 'border-transparent bg-lime-100 text-lime-800 hover:bg-lime-100', label: 'High demand' },
  'moderate-high': { badge: 'border-transparent bg-amber-100 text-amber-800 hover:bg-amber-100', label: 'Moderate-high demand' },
  'stable-high': { badge: 'border-transparent bg-yellow-100 text-yellow-800 hover:bg-yellow-100', label: 'Stable-high demand' },
  stable: { badge: 'border-transparent bg-stone-200 text-stone-700 hover:bg-stone-200', label: 'Stable demand' },
  moderate: { badge: 'border-transparent bg-stone-200 text-stone-700 hover:bg-stone-200', label: 'Moderate demand' },
  'high-volume': { badge: 'border-transparent bg-orange-100 text-orange-800 hover:bg-orange-100', label: 'High-volume hiring' },
};

export default function SalarySuggestionTool() {
  const { items: departments } = useCollection<Department>('departments');

  const industries = useMemo(() => listIndustries(), []);
  const [industry, setIndustry] = useState<string>(industries[0] ?? '');
  const roles = useMemo(() => listRoles(industry), [industry]);
  const [roleChoice, setRoleChoice] = useState<string>(roles[0]?.role ?? CUSTOM_ROLE);
  const [customRole, setCustomRole] = useState('');
  const [years, setYears] = useState(3);
  const [state, setState] = useState<StateCode>('KUL');
  const [dept, setDept] = useState<string>(AUTO_DEPT);

  const pickIndustry = (next: string) => {
    setIndustry(next);
    // Cascade: reset the role to the first benchmark of the new industry.
    setRoleChoice(listRoles(next)[0]?.role ?? CUSTOM_ROLE);
  };

  const role = roleChoice === CUSTOM_ROLE ? customRole : roleChoice;
  const suggestion = useMemo(
    () =>
      role.trim()
        ? suggestSalary(role.trim(), years, state, dept === AUTO_DEPT ? undefined : dept)
        : null,
    [role, years, state, dept],
  );
  const col = colForState(state);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* Inputs */}
      <Card className="rounded-xl lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Who are you pricing?</CardTitle>
          <CardDescription>
            Industry, role, seniority and location drive the benchmark range.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="industry">Industry</Label>
            <Select value={industry} onValueChange={pickIndustry}>
              <SelectTrigger id="industry">
                <SelectValue placeholder="Pick an industry" />
              </SelectTrigger>
              <SelectContent>
                {industries.map((i) => (
                  <SelectItem key={i} value={i}>
                    {i}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Select value={roleChoice} onValueChange={setRoleChoice}>
              <SelectTrigger id="role">
                <SelectValue placeholder="Pick a role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((b) => (
                  <SelectItem key={b.role} value={b.role}>
                    {b.role}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_ROLE}>Other — type it myself</SelectItem>
              </SelectContent>
            </Select>
            {roleChoice === CUSTOM_ROLE && (
              <Input
                className="mt-2"
                placeholder="e.g. QA Engineer, Graphic Designer…"
                value={customRole}
                onChange={(e) => setCustomRole(e.target.value)}
              />
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Seniority</Label>
              <span className="text-sm font-medium tabular-nums">{years} yrs</span>
            </div>
            <Slider
              value={[years]}
              min={0}
              max={20}
              step={1}
              onValueChange={(v) => setYears(v[0] ?? 0)}
            />
            <p className="text-xs text-muted-foreground">
              Bands: 0–2 · 3–5 · 6–10 · 10+ years of experience.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="state">Work location (state)</Label>
            <Select value={state} onValueChange={(v) => setState(v as StateCode)}>
              <SelectTrigger id="state">
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

          <div className="space-y-2">
            <Label htmlFor="dept">Department</Label>
            <Select value={dept} onValueChange={setDept}>
              <SelectTrigger id="dept">
                <SelectValue placeholder="Auto (from role)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_DEPT}>Auto (from role)</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.name}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Used as a fallback when the role title has no direct benchmark match.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Output */}
      <div className="space-y-6 lg:col-span-3">
        <Card className="rounded-xl">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Suggested range</CardTitle>
              {suggestion && (
                <>
                  <Badge variant="secondary">{suggestion.matchedRole}</Badge>
                  {suggestion.industry && <Badge variant="outline">{suggestion.industry}</Badge>}
                  <Badge variant="outline">Band {suggestion.band} yrs</Badge>
                  {suggestion.demandLevel && (
                    <Badge className={DEMAND_STYLE[suggestion.demandLevel].badge}>
                      <Flame className="mr-1 h-3 w-3" />
                      {DEMAND_STYLE[suggestion.demandLevel].label}
                    </Badge>
                  )}
                  {suggestion.variablePay && (
                    <Badge variant="outline" className="border-amber-300 text-amber-800">
                      Variable pay significant
                    </Badge>
                  )}
                </>
              )}
            </div>
            <CardDescription>
              Monthly base salary benchmark, RM — Klang-Valley baseline adjusted by the{' '}
              {col.stateName} wage factor ×{suggestion?.stateFactor ?? 1}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {suggestion ? (
              <>
                <SalaryRangeChart
                  min={suggestion.min}
                  p25={suggestion.percentile25}
                  median={suggestion.median}
                  p75={suggestion.percentile75}
                  max={suggestion.max}
                />
                <div className="space-y-2">
                  <p className="text-sm font-medium">What drives this range</p>
                  <ul className="space-y-2">
                    {suggestion.drivers.map((d) => {
                      const Icon = driverIcon(d);
                      return (
                        <li key={d} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                          <span>{d}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p>
                    Benchmarks are indicative market estimates for guidance only — researched
                    2025–2026 ranges (Robert Walters, FastLaneRecruit, DOSM), not a paid salary
                    survey. Validate against current market data before making an offer.
                  </p>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Sparkles className="h-6 w-6 text-amber-500" />
                <p className="text-sm font-medium">Type a role to see its benchmark</p>
                <p className="max-w-xs text-sm text-muted-foreground">
                  Free-text roles match against benchmark aliases (seniority prefixes are stripped);
                  unmatched roles fall back to a generic Malaysian band.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Role profile + demand + COL note */}
        {suggestion?.jobDescription && (
          <Card className="rounded-xl">
            <CardHeader>
              <CardTitle className="text-base">Role profile &amp; market context</CardTitle>
              <CardDescription>{suggestion.matchedRole} — researched profile.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3">
                <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <p className="text-sm font-medium">What the role does</p>
                  <p className="text-sm text-muted-foreground">{suggestion.jobDescription}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <GraduationCap className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <p className="text-sm font-medium">Typical qualifications</p>
                  <p className="text-sm text-muted-foreground">{suggestion.qualifications}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <p className="text-sm font-medium">Hiring demand 2025–2026</p>
                  <p className="text-sm text-muted-foreground">{suggestion.demandTrend}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <p className="text-sm font-medium">Cost of living — {col.stateName}</p>
                  <p className="text-sm text-muted-foreground">
                    COL index {col.index} (Kuala Lumpur = 100) · single-person basket ≈{' '}
                    {fmtRM(col.basket)}/month · 1BR rent {fmtRM(col.rent1BrCity)} city centre /{' '}
                    {fmtRM(col.rent1BrSuburb)} suburb ({col.refCity}).
                    {col.estimated && ' Components partly estimated — treat as ±15%.'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
