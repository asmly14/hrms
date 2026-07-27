/**
 * /holidays — Malaysian public holiday calendar per state.
 * Data comes from getEffectiveHolidays(year, state) — curated data + optional
 * community-API refresh cache + admin overrides ('holidays' collection) +
 * computed in-lieu replacements (EA 1955 s.60D proviso). Nothing is hardcoded.
 */
import { useMemo, useState } from 'react';
import {
  CalendarDays, Info, Loader2, MapPin, Plus, RefreshCw, Trash2,
} from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import {
  getEffectiveHolidays, refreshHolidays, stateInfo, states, type RefreshResult,
} from '@/lib/holidays';
import { fmtDate } from '@/lib/utils';
import { useAuthScope } from '@/pages/leave/useAuthScope';
import type { Holiday, Settings as CompanySettings, StateCode } from '@/lib/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const YEARS = [2025, 2026, 2027];

function scopeBadge(h: Holiday) {
  return h.states === 'ALL'
    ? <Badge variant="secondary">National</Badge>
    : <Badge variant="outline" className="gap-1"><MapPin className="h-3 w-3" />State</Badge>;
}

function HolidayBadges({ h }: { h: Holiday }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopeBadge(h)}
      {h.isCompulsoryEA && (
        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200">
          EA compulsory
        </Badge>
      )}
      {h.tentative && (
        <Badge variant="outline" className="border-dashed">Tentative</Badge>
      )}
      {h.replacesDate && (
        <Badge variant="secondary" className="bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200">
          In lieu of {fmtDate(h.replacesDate)}
        </Badge>
      )}
      {h.isOverride && <Badge variant="outline">Custom</Badge>}
    </div>
  );
}

