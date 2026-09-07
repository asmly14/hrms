/**
 * Salary report tests — period-preset math (monthly/quarterly/half-yearly/
 * yearly/custom windows, labels, file tags, invalid selections), the pure
 * aggregation vs hand-summed payslip figures, finalized-only scoping, gap
 * detection (draft / orphan / missing months), salary-band histogram
 * boundaries, the CSV pack, WinAnsi sanitization, and a real-PDF node smoke
 * test (renders with jsPDF's node build, verifies page count + %PDF bytes).
 *
 * Money fixtures use .00/.25/.50/.75 decimals only, which are exact in binary
 * floating point, so every hand-verified sum is drift-free.
 */
/// <reference types="node" />
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateSalaryReport,
  isMonthKey,
  monthsBetween,
  resolveSalaryPeriod,
  salaryBandIndex,
  salaryMonthLabel,
  salaryMonthShort,
  salaryReportCompanyTag,
  salaryReportCsvs,
  SALARY_BAND_DEFS,
  type SalaryPeriod,
} from '../salaryReports';
import {
  pdfSafe,
  renderSalaryReportPdf,
  salaryReportFileName,
  SALARY_REGISTER_ROWS_PER_PAGE,
} from '../salaryReportPdf';
import { round2 } from '../utils';
import type {
  Company, Department, Employee, PayrollRun, Payslip, Settings,
} from '../types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GENERATED = new Date('2026-04-02T09:30:00');

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
    baseSalary: 3000,
    maritalStatus: 'single',
    children: 0,
    bankName: 'Maybank',
    bankAccount: '1234567890',
    epfNo: 'EPF-1',
    socsoNo: 'SOC-1',
    taxNo: 'TAX-1',
    isForeignWorker: false,
    dateOfBirth: '1990-01-01',
    gender: 'male',
    fixedAllowances: [],
    ...over,
  };
}

const DEPARTMENTS: Department[] = [
  { id: 'dept-1', name: 'Engineering', code: 'ENG', state: 'KUL' },
  { id: 'dept-2', name: 'Operations', code: 'OPS', state: 'KUL' },
];

function mkRun(id: string, monthKey: string, status: PayrollRun['status']): PayrollRun {
  return {
    id,
    monthKey,
    status,
    runAt: `${monthKey}-28T09:00:00.000Z`,
    runBy: 'hr-admin',
    employeeCount: 2,
    totalGross: 0,
    totalNet: 0,
    totalEmployerCost: 0,
    warnings: [],
    prorationMethod: 'calendar',
    cutoffDay: 25,
    ...(status === 'finalized' ? { finalizedAt: `${monthKey}-28T10:00:00.000Z` } : {}),
  };
}

type SlipSeed = Partial<Payslip> & { employeeId: string };

function mkSlip(seed: SlipSeed): Payslip {
  return {
    basicPay: 0,
    unpaidLeaveDeduction: 0,
    otPay: 0,
    otHours: 0,
    allowances: 0,
    claimsTotal: 0,
    grossPay: 0,
    epfEmployee: 0,
    epfEmployer: 0,
    socsoEmployee: 0,
    socsoEmployer: 0,
    socsoCategory: 1,
    eisEmployee: 0,
    eisEmployer: 0,
    pcb: 0,
    hrdLevy: 0,
    netPay: 0,
    employerCost: 0,
    lines: [],
    ytd: { gross: 0, epf: 0, socso: 0, pcb: 0, net: 0 },
    ...seed,
    id: seed.id ?? `${seed.runId ?? 'run-x'}:${seed.employeeId}:${seed.monthKey ?? 'm'}`,
    runId: seed.runId ?? 'run-x',
    monthKey: seed.monthKey ?? '2026-01',
  };
}

/**
 * Q1 2026 fixture: finalized runs for Jan + Mar, a DRAFT run for Feb (gap),
 * and an orphan payslip whose run no longer exists. Three employees across
 * two departments; emp-1 carries a loan in both finalized months.
 */
