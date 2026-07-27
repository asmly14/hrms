import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { setCollection, getCollection } from '../db';
import { runPayroll, payslipFor, ytdForPcb } from '../payrollEngine';
import { calcPCB } from '../statutory';
import { round2 } from '../utils';
import type { AttendanceRecord, Claim, Employee, LeaveRequest, PayrollRun, Payslip } from '../types';

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
  fixedAllowances: [{ name: 'Transport', amount: 200 }],
};

const emp2: Employee = {
  ...emp1,
  id: 'emp-2',
  name: 'Test Employee Two',
  email: 'two@test.my',
  baseSalary: 5000,
  fixedAllowances: [],
};

const attendance: AttendanceRecord[] = [
  // 4h approved normal-day OT + 3h approved rest-day OT + 2h unapproved (unpaid)
  { id: 'att-1', employeeId: 'emp-1', date: '2025-03-03', status: 'present', otHours: 4, otDayType: 'normal', otApproved: true },
  { id: 'att-2', employeeId: 'emp-1', date: '2025-03-08', status: 'present', otHours: 3, otDayType: 'rest', otApproved: true },
  { id: 'att-3', employeeId: 'emp-1', date: '2025-03-10', status: 'present', otHours: 2, otDayType: 'normal', otApproved: false },
  // February OT must not leak into the March run
  { id: 'att-4', employeeId: 'emp-1', date: '2025-02-10', status: 'present', otHours: 5, otDayType: 'normal', otApproved: true },
];

const leaves: LeaveRequest[] = [
  // 2 approved unpaid days inside March; a June leave must not touch March
  { id: 'lv-1', employeeId: 'emp-1', type: 'unpaid', startDate: '2025-03-12', endDate: '2025-03-13', days: 2, status: 'approved', appliedAt: '2025-03-01T00:00:00Z' },
  { id: 'lv-2', employeeId: 'emp-1', type: 'unpaid', startDate: '2025-06-02', endDate: '2025-06-03', days: 2, status: 'approved', appliedAt: '2025-05-01T00:00:00Z' },
  { id: 'lv-3', employeeId: 'emp-1', type: 'unpaid', startDate: '2025-03-20', endDate: '2025-03-20', days: 1, status: 'rejected', appliedAt: '2025-03-01T00:00:00Z' },
];

const claims: Claim[] = [
  { id: 'clm-1', employeeId: 'emp-1', category: 'travel', title: 'Grab to client', amount: 45.5, claimDate: '2025-03-05', status: 'approved' },
  { id: 'clm-2', employeeId: 'emp-1', category: 'meal', title: 'Team lunch', amount: 80, claimDate: '2025-03-15', status: 'submitted' }, // not approved → excluded
  { id: 'clm-3', employeeId: 'emp-2', category: 'medical', title: 'Clinic visit', amount: 120, claimDate: '2025-03-11', status: 'approved' },
];

function seedAll(): void {
  setCollection('employees', [emp1, emp2]);
  setCollection('attendance', attendance);
  setCollection('leaves', leaves);
  setCollection('claims', claims);
  setCollection('payrollRuns', []);
  setCollection('payslips', []);
  setCollection('audit', []);
}

beforeEach(() => {
  installLocalStorage();
  seedAll();
});

const MONTH = '2025-03';

