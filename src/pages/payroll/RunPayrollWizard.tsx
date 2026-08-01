/**
 * 'Run Payroll' wizard — step 1 pick month + employees, step 2 pre-flight
 * compliance checks, step 3 execute `runPayroll(month)` and show the summary.
 * All thresholds come from `@/lib/statutory` constants; nothing is hardcoded.
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle, BadgeCheck, ChevronLeft, ChevronRight, CircleAlert,
  ClipboardCheck, Globe2, Play, Search,
} from 'lucide-react';
import { useCollection } from '@/lib/db';
import { useRole } from '@/lib/roleContext';
import { useAuthSafe } from './useAuthSafe';
import { runPayroll, type PayrollResult } from '@/lib/payrollEngine';
import { MAX_OT_HOURS_MONTH, MINIMUM_WAGE } from '@/lib/statutory';
import { fmtRM, monthKey, round2 } from '@/lib/utils';
import type { AttendanceRecord, Claim, Employee, LeaveRequest } from '@/lib/types';
import { monthLabel, overlapDaysInMonth } from './helpers';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

interface WizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: (runId: string) => void;
}

/** Employees the engine would pick up for a month (mirrors payrollEngine rules). */
function eligibleForMonth(employees: Employee[], month: string): Employee[] {
  return employees.filter((e) =>
    e.status === 'resigned' ? !!e.resignDate && e.resignDate.startsWith(month) : true,
  );
}

interface Preflight {
  belowMinWage: Employee[];
  otOverCap: { emp: Employee; hours: number }[];
  missingNumbers: { emp: Employee; missing: string[] }[];
  foreignWorkers: Employee[];
  otRecords: number;
  otHours: number;
  claimsCount: number;
  claimsTotal: number;
  unpaidLeaveDays: number;
}

