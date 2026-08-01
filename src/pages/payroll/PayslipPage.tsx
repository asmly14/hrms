/**
 * Itemized payslip (EA 1955 s.25A) — company header, employee + statutory
 * numbers, earnings/deduction lines, employer contributions, YTD box via
 * `ytdFor`, big net pay, and a print-friendly sheet (window.print).
 */
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Printer, Receipt, ShieldAlert } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { ytdFor } from '@/lib/payrollEngine';
import { fmtDate, fmtRM, round2 } from '@/lib/utils';
import type {
  Department, Employee, Payslip, Position, Settings as CompanySettings,
} from '@/lib/types';
import { monthLabel } from './helpers';
import { PrintAreaStyles } from './components';
import { useAuthSafe } from './useAuthSafe';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

const PRINT_AREA = 'payslip-print-area';

function kv(label: string, value: string) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground print-text-muted">{label}</p>
      <p className="text-sm font-medium">{value || '—'}</p>
    </div>
  );
}

export default function PayslipPage() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuthSafe();
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');
  const { items: settingsItems } = useCollection<CompanySettings>('settings');

  const slip = payslips.find((p) => p.id === id);
  const emp = slip ? employees.find((e) => e.id === slip.employeeId) : undefined;
  const company = settingsItems[0];

  if (!slip) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <Receipt className="h-10 w-10 text-muted-foreground" />
        <p className="font-medium">Payslip not found</p>
        <p className="text-sm text-muted-foreground">
          It may have been replaced by a re-run of the same month.
        </p>
        <Button variant="outline" asChild>
          <Link to="/payroll">
            <ArrowLeft className="h-4 w-4" /> Back to payroll
          </Link>
        </Button>
      </div>
    );
  }

  // B2 — ownership guard: Employee sees only their own payslip, Manager only
  // their own department's, Admin/HR everything (canViewEmployee encodes this).
  if (auth && !auth.canViewEmployee(slip.employeeId)) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <ShieldAlert className="h-10 w-10 text-amber-600" />
        <p className="font-medium">Access restricted</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          You don't have permission to view this payslip. Employees can only open
          their own payslips; managers only payslips within their department.
        </p>
        <Button variant="outline" asChild>
          <Link to="/payroll">
            <ArrowLeft className="h-4 w-4" /> Back to payroll
          </Link>
        </Button>
      </div>
    );
  }

  const dept = emp ? departments.find((d) => d.id === emp.departmentId) : undefined;
  const pos = emp ? positions.find((p) => p.id === emp.positionId) : undefined;

  // B4 — claim reimbursements are non-statutory: render them in their own
  // block so the earnings table foots exactly to slip.grossPay.
  const earnings = slip.lines.filter((l) => l.kind === 'earning' && !l.nonStatutory);
  const reimbursements = slip.lines.filter((l) => l.kind === 'earning' && l.nonStatutory);
  const deductions = slip.lines.filter((l) => l.kind === 'deduction');
  const employer = slip.lines.filter((l) => l.kind === 'employer');
  const infoLines = slip.lines.filter((l) => l.kind === 'info');
  const totalDeductions = round2(
    slip.epfEmployee + slip.socsoEmployee + slip.eisEmployee + slip.pcb +
    slip.unpaidLeaveDeduction + (slip.adjustmentDeductions ?? 0),
  );
  const employerTotal = round2(
    slip.epfEmployer + slip.socsoEmployer + slip.eisEmployer + slip.hrdLevy,
  );
  // B8 — s.25A wage period: 1st–last day of the payslip month.
  const [wy, wm] = slip.monthKey.split('-').map(Number);
  const wagePeriod =
    wy && wm
      ? `${fmtDate(new Date(wy, wm - 1, 1))} – ${fmtDate(new Date(wy, wm, 0))}`
      : monthLabel(slip.monthKey);
  // YTD box via ytdFor: months before this payslip + this payslip.
  const prior = ytdFor(slip.employeeId, slip.monthKey);

  return (
    <div className="space-y-4">
      <PrintAreaStyles areaClass={PRINT_AREA} />

      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" asChild>
          <Link to={`/payroll/runs/${slip.runId}`}>
            <ArrowLeft className="h-4 w-4" /> Back to run
          </Link>
        </Button>
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Print / save PDF
        </Button>
      </div>

      <div className={`${PRINT_AREA} mx-auto max-w-3xl rounded-xl border bg-card p-6 shadow-sm md:p-8`}>
        {/* Company header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-lg font-semibold">{company?.companyName ?? 'ASM Tech Sdn Bhd'}</p>
            <p className="text-xs text-muted-foreground print-text-muted">
              {company?.companyRegNo ?? ''}
            </p>
            <p className="max-w-xs text-xs text-muted-foreground print-text-muted">
              {company?.address ?? ''}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold uppercase tracking-wide">Payslip</p>
            <p className="text-sm text-muted-foreground print-text-muted">
              {monthLabel(slip.monthKey)}
            </p>
            <p className="text-xs text-muted-foreground print-text-muted">
              Itemized payslip — Employment Act 1955, s.25A
            </p>
          </div>
        </div>

        <Separator className="my-5" />

        {/* Employee + statutory numbers */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 md:grid-cols-4">
          {kv('Employee', emp?.name ?? slip.employeeId)}
          {kv('NRIC / passport', emp?.ic ?? '—')}
          {kv('Department', dept?.name ?? '—')}
          {kv('Position', pos?.title ?? '—')}
          {kv('Wage period', wagePeriod)}
          {kv('EPF no.', emp?.epfNo ?? '—')}
          {kv('SOCSO no.', emp?.socsoNo ?? '—')}
          {kv('Income tax no.', emp?.taxNo ?? '—')}
          {kv('Bank', emp ? `${emp.bankName} ${emp.bankAccount}` : '—')}
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          {/* Earnings */}
          <div>
            <p className="text-sm font-semibold">Earnings</p>
            {slip.otHours > 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground print-text-muted">
                Overtime worked this wage period: {slip.otHours}h
              </p>
            )}
            {/* Proration transparency: days worked + proration note when partial */}
            {infoLines.map((l) => (
              <p key={l.label} className="mt-0.5 text-xs text-muted-foreground print-text-muted">
                {l.label}
              </p>
            ))}
            <table className="mt-2 w-full text-sm">
              <tbody>
                {earnings.map((l) => (
                  <tr key={l.label} className="border-b border-dashed last:border-0">
                    <td className="py-1.5 pr-2">{l.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtRM(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t font-medium">
                  <td className="py-1.5">Gross pay</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtRM(slip.grossPay)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Deductions */}
          <div>
            <p className="text-sm font-semibold">Deductions</p>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {deductions.map((l) => (
                  <tr key={l.label} className="border-b border-dashed last:border-0">
                    <td className="py-1.5 pr-2">{l.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtRM(Math.abs(l.amount))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t font-medium">
                  <td className="py-1.5">Total deductions</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtRM(totalDeductions)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* B4 — Reimbursements: non-statutory, excluded from gross pay */}
        {reimbursements.length > 0 && (
          <div className="mt-6">
            <p className="text-sm font-semibold">Reimbursements (non-statutory)</p>
            <p className="mt-0.5 text-xs text-muted-foreground print-text-muted">
              Claim reimbursements — not subject to EPF / SOCSO / EIS / PCB and excluded from gross pay.
            </p>
            <table className="mt-2 w-full text-sm md:w-1/2">
              <tbody>
                {reimbursements.map((l) => (
                  <tr key={l.label} className="border-b border-dashed last:border-0">
                    <td className="py-1.5 pr-2">{l.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtRM(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t font-medium">
                  <td className="py-1.5">Total reimbursements</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtRM(slip.claimsTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Net pay */}
        <div className="mt-6 flex items-center justify-between rounded-xl bg-amber-50 px-5 py-4 dark:bg-amber-950/30">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground print-text-muted">
              Net pay
            </p>
            <p className="text-xs text-muted-foreground print-text-muted">
              incl. {fmtRM(slip.claimsTotal)} claim reimbursements
            </p>
          </div>
          <p className="text-2xl font-bold tabular-nums">{fmtRM(slip.netPay)}</p>
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          {/* Employer contributions */}
          <div className="rounded-xl border p-4">
            <p className="text-sm font-semibold">Employer contributions (not deducted from pay)</p>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {employer.map((l) => (
                  <tr key={l.label} className="border-b border-dashed last:border-0">
                    <td className="py-1.5 pr-2">{l.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtRM(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t font-medium">
                  <td className="py-1.5">Total employer contributions</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtRM(employerTotal)}</td>
                </tr>
              </tfoot>
            </table>
            {/* B3 — employer cost is a different figure (gross + employer
                statutory + HRD + reimbursements); show it as its own line. */}
            <div className="mt-2 flex items-center justify-between rounded-lg bg-accent/60 px-3 py-2 text-sm">
              <span className="text-muted-foreground print-text-muted">Total employer cost</span>
              <span className="font-medium tabular-nums">{fmtRM(slip.employerCost)}</span>
            </div>
          </div>

          {/* YTD */}
          <div className="rounded-xl border p-4">
            <p className="text-sm font-semibold">
              Year to date ({slip.monthKey.slice(0, 4)}{prior.months > 0 ? ` · ${prior.months + 1} months` : ''})
            </p>
            <table className="mt-2 w-full text-sm">
              <tbody>
                <tr className="border-b border-dashed">
                  <td className="py-1.5">Gross remuneration</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtRM(slip.ytd.gross)}</td>
                </tr>
                <tr className="border-b border-dashed">
                  <td className="py-1.5">EPF (employee)</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtRM(slip.ytd.epf)}</td>
                </tr>
                <tr className="border-b border-dashed">
                  <td className="py-1.5">SOCSO + EIS (employee)</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtRM(slip.ytd.socso)}</td>
                </tr>
                <tr className="border-b border-dashed">
                  <td className="py-1.5">PCB / MTD deducted</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtRM(slip.ytd.pcb)}</td>
                </tr>
                <tr>
                  <td className="py-1.5">Net pay</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtRM(slip.ytd.net)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <Separator className="my-5" />
        <p className="text-[11px] text-muted-foreground print-text-muted">
          Generated {fmtDate(new Date())} by {company?.companyName ?? 'ASM Tech Sdn Bhd'} HRMS.
          Figures computed per EPF Act 1991 (Third Schedule), SOCSO Act 1969, EIS Act 2017,
          PSMB Act 2001 and LHDN computerized PCB specification. This is a computer-generated
          document; no signature is required.
        </p>
      </div>
    </div>
  );
}
