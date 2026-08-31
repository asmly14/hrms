/**
 * Employee loans — company-to-employee lending with payroll repayment.
 *
 * An employee borrows from the company; the loan is repaid by monthly
 * installments deducted from net pay. Repayments are NON-statutory: they
 * reduce NET pay only and never touch the EPF/SOCSO/EIS/PCB wage bases.
 *
 * Malaysian compliance encoded here:
 *  - EA 1955 s.24 — the total of ALL deductions from an employee's wages in
 *    any one month must not exceed 50% of that month's wages. payrollEngine
 *    computes the headroom after statutory + other deductions and deducts
 *    each scheduled installment only up to that headroom; the shortfall is
 *    DEFERRED (the entry is marked 'deferred' and the remaining schedule is
 *    rebuilt, extending the term — installments stay the same, no penalty
 *    interest accrues on the deferred principal).
 *  - EA 1955 s.22/24 — itemized payslips: every deduction appears as its own
 *    payslip line ('Loan repayment — LN-XXX-NNN').
 *
 * Schedule model
 * ──────────────
 * The stored `schedule` is MATERIALIZED: a pure rebuild walks month-by-month
 * from `firstDeductionMonth`, applying the recorded `payments` history. An
 * under-payment (EA s.24 cap) leaves a higher outstanding balance, so the
 * rebuild naturally extends the term with further installment-sized entries
 * (last entry = remainder). Reverting a run's payments (undo / re-run) and
 * rebuilding reproduces the pre-run schedule exactly — the same revert-by-
 * history approach the engine uses for claims.
 *
 * Run lifecycle (mirrors claims): DRAFT runs compute deduction previews but
 * never mark loans; `recordRunLoanDeductions` fires when a run is created
 * finalized or on `finalizePayrollRun`; `undoPayrollRun` calls
 * `revertRunLoanPayments`. Re-running a month first reverts the replaced
 * run's payments for targeted employees (idempotent), then applies the new
 * payslips' deductions; non-targeted employees' payments are re-pointed to
 * the new run id so `paidInRunId` never dangles.
 *
 * Pure client-side: localStorage-backed on the first-class registry
 * collection `loans` (lib/db.ts).
 */
import { getActiveCompany, getCollection, logAudit, setCollection, uid } from './db';
import { round2 } from './utils';

export const LOANS_COLLECTION = 'loans';

/**
 * EA 1955 s.24: total deductions from wages in a month ≤ 50% of the month's
 * wages. payrollEngine enforces this across statutory + adjustment + loan
 * deductions; loans are the LAST (most deferrable) claimant on the headroom.
 */
export const MAX_TOTAL_DEDUCTION_RATIO = 0.5;

/* ────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────── */

export type LoanStatus = 'active' | 'settled' | 'written-off' | 'cancelled';

export type LoanScheduleStatus = 'pending' | 'paid' | 'deferred';

export interface LoanScheduleEntry {
  /** Wage month the installment is deducted in, 'YYYY-MM'. */
  month: string;
  /** Scheduled installment for the month (last entry = remainder). */
  amount: number;
  /** Actually deducted (≤ amount; less only when the EA s.24 cap bit). */
  paidAmount?: number;
  /** Payroll run that deducted the installment. */
  paidInRunId?: string;
  /** 'paid' = deducted in full; 'deferred' = capped, shortfall pushed on. */
  status: LoanScheduleStatus;
}

/** One repayment event against a loan (payroll deduction or settlement). */
export interface LoanPayment {
  /** Wage month the payment was deducted for, 'YYYY-MM'. */
  month: string;
  /** Amount actually applied against the loan. */
  paidAmount: number;
  /** Payroll run that deducted it (absent for manual settlements). */
  runId?: string;
  kind: 'payroll' | 'settlement';
  /** ISO datetime the payment was recorded. */
  at: string;
}