function buildFixtures() {
  const employees = [
    mkEmp('emp-1', { name: 'Zara Ibrahim', employeeNo: 'ASM0001', departmentId: 'dept-1' }),
    mkEmp('emp-2', { name: 'Ahmad Faizal', employeeNo: 'ASM0002', departmentId: 'dept-2' }),
    mkEmp('emp-3', { name: 'Chen Wei', employeeNo: 'ASM0003', departmentId: 'dept-1' }),
  ];
  const runs = [
    mkRun('run-2026-01', '2026-01', 'finalized'),
    mkRun('run-2026-02', '2026-02', 'draft'),
    mkRun('run-2026-03', '2026-03', 'finalized'),
  ];
  const payslips: Payslip[] = [
    // ── Jan (finalized) ──
    mkSlip({
      employeeId: 'emp-1', runId: 'run-2026-01', monthKey: '2026-01',
      basicPay: 2800, allowances: 200, grossPay: 3000, netPay: 2500, employerCost: 3600,
      epfEmployee: 330, epfEmployer: 390,
      socsoEmployee: 8.75, socsoEmployer: 30.5,
      eisEmployee: 6, eisEmployer: 6,
      pcb: 100, hrdLevy: 15, claimsTotal: 50,
      loanDeductions: [{ loanId: 'loan-1', refNo: 'LN-001', scheduled: 150, applied: 150, deferred: 0 }],
      loanDeductionTotal: 150,
    }),
    mkSlip({
      employeeId: 'emp-2', runId: 'run-2026-01', monthKey: '2026-01',
      basicPay: 1900, otPay: 100, grossPay: 2000, netPay: 1700, employerCost: 2400,
      epfEmployee: 220, epfEmployer: 260,
      socsoEmployee: 6.75, socsoEmployer: 23.5,
      eisEmployee: 4, eisEmployer: 4,
      pcb: 60, hrdLevy: 10,
    }),
    // ── Orphan slip: run deleted — must be excluded (QA: no dangling runId) ──
    mkSlip({
      employeeId: 'emp-3', runId: 'run-ghost', monthKey: '2026-01',
      grossPay: 9999, netPay: 9999, employerCost: 9999,
    }),
    // ── Feb (DRAFT — must be excluded, and the month flagged as a gap) ──
    mkSlip({
      employeeId: 'emp-1', runId: 'run-2026-02', monthKey: '2026-02',
      grossPay: 3100, netPay: 2600, employerCost: 3700,
    }),
    mkSlip({
      employeeId: 'emp-2', runId: 'run-2026-02', monthKey: '2026-02',
      grossPay: 2100, netPay: 1800, employerCost: 2500,
    }),
    // ── Mar (finalized) ──
    mkSlip({
      employeeId: 'emp-1', runId: 'run-2026-03', monthKey: '2026-03',
      basicPay: 2900, allowances: 200, otPay: 100.5, grossPay: 3200.5,
      netPay: 2650.25, employerCost: 3850.75,
      epfEmployee: 352, epfEmployer: 416,
      socsoEmployee: 9.75, socsoEmployer: 34.25,
      eisEmployee: 6.5, eisEmployer: 6.5,
      pcb: 120.25, hrdLevy: 16,
      adjustmentReimbursements: 25,
      loanDeductions: [{ loanId: 'loan-1', refNo: 'LN-001', scheduled: 150, applied: 150, deferred: 0 }],
      loanDeductionTotal: 150,
    }),
    mkSlip({
      employeeId: 'emp-3', runId: 'run-2026-03', monthKey: '2026-03',
      basicPay: 1400, allowances: 100, grossPay: 1500, netPay: 1300, employerCost: 1750,
      epfEmployee: 165, epfEmployer: 195,
      socsoEmployee: 4.25, socsoEmployer: 14.75,
      eisEmployee: 3, eisEmployer: 3,
      pcb: 0, hrdLevy: 7.5,
    }),
  ];
  const settings: Settings = {
    id: 'company',
    companyName: 'ASM Tech Sdn Bhd',
    companyRegNo: '202401000001 (1234567-A)',
    hqState: 'KUL',
    address: '1 Jalan Testing, 50000 Kuala Lumpur',
    epfEmployerNo: 'EPF-EMP-01',
    socsoEmployerNo: 'SOC-EMP-01',
    taxEmployerNo: 'E-123456',
    paydayDay: 28,
    standardDailyHours: 8,
    standardWeeklyHours: 45,
  };
  const company: Company = {
    id: 'co-asm',
    code: 'ASM',
    name: 'ASM Tech Sdn Bhd',
    regNo: '202401000001 (1234567-A)',
    hqState: 'KUL',
    status: 'active',
    plan: 'enterprise',
    createdAt: '2025-01-01T00:00:00.000Z',
    branding: { logoText: 'ASM', accentColor: '#b45309' },
    config: {
      workingWeek: 'sat-sun',
      payrollCutoffDay: 25,
      claimPolicy: {},
      leaveTopUps: {},
      enabledModules: ['payroll'],
      customFields: [],
      numberFormats: { employeeIdPrefix: 'ASM', payslipPrefix: 'ASM-PS' },
      orgChart: { showDottedLineReports: false },
    },
  };
  return { employees, runs, payslips, settings, company };
}

