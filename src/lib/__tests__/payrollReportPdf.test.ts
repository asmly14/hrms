/**
 * Org payroll report tests — the pure aggregation behind the PDF (totals vs
 * stored-payslip sums and run totals, department rollup math, register
 * markers, exceptions lists) plus a real-PDF node smoke test (renders the
 * document with jsPDF's node build, verifies page count + %PDF bytes, and
 * cleans the temp file up afterwards).
 *
 * Money fixtures use .00/.25/.50/.75 decimals only, which are exact in binary
 * floating point, so every hand-verified sum is drift-free.
 */
/// <reference types="node" />
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateOrgReport, buildOrgReport, MARKER_ADJUSTED, MARKER_BASIC_OVERRIDE,
  MARKER_OPT_OUT, MARKER_SALARY_TYPE, orgReportFileName, REGISTER_ROWS_PER_PAGE,
  renderOrgReportPdf,
} from '../payrollReportPdf';
import { installLocalStorage } from './storageStub';
import { saveCompanies, setCollection } from '../db';
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

function mkRun(over: Partial<PayrollRun> = {}): PayrollRun {
  return {
    id: 'run-2026-03',
    monthKey: '2026-03',
    status: 'finalized',
    runAt: '2026-03-28T09:00:00.000Z',
    runBy: 'hr-admin',
    employeeCount: 4,
    totalGross: 11348.5,
    totalNet: 10294.25,
    totalEmployerCost: 12432.25,
    warnings: [
      'Dina Ria: basic 1500.00 below minimum wage RM1700 (MWO 2024)',
      'Chen Wei: OT 110h exceeds 104h/month cap (OT Regulations 1980)',
    ],
    prorationMethod: 'calendar',
    cutoffDay: 25,
    finalizedAt: '2026-03-28T10:00:00.000Z',
    ...over,
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
    id: seed.id ?? `run-2026-03:${seed.employeeId}`,
    runId: seed.runId ?? 'run-2026-03',
    monthKey: seed.monthKey ?? '2026-03',
  };
}

