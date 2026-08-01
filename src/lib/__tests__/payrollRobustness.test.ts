/**
 * Payroll robustness — joiner/leaver proration (3 methods), unpaid-leave
 * consistency, payslip transparency, undo run, and the draft→finalize
 * lifecycle with per-employee adjustments (CP38 / Zakat / PTPTN / custom).
 *
 * All proration expectations are hand-verified (see workdays.test.ts for the
 * underlying day-count derivations).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { getCollection, saveCompanies, setCollection } from '../db';
import {
  excludeEmployeeFromRun, finalizePayrollRun, payslipFor, resetPayslipToDefaults,
  runPayroll, setPayslipAdjustments, undoPayrollRun, ytdFor,
} from '../payrollEngine';
import { calcEPF } from '../statutory';
import { round2 } from '../utils';
import type {
  Claim, Company, Employee, LeaveRequest, PayrollProrationMethod,
  PayrollRun, Payslip, PayslipAdjustment,
} from '../types';

const MONTH = '2026-03'; // 31 days; 19 working days KUL (see workdays.test.ts)

function companyWith(method?: PayrollProrationMethod): Company {
  return {
    id: 'co-asm',
    code: 'ASM',
    name: 'ASM Tech Sdn Bhd',
    regNo: '202401000001',
    hqState: 'KUL',
    status: 'active',
    plan: 'pro',
    createdAt: '2026-01-01T00:00:00.000Z',
    branding: { logoText: 'ASM', accentColor: '#b45309' },
    config: {
      workingWeek: 'sat-sun',
      payrollCutoffDay: 25,
      ...(method ? { payrollProration: method } : {}),
      claimPolicy: {},
      leaveTopUps: {},
      enabledModules: ['payroll'],
      customFields: [],
      numberFormats: { employeeIdPrefix: 'ASM', payslipPrefix: 'ASM-PS' },
      orgChart: { showDottedLineReports: false },
    },
  };
}

function mkEmp(id: string, over: Partial<Employee> = {}): Employee {
  return {
    id,
    name: `Employee ${id}`,
    ic: '900101-01-1234',
    email: `${id}@test.my`,
    phone: '012-3456789',
    departmentId: 'dept-1',
    positionId: 'pos-1',
    role: 'employee',
    joinDate: '2023-01-01',
    state: 'KUL',
    employmentType: 'full-time',
    status: 'active',
    baseSalary: 3100,
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
    ...over,
  };
}

function seed(method: PayrollProrationMethod | undefined, employees: Employee[], extra?: {
  leaves?: LeaveRequest[];
  claims?: Claim[];
}): void {
  saveCompanies([companyWith(method)]);
  setCollection('employees', employees);
  setCollection('attendance', []);
  setCollection('leaves', extra?.leaves ?? []);
  setCollection('claims', extra?.claims ?? []);
  setCollection('payrollRuns', []);
  setCollection('payslips', []);
  setCollection('audit', []);
}

beforeEach(() => {
  installLocalStorage();
});

// ─────────────────────────────────────────────────────────────────────────────
// Joiner / leaver proration across the 3 methods
// ─────────────────────────────────────────────────────────────────────────────

describe('runPayroll — joiner/leaver proration', () => {
  const joiner = () =>
    mkEmp('e-join', {
      joinDate: '2026-03-10',
      baseSalary: 3100,
      fixedAllowances: [{ name: 'Transport', amount: 310 }],
    });

  it("calendar: 22/31 days → basic 2200.00, allowance 220.00, factor on the slip", () => {
    seed('calendar', [joiner()]);
    const { run, payslips } = runPayroll(MONTH);
    const p = payslips[0]!;
    expect(p.daysWorked).toBe(22);
    expect(p.daysInBasis).toBe(31);
    expect(p.prorationMethod).toBe('calendar');
    expect(p.prorationFactor).toBeCloseTo(22 / 31, 10);
    expect(p.basicPay).toBe(2200);
    expect(p.allowances).toBe(220); // fixed allowances prorated by the same factor
    expect(run.prorationMethod).toBe('calendar'); // run stores the method
  });

  it('working-days: 14/19 days → basic 2284.21, allowance 228.42', () => {
    seed('working-days', [joiner()]);
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.daysWorked).toBe(14);
    expect(p.daysInBasis).toBe(19);
    expect(p.basicPay).toBe(2284.21);
    expect(p.allowances).toBe(228.42);
  });

  it('fixed-26: 22/26 days → basic 2623.08, allowance 262.31', () => {
    seed('fixed-26', [joiner()]);
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.daysWorked).toBe(22);
    expect(p.daysInBasis).toBe(26);
    expect(p.basicPay).toBe(2623.08);
    expect(p.allowances).toBe(262.31);
  });

  it('mid-month leaver (resigned) is prorated through the resignation date', () => {
    seed('calendar', [
      mkEmp('e-leave', { status: 'resigned', resignDate: '2026-03-15', baseSalary: 3100 }),
    ]);
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.daysWorked).toBe(15);
    expect(p.daysInBasis).toBe(31);
    expect(p.basicPay).toBe(1500); // 3100 × 15/31
  });

  it('statutory contributions are computed on the prorated wages actually paid', () => {
    seed('calendar', [joiner()]);
    const p = runPayroll(MONTH).payslips[0]!;
    // EPF base = prorated basic + prorated allowances = 2420 (Third Schedule on paid wages)
    const expected = calcEPF(2420, 36, true, false);
    expect(p.epfEmployee).toBe(expected.employee);
    expect(p.epfEmployer).toBe(expected.employer);
    expect(p.grossPay).toBe(2420);
  });

  it('full-month employees are never prorated and show no proration line', () => {
    seed('calendar', [mkEmp('e-full')]);
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.prorationFactor).toBe(1);
    expect(p.basicPay).toBe(3100);
    expect(p.daysWorked).toBe(31);
    expect(p.lines.some((l) => l.label.startsWith('Proration —'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payslip transparency
// ─────────────────────────────────────────────────────────────────────────────

describe('runPayroll — payslip transparency', () => {
  it("shows 'Days worked: X / Y (method)' and a proration line when factor < 1", () => {
    seed('calendar', [mkEmp('e-join', { joinDate: '2026-03-10' })]);
    const p = runPayroll(MONTH).payslips[0]!;
    const daysLine = p.lines.find((l) => l.kind === 'info' && l.label.startsWith('Days worked:'));
    expect(daysLine?.label).toBe('Days worked: 22 / 31 (calendar days)');
    const prorationLine = p.lines.find((l) => l.kind === 'info' && l.label.startsWith('Proration —'));
    expect(prorationLine?.label).toContain('22/31');
    expect(prorationLine?.label).toContain('calendar days');
  });

  it('uses the working-days label when configured', () => {
    seed('working-days', [mkEmp('e-join', { joinDate: '2026-03-10' })]);
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.lines.find((l) => l.label.startsWith('Days worked:'))?.label).toBe(
      'Days worked: 14 / 19 (working days)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unpaid-leave deduction uses the SAME method (consistency fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('runPayroll — unpaid-leave consistency with the proration method', () => {
  const leave = (days: [string, string]): LeaveRequest => ({
    id: 'lv-1',
    employeeId: 'e-1',
    type: 'unpaid',
    startDate: days[0],
    endDate: days[1],
    days: 2,
    status: 'approved',
    appliedAt: '2026-03-01T00:00:00Z',
  });

  it('calendar: 2 days at salary ÷ 31 (3100 → 200.00)', () => {
    seed('calendar', [mkEmp('e-1')], { leaves: [leave(['2026-03-12', '2026-03-13'])] });
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.unpaidLeaveDeduction).toBe(200);
    expect(p.basicPay).toBe(2900);
  });

  it('working-days: 2 working days at salary ÷ 19 (1900 → 200.00)', () => {
    seed('working-days', [mkEmp('e-1', { baseSalary: 1900 })], {
      leaves: [leave(['2026-03-12', '2026-03-13'])],
    });
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.unpaidLeaveDeduction).toBe(200);
    expect(p.basicPay).toBe(1700);
  });

  it('working-days: unpaid leave spanning a weekend/in-lieu holiday deducts working days only', () => {
    // Sat 7th + Sun 8th + Mon 9th (Nuzul in-lieu) → 0 working days, no deduction
    seed('working-days', [mkEmp('e-1', { baseSalary: 1900 })], {
      leaves: [leave(['2026-03-07', '2026-03-09'])],
    });
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.unpaidLeaveDeduction).toBe(0);
    expect(p.basicPay).toBe(1900);
  });

  it('fixed-26: 2 days at ORP = salary ÷ 26 (2600 → 200.00)', () => {
    seed('fixed-26', [mkEmp('e-1', { baseSalary: 2600 })], {
      leaves: [leave(['2026-03-12', '2026-03-13'])],
    });
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.unpaidLeaveDeduction).toBe(200);
    expect(p.basicPay).toBe(2400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Undo payroll run
// ─────────────────────────────────────────────────────────────────────────────

describe('undoPayrollRun', () => {
  const claims: Claim[] = [
    { id: 'clm-1', employeeId: 'e-1', category: 'travel', title: 'Grab', amount: 45.5, claimDate: '2026-03-05', status: 'approved' },
  ];

  it('deletes the run + its payslips and reverts paid claims to approved', () => {
    seed('calendar', [mkEmp('e-1')], { claims });
    const { run } = runPayroll(MONTH);
    expect(getCollection<Claim>('claims')[0]!.status).toBe('paid');

    expect(undoPayrollRun(run.id, 'hr-admin')).toBe(true);

    expect(getCollection<PayrollRun>('payrollRuns').filter((r) => r.monthKey === MONTH)).toHaveLength(0);
    expect(getCollection<Payslip>('payslips').filter((p) => p.monthKey === MONTH)).toHaveLength(0);
    const c = getCollection<Claim>('claims')[0]!;
    expect(c.status).toBe('approved');
    expect(c.paidInRunId).toBeUndefined();
    // YTD recomputes naturally — no recorded months remain.
    expect(ytdFor('e-1', '2026-04').months).toBe(0);
    // Audited.
    const audit = getCollection<{ action: string }>('audit');
    expect(audit.some((a) => a.action === 'payroll.undo')).toBe(true);
  });

  it('re-running after undo reproduces identical payslip figures (idempotent)', () => {
    seed('calendar', [mkEmp('e-1'), mkEmp('e-2', { baseSalary: 5000 })], { claims });
    const first = runPayroll(MONTH);
    const figures = (slips: Payslip[]) =>
      new Map(
        slips.map((p) => [
          p.employeeId,
          {
            basic: p.basicPay, allowances: p.allowances, gross: p.grossPay,
            epf: p.epfEmployee, pcb: p.pcb, net: p.netPay, claims: p.claimsTotal,
          },
        ]),
      );
    const before = figures(first.payslips);

    expect(undoPayrollRun(first.run.id)).toBe(true);
    const second = runPayroll(MONTH);
    const after = figures(second.payslips);

    expect(after.size).toBe(before.size);
    for (const [empId, f] of before) expect(after.get(empId)).toEqual(f);
    // The claim was reimbursed again by the replacement run.
    const c = getCollection<Claim>('claims')[0]!;
    expect(c.status).toBe('paid');
    expect(c.paidInRunId).toBe(second.run.id);
  });

  it('returns false for an unknown run id', () => {
    seed('calendar', [mkEmp('e-1')]);
    expect(undoPayrollRun('no-such-run')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Draft → finalize lifecycle + per-employee editor
// ─────────────────────────────────────────────────────────────────────────────

describe('draft runs — per-employee editor & finalize locking', () => {
  const claims: Claim[] = [
    { id: 'clm-1', employeeId: 'e-1', category: 'travel', title: 'Grab', amount: 45.5, claimDate: '2026-03-05', status: 'approved' },
  ];
  const deductionLines: PayslipAdjustment[] = [
    { id: 'a1', kind: 'deduction', preset: 'cp38', label: 'March order', amount: 100 },
    { id: 'a2', kind: 'deduction', preset: 'zakat', label: 'Monthly tithe', amount: 50 },
    { id: 'a3', kind: 'deduction', preset: 'ptptn', label: 'Loan repayment', amount: 150 },
  ];

  it('draft runs do not stamp claims paid; finalize does', () => {
    seed('calendar', [mkEmp('e-1')], { claims });
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    expect(run.status).toBe('draft');
    expect(getCollection<Claim>('claims')[0]!.status).toBe('approved');

    const finalized = finalizePayrollRun(run.id, 'hr-admin');
    expect(finalized?.status).toBe('finalized');
    expect(finalized?.finalizedAt).toBeTruthy();
    const c = getCollection<Claim>('claims')[0]!;
    expect(c.status).toBe('paid');
    expect(c.paidInRunId).toBe(run.id);
    // Idempotent: finalizing again is a no-op.
    expect(finalizePayrollRun(run.id)?.status).toBe('finalized');
  });

  it('CP38 / Zakat / PTPTN deduction lines reduce net pay and appear on the payslip', () => {
    seed('calendar', [mkEmp('e-1')]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const base = payslips[0]!;

    const adjusted = setPayslipAdjustments(run.id, 'e-1', deductionLines, 'hr-admin')!;
    expect(adjusted.adjustmentDeductions).toBe(300);
    expect(adjusted.netPay).toBe(round2(base.netPay - 300));
    expect(adjusted.grossPay).toBe(base.grossPay); // deductions never touch gross/statutory bases
    expect(adjusted.epfEmployee).toBe(base.epfEmployee);
    const labels = adjusted.lines.map((l) => l.label);
    expect(labels.some((l) => l.startsWith('CP38'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Zakat'))).toBe(true);
    expect(labels.some((l) => l.startsWith('PTPTN'))).toBe(true);

    // Run totals were retallied.
    const stored = getCollection<PayrollRun>('payrollRuns').find((r) => r.id === run.id)!;
    expect(stored.totalNet).toBe(round2(run.totalNet - 300));
    // Persisted on the payslip.
    expect(payslipFor(run.id, 'e-1')!.adjustments).toHaveLength(3);
  });

  it('custom earning lines join gross pay and are taxed as additional remuneration', () => {
    seed('calendar', [mkEmp('e-1')]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const base = payslips[0]!;

    const adjusted = setPayslipAdjustments(run.id, 'e-1', [
      { id: 'a1', kind: 'earning', preset: 'custom', label: 'Sales commission', amount: 500 },
    ])!;
    expect(adjusted.adjustmentEarnings).toBe(500);
    expect(adjusted.grossPay).toBe(round2(base.grossPay + 500));
    // LHDN additional-remuneration mechanism: PCB rises or stays, net rises by less than 500.
    expect(adjusted.pcb).toBeGreaterThanOrEqual(base.pcb);
    expect(adjusted.netPay).toBeLessThan(round2(base.netPay + 500));
    expect(adjusted.netPay).toBeGreaterThan(base.netPay);
  });

  it('reset employee recomputes from defaults, dropping all adjustments', () => {
    seed('calendar', [mkEmp('e-1')]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const base = payslips[0]!;
    setPayslipAdjustments(run.id, 'e-1', deductionLines);

    const reset = resetPayslipToDefaults(run.id, 'e-1', 'hr-admin')!;
    expect(reset.id).toBe(base.id); // same payslip row, recomputed
    expect(reset.adjustments).toHaveLength(0);
    expect(reset.netPay).toBe(base.netPay);
    expect(reset.grossPay).toBe(base.grossPay);
    expect(reset.pcb).toBe(base.pcb);
  });

  it('exclude-from-run removes the payslip and retallies the run', () => {
    seed('calendar', [mkEmp('e-1'), mkEmp('e-2', { baseSalary: 5000 })]);
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const e2Net = payslipFor(run.id, 'e-2')!.netPay;

    expect(excludeEmployeeFromRun(run.id, 'e-2', 'hr-admin')).toBe(true);

    expect(payslipFor(run.id, 'e-2')).toBeUndefined();
    const stored = getCollection<PayrollRun>('payrollRuns').find((r) => r.id === run.id)!;
    expect(stored.employeeCount).toBe(1);
    expect(stored.totalNet).toBe(round2(run.totalNet - e2Net));
    // Excluding again (already out) is a no-op false.
    expect(excludeEmployeeFromRun(run.id, 'e-2')).toBe(false);
  });

  it('finalize locks the run: adjustments, resets and exclusions are rejected', () => {
    seed('calendar', [mkEmp('e-1')]);
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    finalizePayrollRun(run.id, 'hr-admin');

    expect(setPayslipAdjustments(run.id, 'e-1', deductionLines)).toBeNull();
    expect(resetPayslipToDefaults(run.id, 'e-1')).toBeNull();
    expect(excludeEmployeeFromRun(run.id, 'e-1')).toBe(false);
    // Payslip untouched by the rejected edits.
    expect(payslipFor(run.id, 'e-1')!.adjustments).toHaveLength(0);
  });

  it('undoing a draft run needs no claim revert but still deletes everything', () => {
    seed('calendar', [mkEmp('e-1')], { claims });
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    expect(undoPayrollRun(run.id)).toBe(true);
    expect(getCollection<PayrollRun>('payrollRuns')).toHaveLength(0);
    expect(getCollection<Payslip>('payslips')).toHaveLength(0);
    expect(getCollection<Claim>('claims')[0]!.status).toBe('approved'); // never stamped
  });
});