export interface EmployeeLoan {
  id: string;
  employeeId: string;
  /** Human reference, e.g. 'LN-ASM-001' (company code + sequence). */
  refNo: string;
  /** RM lent to the employee. */
  principal: number;
  /** ISO date the loan was issued. */
  issueDate: string;
  /** RM deducted per month. */
  installmentAmount: number;
  /** Schedule length at creation (the term may EXTEND on deferrals). */
  termMonths: number;
  /** Annual nominal rate, % p.a. (default 0 — interest-free advance). */
  interestRate: number;
  /** First wage month an installment is deducted, 'YYYY-MM'. */
  firstDeductionMonth: string;
  status: LoanStatus;
  /** RM repaid to date (payroll deductions + early settlements). */
  paidToDate: number;
  /** RM outstanding = sum of the pending schedule entries. */
  remaining: number;
  /** Materialized schedule — rebuilt from `payments` after every change. */
  schedule: LoanScheduleEntry[];
  /** Repayment history (source of truth for the schedule rebuild). */
  payments: LoanPayment[];
  reason?: string;
  approvedBy: string;
  createdAt: string; // ISO datetime
  /** ISO datetime of an early settlement, when settled that way. */
  settledAt?: string;
  /** Audit note for write-offs / cancellations. */
  statusNote?: string;
}

export interface CreateLoanInput {
  employeeId: string;
  principal: number;
  /** RM per month — XOR `termMonths` (one derives the other). */
  installmentAmount?: number;
  /** Explicit term in months — installment is derived (annuity when interest > 0). */
  termMonths?: number;
  /** Annual rate % p.a.; defaults to 0. */
  interestRate?: number;
  /** ISO date; defaults to today. */
  issueDate?: string;
  /** 'YYYY-MM'; defaults to the month AFTER the issue month. */
  firstDeductionMonth?: string;
  reason?: string;
}

/* ────────────────────────────────────────────────────────────
 * Month helpers
 * ──────────────────────────────────────────────────────────── */

export function nextMonthKey(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ────────────────────────────────────────────────────────────
 * Schedule building & rebuild
 * ──────────────────────────────────────────────────────────── */

/** Hard iteration guard — a valid amortization always terminates long before. */
const MAX_SCHEDULE_MONTHS = 600;

/**
 * Annuity payment for an explicit term with interest: A = P·r / (1 − (1+r)^−n).
 * Returns the UNROUNDED payment; callers round2.
 */
export function annuityPayment(principal: number, termMonths: number, annualRatePct: number): number {
  const r = annualRatePct / 100 / 12;
  if (r <= 0) return principal / termMonths;
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths));
}

/**
 * Materialize the amortization schedule: walk month-by-month from
 * `firstDeductionMonth`, charging monthly interest on the outstanding balance
 * and paying `installmentAmount` (last entry = balance + interest, i.e. the
 * remainder). Months found in `payments` apply their recorded `paidAmount`
 * instead — an under-payment keeps the balance higher, so the schedule
 * extends naturally (EA s.24 deferral) without any destructive rewrite.
 */
function materializeSchedule(
  principal: number,
  installment: number,
  annualRatePct: number,
  firstMonth: string,
  payments: LoanPayment[],
): { schedule: LoanScheduleEntry[]; paidToDate: number; remaining: number } {
  const r = annualRatePct / 100 / 12;
  const payByMonth = new Map<string, LoanPayment[]>();
  for (const p of payments) {
    const list = payByMonth.get(p.month) ?? [];
    list.push(p);
    payByMonth.set(p.month, list);
  }
  const schedule: LoanScheduleEntry[] = [];
  let balance = round2(principal);
  let month = firstMonth;
  let guard = 0;
  while (balance > 0 && guard < MAX_SCHEDULE_MONTHS) {
    guard += 1;
    const interest = round2(balance * r);
    const due = round2(Math.min(installment, balance + interest));
    const events = payByMonth.get(month);
    if (events && events.length > 0) {
      const paid = round2(events.reduce((s, p) => s + p.paidAmount, 0));
      // Settlements pay off the WHOLE outstanding balance, not just the
      // month's installment; payroll deductions stay capped at the due.
      const limit = events.some((p) => p.kind === 'settlement') ? round2(balance + interest) : due;
      const applied = round2(Math.min(paid, limit));
      const payrollRun = events.find((p) => p.runId)?.runId;
      schedule.push({
        month,
        amount: due,
        paidAmount: applied,
        ...(payrollRun ? { paidInRunId: payrollRun } : {}),
        status: applied >= due ? 'paid' : 'deferred',
      });
      balance = round2(balance + interest - applied);
    } else {
      schedule.push({ month, amount: due, status: 'pending' });
      balance = round2(balance + interest - due);
    }
    month = nextMonthKey(month);
  }
  // Rounding sliver: a trailing pending remainder of ≤1% of the installment
  // (e.g. the 0.01 left by 1000 ÷ 3 = 333.33) folds into the previous
  // pending entry so the term holds and the LAST entry carries the remainder.
  if (schedule.length >= 2) {
    const last = schedule[schedule.length - 1]!;
    const prev = schedule[schedule.length - 2]!;
    if (last.status === 'pending' && prev.status === 'pending' && last.amount <= installment * 0.01) {
      prev.amount = round2(prev.amount + last.amount);
      schedule.pop();
    }
  }
  const paidToDate = round2(
    schedule.reduce((s, e) => s + (e.paidAmount ?? 0), 0),
  );
  const remaining = round2(
    schedule.filter((e) => e.status === 'pending').reduce((s, e) => s + e.amount, 0),
  );
  return { schedule, paidToDate, remaining };
}