const Q1_2026 = resolveSalaryPeriod({ preset: 'quarterly', quarter: 1, year: 2026 })!;

function buildModel(period: SalaryPeriod = Q1_2026) {
  const { employees, runs, payslips, settings, company } = buildFixtures();
  return aggregateSalaryReport({
    period, runs, payslips, employees, departments: DEPARTMENTS,
    settings, company, generatedAt: GENERATED,
  });
}

// ── Period math ──────────────────────────────────────────────────────────────

describe('resolveSalaryPeriod — preset windows', () => {
  it('monthly resolves to a single month with label + file tag', () => {
    const p = resolveSalaryPeriod({ preset: 'monthly', month: '2026-03' });
    expect(p).not.toBeNull();
    expect(p?.months).toEqual(['2026-03']);
    expect(p?.from).toBe('2026-03');
    expect(p?.to).toBe('2026-03');
    expect(p?.label).toBe('March 2026');
    expect(p?.fileTag).toBe('2026-03');
  });

  it('quarterly resolves Q1/Q4 to their 3-month windows', () => {
    const q1 = resolveSalaryPeriod({ preset: 'quarterly', quarter: 1, year: 2026 });
    expect(q1?.months).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(q1?.label).toBe('Q1 2026 (Jan – Mar)');
    expect(q1?.fileTag).toBe('2026-Q1');
    const q4 = resolveSalaryPeriod({ preset: 'quarterly', quarter: 4, year: 2025 });
    expect(q4?.months).toEqual(['2025-10', '2025-11', '2025-12']);
    expect(q4?.label).toBe('Q4 2025 (Oct – Dec)');
  });

  it('half-yearly resolves H1/H2 to their 6-month windows', () => {
    const h1 = resolveSalaryPeriod({ preset: 'half-yearly', half: 1, year: 2026 });
    expect(h1?.months).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
    ]);
    expect(h1?.label).toBe('H1 2026 (Jan – Jun)');
    expect(h1?.fileTag).toBe('2026-H1');
    const h2 = resolveSalaryPeriod({ preset: 'half-yearly', half: 2, year: 2025 });
    expect(h2?.months[0]).toBe('2025-07');
    expect(h2?.months[5]).toBe('2025-12');
    expect(h2?.fileTag).toBe('2025-H2');
  });

  it('yearly resolves to all 12 months of the year', () => {
    const p = resolveSalaryPeriod({ preset: 'yearly', year: 2026 });
    expect(p?.months).toHaveLength(12);
    expect(p?.months[0]).toBe('2026-01');
    expect(p?.months[11]).toBe('2026-12');
    expect(p?.label).toBe('Year 2026');
    expect(p?.fileTag).toBe('2026');
  });

  it('custom resolves an inclusive from-to window, across year boundaries', () => {
    const p = resolveSalaryPeriod({ preset: 'custom', from: '2025-11', to: '2026-02' });
    expect(p?.months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(p?.label).toBe('Nov 2025 – Feb 2026');
    expect(p?.fileTag).toBe('2025-11_2026-02');
  });

  it('custom with from = to is a one-month window labeled like monthly', () => {
    const p = resolveSalaryPeriod({ preset: 'custom', from: '2026-03', to: '2026-03' });
    expect(p?.months).toEqual(['2026-03']);
    expect(p?.label).toBe('March 2026');
  });

  it('rejects invalid or incomplete selections', () => {
    expect(resolveSalaryPeriod({ preset: 'monthly', month: '2026-13' })).toBeNull();
    expect(resolveSalaryPeriod({ preset: 'monthly', month: '2026-3' })).toBeNull();
    expect(resolveSalaryPeriod({ preset: 'monthly' })).toBeNull();
    expect(resolveSalaryPeriod({ preset: 'quarterly', quarter: 1 })).toBeNull(); // year missing
    expect(resolveSalaryPeriod({ preset: 'half-yearly', half: 3 as never, year: 2026 })).toBeNull();
    expect(resolveSalaryPeriod({ preset: 'yearly', year: 0 })).toBeNull();
    // custom: from after to
    expect(resolveSalaryPeriod({ preset: 'custom', from: '2026-05', to: '2026-02' })).toBeNull();
    expect(resolveSalaryPeriod({ preset: 'custom', from: '2026-05' })).toBeNull();
  });
});