export default function HolidaysPage() {
  const auth = useAuthScope();
  const { items: settingsItems } = useCollection<CompanySettings>('settings');
  const holidaysApi = useCollection<Holiday>('holidays');

  const hqState = settingsItems[0]?.hqState ?? 'KUL';
  const [year, setYear] = useState<number>(() => Math.min(2027, Math.max(2025, new Date().getFullYear())));
  const [stateCode, setStateCode] = useState<StateCode>(hqState);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<(RefreshResult & { at: string }) | null>(null);
  const [tick, setTick] = useState(0); // forces recompute after the API cache changes

  // Override form state
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const [newNational, setNewNational] = useState(true);
  const [newStates, setNewStates] = useState<StateCode[]>([]);
  const [newCompulsory, setNewCompulsory] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // getEffectiveHolidays reads curated data + API cache + overrides from the
  // 'holidays' collection; `tick` re-runs it after a successful refresh.
  const effective = useMemo(
    () => getEffectiveHolidays(year, stateCode),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [year, stateCode, holidaysApi.items, tick],
  );

  const overrides = useMemo(
    () => holidaysApi.items
      .filter((h) => h.isOverride && h.date.startsWith(String(year)))
      .sort((a, b) => a.date.localeCompare(b.date)),
    [holidaysApi.items, year],
  );

  const stats = useMemo(() => ({
    total: effective.length,
    compulsory: effective.filter((h) => h.isCompulsoryEA).length,
    tentative: effective.filter((h) => h.tentative).length,
    inLieu: effective.filter((h) => h.replacesDate).length,
  }), [effective]);

  const onRefresh = async () => {
    setRefreshing(true);
    setRefreshResult(null);
    const result = await refreshHolidays(year, stateCode);
    setRefreshing(false);
    setRefreshResult({ ...result, at: new Date().toISOString() });
    setTick((t) => t + 1);
    logAudit({
      actorName: auth.actor,
      action: 'holiday.refresh',
      entity: 'holidays',
      detail: `Refresh ${year} ${stateCode}: source=${result.source}, updated=${result.updated}${result.error ? `, error=${result.error}` : ''}`,
    });
  };

  const toggleNewState = (code: StateCode, checked: boolean) => {
    setNewStates((prev) => (checked ? [...prev, code] : prev.filter((c) => c !== code)));
  };

  const onAddOverride = () => {
    setFormError(null);
    if (!newDate) { setFormError('Pick a date.'); return; }
    if (!newDate.startsWith(String(year))) {
      setFormError(`Date must fall within ${year} (the selected year).`);
      return;
    }
    if (!newName.trim()) { setFormError('Enter a holiday name.'); return; }
    if (!newNational && newStates.length === 0) {
      setFormError('Select at least one state, or mark it national.');
      return;
    }
    const added = holidaysApi.add({
      date: newDate,
      name: newName.trim(),
      states: newNational ? 'ALL' : newStates,
      isCompulsoryEA: newCompulsory,
      tentative: false,
      source: 'manual',
      isOverride: true,
    });
    logAudit({
      actorName: auth.actor,
      action: 'holiday.override.add',
      entity: 'holidays',
      entityId: added.id,
      detail: `${newName.trim()} on ${newDate} (${newNational ? 'ALL' : newStates.join(',')})`,
    });
    setNewDate('');
    setNewName('');
    setNewStates([]);
    setNewNational(true);
    setNewCompulsory(false);
  };

  const onDeleteOverride = (h: Holiday) => {
    holidaysApi.remove(h.id);
    logAudit({
      actorName: auth.actor,
      action: 'holiday.override.delete',
      entity: 'holidays',
      entityId: h.id,
      detail: `${h.name} on ${h.date}`,
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Public Holidays</h1>
        <p className="text-sm text-muted-foreground">
          Gazetted holidays 2025–2027 for all 16 jurisdictions, with automatic in-lieu
          replacement when a holiday falls on a rest day.
        </p>
      </div>

      {/* EA 1955 s.60D explainer */}
      <Alert className="rounded-xl border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/30">
        <Info className="h-4 w-4 text-amber-700 dark:text-amber-400" />
        <AlertTitle>EA 1955 s.60D — paid public holidays</AlertTitle>
        <AlertDescription className="text-sm">
          Employees are entitled to <strong>11 gazetted paid public holidays</strong> a year, of which
          <strong> 5 are compulsory</strong>: National Day, the Yang di-Pertuan Agong&apos;s birthday, the State
          Ruler&apos;s / Federal Territory Day, Labour Day, and Malaysia Day. When a holiday falls on a weekly
          rest day (Fri–Sat in Johor, Kedah, Kelantan &amp; Terengganu; Sat–Sun elsewhere), the
          <strong> next working day is the substituted paid holiday</strong> — shown below as
          <em> in-lieu</em> rows. Ad-hoc holidays declared under s.8 Holidays Act 1951 are also paid.
        </AlertDescription>
      </Alert>

      {/* Controls */}
      <Card className="rounded-xl">
        <CardContent className="flex flex-col gap-4 pt-6 md:flex-row md:items-end">
          <div className="space-y-2">
            <Label htmlFor="ph-year">Year</Label>
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger id="ph-year" className="w-[120px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {YEARS.map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ph-state">State / Federal Territory</Label>
            <Select value={stateCode} onValueChange={(v) => setStateCode(v as StateCode)}>
              <SelectTrigger id="ph-state" className="w-[220px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {states.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.name}{s.weekend === 'fri-sat' ? ' (Fri–Sat weekend)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={onRefresh} disabled={refreshing} className="gap-1.5 md:ml-auto">
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {refreshing ? 'Refreshing…' : 'Auto-refresh holidays'}
          </Button>
        </CardContent>
        {refreshResult && (
          <CardContent className="pt-0">
            <Alert
              className={cn(
                'rounded-xl',
                refreshResult.source === 'api'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100'
                  : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100',
              )}
            >
              {refreshResult.source === 'api' ? <RefreshCw className="h-4 w-4" /> : <Info className="h-4 w-4" />}
              <AlertTitle>
                {refreshResult.source === 'api' ? 'Updated from community API' : 'Using local curated data'}
              </AlertTitle>
              <AlertDescription>
                {refreshResult.source === 'api'
                  ? `${refreshResult.updated} new holiday entr${refreshResult.updated === 1 ? 'y' : 'ies'} merged for ${stateInfo(stateCode).name} ${year}.`
                  : `Live API unavailable${refreshResult.error ? ` (${refreshResult.error})` : ''} — showing the built-in gazetted calendar.`}
              </AlertDescription>
            </Alert>
          </CardContent>
        )}
      </Card>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge variant="secondary">{stats.total} holidays</Badge>
        <Badge variant="secondary">{stats.compulsory} EA-compulsory</Badge>
        <Badge variant="secondary">{stats.inLieu} in-lieu replacement{stats.inLieu === 1 ? '' : 's'}</Badge>
        {stats.tentative > 0 && <Badge variant="outline" className="border-dashed">{stats.tentative} tentative (pending gazette)</Badge>}
      </div>

      {/* Holiday list */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4 text-amber-600" />
            {stateInfo(stateCode).name} — {year}
          </CardTitle>
          <CardDescription>
            Effective calendar: gazetted days plus computed rest-day replacements.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {effective.length === 0 ? (
            <p className="text-sm text-muted-foreground">No holiday data for this selection.</p>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[150px]">Date</TableHead>
                      <TableHead>Holiday</TableHead>
                      <TableHead className="w-[320px]">Badges</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {effective.map((h) => (
                      <TableRow key={`${h.date}-${h.name}-${JSON.stringify(h.states)}`}>
                        <TableCell className="font-medium">
                          {fmtDate(h.date)}
                          <span className="block text-xs font-normal text-muted-foreground">
                            {new Date(`${h.date}T00:00:00`).toLocaleDateString('en-MY', { weekday: 'long' })}
                          </span>
                        </TableCell>
                        <TableCell>
                          {h.name}
                          {h.nameMs && <span className="block text-xs text-muted-foreground">{h.nameMs}</span>}
                        </TableCell>
                        <TableCell><HolidayBadges h={h} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {/* Mobile cards */}
              <div className="space-y-3 md:hidden">
                {effective.map((h) => (
                  <div key={`${h.date}-${h.name}-${JSON.stringify(h.states)}`} className="rounded-xl border p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{h.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(h.date)}</span>
                    </div>
                    <div className="mt-2"><HolidayBadges h={h} /></div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Admin overrides — Admin/HR only (route guard lands with the auth integration wave) */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Custom holidays &amp; cuti peristiwa</CardTitle>
          <CardDescription>
            Company-declared holidays (e.g. cuti peristiwa, election day, company anniversary).
            Overrides merge into the calendar above and apply to leave-day counting.
          </CardDescription>
        </CardHeader>
        {!auth.isHROrAdmin ? (
          <CardContent>
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
              Custom holidays are managed by Admin / HR. Contact HR to add or remove a
              company-declared holiday.
            </p>
          </CardContent>
        ) : (
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="ov-date">Date ({year})</Label>
              <Input id="ov-date" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
            </div>
            <div className="space-y-2 sm:col-span-1 lg:col-span-2">
              <Label htmlFor="ov-name">Name</Label>
              <Input
                id="ov-name"
                placeholder="e.g. Cuti Peristiwa — Company Family Day"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={onAddOverride} className="gap-1.5">
                <Plus className="h-4 w-4" /> Add holiday
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={newNational}
                onCheckedChange={(c) => setNewNational(c === true)}
              />
              National (all states)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={newCompulsory}
                onCheckedChange={(c) => setNewCompulsory(c === true)}
              />
              Counts toward the 11 EA-compulsory days
            </label>
          </div>

          {!newNational && (
            <div className="grid grid-cols-2 gap-2 rounded-xl border p-3 sm:grid-cols-4">
              {states.map((s) => (
                <label key={s.code} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={newStates.includes(s.code)}
                    onCheckedChange={(c) => toggleNewState(s.code, c === true)}
                  />
                  {s.name}
                </label>
              ))}
            </div>
          )}

          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <Separator />

          {overrides.length === 0 ? (
            <p className="text-sm text-muted-foreground">No custom holidays for {year} yet.</p>
          ) : (
            <ul className="space-y-2">
              {overrides.map((h) => (
                <li key={h.id} className="flex items-center gap-3 rounded-xl border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{h.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtDate(h.date)} · {h.states === 'ALL' ? 'All states' : (h.states as StateCode[]).join(', ')}
                      {h.isCompulsoryEA ? ' · EA-compulsory' : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${h.name}`}
                    onClick={() => onDeleteOverride(h)}
                  >
                    <Trash2 className="h-4 w-4 text-rose-600" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
        )}
      </Card>
    </div>
  );
}