/** Rebuild a loan's schedule/paidToDate/remaining and re-derive its status. */
function rederive(loan: EmployeeLoan): EmployeeLoan {
  const { schedule, paidToDate, remaining } = materializeSchedule(
    loan.principal,
    loan.installmentAmount,
    loan.interestRate,
    loan.firstDeductionMonth,
    loan.payments,
  );
  let status = loan.status;
  // Manual statuses are sticky; auto-settle only applies to 'active' loans,
  // and a revert of the settling run flips an auto-settled loan back.
  const settledManually =
    status === 'settled' && loan.payments.some((p) => p.kind === 'settlement');
  if (status === 'active' && remaining <= 0) {
    status = 'settled';
  } else if (status === 'settled' && !settledManually && remaining > 0) {
    status = 'active';
  }
  return { ...loan, schedule, paidToDate, remaining, status };
}

/* ────────────────────────────────────────────────────────────
 * Store helpers
 * ──────────────────────────────────────────────────────────── */

export function getLoans(): EmployeeLoan[] {
  return getCollection<EmployeeLoan>(LOANS_COLLECTION);
}

function saveLoans(loans: EmployeeLoan[]): void {
  setCollection(LOANS_COLLECTION, loans);
}

export function getLoan(loanId: string): EmployeeLoan | undefined {
  return getLoans().find((l) => l.id === loanId);
}

function mutateLoan(loanId: string, fn: (loan: EmployeeLoan) => EmployeeLoan): EmployeeLoan | null {
  const loans = getLoans();
  const idx = loans.findIndex((l) => l.id === loanId);
  if (idx < 0) return null;
  const next = fn(loans[idx]);
  loans[idx] = next;
  saveLoans(loans);
  return next;
}

/**
 * Next loan reference: `LN-<COMPANY CODE>-NNN`, sequence continuing past the
 * highest existing number for the prefix (never reused after cancellations).
 */