describe('month helpers', () => {
  it('monthsBetween is inclusive and crosses year boundaries', () => {
    expect(monthsBetween('2025-12', '2026-02')).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2026-03', '2026-01')).toEqual([]); // from > to
    expect(monthsBetween('2026-13', '2026-14')).toEqual([]); // invalid
  });

  it('isMonthKey validates strict YYYY-MM', () => {
    expect(isMonthKey('2026-01')).toBe(true);
    expect(isMonthKey('2026-12')).toBe(true);
    expect(isMonthKey('2026-00')).toBe(false);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('26-01')).toBe(false);
    expect(isMonthKey(undefined)).toBe(false);
  });

  it('formats long + short month labels', () => {
    expect(salaryMonthLabel('2026-03')).toBe('March 2026');
    expect(salaryMonthShort('2026-03')).toBe('Mar 26');
  });
});

// ── Aggregation vs payslip sums ──────────────────────────────────────────────

describe('aggregateSalaryReport — totals match hand-summed finalized payslips', () => {
  const model = buildModel();

  it('counts only finalized-run payslips (draft + orphan slips excluded)', () => {
    expect(model.payslipCount).toBe(4); // Jan emp-1/emp-2, Mar emp-1/emp-3
    expect(model.employeesPaid).toBe(3);
  });

  it('gross / net / employer cost equal the Σ of stored payslip figures', () => {
    expect(model.totals.gross).toBe(9700.5);
    expect(model.totals.net).toBe(8150.25);
    expect(model.totals.employerCost).toBe(11600.75);
  });

  it('sums every statutory column + loans + claims from the payslips', () => {
    expect(model.totals).toMatchObject({
      epfEmployee: 1067, epfEmployer: 1261,
      socsoEmployee: 29.5, socsoEmployer: 103,
      eisEmployee: 19.5, eisEmployer: 19.5,
      pcb: 280.25, hrdLevy: 48.5,
      loans: 300,   // 150 (Jan) + 150 (Mar), emp-1
      claims: 75,   // 50 claimsTotal (Jan) + 25 adjustmentReimbursements (Mar)
    });
  });

  it('carries company identity + branding from the Company record', () => {
    expect(model).toMatchObject({
      companyName: 'ASM Tech Sdn Bhd',
      companyRegNo: '202401000001 (1234567-A)',
      companyCode: 'ASM',
      logoText: 'ASM',
      accentColor: '#b45309',
    });
  });

  it('falls back to Settings identity when no Company record is given', () => {
    const { employees, runs, payslips, settings } = buildFixtures();
    const m = aggregateSalaryReport({
      period: Q1_2026, runs, payslips, employees, departments: DEPARTMENTS, settings,
      generatedAt: GENERATED,
    });
    expect(m.companyName).toBe('ASM Tech Sdn Bhd');
    expect(m.companyCode).toBe('COMPANY');
    expect(m.accentColor).toBe('#b45309');
  });
});

// ── Gap detection ────────────────────────────────────────────────────────────

