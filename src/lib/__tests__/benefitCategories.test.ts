/**
 * BIK categories tests (BIK wave).
 *
 * Covers:
 *  - per-tenant default-catalog seeding on first access (9 statutory
 *    defaults, deterministic bcat-* ids), idempotency, tenant isolation;
 *  - category CRUD: custom create with per-kind auto-suggested advice,
 *    edit, deactivate (keeps the record; assignments still resolve),
 *    validation;
 *  - benefit assignments carrying categoryId: category-driven defaults
 *    (name/treatment from the category), preset → category auto-fill,
 *    unknown-category rejection, update/clear;
 *  - employer-level benefitSummary math (active count + monthly cost by
 *    treatment, annual frequency honoured);
 *  - EA s.13(1)(b) aggregation (eaBikTotals): per-item annual totals from
 *    non-cash-bik benefits + editor non-cash lines, exclusions, and the
 *    end-to-end payslip path after real payroll runs;
 *  - treatment → wage-base integration for category-driven assignments
 *    (taxable allowance joins all bases; non-cash BIK feeds PCB only) —
 *    the engine itself is untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { getCollection, saveCompanies, setActiveTenantId, setCollection } from '../db';
import { runPayroll } from '../payrollEngine';
import {
  BENEFIT_CATEGORIES_COLLECTION, DEFAULT_BENEFIT_CATEGORIES, activeBenefitCategories,
  benefitCategory, benefitSummary, createBenefit, createBenefitCategory, deleteBenefitCategory,
  eaBikTotals,
  getBenefitCategories, getBenefits, suggestCategoryAdvice, updateBenefit, updateBenefitCategory,
  type BenefitCategory,
} from '../benefits';
import { round2 } from '../utils';
import type { AuditLog, Company, Employee, Payslip } from '../types';

const MONTH = '2025-03';
const CO_A = 'co-asm';
const CO_B = 'co-merdeka';

const testCompany: Company = {
  id: CO_A,
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

function seedAll(): void {
  saveCompanies([testCompany]);
  setCollection('employees', [emp1]);
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
  setActiveTenantId(CO_A);
  seedAll();
});

function slipOf(result: { payslips: Payslip[] } | Payslip[], employeeId = emp1.id): Payslip {
  const list = Array.isArray(result) ? result : result.payslips;
  const p = list.find((s) => s.employeeId === employeeId);
  if (!p) throw new Error(`no payslip for ${employeeId}`);
  return p;
}

/** Minimal stored-payslip shape for pure eaBikTotals math tests. */
function fakeSlip(monthKey: string, extras: Partial<Payslip>): Payslip {
  return {
    id: `p-${monthKey}`,
    runId: 'run-x',
    employeeId: emp1.id,
    monthKey,
    basicPay: 3000,
    unpaidLeaveDeduction: 0,
    otPay: 0,
    otHours: 0,
    allowances: 0,
    claimsTotal: 0,
    grossPay: 3000,
    epfEmployee: 330,
    epfEmployer: 390,
    socsoEmployee: 0,
    socsoEmployer: 0,
    socsoCategory: 1,
    eisEmployee: 0,
    eisEmployer: 0,
    pcb: 0,
    hrdLevy: 0,
    netPay: 2670,
    employerCost: 3390,
    lines: [],
    ytd: { gross: 0, epf: 0, socso: 0, pcb: 0, net: 0 },
    ...extras,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default-catalog seeding
// ─────────────────────────────────────────────────────────────────────────────

describe('category seeding — per tenant, on first access', () => {
  it('seeds the 9 statutory-default categories with deterministic ids', () => {
    expect(getCollection(BENEFIT_CATEGORIES_COLLECTION)).toHaveLength(0);
    const cats = getBenefitCategories();
    expect(cats).toHaveLength(9);
    expect(getCollection(BENEFIT_CATEGORIES_COLLECTION)).toHaveLength(9);
    const byId = new Map(cats.map((c) => [c.id, c]));
    expect(byId.get('bcat-medical')).toMatchObject({
      name: 'Medical Insurance', kind: 'medical', defaultTreatment: 'non-cash-bik',
      custom: false, active: true,
    });
    expect(byId.get('bcat-parking')).toMatchObject({
      name: 'Parking Allowance', kind: 'parking', defaultTreatment: 'taxable-allowance',
    });
    expect(byId.get('bcat-childcare')).toMatchObject({
      name: 'Childcare Subsidy', kind: 'other', defaultTreatment: 'taxable-allowance',
    });
    expect(byId.get('bcat-vehicle')).toMatchObject({
      name: 'Company Vehicle', kind: 'vehicle', defaultTreatment: 'non-cash-bik',
    });
    expect(byId.get('bcat-housing')).toMatchObject({ kind: 'housing' });
    expect(byId.get('bcat-education')).toMatchObject({ kind: 'education' });
    expect(byId.get('bcat-group-insurance')).toMatchObject({ kind: 'insurance' });
    expect(byId.get('bcat-wellness')).toMatchObject({ kind: 'wellness' });
    expect(byId.get('bcat-membership')).toMatchObject({ kind: 'membership' });
    // Every seeded category carries both advisory notes.
    for (const c of cats) {
      expect(c.pcbNote.length).toBeGreaterThan(0);
      expect(c.epfNote.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent: re-access never duplicates, custom rows survive', () => {
    const first = getBenefitCategories();
    const second = getBenefitCategories();
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
    createBenefitCategory({ name: 'Mobile Phone Subsidy', kind: 'other' }, 'hr');
    const third = getBenefitCategories();
    expect(third).toHaveLength(10);
    expect(third.filter((c) => !c.custom)).toHaveLength(9);
    // Seed never re-fires while rows exist.
    getBenefitCategories();
    expect(getCollection<BenefitCategory>(BENEFIT_CATEGORIES_COLLECTION)).toHaveLength(10);
  });

  it('is tenant-isolated: each tenant gets its own catalog', () => {
    getBenefitCategories();
    createBenefitCategory({ name: 'A-Only Category', kind: 'wellness' }, 'hr');
    expect(getBenefitCategories()).toHaveLength(10);

    setActiveTenantId(CO_B);
    const bCats = getBenefitCategories();
    expect(bCats).toHaveLength(9); // fresh defaults, not A's rows
    expect(bCats.some((c) => c.name === 'A-Only Category')).toBe(false);
    createBenefitCategory({ name: 'B-Only Category', kind: 'education' }, 'hr');

    setActiveTenantId(CO_A);
    const aCats = getBenefitCategories();
    expect(aCats).toHaveLength(10);
    expect(aCats.some((c) => c.name === 'A-Only Category')).toBe(true);
    expect(aCats.some((c) => c.name === 'B-Only Category')).toBe(false);
  });

  it('suggestCategoryAdvice encodes the per-kind defaults', () => {
    expect(suggestCategoryAdvice('parking').defaultTreatment).toBe('taxable-allowance');
    expect(suggestCategoryAdvice('medical').defaultTreatment).toBe('non-cash-bik');
    expect(suggestCategoryAdvice('vehicle').defaultTreatment).toBe('non-cash-bik');
    expect(suggestCategoryAdvice('other').defaultTreatment).toBe('non-cash-bik');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Category CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe('category CRUD', () => {
  it('creates a custom category with per-kind auto-suggested advice', () => {
    const c = createBenefitCategory({ name: 'Mobile Phone Subsidy', kind: 'other' }, 'hr');
    expect(c.custom).toBe(true);
    expect(c.active).toBe(true);
    expect(c.defaultTreatment).toBe('non-cash-bik');
    expect(c.pcbNote).toBe(suggestCategoryAdvice('other').pcbNote);
    expect(c.epfNote).toBe(suggestCategoryAdvice('other').epfNote);
    expect(benefitCategory(c.id)?.name).toBe('Mobile Phone Subsidy');
  });

  it('uses the kind default treatment unless overridden', () => {
    const parking = createBenefitCategory({ name: 'Site Parking', kind: 'parking' }, 'hr');
    expect(parking.defaultTreatment).toBe('taxable-allowance');
    const custom = createBenefitCategory(
      { name: 'Parking Reimbursement', kind: 'parking', defaultTreatment: 'nonStatutory-reimbursement' },
      'hr',
    );
    expect(custom.defaultTreatment).toBe('nonStatutory-reimbursement');
  });

  it('validates: name required, kind must be known', () => {
    expect(() => createBenefitCategory({ name: '  ', kind: 'other' }, 'hr')).toThrow(/name is required/);
    expect(() =>
      createBenefitCategory({ name: 'X', kind: 'bogus' as BenefitCategory['kind'] }, 'hr'),
    ).toThrow(/Unknown benefit category kind/);
    expect(updateBenefitCategory('no-such-id', { name: 'X' }, 'hr')).toBeNull();
  });

  it('edits fields and deactivates/reactivates without deleting the record', () => {
    const updated = updateBenefitCategory(
      'bcat-wellness',
      { name: 'Gym & Wellness', defaultTreatment: 'taxable-allowance' },
      'hr',
    )!;
    expect(updated.name).toBe('Gym & Wellness');
    expect(updated.defaultTreatment).toBe('taxable-allowance');

    const off = updateBenefitCategory('bcat-wellness', { active: false }, 'hr')!;
    expect(off.active).toBe(false);
    // Record still resolves (existing assignments keep working) but leaves
    // the active picker.
    expect(benefitCategory('bcat-wellness')?.name).toBe('Gym & Wellness');
    expect(activeBenefitCategories().some((c) => c.id === 'bcat-wellness')).toBe(false);

    const on = updateBenefitCategory('bcat-wellness', { active: true }, 'hr')!;
    expect(on.active).toBe(true);
    expect(getBenefitCategories()).toHaveLength(DEFAULT_BENEFIT_CATEGORIES.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Assignments with categories
// ─────────────────────────────────────────────────────────────────────────────

describe('benefit assignments with categoryId', () => {
  it('defaults name and treatment from the category for custom keys', () => {
    const b = createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: 'bcat-parking',
        amount: 250, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    );
    expect(b.categoryId).toBe('bcat-parking');
    expect(b.name).toBe('Parking Allowance');
    expect(b.treatment).toBe('taxable-allowance');
  });

  it('explicit name/treatment override the category defaults', () => {
    const b = createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: 'bcat-parking',
        name: 'Parking (receipts)', treatment: 'nonStatutory-reimbursement',
        amount: 120, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    );
    expect(b.name).toBe('Parking (receipts)');
    expect(b.treatment).toBe('nonStatutory-reimbursement');
  });

  it('auto-fills the category from the preset mapping', () => {
    const b = createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'health-insurance',
        amount: 150, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    );
    expect(b.categoryId).toBe('bcat-medical');
    expect(b.name).toBe('Personal Health Insurance'); // preset label still wins
    expect(b.treatment).toBe('nonStatutory-reimbursement'); // preset treatment wins
  });

  it('rejects unknown category ids; update can change or clear the category', () => {
    expect(() =>
      createBenefit(
        {
          employeeId: emp1.id, benefitKey: 'custom', categoryId: 'bcat-nope',
          amount: 10, frequency: 'monthly', startMonth: '2025-01',
        },
        'hr',
      ),
    ).toThrow(/Unknown benefit category/);

    const b = createBenefit(
      { employeeId: emp1.id, benefitKey: 'gym-wellness', amount: 80, frequency: 'monthly', startMonth: '2025-01' },
      'hr',
    );
    expect(b.categoryId).toBe('bcat-wellness');
    const moved = updateBenefit(b.id, { categoryId: 'bcat-medical' }, 'hr')!;
    expect(moved.categoryId).toBe('bcat-medical');
    const cleared = updateBenefit(b.id, { categoryId: '' }, 'hr')!;
    expect(cleared.categoryId).toBeUndefined();
  });

  it('assignments on deactivated categories still resolve their category', () => {
    const b = createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: 'bcat-housing',
        amount: 800, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    );
    updateBenefitCategory('bcat-housing', { active: false }, 'hr');
    expect(benefitCategory(b.categoryId)?.name).toBe('Housing Benefit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Employer-level summary strip
// ─────────────────────────────────────────────────────────────────────────────

describe('benefitSummary — active count & monthly cost by treatment', () => {
  it('splits the month injection by treatment and honours frequency/window', () => {
    createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: 'bcat-medical',
        amount: 200, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    ); // non-cash-bik monthly
    createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: 'bcat-parking',
        amount: 150, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    ); // taxable-allowance monthly
    createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'health-insurance',
        amount: 100, frequency: 'annual', annualMonth: 3, startMonth: '2025-01',
      },
      'hr',
    ); // reimbursement, March only
    const ended = createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: 'bcat-vehicle',
        amount: 500, frequency: 'monthly', startMonth: '2025-01', endMonth: '2025-02',
      },
      'hr',
    );
    expect(ended.status).toBe('active');

    const mar = benefitSummary(MONTH);
    expect(mar.activeCount).toBe(4); // window-expired still counts as active status
    expect(mar.injectableCount).toBe(3); // vehicle ended 2025-02
    expect(mar.byTreatment['non-cash-bik']).toBe(200);
    expect(mar.byTreatment['taxable-allowance']).toBe(150);
    expect(mar.byTreatment['nonStatutory-reimbursement']).toBe(100);
    expect(mar.totalMonth).toBe(450);

    const apr = benefitSummary('2025-04');
    expect(apr.injectableCount).toBe(2); // annual reimbursement skips April
    expect(apr.byTreatment['nonStatutory-reimbursement']).toBe(0);
    expect(apr.totalMonth).toBe(350);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EA s.13(1)(b) aggregation
// ─────────────────────────────────────────────────────────────────────────────

describe('eaBikTotals — EA s.13(1)(b) math', () => {
  it('aggregates non-cash-bik benefits per item; excludes other treatments', () => {
    const slips = [
      fakeSlip('2025-01', {
        benefits: [
          { benefitId: 'b1', name: 'Group Insurance Premium', amount: 200, treatment: 'non-cash-bik' },
          { benefitId: 'b2', name: 'Personal Health Insurance', amount: 150, treatment: 'nonStatutory-reimbursement' },
          { benefitId: 'b3', name: 'Parking Allowance', amount: 250, treatment: 'taxable-allowance' },
        ],
      }),
      fakeSlip('2025-02', {
        benefits: [
          { benefitId: 'b1', name: 'Group Insurance Premium', amount: 200, treatment: 'non-cash-bik' },
        ],
      }),
      fakeSlip('2025-03', {
        benefits: [
          { benefitId: 'b4', name: 'Company Vehicle', amount: 900, treatment: 'non-cash-bik' },
        ],
      }),
    ];
    const bik = eaBikTotals(slips);
    expect(bik.total).toBe(1300);
    expect(bik.items).toEqual([
      { name: 'Company Vehicle', total: 900, months: 1 },
      { name: 'Group Insurance Premium', total: 400, months: 2 },
    ]);
  });

  it('includes editor non-cash earning lines and skips invalid amounts', () => {
    const slips = [
      fakeSlip('2025-06', {
        adjustments: [
          { id: 'a1', kind: 'earning', preset: 'custom', label: 'BIK / VOLA (non-cash)', amount: 500, nonCash: true },
          { id: 'a2', kind: 'earning', preset: 'custom', label: 'Bonus', amount: 100 }, // cash — excluded
          { id: 'a3', kind: 'deduction', preset: 'custom', label: 'CP38', amount: 50 }, // deduction — excluded
        ],
        benefits: [
          { benefitId: 'b1', name: 'Group Insurance Premium', amount: 0, treatment: 'non-cash-bik' },
        ],
      }),
    ];
    const bik = eaBikTotals(slips);
    expect(bik.items).toEqual([{ name: 'BIK / VOLA (non-cash)', total: 500, months: 1 }]);
    expect(bik.total).toBe(500);
  });

  it('empty input yields an empty section', () => {
    expect(eaBikTotals([])).toEqual({ items: [], total: 0 });
    expect(eaBikTotals([fakeSlip('2025-01', {})])).toEqual({ items: [], total: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Engine integration — category-driven assignments & EA totals from payslips
// ─────────────────────────────────────────────────────────────────────────────

describe('payroll integration — category-driven treatment → wage bases', () => {
  it('taxable-allowance category joins gross and every statutory base', () => {
    const base = slipOf(runPayroll(MONTH));
    createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: 'bcat-parking',
        amount: 250, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    );
    const p = slipOf(runPayroll(MONTH));
    expect(p.benefitWages).toBe(250);
    expect(p.grossPay).toBe(round2(base.grossPay + 250));
    expect(p.epfBase).toBe(round2(base.epfBase! + 250));
    expect(p.socsoBase).toBe(round2(base.socsoBase! + 250));
    expect(p.eisBase).toBe(round2(base.eisBase! + 250));
    expect(p.pcbBase).toBe(round2(base.pcbBase! + 250));
    expect(p.benefits![0]).toMatchObject({ name: 'Parking Allowance', treatment: 'taxable-allowance' });
  });

  it('non-cash-bik category feeds the PCB base only, then aggregates on the EA path', () => {
    const base = slipOf(runPayroll('2025-01'));
    createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: 'bcat-medical',
        amount: 180, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    );
    const jan = slipOf(runPayroll('2025-01'));
    expect(jan.benefitNonCash).toBe(180);
    expect(jan.grossPay).toBe(base.grossPay);
    expect(jan.epfBase).toBe(base.epfBase);
    expect(jan.socsoBase).toBe(base.socsoBase);
    expect(jan.pcbBase).toBe(round2(base.pcbBase! + 180));

    slipOf(runPayroll('2025-02'));
    // End-to-end: the EA aggregation reads the stored payslips.
    const yearSlips = getCollection<Payslip>('payslips').filter(
      (p) => p.employeeId === emp1.id && p.monthKey.startsWith('2025'),
    );
    const bik = eaBikTotals(yearSlips);
    expect(bik.items).toEqual([{ name: 'Medical Insurance', total: 360, months: 2 }]);
    expect(bik.total).toBe(360);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom-category hard delete (guarded)
// ─────────────────────────────────────────────────────────────────────────────

describe('deleteBenefitCategory — custom-category hard delete', () => {
  it('deletes an unreferenced custom category and audits it', () => {
    const c = createBenefitCategory({ name: 'Mobile Phone Subsidy', kind: 'other' }, 'hr');
    expect(deleteBenefitCategory(c.id, 'hr')).toBe(true);
    expect(benefitCategory(c.id)).toBeUndefined();
    // Seeded defaults are untouched.
    expect(getBenefitCategories()).toHaveLength(DEFAULT_BENEFIT_CATEGORIES.length);
    const audit = getCollection<AuditLog>('audit').find((e) => e.action === 'benefitCategories.delete');
    expect(audit?.entityId).toBe(c.id);
    expect(audit?.actorName).toBe('hr');
  });

  it('blocks deletion while ANY assignment references the category', () => {
    const c = createBenefitCategory({ name: 'Mobile Phone Subsidy', kind: 'other' }, 'hr');
    createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: c.id,
        amount: 100, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    );
    expect(() => deleteBenefitCategory(c.id, 'hr')).toThrow(/used by 1 benefit assignment/);
    // The category survives — the offered alternative is deactivation.
    expect(benefitCategory(c.id)?.active).toBe(true);
    const off = updateBenefitCategory(c.id, { active: false }, 'hr')!;
    expect(off.active).toBe(false);
  });

  it('seeded statutory defaults cannot be deleted — deactivate instead', () => {
    expect(() => deleteBenefitCategory('bcat-medical', 'hr')).toThrow(/statutory default/);
    expect(benefitCategory('bcat-medical')).toBeDefined();
    expect(deleteBenefitCategory('bcat-nope', 'hr')).toBe(false);
  });

  it("edit with name '' reverts a custom benefit to its category name", () => {
    const c = createBenefitCategory({ name: 'Mobile Phone Subsidy', kind: 'other' }, 'hr');
    const b = createBenefit(
      {
        employeeId: emp1.id, benefitKey: 'custom', categoryId: c.id, name: 'Phone (director)',
        amount: 100, frequency: 'monthly', startMonth: '2025-01',
      },
      'hr',
    );
    const cleared = updateBenefit(b.id, { name: '' }, 'hr')!;
    expect(cleared.name).toBe('Mobile Phone Subsidy');
    expect(getBenefits()[0].name).toBe('Mobile Phone Subsidy');
  });
});
