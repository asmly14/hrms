/**
 * Separation engine tests: VSS amount math, reason mapping, payslip-delete
 * guard, case creation payloads, bulk separation results, cascade delete
 * (incl. mock-auth account removal via the documented 'hrms.users' key),
 * and audit trails. Mirrors the lib test style with the storage stub.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from '../../../lib/__tests__/storageStub';
import { getCollection, setActiveTenantId, setCollection } from '../../../lib/db';
import type { OffboardingCase } from '../../../lib/lifecycle';
import type { UserAccount } from '../../../lib/auth';
import type { Employee, Payslip } from '../../../lib/types';
import {
  OTHER_SEPARATION_REASON_LABELS,
  addCascadeCounts,
  applySeparation,
  buildSeparationPayload,
  buildVssPackage,
  bulkDelete,
  bulkSeparate,
  computeVssAmount,
  deleteBlockReason,
  deleteEmployeeCascade,
  emptyCascadeCounts,
  hasPayslips,
  offboardingReasonFor,
  separationBlockReason,
  suggestedLastWorkingDay,
  summarizeCascadeCounts,
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
  return getCollection<OffboardingCase>('offboardingCases');
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
      contracts: 0,
      contractFeePayments: 0,
      employeeRecords: 0,
      onboardingExtras: 0,
      onboardingChecklists: 0,
      offboardingCases: 0,
      objectives: 0,
      checkins: 0,
      pips: 0,
      userAccounts: 1,
    });
    expect(result!.cleanedRefs).toEqual({
      onboardSubmissions: 0,
      reviewAssignments: 0,
      checkinAuthorships: 0,
      departmentHeads: 0,
      shiftAssignments: 0,
      rotationMemberships: 0,
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

  it('attaches per-employee cascade counts to the bulk result', () => {
    const a = emp('emp-a');
    const b = emp('emp-b'); // protected by a payslip
    setCollection('employees', [a, b]);
    setCollection('payslips', [slip('emp-b')]);
    setCollection('contracts', [{ id: 'ct-a', employeeId: 'emp-a' }]);

    const result = bulkDelete([a, b], 'admin');

    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0]!.cascade?.removedLinked.contracts).toBe(1);
    expect(result.succeeded[0]!.cascade?.removedLinked.userAccounts).toBe(0);
    expect(result.skipped[0]!.reason).toMatch(/payslips/);
  });
});

// ── Full-cascade coverage (audit-database §3.1) ─────────────────────────────

describe('deleteEmployeeCascade — full registry coverage', () => {
  it('purges every employee-owned collection and cleans cross-references', () => {
    const e = emp('emp-1');
    const other = emp('emp-2');
    setCollection('employees', [e, other]);

    // Owned rows (employeeId-keyed) — emp-1 rows must go, emp-2 controls stay.
    setCollection('contracts', [
      { id: 'ct-1', employeeId: 'emp-1' },
      { id: 'ct-2', employeeId: 'emp-1' },
      { id: 'ct-3', employeeId: 'emp-2' },
    ]);
    setCollection('contractFeePayments', [
      { id: 'fp-1', contractId: 'ct-1' },
      { id: 'fp-2', contractId: 'ct-2' },
      { id: 'fp-3', contractId: 'ct-3' },
    ]);
    setCollection('employeeRecords', [
      { id: 'er-1', employeeId: 'emp-1' },
      { id: 'er-2', employeeId: 'emp-2' },
    ]);
    setCollection('onboardingExtras', [
      { id: 'ex-1', employeeId: 'emp-1' },
      { id: 'ex-2', employeeId: 'emp-2' },
    ]);
    setCollection('onboardingChecklists', [
      { id: 'cl-1', employeeId: 'emp-1' },
      { id: 'cl-2', employeeId: 'emp-2' },
    ]);
    setCollection('offboardingCases', [
      { id: 'oc-1', employeeId: 'emp-1' },
      { id: 'oc-2', employeeId: 'emp-2' },
    ]);
    setCollection('objectives', [
      { id: 'ob-1', employeeId: 'emp-1' },
      { id: 'ob-2', employeeId: 'emp-2' },
    ]);
    setCollection('pips', [
      { id: 'pp-1', employeeId: 'emp-1' },
      { id: 'pp-2', employeeId: 'emp-2' },
    ]);
    setCollection('checkins', [
      // emp-1 is the review subject → row is deleted with the review thread.
      { id: 'ci-1', reviewId: 'rv-1', employeeId: 'emp-1', authorId: 'emp-2' },
      // emp-1 authored a note on emp-2's thread → kept, authorId cleared.
      { id: 'ci-2', reviewId: 'rv-2', employeeId: 'emp-2', authorId: 'emp-1' },
    ]);
    setCollection('reviews', [
      { id: 'rv-1', employeeId: 'emp-1', reviewerId: 'emp-2' }, // own → deleted
      { id: 'rv-2', employeeId: 'emp-2', reviewerId: 'emp-1' }, // routed to emp-1 → kept, unassigned
    ]);
    setCollection('onboardSubmissions', [
      {
        id: 'sub-1',
        employeeId: 'emp-1',
        documents: [{ kind: 'IC', fileName: 'ic.png', sizeBytes: 10, uploadedAt: '2025-01-01' }],
      },
      { id: 'sub-2', employeeId: 'emp-2' },
    ]);
    setCollection('departments', [
      { id: 'dept-eng', name: 'Engineering', code: 'ENG', headId: 'emp-1', state: 'KUL' },
      { id: 'dept-hr', name: 'HR', code: 'HR', headId: 'emp-2', state: 'KUL' },
    ]);
    setCollection('shifts', [
      { id: 'sh-1', name: 'Morning', employeeIds: ['emp-1', 'emp-2'] },
      { id: 'sh-2', name: 'Night', employeeIds: ['emp-2'] },
    ]);
    setCollection('attendance:rotations', [
      { id: 'rp-1', name: 'Plan A', employeeIds: ['emp-1'] },
      { id: 'rp-2', name: 'Plan B', employeeIds: ['emp-2'] },
    ]);

    const result = deleteEmployeeCascade(e, 'admin');
    expect(result).not.toBeNull();

    // ── Owned rows purged; controls untouched ──
    expect(getCollection<{ id: string }>('contracts').map((x) => x.id)).toEqual(['ct-3']);
    expect(getCollection<{ id: string }>('contractFeePayments').map((x) => x.id)).toEqual(['fp-3']);
    expect(getCollection<{ id: string }>('employeeRecords').map((x) => x.id)).toEqual(['er-2']);
    expect(getCollection<{ id: string }>('onboardingExtras').map((x) => x.id)).toEqual(['ex-2']);
    expect(getCollection<{ id: string }>('onboardingChecklists').map((x) => x.id)).toEqual(['cl-2']);
    expect(getCollection<{ id: string }>('offboardingCases').map((x) => x.id)).toEqual(['oc-2']);
    expect(getCollection<{ id: string }>('objectives').map((x) => x.id)).toEqual(['ob-2']);
    expect(getCollection<{ id: string }>('pips').map((x) => x.id)).toEqual(['pp-2']);

    // ── Check-ins: subject row deleted; authored row kept, authorId cleared ──
    const checkins = getCollection<{ id: string; authorId?: string }>('checkins');
    expect(checkins).toHaveLength(1);
    expect(checkins[0]!.id).toBe('ci-2');
    expect(checkins[0]!.authorId).toBeUndefined();

    // ── Reviews: own deleted; emp-2's kept with the reviewer unassigned ──
    const reviews = getCollection<{ id: string; reviewerId?: string }>('reviews');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.id).toBe('rv-2');
    expect(reviews[0]!.reviewerId).toBe('');

    // ── Submissions kept (intake record + document bytes), employeeId cleared ──
    const subs = getCollection<{ id: string; employeeId?: string; documents?: unknown[] }>(
      'onboardSubmissions',
    );
    expect(subs).toHaveLength(2);
    expect(subs[0]!.id).toBe('sub-1');
    expect(subs[0]!.employeeId).toBeUndefined();
    expect(subs[0]!.documents).toHaveLength(1);
    expect(subs[1]!.employeeId).toBe('emp-2');

    // ── Department head reference nulled; other department untouched ──
    const depts = getCollection<{ id: string; headId?: string }>('departments');
    expect(depts.find((d) => d.id === 'dept-eng')!.headId).toBeUndefined();
    expect(depts.find((d) => d.id === 'dept-hr')!.headId).toBe('emp-2');

    // ── Shift assignments + rotation memberships removed ──
    const shifts = getCollection<{ id: string; employeeIds?: string[] }>('shifts');
    expect(shifts.find((s) => s.id === 'sh-1')!.employeeIds).toEqual(['emp-2']);
    expect(shifts.find((s) => s.id === 'sh-2')!.employeeIds).toEqual(['emp-2']);
    const rotations = getCollection<{ id: string; employeeIds?: string[] }>('attendance:rotations');
    expect(rotations.find((r) => r.id === 'rp-1')!.employeeIds).toEqual([]);
    expect(rotations.find((r) => r.id === 'rp-2')!.employeeIds).toEqual(['emp-2']);

    // ── Per-collection counts ──
    expect(result!.removedLinked).toMatchObject({
      contracts: 2,
      contractFeePayments: 2,
      employeeRecords: 1,
      onboardingExtras: 1,
      onboardingChecklists: 1,
      offboardingCases: 1,
      objectives: 1,
      checkins: 1,
      pips: 1,
      reviews: 1,
    });
    expect(result!.cleanedRefs).toEqual({
      onboardSubmissions: 1,
      reviewAssignments: 1,
      checkinAuthorships: 1,
      departmentHeads: 1,
      shiftAssignments: 1,
      rotationMemberships: 1,
    });

    // ── The employee record itself is gone; the audit entry tells the story ──
    expect(getCollection<Employee>('employees').map((x) => x.id)).toEqual(['emp-2']);
    const audit = getCollection<{ action: string; detail: string }>('audit');
    expect(audit.at(-1)!.action).toBe('employee.delete');
    expect(audit.at(-1)!.detail).toContain('2 contracts');
    expect(audit.at(-1)!.detail).toContain('1 department-head refs');
  });

  it('keeps payroll history and non-employee-linked collections untouched', () => {
    const e = emp('emp-1');
    const other = emp('emp-2');
    setCollection('employees', [e, other]);
    // emp-2's payslip keeps the guard intact for them but must not trip emp-1's delete.
    setCollection('payslips', [slip('emp-2')]);
    setCollection('payrollRuns', [{ id: 'run-1', monthKey: '2025-01' }]);
    setCollection('cycles', [{ id: 'cy-1', name: '2026-H1', departmentIds: ['dept-eng'] }]);
    setCollection('positionProfiles', [{ id: 'pos-swe', positionId: 'pos-swe' }]);
    setCollection('departmentProfiles', [{ id: 'dept-eng', departmentId: 'dept-eng' }]);
    setCollection('onboardLinks', [
      { id: 'ln-1', token: 'tok', companyId: 'co-asm', status: 'approved', submissionId: 'sub-1' },
    ]);

    const result = deleteEmployeeCascade(e, 'admin');
    expect(result).not.toBeNull();

    expect(getCollection('payslips')).toHaveLength(1);
    expect(getCollection('payrollRuns')).toHaveLength(1);
    expect(getCollection('cycles')).toHaveLength(1);
    expect(getCollection('positionProfiles')).toHaveLength(1);
    expect(getCollection('departmentProfiles')).toHaveLength(1);
    expect(getCollection('onboardLinks')).toHaveLength(1);
    // No deletion counts anywhere except the employee record itself.
    expect(result!.removedLinked).toEqual(emptyCascadeCounts().removedLinked);
    expect(result!.cleanedRefs).toEqual(emptyCascadeCounts().cleanedRefs);
  });

  it('refuses wholesale when payslips exist — no linked collection is touched', () => {
    const e = emp('emp-1');
    setCollection('employees', [e]);
    setCollection('payslips', [slip('emp-1')]);
    setCollection('attendance', [{ id: 'at-1', employeeId: 'emp-1' }]);
    setCollection('contracts', [{ id: 'ct-1', employeeId: 'emp-1' }]);
    setCollection('departments', [
      { id: 'dept-eng', name: 'Engineering', code: 'ENG', headId: 'emp-1', state: 'KUL' },
    ]);

    expect(deleteEmployeeCascade(e, 'admin')).toBeNull();

    expect(getCollection<Employee>('employees')).toHaveLength(1);
    expect(getCollection('attendance')).toHaveLength(1);
    expect(getCollection('contracts')).toHaveLength(1);
    expect(
      getCollection<{ headId?: string }>('departments')[0]!.headId,
    ).toBe('emp-1');
    expect(getCollection('audit')).toHaveLength(0); // no delete audit written
  });

  it('is idempotent — a second delete is a zero-count no-op', () => {
    const e = emp('emp-1');
    const other = emp('emp-2');
    setCollection('employees', [e, other]);
    setCollection('attendance', [{ id: 'at-1', employeeId: 'emp-1' }]);
    setCollection('contracts', [{ id: 'ct-1', employeeId: 'emp-1' }]);
    setCollection('departments', [
      { id: 'dept-eng', name: 'Engineering', code: 'ENG', headId: 'emp-1', state: 'KUL' },
    ]);

    const first = deleteEmployeeCascade(e, 'admin');
    expect(first).not.toBeNull();
    expect(first!.removedLinked.attendance).toBe(1);

    const second = deleteEmployeeCascade(e, 'admin');
    expect(second).toEqual(emptyCascadeCounts());
    expect(getCollection<Employee>('employees').map((x) => x.id)).toEqual(['emp-2']);
    expect(getCollection<{ headId?: string }>('departments')[0]!.headId).toBeUndefined();
    // Both runs wrote an audit entry (the trail is append-only by design).
    expect(getCollection<{ action: string }>('audit').map((a) => a.action)).toEqual([
      'employee.delete',
      'employee.delete',
    ]);
  });
});

// ── Cascade count helpers ───────────────────────────────────────────────────

describe('cascade count helpers', () => {
  it('summarizes non-zero counts only', () => {
    const counts = emptyCascadeCounts();
    counts.removedLinked.contracts = 2;
    counts.removedLinked.userAccounts = 1;
    counts.cleanedRefs.departmentHeads = 1;
    expect(summarizeCascadeCounts(counts)).toBe(
      'purged 2 contracts, 1 user accounts; cleared 1 department-head refs',
    );
  });

  it('reports "no linked records" for an empty cascade', () => {
    expect(summarizeCascadeCounts(emptyCascadeCounts())).toBe('no linked records');
  });

  it('aggregates two cascade results field-by-field', () => {
    const a = emptyCascadeCounts();
    a.removedLinked.attendance = 3;
    a.cleanedRefs.shiftAssignments = 1;
    const b = emptyCascadeCounts();
    b.removedLinked.attendance = 2;
    b.cleanedRefs.departmentHeads = 1;

    const total = addCascadeCounts(a, b);
    expect(total.removedLinked.attendance).toBe(5);
    expect(total.cleanedRefs.shiftAssignments).toBe(1);
    expect(total.cleanedRefs.departmentHeads).toBe(1);
    expect(total.removedLinked.contracts).toBe(0);
  });
});

// ── EA notice suggestion ────────────────────────────────────────────────────

describe('suggestedLastWorkingDay', () => {
  it('derives the statutory LWD from EA s.12 notice tiers', () => {
    // Joined 2020-01-15 → 8 weeks' notice at 2025-06-02 → LWD 56 - 1 = 55 days later.
    expect(suggestedLastWorkingDay(emp('emp-1'), '2025-06-02')).toBe('2025-07-27');
  });
});