describe('aggregateSalaryReport — gap detection', () => {
  const model = buildModel();

  it('flags months without a finalized run (draft-only Feb) as missing', () => {
    expect(model.expectedMonths).toBe(3);
    expect(model.finalizedMonths).toEqual(['2026-01', '2026-03']);
    expect(model.missingMonths).toEqual(['2026-02']);
    expect(model.hasGaps).toBe(true);
  });

  it('trend row for a gap month is zeroed and marked not finalized', () => {
    const feb = model.monthly.find((m) => m.month === '2026-02')!;
    expect(feb.finalized).toBe(false);
    expect(feb.payslips).toBe(0);
    expect(feb.headcount).toBe(0);
    expect(feb.gross).toBe(0);
    expect(feb.net).toBe(0);
    expect(feb.employerCost).toBe(0);
  });

  it('trend rows for finalized months carry the month sums', () => {
    const jan = model.monthly.find((m) => m.month === '2026-01')!;
    expect(jan).toMatchObject({
      finalized: true, payslips: 2, headcount: 2,
      gross: 5000, net: 4200, employerCost: 6000,
      epfEmployee: 550, epfEmployer: 650, pcb: 160, hrdLevy: 25,
      loans: 150, claims: 50,
    });
    const mar = model.monthly.find((m) => m.month === '2026-03')!;
    expect(mar).toMatchObject({
      finalized: true, payslips: 2, headcount: 2,
      gross: 4700.5, net: 3950.25, employerCost: 5600.75,
    });
  });

  it('a fully finalized period reports no gaps', () => {
    const p = resolveSalaryPeriod({ preset: 'monthly', month: '2026-01' })!;
    const m = buildModel(p);
    expect(m.hasGaps).toBe(false);
    expect(m.missingMonths).toEqual([]);
    expect(m.finalizedMonths).toEqual(['2026-01']);
  });

  it('a period with no finalized run at all aggregates to zeros', () => {
    const p = resolveSalaryPeriod({ preset: 'monthly', month: '2026-02' })!;
    const m = buildModel(p);
    expect(m.hasGaps).toBe(true);
    expect(m.missingMonths).toEqual(['2026-02']);
    expect(m.payslipCount).toBe(0);
    expect(m.employeesPaid).toBe(0);
    expect(m.totals.gross).toBe(0);
    expect(m.employees).toEqual([]);
    expect(m.departments).toEqual([]);
    expect(m.topEarners).toEqual([]);
    expect(m.bands.every((b) => b.count === 0)).toBe(true);
  });
});

// ── Per-employee rows ────────────────────────────────────────────────────────

describe('aggregateSalaryReport — per-employee rows', () => {
  const model = buildModel();

  it('produces one name-sorted row per paid employee', () => {
    expect(model.employees.map((r) => r.name)).toEqual(
      ['Ahmad Faizal', 'Chen Wei', 'Zara Ibrahim'],
    );
  });

  it('accumulates months paid, totals and average monthly gross', () => {
    const zara = model.employees.find((r) => r.name === 'Zara Ibrahim')!;
    expect(zara).toMatchObject({
      employeeNo: 'ASM0001',
      department: 'Engineering',
      monthsPaid: 2,
      gross: 6200.5,
      ot: 100.5,
      allowances: 400,
      epfEmployee: 682,
      socsoEmployee: 18.5,
      eisEmployee: 12.5,
      pcb: 220.25,
      loans: 300,
      net: 5150.25,
      employerCost: 7450.75,
      avgMonthlyGross: 3100.25,
    });
  });

  it('builds the ascending per-month mini breakdown', () => {
    const zara = model.employees.find((r) => r.name === 'Zara Ibrahim')!;
    expect(zara.monthly.map((m) => m.month)).toEqual(['2026-01', '2026-03']);
    expect(zara.monthly[0]).toMatchObject({ gross: 3000, net: 2500, loans: 150, pcb: 100 });
    expect(zara.monthly[1]).toMatchObject({ gross: 3200.5, net: 2650.25, loans: 150 });
    // Draft-month payslip never appears in the breakdown.
    expect(zara.monthly.some((m) => m.month === '2026-02')).toBe(false);
  });

  it('employee row sums reconcile with the period totals', () => {
    const sum = (fn: (r: (typeof model.employees)[number]) => number) =>
      round2(model.employees.reduce((s, r) => s + fn(r), 0));
    expect(sum((r) => r.gross)).toBe(model.totals.gross);
    expect(sum((r) => r.net)).toBe(model.totals.net);
    expect(sum((r) => r.employerCost)).toBe(model.totals.employerCost);
    expect(sum((r) => r.loans)).toBe(model.totals.loans);
    expect(sum((r) => r.pcb)).toBe(model.totals.pcb);
  });
});

// ── Department aggregation ───────────────────────────────────────────────────

