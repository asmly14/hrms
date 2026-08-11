import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { getCollection, saveCompanies, setCollection } from '../db';
import {
  DEFAULT_GL_MAPPING,
  GL_LINE_TYPES,
  buildGLJournal,
  getGLMapping,
  glToGenericCsv,
  glToQboCsv,
  glToXeroCsv,
  journalDateFor,
  journalRefFor,
  saveGLMapping,
  slipGLAmounts,
  type GLMapping,
} from '../glExport';
import { finalizePayrollRun, runPayroll, setPayslipAdjustments } from '../payrollEngine';
import { buildDeptCostRollup } from '@/pages/reports/reportBuilders';
import { round2 } from '../utils';
import type {
  Claim,
  Company,
  Department,
  Employee,
  PayslipAdjustment,
} from '../types';
import type { DepartmentProfile } from '../orgChart';

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
  fixedAllowances: [{ name: 'Transport', amount: 200 }],
};

const emp2: Employee = {
  ...emp1,
  id: 'emp-2',
  name: 'Test Employee Two',
  email: 'two@test.my',
  departmentId: 'dept-2',
  baseSalary: 5000,
  fixedAllowances: [],
};

const departments: Department[] = [
  { id: 'dept-1', name: 'Engineering', code: 'ENG', state: 'KUL' },
  { id: 'dept-2', name: 'Sales', code: 'SAL', state: 'KUL' },
];

const deptProfiles: DepartmentProfile[] = [
  { id: 'dept-1', departmentId: 'dept-1', costCenter: 'CC-100', updatedAt: '2025-01-01T00:00:00Z' },
];

const claims: Claim[] = [
  { id: 'clm-1', employeeId: 'emp-1', category: 'travel', title: 'Grab to client', amount: 45.5, claimDate: '2025-03-05', status: 'approved' },
];

function seedAll(): void {
  saveCompanies([testCompany]);
  setCollection('employees', [emp1, emp2]);
  setCollection('departments', departments);
  setCollection('departmentProfiles', deptProfiles);
  setCollection('attendance', []);
  setCollection('leaves', []);
  setCollection('claims', claims);
  setCollection('payrollRuns', []);
  setCollection('payslips', []);
  setCollection('settings', []);
  setCollection('audit', []);
}

beforeEach(() => {
  installLocalStorage();
  seedAll();
});

const MONTH = '2025-03';

/** Parse a CSV produced by the gl serializers and sum the debit/credit columns. */
function csvDebitCreditSums(csv: string, header: string): { debit: number; credit: number } {
  const lines = csv.split('\r\n');
  const cols = lines[0].split(',');
  const di = cols.indexOf(header === 'qbo' ? 'Debits' : 'Debit');
  const ci = cols.indexOf(header === 'qbo' ? 'Credits' : 'Credit');
  let debit = 0;
  let credit = 0;
  for (const row of lines.slice(1)) {
    const cells = row.split(',');
    debit += Number(cells[di] || 0);
    credit += Number(cells[ci] || 0);
  }
  return { debit: round2(debit), credit: round2(credit) };
}