export default function RunPayrollWizard({ open, onOpenChange, onCompleted }: WizardProps) {
  const { role: stubRole } = useRole();
  const auth = useAuthSafe();
  // Session role wins for audit attribution; dev stub only pre-login demos.
  const role = auth?.role ?? stubRole;
  const { items: employees } = useCollection<Employee>('employees');
  const { items: attendance } = useCollection<AttendanceRecord>('attendance');
  const { items: leaves } = useCollection<LeaveRequest>('leaves');
  const { items: claims } = useCollection<Claim>('claims');

  const [step, setStep] = useState(1);
  const [month, setMonth] = useState(monthKey());
  const [selected, setSelected] = useState<Set<string> | null>(null); // null = all eligible
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<PayrollResult | null>(null);

  const eligible = useMemo(() => eligibleForMonth(employees, month), [employees, month]);
  const selectedIds = useMemo(
    () => (selected === null ? new Set(eligible.map((e) => e.id)) : selected),
    [selected, eligible],
  );

  const reset = () => {
    setStep(1);
    setMonth(monthKey());
    setSelected(null);
    setQuery('');
    setResult(null);
  };

  const preflight = useMemo<Preflight>(() => {
    const chosen = eligible.filter((e) => selectedIds.has(e.id));
    const belowMinWage = chosen.filter(
      (e) => e.employmentType === 'full-time' && e.baseSalary < MINIMUM_WAGE,
    );
    const otByEmp = new Map<string, { hours: number; records: number }>();
    attendance
      .filter((a) => a.date.startsWith(month) && a.otApproved && a.otHours > 0)
      .forEach((a) => {
        const cur = otByEmp.get(a.employeeId) ?? { hours: 0, records: 0 };
        cur.hours = round2(cur.hours + a.otHours);
        cur.records += 1;
        otByEmp.set(a.employeeId, cur);
      });
    const otOverCap = chosen
      .filter((e) => (otByEmp.get(e.id)?.hours ?? 0) > MAX_OT_HOURS_MONTH)
      .map((e) => ({ emp: e, hours: otByEmp.get(e.id)!.hours }));
    const missingNumbers = chosen
      .map((e) => ({
        emp: e,
        missing: [
          ...(!e.epfNo ? ['EPF no.'] : []),
          ...(!e.socsoNo ? ['SOCSO no.'] : []),
          ...(!e.taxNo ? ['Income tax no.'] : []),
          // B6 — giro file would ship blank bank fields without these.
          ...(!e.bankName || !e.bankAccount ? ['Bank account'] : []),
        ],
      }))
      .filter((x) => x.missing.length > 0);
    const foreignWorkers = chosen.filter((e) => e.isForeignWorker);

    const chosenIds = new Set(chosen.map((e) => e.id));
    const monthClaims = claims.filter(
      (c) => c.status === 'approved' && c.claimDate.startsWith(month) && chosenIds.has(c.employeeId),
    );
    const unpaidLeaveDays = leaves
      .filter(
        (l) =>
          l.type === 'unpaid' && l.status === 'approved' && chosenIds.has(l.employeeId),
      )
      .reduce((s, l) => s + overlapDaysInMonth(l.startDate, l.endDate, month), 0);
    const otRecords = [...otByEmp.entries()].filter(([id]) => chosenIds.has(id));
    return {
      belowMinWage,
      otOverCap,
      missingNumbers,
      foreignWorkers,
      otRecords: otRecords.reduce((s, [, v]) => s + v.records, 0),
      otHours: round2(otRecords.reduce((s, [, v]) => s + v.hours, 0)),
      claimsCount: monthClaims.length,
      claimsTotal: round2(monthClaims.reduce((s, c) => s + c.amount, 0)),
      unpaidLeaveDays,
    };
  }, [eligible, selectedIds, attendance, claims, leaves, month]);

  const execute = () => {
    const ids = eligible.filter((e) => selectedIds.has(e.id)).map((e) => e.id);
    // Kakitangan-style review step: the wizard creates a DRAFT run so HR can
    // adjust per-employee lines (CP38 / Zakat / PTPTN / custom), exclude or
    // reset employees on the run detail page, then finalize to lock it.
    const res = runPayroll(month, ids, role, { draft: true });
    setResult(res);
    setStep(3);
  };

  const filtered = eligible.filter((e) =>
    `${e.name} ${e.ic}`.toLowerCase().includes(query.toLowerCase()),
  );

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selectedIds);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  const steps = ['Month & employees', 'Pre-flight checks', 'Summary'];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run payroll</DialogTitle>
          <DialogDescription>
            Compute EPF, SOCSO, EIS, PCB and HRD levy for a wage month via the statutory engine.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <ol className="flex items-center gap-2 text-xs">
          {steps.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full border font-medium ${
                  step === i + 1
                    ? 'border-amber-600 bg-amber-600/10 text-amber-700'
                    : step > i + 1
                      ? 'border-amber-600 bg-amber-600 text-white'
                      : 'text-muted-foreground'
                }`}
              >
                {i + 1}
              </span>
              <span className={step === i + 1 ? 'font-medium' : 'text-muted-foreground'}>{s}</span>
              {i < steps.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            </li>
          ))}
        </ol>
        <Separator />

        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pay-month">Wage month</Label>
              <Input
                id="pay-month"
                type="month"
                value={month}
                onChange={(e) => {
                  setMonth(e.target.value || monthKey());
                  setSelected(null);
                }}
                className="w-48"
              />
              <p className="text-xs text-muted-foreground">
                Re-running {monthLabel(month)} replaces that month's payslips for the selected employees.
              </p>
            </div>

            <div className="flex items-center justify-between gap-2">
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search name or IC…"
                  className="pl-8"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setSelected(null)}>
                  Select all
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                  None
                </Button>
              </div>
            </div>

            <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border p-2">
              {filtered.length === 0 && (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  No employees match this search.
                </p>
              )}
              {filtered.map((e) => (
                <label
                  key={e.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent"
                >
                  <Checkbox
                    checked={selectedIds.has(e.id)}
                    onCheckedChange={(c) => toggle(e.id, c === true)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{e.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {e.ic} · {fmtRM(e.baseSalary)}
                      {e.status !== 'active' ? ` · ${e.status}` : ''}
                      {e.isForeignWorker ? ' · foreign worker' : ''}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {selectedIds.size} of {eligible.length} employees selected for {monthLabel(month)}.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">Approved OT feeding in</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {preflight.otHours}h
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    ({preflight.otRecords} records)
                  </span>
                </p>
              </div>
              <div className="rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">Approved claims to reimburse</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {fmtRM(preflight.claimsTotal)}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    ({preflight.claimsCount})
                  </span>
                </p>
              </div>
              <div className="rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">Unpaid leave days</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{preflight.unpaidLeaveDays}</p>
              </div>
            </div>

            <CheckItem
              ok={preflight.belowMinWage.length === 0}
              title={`Minimum wage (${fmtRM(MINIMUM_WAGE)})`}
              okText="All selected full-time employees meet the minimum wage."
              items={preflight.belowMinWage.map(
                (e) => `${e.name}: basic ${fmtRM(e.baseSalary)} is below ${fmtRM(MINIMUM_WAGE)}`,
              )}
            />
            <CheckItem
              ok={preflight.otOverCap.length === 0}
              title={`Overtime cap (${MAX_OT_HOURS_MONTH}h/month)`}
              okText="No employee exceeds the statutory OT cap."
              items={preflight.otOverCap.map(
                (x) => `${x.emp.name}: ${x.hours}h approved OT exceeds ${MAX_OT_HOURS_MONTH}h`,
              )}
            />
            <CheckItem
              ok={preflight.missingNumbers.length === 0}
              title="Statutory numbers & bank details"
              okText="EPF / SOCSO / income tax numbers and bank accounts are on file for everyone."
              items={preflight.missingNumbers.map(
                (x) => `${x.emp.name}: missing ${x.missing.join(', ')}`,
              )}
            />
            <CheckItem
              ok={preflight.foreignWorkers.length === 0}
              title="Foreign workers"
              okText="No foreign workers in this run."
              neutral
              items={preflight.foreignWorkers.map(
                (e) => `${e.name}: EPF at the foreign-worker rate applies (mandatory since Oct 2025)`,
              )}
            />
          </div>
        )}

        {step === 3 && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/30">
              <BadgeCheck className="h-5 w-5 text-amber-600" />
              <div>
                <p className="text-sm font-medium">
                  Draft payroll for {monthLabel(result.run.monthKey)} created
                </p>
                <p className="text-xs text-muted-foreground">
                  {result.run.employeeCount} payslips generated · run as {result.run.runBy} ·
                  review &amp; adjust per employee, then finalize on the run detail page
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <SummaryStat label="Total gross" value={fmtRM(result.run.totalGross)} />
              <SummaryStat label="Total net pay" value={fmtRM(result.run.totalNet)} />
              <SummaryStat label="Employer cost" value={fmtRM(result.run.totalEmployerCost)} />
            </div>
            {result.run.warnings.length > 0 && (
              <div className="rounded-xl border p-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  {result.run.warnings.length} compliance warning(s)
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {result.run.warnings.slice(0, 6).map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                  {result.run.warnings.length > 6 && (
                    <li>…and {result.run.warnings.length - 6} more on the run detail page.</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === 2 && (
            <Button variant="outline" onClick={() => setStep(1)}>
              <ChevronLeft className="h-4 w-4" /> Back
            </Button>
          )}
          {step === 1 && (
            <Button
              disabled={selectedIds.size === 0 || !/^\d{4}-\d{2}$/.test(month)}
              onClick={() => setStep(2)}
            >
              Continue <ChevronRight className="h-4 w-4" />
            </Button>
          )}
          {step === 2 && (
            <Button onClick={execute}>
              <Play className="h-4 w-4" /> Create draft for {monthLabel(month)}
            </Button>
          )}
          {step === 3 && result && (
            <Button
              onClick={() => {
                onOpenChange(false);
                reset();
                onCompleted(result.run.id);
              }}
            >
              Review &amp; finalize <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CheckItem({
  ok,
  title,
  okText,
  items,
  neutral = false,
}: {
  ok: boolean;
  title: string;
  okText: string;
  items: string[];
  neutral?: boolean;
}) {
  return (
    <div className="rounded-xl border p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        {ok ? (
          <BadgeCheck className="h-4 w-4 text-emerald-600" />
        ) : neutral ? (
          <Globe2 className="h-4 w-4 text-amber-600" />
        ) : (
          <CircleAlert className="h-4 w-4 text-amber-600" />
        )}
        {title}
        {!ok && <Badge variant="secondary">{items.length}</Badge>}
      </p>
      {ok ? (
        <p className="mt-1 pl-6 text-xs text-muted-foreground">{okText}</p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-11 text-xs text-muted-foreground">
          {items.map((it) => (
            <li key={it}>{it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ClipboardCheck className="h-3.5 w-3.5" /> {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