describe('aggregateSalaryReport — department aggregation', () => {
  const model = buildModel();

  it('rolls unique employees + totals up per department, sorted by cost desc', () => {
    expect(model.departments.map((d) => d.name)).toEqual(['Engineering', 'Operations']);
    const eng = model.departments[0]!;
    expect(eng).toMatchObject({
      employees: 2, gross: 7700.5, net: 6450.25, employerCost: 9200.75,
    });
    const ops = model.departments[1]!;
    expect(ops).toMatchObject({ employees: 1, gross: 2000, net: 1700, employerCost: 2400 });
  });

  it('computes % of total employer cost (1 decimal) reconciling with totals', () => {
    expect(model.departments.map((d) => d.pctOfCost)).toEqual([79.3, 20.7]);
    const costSum = round2(model.departments.reduce((s, d) => s + d.employerCost, 0));
    expect(costSum).toBe(model.totals.employerCost);
    const pctSum = model.departments.reduce((s, d) => s + d.pctOfCost, 0);
    expect(Math.abs(pctSum - 100)).toBeLessThanOrEqual(0.3);
  });
});

// ── Salary bands ─────────────────────────────────────────────────────────────

describe('salary bands — histogram boundaries', () => {
  it('assigns upper bounds INCLUSIVE: exact boundary lands in the lower band', () => {
    expect(salaryBandIndex(0)).toBe(0);
    expect(salaryBandIndex(1999.99)).toBe(0);
    expect(salaryBandIndex(2000)).toBe(0);      // ≤ 2,000
    expect(salaryBandIndex(2000.01)).toBe(1);
    expect(salaryBandIndex(3000)).toBe(1);      // 2,000 – 3,000
    expect(salaryBandIndex(3000.01)).toBe(2);
    expect(salaryBandIndex(5000)).toBe(2);      // 3,000 – 5,000
    expect(salaryBandIndex(5000.01)).toBe(3);
    expect(salaryBandIndex(8000)).toBe(3);      // 5,000 – 8,000
    expect(salaryBandIndex(8000.01)).toBe(4);   // 8,000+
    expect(salaryBandIndex(99999)).toBe(4);
  });

  it('defines the five mission bands with ascending bounds', () => {
    expect(SALARY_BAND_DEFS).toHaveLength(5);
    expect(SALARY_BAND_DEFS[0]?.max).toBe(2000);
    expect(SALARY_BAND_DEFS[4]?.max).toBeNull();
  });

  it('bands employees by AVERAGE monthly gross; counts sum to employees paid', () => {
    const model = buildModel();
    // avg gross: Zara 3100.25 → band 2; Ahmad 2000 → band 0; Chen 1500 → band 0
    expect(model.bands.map((b) => b.count)).toEqual([2, 0, 1, 0, 0]);
    const total = model.bands.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(model.employeesPaid);
  });

  it('multi-month employees band by average, not period total', () => {
    const { employees, settings, company } = buildFixtures();
    const runs = [
      mkRun('r1', '2026-01', 'finalized'),
      mkRun('r2', '2026-02', 'finalized'),
    ];
    const slips = [
      mkSlip({ employeeId: 'emp-1', runId: 'r1', monthKey: '2026-01', grossPay: 2500, netPay: 2000, employerCost: 3000 }),
      mkSlip({ employeeId: 'emp-1', runId: 'r2', monthKey: '2026-02', grossPay: 2500, netPay: 2000, employerCost: 3000 }),
    ];
    const p = resolveSalaryPeriod({ preset: 'custom', from: '2026-01', to: '2026-02' })!;
    const m = aggregateSalaryReport({
      period: p, runs, payslips: slips, employees, departments: DEPARTMENTS,
      settings, company, generatedAt: GENERATED,
    });
    // 5,000 total but 2,500 average → band 1, not band 3.
    expect(m.employees[0]?.avgMonthlyGross).toBe(2500);
    expect(m.bands.map((b) => b.count)).toEqual([0, 1, 0, 0, 0]);
  });
});

// ── Top earners ──────────────────────────────────────────────────────────────