describe('runPayroll — payslip math', () => {
  it('gross − employee statutory − PCB + claims = net (identity holds per slip)', () => {
    const { payslips } = runPayroll(MONTH);
    expect(payslips).toHaveLength(2);
    for (const p of payslips) {
      const expected = round2(p.grossPay - p.epfEmployee - p.socsoEmployee - p.eisEmployee - p.pcb + p.claimsTotal);
      expect(p.netPay).toBe(expected);
      const expectedCost = round2(p.grossPay + p.epfEmployer + p.socsoEmployer + p.eisEmployer + p.hrdLevy + p.claimsTotal);
      expect(p.employerCost).toBe(expectedCost);
      // gross = basic + allowances + OT (claims are NOT statutory wages)
      expect(p.grossPay).toBe(round2(p.basicPay + p.allowances + p.otPay));
    }
  });

  it('unpaid leave prorates basic at ORP = salary ÷ 26', () => {
    const { payslips } = runPayroll(MONTH);
    const p = payslips.find((s) => s.employeeId === 'emp-1')!;
    // 2 days × 3000/26 = 230.77
    expect(p.unpaidLeaveDeduction).toBe(230.77);
    expect(p.basicPay).toBe(round2(3000 - 230.77));
  });

  it('approved OT only, split 1.5× / 2×; unapproved & other-month OT excluded', () => {
    const { payslips } = runPayroll(MONTH);
    const p = payslips.find((s) => s.employeeId === 'emp-1')!;
    const hrp = 3000 / 26 / 8;
    const expectedOT = round2(round2(hrp * 4 * 1.5) + round2(hrp * 3 * 2));
    expect(p.otPay).toBe(expectedOT);
    expect(p.otHours).toBe(7);
  });

  it('EPF base excludes OT but includes fixed allowances', () => {
    const { payslips } = runPayroll(MONTH);
    const p = payslips.find((s) => s.employeeId === 'emp-1')!;
    // EPF wages = 2769.23 + 200 = 2969.23 → band 2980 → ee ceil(327.8)=328, er ceil(387.4)=388
    expect(p.epfEmployee).toBe(328);
    expect(p.epfEmployer).toBe(388);
  });

  it('approved claims become nonStatutory earning lines and are marked paid', () => {
    const { run, payslips } = runPayroll(MONTH);
    const p = payslips.find((s) => s.employeeId === 'emp-1')!;
    expect(p.claimsTotal).toBe(45.5);
    const claimLines = p.lines.filter((l) => l.nonStatutory);
    expect(claimLines).toHaveLength(1);
    expect(claimLines[0]!.label).toContain('Grab to client');
    expect(claimLines[0]!.kind).toBe('earning');

    const stored = getCollection<Claim>('claims');
    const c1 = stored.find((c) => c.id === 'clm-1')!;
    expect(c1.status).toBe('paid');
    expect(c1.paidInRunId).toBe(run.id);
    // unapproved claim untouched
    expect(stored.find((c) => c.id === 'clm-2')!.status).toBe('submitted');
  });

  it('run totals aggregate the payslips', () => {
    const { run, payslips } = runPayroll(MONTH);
    expect(run.employeeCount).toBe(2);
    expect(run.totalGross).toBe(round2(payslips.reduce((s, p) => s + p.grossPay, 0)));
    expect(run.totalNet).toBe(round2(payslips.reduce((s, p) => s + p.netPay, 0)));
    expect(run.totalEmployerCost).toBe(round2(payslips.reduce((s, p) => s + p.employerCost, 0)));
  });
});

describe('runPayroll — idempotency', () => {
  it('re-running the same month replaces payslips (no duplicates, same figures)', () => {
    const first = runPayroll(MONTH);
    const firstSlip = first.payslips.find((p) => p.employeeId === 'emp-1')!;

    const second = runPayroll(MONTH);
    const stored = getCollection<import('../types').Payslip>('payslips').filter((p) => p.monthKey === MONTH);
    expect(stored).toHaveLength(2); // replaced, not appended

    const secondSlip = second.payslips.find((p) => p.employeeId === 'emp-1')!;
    expect(secondSlip.grossPay).toBe(firstSlip.grossPay);
    expect(secondSlip.netPay).toBe(firstSlip.netPay);
    expect(secondSlip.pcb).toBe(firstSlip.pcb);
    // only one run record survives for the month
    const runs = getCollection<import('../types').PayrollRun>('payrollRuns').filter((r) => r.monthKey === MONTH);
    expect(runs).toHaveLength(1);
  });

  it('regression: claims stay reimbursed on re-run (paid claims still feed the payslip)', () => {
    const first = runPayroll(MONTH);
    const firstNet = first.payslips.find((p) => p.employeeId === 'emp-1')!.netPay;
    // Claims are now status 'paid' — a second run must still reimburse them,
    // otherwise net pay silently drops by claimsTotal.
    const second = runPayroll(MONTH);
    const secondSlip = second.payslips.find((p) => p.employeeId === 'emp-1')!;
    expect(secondSlip.claimsTotal).toBe(45.5);
    expect(secondSlip.netPay).toBe(firstNet);
    const claimLines = secondSlip.lines.filter((l) => l.nonStatutory);
    expect(claimLines).toHaveLength(1);
  });

  it('targeted re-run preserves other employees\u2019 payslips', () => {
    runPayroll(MONTH);
    runPayroll(MONTH, ['emp-2']);
    const stored = getCollection<import('../types').Payslip>('payslips').filter((p) => p.monthKey === MONTH);
    expect(stored).toHaveLength(2);
    expect(stored.some((p) => p.employeeId === 'emp-1')).toBe(true);
  });

  it('payslipFor finds the stored slip by run + employee', () => {
    const { run } = runPayroll(MONTH);
    const slip = payslipFor(run.id, 'emp-2');
    expect(slip).toBeDefined();
    expect(slip!.employeeId).toBe('emp-2');
  });
});

