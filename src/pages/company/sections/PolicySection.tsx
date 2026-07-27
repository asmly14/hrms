/**
 * Company Setup → Work & payroll policy: working week, payroll cut-off,
 * public-holiday state, claim policy and leave top-ups for the ACTIVE
 * company.
 *
 * Canonical home is `Company.config` (workingWeek / payrollCutoffDay /
 * claimPolicy / leaveTopUps); saves ALSO mirror into the legacy tenant
 * settings docs ('ext:payroll', 'claimPolicy', 'ext:leaveTopups') because
 * lib/appSettings.ts resolves defaults → Company.config → settings docs —
 * without mirroring, a previously-written doc would shadow the new config.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, CalendarHeart, MapPin, ReceiptText } from 'lucide-react';
import { states, stateInfo } from '@/lib/holidays';
import type { StateCode, WorkingWeek } from '@/lib/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Field, SaveButton, SectionCard, numOr } from '../../settings/shared';
import { mirrorSettingsDoc, useCompanySetup, useUnsavedGuard, UNSAVED_HINT } from '../store';

type TopupKey = 'annual' | 'sick' | 'hospitalization' | 'maternity' | 'paternity';

const TOPUP_TYPES: { key: TopupKey; label: string }[] = [
  { key: 'annual', label: 'Annual leave' },
  { key: 'sick', label: 'Sick leave' },
  { key: 'hospitalization', label: 'Hospitalization leave' },
  { key: 'maternity', label: 'Maternity leave' },
  { key: 'paternity', label: 'Paternity leave' },
];

/** EA 1955 statutory minimums per type, by service tier (<2 / 2–<5 / ≥5 yrs). */
const EA_MINIMUMS: Record<TopupKey, [number, number, number]> = {
  annual: [8, 12, 16],
  sick: [14, 18, 22],
  hospitalization: [60, 60, 60],
  maternity: [98, 98, 98],
  paternity: [7, 7, 7],
};

const CLAIM_FIELDS: {
  key: 'mileageRatePerKm' | 'mealDailyLimit' | 'medicalClaimLimit' | 'phoneMonthlyLimit';
  label: string;
  hint: string;
  step: number;
}[] = [
  { key: 'mileageRatePerKm', label: 'Mileage rate (RM / km)', hint: 'Auto-computes mileage claim amounts in the Claims module.', step: 0.05 },
  { key: 'mealDailyLimit', label: 'Meal limit (RM / day)', hint: 'Soft flag when meal claims exceed this per calendar day.', step: 5 },
  { key: 'medicalClaimLimit', label: 'Medical limit (RM / claim)', hint: 'Soft flag on any single medical claim above this amount.', step: 50 },
  { key: 'phoneMonthlyLimit', label: 'Phone & internet limit (RM / month)', hint: 'Soft flag when a month\u2019s phone claims exceed this cap.', step: 10 },
];

interface Draft {
  workingWeek: WorkingWeek;
  payrollCutoffDay: string;
  holidayState: StateCode;
  mileageRatePerKm: string;
  mealDailyLimit: string;
  medicalClaimLimit: string;
  phoneMonthlyLimit: string;
  topUps: Record<TopupKey, number>;
}

