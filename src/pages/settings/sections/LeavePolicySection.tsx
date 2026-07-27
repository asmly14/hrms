/**
 * Settings → Leave policy: read-only EA 1955 statutory minimum entitlement
 * table.
 *
 * MULTI-TENANT: company bonus top-up days are per-company configuration and
 * editing moved to Company Setup → Work & Payroll Policy (writes
 * config.leaveTopUps and mirrors the legacy 'ext:leaveTopups' doc, so the
 * core entitlement logic via getLeaveTopUps() keeps working unchanged).
 */
import { Link } from 'react-router-dom';
import { CalendarHeart, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SectionCard } from '../shared';

/** EA 1955 reference rows — statutory minimums (see docs/research/employment-law.md §7–10). */
const EA_ROWS: {
  type: string;
  section: string;
  tiers: [string, string, string];
  note?: string;
}[] = [
  { type: 'Annual leave', section: 's.60E', tiers: ['8 days', '12 days', '16 days'] },
  { type: 'Sick leave (non-hospitalized)', section: 's.60F', tiers: ['14 days', '18 days', '22 days'] },
  {
    type: 'Hospitalization leave',
    section: 's.60F',
    tiers: ['60 days', '60 days', '60 days'],
    note: 'Aggregate per year, in addition to the sick-leave entitlement (2022 amendment).',
  },
  { type: 'Maternity leave', section: 'Part IX (s.37)', tiers: ['98 days', '98 days', '98 days'], note: 'Applies to every female employee irrespective of wages.' },
  { type: 'Paternity leave', section: 's.60FA', tiers: ['7 days', '7 days', '7 days'], note: 'Married male employees, up to 5 confinements.' },
];

export default function LeavePolicySection() {
  return (
    <div className="space-y-6">
      <SectionCard
        icon={Scale}
        title="Statutory minimums — Employment Act 1955"
        description="Read-only reference. These are legal minimums; more-favourable company terms prevail (EA s.7)."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Leave type</TableHead>
              <TableHead className="text-center">&lt; 2 yrs service</TableHead>
              <TableHead className="text-center">2 – &lt; 5 yrs</TableHead>
              <TableHead className="text-center">≥ 5 yrs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {EA_ROWS.map((r) => (
              <TableRow key={r.type}>
                <TableCell>
                  <p className="font-medium">{r.type}</p>
                  <p className="text-xs text-muted-foreground">
                    EA 1955 {r.section}
                    {r.note ? ` · ${r.note}` : ''}
                  </p>
                </TableCell>
                {r.tiers.map((t, i) => (
                  <TableCell key={i} className="text-center font-medium">
                    {t}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">
          Applies to Peninsular Malaysia and FT Labuan. Sabah &amp; Sarawak Labour Ordinance amendments effective
          1 May 2025 substantially mirror these entitlements. Service tiers follow each employee&apos;s anniversary date.
        </p>
      </SectionCard>

      <SectionCard
        icon={CalendarHeart}
        title="Company top-up (bonus leave)"
        description="Extra paid days granted ON TOP of the EA 1955 minimums above, applied uniformly to all service tiers — the Leave module adds them when computing each employee's annual entitlement."
      >
        <p className="text-sm text-muted-foreground">
          Top-up editing moved to{' '}
          <Link to="/company?tab=policy" className="font-medium text-amber-700 hover:underline underline-offset-4">
            Company Setup → Work &amp; Payroll Policy
          </Link>
          , where each type shows a live preview of EA minimum + top-up = total per service tier. Values are saved to
          the active company&apos;s <code className="rounded bg-muted px-1 py-0.5">config.leaveTopUps</code> and
          mirrored into the <code className="rounded bg-muted px-1 py-0.5">ext:leaveTopups</code> settings doc, so the
          entitlement engine reads them exactly as before — the statutory floor is never reduced.
        </p>
        <div>
          <Button asChild variant="outline" size="sm">
            <Link to="/company?tab=policy">Open leave top-ups in Company Setup</Link>
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
