/**
 * Settings → Payroll: cut-off day, payday, working-days basis and a live
 * HRD Corp levy auto-detection readout computed from the 'employees'
 * collection via hrdfLevy() from the core statutory lib.
 *
 * MULTI-TENANT: the company claim policy (and the cut-off base layer) moved
 * to Company Setup → Work & Payroll Policy, which writes Company.config and
 * mirrors the values back into the settings docs this section edits — so
 * this editor keeps working and the two never diverge.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgePercent, CalendarClock, ReceiptText } from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import { hrdfLevy } from '@/lib/statutory';
import { fmtRM, round2 } from '@/lib/utils';
import type { Employee } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { DEMO_ACTOR, Field, SaveButton, SectionCard, numOr } from '../shared';
import { useSettingsData } from '../store';

interface Draft {
  cutoffDay: string;
  paydayDay: string;
  workingDaysBasis: string;
}

export default function PayrollSection() {
  const { company, payrollPolicy, saveCompany, savePayrollPolicy } = useSettingsData();
  const { items: employees } = useCollection<Employee>('employees');
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (company && payrollPolicy) {
      setDraft((prev) =>
        prev ?? {
          cutoffDay: String(payrollPolicy.cutoffDay),
          paydayDay: String(company.paydayDay),
          workingDaysBasis: String(payrollPolicy.workingDaysBasis),
        },
      );
    }
  }, [company, payrollPolicy]);

  // ── HRD Corp levy auto-detection — live from the employees collection ──
  const localEmployees = employees.filter((e) => !e.isForeignWorker && e.status !== 'resigned');
  const numLocal = localEmployees.length;
  const localMonthlyWages = round2(
    localEmployees.reduce((sum, e) => sum + e.baseSalary + e.fixedAllowances.reduce((a, f) => a + f.amount, 0), 0),
  );
  const monthlyLevy = hrdfLevy(localMonthlyWages, numLocal);
  // Effective rate derived FROM the lib function (never hardcoded):
  // levy on a RM10,000 wage bill equals rate × 10,000.
  const effectiveRatePct = hrdfLevy(10000, numLocal) / 100;
  const levyTier =
    effectiveRatePct > 0
      ? effectiveRatePct >= 1
        ? 'Mandatory registration'
        : 'Optional registration'
      : 'Exempt';

  if (!company || !payrollPolicy || !draft) {
    return (
      <SectionCard icon={CalendarClock} title="Payroll cycle" description="Loading payroll settings…">
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </SectionCard>
    );
  }

  const cutoff = numOr(draft.cutoffDay, NaN);
  const payday = numOr(draft.paydayDay, NaN);
  const basis = numOr(draft.workingDaysBasis, NaN);
  const valid =
    Number.isInteger(cutoff) && cutoff >= 1 && cutoff <= 31 &&
    Number.isInteger(payday) && payday >= 1 && payday <= 31 &&
    Number.isInteger(basis) && basis >= 20 && basis <= 31;

  const onSave = () => {
    if (!valid) return;
    saveCompany({ paydayDay: payday });
    savePayrollPolicy({ cutoffDay: cutoff, workingDaysBasis: basis });
    logAudit({
      actorName: DEMO_ACTOR,
      action: 'settings.update',
      entity: 'settings',
      entityId: 'ext:payroll',
      detail: `Payroll policy saved (cut-off day ${cutoff}, payday day ${payday})`,
    });
  };

  return (
    <div className="space-y-6">
      <SectionCard
        icon={CalendarClock}
        title="Payroll cycle"
        description="Cut-off and payment schedule for the monthly wage period."
        action={<SaveButton onSave={onSave} disabled={!valid} />}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Payroll cut-off day" hint="Attendance, OT and claims close on this day each month; later-dated items roll into the next run.">
            <Input type="number" min={1} max={31} value={draft.cutoffDay} onChange={(e) => setDraft({ ...draft, cutoffDay: e.target.value })} />
          </Field>
          <Field label="Payday (day of month)" hint="EA 1955 s.19 — wages must be paid within 7 days after the wage period.">
            <Input type="number" min={1} max={31} value={draft.paydayDay} onChange={(e) => setDraft({ ...draft, paydayDay: e.target.value })} />
          </Field>
          <Field
            label="Working-days basis"
            hint="EA 1955 s.60I — ordinary rate of pay = monthly wages ÷ 26. OT and unpaid-leave math uses orpFromMonthly() from the core lib."
          >
            <Input type="number" min={20} max={31} value={draft.workingDaysBasis} onChange={(e) => setDraft({ ...draft, workingDaysBasis: e.target.value })} />
          </Field>
        </div>
        {!valid ? <p className="text-xs text-destructive">Days must be whole numbers: cut-off / payday 1–31, working-days basis 20–31.</p> : null}
        <p className="text-xs text-muted-foreground">
          The cut-off day is also editable per company in{' '}
          <Link to="/company?tab=policy" className="font-medium text-amber-700 hover:underline underline-offset-4">
            Company Setup → Work &amp; Payroll Policy
          </Link>{' '}
          — both write the same record, so they stay in sync.
        </p>
      </SectionCard>

      <SectionCard
        icon={BadgePercent}
        title="HRD Corp levy (auto-detected)"
        description="PSMB Act 2001 — levy rate is determined by the number of Malaysian (non-foreign) employees on the payroll."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Local employees</p>
            <p className="mt-1 text-2xl font-semibold">{numLocal}</p>
            <p className="mt-1 text-xs text-muted-foreground">active &amp; probation, excluding foreign workers</p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Detected levy rate</p>
            <p className="mt-1 flex items-center gap-2 text-2xl font-semibold">
              {effectiveRatePct}%
              <Badge variant={effectiveRatePct >= 1 ? 'default' : effectiveRatePct > 0 ? 'secondary' : 'outline'}>
                {levyTier}
              </Badge>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">1% at ≥10 staff · 0.5% at 5–9 (opt-in) · exempt below 5</p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Est. monthly levy</p>
            <p className="mt-1 text-2xl font-semibold">{fmtRM(monthlyLevy)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              on {fmtRM(localMonthlyWages)} levy-able wages · ≈ {fmtRM(round2(monthlyLevy * 12))} / year
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Computed live via <code className="rounded bg-muted px-1 py-0.5">hrdfLevy()</code> from{' '}
          <code className="rounded bg-muted px-1 py-0.5">src/lib/statutory.ts</code> on (basic + fixed allowances);
          OT, bonus and commission are excluded. The same figure appears as the employer-only HRD line on every payslip.
        </p>
      </SectionCard>

      <SectionCard
        icon={ReceiptText}
        title="Claim policies"
        description="Mileage, meal, medical and phone limits are company-scoped configuration."
      >
        <p className="text-sm text-muted-foreground">
          Claim policy editing moved to{' '}
          <Link to="/company?tab=policy" className="font-medium text-amber-700 hover:underline underline-offset-4">
            Company Setup → Work &amp; Payroll Policy
          </Link>
          , which saves to the active company&apos;s <code className="rounded bg-muted px-1 py-0.5">config.claimPolicy</code>{' '}
          and mirrors the values into the <code className="rounded bg-muted px-1 py-0.5">claimPolicy</code> settings
          doc the Claims module reads — limits warn (never block) at submission and in the approver inbox, exactly as
          before.
        </p>
        <div>
          <Button asChild variant="outline" size="sm">
            <Link to="/company?tab=policy">Open claim policy in Company Setup</Link>
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
