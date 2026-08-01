/**
 * Employee records engine tests: completeness calc, document expiry status,
 * salary-history % math, on-demand file creation, section CRUD persistence,
 * base-salary application and audit trails. Mirrors the lib test style with
 * the in-memory storage stub.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from '../../../../lib/__tests__/storageStub';
import { getCollection, setActiveTenantId, setCollection } from '../../../../lib/db';
import type { AuditLog, Employee } from '../../../../lib/types';
import {
  EMPLOYEE_RECORDS_COLLECTION,
  MAX_DOCUMENT_BYTES,
  acknowledgeDiscipline,
  addNote,
  buildSalaryChange,
  childReliefHint,
  documentExpiryStatus,
  expiringDocuments,
  getRecordFile,
  outstandingAssets,
  recordCompleteness,
  recordSalaryChange,
  removeDependent,
  returnAsset,
  salaryChangePercent,
  saveAcademic,
  saveDependent,
  saveDiscipline,
  saveDocument,
  saveEmergencyContact,
  saveAsset,
  type EmployeeRecordFile,
} from '@/lib/employeeRecords';

beforeEach(() => {
  installLocalStorage();
  setActiveTenantId('co-asm');
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function emp(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'emp-1',
    name: 'Ahmad Faizal',
    ic: '900101-01-1234',
    email: 'ahmad@example.com',
    phone: '012-3456789',
    departmentId: 'dept-eng',
    positionId: 'pos-swe',
    role: 'employee',
    joinDate: '2020-01-15',
    state: 'KUL',
    employmentType: 'full-time',
    status: 'active',
    baseSalary: 5000,
    maritalStatus: 'married',
    children: 2,
    bankName: 'Maybank',
    bankAccount: '1234567890',
    epfNo: 'EPF123',
    socsoNo: 'SOC123',
    taxNo: 'TAX123',
    isForeignWorker: false,
    dateOfBirth: '1990-01-01',
    gender: 'male',
    fixedAllowances: [],
    ...overrides,
  };
}

function files(): EmployeeRecordFile[] {
  return getCollection<EmployeeRecordFile>(EMPLOYEE_RECORDS_COLLECTION as never);
}

function auditLog(): AuditLog[] {
  return getCollection<AuditLog>('audit');
}

// ── Completeness ────────────────────────────────────────────────────────────

describe('recordCompleteness', () => {
  it('scores a fully documented employee at 100%', () => {
    const e = emp();
    saveEmergencyContact(e.id, { name: 'Siti', relation: 'Spouse', phone: '013-1112223' }, 'hr');
    saveAcademic(
      e.id,
      { level: 'Degree', institution: 'UM', course: 'CS', fromYear: 2008, toYear: 2012 },
      'hr',
    );
    saveDocument(e.id, { kind: 'IC', fileName: 'ic.pdf', sizeBytes: 1024 }, 'hr');

    const result = recordCompleteness(e, getRecordFile(e.id));
    expect(result.percent).toBe(100);
    expect(result.missing).toEqual([]);
    expect(result.items).toHaveLength(11);
  });

  it('flags missing core fields and file sections', () => {
    const e = emp({ ic: '', phone: '', bankAccount: '', epfNo: '', socsoNo: '', taxNo: '' });
    const result = recordCompleteness(e, undefined);
    expect(result.percent).toBe(18); // only dob + state pass
    expect(result.missing).toContain('NRIC / passport no.');
    expect(result.missing).toContain('Phone number');
    expect(result.missing).toContain('Bank account (salary credit)');
    expect(result.missing).toContain('EPF / KWSP number');
    expect(result.missing).toContain('Emergency contact');
    expect(result.missing).toContain('Academic qualification');
    expect(result.missing).toContain('IC document uploaded');
  });

  it('requires both bank name and account number', () => {
    const e = emp({ bankAccount: '' });
    const result = recordCompleteness(e, undefined);
    expect(result.items.find((i) => i.key === 'bank')!.ok).toBe(false);
  });
});

// ── Document expiry ─────────────────────────────────────────────────────────

describe('documentExpiryStatus', () => {
  const asOf = '2026-02-10';

  it('classifies none / valid / expiring / expired', () => {
    expect(documentExpiryStatus({}, asOf)).toEqual({ status: 'none', daysToExpiry: null });
    expect(documentExpiryStatus({ expiryDate: '2027-01-01' }, asOf).status).toBe('valid');
    // 60 days out → within the 90-day amber window
    const expiring = documentExpiryStatus({ expiryDate: '2026-04-11' }, asOf);
    expect(expiring.status).toBe('expiring');
    expect(expiring.daysToExpiry).toBe(60);
    // boundary: exactly 90 days is still "expiring"
    expect(documentExpiryStatus({ expiryDate: '2026-05-11' }, asOf).status).toBe('expiring');
    expect(documentExpiryStatus({ expiryDate: '2026-05-12' }, asOf).status).toBe('valid');
    // past → expired with negative day count
    const expired = documentExpiryStatus({ expiryDate: '2026-02-01' }, asOf);
    expect(expired.status).toBe('expired');
    expect(expired.daysToExpiry).toBe(-9);
  });
});

describe('expiringDocuments', () => {
  it('collects expiring + expired across files, soonest first', () => {
    const a = emp({ id: 'emp-a' });
    const b = emp({ id: 'emp-b' });
    saveDocument(a.id, { kind: 'Passport', fileName: 'pass.pdf', sizeBytes: 10, expiryDate: '2026-04-01' }, 'hr');
    saveDocument(a.id, { kind: 'IC', fileName: 'ic.pdf', sizeBytes: 10 }, 'hr'); // no expiry — skipped
    saveDocument(b.id, { kind: 'Work Permit', fileName: 'wp.pdf', sizeBytes: 10, expiryDate: '2026-01-01' }, 'hr'); // expired
    saveDocument(b.id, { kind: 'Medical', fileName: 'med.pdf', sizeBytes: 10, expiryDate: '2027-06-01' }, 'hr'); // valid — skipped

    const hits = expiringDocuments(files(), 90, '2026-02-10');
    expect(hits).toHaveLength(2);
    expect(hits[0]!.status).toBe('expired'); // soonest (most negative) first
    expect(hits[0]!.employeeId).toBe('emp-b');
    expect(hits[1]!.status).toBe('expiring');
    expect(hits[1]!.employeeId).toBe('emp-a');
  });
});

// ── Salary history math ─────────────────────────────────────────────────────

describe('salaryChangePercent', () => {
  it('computes signed percentage at 2dp', () => {
    expect(salaryChangePercent(5000, 5250)).toBe(5);
    expect(salaryChangePercent(4000, 3800)).toBe(-5);
    expect(salaryChangePercent(3333, 3500)).toBe(5.01);
    expect(salaryChangePercent(5000, 5000)).toBe(0);
  });

  it('guards zero / negative / non-finite base', () => {
    expect(salaryChangePercent(0, 5000)).toBe(0);
    expect(salaryChangePercent(-100, 5000)).toBe(0);
    expect(salaryChangePercent(Number.NaN, 5000)).toBe(0);
  });
});

describe('buildSalaryChange', () => {
  it('auto-fills previous from baseSalary and derives the percent', () => {
    const change = buildSalaryChange(emp(), {
      effectiveDate: '2026-01-01',
      newSalary: 5500,
      reason: 'annual-increment',
    });
    expect(change.previousSalary).toBe(5000);
    expect(change.newSalary).toBe(5500);
    expect(change.changePercent).toBe(10);
    expect(change.approvedBy).toBeUndefined();
  });
});

describe('recordSalaryChange', () => {
  it('appends to the file, audits, and leaves baseSalary untouched by default', () => {
    const e = emp();
    setCollection('employees', [e]);

    recordSalaryChange(
      e,
      { effectiveDate: '2026-01-01', newSalary: 5500, reason: 'promotion', applyToBaseSalary: false },
      'hr',
    );

    const file = getRecordFile(e.id)!;
    expect(file.salaryHistory).toHaveLength(1);
    expect(file.salaryHistory[0]).toMatchObject({
      previousSalary: 5000,
      newSalary: 5500,
      changePercent: 10,
      reason: 'promotion',
    });
    expect(getCollection<Employee>('employees')[0]!.baseSalary).toBe(5000);
    expect(auditLog().some((a) => a.action === 'records.salary.record')).toBe(true);
  });

  it('optionally updates the live baseSalary with a second audit entry', () => {
    const e = emp();
    setCollection('employees', [e]);

    recordSalaryChange(
      e,
      { effectiveDate: '2026-03-01', newSalary: 5300, reason: 'adjustment', applyToBaseSalary: true },
      'hr',
    );

    expect(getCollection<Employee>('employees')[0]!.baseSalary).toBe(5300);
    const actions = auditLog().map((a) => a.action);
    expect(actions).toContain('records.salary.record');
    expect(actions).toContain('employee.update');
  });
});

// ── File lifecycle + CRUD ───────────────────────────────────────────────────

describe('record file lifecycle', () => {
  it('creates one file per employee on demand and reuses it', () => {
    saveDependent(emp().id, { name: 'Aisyah', relation: 'Daughter', isChild: true }, 'hr');
    saveDependent(emp().id, { name: 'Siti', relation: 'Spouse', isChild: false }, 'hr');

    expect(files()).toHaveLength(1);
    const file = getRecordFile('emp-1')!;
    expect(file.dependents).toHaveLength(2);
    expect(file.createdAt).toBeTruthy();
    // creation + two mutations audited
    expect(auditLog().filter((a) => a.entity === EMPLOYEE_RECORDS_COLLECTION)).toHaveLength(3);
    expect(auditLog()[0]!.action).toBe('records.file.create');
  });

  it('updates an existing sub-record when id is provided', () => {
    const e = emp();
    saveEmergencyContact(e.id, { id: 'ec-1', name: 'Siti', relation: 'Spouse', phone: '013-111' }, 'hr');
    saveEmergencyContact(e.id, { id: 'ec-1', name: 'Siti', relation: 'Spouse', phone: '013-999' }, 'hr');

    const file = getRecordFile(e.id)!;
    expect(file.emergencyContacts).toHaveLength(1);
    expect(file.emergencyContacts[0]!.phone).toBe('013-999');
  });

  it('removes sub-records', () => {
    const e = emp();
    saveDependent(e.id, { id: 'd-1', name: 'Aisyah', relation: 'Daughter', isChild: true }, 'hr');
    removeDependent(e.id, 'd-1', 'Aisyah', 'hr');
    expect(getRecordFile(e.id)!.dependents).toHaveLength(0);
  });

  it('rejects documents over the size cap', () => {
    expect(() =>
      saveDocument(emp().id, { kind: 'CV', fileName: 'big.pdf', sizeBytes: MAX_DOCUMENT_BYTES + 1 }, 'hr'),
    ).toThrow(/limit/);
    expect(files()).toHaveLength(0);
  });
});

// ── Discipline acknowledgement, assets, notes ───────────────────────────────

describe('discipline / assets / notes', () => {
  it('acknowledgement stamps the record', () => {
    const e = emp();
    saveDiscipline(
      e.id,
      { id: 'dr-1', date: '2026-01-15', type: 'written-warning', subject: 'Late coming', detail: 'Third offence', issuedBy: 'HR' },
      'hr',
    );
    expect(getRecordFile(e.id)!.discipline[0]!.acknowledgedAt).toBeUndefined();

    acknowledgeDiscipline(e.id, 'dr-1', 'ahmad');
    expect(getRecordFile(e.id)!.discipline[0]!.acknowledgedAt).toBeTruthy();
  });

  it('asset issue → return feeds the outstanding list', () => {
    const e = emp();
    saveAsset(e.id, { id: 'as-1', item: 'MacBook Pro', serialNo: 'SN-1', issuedAt: '2025-01-01', condition: 'New' }, 'hr');
    saveAsset(e.id, { id: 'as-2', item: 'Access card', issuedAt: '2025-01-01', condition: 'Good' }, 'hr');
    expect(outstandingAssets(getRecordFile(e.id))).toHaveLength(2);

    returnAsset(e.id, 'as-1', 'MacBook Pro', 'hr', '2026-02-01');
    const outstanding = outstandingAssets(getRecordFile(e.id));
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]!.item).toBe('Access card');
  });

  it('notes keep author + date', () => {
    const e = emp();
    addNote(e.id, { date: '2026-02-10', author: 'HR', text: 'Confirmed in role.' }, 'hr');
    expect(getRecordFile(e.id)!.notes[0]).toMatchObject({ author: 'HR', text: 'Confirmed in role.' });
  });
});

// ── Child relief hint ───────────────────────────────────────────────────────

describe('childReliefHint', () => {
  it('compares isChild dependents with the employee children count', () => {
    const e = emp({ children: 2 });
    saveDependent(e.id, { name: 'A', relation: 'Daughter', isChild: true }, 'hr');
    const hint = childReliefHint(e, getRecordFile(e.id));
    expect(hint).toEqual({ fileChildren: 1, employeeChildren: 2, mismatch: true });
  });
});
