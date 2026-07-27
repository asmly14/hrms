/**
 * SuperAdmin → System settings:
 *   1. Demo-data management — force-reseed a specific tenant
 *      (seedTenantIfEmpty(companyId, true)) behind a confirm dialog.
 *   2. Global holidays note — the 'holidays' collection is intentionally
 *      GLOBAL (shared across tenants; Malaysian holiday law is national).
 *   3. Plan feature matrix — informational billing/entitlement card.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, Check, CircleDollarSign, Database, Minus, RotateCcw,
} from 'lucide-react';
import { useTenant } from '@/lib/tenantContext';
import { seedTenantIfEmpty } from '@/lib/db';
import { DEMO_COMPANY_IDS } from '@/lib/tenants';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { headcountOf, PLAN_RATES } from './lib';
import { SectionCard } from './shared';

// ── Plan matrix (informational) ──────────────────────────────────────────────

interface MatrixRow {
  label: string;
  free: boolean;
  pro: boolean;
  enterprise: boolean;
}

const MATRIX: MatrixRow[] = [
  { label: 'Employees directory & org structure', free: true, pro: true, enterprise: true },
  { label: 'Leave management & public holidays', free: true, pro: true, enterprise: true },
  { label: 'Attendance & shifts', free: false, pro: true, enterprise: true },
  { label: 'Claims & reimbursements', free: false, pro: true, enterprise: true },
  { label: 'Payroll & statutory (EPF/SOCSO/EIS/PCB)', free: false, pro: true, enterprise: true },
  { label: 'Reports', free: false, pro: true, enterprise: true },
  { label: 'KPI & performance reviews', free: false, pro: false, enterprise: true },
  { label: 'Salary insights & benchmarking', free: false, pro: false, enterprise: true },
  { label: 'Onboarding / offboarding workflows', free: false, pro: false, enterprise: true },
];

function MatrixCell({ on }: { on: boolean }) {
  return on ? (
    <Check className="mx-auto h-4 w-4 text-lime-600" />
  ) : (
    <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" />
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

export default function SystemSection() {
  const { companies, refreshCompanies } = useTenant();
  const navigate = useNavigate();

  const [targetId, setTargetId] = useState<string>(companies[0]?.id ?? '');
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<'idle' | 'working' | 'done'>('idle');

  const target = useMemo(
    () => companies.find((c) => c.id === targetId) ?? null,
    [companies, targetId],
  );
  const isDemoTenant = target ? (DEMO_COMPANY_IDS as readonly string[]).includes(target.id) : false;

  const reseed = () => {
    if (!target) return;
    setConfirming(false);
    setFeedback('working');
    // seedTenantIfEmpty loads the seed module dynamically — fire and forget,
    // then re-read the directory shortly after for refreshed headcounts.
    seedTenantIfEmpty(target.id, true);
    window.setTimeout(() => {
      refreshCompanies();
      setFeedback('done');
      window.setTimeout(() => setFeedback('idle'), 4000);
    }, 800);
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <SectionCard
        icon={Database}
        title="Demo-data management"
        description="Force-reseed one tenant's dataset. This is destructive to that tenant's current data."
      >
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Tenant</p>
          <Select
            value={targetId}
            onValueChange={(v) => {
              setTargetId(v);
              setFeedback('idle');
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a company…" />
            </SelectTrigger>
            <SelectContent>
              {companies.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {target ? (
          <div className="rounded-lg border bg-stone-50 p-3 text-sm dark:bg-stone-900/40">
            <p className="font-medium">{target.name}</p>
            <p className="text-xs text-muted-foreground">
              {headcountOf(target.id)} employees on record ·{' '}
              {isDemoTenant ? 'demo tenant — full sample dataset available' : 'custom tenant — no demo dataset'}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Select a tenant to reseed.</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={!target || feedback === 'working'}
            onClick={() => setConfirming(true)}
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            {feedback === 'working' ? 'Reseeding…' : 'Reseed tenant'}
          </Button>
          {feedback === 'done' && (
            <span className="text-sm text-lime-700 dark:text-lime-400">
              Reseed complete — data refreshed.
            </span>
          )}
        </div>
      </SectionCard>

      <SectionCard
        icon={CalendarDays}
        title="Public holidays are global"
        description="One shared holiday collection serves every tenant."
      >
        <p className="text-sm text-muted-foreground">
          The <code className="rounded bg-muted px-1 py-0.5">holidays</code> collection
          (<code className="rounded bg-muted px-1 py-0.5">myhrms:holidays</code>) is
          intentionally <strong>global</strong> — Malaysian public-holiday law is national, so
          curated dates, gazette refreshes and admin overrides apply to all companies at once.
          Per-state differences are resolved per employee via their work-location state, and
          replacement (in-lieu) holidays follow each company's working-week pattern.
        </p>
        <p className="text-sm text-muted-foreground">
          Tenants manage overrides themselves on the Public Holidays page; there is no
          per-tenant holiday namespace to maintain here.
        </p>
        <Button variant="outline" size="sm" onClick={() => navigate('/holidays')}>
          Open Public Holidays
        </Button>
      </SectionCard>

      <div className="lg:col-span-2">
        <SectionCard
          icon={CircleDollarSign}
          title="Plan feature matrix"
          description="Intended entitlements per billing plan — informational only; plan gates are not enforced in this demo build."
          action={
            <Badge variant="outline" className="border-dashed">
              Demo pricing
            </Badge>
          }
        >
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Capability</TableHead>
                  <TableHead className="text-center">Free — RM0</TableHead>
                  <TableHead className="text-center">
                    Pro — RM{PLAN_RATES.pro}/emp/mo
                  </TableHead>
                  <TableHead className="text-center">
                    Enterprise — RM{PLAN_RATES.enterprise}/emp/mo
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {MATRIX.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell>{row.label}</TableCell>
                    <TableCell className="text-center">
                      <MatrixCell on={row.free} />
                    </TableCell>
                    <TableCell className="text-center">
                      <MatrixCell on={row.pro} />
                    </TableCell>
                    <TableCell className="text-center">
                      <MatrixCell on={row.enterprise} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Actual module availability is controlled per company via{' '}
            <code className="rounded bg-muted px-1 py-0.5">config.enabledModules</code> (set in
            the create wizard / tenant settings), not by the plan flag. The MRR estimate on the
            Overview tab uses these rates with live headcounts.
          </p>
        </SectionCard>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reseed {target?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {isDemoTenant
                ? 'This replaces ALL current data in this tenant with the original demo dataset (employees, attendance, leave, claims, payroll…) and restores the original company profile — plan, status and branding edits will be lost. This cannot be undone.'
                : 'This tenant has no demo dataset. Reseeding initialises empty collections only — no demo employees are added, and existing data in missing collections is left untouched.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={reseed}>Reseed tenant</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
