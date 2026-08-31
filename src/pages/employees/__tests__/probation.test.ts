/**
 * Probation engine tests: end-date math (default / custom length / month-end
 * clamp / extension wins), status transitions (active → overdue, probation →
 * confirmed), history append on extend and confirm, and the audit trail.
 * Mirrors the lib test style with the storage stub.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from '../../../lib/__tests__/storageStub';
import { getCollection, setActiveTenantId, setCollection } from '../../../lib/db';
import type { AuditLog, Employee } from '../../../lib/types';
import {
  probationDaysLeft,
  probationEndDate,
  probationProgress,
  probationStatus,
} from '../helpers';
import {
  confirmEmployee,
  confirmPatch,
  extendProbation,
  extensionPatch,
  lastExtension,
} from '../probation';

beforeEach(() => {
  installLocalStorage();
  setActiveTenantId('co-asm');
});

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function emp(id: string, extra: Partial<Employee> = {}): Employee {
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
    joinDate: '2025-08-12',
    state: 'KUL',
    employmentType: 'full-time',
    status: 'probation',
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
    ...extra,
  };
}

function seed(e: Employee): Employee {
  setCollection('employees', [e]);
  return e;
}

function stored(id: string): Employee {
  return getCollection<Employee>('employees').find((e) => e.id === id)!;
}

// ── End-date math ───────────────────────────────────────────────────────────

describe('probationEndDate', () => {
  it('defaults to join date + 3 months', () => {
    expect(probationEndDate(emp('e1'))).toBe('2025-11-12');
  });

  it('honours a custom probationMonths', () => {
    expect(probationEndDate(emp('e2', { probationMonths: 6 }))).toBe('2026-02-12');
  });

  it('clamps month-end overflow (31 Jan + 3 months → 30 Apr)', () => {
    expect(probationEndDate(emp('e3', { joinDate: '2025-01-31' }))).toBe('2025-04-30');
  });

  it('extension date wins over the derived end', () => {
    expect(probationEndDate(emp('e4', { probationExtendedTo: '2026-02-12' }))).toBe('2026-02-12');
  });
});

describe('probationDaysLeft / probationProgress', () => {
  it('counts whole days to the end date', () => {
    const e = emp('e5'); // ends 2025-11-12
    expect(probationDaysLeft(e, new Date('2025-11-02T12:00:00'))).toBe(10);
    expect(probationDaysLeft(e, new Date('2025-11-12T00:00:00'))).toBe(0);
    expect(probationDaysLeft(e, new Date('2025-11-20T00:00:00'))).toBe(-8);
  });

  it('extension pushes daysLeft back into the future', () => {
    const e = emp('e6', { probationExtendedTo: '2026-02-12' });
    expect(probationDaysLeft(e, new Date('2025-11-20T00:00:00'))).toBe(84);
  });

  it('progress spans join date → current (extended) end date', () => {
    const base = emp('e7');
    expect(probationProgress(base, new Date('2025-08-12T00:00:00'))).toBe(0);
    expect(probationProgress(base, new Date('2025-11-12T00:00:00'))).toBe(1);
    const extended = emp('e7b', { probationExtendedTo: '2026-08-12' });
    // Same absolute day = smaller share of the longer extended period.
    const p = probationProgress(extended, new Date('2025-11-12T00:00:00'));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.5);
  });
});

// ── Status transitions ──────────────────────────────────────────────────────

describe('probationStatus', () => {
  it('is active with daysLeft while on probation', () => {
    const s = probationStatus(emp('e8'), new Date('2025-11-02T00:00:00'));
    expect(s).toEqual({ active: true, daysLeft: 10, overdue: false });
  });

  it('flips to overdue past the end date', () => {
    const s = probationStatus(emp('e9'), new Date('2025-11-20T00:00:00'));
    expect(s).toEqual({ active: true, daysLeft: -8, overdue: true });
  });

  it('an extension clears the overdue flag', () => {
    const e = emp('e10', { probationExtendedTo: '2026-02-12' });
    const s = probationStatus(e, new Date('2025-11-20T00:00:00'));
    expect(s.overdue).toBe(false);
    expect(s.daysLeft).toBeGreaterThan(0);
  });

  it('is inactive once confirmed (status active)', () => {
    const s = probationStatus(emp('e11', { status: 'active' }), new Date('2025-11-20T00:00:00'));
    expect(s.active).toBe(false);
    expect(s.overdue).toBe(false);
  });
});

// ── Pure patches / history append ───────────────────────────────────────────

describe('extensionPatch', () => {
  it('sets probationExtendedTo and appends a history entry', () => {
    const e = emp('e12');
    const patch = extensionPatch(e, '2026-02-12', 'hr.amy', 'Performance review pending', '2025-11-01T03:00:00Z');
    expect(patch.probationExtendedTo).toBe('2026-02-12');
    expect(patch.probationHistory).toHaveLength(1);
    expect(patch.probationHistory![0]).toEqual({
      action: 'extended',
      fromEnd: '2025-11-12',
      toEnd: '2026-02-12',
      reason: 'Performance review pending',
      by: 'hr.amy',
      at: '2025-11-01T03:00:00Z',
    });
  });

  it('omits reason when blank and chains extensions from the latest end', () => {
    const first = emp('e13');
    const once: Employee = { ...first, ...extensionPatch(first, '2026-02-12', 'hr.amy', '  ', '2025-11-01T00:00:00Z') };
    expect(once.probationHistory![0].reason).toBeUndefined();

    const twice = extensionPatch(once, '2026-05-12', 'hr.amy', undefined, '2026-02-01T00:00:00Z');
    expect(twice.probationHistory).toHaveLength(2);
    expect(twice.probationHistory![1].fromEnd).toBe('2026-02-12');
    expect(twice.probationHistory![1].toEnd).toBe('2026-05-12');
    expect(lastExtension({ ...once, ...twice })?.toEnd).toBe('2026-05-12');
  });
});

describe('confirmPatch', () => {
  it('flips status to active and records the scheduled vs actual end', () => {
    const e = emp('e14');
    const patch = confirmPatch(e, 'hr.amy', '2025-11-01T03:00:00Z');
    expect(patch.status).toBe('active');
    expect(patch.probationHistory).toHaveLength(1);
    const entry = patch.probationHistory![0];
    expect(entry.action).toBe('confirmed');
    expect(entry.fromEnd).toBe('2025-11-12');
    expect(entry.by).toBe('hr.amy');
    expect(entry.toEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── Storage-backed mutations ────────────────────────────────────────────────

describe('extendProbation', () => {
  it('persists the extension, history entry and audit log', () => {
    const e = seed(emp('e15'));
    const next = extendProbation(e, '2026-02-12', 'hr.amy', 'Extended training period');
    expect(next).not.toBeNull();

    const saved = stored('e15');
    expect(saved.probationExtendedTo).toBe('2026-02-12');
    expect(saved.probationHistory).toHaveLength(1);
    expect(saved.probationHistory![0].reason).toBe('Extended training period');

    const audit = getCollection<AuditLog>('audit');
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('employee.probation_extend');
    expect(audit[0].entityId).toBe('e15');
    expect(audit[0].detail).toContain('2025-11-12 → 2026-02-12');
  });

  it('rejects a date at or before the current end and leaves no trace', () => {
    const e = seed(emp('e16'));
    expect(extendProbation(e, '2025-11-12', 'hr.amy')).toBeNull();
    expect(extendProbation(e, '2025-10-01', 'hr.amy')).toBeNull();
    expect(stored('e16').probationExtendedTo).toBeUndefined();
    expect(getCollection<AuditLog>('audit')).toHaveLength(0);
  });

  it('rejects employees who are not on probation', () => {
    const e = seed(emp('e17', { status: 'active' }));
    expect(extendProbation(e, '2026-02-12', 'hr.amy')).toBeNull();
    expect(getCollection<AuditLog>('audit')).toHaveLength(0);
  });

  it('re-extension starts from the previous extension date', () => {
    const e = seed(emp('e18'));
    const once = extendProbation(e, '2026-02-12', 'hr.amy')!;
    expect(extendProbation(once, '2026-01-01', 'hr.amy')).toBeNull(); // backwards
    const twice = extendProbation(once, '2026-05-12', 'hr.bob', 'Second review')!;
    expect(twice.probationHistory).toHaveLength(2);
    expect(twice.probationHistory![1]).toMatchObject({
      action: 'extended',
      fromEnd: '2026-02-12',
      toEnd: '2026-05-12',
      by: 'hr.bob',
    });
    expect(stored('e18').probationExtendedTo).toBe('2026-05-12');
  });
});

describe('confirmEmployee', () => {
  it('sets status active, appends history and audits', () => {
    const e = seed(emp('e19', { probationExtendedTo: '2026-02-12' }));
    const next = confirmEmployee(e, 'hr.amy')!;
    expect(next.status).toBe('active');

    const saved = stored('e19');
    expect(saved.status).toBe('active');
    expect(saved.probationHistory).toHaveLength(1);
    expect(saved.probationHistory![0]).toMatchObject({
      action: 'confirmed',
      fromEnd: '2026-02-12', // scheduled end = the extension
      by: 'hr.amy',
    });

    const audit = getCollection<AuditLog>('audit');
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('employee.confirm');
    expect(audit[0].detail).toContain('Employee e19 confirmed in role after probation');
  });

  it('is a no-op for non-probation employees', () => {
    const e = seed(emp('e20', { status: 'resigned' }));
    expect(confirmEmployee(e, 'hr.amy')).toBeNull();
    expect(stored('e20').status).toBe('resigned');
    expect(getCollection<AuditLog>('audit')).toHaveLength(0);
  });

  it('confirm after extend keeps the full trail in order', () => {
    const e = seed(emp('e21'));
    const extended = extendProbation(e, '2026-02-12', 'hr.amy', 'Ramp-up')!;
    const confirmed = confirmEmployee(extended, 'hr.amy')!;
    expect(confirmed.probationHistory?.map((h) => h.action)).toEqual(['extended', 'confirmed']);
    expect(probationStatus(confirmed).active).toBe(false);
  });
});