/** Four employees covering monthly / daily+override / opt-out+adjusted / dirty-data. */
function buildFixtures() {
  const employees = [
    mkEmp('emp-1', { name: 'Zara Ibrahim', employeeNo: 'ASM0001', departmentId: 'dept-1' }),
    mkEmp('emp-2', {
      name: 'Ahmad Faizal', employeeNo: 'ASM0002', departmentId: 'dept-2', salaryType: 'daily',
    }),
    mkEmp('emp-3', { name: 'Chen Wei', employeeNo: 'ASM0003', departmentId: 'dept-1' }),
    mkEmp('emp-4', {
      name: 'Dina Ria', employeeNo: 'ASM0004', departmentId: 'dept-9', // no such department
      ic: '', epfNo: '', bankAccount: '',
    }),
  ];
  const payslips: Payslip[] = [
    mkSlip({
      employeeId: 'emp-1',
      basicPay: 3000, allowances: 200, otPay: 100.5, grossPay: 3200.5, claimsTotal: 50,
      epfEmployee: 352, epfEmployer: 416,
      socsoEmployee: 9.75, socsoEmployer: 34.25,
      eisEmployee: 6.5, eisEmployer: 6.5,
      pcb: 120.25, hrdLevy: 16, netPay: 2700, employerCost: 3723.25,
      daysWorked: 26, daysInBasis: 26, salaryTypeUsed: 'monthly',
    }),
    mkSlip({
      employeeId: 'emp-2',
      basicPay: 1848, grossPay: 1848,
      epfEmployee: 203.5, epfEmployer: 240.25,
      socsoEmployee: 4.75, socsoEmployer: 16.75,
      eisEmployee: 3.75, eisEmployer: 3.75,
      hrdLevy: 9.25, netPay: 1636, employerCost: 2118,
      salaryTypeUsed: 'daily', workedQty: 22, workedUnit: 'day', basicOverride: 1848,
    }),
    mkSlip({
      employeeId: 'emp-3',
      basicPay: 4000, allowances: 300, grossPay: 4800,
      socsoEmployee: 11.75, socsoEmployer: 41.25,
      eisEmployee: 7.75, eisEmployer: 7.75,
      hrdLevy: 21.5, netPay: 4630.5, employerCost: 4870.5,
      daysWorked: 31, daysInBasis: 31, salaryTypeUsed: 'monthly',
      excludeEpf: true, excludePcb: true,
      optOutReasons: { epf: 'Not eligible — director', pcb: 'CP39 settled separately' },
      adjustments: [
        { id: 'adj-1', kind: 'earning', preset: 'custom', label: 'Bonus', amount: 500 },
        { id: 'adj-2', kind: 'deduction', preset: 'zakat', label: 'Monthly zakat', amount: 150 },
      ],
      adjustmentEarnings: 500, adjustmentDeductions: 150,
    }),
    mkSlip({
      employeeId: 'emp-4',
      basicPay: 1500, grossPay: 1500, unpaidLeaveDeduction: 48.5,
      epfEmployee: 165, epfEmployer: 195,
      socsoEmployee: 4.25, socsoEmployer: 14.75,
      eisEmployee: 3, eisEmployer: 3,
      hrdLevy: 7.5, netPay: 1327.75, employerCost: 1720.5,
      daysWorked: 30, daysInBasis: 31, salaryTypeUsed: 'monthly',
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
  return { employees, payslips, settings, company, run: mkRun() };
}

function buildModel() {
  const { employees, payslips, settings, company, run } = buildFixtures();
  return aggregateOrgReport({
    run, slips: payslips, employees, departments: DEPARTMENTS,
    settings, company, generatedAt: GENERATED,
  });
}

// ── Headline totals ──────────────────────────────────────────────────────────

describe('aggregateOrgReport — headline totals', () => {
  const model = buildModel();

  it('headcount + gross/net/employer cost match the run totals (Σ stored payslips)', () => {
    expect(model.headcount).toBe(4);
    expect(model.totals.gross).toBe(11348.5);
    expect(model.totals.net).toBe(10294.25);
    expect(model.totals.employerCost).toBe(12432.25);
  });

  it('sums every statutory column from the payslips', () => {
    expect(model.totals).toMatchObject({
      basic: 10348, allowances: 500, ot: 100.5,
      epfEmployee: 720.5, epfEmployer: 851.25,
      socsoEmployee: 30.5, socsoEmployer: 107,
      eisEmployee: 21, eisEmployer: 21,
      pcb: 120.25, hrdLevy: 54.25,
      claims: 50, unpaidLeave: 48.5,
      adjustmentDeductions: 150,
    });
  });

  it('total deductions = EPF ee + SOCSO ee + EIS ee + PCB + deduction adjustments', () => {
    const t = model.totals;
    expect(t.deductions).toBe(1042.25);
    expect(t.deductions).toBe(
      round2(t.epfEmployee + t.socsoEmployee + t.eisEmployee + t.pcb + t.adjustmentDeductions),
    );
  });

  it('computes average and median net pay', () => {
    expect(model.averageNet).toBe(2573.56); // 10294.25 / 4, sen-rounded
    expect(model.medianNet).toBe(2168);     // (1636 + 2700) / 2
  });

  it('median of an odd-sized run is the middle net pay', () => {
    const { employees, settings, company, run } = buildFixtures();
    const slips = [
      mkSlip({ employeeId: 'emp-1', netPay: 100 }),
      mkSlip({ employeeId: 'emp-2', netPay: 500 }),
      mkSlip({ employeeId: 'emp-3', netPay: 300 }),
    ];
    const model = aggregateOrgReport({
      run, slips, employees, departments: DEPARTMENTS, settings, company,
      generatedAt: GENERATED,
    });
    expect(model.medianNet).toBe(300);
    expect(model.averageNet).toBe(300);
  });

  it('handles an empty run without dividing by zero', () => {
    const { employees, settings, company, run } = buildFixtures();
    const model = aggregateOrgReport({
      run, slips: [], employees, departments: DEPARTMENTS, settings, company,
      generatedAt: GENERATED,
    });
    expect(model.headcount).toBe(0);
    expect(model.averageNet).toBe(0);
    expect(model.medianNet).toBe(0);
    expect(model.departments).toEqual([]);
  });
});

// ── Run context ──────────────────────────────────────────────────────────────

describe('aggregateOrgReport — run context', () => {
  const model = buildModel();

  it('carries company identity + branding from the Company record', () => {
    expect(model).toMatchObject({
      companyName: 'ASM Tech Sdn Bhd',
      companyRegNo: '202401000001 (1234567-A)',
      companyCode: 'ASM',
      logoText: 'ASM',
      accentColor: '#b45309',
    });
  });

  it('derives the cut-off window from the run month + cut-off day', () => {
    expect(model.period).toEqual({ start: '2026-02-26', end: '2026-03-25', cutoffDay: 25 });
  });

  it('records the proration method and its human label', () => {
    expect(model.prorationMethod).toBe('calendar');
    expect(model.prorationLabel).toBe('calendar days');
  });

  it('falls back to Settings identity when no Company record is given', () => {
    const { employees, payslips, settings, run } = buildFixtures();
    const model = aggregateOrgReport({
      run, slips: payslips, employees, departments: DEPARTMENTS, settings,
      generatedAt: GENERATED,
    });
    expect(model.companyName).toBe('ASM Tech Sdn Bhd');
    expect(model.companyRegNo).toBe('202401000001 (1234567-A)');
    expect(model.accentColor).toBe('#b45309');
  });
});

// ── Department rollup ────────────────────────────────────────────────────────

describe('aggregateOrgReport — department breakdown', () => {
  const model = buildModel();

  it('rolls headcount/gross/net/employer cost up per department', () => {
    expect(model.departments).toHaveLength(3);
    const eng = model.departments.find((d) => d.name === 'Engineering');
    expect(eng).toMatchObject({
      headcount: 2, gross: 8000.5, net: 7330.5, employerCost: 8593.75,
    });
    const ops = model.departments.find((d) => d.name === 'Operations');
    expect(ops).toMatchObject({ headcount: 1, gross: 1848, net: 1636, employerCost: 2118 });
  });

  it('buckets employees with an unknown department as Unassigned', () => {
    const un = model.departments.find((d) => d.name === 'Unassigned');
    expect(un).toMatchObject({ headcount: 1, gross: 1500, net: 1327.75, employerCost: 1720.5 });
  });

  it('computes % of total employer cost (1 decimal) and sorts desc by cost', () => {
    expect(model.departments.map((d) => d.name)).toEqual(
      ['Engineering', 'Operations', 'Unassigned'],
    );
    expect(model.departments.map((d) => d.pctOfTotalCost)).toEqual([69.1, 17.0, 13.8]);
    const pctSum = model.departments.reduce((s, d) => s + d.pctOfTotalCost, 0);
    expect(Math.abs(pctSum - 100)).toBeLessThanOrEqual(0.3); // rounding tolerance
    const costSum = round2(model.departments.reduce((s, d) => s + d.employerCost, 0));
    expect(costSum).toBe(model.totals.employerCost);
  });
});

// ── Employee register rows ───────────────────────────────────────────────────

describe('aggregateOrgReport — employee register rows', () => {
  const model = buildModel();

  it('produces one name-sorted row per payslip with staff number + department', () => {
    expect(model.employees.map((r) => r.name)).toEqual(
      ['Ahmad Faizal', 'Chen Wei', 'Dina Ria', 'Zara Ibrahim'],
    );
    expect(model.employees[0]).toMatchObject({
      employeeNo: 'ASM0002', department: 'Operations', gross: 1848, net: 1636,
    });
  });

  it('labels worked days per salary type (monthly fraction / days / hours)', () => {
    const byName = new Map(model.employees.map((r) => [r.name, r]));
    expect(byName.get('Zara Ibrahim')?.daysLabel).toBe('26/26');
    expect(byName.get('Ahmad Faizal')?.daysLabel).toBe('22 d');
    expect(byName.get('Dina Ria')?.daysLabel).toBe('30/31');
  });

  it('labels hours for hourly-rated payslips', () => {
    const { employees, settings, company, run } = buildFixtures();
    const slips = [
      mkSlip({ employeeId: 'emp-1', salaryTypeUsed: 'hourly', workedQty: 176, workedUnit: 'hour' }),
    ];
    const [row] = aggregateOrgReport({
      run, slips, employees, departments: DEPARTMENTS, settings, company,
      generatedAt: GENERATED,
    }).employees;
    expect(row?.daysLabel).toBe('176 h');
    expect(row?.markers).toContain(MARKER_SALARY_TYPE);
  });

  it('marks basic overrides, daily/hourly rating, opt-outs and adjustments', () => {
    const byName = new Map(model.employees.map((r) => [r.name, r]));
    expect(byName.get('Ahmad Faizal')?.markers).toEqual(
      [MARKER_BASIC_OVERRIDE, MARKER_SALARY_TYPE],
    );
    expect(byName.get('Chen Wei')?.markers).toEqual([MARKER_OPT_OUT, MARKER_ADJUSTED]);
    expect(byName.get('Zara Ibrahim')?.markers).toEqual([]);
    expect(byName.get('Chen Wei')?.footnotes.join(' ')).toContain('opted out: EPF, PCB');
    expect(byName.get('Chen Wei')?.footnotes.join(' ')).toContain('2 adjustment line(s)');
  });

  it('other deductions = deduction adjustments only (unpaid leave stays inside basic)', () => {
    const byName = new Map(model.employees.map((r) => [r.name, r]));
    expect(byName.get('Chen Wei')?.otherDeductions).toBe(150);
    expect(byName.get('Dina Ria')?.otherDeductions).toBe(0);
  });
});

// ── Exceptions ───────────────────────────────────────────────────────────────

describe('aggregateOrgReport — exceptions', () => {
  const model = buildModel();

  it('carries engine warnings (below minimum wage, OT cap) split into employee + detail', () => {
    const engine = model.warnings.filter((w) => w.source === 'engine');
    expect(engine).toHaveLength(2);
    expect(engine[0]).toEqual({
      source: 'engine',
      employee: 'Dina Ria',
      detail: 'basic 1500.00 below minimum wage RM1700 (MWO 2024)',
    });
    expect(engine[1]?.detail).toContain('OT 110h exceeds 104h/month cap');
  });

  it('flags missing statutory numbers and bank details per employee, deduplicated', () => {
    const data = model.warnings.filter((w) => w.source === 'data');
    const details = data.map((w) => `${w.employee}|${w.detail}`);
    expect(details).toContain('Dina Ria|Missing NRIC / passport no.');
    expect(details).toContain('Dina Ria|Missing EPF member no.');
    expect(details).toContain('Dina Ria|Missing bank details');
    // 2 of the 4 employees have complete records → warnings only for Dina Ria.
    expect(new Set(data.map((w) => w.employee))).toEqual(new Set(['Dina Ria']));
    expect(details.length).toBe(new Set(details).size);
  });

  it('lists statutory opt-outs with schemes and stored reasons', () => {
    expect(model.optOuts).toHaveLength(1);
    expect(model.optOuts[0]).toMatchObject({ employee: 'Chen Wei', schemes: ['EPF', 'PCB'] });
    expect(model.optOuts[0]?.reason).toContain('EPF: Not eligible — director');
    expect(model.optOuts[0]?.reason).toContain('PCB: CP39 settled separately');
  });

  it('summarizes manual adjustments per employee', () => {
    expect(model.adjustments).toEqual([
      { employee: 'Chen Wei', lines: 2, earnings: 500, deductions: 150, reimbursements: 0 },
    ]);
  });
});

// ── File naming ──────────────────────────────────────────────────────────────

describe('orgReportFileName', () => {
  it('builds Payroll-Report-<COMPANY>-<YYYY-MM>.pdf', () => {
    expect(orgReportFileName({ companyCode: 'ASM', monthKey: '2026-03' }))
      .toBe('Payroll-Report-ASM-2026-03.pdf');
  });

  it('sanitizes unusual company codes and never emits an empty code', () => {
    expect(orgReportFileName({ companyCode: 'asm tech!', monthKey: '2026-12' }))
      .toBe('Payroll-Report-ASM-TECH-2026-12.pdf');
    expect(orgReportFileName({ companyCode: '!!!', monthKey: '2026-01' }))
      .toBe('Payroll-Report-COMPANY-2026-01.pdf');
  });
});

// ── db-backed builder ────────────────────────────────────────────────────────

describe('buildOrgReport (db-backed)', () => {
  beforeEach(() => {
    installLocalStorage();
    const { employees, payslips, settings, company, run } = buildFixtures();
    saveCompanies([company]);
    setCollection('employees', employees);
    setCollection('departments', DEPARTMENTS);
    setCollection('settings', [settings]);
    setCollection('payrollRuns', [run]);
    setCollection('payslips', payslips);
  });

  it('assembles the model from the active tenant collections', () => {
    const model = buildOrgReport('run-2026-03', { generatedAt: GENERATED });
    expect(model).not.toBeNull();
    expect(model?.headcount).toBe(4);
    expect(model?.totals.net).toBe(10294.25);
    expect(model?.accentColor).toBe('#b45309');
    expect(model?.period).toEqual({ start: '2026-02-26', end: '2026-03-25', cutoffDay: 25 });
  });

  it('returns null for an unknown run id', () => {
    expect(buildOrgReport('run-ghost')).toBeNull();
  });
});

// ── Real-PDF node smoke test ─────────────────────────────────────────────────

describe('renderOrgReportPdf — node smoke test', () => {
  const tmpFile = join(tmpdir(), 'org-payroll-report-smoke.pdf');

  afterAll(() => {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  });

  it('renders a multi-page PDF whose bytes start with %PDF', async () => {
    const { employees, settings, company } = buildFixtures();
    // 45 employees → cover + department + 3 register pages (20/page) + exceptions.
    const manyEmployees: Employee[] = [];
    const manySlips: Payslip[] = [];
    for (let i = 0; i < 45; i++) {
      const id = `bulk-${String(i).padStart(2, '0')}`;
      manyEmployees.push(mkEmp(id, {
        name: `Bulk ${String(i).padStart(2, '0')}`,
        departmentId: i % 2 === 0 ? 'dept-1' : 'dept-2',
      }));
      manySlips.push(mkSlip({
        employeeId: id,
        basicPay: 2500, allowances: 100, grossPay: 2600,
        epfEmployee: 286, epfEmployer: 338,
        socsoEmployee: 7.75, socsoEmployer: 27.25,
        eisEmployee: 5.25, eisEmployer: 5.25,
        pcb: 40.5, hrdLevy: 13, netPay: 2260.5, employerCost: 2983.75,
        daysWorked: 26, daysInBasis: 26, salaryTypeUsed: 'monthly',
      }));
    }
    const model = aggregateOrgReport({
      run: mkRun({ employeeCount: 45 }),
      slips: manySlips,
      employees: [...employees, ...manyEmployees],
      departments: DEPARTMENTS,
      settings, company, generatedAt: GENERATED,
    });

    const doc = await renderOrgReportPdf(model);
    const expectedRegisterPages = Math.ceil(45 / REGISTER_ROWS_PER_PAGE);
    expect(doc.getNumberOfPages()).toBe(1 + 1 + expectedRegisterPages + 1);
    expect(doc.getNumberOfPages()).toBeGreaterThan(0);

    const bytes = new Uint8Array(doc.output('arraybuffer'));
    expect(bytes.byteLength).toBeGreaterThan(1000);
    writeFileSync(tmpFile, bytes);
    const head = readFileSync(tmpFile).subarray(0, 5).toString('latin1');
    expect(head).toBe('%PDF-');
    expect(existsSync(tmpFile)).toBe(true);
    unlinkSync(tmpFile);
    expect(existsSync(tmpFile)).toBe(false);
  });

  it('still renders cleanly for an empty run', async () => {
    const { employees, settings, company, run } = buildFixtures();
    const model = aggregateOrgReport({
      run, slips: [], employees, departments: DEPARTMENTS, settings, company,
      generatedAt: GENERATED,
    });
    const doc = await renderOrgReportPdf(model);
    expect(doc.getNumberOfPages()).toBe(4); // cover + dept + register + exceptions
  });
});
