import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { getCollection, saveCompanies, setCollection } from '../db';
import { runPayroll } from '../payrollEngine';
import { buildGLJournal } from '../glExport';
import { calcEPF, calcSOCSO, calcEIS } from '../statutory';
import {
  applicabilityToTriState,
  resolveStatutoryEligibility,
  triStateToApplicability,
} from '../statutoryEligibility';
import { CONTRACTS_COLLECTION, type EmploymentContract } from '../contracts';
import { round2 } from '../utils';
import type { Company, Employee, Payslip } from '../types';

/**
 * Statutory applicability standing rule (lib/statutoryEligibility.ts):
 *  - AUTO resolution (employment type + in-force linked contract kind)
 *  - employer override wins per scheme; EIS follows SOCSO
 *  - engine zeroing + payslip info lines + recorded resolution fields
 *  - GL journal stays balanced with zeroed contributions
 *  - backward compatibility: employees without flags = legacy behaviour
 */

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

const baseEmp: Employee = {
  id: 'emp-1',
  name: 'Regular Employee',
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

/** Contractor on payroll (fees via payroll), linked to a for-service contract. */
const contractorEmp: Employee = {
  ...baseEmp,
  id: 'emp-c',
  name: 'Consultant Contractor',
  email: 'consultant@test.my',
  baseSalary: 4000,
  fixedAllowances: [],
};

function makeContract(patch: Partial<EmploymentContract>): EmploymentContract {
  return {
    id: 'ct-1',
    employeeId: 'emp-c',
    kind: 'for-service',
    title: 'IT Consultant',
    refNo: 'ASM-CT-2025-001',
    party: { companySigner: 'CEO' },
    startDate: '2025-01-01',
    status: 'active',
    remuneration: { mode: 'fixed-fee', amount: 4000, currency: 'MYR' },
    terms: { ipClause: true, confidentiality: true },
    statutoryApplies: false,
    version: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...patch,
  };
}

function isoInDays(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MONTH = '2025-03';

beforeEach(() => {
  installLocalStorage();
  saveCompanies([testCompany]);
  setCollection('employees', [baseEmp, contractorEmp]);
  setCollection('attendance', []);
  setCollection('leaves', []);
  setCollection('claims', []);
  setCollection('payrollRuns', []);
  setCollection('payslips', []);
  setCollection('audit', []);
  setCollection(CONTRACTS_COLLECTION, []);
});

function slipFor(payslips: Payslip[], employeeId: string): Payslip {
  const p = payslips.find((s) => s.employeeId === employeeId);
  if (!p) throw new Error(`no payslip for ${employeeId}`);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver — AUTO rules per employment type / contract kind
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveStatutoryEligibility — AUTO rules', () => {
  it('full-time employee, no contracts → all schemes applicable (auto)', () => {
    const r = resolveStatutoryEligibility(baseEmp, []);
    expect(r).toMatchObject({ epf: true, socso: true, eis: true, source: 'auto' });
    expect(r.epfReason).toBeUndefined();
    expect(r.autoBasis).toContain('full-time employee');
  });

  it('part-time employee → applicable (auto)', () => {
    const r = resolveStatutoryEligibility({ ...baseEmp, employmentType: 'part-time' }, []);
    expect(r).toMatchObject({ epf: true, socso: true, eis: true, source: 'auto' });
    expect(r.autoBasis).toContain('part-time employee');
  });

  it('contract (of-service) employee without linked contract record → applicable (auto)', () => {
    const r = resolveStatutoryEligibility({ ...baseEmp, employmentType: 'contract' }, []);
    expect(r).toMatchObject({ epf: true, socso: true, eis: true, source: 'auto' });
    expect(r.autoBasis).toContain('contract of service');
  });

  it('active linked contract FOR service → all schemes OFF (auto)', () => {
    const r = resolveStatutoryEligibility(contractorEmp, [makeContract({})]);
    expect(r).toMatchObject({ epf: false, socso: false, eis: false, source: 'auto' });
    expect(r.autoBasis).toContain('contract for service ASM-CT-2025-001');
    expect(r.epfReason).toBe('EPF not applicable — contract for service');
    expect(r.socsoReason).toBe('SOCSO not applicable — contract for service');
    expect(r.eisReason).toBe('EIS not applicable — contract for service');
    expect(r.reasons.join(' ')).toContain('ASM-CT-2025-001');
  });

  it('expiring (end within 60 days) for-service contract is still in force → OFF', () => {
    const c = makeContract({ endDate: isoInDays(30) });
    const r = resolveStatutoryEligibility(contractorEmp, [c]);
    expect(r).toMatchObject({ epf: false, socso: false, eis: false });
  });

  it('expired for-service contract → applicable again', () => {
    const c = makeContract({ endDate: isoInDays(-10) });
    const r = resolveStatutoryEligibility(contractorEmp, [c]);
    expect(r).toMatchObject({ epf: true, socso: true, eis: true, source: 'auto' });
  });

  it.each(['draft', 'terminated', 'renewed'] as const)(
    '%s for-service contract never drives applicability → applicable',
    (status) => {
      const c = makeContract({ status });
      const r = resolveStatutoryEligibility(contractorEmp, [c]);
      expect(r).toMatchObject({ epf: true, socso: true, eis: true, source: 'auto' });
    },
  );

  it('active linked contract OF service → applicable (auto)', () => {
    const c = makeContract({ kind: 'of-service', statutoryApplies: true });
    const r = resolveStatutoryEligibility(contractorEmp, [c]);
    expect(r).toMatchObject({ epf: true, socso: true, eis: true, source: 'auto' });
    expect(r.autoBasis).toContain('ASM-CT-2025-001');
  });

  it('contract linked to a DIFFERENT employee is ignored', () => {
    const c = makeContract({ employeeId: 'someone-else' });
    const r = resolveStatutoryEligibility(contractorEmp, [c]);
    expect(r).toMatchObject({ epf: true, socso: true, eis: true });
  });

  it('age 60+ citizen → applicable with an age edge note (rates stay downstream)', () => {
    const senior = { ...baseEmp, dateOfBirth: '1960-06-15' };
    const r = resolveStatutoryEligibility(senior, [], new Date('2025-03-28T00:00:00'));
    expect(r).toMatchObject({ epf: true, socso: true, eis: true });
    expect(r.reasons.join(' ')).toContain('Age 60+');
  });

  it('age 75+ → applicable with a nil-EPF note', () => {
    const senior = { ...baseEmp, dateOfBirth: '1948-06-15' };
    const r = resolveStatutoryEligibility(senior, [], new Date('2025-03-28T00:00:00'));
    expect(r.epf).toBe(true);
    expect(r.reasons.join(' ')).toContain('Age 75+');
  });

  it('foreign worker → applicable with the 2%/2% note (EIS exempt stays downstream)', () => {
    const r = resolveStatutoryEligibility({ ...baseEmp, isForeignWorker: true }, []);
    expect(r).toMatchObject({ epf: true, socso: true, eis: true });
    expect(r.reasons.join(' ')).toContain('2% employee + 2% employer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolver — employer override
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveStatutoryEligibility — employer override', () => {
  it('epfApplicable=false on a regular employee → EPF off, SOCSO/EIS untouched', () => {
    const r = resolveStatutoryEligibility({ ...baseEmp, epfApplicable: false }, []);
    expect(r).toMatchObject({ epf: false, socso: true, eis: true, source: 'override' });
    expect(r.epfReason).toBe('EPF not applicable — employer override (employee record)');
    expect(r.socsoReason).toBeUndefined();
  });

  it('socsoApplicable=false → SOCSO and EIS off (EIS follows SOCSO), EPF untouched', () => {
    const r = resolveStatutoryEligibility({ ...baseEmp, socsoApplicable: false }, []);
    expect(r).toMatchObject({ epf: true, socso: false, eis: false, source: 'override' });
    expect(r.socsoReason).toBe('SOCSO not applicable — employer override (employee record)');
    expect(r.eisReason).toBe('EIS not applicable — employer override (employee record)');
  });

  it('override WINS over the auto rule: for-service contractor forced applicable', () => {
    const r = resolveStatutoryEligibility(
      { ...contractorEmp, epfApplicable: true, socsoApplicable: true },
      [makeContract({})],
    );
    expect(r).toMatchObject({ epf: true, socso: true, eis: true, source: 'override' });
    expect(r.epfReason).toBeUndefined();
    expect(r.reasons.join(' ')).toContain('employer override');
  });

  it('mixed override: EPF forced ON over a for-service contract, SOCSO stays auto-OFF', () => {
    const r = resolveStatutoryEligibility(
      { ...contractorEmp, epfApplicable: true },
      [makeContract({})],
    );
    expect(r).toMatchObject({ epf: true, socso: false, eis: false, source: 'override' });
  });

  it('null / undefined flags = AUTO (backward compatible)', () => {
    expect(resolveStatutoryEligibility({ ...baseEmp, epfApplicable: null, socsoApplicable: null }, []).source).toBe('auto');
    expect(resolveStatutoryEligibility({ ...baseEmp, epfApplicable: undefined }, []).source).toBe('auto');
    const r = resolveStatutoryEligibility({ ...contractorEmp, epfApplicable: null }, [makeContract({})]);
    expect(r).toMatchObject({ epf: false, source: 'auto' });
  });

  it('tri-state mapping helpers round-trip (auto persists as null)', () => {
    expect(applicabilityToTriState(true)).toBe('yes');
    expect(applicabilityToTriState(false)).toBe('no');
    expect(applicabilityToTriState(null)).toBe('auto');
    expect(applicabilityToTriState(undefined)).toBe('auto');
    expect(triStateToApplicability('yes')).toBe(true);
    expect(triStateToApplicability('no')).toBe(false);
    expect(triStateToApplicability('auto')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Engine integration — zeroing, payslip lines, recorded fields
// ─────────────────────────────────────────────────────────────────────────────

describe('payrollEngine — statutory applicability', () => {
  it('AUTO: employee linked to an active for-service contract → both shares 0 + info lines', () => {
    setCollection(CONTRACTS_COLLECTION, [makeContract({})]);
    const { payslips } = runPayroll(MONTH, ['emp-c']);
    const p = slipFor(payslips, 'emp-c');

    expect(p.epfEmployee).toBe(0);
    expect(p.epfEmployer).toBe(0);
    expect(p.socsoEmployee).toBe(0);
    expect(p.socsoEmployer).toBe(0);
    expect(p.eisEmployee).toBe(0);
    expect(p.eisEmployer).toBe(0);

    // Resolution is recorded on the payslip (auto source).
    expect(p.epfApplicable).toBe(false);
    expect(p.socsoApplicable).toBe(false);
    expect(p.eisApplicable).toBe(false);
    expect(p.statutoryApplicabilitySource).toBe('auto');
    expect(p.statutoryApplicabilityReasons?.join(' ')).toContain('ASM-CT-2025-001');

    // Payslip info lines name the reason; no EPF/SOCSO/EIS deduction or
    // employer lines exist for the not-applicable schemes.
    const info = p.lines.filter((l) => l.kind === 'info').map((l) => l.label);
    expect(info).toContain('EPF not applicable — contract for service');
    expect(info).toContain('SOCSO not applicable — contract for service');
    expect(info).toContain('EIS not applicable — contract for service');
    expect(p.lines.some((l) => l.label.startsWith('EPF employee'))).toBe(false);
    expect(p.lines.some((l) => l.label.startsWith('EPF employer'))).toBe(false);
    expect(p.lines.some((l) => l.label.startsWith('SOCSO employer'))).toBe(false);

    // Net = gross − PCB only (PCB still applies); employer cost = gross + HRD.
    expect(p.netPay).toBe(round2(p.grossPay - p.pcb));
    expect(p.employerCost).toBe(round2(p.grossPay + p.hrdLevy));
  });

  it('OVERRIDE: epfApplicable=false zeroes EPF only; SOCSO/EIS computed', () => {
    setCollection<Employee>('employees', [{ ...baseEmp, epfApplicable: false }]);
    const { payslips } = runPayroll(MONTH);
    const p = slipFor(payslips, 'emp-1');

    expect(p.epfEmployee).toBe(0);
    expect(p.epfEmployer).toBe(0);
    const socso = calcSOCSO(3200, 35);
    const eis = calcEIS(3200, 35, true);
    expect(p.socsoEmployee).toBe(socso.employee);
    expect(p.eisEmployee).toBe(eis.employee);

    expect(p.epfApplicable).toBe(false);
    expect(p.socsoApplicable).toBe(true);
    expect(p.eisApplicable).toBe(true);
    expect(p.statutoryApplicabilitySource).toBe('override');
    const info = p.lines.filter((l) => l.kind === 'info').map((l) => l.label);
    expect(info).toContain('EPF not applicable — employer override (employee record)');
    expect(p.netPay).toBe(round2(p.grossPay - p.socsoEmployee - p.eisEmployee - p.pcb));
  });

  it('OVERRIDE: socsoApplicable=false zeroes SOCSO + EIS, EPF computed', () => {
    setCollection<Employee>('employees', [{ ...baseEmp, socsoApplicable: false }]);
    const { payslips } = runPayroll(MONTH);
    const p = slipFor(payslips, 'emp-1');

    const epf = calcEPF(3200, 35, true, false);
    expect(p.epfEmployee).toBe(epf.employee);
    expect(p.epfEmployer).toBe(epf.employer);
    expect(p.socsoEmployee).toBe(0);
    expect(p.socsoEmployer).toBe(0);
    expect(p.eisEmployee).toBe(0);
    expect(p.eisEmployer).toBe(0);
    expect(p.eisApplicable).toBe(false);
    const info = p.lines.filter((l) => l.kind === 'info').map((l) => l.label);
    expect(info).toContain('SOCSO not applicable — employer override (employee record)');
    expect(info).toContain('EIS not applicable — employer override (employee record)');
  });

  it('OVERRIDE wins: for-service contractor forced applicable → contributions computed', () => {
    setCollection(CONTRACTS_COLLECTION, [makeContract({})]);
    setCollection<Employee>('employees', [
      { ...contractorEmp, epfApplicable: true, socsoApplicable: true },
    ]);
    const { payslips } = runPayroll(MONTH, ['emp-c']);
    const p = slipFor(payslips, 'emp-c');

    const epf = calcEPF(4000, 35, true, false);
    const socso = calcSOCSO(4000, 35);
    expect(p.epfEmployee).toBe(epf.employee);
    expect(p.epfEmployer).toBe(epf.employer);
    expect(p.socsoEmployee).toBe(socso.employee);
    expect(p.socsoEmployer).toBe(socso.employer);
    expect(p.epfApplicable).toBe(true);
    expect(p.statutoryApplicabilitySource).toBe('override');
  });

  it('standing rule beats per-run opt-out bookkeeping: not applicable is not an opt-out', () => {
    setCollection(CONTRACTS_COLLECTION, [makeContract({})]);
    const { payslips } = runPayroll(MONTH, ['emp-c']);
    const p = slipFor(payslips, 'emp-c');
    // Not-applicable schemes never set the per-run opt-out flags.
    expect(p.excludeEpf).toBeUndefined();
    expect(p.excludeSocso).toBeUndefined();
    expect(p.excludeEis).toBeUndefined();
    expect(p.optOutReasons).toBeUndefined();
  });

  it('BACKWARD COMPAT: employee without flags or contracts → legacy figures, no new fields', () => {
    const { payslips } = runPayroll(MONTH, ['emp-1']);
    const p = slipFor(payslips, 'emp-1');

    const epf = calcEPF(3200, 35, true, false);
    const socso = calcSOCSO(3200, 35);
    const eis = calcEIS(3200, 35, true);
    expect(p.epfEmployee).toBe(epf.employee);
    expect(p.epfEmployer).toBe(epf.employer);
    expect(p.socsoEmployee).toBe(socso.employee);
    expect(p.eisEmployee).toBe(eis.employee);

    // No applicability fields recorded — payslip shape is exactly the legacy one.
    expect(p.epfApplicable).toBeUndefined();
    expect(p.socsoApplicable).toBeUndefined();
    expect(p.eisApplicable).toBeUndefined();
    expect(p.statutoryApplicabilitySource).toBeUndefined();
    expect(p.statutoryApplicabilityReasons).toBeUndefined();

    // Legacy deduction/employer lines, no applicability info lines.
    expect(p.lines.some((l) => l.label.startsWith('EPF employee (11%)'))).toBe(true);
    expect(p.lines.some((l) => l.label.startsWith('EPF employer (13%)'))).toBe(true);
    expect(p.lines.some((l) => l.kind === 'info' && l.label.includes('not applicable'))).toBe(false);
  });

  it('GL journal stays balanced with zeroed contributions (detailed mode)', () => {
    setCollection(CONTRACTS_COLLECTION, [makeContract({})]);
    const { run } = runPayroll(MONTH); // both employees; run finalized by default

    const journal = buildGLJournal(run.id, { mode: 'detailed' });
    expect(journal.balanced).toBe(true);
    expect(journal.debitTotal).toBe(journal.creditTotal);
    expect(journal.lines.length).toBeGreaterThan(0);

    // The contractor contributes no EPF/SOCSO/EIS lines at all.
    const contractorLines = journal.lines.filter((l) => l.employeeId === 'emp-c');
    expect(contractorLines.length).toBeGreaterThan(0); // wages + net pay still post
    for (const t of ['epfEmployerExpense', 'socsoEmployerExpense', 'eisEmployerExpense', 'epfPayable', 'socsoPayable', 'eisPayable'] as const) {
      expect(contractorLines.some((l) => l.type === t)).toBe(false);
    }
    // The regular employee still posts every statutory line.
    const regularLines = journal.lines.filter((l) => l.employeeId === 'emp-1');
    for (const t of ['epfEmployerExpense', 'socsoEmployerExpense', 'eisEmployerExpense', 'epfPayable', 'socsoPayable', 'eisPayable'] as const) {
      expect(regularLines.some((l) => l.type === t)).toBe(true);
    }
  });

  it('GL summary mode also balances and reflects only the applicable shares', () => {
    setCollection(CONTRACTS_COLLECTION, [makeContract({})]);
    const { run } = runPayroll(MONTH);
    const journal = buildGLJournal(run.id); // summary
    expect(journal.balanced).toBe(true);
    const slips = getCollection<Payslip>('payslips').filter((p) => p.runId === run.id);
    const epfPayable = round2(slips.reduce((s, p) => s + p.epfEmployee + p.epfEmployer, 0));
    const line = journal.lines.find((l) => l.type === 'epfPayable');
    expect(line?.credit ?? 0).toBe(epfPayable);
  });
});
