/**
 * Config-teeth tests (P1): previously dead/bypassed Company.config fields now
 * drive real behaviour —
 *  - numberFormats.payslipPrefix → human payslip refNo per run
 *  - payrollCutoffDay            → run window; after-cut-off OT/claims defer
 *  - workingWeek                 → tenant rest-day override (workdays/leave)
 *  - leaveTopUps                 → single read path via appSettings
 *  - Company.status 'suspended'  → login blocked (SuperAdmin unaffected)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import {
  getCollection, saveCompanies, setActiveTenantId, setCollection,
} from '../db';
import {
  payrollPeriodFor, runPayroll, setPayslipAdjustments,
} from '../payrollEngine';
import {
  getLeaveTopUps, getPayslipPrefix, isRestDay, resolveWorkingWeek,
} from '../appSettings';
import { isWeekend } from '../holidays';
import { workingDaysInMonth } from '../workdays';
import { eaEntitlements, leaveTopUps } from '../../pages/leave/leaveLogic';
import { getSession, login, logout } from '../auth';
import type {
  AttendanceRecord, Claim, Company, CompanyStatus, Employee, WorkingWeek,
} from '../types';

const CO = 'co-asm';

function mkCompany(over: {
  id?: string;
  code?: string;
  status?: CompanyStatus;
  workingWeek?: WorkingWeek;
  cutoffDay?: number;
  payslipPrefix?: string | null;
  leaveTopUps?: Company['config']['leaveTopUps'];
} = {}): Company {
  return {
    id: over.id ?? CO,
    code: over.code ?? 'ASM',
    name: 'ASM Tech Sdn Bhd',
    regNo: '202401000001',
    hqState: 'KUL',
    status: over.status ?? 'active',
    plan: 'pro',
    createdAt: '2025-01-01T00:00:00.000Z',
    branding: { logoText: over.code ?? 'ASM', accentColor: '#b45309' },
    config: {
      workingWeek: over.workingWeek ?? 'sat-sun',
      payrollCutoffDay: over.cutoffDay ?? 25,
      claimPolicy: {},
      leaveTopUps: over.leaveTopUps ?? {},
      enabledModules: ['payroll', 'leave', 'attendance', 'claims'],
      customFields: [],
      numberFormats: {
        employeeIdPrefix: over.code ?? 'ASM',
        // null simulates a legacy company record missing the prefix.
        payslipPrefix: over.payslipPrefix === null ? (undefined as never) : (over.payslipPrefix ?? 'ASM-PS'),
      },
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
    ...over,
  };
}

function seedPayroll(company: Company, employees: Employee[], extra?: {
  attendance?: AttendanceRecord[];
  claims?: Claim[];
}): void {
  saveCompanies([company]);
  setActiveTenantId(company.id);
  setCollection('employees', employees);
  setCollection('attendance', extra?.attendance ?? []);
  setCollection('leaves', []);
  setCollection('claims', extra?.claims ?? []);
  setCollection('payrollRuns', []);
  setCollection('payslips', []);
  setCollection('audit', []);
}

beforeEach(() => {
  installLocalStorage();
  logout();
});

// ─────────────────────────────────────────────────────────────────────────────
// payrollCutoffDay — run window + deferral
// ─────────────────────────────────────────────────────────────────────────────

describe('payrollPeriodFor — cut-off windows', () => {
  it('cut-off 25: March covers 26 Feb → 25 Mar', () => {
    expect(payrollPeriodFor('2025-03', 25)).toEqual({
      start: '2025-02-26',
      end: '2025-03-25',
      cutoffDay: 25,
    });
  });

  it('January wraps into December of the previous year', () => {
    expect(payrollPeriodFor('2025-01', 25)).toEqual({
      start: '2024-12-26',
      end: '2025-01-25',
      cutoffDay: 25,
    });
  });

  it('short February: day after a 28-day-month cut-off is the 1st', () => {
    // Feb 2025 has 28 days; cut-off 28 → next window starts 1 Mar.
    expect(payrollPeriodFor('2025-03', 28)).toEqual({
      start: '2025-03-01',
      end: '2025-03-28',
      cutoffDay: 28,
    });
  });
});

describe('runPayroll — payrollCutoffDay deferral', () => {
  const attendance: AttendanceRecord[] = [
    { id: 'att-in', employeeId: 'emp-1', date: '2025-03-20', status: 'present', otHours: 4, otDayType: 'normal', otApproved: true },
    { id: 'att-late', employeeId: 'emp-1', date: '2025-03-27', status: 'present', otHours: 3, otDayType: 'normal', otApproved: true },
  ];
  const claims: Claim[] = [
    { id: 'clm-in', employeeId: 'emp-1', category: 'travel', title: 'In window', amount: 45.5, claimDate: '2025-03-05', status: 'approved' },
    { id: 'clm-late', employeeId: 'emp-1', category: 'meal', title: 'After cut-off', amount: 100, claimDate: '2025-03-27', status: 'approved' },
  ];

  it('pays only OT/claims dated on/before the cut-off; records the cut-off on the run', () => {
    seedPayroll(mkCompany({ cutoffDay: 25 }), [mkEmp('emp-1')], { attendance, claims });
    const { run, payslips } = runPayroll('2025-03');
    const p = payslips[0]!;
    expect(run.cutoffDay).toBe(25);
    expect(p.otHours).toBe(4);           // 27 Mar OT deferred
    expect(p.claimsTotal).toBe(45.5);    // 27 Mar claim deferred
    // In-window claim stamped paid by the (finalized) run; late claim untouched.
    const stored = getCollection<Claim>('claims');
    expect(stored.find((c) => c.id === 'clm-in')!.status).toBe('paid');
    const late = stored.find((c) => c.id === 'clm-late')!;
    expect(late.status).toBe('approved');
    expect(late.paidInRunId).toBeUndefined();
  });

  it("deferred items roll into the NEXT month's run, which stamps them paid", () => {
    seedPayroll(mkCompany({ cutoffDay: 25 }), [mkEmp('emp-1')], { attendance, claims });
    runPayroll('2025-03');
    const april = runPayroll('2025-04');
    const p = april.payslips[0]!;
    expect(p.otHours).toBe(3);          // 27 Mar OT lands in April's window
    expect(p.claimsTotal).toBe(100);    // 27 Mar claim reimbursed in April
    const late = getCollection<Claim>('claims').find((c) => c.id === 'clm-late')!;
    expect(late.status).toBe('paid');
    expect(late.paidInRunId).toBe(april.run.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// numberFormats.payslipPrefix — human payslip refNo
// ─────────────────────────────────────────────────────────────────────────────

describe('payslip refNo (payslipPrefix consumer)', () => {
  it('assigns <prefix>-<YYYY-MM>-<NNNN> per run', () => {
    seedPayroll(mkCompany({}), [mkEmp('emp-1'), mkEmp('emp-2')]);
    const { payslips } = runPayroll('2025-03');
    expect(payslips.map((p) => p.refNo)).toEqual([
      'ASM-PS-2025-03-0001',
      'ASM-PS-2025-03-0002',
    ]);
    for (const p of payslips) expect(p.refNo).toMatch(/^ASM-PS-2025-03-\d{4}$/);
  });

  it('a full re-run reproduces the same refNos (idempotent)', () => {
    seedPayroll(mkCompany({}), [mkEmp('emp-1'), mkEmp('emp-2')]);
    const first = runPayroll('2025-03').payslips.map((p) => p.refNo);
    const second = runPayroll('2025-03').payslips.map((p) => p.refNo);
    expect(second).toEqual(first);
  });

  it('a partial re-run never collides with surviving payslip numbers', () => {
    seedPayroll(mkCompany({}), [mkEmp('emp-1'), mkEmp('emp-2')]);
    runPayroll('2025-03');
    const second = runPayroll('2025-03', ['emp-2']);
    const stored = getCollection<import('../types').Payslip>('payslips')
      .filter((p) => p.monthKey === '2025-03');
    const emp1 = stored.find((p) => p.employeeId === 'emp-1')!;
    const emp2 = stored.find((p) => p.employeeId === 'emp-2')!;
    expect(emp1.refNo).toBe('ASM-PS-2025-03-0001'); // survivor untouched
    // emp-2's replacement continues past the survivors' max (0001); the old
    // 0002 slip was deleted with the targeted re-run, so 0002 is free and no
    // number appears twice in the run.
    expect(emp2.refNo).toBe('ASM-PS-2025-03-0002');
    expect(second.payslips[0]!.refNo).toBe('ASM-PS-2025-03-0002');
    expect(new Set(stored.map((p) => p.refNo)).size).toBe(stored.length);
  });

  it('draft editor recomputes keep the payslip refNo', () => {
    seedPayroll(mkCompany({}), [mkEmp('emp-1')]);
    const { run, payslips } = runPayroll('2025-03', undefined, 'hr-admin', { draft: true });
    const original = payslips[0]!.refNo;
    const adjusted = setPayslipAdjustments(run.id, 'emp-1', [
      { id: 'a1', kind: 'earning', preset: 'custom', label: 'Commission', amount: 100 },
    ])!;
    expect(adjusted.refNo).toBe(original);
  });

  it('getPayslipPrefix falls back to <code>-PS, then PS', () => {
    seedPayroll(mkCompany({ payslipPrefix: null, code: 'mrd' }), [mkEmp('emp-1')]);
    expect(getPayslipPrefix()).toBe('MRD-PS');
    saveCompanies([]);
    expect(getPayslipPrefix()).toBe('PS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// workingWeek — tenant override of the state weekend rule
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveWorkingWeek / isRestDay — tenant working week', () => {
  it('returns null with no active tenant (state rule applies)', () => {
    setActiveTenantId(null); // system view — no company consulted
    expect(resolveWorkingWeek()).toBeNull();
  });

  it('reads the active company config', () => {
    saveCompanies([mkCompany({ workingWeek: 'fri-sat' })]);
    setActiveTenantId(CO);
    expect(resolveWorkingWeek()).toBe('fri-sat');
    expect(resolveWorkingWeek(mkCompany({ workingWeek: 'sat-sun' }))).toBe('sat-sun');
  });

  it('a JHR employee follows the company sat-sun week, not the state fri-sat rule', () => {
    // 2026-03-15 is a Sunday; 2026-03-13 is a Friday.
    setActiveTenantId(null); // system view → state rule
    expect(isWeekend('2026-03-15', 'JHR')).toBe(false); // state rule: Sunday is a work day
    expect(isRestDay('2026-03-15', 'JHR')).toBe(false);

    saveCompanies([mkCompany({ workingWeek: 'sat-sun' })]);
    setActiveTenantId(CO);
    expect(isRestDay('2026-03-15', 'JHR')).toBe(true);  // company override: Sunday rests
    expect(isRestDay('2026-03-13', 'JHR')).toBe(false); // …and Friday is worked
  });

  it('workingDaysInMonth honours the override in both directions', () => {
    // State-rule baselines for 2026-02 (system view): see workdays.test.ts.
    setActiveTenantId(null);
    expect(workingDaysInMonth('2026-02', 'JHR')).toBe(16); // fri-sat state rule
    expect(workingDaysInMonth('2026-02', 'KUL')).toBe(16); // sat-sun state rule

    // JHR company running sat-sun: Sat/Sun rest instead of Fri/Sat →
    // 28 − 8 weekend days − 3 weekday holidays = 17 (Thaipusam on Sun 02-01
    // is already a rest day under the override).
    saveCompanies([mkCompany({ workingWeek: 'sat-sun' })]);
    setActiveTenantId(CO);
    expect(workingDaysInMonth('2026-02', 'JHR')).toBe(17);

    // KUL company running fri-sat: 28 − 8 Fri/Sat − {02-01 (Sun, holiday),
    // 02-02, 02-03 in-lieu, 02-17, 02-18 CNY} = 15.
    saveCompanies([mkCompany({ workingWeek: 'fri-sat' })]);
    expect(workingDaysInMonth('2026-02', 'KUL')).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// leaveTopUps — single read path through appSettings.getLeaveTopUps
// ─────────────────────────────────────────────────────────────────────────────

describe('leaveTopUps — single read path (config layering bypass fixed)', () => {
  it('Company.config.leaveTopUps applies even with no settings doc', () => {
    saveCompanies([mkCompany({ leaveTopUps: { annual: 2 } })]);
    setActiveTenantId(CO);
    // No 'ext:leaveTopups' settings doc exists at all.
    expect(getLeaveTopUps().annual).toBe(2);
    expect(leaveTopUps().annual).toBe(2); // leaveLogic goes through the accessor
  });

  it('eaEntitlements includes config-level top-ups on top of EA minimums', () => {
    saveCompanies([mkCompany({ leaveTopUps: { annual: 2 } })]);
    setActiveTenantId(CO);
    const emp = mkEmp('emp-1', { joinDate: '2025-06-01' }); // <2 yrs on 2026-03-01
    const ent = eaEntitlements(emp, new Date('2026-03-01T00:00:00'));
    expect(ent.annual).toBe(10); // 8 (EA s.60E tier 1) + 2 company top-up
    expect(ent.topUps.annual).toBe(2);
  });

  it("the 'ext:leaveTopups' settings doc still overrides the config layer", () => {
    saveCompanies([mkCompany({ leaveTopUps: { annual: 2 } })]);
    setActiveTenantId(CO);
    setCollection('settings', [
      { id: 'ext:leaveTopups', kind: 'leaveTopups', days: { annual: 5 } },
    ]);
    expect(leaveTopUps().annual).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suspend enforcement — web login()
// ─────────────────────────────────────────────────────────────────────────────

describe('login — suspended company enforcement', () => {
  function seedCompanies(): void {
    saveCompanies([
      mkCompany({}), // co-asm, active — accounts admin/hr/…
      mkCompany({ id: 'co-merdeka', code: 'MRD', status: 'suspended' }),
    ]);
    setActiveTenantId(CO);
  }

  it('rejects a user of a suspended company with a clear message, no session', () => {
    seedCompanies();
    const res = login('admin2', 'admin123'); // Merdeka Manufacturing admin
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/suspended/i);
    expect(getSession()).toBeNull();
  });

  it('does not leak suspension on a wrong password (generic error wins)', () => {
    seedCompanies();
    const res = login('admin2', 'wrong-password');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Invalid username or password.');
  });

  it('active-company users and SuperAdmin are unaffected', () => {
    seedCompanies();
    expect(login('admin', 'admin123').ok).toBe(true);
    logout();
    expect(login('superadmin', 'super123').ok).toBe(true);
  });

  it('reactivating the company restores sign-in', () => {
    seedCompanies();
    expect(login('admin2', 'admin123').ok).toBe(false);
    saveCompanies([
      mkCompany({}),
      mkCompany({ id: 'co-merdeka', code: 'MRD', status: 'active' }),
    ]);
    expect(login('admin2', 'admin123').ok).toBe(true);
  });
});
