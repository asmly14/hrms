/**
 * Separation engine tests: VSS amount math, reason mapping, payslip-delete
 * guard, case creation payloads, bulk separation results, cascade delete
 * (incl. mock-auth account removal via the documented 'hrms.users' key),
 * and audit trails. Mirrors the lib test style with the storage stub.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from '../../../lib/__tests__/storageStub';
import { getCollection, setActiveTenantId, setCollection, type CollectionName } from '../../../lib/db';
import type { OffboardingCase } from '../../../lib/lifecycle';
import type { UserAccount } from '../../../lib/auth';
import type { Employee, Payslip } from '../../../lib/types';
import {
  OTHER_SEPARATION_REASON_LABELS,
  applySeparation,
  buildSeparationPayload,
  buildVssPackage,
  bulkDelete,
  bulkSeparate,
  computeVssAmount,
  deleteBlockReason,
  deleteEmployeeCascade,
  hasPayslips,
  offboardingReasonFor,
  separationBlockReason,
  suggestedLastWorkingDay,
  type SeparationSpec,
} from '../separations';

beforeEach(() => {
  installLocalStorage();
  setActiveTenantId('co-asm');
});

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function emp(id: string, status: Employee['status'] = 'active'): Employee {
  seq += 1;
  return {
    id,
    name: `Employee ${id}`,
    ic: `90010${seq}-01-1234`,
    email: `${id}@example.com`,
    phone: '012-3456789',
    departmentId: 'dept-eng',
    positionId: 'pos-swe',
    role: 'employee',
    joinDate: '2020-01-15',
    state: 'KUL',
    employmentType: 'full-time',
    status,
    baseSalary: 5000,
    maritalStatus: 'single',
    children: 0,
    bankName: 'Maybank',
    bankAccount: '1234567890',
    epfNo: `EPF${seq}`,
    socsoNo: `SOC${seq}`,
    taxNo: `TAX${seq}`,
    isForeignWorker: false,
    dateOfBirth: '1990-01-01',
    gender: 'male',
    fixedAllowances: [],
  };
}

function slip(employeeId: string): Payslip {
  return { id: `ps-${employeeId}`, runId: 'run-1', employeeId, monthKey: '2025-01' } as Payslip;
}

const resignSpec: SeparationSpec = {
  kind: 'resign',
  noticeDate: '2025-06-02',
  lastWorkingDay: '2025-06-30',
  remarks: 'Moving abroad',
};

function casesStore(): OffboardingCase[] {
  return getCollection<OffboardingCase>('offboardingCases' as CollectionName);
}

// ── VSS math ────────────────────────────────────────────────────────────────

describe('computeVssAmount', () => {
  it('multiplies months by last drawn salary', () => {
    expect(computeVssAmount(1.5, 5000)).toBe(7500);
    expect(computeVssAmount(3, 4250.5)).toBe(12751.5);
  });

  it('clamps non-positive / non-finite input to zero', () => {
    expect(computeVssAmount(-1, 5000)).toBe(0);
    expect(computeVssAmount(2, Number.NaN)).toBe(0);
  });
});

describe('buildVssPackage', () => {
  it('derives the amount and trims terms', () => {
    expect(buildVssPackage({ months: 2, lastDrawnSalary: 6000, terms: '  medical ext. ' })).toEqual({
      months: 2,
      amount: 12000,
      terms: 'medical ext.',
    });
  });

  it('omits blank terms', () => {
    expect(buildVssPackage({ months: 1, lastDrawnSalary: 5000, terms: '   ' })).toEqual({
      months: 1,
      amount: 5000,
    });
  });
});

// ── Reason mapping ──────────────────────────────────────────────────────────

describe('offboardingReasonFor', () => {
  it('maps dialog kinds onto the lifecycle union', () => {
    expect(offboardingReasonFor({ ...resignSpec })).toBe('resignation');
    expect(offboardingReasonFor({ ...resignSpec, kind: 'vss' })).toBe('vss');
    expect(offboardingReasonFor({ ...resignSpec, kind: 'other', otherReason: 'absconded' })).toBe('absconded');
    expect(offboardingReasonFor({ ...resignSpec, kind: 'other', otherReason: 'contract-end' })).toBe('contract-end');
  });

  it('offers exactly the four other-separation reasons', () => {
    expect(Object.keys(OTHER_SEPARATION_REASON_LABELS).sort()).toEqual([
      'absconded',
      'contract-end',
      'retirement',
      'termination',
    ]);
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

describe('payslip delete guard', () => {
  it('blocks deletion when payslips exist, citing statutory retention', () => {
    const e = emp('emp-1');
    expect(hasPayslips([slip('emp-1')], 'emp-1')).toBe(true);
    expect(deleteBlockReason([slip('emp-1')], e)).toMatch(/6–7 years/);
    expect(deleteBlockReason([slip('emp-2')], e)).toBeNull();
    expect(deleteBlockReason([], e)).toBeNull();
  });
});

describe('separation guard', () => {
  it('blocks already-resigned employees only', () => {
    expect(separationBlockReason(emp('emp-1', 'resigned'))).toBe('already resigned');
    expect(separationBlockReason(emp('emp-2', 'active'))).toBeNull();
    expect(separationBlockReason(emp('emp-3', 'probation'))).toBeNull();
  });
});

// ── Case creation payloads ──────────────────────────────────────────────────

describe('buildSeparationPayload', () => {
  it('resign: status patch + resignation case with shared LWD', () => {
    const e = emp('emp-1');
    const { employeePatch, casePayload } = buildSeparationPayload(e, resignSpec, [], []);
    expect(employeePatch).toEqual({ status: 'resigned', resignDate: '2025-06-30' });
    expect(casePayload.reason).toBe('resignation');
    expect(casePayload.employeeId).toBe('emp-1');
    expect(casePayload.lastWorkingDay).toBe('2025-06-30');
    expect(casePayload.notes).toBe('Moving abroad');
    expect(casePayload.vssPackage).toBeUndefined();
    // EA notice weeks from joinDate 2020-01-15 at notice 2025-06-02 → 8 weeks.
    expect(casePayload.noticeWeeks).toBe(8);
    expect(casePayload.clearanceItems.length).toBeGreaterThan(0);
  });

  it('vss: stores the package with derived amount on the case', () => {
    const e = emp('emp-1');
    const spec: SeparationSpec = {
      kind: 'vss',
      noticeDate: '2025-06-02',
      lastWorkingDay: '2025-07-31',
      vss: { months: 2, lastDrawnSalary: 5000, terms: 'medical ext.' },
    };
    const { casePayload } = buildSeparationPayload(e, spec, [], []);
    expect(casePayload.reason).toBe('vss');
    expect(casePayload.vssPackage).toEqual({ months: 2, amount: 10000, terms: 'medical ext.' });
  });

  it('absconded: flags the EA s.12(3) inquiry note on the case', () => {
    const e = emp('emp-1');
    const spec: SeparationSpec = {
      kind: 'other',
      otherReason: 'absconded',
      noticeDate: '2025-06-02',
      lastWorkingDay: '2025-06-10',
      remarks: 'No-show since 2 Jun',
    };
    const { employeePatch, casePayload } = buildSeparationPayload(e, spec, [], []);
    expect(employeePatch.status).toBe('resigned');
    expect(casePayload.reason).toBe('absconded');
    expect(casePayload.notes).toContain('No-show since 2 Jun');
    expect(casePayload.notes).toContain('absconded');
  });
});

// ── Apply + audit ───────────────────────────────────────────────────────────

describe('applySeparation', () => {
  it('updates the employee, creates the case and writes one audit entry', () => {
    const e = emp('emp-1');
    setCollection('employees', [e]);

    applySeparation(e, resignSpec, 'hr');

    const stored = getCollection<Employee>('employees');
    expect(stored[0]!.status).toBe('resigned');
    expect(stored[0]!.resignDate).toBe('2025-06-30');

    const cases = casesStore();
    expect(cases).toHaveLength(1);
    expect(cases[0]!.reason).toBe('resignation');

    const audit = getCollection<{ action: string; entityId: string; actorName: string }>('audit');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('employee.separate.resignation');
    expect(audit[0]!.entityId).toBe('emp-1');
    expect(audit[0]!.actorName).toBe('hr');
  });
});

// ── Bulk separation ─────────────────────────────────────────────────────────

describe('bulkSeparate', () => {
  it('separates eligible employees and skips already-resigned ones', () => {
    const a = emp('emp-a');
    const b = emp('emp-b', 'resigned');
    const c = emp('emp-c', 'probation');
    setCollection('employees', [a, b, c]);

    const progress: number[] = [];
    const result = bulkSeparate([a, b, c], resignSpec, 'hr', (done) => progress.push(done));

    expect(result.succeeded.map((s) => s.employeeId)).toEqual(['emp-a', 'emp-c']);
    expect(result.skipped).toEqual([
      { employeeId: 'emp-b', name: b.name, reason: 'already resigned' },
    ]);
    expect(casesStore()).toHaveLength(2); // one case per processed employee
    expect(getCollection('audit')).toHaveLength(2); // one audit entry each
    expect(progress).toEqual([1, 2, 3]); // per-item progress callbacks
  });
});

// ── Permanent delete ────────────────────────────────────────────────────────

describe('deleteEmployeeCascade', () => {
  it('removes the record, linked collections and the user account', () => {
    const e = emp('emp-1');
    const other = emp('emp-2');
    setCollection('employees', [e, other]);
    setCollection('attendance', [{ id: 'at-1', employeeId: 'emp-1' }, { id: 'at-2', employeeId: 'emp-2' }]);
    setCollection('leaves', [{ id: 'lv-1', employeeId: 'emp-1' }]);
    setCollection('claims', [{ id: 'cl-1', employeeId: 'emp-1' }]);
    setCollection('leaveBalances', [{ id: 'lb-1', employeeId: 'emp-1' }]);
    setCollection('kpis', [{ id: 'kp-1', employeeId: 'emp-1' }]);
    setCollection('reviews', [{ id: 'rv-1', employeeId: 'emp-1' }]);
    localStorage.setItem(
      'hrms.users',
      JSON.stringify([
        { id: 'u-1', username: 'emp1', password: 'x', companyId: 'co-asm', employeeId: 'emp-1', role: 'Employee' },
        { id: 'u-2', username: 'emp2', password: 'x', companyId: 'co-asm', employeeId: 'emp-2', role: 'Employee' },
        { id: 'u-3', username: 'otherco', password: 'x', companyId: 'co-merdeka', employeeId: 'emp-1', role: 'Employee' },
      ] satisfies UserAccount[]),
    );

    const result = deleteEmployeeCascade(e, 'admin');

    expect(result).not.toBeNull();
    expect(result!.removedLinked).toEqual({
      attendance: 1,
      leaves: 1,
      claims: 1,
      leaveBalances: 1,
      kpis: 1,
      reviews: 1,
      userAccounts: 1,
    });
    expect(getCollection<Employee>('employees').map((x) => x.id)).toEqual(['emp-2']);
    expect(getCollection<{ employeeId: string }>('attendance').map((x) => x.employeeId)).toEqual(['emp-2']);

    const users = JSON.parse(localStorage.getItem('hrms.users')!) as UserAccount[];
    // Same-tenant account gone; the other tenant's account is untouched.
    expect(users.map((u) => u.id)).toEqual(['u-2', 'u-3']);

    const audit = getCollection<{ action: string }>('audit');
    expect(audit.at(-1)!.action).toBe('employee.delete');
  });

  it('refuses when payslips exist (defence-in-depth backstop)', () => {
    const e = emp('emp-1');
    setCollection('employees', [e]);
    setCollection('payslips', [slip('emp-1')]);
    expect(deleteEmployeeCascade(e, 'admin')).toBeNull();
    expect(getCollection<Employee>('employees')).toHaveLength(1);
  });
});

describe('bulkDelete', () => {
  it('deletes payslip-free records and skips protected ones', () => {
    const a = emp('emp-a');
    const b = emp('emp-b'); // protected by a payslip
    setCollection('employees', [a, b]);
    setCollection('payslips', [slip('emp-b')]);

    const result = bulkDelete([a, b], 'admin');

    expect(result.succeeded.map((s) => s.employeeId)).toEqual(['emp-a']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.employeeId).toBe('emp-b');
    expect(result.skipped[0]!.reason).toMatch(/payslips/);
    expect(getCollection<Employee>('employees').map((x) => x.id)).toEqual(['emp-b']);
  });
});

// ── EA notice suggestion ────────────────────────────────────────────────────

describe('suggestedLastWorkingDay', () => {
  it('derives the statutory LWD from EA s.12 notice tiers', () => {
    // Joined 2020-01-15 → 8 weeks' notice at 2025-06-02 → LWD 56 - 1 = 55 days later.
    expect(suggestedLastWorkingDay(emp('emp-1'), '2025-06-02')).toBe('2025-07-27');
  });
});