describe('aggregateSalaryReport — top earners', () => {
  it('orders by period gross desc with name as tiebreak, capped at 10', () => {
    const model = buildModel();
    expect(model.topEarners.map((r) => r.name)).toEqual(
      ['Zara Ibrahim', 'Ahmad Faizal', 'Chen Wei'],
    );
    expect(model.topEarners[0]?.gross).toBe(6200.5);
  });

  it('caps the list at 10 earners', () => {
    const { settings, company } = buildFixtures();
    const employees: Employee[] = [];
    const slips: Payslip[] = [];
    const runs = [mkRun('r1', '2026-01', 'finalized')];
    for (let i = 0; i < 14; i++) {
      const id = `bulk-${String(i).padStart(2, '0')}`;
      employees.push(mkEmp(id, { name: `Bulk ${String(i).padStart(2, '0')}` }));
      slips.push(mkSlip({
        employeeId: id, runId: 'r1', monthKey: '2026-01',
        grossPay: 1000 + i * 100, netPay: 900, employerCost: 1200,
      }));
    }
    const p = resolveSalaryPeriod({ preset: 'monthly', month: '2026-01' })!;
    const m = aggregateSalaryReport({
      period: p, runs, payslips: slips, employees, departments: DEPARTMENTS,
      settings, company, generatedAt: GENERATED,
    });
    expect(m.topEarners).toHaveLength(10);
    expect(m.topEarners[0]?.gross).toBe(2300); // bulk-13
    expect(m.employees).toHaveLength(14);
  });
});

// ── CSV pack ─────────────────────────────────────────────────────────────────

describe('salaryReportCsvs — per-section CSV pack', () => {
  const model = buildModel();
  const files = salaryReportCsvs(model);

  it('produces four named section files under Salary-Report-<COMPANY>-<tag>', () => {
    expect(files.map((f) => f.filename)).toEqual([
      'Salary-Report-ASM-2026-Q1-summary.csv',
      'Salary-Report-ASM-2026-Q1-employees.csv',
      'Salary-Report-ASM-2026-Q1-monthly-trend.csv',
      'Salary-Report-ASM-2026-Q1-departments.csv',
    ]);
  });

  it('summary CSV carries the headline totals as fixed 2-decimal strings', () => {
    const summary = files[0]!.csv;
    expect(summary).toContain('Period,Q1 2026 (Jan – Mar)');
    expect(summary).toContain('Gross wages (RM),9700.50');
    expect(summary).toContain('Net pay (RM),8150.25');
    expect(summary).toContain('Employer cost (RM),11600.75');
    expect(summary).toContain('Loans recovered (RM),300.00');
    expect(summary).toContain('Missing (not finalized) months,1');
    expect(summary).toContain('Missing month list,2026-02');
  });

  it('employees CSV has a header + one row per paid employee (name-sorted)', () => {
    const lines = files[1]!.csv.split('\r\n');
    expect(lines).toHaveLength(1 + 3);
    expect(lines[0]).toContain('Avg monthly gross (RM)');
    expect(lines[1]).toContain('Ahmad Faizal');
    const zara = lines.find((l) => l.includes('Zara Ibrahim'))!;
    expect(zara).toContain('6200.50');
    expect(zara).toContain('3100.25'); // avg monthly gross
    expect(zara).toContain('300.00');  // loans
  });

  it('monthly CSV flags the gap month as excluded', () => {
    const lines = files[2]!.csv.split('\r\n');
    expect(lines).toHaveLength(1 + 3);
    const feb = lines.find((l) => l.startsWith('2026-02,'))!;
    expect(feb).toContain('not finalized (excluded)');
    const jan = lines.find((l) => l.startsWith('2026-01,'))!;
    expect(jan).toContain('finalized');
    expect(jan).toContain('5000.00');
  });

  it('departments CSV has one row per department with cost share', () => {
    const lines = files[3]!.csv.split('\r\n');
    expect(lines).toHaveLength(1 + 2);
    expect(lines[1]).toContain('Engineering,2,7700.50,6450.25,9200.75,79.3');
  });

  it('sanitizes company codes in filenames', () => {
    expect(salaryReportCompanyTag('asm tech!')).toBe('ASM-TECH');
    expect(salaryReportCompanyTag('!!!')).toBe('COMPANY');
  });
});

// ── WinAnsi sanitization + file naming ───────────────────────────────────────