describe('buildGLJournal — balance', () => {
  it('summary journal always balances (debits == credits)', () => {
    const { run } = runPayroll(MONTH);
    const j = buildGLJournal(run.id, { mode: 'summary' });
    expect(j.balanced).toBe(true);
    expect(j.debitTotal).toBe(j.creditTotal);
    expect(j.debitTotal).toBeGreaterThan(0);
  });

  it('detailed journal balances and covers every employee', () => {
    const { run, payslips } = runPayroll(MONTH);
    const j = buildGLJournal(run.id, { mode: 'detailed' });
    expect(j.debitTotal).toBe(j.creditTotal);
    const empIds = new Set(j.lines.map((l) => l.employeeId));
    expect(empIds.size).toBe(payslips.length);
  });

  it('debit total equals employer cost plus claim-free identity check', () => {
    const { run } = runPayroll(MONTH);
    const slips = getCollection<{ employerCost: number; claimsTotal: number; grossPay: number }>('payslips');
    const erStatutoryAndClaims = round2(
      slips.reduce((s, p) => s + (p.employerCost - p.grossPay), 0),
    );
    const gross = round2(slips.reduce((s, p) => s + p.grossPay, 0));
    const j = buildGLJournal(run.id);
    // debits = gross wages + employer statutory + HRD + claims (employer cost)
    expect(j.debitTotal).toBe(round2(gross + erStatutoryAndClaims));
    expect(j.debitTotal).toBe(run.totalEmployerCost);
  });

  it('balances with CP38 / Zakat / PTPTN / custom adjustments on a draft→finalized run', () => {
    const { run } = runPayroll(MONTH, undefined, 'test', { draft: true });
    const adjustments: PayslipAdjustment[] = [
      { id: 'adj-1', kind: 'deduction', preset: 'cp38', label: 'Court order', amount: 150 },
      { id: 'adj-2', kind: 'deduction', preset: 'zakat', label: 'Monthly zakat', amount: 75.25 },
      { id: 'adj-3', kind: 'deduction', preset: 'ptptn', label: 'Loan', amount: 120 },
      { id: 'adj-4', kind: 'deduction', preset: 'custom', label: 'Union fee', amount: 10 },
      { id: 'adj-5', kind: 'earning', preset: 'custom', label: 'One-off bonus', amount: 500 },
    ];
    expect(setPayslipAdjustments(run.id, 'emp-1', adjustments)).not.toBeNull();
    expect(finalizePayrollRun(run.id)).not.toBeNull();

    for (const mode of ['summary', 'detailed'] as const) {
      const j = buildGLJournal(run.id, { mode });
      expect(j.debitTotal).toBe(j.creditTotal);
    }
    const j = buildGLJournal(run.id);
    const byType = new Map(j.lines.map((l) => [l.type, l]));
    expect(byType.get('cp38Payable')?.credit).toBe(150);
    expect(byType.get('zakatPayable')?.credit).toBe(75.25);
    expect(byType.get('ptptnPayable')?.credit).toBe(120);
    expect(byType.get('otherDeductionsPayable')?.credit).toBe(10);
    expect(byType.get('otherEarnings')?.debit).toBe(500);
  });

  it('throws for draft runs and unknown runs', () => {
    const { run } = runPayroll(MONTH, undefined, 'test', { draft: true });
    expect(() => buildGLJournal(run.id)).toThrow(/not finalized/);
    expect(() => buildGLJournal('no-such-run')).toThrow(/not found/);
  });
});

describe('slipGLAmounts', () => {
  it('wage split sums to gross; deduction presets sum to adjustmentDeductions', () => {
    const { run } = runPayroll(MONTH, undefined, 'test', { draft: true });
    setPayslipAdjustments(run.id, 'emp-1', [
      { id: 'a1', kind: 'deduction', preset: 'cp38', label: 'x', amount: 50 },
      { id: 'a2', kind: 'deduction', preset: 'custom', label: 'y', amount: 20 },
    ]);
    const slips = getCollection<Parameters<typeof slipGLAmounts>[0]>('payslips');
    for (const p of slips) {
      const a = slipGLAmounts(p);
      expect(round2(a.wagesBasic + a.wagesAllowance + a.wagesOT + a.otherEarnings)).toBe(p.grossPay);
      expect(round2(a.cp38Payable + a.zakatPayable + a.ptptnPayable + a.otherDeductionsPayable)).toBe(
        p.adjustmentDeductions ?? 0,
      );
    }
  });
});

describe('GL mapping persistence', () => {
  it('returns MY SME defaults when nothing is stored', () => {
    const m = getGLMapping();
    expect(m.wagesBasic.code).toBe(DEFAULT_GL_MAPPING.wagesBasic.code);
    expect(m.pcbPayable.name).toBe(DEFAULT_GL_MAPPING.pcbPayable.name);
    expect(GL_LINE_TYPES.every((t) => m[t].code && m[t].name)).toBe(true);
  });

  it('saveGLMapping persists per company and round-trips', () => {
    const m = getGLMapping();
    m.epfPayable = { code: '2215', name: 'KWSP control account' };
    saveGLMapping(m, 'hr');
    const reread = getGLMapping();
    expect(reread.epfPayable).toEqual({ code: '2215', name: 'KWSP control account' });
    // untouched line types keep their saved/default values
    expect(reread.socsoPayable.code).toBe(DEFAULT_GL_MAPPING.socsoPayable.code);
    const doc = getCollection<{ id: string; kind?: string }>('settings').find((r) => r.id === 'ext:glMapping');
    expect(doc?.kind).toBe('glMapping');
  });

  it('blank codes fall back to defaults on save', () => {
    const m = getGLMapping();
    m.hrdPayable = { code: '  ', name: '' };
    const clean = saveGLMapping(m);
    expect(clean.hrdPayable).toEqual(DEFAULT_GL_MAPPING.hrdPayable);
  });

  it('custom mapping is honoured by the journal', () => {
    runPayroll(MONTH);
    const custom: GLMapping = getGLMapping();
    custom.netPay = { code: '9001', name: 'Payroll clearing' };
    const { run } = { run: getCollection<{ id: string }>('payrollRuns')[0] };
    const j = buildGLJournal(run.id, { mapping: custom });
    const netLine = j.lines.find((l) => l.type === 'netPay');
    expect(netLine?.accountCode).toBe('9001');
    expect(j.debitTotal).toBe(j.creditTotal);
  });
});