describe('runPayroll — YTD chaining & compliance warnings', () => {
  it('February payslips feed the March YTD totals', () => {
    runPayroll('2025-02');
    const { payslips } = runPayroll(MONTH);
    const feb = getCollection<import('../types').Payslip>('payslips').find((p) => p.employeeId === 'emp-1' && p.monthKey === '2025-02')!;
    const mar = payslips.find((p) => p.employeeId === 'emp-1')!;
    expect(mar.ytd.gross).toBe(round2(feb.grossPay + mar.grossPay));
    expect(mar.ytd.pcb).toBe(round2(feb.pcb + mar.pcb));
  });

  it('warns when a full-timer is below minimum wage and OT exceeds the 104h cap', () => {
    setCollection('employees', [
      { ...emp1, baseSalary: 1200 },
    ]);
    setCollection('attendance', [
      { id: 'att-x', employeeId: 'emp-1', date: '2025-03-03', status: 'present', otHours: 110, otDayType: 'normal', otApproved: true },
    ]);
    setCollection('leaves', []);
    setCollection('claims', []);
    const { run } = runPayroll(MONTH);
    expect(run.warnings.some((w) => w.includes('minimum wage'))).toBe(true);
    expect(run.warnings.some((w) => w.includes('104'))).toBe(true);
  });

  it('resigned employees are excluded unless resignDate is inside the month', () => {
    setCollection('employees', [
      emp1,
      { ...emp2, status: 'resigned' as const, resignDate: '2025-02-15' },
    ]);
    const { payslips } = runPayroll(MONTH);
    expect(payslips).toHaveLength(1);
    expect(payslips[0]!.employeeId).toBe('emp-1');

    const { payslips: febSlips } = runPayroll('2025-02');
    expect(febSlips).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wave-2 regressions (CoreFix): TP3 carry-in, re-run integrity, eligibility,
// EPF labels.
// ─────────────────────────────────────────────────────────────────────────────

/** Mid-year hire with TP3 prior-employer figures (same tax year). */
const midYearHire: Employee = {
  ...emp1,
  id: 'emp-mid',
  name: 'Mid Year Hire',
  joinDate: '2025-03-10',
  baseSalary: 6000,
  fixedAllowances: [],
  ytdCarryIn: { year: 2025, gross: 12000, epf: 1320, socso: 100, pcb: 300 },
};

function isolateEmployees(list: Employee[]): void {
  setCollection('employees', list);
  setCollection('attendance', []);
  setCollection('leaves', []);
  setCollection('claims', []);
}

describe('runPayroll — TP3 carry-in (Wave-2, QA employees C-1)', () => {
  it('seeds the PCB basis and the printed YTD from ytdCarryIn on the first recorded run', () => {
    isolateEmployees([midYearHire]);
    const { payslips } = runPayroll('2025-06');
    const p = payslips[0]!;
    // Printed YTD = TP3 carry-in + this month's figures (EA-form expectation).
    expect(p.ytd.gross).toBe(round2(12000 + p.grossPay));
    expect(p.ytd.epf).toBe(round2(1320 + p.epfEmployee));
    expect(p.ytd.pcb).toBe(round2(300 + p.pcb));
    // PCB is computed against the carry-in basis, not a zero or estimated YTD.
    const expected = calcPCB(
      p.grossPay,
      { gross: 12000, epf: 1320, socso: 100, pcb: 300 },
      {
        marital: 'single',
        children: 0,
        monthIndex: 6,
        epfEmployee: p.epfEmployee,
        socsoEmployee: round2(p.socsoEmployee + p.eisEmployee),
      },
    );
    expect(p.pcb).toBe(expected);
    expect(p.pcb).toBeGreaterThan(0);
  });

  it('ytdForPcb returns the carry-in basis before any recorded run', () => {
    isolateEmployees([midYearHire]);
    const basis = ytdForPcb('emp-mid', '2025-06');
    expect(basis).toMatchObject({ gross: 12000, epf: 1320, socso: 100, pcb: 300, months: 0 });
  });

  it('carry-in from a DIFFERENT tax year is ignored', () => {
    isolateEmployees([
      { ...midYearHire, id: 'emp-old-tp3', ytdCarryIn: { year: 2024, gross: 50000, epf: 5500, socso: 300, pcb: 900 } },
    ]);
    const { payslips } = runPayroll('2025-06');
    const p = payslips[0]!;
    expect(p.ytd.gross).toBe(p.grossPay); // printed YTD not inflated by last year's TP3
  });

  it('mid-year hire WITHOUT TP3 keeps a true zero YTD (no package estimate)', () => {
    isolateEmployees([{ ...emp1, id: 'emp-new', joinDate: '2025-04-01', baseSalary: 4000, fixedAllowances: [] }]);
    const { payslips } = runPayroll('2025-06');
    const p = payslips[0]!;
    expect(p.ytd.gross).toBe(p.grossPay);
    const expected = calcPCB(
      p.grossPay,
      { gross: 0, epf: 0, socso: 0, pcb: 0 },
      {
        marital: 'single',
        children: 0,
        monthIndex: 6,
        epfEmployee: p.epfEmployee,
        socsoEmployee: round2(p.socsoEmployee + p.eisEmployee),
      },
    );
    expect(p.pcb).toBe(expected);
  });

  it('employee who joined before this year with no history keeps the year-continuity estimate', () => {
    isolateEmployees([{ ...emp1, id: 'emp-tenured', joinDate: '2023-01-01', baseSalary: 4000, fixedAllowances: [] }]);
    const basis = ytdForPcb('emp-tenured', '2025-06');
    expect(basis.months).toBe(5); // Jan–May estimated from the current package
    expect(basis.gross).toBe(round2(4000 * 5));
  });
});

describe('runPayroll — partial re-run integrity (Wave-2, QA payroll B1)', () => {
  it('re-points surviving payslips and paid claims to the new run; totals stay full-coverage', () => {
    const first = runPayroll(MONTH);
    const emp1First = first.payslips.find((p) => p.employeeId === 'emp-1')!;

    const second = runPayroll(MONTH, ['emp-2']);

    // Exactly one run survives for the month.
    const runs = getCollection<PayrollRun>('payrollRuns').filter((r) => r.monthKey === MONTH);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(second.run.id);

    // The non-targeted payslip survived, re-pointed to the new run — no dangling runId.
    const emp1Slip = getCollection<Payslip>('payslips').find(
      (p) => p.employeeId === 'emp-1' && p.monthKey === MONTH,
    )!;
    expect(emp1Slip.runId).toBe(second.run.id);
    expect(payslipFor(second.run.id, 'emp-1')).toBeDefined();
    // Figures untouched by the partial re-run.
    expect(emp1Slip.grossPay).toBe(emp1First.grossPay);
    expect(emp1Slip.netPay).toBe(emp1First.netPay);

    // Run totals reflect the WHOLE month, not just the re-run subset.
    const monthSlips = getCollection<Payslip>('payslips').filter((p) => p.monthKey === MONTH);
    expect(monthSlips).toHaveLength(2);
    expect(second.run.employeeCount).toBe(monthSlips.length);
    expect(second.run.totalGross).toBe(round2(monthSlips.reduce((s, p) => s + p.grossPay, 0)));
    expect(second.run.totalNet).toBe(round2(monthSlips.reduce((s, p) => s + p.netPay, 0)));

    // The surviving employee's paid claim follows its payslip onto the new run.
    const c1 = getCollection<Claim>('claims').find((c) => c.id === 'clm-1')!;
    expect(c1.status).toBe('paid');
    expect(c1.paidInRunId).toBe(second.run.id);
    // No stored claim points at a deleted run.
    const runIds = new Set(getCollection<PayrollRun>('payrollRuns').map((r) => r.id));
    for (const c of getCollection<Claim>('claims')) {
      if (c.paidInRunId) expect(runIds.has(c.paidInRunId)).toBe(true);
    }
  });
});

describe('runPayroll — eligibility (Wave-2, QA employees H-1 / payroll B13)', () => {
  it('resigned employee WITHOUT resignDate is still paid, with a warning', () => {
    setCollection('employees', [emp1, { ...emp2, id: 'emp-res', status: 'resigned' as const }]);
    const { run, payslips } = runPayroll(MONTH);
    expect(payslips.some((p) => p.employeeId === 'emp-res')).toBe(true);
    expect(run.warnings.some((w) => w.includes('Test Employee Two') && w.includes('resignation date'))).toBe(true);
  });

  it('resigned employee remains payable until the resignation month, excluded after', () => {
    setCollection('employees', [
      emp1,
      { ...emp2, id: 'emp-res2', status: 'resigned' as const, resignDate: '2025-04-15' },
    ]);
    // March (before the April resignation): still payable.
    expect(runPayroll(MONTH).payslips.some((p) => p.employeeId === 'emp-res2')).toBe(true);
    // April (resignation month): payable — the final month.
    expect(runPayroll('2025-04').payslips.some((p) => p.employeeId === 'emp-res2')).toBe(true);
    // May (after): excluded.
    expect(runPayroll('2025-05').payslips.some((p) => p.employeeId === 'emp-res2')).toBe(false);
  });

  it('employees joining after the payroll month are excluded with a warning', () => {
    setCollection('employees', [emp1, { ...emp2, id: 'emp-future', joinDate: '2025-06-01' }]);
    const { run, payslips } = runPayroll(MONTH);
    expect(payslips.some((p) => p.employeeId === 'emp-future')).toBe(false);
    expect(run.warnings.some((w) => w.includes('Test Employee Two') && w.includes('excluded'))).toBe(true);
    // Joining DURING the month is payable.
    expect(runPayroll('2025-06').payslips.some((p) => p.employeeId === 'emp-future')).toBe(true);
  });
});

describe('runPayroll — EPF line labels (Wave-2, QA payroll B10)', () => {
  function epfLabels(emp: Employee): { ee?: string; er?: string } {
    isolateEmployees([emp]);
    const { payslips } = runPayroll(MONTH);
    const lines = payslips[0]!.lines;
    return {
      ee: lines.find((l) => l.label.startsWith('EPF employee'))?.label,
      er: lines.find((l) => l.label.startsWith('EPF employer'))?.label,
    };
  }

  it('standard citizen employee → 11% / 13% (≤ RM5,000)', () => {
    const { ee, er } = epfLabels({ ...emp1, id: 'emp-std' });
    expect(ee).toBe('EPF employee (11%)');
    expect(er).toBe('EPF employer (13%)');
  });

  it('foreign worker → 2% / 2% (EPF (Amendment) Act 2025)', () => {
    const { ee, er } = epfLabels({ ...emp1, id: 'emp-fw', isForeignWorker: true });
    expect(ee).toBe('EPF employee (2%)');
    expect(ee).not.toContain('11%');
    expect(er).toBe('EPF employer (2%)');
  });

  it('employee aged 60+ → 0% / 4% (Third Schedule s.E)', () => {
    const { ee, er } = epfLabels({ ...emp1, id: 'emp-60', dateOfBirth: '1960-01-01' });
    expect(ee).toBe('EPF employee (0%)');
    expect(er).toBe('EPF employer (4%)');
  });
});