describe('pdfSafe — WinAnsi glyph sanitization', () => {
  it('replaces non-WinAnsi math/arrow glyphs with ASCII fallbacks', () => {
    expect(pdfSafe('≤ RM 2,000')).toBe('<= RM 2,000');
    expect(pdfSafe('RM ≥ 5,000 → save')).toBe('RM >= 5,000 -> save');
  });

  it('keeps cp1252 punctuation (en/em dash, ellipsis, middle dot) intact', () => {
    expect(pdfSafe('Jan – Mar · Q1 — 2026 …')).toBe('Jan – Mar · Q1 — 2026 …');
  });

  it('replaces unmappable glyphs (CJK, emoji) with ?', () => {
    expect(pdfSafe('张伟')).toBe('??');
    expect(pdfSafe('🚀')).toBe('?');
  });
});

describe('salaryReportFileName', () => {
  it('builds Salary-Report-<COMPANY>-<periodTag>.pdf', () => {
    expect(
      salaryReportFileName({ companyCode: 'ASM', period: { fileTag: '2026-Q1' } as SalaryPeriod }),
    ).toBe('Salary-Report-ASM-2026-Q1.pdf');
    expect(
      salaryReportFileName({ companyCode: 'asm tech!', period: { fileTag: '2025-11_2026-02' } as SalaryPeriod }),
    ).toBe('Salary-Report-ASM-TECH-2025-11_2026-02.pdf');
  });
});

// ── Real-PDF node smoke test ─────────────────────────────────────────────────

describe('renderSalaryReportPdf — node smoke test', () => {
  // Cold jsPDF dynamic import + first render can exceed the 5s default under a
  // cold vite transform cache — give these renders an explicit budget.
  const PDF_TIMEOUT = 30_000;
  const tmpFile = join(tmpdir(), 'salary-report-smoke.pdf');

  afterAll(() => {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  });

  it('renders cover + register + department + insights pages whose bytes start with %PDF', async () => {
    const model = buildModel();
    const doc = await renderSalaryReportPdf(model);
    // 3 employees fit on one register page → 1 + 1 + 1 + 1.
    expect(doc.getNumberOfPages()).toBe(4);
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    expect(bytes.byteLength).toBeGreaterThan(1000);
    writeFileSync(tmpFile, bytes);
    const head = readFileSync(tmpFile).subarray(0, 5).toString('latin1');
    expect(head).toBe('%PDF-');
    expect(existsSync(tmpFile)).toBe(true);
    unlinkSync(tmpFile);
    expect(existsSync(tmpFile)).toBe(false);
  }, PDF_TIMEOUT);

  it('paginates the employee register at 20 rows per landscape page', async () => {
    const { employees, runs, settings, company } = buildFixtures();
    const manyEmployees: Employee[] = [];
    const manySlips: Payslip[] = [];
    for (let i = 0; i < 45; i++) {
      const id = `bulk-${String(i).padStart(2, '0')}`;
      manyEmployees.push(mkEmp(id, {
        name: `Bulk ${String(i).padStart(2, '0')}`,
        departmentId: i % 2 === 0 ? 'dept-1' : 'dept-2',
      }));
      manySlips.push(mkSlip({
        employeeId: id, runId: 'run-2026-01', monthKey: '2026-01',
        basicPay: 2500, allowances: 100, grossPay: 2600,
        epfEmployee: 286, epfEmployer: 338,
        socsoEmployee: 7.75, socsoEmployer: 27.25,
        eisEmployee: 5.25, eisEmployer: 5.25,
        pcb: 40.5, hrdLevy: 13, netPay: 2260.5, employerCost: 2983.75,
      }));
    }
    const p = resolveSalaryPeriod({ preset: 'monthly', month: '2026-01' })!;
    const model = aggregateSalaryReport({
      period: p,
      runs,
      payslips: manySlips,
      employees: [...employees, ...manyEmployees],
      departments: DEPARTMENTS,
      settings, company, generatedAt: GENERATED,
    });
    const doc = await renderSalaryReportPdf(model);
    const registerPages = Math.ceil(45 / SALARY_REGISTER_ROWS_PER_PAGE);
    expect(doc.getNumberOfPages()).toBe(1 + registerPages + 1 + 1);
  }, PDF_TIMEOUT);

  it('still renders cleanly for a period with no finalized payroll', async () => {
    const p = resolveSalaryPeriod({ preset: 'monthly', month: '2026-02' })!;
    const model = buildModel(p);
    const doc = await renderSalaryReportPdf(model);
    expect(doc.getNumberOfPages()).toBe(4); // cover + register + dept + insights
  }, PDF_TIMEOUT);
});
