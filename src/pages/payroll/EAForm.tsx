/**
 * EA Form (CP8A) view — pick a year + employee, aggregate the year's
 * payslips into the statutory EA layout, print-ready. Data comes from the
 * payslips collection only; no rates are recomputed here.
 */
import { useMemo, useState } from 'react';
import { FileText, Printer } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { fmtRM, round2 } from '@/lib/utils';
import type {
  Department, Employee, Payslip, Position, Settings as CompanySettings,
} from '@/lib/types';
import { PrintAreaStyles } from './components';
import { canSeeSensitive, useAuthSafe } from './useAuthSafe';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const PRINT_AREA = 'ea-print-area';

function row(label: string, value: string) {
  return (
    <tr className="border-b border-dashed last:border-0">
      <td className="py-1.5 pr-2 text-sm">{label}</td>
      <td className="py-1.5 text-right text-sm font-medium tabular-nums">{value}</td>
    </tr>
  );
}

function detail(label: string, value: string) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground print-text-muted">{label}</p>
      <p className="text-sm font-medium">{value || '—'}</p>
    </div>
  );
}

export default function EAFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const auth = useAuthSafe();
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');
  const { items: settingsItems } = useCollection<CompanySettings>('settings');

  const years = useMemo(() => {
    const set = new Set<string>(payslips.map((p) => p.monthKey.slice(0, 4)));
    set.add(String(new Date().getFullYear()));
    return [...set].sort().reverse();
  }, [payslips]);

  const [year, setYear] = useState<string>('');
  const [employeeId, setEmployeeId] = useState<string>('');
  const effYear = year || years[0] || String(new Date().getFullYear());

  // B2 — scope the employee picker by role: Employee is pinned to their own
  // record (select disabled), Manager picks within their department only,
  // Admin/HR see everyone. IC labels are shown to Admin/HR only.
  const visibleEmployees = auth ? auth.scopeEmployees(employees) : employees;
  const pinnedId = auth?.role === 'Employee' ? auth.employeeId : null;
  const effEmployeeId = pinnedId ?? employeeId;
  const showSensitive = canSeeSensitive(auth);
  const emp = employees.find((e) => e.id === effEmployeeId);

  const slips = useMemo(
    () =>
      payslips
        .filter((p) => p.employeeId === effEmployeeId && p.monthKey.startsWith(effYear))
        .sort((a, b) => a.monthKey.localeCompare(b.monthKey)),
    [payslips, effEmployeeId, effYear],
  );

  const t = useMemo(() => {
    const sum = (fn: (p: Payslip) => number) => round2(slips.reduce((s, p) => s + fn(p), 0));
    return {
      basic: sum((p) => p.basicPay),
      allowances: sum((p) => p.allowances),
      ot: sum((p) => p.otPay),
      gross: sum((p) => p.grossPay),
      claims: sum((p) => p.claimsTotal),
      epfEe: sum((p) => p.epfEmployee),
      epfEr: sum((p) => p.epfEmployer),
      socsoEe: sum((p) => p.socsoEmployee),
      eisEe: sum((p) => p.eisEmployee),
      pcb: sum((p) => p.pcb),
      net: sum((p) => p.netPay),
    };
  }, [slips]);

  const company = settingsItems[0];
  const dept = emp ? departments.find((d) => d.id === emp.departmentId) : undefined;
  const pos = emp ? positions.find((p) => p.id === emp.positionId) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <PrintAreaStyles areaClass={PRINT_AREA} />
        <DialogHeader className="print:hidden">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-amber-600" /> EA form (CP8A)
          </DialogTitle>
          <DialogDescription>
            Annual remuneration statement per Income Tax Act 1967 — issued to every employee by
            the last day of February. Totals are aggregated from stored payslips.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-3 print:hidden">
          <Select value={effYear} onValueChange={setYear}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Year" />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={y}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={effEmployeeId} onValueChange={setEmployeeId} disabled={!!pinnedId}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select employee…" />
            </SelectTrigger>
            <SelectContent>
              {visibleEmployees.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}{showSensitive ? ` · ${e.ic}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {emp && slips.length > 0 && (
            <Button variant="outline" className="ml-auto" onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Print
            </Button>
          )}
        </div>

        {!emp ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-center">
            <FileText className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Pick a year and an employee to preview the EA form.
            </p>
          </div>
        ) : slips.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-center">
            <FileText className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">No payslips for {emp.name} in {effYear}</p>
            <p className="text-sm text-muted-foreground">
              Run payroll for that year first — the EA form aggregates stored payslips.
            </p>
          </div>
        ) : (
          <div className={`${PRINT_AREA} rounded-xl border bg-card p-6`}>
            <div className="text-center">
              <p className="text-xs uppercase tracking-wide text-muted-foreground print-text-muted">
                Borang EA · CP8A
              </p>
              <p className="text-base font-semibold">
                Private Sector Employee's Statement of Remuneration — Year of Assessment {effYear}
              </p>
            </div>

            <Separator className="my-4" />

            {/* Employer */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              {detail('Employer', company?.companyName ?? 'ASM Tech Sdn Bhd')}
              {detail('Employer no. (E no.)', company?.taxEmployerNo ?? '—')}
              {detail('EPF employer no.', company?.epfEmployerNo ?? '—')}
            </div>

            <p className="mt-5 text-sm font-semibold">Part A — Employee particulars</p>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              {detail('Name', emp.name)}
              {detail('NRIC / passport no.', emp.ic)}
              {detail('Income tax no.', emp.taxNo)}
              {detail('EPF member no.', emp.epfNo)}
              {detail('SOCSO no.', emp.socsoNo)}
              {detail('Department / position', `${dept?.name ?? '—'} / ${pos?.title ?? '—'}`)}
              {detail('Marital status', emp.maritalStatus)}
              {detail('Months remunerated', String(slips.length))}
            </div>

            <div className="mt-5 grid gap-6 md:grid-cols-2">
              <div>
                <p className="text-sm font-semibold">Part B — Remuneration</p>
                <table className="mt-2 w-full">
                  <tbody>
                    {row('Salary, wages & leave pay', fmtRM(t.basic))}
                    {row('Fixed allowances', fmtRM(t.allowances))}
                    {row('Overtime payments', fmtRM(t.ot))}
                    {row('Gross remuneration', fmtRM(t.gross))}
                    {row('Benefits-in-kind (BIK)', fmtRM(0))}
                    {row('Value of living accommodation (VOLA)', fmtRM(0))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t font-semibold">
                      <td className="py-1.5 text-sm">Total gross remuneration</td>
                      <td className="py-1.5 text-right text-sm tabular-nums">
                        {fmtRM(t.gross)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                {/* B7 — expense reimbursements are NOT remuneration on the EA
                    form; shown as a memo line only, never added to the total. */}
                {t.claims > 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground print-text-muted">
                    Memo: {fmtRM(t.claims)} of claim reimbursements (non-taxable) were paid
                    during {effYear} — for information only; not part of taxable remuneration.
                  </p>
                )}
              </div>

              <div>
                <p className="text-sm font-semibold">Part D — Deductions & contributions</p>
                <table className="mt-2 w-full">
                  <tbody>
                    {row('Monthly tax deductions (PCB/MTD)', fmtRM(t.pcb))}
                    {row('EPF — employee share', fmtRM(t.epfEe))}
                    {row('SOCSO — employee share', fmtRM(t.socsoEe))}
                    {row('EIS (SIP) — employee share', fmtRM(t.eisEe))}
                    {row('CP38 (arrears deduction)', fmtRM(0))}
                  </tbody>
                </table>
                <p className="mt-3 text-sm font-semibold">Part E — EPF summary</p>
                <table className="mt-2 w-full">
                  <tbody>
                    {row('EPF employee contributions', fmtRM(t.epfEe))}
                    {row('EPF employer contributions', fmtRM(t.epfEr))}
                    {row('Net remuneration paid', fmtRM(t.net))}
                  </tbody>
                </table>
              </div>
            </div>

            <Separator className="my-4" />
            <div className="flex items-end justify-between">
              <p className="max-w-sm text-[11px] text-muted-foreground print-text-muted">
                Prepared from computerized payroll records (LHDN-compliant PCB calculation).
                Reference: payslips {slips[0]?.monthKey} to {slips[slips.length - 1]?.monthKey}.
              </p>
              <div className="text-center">
                <div className="h-10 w-44 border-b border-foreground/40" />
                <p className="mt-1 text-[11px] text-muted-foreground print-text-muted">
                  Employer / authorized officer
                </p>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
