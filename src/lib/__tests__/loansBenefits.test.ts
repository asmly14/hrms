/**
 * Employee loans + recurring benefits tests (CompExtras wave).
 *
 * Covers:
 *  - loan schedule building (installment / term / annuity, remainder last
 *    entry, validations), ref numbering, settle / write-off / cancel;
 *  - payroll auto-deduction as a NET-ONLY non-statutory line, draft →
 *    finalize marking, undo restore, idempotent re-runs;
 *  - the EA 1955 s.24 50%-of-wages cap: headroom math, deferral, schedule
 *    rebuild (term extension) and payslip/run warnings;
 *  - recurring-benefit month matching (monthly / annual / window), engine
 *    injection and treatment → wage-base effects (reimbursement / non-cash
 *    BIK / taxable allowance), draft-run per-payslip skip + reset re-add;
 *  - backward compatibility: runs without loans/benefits are byte-identical
 *    in shape (no new payslip fields) to pre-feature payslips.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { getCollection, saveCompanies, setCollection } from '../db';
import {
  finalizePayrollRun, resetPayslipToDefaults, runPayroll, undoPayrollRun,
  updateDraftPayslip,
} from '../payrollEngine';
import {
  createLoan, getLoan, getLoans, loanExposureStats, loanInstallmentsDue, loanStatement,
  recordInstallmentPaid, settleEarly, writeOffLoan, cancelLoan,
  type EmployeeLoan,
} from '../loans';
import {
  benefitsForMonth, createBenefit, endBenefit, type RecurringBenefit,
} from '../benefits';
import { round2 } from '../utils';
import type { Company, Employee, Payslip } from '../types';

const MONTH = '2025-03';

const testCompany: Company = {
  id: 'co-asm',
  code: 'ASM',
  name: 'ASM Tech Sdn Bhd',
  regNo: '202401000001',
  hqState: 'KUL',
  status: 'active',
  plan: 'pro',
  createdAt: '2025-01-01T00:00:00.000Z',
  branding: { logoText: 'ASM', accentColor: '#b45309' },
  config: {
    workingWeek: 'sat-sun',
    payrollCutoffDay: 25,
    payrollProration: 'fixed-26',
    claimPolicy: {},
    leaveTopUps: {},
    enabledModules: ['attendance', 'leave', 'claims', 'payroll', 'kpi', 'insights', 'reports', 'onboarding', 'offboarding'],
    customFields: [],
    numberFormats: { employeeIdPrefix: 'ASM', payslipPrefix: 'ASM-PS' },
    orgChart: { showDottedLineReports: false },
  },
};

const emp1: Employee = {
  id: 'emp-1',
  name: 'Test Employee One',
  ic: '900101-01-1234',
  email: 'one@test.my',
  phone: '012-3456789',
  departmentId: 'dept-1',
  positionId: 'pos-1',
  role: 'employee',
  joinDate: '2023-01-01',
  state: 'KUL',
  employmentType: 'full-time',
  status: 'active',
  baseSalary: 3000,
  maritalStatus: 'single',
  children: 0,
  bankName: 'Maybank',
  bankAccount: '1234567890',
  epfNo: 'EPF1',
  socsoNo: 'SOC1',
  taxNo: 'TAX1',
  isForeignWorker: false,
  dateOfBirth: '1990-01-01',
  gender: 'male',
  fixedAllowances: [],
};

/** Low-wage employee for the EA s.24 cap tests. */
const empLow: Employee = {
  ...emp1,
  id: 'emp-low',
  name: 'Low Wage',
  email: 'low@test.my',
  baseSalary: 1000,
};

function seedAll(employees: Employee[] = [emp1]): void {
  saveCompanies([testCompany]);
  setCollection('employees', employees);
  setCollection('attendance', []);
  setCollection('leaves', []);
  setCollection('claims', []);
  setCollection('payrollRuns', []);
  setCollection('payslips', []);
  setCollection('audit', []);
  setCollection('loans', []);
  setCollection('benefits', []);
}