export function nextLoanRefNo(): string {
  const code = getActiveCompany()?.code?.trim().toUpperCase() || 'CO';
  const prefix = `LN-${code}-`;
  const maxSeq = getLoans().reduce((max, l) => {
    const n = l.refNo.startsWith(prefix) ? Number(l.refNo.slice(prefix.length)) : NaN;
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
}

/* ────────────────────────────────────────────────────────────
 * Creation & lifecycle
 * ──────────────────────────────────────────────────────────── */

/**
 * Create a loan and build its amortization schedule. Exactly one of
 * `installmentAmount` / `termMonths` may be given (the other is derived);
 * with neither, installment defaults to principal ÷ 12. Validations:
 * principal > 0; 0 < installment ≤ principal; with interest the installment
 * must exceed the first month's interest (else the loan never amortizes).
 * Throws on invalid input — callers surface the message.
 */
export function createLoan(input: CreateLoanInput, actor = 'system'): EmployeeLoan {
  const principal = round2(input.principal);
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new Error('Loan principal must be a positive amount.');
  }
  const interestRate = input.interestRate ?? 0;
  if (!Number.isFinite(interestRate) || interestRate < 0) {
    throw new Error('Interest rate must be zero or positive.');
  }
  if (input.installmentAmount !== undefined && input.termMonths !== undefined) {
    throw new Error('Give either an installment amount OR a term in months — not both.');
  }

  let installment: number;
  if (input.installmentAmount !== undefined) {
    installment = round2(input.installmentAmount);
  } else if (input.termMonths !== undefined) {
    const n = Math.round(input.termMonths);
    if (!Number.isFinite(n) || n < 1) throw new Error('Term must be at least 1 month.');
    installment = round2(annuityPayment(principal, n, interestRate));
  } else {
    installment = round2(principal / 12);
  }
  if (!Number.isFinite(installment) || installment <= 0) {
    throw new Error('Installment must be a positive amount.');
  }
  // Spec guard: the monthly installment may not exceed the principal.
  if (installment > principal) {
    throw new Error('Installment cannot exceed the loan principal.');
  }
  const firstInterest = round2(principal * (interestRate / 100 / 12));
  if (interestRate > 0 && installment <= firstInterest) {
    throw new Error(
      `Installment RM${installment.toFixed(2)} does not cover the first month's interest ` +
        `(RM${firstInterest.toFixed(2)}) — the loan would never amortize.`,
    );
  }

  const issueDate = input.issueDate ?? toISODate(new Date());
  const firstDeductionMonth = input.firstDeductionMonth ?? nextMonthKey(issueDate.slice(0, 7));

  const base: EmployeeLoan = {
    id: uid(),
    employeeId: input.employeeId,
    refNo: nextLoanRefNo(),
    principal,
    issueDate,
    installmentAmount: installment,
    termMonths: 0, // derived below from the built schedule
    interestRate,
    firstDeductionMonth,
    status: 'active',
    paidToDate: 0,
    remaining: principal,
    schedule: [],
    payments: [],
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    approvedBy: actor,
    createdAt: new Date().toISOString(),
  };
  const derived = rederive(base);
  const loan: EmployeeLoan = { ...derived, termMonths: derived.schedule.length };
  const loans = getLoans();
  saveLoans([...loans, loan]);
  logAudit({
    actorName: actor,
    action: 'loans.create',
    entity: LOANS_COLLECTION,
    entityId: loan.id,
    detail:
      `${loan.refNo}: RM${principal.toFixed(2)} to ${input.employeeId}, ` +
      `${loan.termMonths}× RM${installment.toFixed(2)} from ${firstDeductionMonth}` +
      (interestRate > 0 ? ` @ ${interestRate}% p.a.` : ''),
  });
  return loan;
}

/**
 * Record one installment payment against a loan (payroll run or settlement).
 * Idempotent per (month, kind, runId): re-recording the same event replaces
 * it, so engine re-runs never double-count. Returns null for unknown loans.
 */
export function recordInstallmentPaid(
  loanId: string,
  month: string,
  runId: string | undefined,
  paidAmount: number,
  kind: 'payroll' | 'settlement' = 'payroll',
): EmployeeLoan | null {
  const amount = round2(Math.max(0, paidAmount));
  return mutateLoan(loanId, (loan) => {
    const payments = loan.payments.filter(
      (p) => !(p.month === month && p.kind === kind && p.runId === runId),
    );
    payments.push({ month, paidAmount: amount, ...(runId ? { runId } : {}), kind, at: new Date().toISOString() });
    return rederive({ ...loan, payments });
  });
}

/**
 * Settle a loan early (employee pays off the outstanding balance outside
 * payroll — e.g. final settlement on resignation): records a settlement
 * payment for the full remaining balance and marks the loan settled.
 */
export function settleEarly(loanId: string, actor = 'system', note?: string): EmployeeLoan | null {
  const loan = getLoan(loanId);
  if (!loan) return null;
  if (loan.status !== 'active') return loan;
  const month = loan.schedule.find((e) => e.status === 'pending')?.month ?? loan.firstDeductionMonth;
  const next = recordInstallmentPaid(loanId, month, undefined, loan.remaining, 'settlement');
  if (!next) return null;
  const finalized = mutateLoan(loanId, (l) => ({
    ...l,
    status: 'settled' as const,
    settledAt: new Date().toISOString(),
    ...(note?.trim() ? { statusNote: note.trim() } : {}),
  }));
  logAudit({
    actorName: actor,
    action: 'loans.settle',
    entity: LOANS_COLLECTION,
    entityId: loanId,
    detail: `${loan.refNo}: settled early — RM${loan.remaining.toFixed(2)} paid off${note ? ` (${note})` : ''}`,
  });
  return finalized;
}

/** Write off a loan (uncollectible — e.g. absconded employee). Audit-logged. */
export function writeOffLoan(loanId: string, actor = 'system', note?: string): EmployeeLoan | null {
  const loan = getLoan(loanId);
  if (!loan || loan.status !== 'active') return loan ?? null;
  const next = mutateLoan(loanId, (l) => ({
    ...l,
    status: 'written-off' as const,
    statusNote: note?.trim() || undefined,
  }));
  logAudit({
    actorName: actor,
    action: 'loans.writeoff',
    entity: LOANS_COLLECTION,
    entityId: loanId,
    detail: `${loan.refNo}: written off — RM${loan.remaining.toFixed(2)} outstanding${note ? ` (${note})` : ''}`,
  });
  return next;
}

/** Cancel a loan created by mistake — only before any payment was recorded. */
export function cancelLoan(loanId: string, actor = 'system', note?: string): EmployeeLoan | null {
  const loan = getLoan(loanId);
  if (!loan) return null;
  if (loan.payments.length > 0) {
    throw new Error('Cannot cancel a loan with recorded payments — write it off or settle it instead.');
  }
  const next = mutateLoan(loanId, (l) => ({
    ...l,
    status: 'cancelled' as const,
    statusNote: note?.trim() || undefined,
  }));
  logAudit({
    actorName: actor,
    action: 'loans.cancel',
    entity: LOANS_COLLECTION,
    entityId: loanId,
    detail: `${loan.refNo}: cancelled${note ? ` (${note})` : ''}`,
  });
  return next;
}

/* ────────────────────────────────────────────────────────────
 * Queries
 * ──────────────────────────────────────────────────────────── */

/** All loans for an employee (any status), newest first. */
export function loansFor(employeeId: string): EmployeeLoan[] {
  return getLoans()
    .filter((l) => l.employeeId === employeeId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Installments DUE from an employee in a wage month: active loans whose
 * schedule has an entry for `month` that is still collectible. An entry
 * already paid by a run OF THE SAME MONTH counts as due again — the
 * superseded run is deleted by the re-run, so its deduction must roll into
 * the replacement payslip (same idempotency rule as claims). Entries paid
 * by runs of OTHER months stay paid.
 */
export function loanInstallmentsDue(
  employeeId: string,
  month: string,
): { loan: EmployeeLoan; entry: LoanScheduleEntry }[] {
  const runsById = new Map(
    getCollection<{ id: string; monthKey: string }>('payrollRuns').map((r) => [r.id, r.monthKey]),
  );
  return getLoans()
    .filter((l) => l.employeeId === employeeId && l.status === 'active')
    .flatMap((loan) => {
      const entry = loan.schedule.find((e) => e.month === month);
      if (!entry || entry.status === 'pending') {
        return entry ? [{ loan, entry }] : [];
      }
      const paidThisMonth = entry.paidInRunId !== undefined && runsById.get(entry.paidInRunId) === month;
      return paidThisMonth ? [{ loan, entry }] : [];
    })
    .sort((a, b) => a.loan.refNo.localeCompare(b.loan.refNo));
}

/** Ledger view of a loan: schedule entries + headline totals. */
export function loanStatement(loanId: string): {
  loan: EmployeeLoan;
  entries: LoanScheduleEntry[];
  totals: { principal: number; paid: number; remaining: number; scheduled: number };
} | null {
  const loan = getLoan(loanId);
  if (!loan) return null;
  return {
    loan,
    entries: loan.schedule,
    totals: {
      principal: loan.principal,
      paid: loan.paidToDate,
      remaining: loan.remaining,
      scheduled: round2(loan.schedule.reduce((s, e) => s + e.amount, 0)),
    },
  };
}

/** Company exposure: active loan count, total outstanding, this-month dues. */
export function loanExposureStats(month: string): {
  activeLoans: number;
  totalOutstanding: number;
  scheduledThisMonth: number;
  totalLent: number;
} {
  const loans = getLoans();
  const active = loans.filter((l) => l.status === 'active');
  const scheduledThisMonth = round2(
    active.reduce((s, l) => {
      const entry = l.schedule.find((e) => e.month === month);
      // Count only collectible entries (not already paid by another month).
      return s + (entry && entry.status !== 'paid' ? entry.amount : 0);
    }, 0),
  );
  return {
    activeLoans: active.length,
    totalOutstanding: round2(active.reduce((s, l) => s + l.remaining, 0)),
    scheduledThisMonth,
    totalLent: round2(active.reduce((s, l) => s + l.principal, 0)),
  };
}

/* ────────────────────────────────────────────────────────────
 * Payroll-run integration (called by payrollEngine only)
 * ──────────────────────────────────────────────────────────── */

/**
 * Apply a finalized run's loan deductions: for every payslip loan line,
 * record the payment (applied amount) against the loan and rebuild. A zero
 * `applied` still records an event — the ledger shows the month as
 * 'deferred' with the run link, and the shortfall extends the schedule.
 */
export function recordRunLoanDeductions(
  runId: string,
  deductions: { employeeId: string; month: string; loanId: string; applied: number }[],
): void {
  const byLoan = new Map<string, { month: string; applied: number }[]>();
  for (const d of deductions) {
    const list = byLoan.get(d.loanId) ?? [];
    list.push({ month: d.month, applied: d.applied });
    byLoan.set(d.loanId, list);
  }
  if (byLoan.size === 0) return;
  const loans = getLoans().map((loan) => {
    const events = byLoan.get(loan.id);
    if (!events) return loan;
    let payments = loan.payments;
    for (const e of events) {
      payments = payments.filter((p) => !(p.month === e.month && p.kind === 'payroll' && p.runId === runId));
      payments = [
        ...payments,
        { month: e.month, paidAmount: round2(Math.max(0, e.applied)), runId, kind: 'payroll' as const, at: new Date().toISOString() },
      ];
    }
    return rederive({ ...loan, payments });
  });
  saveLoans(loans);
}

/**
 * Revert every payroll payment recorded against `runIds` (for the given
 * employees when provided) and rebuild the affected loans — undoPayrollRun
 * and idempotent re-runs restore the exact pre-run schedule this way.
 */
export function revertRunLoanPayments(runIds: Set<string>, employeeIds?: Set<string>): void {
  const loans = getLoans();
  let changed = false;
  const next = loans.map((loan) => {
    if (employeeIds && !employeeIds.has(loan.employeeId)) return loan;
    const kept = loan.payments.filter((p) => !(p.kind === 'payroll' && p.runId !== undefined && runIds.has(p.runId)));
    if (kept.length === loan.payments.length) return loan;
    changed = true;
    return rederive({ ...loan, payments: kept });
  });
  if (changed) saveLoans(next);
}

/**
 * Re-point payroll payments from replaced runs to the new run id (partial
 * re-runs: non-targeted employees' payslips survive on the new run, so their
 * loan payments must follow — paidInRunId never dangles).
 */
export function repointRunLoanPayments(runIds: Set<string>, newRunId: string, employeeIds: Set<string>): void {
  const loans = getLoans();
  let changed = false;
  const next = loans.map((loan) => {
    if (!employeeIds.has(loan.employeeId)) return loan;
    if (!loan.payments.some((p) => p.runId !== undefined && runIds.has(p.runId))) return loan;
    changed = true;
    return {
      ...loan,
      payments: loan.payments.map((p) =>
        p.runId !== undefined && runIds.has(p.runId) ? { ...p, runId: newRunId } : p,
      ),
    };
  });
  if (changed) saveLoans(next);
}