export default function PolicySection() {
  const { company, save } = useCompanySetup();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);

  const companyId = company?.id;
  useEffect(() => {
    setDraft(null);
    setDirty(false);
  }, [companyId]);
  useEffect(() => {
    if (!company || draft) return;
    const cfg = company.config;
    setDraft({
      workingWeek: cfg.workingWeek,
      payrollCutoffDay: String(cfg.payrollCutoffDay),
      holidayState: company.hqState,
      mileageRatePerKm: cfg.claimPolicy.mileageRatePerKm != null ? String(cfg.claimPolicy.mileageRatePerKm) : '0.8',
      mealDailyLimit: cfg.claimPolicy.mealDailyLimit != null ? String(cfg.claimPolicy.mealDailyLimit) : '50',
      medicalClaimLimit: cfg.claimPolicy.medicalClaimLimit != null ? String(cfg.claimPolicy.medicalClaimLimit) : '200',
      phoneMonthlyLimit: cfg.claimPolicy.phoneMonthlyLimit != null ? String(cfg.claimPolicy.phoneMonthlyLimit) : '100',
      topUps: {
        annual: cfg.leaveTopUps.annual ?? 0,
        sick: cfg.leaveTopUps.sick ?? 0,
        hospitalization: cfg.leaveTopUps.hospitalization ?? 0,
        maternity: cfg.leaveTopUps.maternity ?? 0,
        paternity: cfg.leaveTopUps.paternity ?? 0,
      },
    });
  }, [company, draft]);

  if (!company || !draft) {
    return (
      <SectionCard icon={CalendarClock} title="Work & payroll policy" description="Loading policy…">
        <Skeleton className="h-48 w-full rounded-lg" />
      </SectionCard>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setDirty(true);
  };
  const setTopUp = (key: TopupKey, value: string) => {
    setDraft((d) =>
      d ? { ...d, topUps: { ...d.topUps, [key]: Math.max(0, Math.floor(numOr(value, 0))) } } : d,
    );
    setDirty(true);
  };

  const cutoff = numOr(draft.payrollCutoffDay, NaN);
  const cutoffValid = Number.isInteger(cutoff) && cutoff >= 1 && cutoff <= 28;
  const claimValues = {
    mileageRatePerKm: numOr(draft.mileageRatePerKm, NaN),
    mealDailyLimit: numOr(draft.mealDailyLimit, NaN),
    medicalClaimLimit: numOr(draft.medicalClaimLimit, NaN),
    phoneMonthlyLimit: numOr(draft.phoneMonthlyLimit, NaN),
  };
  const claimValid = Object.values(claimValues).every((v) => Number.isFinite(v) && v > 0);
  const valid = cutoffValid && claimValid;

  const weekendDefault = stateInfo(draft.holidayState).weekend;

  const onSave = () => {
    if (!valid) return;
    save(
      (c) => ({
        ...c,
        hqState: draft.holidayState,
        config: {
          ...c.config,
          workingWeek: draft.workingWeek,
          payrollCutoffDay: cutoff,
          claimPolicy: { ...claimValues },
          leaveTopUps: { ...draft.topUps },
        },
      }),
      `Work & payroll policy saved (${draft.workingWeek}, cut-off day ${cutoff}, holidays ${draft.holidayState})`,
    );
    // Mirror into the legacy settings docs that appSettings accessors layer
    // over Company.config, so either reader sees the same effective values.
    mirrorSettingsDoc('ext:payroll', { kind: 'payrollPolicy', cutoffDay: cutoff });
    mirrorSettingsDoc('claimPolicy', { ...claimValues });
    mirrorSettingsDoc('ext:leaveTopups', { kind: 'leaveTopups', days: { ...draft.topUps } });
    // Holiday state also mirrors onto the settings singleton (Settings page).
    mirrorSettingsDoc('company', { hqState: draft.holidayState });
    setDirty(false);
  };

  return (
    <div className="space-y-6">
      <SectionCard
        icon={CalendarClock}
        title="Working week & payroll cut-off"
        description="Weekend pattern and the monthly close for attendance, OT and claims."
        action={
          <div className="flex items-center gap-2">
            {dirty ? <span className="text-xs font-medium text-amber-700">{UNSAVED_HINT}</span> : null}
            <SaveButton onSave={onSave} disabled={!valid} />
          </div>
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <Field
            label="Working week"
            hint={`HQ state default: ${weekendDefault === 'fri-sat' ? 'Friday–Saturday' : 'Saturday–Sunday'} (${stateInfo(draft.holidayState).name}).`}
          >
            <RadioGroup
              value={draft.workingWeek}
              onValueChange={(v) => set('workingWeek', v as WorkingWeek)}
              className="gap-3"
            >
              <Label
                htmlFor="ww-sat-sun"
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-amber-500 has-[[data-state=checked]]:bg-amber-50/60"
              >
                <RadioGroupItem value="sat-sun" id="ww-sat-sun" />
                <span>
                  <span className="block text-sm font-medium">Saturday – Sunday weekend</span>
                  <span className="block text-xs text-muted-foreground">Standard for most states and the federal territories.</span>
                </span>
              </Label>
              <Label
                htmlFor="ww-fri-sat"
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-amber-500 has-[[data-state=checked]]:bg-amber-50/60"
              >
                <RadioGroupItem value="fri-sat" id="ww-fri-sat" />
                <span>
                  <span className="block text-sm font-medium">Friday – Saturday weekend</span>
                  <span className="block text-xs text-muted-foreground">Johor, Kedah, Kelantan and Terengganu practice.</span>
                </span>
              </Label>
            </RadioGroup>
          </Field>

          <div className="space-y-4">
            <Field
              label="Payroll cut-off day (1–28)"
              hint="Attendance, OT and claims close on this day each month; later-dated items roll into the next run."
            >
              <Input
                type="number"
                min={1}
                max={28}
                value={draft.payrollCutoffDay}
                onChange={(e) => set('payrollCutoffDay', e.target.value)}
              />
            </Field>
            {!cutoffValid ? (
              <p className="text-xs text-destructive">Cut-off must be a whole number between 1 and 28.</p>
            ) : null}
            <Field
              label="Public-holiday state"
              hint="Holiday lists and replacement (in-lieu) rules follow this state. Synced with the HQ state on the Profile tab."
            >
              <Select value={draft.holidayState} onValueChange={(v) => set('holidayState', v as StateCode)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent>
                  {states.map((s) => (
                    <SelectItem key={s.code} value={s.code}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        icon={ReceiptText}
        title="Claim policy"
        description="Company policy caps (not statutory values) — saved to config.claimPolicy and mirrored to the 'claimPolicy' settings doc the Claims module reads live."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {CLAIM_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">RM</span>
                <Input
                  type="number"
                  min={0}
                  step={f.step}
                  className="pl-11"
                  value={draft[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </div>
            </Field>
          ))}
        </div>
        {!claimValid ? (
          <p className="text-xs text-destructive">All four policy values are required and must be greater than 0.</p>
        ) : null}
      </SectionCard>

      <SectionCard
        icon={CalendarHeart}
        title="Leave top-ups (bonus days)"
        description="Extra paid days granted ON TOP of the EA 1955 statutory minimums, applied uniformly across service tiers. The Leave module adds them when computing annual entitlements."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TOPUP_TYPES.map((t) => (
            <Field key={t.key} label={`${t.label} top-up (days)`}>
              <Input
                type="number"
                min={0}
                step={1}
                value={draft.topUps[t.key]}
                onChange={(e) => setTopUp(t.key, e.target.value)}
              />
            </Field>
          ))}
        </div>

        {/* Resulting-entitlement preview: EA minimum + current top-up, per tier. */}
        <div className="space-y-2 rounded-lg bg-muted/50 p-3">
          <p className="text-xs font-medium text-foreground">
            Resulting annual entitlement preview (full-time staff, EA minimum + top-up = total):
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 text-xs">Leave type</TableHead>
                <TableHead className="h-8 text-center text-xs">&lt; 2 yrs</TableHead>
                <TableHead className="h-8 text-center text-xs">2 – &lt; 5 yrs</TableHead>
                <TableHead className="h-8 text-center text-xs">≥ 5 yrs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TOPUP_TYPES.map((t) => {
                const topup = draft.topUps[t.key];
                return (
                  <TableRow key={t.key}>
                    <TableCell className="py-2 text-xs font-medium">{t.label}</TableCell>
                    {EA_MINIMUMS[t.key].map((min, i) => (
                      <TableCell key={i} className="py-2 text-center text-xs">
                        <span className="font-medium">{min + topup} days</span>
                        {topup > 0 ? <span className="text-muted-foreground">{` (${min}+${topup})`}</span> : null}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            Top-ups are company policy — they never reduce the statutory floor (EA 1955 s.7, more-favourable terms
            prevail).
          </p>
        </div>
      </SectionCard>

      <SectionCard
        icon={MapPin}
        title="Attendance geofence"
        description="Office & site geofences are per-company too. They continue to be managed in Settings → Locations (the canonical editor the Attendance module reads)."
      >
        <p className="text-sm text-muted-foreground">
          Head to{' '}
          <Link to="/settings" className="font-medium text-amber-700 hover:underline underline-offset-4">
            Settings → Locations
          </Link>{' '}
          to add or edit geofenced clock-in sites for {company.name}.
        </p>
      </SectionCard>
    </div>
  );
}