beforeEach(() => {
  installLocalStorage();
  seedAll();
});

function slipOf(result: { payslips: Payslip[] } | Payslip[], employeeId = emp1.id): Payslip {
  const list = Array.isArray(result) ? result : result.payslips;
  const p = list.find((s) => s.employeeId === employeeId);
  if (!p) throw new Error(`no payslip for ${employeeId}`);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loan schedule building
// ─────────────────────────────────────────────────────────────────────────────

describe('createLoan — schedule building', () => {
  it('installment mode: equal installments, last entry = remainder', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 1000, installmentAmount: 300, firstDeductionMonth: MONTH },
      'hr',
    );
    expect(loan.refNo).toBe('LN-ASM-001');
    expect(loan.termMonths).toBe(4);
    expect(loan.schedule.map((e) => e.amount)).toEqual([300, 300, 300, 100]);
    expect(loan.schedule.map((e) => e.month)).toEqual(['2025-03', '2025-04', '2025-05', '2025-06']);
    expect(loan.schedule.every((e) => e.status === 'pending')).toBe(true);
    expect(loan.remaining).toBe(1000);
    expect(loan.paidToDate).toBe(0);
  });

  it('term mode: installment derived, rounding remainder lands on the last entry', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 1000, termMonths: 3, firstDeductionMonth: MONTH },
      'hr',
    );
    expect(loan.installmentAmount).toBe(333.33);
    expect(loan.schedule.map((e) => e.amount)).toEqual([333.33, 333.33, 333.34]);
    expect(loan.remaining).toBe(1000);
  });

  it('defaults the first deduction to the month AFTER the issue month', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 500, installmentAmount: 100, issueDate: '2025-03-10' },
      'hr',
    );
    expect(loan.firstDeductionMonth).toBe('2025-04');
    expect(loan.schedule[0]!.month).toBe('2025-04');
  });

  it('interest-bearing annuity amortizes: interest decreases, term holds', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 1000, termMonths: 12, interestRate: 12, firstDeductionMonth: MONTH },
      'hr',
    );
    expect(loan.schedule).toHaveLength(12);
    // 1%/month on a falling balance → first interest 10.00, payment 88.85 annuity.
    expect(loan.installmentAmount).toBe(88.85);
    const totalScheduled = round2(loan.schedule.reduce((s, e) => s + e.amount, 0));
    expect(totalScheduled).toBeGreaterThan(1000); // principal + interest
    expect(loan.remaining).toBe(totalScheduled);
    // Every entry but the last equals the annuity installment.
    for (const e of loan.schedule.slice(0, -1)) expect(e.amount).toBe(88.85);
  });

  it('validates input: installment ≤ principal, not both modes, amortizes', () => {
    expect(() =>
      createLoan({ employeeId: emp1.id, principal: 100, installmentAmount: 150 }, 'hr'),
    ).toThrow(/exceed the loan principal/);
    expect(() =>
      createLoan({ employeeId: emp1.id, principal: 100, installmentAmount: 10, termMonths: 10 }, 'hr'),
    ).toThrow(/not both/);
    expect(() =>
      createLoan({ employeeId: emp1.id, principal: 1000, installmentAmount: 9, interestRate: 12 }, 'hr'),
    ).toThrow(/never amortize/);
    expect(() => createLoan({ employeeId: emp1.id, principal: 0, installmentAmount: 10 }, 'hr')).toThrow();
  });

  it('ref numbers continue past existing loans (never reused)', () => {
    const a = createLoan({ employeeId: emp1.id, principal: 100, installmentAmount: 50 }, 'hr');
    const b = createLoan({ employeeId: emp1.id, principal: 200, installmentAmount: 50 }, 'hr');
    expect(a.refNo).toBe('LN-ASM-001');
    expect(b.refNo).toBe('LN-ASM-002');
  });
});