describe('journal ref + date', () => {
  it('ref is <COMPANY>-PAY-<YYYY-MM>; date is month end', () => {
    expect(journalRefFor({ monthKey: '2025-03' })).toBe('ASM-PAY-2025-03');
    expect(journalDateFor('2025-03')).toBe('2025-03-31');
    expect(journalDateFor('2024-02')).toBe('2024-02-29'); // leap year
  });
});

describe('CSV serializers', () => {
  it('all three formats export balanced debit/credit columns with the journal ref', () => {
    const { run } = runPayroll(MONTH);
    const j = buildGLJournal(run.id);
    for (const [name, csv] of [
      ['xero', glToXeroCsv(j)],
      ['qbo', glToQboCsv(j)],
      ['generic', glToGenericCsv(j)],
    ] as const) {
      const sums = csvDebitCreditSums(csv, name);
      expect(sums.debit).toBe(j.debitTotal);
      expect(sums.credit).toBe(j.creditTotal);
      expect(csv).toContain(j.ref);
    }
  });

  it('Xero uses DD/MM/YYYY dates and its import header', () => {
    const { run } = runPayroll(MONTH);
    const csv = glToXeroCsv(buildGLJournal(run.id));
    expect(csv.split('\r\n')[0]).toBe('JournalNumber,JournalDate,Description,AccountCode,Debit,Credit,Reference');
    expect(csv).toContain('31/03/2025');
  });

  it('QBO uses MM/DD/YYYY dates and its import header', () => {
    const { run } = runPayroll(MONTH);
    const csv = glToQboCsv(buildGLJournal(run.id));
    expect(csv.split('\r\n')[0]).toBe('Journal No,Journal Date,Account,Debits,Credits,Memo,Name');
    expect(csv).toContain('03/31/2025');
  });

  it('detailed mode adds per-employee memos and QBO Name values', () => {
    const { run } = runPayroll(MONTH);
    const j = buildGLJournal(run.id, { mode: 'detailed' });
    const qbo = glToQboCsv(j);
    expect(qbo).toContain('Test Employee One');
    expect(j.lines.every((l) => l.memo.includes(l.employeeName ?? ''))).toBe(true);
  });
});

describe('buildDeptCostRollup', () => {
  it('department totals equal the finalized run totals', () => {
    const { run } = runPayroll(MONTH);
    const employees = getCollection<Employee>('employees');
    const slips = getCollection<import('../types').Payslip>('payslips');
    const runs = getCollection<import('../types').PayrollRun>('payrollRuns');
    const report = buildDeptCostRollup(MONTH, employees, departments, deptProfiles, slips, runs);

    expect(report.rows).toHaveLength(2);
    expect(report.totalRow?.gross).toBe(run.totalGross);
    expect(report.totalRow?.totalCost).toBe(run.totalEmployerCost);

    const eng = report.rows.find((r) => r.department === 'Engineering');
    const sales = report.rows.find((r) => r.department === 'Sales');
    expect(eng?.costCenter).toBe('CC-100');
    expect(sales?.costCenter).toBe('—'); // no department profile on record
    // per-row identity: gross + er statutory + hrd + claims = total employer cost
    for (const r of report.rows) {
      expect(round2(Number(r.gross) + Number(r.erStatutory) + Number(r.hrd) + Number(r.claims))).toBe(r.totalCost);
    }
  });

  it('excludes draft runs entirely', () => {
    runPayroll(MONTH, undefined, 'test', { draft: true });
    const employees = getCollection<Employee>('employees');
    const slips = getCollection<import('../types').Payslip>('payslips');
    const runs = getCollection<import('../types').PayrollRun>('payrollRuns');
    const report = buildDeptCostRollup(MONTH, employees, departments, deptProfiles, slips, runs);
    expect(report.rows).toHaveLength(0);
  });

  it('picks the month up after the draft run is finalized', () => {
    const { run } = runPayroll(MONTH, undefined, 'test', { draft: true });
    finalizePayrollRun(run.id);
    const employees = getCollection<Employee>('employees');
    const slips = getCollection<import('../types').Payslip>('payslips');
    const runs = getCollection<import('../types').PayrollRun>('payrollRuns');
    const report = buildDeptCostRollup(MONTH, employees, departments, deptProfiles, slips, runs);
    expect(report.totalRow?.totalCost).toBe(run.totalEmployerCost);
    expect(report.totalRow?.headcount).toBe(2);
  });
});
