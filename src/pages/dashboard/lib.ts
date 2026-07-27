/**
 * Dashboard-local helpers: date math, payroll-cost estimation and the
 * statutory filing calendar. All rates come from @/lib/statutory —
 * nothing is hardcoded here.
 */
import { calcEPF, calcSOCSO, calcEIS, hrdfLevy } from '@/lib/statutory';
import { ageFromDob, round2 } from '@/lib/utils';
import type { Employee } from '@/lib/types';

/** Local date → 'YYYY-MM-DD'. */
export function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayISO(): string {
  return isoOf(new Date());
}

export function addDays(d: Date, days: number): Date {
  const next = new Date(d.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function addMonths(d: Date, months: number): Date {
  const next = new Date(d.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

/** 'YYYY-MM-DD' → '5 Mar' (short axis label). */
export function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** 'YYYY-MM' → 'Mar 26' (short axis label). */
export function shortMonth(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

/**
 * Estimated total employer cost for a month when no payroll run exists yet:
 * (basic + fixed allowances) + employer EPF/SOCSO/EIS + HRD levy, computed
 * per employee through the statutory engine. Estimation only — nothing is
 * persisted; the Payroll module remains the system of record for runs.
 */
export function estimateMonthlyEmployerCost(employees: Employee[]): number {
  const active = employees.filter((e) => e.status !== 'resigned');
  const numLocal = active.filter((e) => !e.isForeignWorker).length;
  const asOf = new Date();
  let total = 0;
  for (const e of active) {
    const wages = round2(e.baseSalary + e.fixedAllowances.reduce((s, a) => s + a.amount, 0));
    const age = ageFromDob(e.dateOfBirth, asOf);
    const epf = calcEPF(wages, age, !e.isForeignWorker, e.isForeignWorker);
    const socso = calcSOCSO(wages, age);
    const eis = calcEIS(wages, age, !e.isForeignWorker);
    const hrd = hrdfLevy(wages, numLocal);
    total += wages + epf.employer + socso.employer + eis.employer + hrd;
  }
  return round2(total);
}

export interface ComplianceDeadline {
  id: string;
  title: string;
  note: string;
  due: string; // ISO date
}

/** Next monthly statutory date (e.g. the 15th), today counts as due-today. */
function nextMonthly(day: number, from: Date): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), day);
  if (d.getTime() < from.getTime()) d.setMonth(d.getMonth() + 1);
  return d;
}

/** Next annual statutory date (month is 0-based), today counts as due-today. */
function nextAnnual(month: number, day: number, from: Date): Date {
  let d = new Date(from.getFullYear(), month, day);
  if (d.getTime() < from.getTime()) d = new Date(from.getFullYear() + 1, month, day);
  return d;
}

/**
 * Malaysian statutory filing calendar (dates are computed, not hardcoded):
 *  - EPF/SOCSO/EIS contributions remittance: 15th of the following month
 *  - CP39 (PCB/MTD) payment to LHDN: 15th of the following month
 *  - HRD Corp levy remittance: 15th of the following month (PSMB Act 2001)
 *  - Form EA to employees: last day of February (leap-year aware)
 *  - Form E employer return: 31 March
 */
export function complianceDeadlines(from: Date = new Date()): ComplianceDeadline[] {
  const midnight = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const feb = nextAnnual(1, 28, midnight);
  const lastDayFeb = new Date(feb.getFullYear(), 2, 0); // day 0 of March = last day of Feb
  return [
    {
      id: 'contrib',
      title: 'EPF / SOCSO / EIS remittance',
      note: 'Contributions for the previous wage period',
      due: isoOf(nextMonthly(15, midnight)),
    },
    {
      id: 'cp39',
      title: 'CP39 — PCB / MTD payment',
      note: 'Monthly tax deductions to LHDN',
      due: isoOf(nextMonthly(15, midnight)),
    },
    {
      id: 'hrd',
      title: 'HRD Corp levy remittance',
      note: 'Monthly levy for registered employers (PSMB Act 2001)',
      due: isoOf(nextMonthly(15, midnight)),
    },
    {
      id: 'ea',
      title: 'Form EA to employees',
      note: 'Annual remuneration statement, previous YA',
      due: isoOf(lastDayFeb),
    },
    {
      id: 'form-e',
      title: 'Form E employer return',
      note: 'Annual employer declaration to LHDN',
      due: isoOf(nextAnnual(2, 31, midnight)),
    },
  ].sort((a, b) => a.due.localeCompare(b.due));
}