describe('loan lifecycle — payments, deferral rebuild, settle, write-off', () => {
  it('partial payment marks the entry deferred and rebuilds the tail', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 1000, installmentAmount: 300, firstDeductionMonth: MONTH },
      'hr',
    );
    const next = recordInstallmentPaid(loan.id, MONTH, 'run-1', 100)!;
    const [first, ...tail] = next.schedule;
    expect(first).toMatchObject({ month: MONTH, amount: 300, paidAmount: 100, paidInRunId: 'run-1', status: 'deferred' });
    // RM900 outstanding → three more 300 installments (term holds at 4 entries).
    expect(tail.map((e) => e.amount)).toEqual([300, 300, 300]);
    expect(next.paidToDate).toBe(100);
    expect(next.remaining).toBe(900);
  });

  it('a fully-paid final installment auto-settles the loan', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 100, installmentAmount: 100, firstDeductionMonth: MONTH },
      'hr',
    );
    const next = recordInstallmentPaid(loan.id, MONTH, 'run-1', 100)!;
    expect(next.status).toBe('settled');
    expect(next.remaining).toBe(0);
    expect(next.schedule[0]!.status).toBe('paid');
  });

  it('settleEarly pays off the balance outside payroll', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 1000, installmentAmount: 300, firstDeductionMonth: MONTH },
      'hr',
    );
    recordInstallmentPaid(loan.id, MONTH, 'run-1', 300);
    const settled = settleEarly(loan.id, 'hr')!;
    expect(settled.status).toBe('settled');
    expect(settled.remaining).toBe(0);
    expect(settled.paidToDate).toBe(1000);
    const stmt = loanStatement(loan.id)!;
    expect(stmt.totals.paid).toBe(1000);
  });

  it('write-off freezes the loan; cancel requires zero payments', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 1000, installmentAmount: 300, firstDeductionMonth: MONTH },
      'hr',
    );
    expect(cancelLoan(loan.id, 'hr')!.status).toBe('cancelled');

    const loan2 = createLoan({ employeeId: emp1.id, principal: 500, installmentAmount: 100, firstDeductionMonth: MONTH }, 'hr');
    recordInstallmentPaid(loan2.id, MONTH, 'run-1', 100);
    expect(() => cancelLoan(loan2.id, 'hr')).toThrow(/payments/);
    const off = writeOffLoan(loan2.id, 'hr', 'absconded')!;
    expect(off.status).toBe('written-off');
    // Written-off loans drop out of the due list and exposure stats.
    expect(loanInstallmentsDue(emp1.id, MONTH)).toHaveLength(0);
  });

  it('loanInstallmentsDue picks up active loans with a pending entry for the month', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 600, installmentAmount: 200, firstDeductionMonth: '2025-04' },
      'hr',
    );
    expect(loanInstallmentsDue(emp1.id, MONTH)).toHaveLength(0);
    const due = loanInstallmentsDue(emp1.id, '2025-04');
    expect(due).toHaveLength(1);
    expect(due[0]!.loan.id).toBe(loan.id);
    expect(due[0]!.entry.amount).toBe(200);
  });

  it('exposure stats aggregate active loans only', () => {
    createLoan({ employeeId: emp1.id, principal: 1000, installmentAmount: 300, firstDeductionMonth: MONTH }, 'hr');
    createLoan({ employeeId: emp1.id, principal: 500, installmentAmount: 100, firstDeductionMonth: '2025-05' }, 'hr');
    const stats = loanExposureStats(MONTH);
    expect(stats.activeLoans).toBe(2);
    expect(stats.totalOutstanding).toBe(1500);
    expect(stats.scheduledThisMonth).toBe(300);
    expect(stats.totalLent).toBe(1500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payroll integration — auto-deduction, finalize, undo, idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('payroll integration — loan auto-deduction', () => {
  function loanForEmp(amount = 1200, installment = 400): EmployeeLoan {
    return createLoan(
      { employeeId: emp1.id, principal: amount, installmentAmount: installment, firstDeductionMonth: MONTH },
      'hr',
    );
  }

  it('deducts the installment as a NET-ONLY line (statutory bases untouched)', () => {
    const loan = loanForEmp();
    const { payslips } = runPayroll(MONTH);
    const p = slipOf(payslips);
    const d = p.loanDeductions![0]!;
    expect(d).toMatchObject({ loanId: loan.id, refNo: 'LN-ASM-001', scheduled: 400, applied: 400, deferred: 0 });
    expect(p.loanDeductionTotal).toBe(400);
    // Net identity holds with the loan inside it.
    expect(p.netPay).toBe(
      round2(p.grossPay - p.epfEmployee - p.socsoEmployee - p.eisEmployee - p.pcb + p.claimsTotal - 400),
    );
    // Bases never see the loan.
    expect(p.epfBase).toBe(3000);
    expect(p.socsoBase).toBe(3000);
    expect(p.lines.some((l) => l.label === 'Loan repayment — LN-ASM-001' && l.amount === -400 && l.kind === 'deduction')).toBe(true);
  });

  it('direct finalized run marks the schedule entry paid; undo restores it', () => {
    const loan = loanForEmp();
    const { run } = runPayroll(MONTH);
    let stored = getLoan(loan.id)!;
    expect(stored.paidToDate).toBe(400);
    expect(stored.remaining).toBe(800);
    const entry = stored.schedule.find((e) => e.month === MONTH)!;
    expect(entry).toMatchObject({ status: 'paid', paidAmount: 400, paidInRunId: run.id });

    expect(undoPayrollRun(run.id)).toBe(true);
    stored = getLoan(loan.id)!;
    expect(stored.paidToDate).toBe(0);
    expect(stored.remaining).toBe(1200);
    expect(stored.schedule.every((e) => e.status === 'pending')).toBe(true);
    expect(stored.payments).toHaveLength(0);
  });

  it('draft runs preview but never mark; finalize records the installments', () => {
    const loan = loanForEmp();
    const { run, payslips } = runPayroll(MONTH, undefined, 'test', { draft: true });
    expect(slipOf(payslips).loanDeductionTotal).toBe(400);
    // Draft: loan untouched.
    expect(getLoan(loan.id)!.paidToDate).toBe(0);
    expect(getLoan(loan.id)!.schedule[0]!.status).toBe('pending');

    finalizePayrollRun(run.id);
    const stored = getLoan(loan.id)!;
    expect(stored.paidToDate).toBe(400);
    expect(stored.schedule.find((e) => e.month === MONTH)).toMatchObject({
      status: 'paid', paidAmount: 400, paidInRunId: run.id,
    });
  });

  it('re-running the same month is idempotent — never double-counts', () => {
    const loan = loanForEmp();
    runPayroll(MONTH);
    runPayroll(MONTH);
    runPayroll(MONTH);
    const stored = getLoan(loan.id)!;
    expect(stored.paidToDate).toBe(400);
    expect(stored.payments).toHaveLength(1);
    expect(stored.schedule.filter((e) => e.status === 'paid')).toHaveLength(1);
  });

  it('a loan settles automatically when the last installment is deducted', () => {
    const loan = createLoan(
      { employeeId: emp1.id, principal: 400, installmentAmount: 400, firstDeductionMonth: MONTH },
      'hr',
    );
    runPayroll(MONTH);
    const stored = getLoan(loan.id)!;
    expect(stored.status).toBe('settled');
    expect(stored.remaining).toBe(0);
    // Next month: nothing due.
    expect(loanInstallmentsDue(emp1.id, '2025-04')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EA 1955 s.24 — 50% of wages cap with deferral
// ─────────────────────────────────────────────────────────────────────────────

describe('EA 1955 s.24 — total deductions capped at 50% of wages', () => {
  it('caps the installment at the post-statutory headroom and defers the shortfall', () => {
    seedAll([empLow]);
    const loan = createLoan(
      { employeeId: empLow.id, principal: 1800, installmentAmount: 450, firstDeductionMonth: MONTH },
      'hr',
    );
    const { run, payslips } = runPayroll(MONTH);
    const p = slipOf(payslips, empLow.id);
    const d = p.loanDeductions![0]!;

    // Headroom = 50% of gross − statutory employee deductions (loans last).
    const headroom = round2(
      p.grossPay * 0.5 - p.epfEmployee - p.socsoEmployee - p.eisEmployee - p.pcb,
    );
    expect(d.scheduled).toBe(450);
    expect(d.applied).toBe(round2(Math.min(450, headroom)));
    expect(d.applied).toBeLessThan(450);
    expect(d.deferred).toBe(round2(450 - d.applied));

    // Total deductions never exceed 50% of wages.
    const totalDeductions = round2(
      p.epfEmployee + p.socsoEmployee + p.eisEmployee + p.pcb + p.loanDeductionTotal!,
    );
    expect(totalDeductions).toBeLessThanOrEqual(round2(p.grossPay * 0.5));

    // Payslip info line + run warning name the deferral.
    expect(p.lines.some((l) => l.kind === 'info' && l.label.includes('EA 1955 s.24'))).toBe(true);
    expect(run.warnings.some((w) => w.includes(loan.refNo) && w.includes('deferred'))).toBe(true);

    // Finalized run → the schedule records a partial (deferred) month and the
    // term extends so the shortfall is recovered later (no penalty interest).
    const stored = getLoan(loan.id)!;
    const entry = stored.schedule.find((e) => e.month === MONTH)!;
    expect(entry).toMatchObject({ status: 'deferred', paidAmount: d.applied });
    expect(stored.schedule.length).toBeGreaterThan(4); // 1800 ÷ 450 originally 4
    expect(stored.paidToDate).toBe(d.applied);
    expect(stored.remaining).toBe(round2(1800 - d.applied));
  });

  it('zero headroom defers the whole installment (payslip stays payable)', () => {
    // Minimum-wage employee whose statutory alone nearly reaches the cap:
    // shrink the headroom to exactly 0 via a CP38-style deduction adjustment
    // in a draft run.
    seedAll([empLow]);
    createLoan(
      { employeeId: empLow.id, principal: 900, installmentAmount: 200, firstDeductionMonth: MONTH },
      'hr',
    );
    const { run } = runPayroll(MONTH, undefined, 'test', { draft: true });
    const before = slipOf({ payslips: getCollection<Payslip>('payslips') }, empLow.id);
    const headroom = round2(
      before.grossPay * 0.5 - before.epfEmployee - before.socsoEmployee - before.eisEmployee - before.pcb,
    );
    const adjusted = updateDraftPayslip(
      run.id,
      empLow.id,
      {
        adjustments: [
          { id: 'adj-1', kind: 'deduction', preset: 'custom', label: 'Big deduction', amount: headroom },
        ],
      },
      'test',
    )!;
    const d = adjusted.loanDeductions![0]!;
    expect(d.applied).toBe(0);
    expect(d.deferred).toBe(200);
    // And the payslip still nets out (loan line absent at zero, info line present).
    expect(adjusted.lines.some((l) => l.label.startsWith('Loan repayment —'))).toBe(false);
    expect(adjusted.lines.some((l) => l.kind === 'info' && l.label.includes('deferred'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Recurring benefits
// ─────────────────────────────────────────────────────────────────────────────

describe('benefitsForMonth — frequency & window matching', () => {
  it('monthly benefits match every month in the window; annual only their month', () => {
    const monthly = createBenefit(
      { employeeId: emp1.id, benefitKey: 'health-insurance', amount: 150, frequency: 'monthly', startMonth: '2025-01' },
      'hr',
    );
    const annual = createBenefit(
      { employeeId: emp1.id, benefitKey: 'group-insurance', amount: 1200, frequency: 'annual', annualMonth: 3, startMonth: '2025-01' },
      'hr',
    );
    const mar = benefitsForMonth(emp1.id, '2025-03').map((b) => b.id);
    const apr = benefitsForMonth(emp1.id, '2025-04').map((b) => b.id);
    expect(mar).toContain(monthly.id);
    expect(mar).toContain(annual.id);
    expect(apr).toContain(monthly.id);
    expect(apr).not.toContain(annual.id);
  });

  it('respects start/end months and status', () => {
    const b = createBenefit(
      { employeeId: emp1.id, benefitKey: 'gym-wellness', amount: 100, frequency: 'monthly', startMonth: '2025-02', endMonth: '2025-03' },
      'hr',
    );
    expect(benefitsForMonth(emp1.id, '2025-01')).toHaveLength(0);
    expect(benefitsForMonth(emp1.id, '2025-02')).toHaveLength(1);
    expect(benefitsForMonth(emp1.id, '2025-04')).toHaveLength(0);
    endBenefit(b.id, 'hr');
    expect(benefitsForMonth(emp1.id, '2025-03')).toHaveLength(0);
  });

  it('validates: annual benefits need an injection month', () => {
    expect(() =>
      createBenefit(
        { employeeId: emp1.id, benefitKey: 'group-insurance', amount: 100, frequency: 'annual', startMonth: '2025-01' },
        'hr',
      ),
    ).toThrow(/injection month/);
  });

  it('preset defaults the treatment; custom names override the label', () => {
    const b = createBenefit(
      { employeeId: emp1.id, benefitKey: 'health-insurance', amount: 150, frequency: 'monthly', startMonth: '2025-01' },
      'hr',
    ) as RecurringBenefit;
    expect(b.name).toBe('Personal Health Insurance');
    expect(b.treatment).toBe('nonStatutory-reimbursement');
  });
});

describe('payroll integration — benefit injection & treatment → wage bases', () => {
  function baseRun(): Payslip {
    return slipOf(runPayroll(MONTH));
  }

  it('non-statutory reimbursement: paid in NET, outside gross and all bases', () => {
    const base = baseRun();
    createBenefit(
      { employeeId: emp1.id, benefitKey: 'health-insurance', amount: 150, frequency: 'monthly', startMonth: '2025-01' },
      'hr',
    );
    const p = baseRun();
    expect(p.benefits).toHaveLength(1);
    expect(p.benefitReimbursements).toBe(150);
    expect(p.grossPay).toBe(base.grossPay);
    expect(p.epfBase).toBe(base.epfBase);
    expect(p.socsoBase).toBe(base.socsoBase);
    expect(p.eisBase).toBe(base.eisBase);
    expect(p.pcbBase).toBe(base.pcbBase);
    expect(p.netPay).toBe(round2(base.netPay + 150));
    expect(p.employerCost).toBe(round2(base.employerCost + 150));
    expect(
      p.lines.some((l) => l.label === 'Benefit — Personal Health Insurance' && l.amount === 150 && l.nonStatutory === true),
    ).toBe(true);
  });

  it('non-cash BIK: never gross or net, feeds the PCB base only (TP2)', () => {
    const base = baseRun();
    createBenefit(
      { employeeId: emp1.id, benefitKey: 'group-insurance', amount: 200, frequency: 'monthly', startMonth: '2025-01' },
      'hr',
    );
    const p = baseRun();
    expect(p.benefitNonCash).toBe(200);
    expect(p.grossPay).toBe(base.grossPay);
    expect(p.epfBase).toBe(base.epfBase);
    expect(p.socsoBase).toBe(base.socsoBase);
    // PCB normal-remuneration base picks up the BIK amount.
    expect(p.pcbBase).toBe(round2(base.pcbBase! + 200));
    // The BIK line renders in the non-cash block, never as cash.
    const line = p.lines.find((l) => l.label === 'Benefit — Group Insurance Premium')!;
    expect(line.nonCash).toBe(true);
    expect(line.kind).toBe('earning');
  });

  it('taxable allowance: joins gross and EVERY statutory base', () => {
    const base = baseRun();
    createBenefit(
      { employeeId: emp1.id, benefitKey: 'childcare-subsidy', amount: 300, frequency: 'monthly', startMonth: '2025-01' },
      'hr',
    );
    const p = baseRun();
    expect(p.benefitWages).toBe(300);
    expect(p.grossPay).toBe(round2(base.grossPay + 300));
    expect(p.epfBase).toBe(round2(base.epfBase! + 300));
    expect(p.socsoBase).toBe(round2(base.socsoBase! + 300));
    expect(p.eisBase).toBe(round2(base.eisBase! + 300));
    expect(p.pcbBase).toBe(round2(base.pcbBase! + 300));
    expect(p.epfEmployee).toBeGreaterThan(base.epfEmployee);
  });

  it('annual benefits inject only in their month (idempotent across re-runs)', () => {
    createBenefit(
      { employeeId: emp1.id, benefitKey: 'group-insurance', amount: 500, frequency: 'annual', annualMonth: 3, startMonth: '2025-01' },
      'hr',
    );
    const mar = baseRun();
    const apr = slipOf(runPayroll('2025-04'));
    expect(mar.benefitNonCash).toBe(500);
    expect(apr.benefits).toBeUndefined();
    // Re-running the same month injects exactly once (derived, not stamped).
    const marAgain = baseRun();
    expect(marAgain.benefitNonCash).toBe(500);
    expect(marAgain.benefits).toHaveLength(1);
  });

  it('draft editor can skip a benefit for one run; reset re-adds it', () => {
    const b = createBenefit(
      { employeeId: emp1.id, benefitKey: 'health-insurance', amount: 150, frequency: 'monthly', startMonth: '2025-01' },
      'hr',
    );
    const { run } = runPayroll(MONTH, undefined, 'test', { draft: true });
    const skipped = updateDraftPayslip(run.id, emp1.id, { excludeBenefitIds: [b.id] }, 'test')!;
    expect(skipped.benefits).toBeUndefined();
    expect(skipped.benefitReimbursements).toBeUndefined();
    expect(skipped.excludedBenefitIds).toEqual([b.id]);
    // The benefit record itself is untouched.
    expect(benefitsForMonth(emp1.id, MONTH).map((x) => x.id)).toContain(b.id);
    // Reset restores the engine default → benefit re-injected.
    const reset = resetPayslipToDefaults(run.id, emp1.id, 'test')!;
    expect(reset.benefitReimbursements).toBe(150);
    expect(reset.excludedBenefitIds).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backward compatibility
// ─────────────────────────────────────────────────────────────────────────────

describe('backward compatibility', () => {
  it('runs without loans/benefits produce payslips with no new fields', () => {
    const p = baseRunForCompat();
    expect('loanDeductions' in p).toBe(false);
    expect('loanDeductionTotal' in p).toBe(false);
    expect('benefits' in p).toBe(false);
    expect('benefitReimbursements' in p).toBe(false);
    expect('excludedBenefitIds' in p).toBe(false);
    // Legacy net identity (no loan term) still holds.
    expect(p.netPay).toBe(
      round2(p.grossPay - p.epfEmployee - p.socsoEmployee - p.eisEmployee - p.pcb + p.claimsTotal),
    );
  });

  it('loans of OTHER employees never leak into a payslip', () => {
    seedAll([emp1, empLow]);
    createLoan(
      { employeeId: empLow.id, principal: 600, installmentAmount: 200, firstDeductionMonth: MONTH },
      'hr',
    );
    const { payslips } = runPayroll(MONTH);
    expect(slipOf(payslips, emp1.id).loanDeductions).toBeUndefined();
    expect(slipOf(payslips, empLow.id).loanDeductionTotal).toBe(200);
  });

  function baseRunForCompat(): Payslip {
    return slipOf(runPayroll(MONTH));
  }
});

// Keep the loans registry import surface honest (used by registry tests pattern).
describe('collection registration', () => {
  it('loans & benefits persist via the first-class registry collections', () => {
    createLoan({ employeeId: emp1.id, principal: 100, installmentAmount: 50 }, 'hr');
    createBenefit(
      { employeeId: emp1.id, benefitKey: 'gym-wellness', amount: 80, frequency: 'monthly', startMonth: '2025-01' },
      'hr',
    );
    expect(getCollection<EmployeeLoan>('loans')).toHaveLength(1);
    expect(getCollection<RecurringBenefit>('benefits')).toHaveLength(1);
    expect(getLoans()).toHaveLength(1);
  });
});
