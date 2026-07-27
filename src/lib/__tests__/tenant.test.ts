import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import {
  getCollection, setCollection, getCompanies, upsertCompany, getCompany,
  getActiveCompany, getActiveTenantId, setActiveTenantId, migrateLegacyData,
  nextEmployeeNo, logAudit, DEFAULT_COMPANY_ID, COMPANIES_KEY,
} from '../db';
import { companySeedRecord } from '../tenants';
import { login, logout, seedUsers, findUser, getSession, DEMO_PASSWORD } from '../auth';
import { buildTenantSeedData } from '../seed';
import { getClaimPolicy, getLeaveTopUps, getPayrollCutoff } from '../appSettings';
import type { Employee } from '../types';

const CO_A = 'co-asm';
const CO_B = 'co-merdeka';

const emp = (id: string, employeeNo?: string): Employee => ({
  id,
  employeeNo,
  name: `Person ${id}`,
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
});

beforeEach(() => {
  installLocalStorage();
  logout();
  setActiveTenantId(CO_A); // deterministic starting point for every test
});

describe('tenant-scoped storage', () => {
  it('physically namespaces keys per company', () => {
    const stub = installLocalStorage();
    setCollection('employees', [emp('e1')], CO_A);
    expect(stub.getItem(`myhrms:t:${CO_A}:employees`)).not.toBeNull();
    expect(stub.getItem('myhrms:employees')).toBeNull(); // no legacy key written
  });

  it('writes to company A are invisible in company B (isolation)', () => {
    setCollection('employees', [emp('a1')], CO_A);
    setCollection('employees', [emp('b1'), emp('b2')], CO_B);
    expect(getCollection<Employee>('employees', CO_A).map((e) => e.id)).toEqual(['a1']);
    expect(getCollection<Employee>('employees', CO_B)).toHaveLength(2);
  });

  it('default reads/writes follow the ACTIVE tenant', () => {
    setCollection('employees', [emp('a1')], CO_A);
    setCollection('employees', [emp('b1')], CO_B);

    setActiveTenantId(CO_A);
    expect(getCollection<Employee>('employees').map((e) => e.id)).toEqual(['a1']);

    setActiveTenantId(CO_B);
    expect(getCollection<Employee>('employees').map((e) => e.id)).toEqual(['b1']);

    setCollection('employees', [emp('b1'), emp('b2')]); // active = co-B
    expect(getCollection<Employee>('employees', CO_A)).toHaveLength(1); // A untouched
    expect(getCollection<Employee>('employees', CO_B)).toHaveLength(2);
  });

  it('holidays stay global (shared across tenants)', () => {
    const stub = installLocalStorage();
    setCollection('holidays', [{ id: 'h1' }], CO_A);
    expect(stub.getItem('myhrms:holidays')).not.toBeNull();
    setActiveTenantId(CO_B);
    expect(getCollection('holidays')).toHaveLength(1);
  });

  it('audit log is per-tenant', () => {
    logAudit({ actorName: 'A', action: 'x', entity: 'employees' }, CO_A);
    expect(getCollection('audit', CO_A)).toHaveLength(1);
    expect(getCollection('audit', CO_B)).toHaveLength(0);
  });
});

describe('legacy migration', () => {
  it('moves legacy single-tenant keys under co-asm and writes the flag', () => {
    const stub = installLocalStorage();
    stub.setItem('myhrms:employees', JSON.stringify([emp('legacy-1')]));
    stub.setItem('myhrms:settings', JSON.stringify([{ id: 'company' }]));

    migrateLegacyData();

    expect(stub.getItem('myhrms:employees')).toBeNull();
    expect(stub.getItem('myhrms:settings')).toBeNull();
    expect(getCollection<Employee>('employees', CO_A).map((e) => e.id)).toEqual(['legacy-1']);
    expect(getCollection('settings', CO_A)).toHaveLength(1);
    expect(stub.getItem('myhrms:migrated:v2')).not.toBeNull();
    // The ASM Tech company record is ensured in the global directory.
    expect(getCompany(CO_A)?.name).toBe('ASM Tech Sdn Bhd');
  });

  it('is idempotent and never clobbers existing tenant data', () => {
    const stub = installLocalStorage();
    // Pre-existing tenant data + a leftover legacy key (partial migration crash).
    setCollection('employees', [emp('tenant-wins')], CO_A);
    stub.setItem('myhrms:employees', JSON.stringify([emp('legacy-loser')]));

    migrateLegacyData();
    expect(getCollection<Employee>('employees', CO_A).map((e) => e.id)).toEqual(['tenant-wins']);
    expect(stub.getItem('myhrms:employees')).toBeNull(); // legacy cleaned up

    // Second run is a no-op even if legacy keys reappear.
    stub.setItem('myhrms:employees', JSON.stringify([emp('late-legacy')]));
    migrateLegacyData();
    expect(stub.getItem('myhrms:employees')).not.toBeNull(); // untouched (flag set)
    expect(getCollection<Employee>('employees', CO_A).map((e) => e.id)).toEqual(['tenant-wins']);
  });
});

describe('companies directory + nextEmployeeNo', () => {
  it('stores companies at the global key and resolves the active company', () => {
    upsertCompany(companySeedRecord(CO_A));
    upsertCompany(companySeedRecord(CO_B));
    expect(getCompanies()).toHaveLength(2);
    expect(localStorage.getItem(COMPANIES_KEY)).not.toBeNull();

    setActiveTenantId(CO_B);
    expect(getActiveCompany()?.id).toBe(CO_B);
    expect(getActiveCompany()?.config.workingWeek).toBe('fri-sat'); // JHR
    expect(getCompany(CO_A)?.config.workingWeek).toBe('sat-sun'); // KUL
  });

  it('upsertCompany updates in place (matched by id)', () => {
    upsertCompany(companySeedRecord(CO_A));
    const updated = { ...companySeedRecord(CO_A), status: 'suspended' as const };
    upsertCompany(updated);
    expect(getCompanies()).toHaveLength(1);
    expect(getCompany(CO_A)?.status).toBe('suspended');
  });

  it('nextEmployeeNo applies the company prefix and continues the sequence', () => {
    upsertCompany(companySeedRecord(CO_A)); // prefix 'ASM'
    upsertCompany(companySeedRecord(CO_B)); // prefix 'MRD'
    setCollection('employees', [emp('a1', 'ASM0001'), emp('a2', 'ASM0002'), emp('a3', 'ASM0007')], CO_A);
    expect(nextEmployeeNo(CO_A)).toBe('ASM0008');
    expect(nextEmployeeNo(CO_B)).toBe('MRD0001'); // independent sequence
  });
});

describe('tenant-aware auth', () => {
  it('seeds the superadmin account (cross-company, companyId null)', () => {
    const users = seedUsers();
    const sa = users.find((u) => u.username === 'superadmin');
    expect(sa).toMatchObject({ role: 'SuperAdmin', companyId: null });
    expect(sa?.employeeId).toBeUndefined();
  });

  it('fixed company accounts carry their companyId', () => {
    seedUsers();
    expect(findUser('admin')?.companyId).toBe(CO_A);
    expect(findUser('hr2')?.companyId).toBe(CO_B);
    expect(findUser('admin3')?.companyId).toBe('co-desa');
  });

  it('login resolves the user to their company and stores it in the session', () => {
    const res = login('admin', 'admin123');
    expect(res.ok).toBe(true);
    expect(getSession()).toMatchObject({ username: 'admin', companyId: CO_A });
    expect(getActiveTenantId()).toBe(CO_A);
  });

  it('superadmin session has no fixed company (system view), then enters a tenant', () => {
    const res = login('superadmin', 'super123');
    expect(res.ok).toBe(true);
    expect(getSession()?.companyId).toBeNull();
    expect(getActiveTenantId()).toBeNull(); // system view

    // Cross-tenant access: enter company B, read it, switch to company A.
    setCollection('employees', [emp('a1')], CO_A);
    setCollection('employees', [emp('b1')], CO_B);
    setActiveTenantId(CO_B);
    expect(getCollection<Employee>('employees').map((e) => e.id)).toEqual(['b1']);
    setActiveTenantId(CO_A);
    expect(getCollection<Employee>('employees').map((e) => e.id)).toEqual(['a1']);
  });

  it('employee accounts are derived per company with companyId set', () => {
    upsertCompany(companySeedRecord(CO_A));
    upsertCompany(companySeedRecord(CO_B));
    setCollection('employees', [emp('a-emp')], CO_A);
    setCollection('employees', [emp('b-emp')], CO_B);

    const users = seedUsers();
    const a = users.find((u) => u.employeeId === 'a-emp');
    const b = users.find((u) => u.employeeId === 'b-emp');
    expect(a).toMatchObject({ role: 'Employee', companyId: CO_A, password: DEMO_PASSWORD });
    expect(b).toMatchObject({ role: 'Employee', companyId: CO_B });

    // Each can only log into their own tenant.
    expect(login(a!.username, DEMO_PASSWORD).ok).toBe(true);
    expect(getSession()?.companyId).toBe(CO_A);
    expect(login(b!.username, DEMO_PASSWORD).ok).toBe(true);
    expect(getSession()?.companyId).toBe(CO_B);
  });
});

describe('per-tenant seed data', () => {
  it('co-asm keeps the original 30-employee dataset', () => {
    const data = buildTenantSeedData(CO_A)!;
    expect(data.company.name).toBe('ASM Tech Sdn Bhd');
    expect(data.collections.employees).toHaveLength(30);
    expect(data.collections.departments).toHaveLength(6);
    const e1 = (data.collections.employees as Employee[])[0];
    expect(e1).toMatchObject({ id: 'emp-01', name: 'Ahmad Faizal bin Razak', baseSalary: 12500 });
    expect(e1.employeeNo).toBe('ASM0001');
  });

  it('co-merdeka: 12 manufacturing employees, fri-sat rest days, JHR settings', () => {
    const data = buildTenantSeedData(CO_B)!;
    expect(data.company.name).toBe('Merdeka Manufacturing Sdn Bhd');
    expect(data.company.hqState).toBe('JHR');
    expect(data.company.config.workingWeek).toBe('fri-sat');
    expect(data.collections.employees).toHaveLength(12);
    const settings = (data.collections.settings as { hqState: string }[])[0];
    expect(settings.hqState).toBe('JHR');

    // Attendance rest-day markers must fall on Fri/Sat (fri-sat weekend).
    const attendance = data.collections.attendance as { date: string; status: string }[];
    const restDays = attendance.filter((a) => a.status === 'rest-day');
    expect(restDays.length).toBeGreaterThan(0);
    for (const r of restDays.slice(0, 25)) {
      const dow = new Date(`${r.date}T00:00:00`).getDay();
      expect([5, 6]).toContain(dow);
    }
    // Smaller companies get proportionally smaller samples.
    expect((data.collections.leaves as unknown[]).length).toBeLessThanOrEqual(8);
    expect((data.collections.claims as unknown[]).length).toBeLessThanOrEqual(10);
  });

  it('co-desa: 8 retail employees with employee numbers using the DESA prefix', () => {
    const data = buildTenantSeedData('co-desa')!;
    expect(data.company.name).toBe('Desa Retail Group');
    expect(data.collections.employees).toHaveLength(8);
    const employees = data.collections.employees as Employee[];
    expect(employees[0].employeeNo).toBe('DESA0001');
    expect(employees[7].employeeNo).toBe('DESA0008');
  });

  it('unknown company ids return null (no accidental seed)', () => {
    expect(buildTenantSeedData('co-nope')).toBeNull();
  });
});

describe('appSettings reads the ACTIVE tenant config', () => {
  it('layers Company.config under the settings docs', () => {
    // co-asm seed record: payrollCutoffDay 25, leaveTopUps {annual: 2}.
    upsertCompany(companySeedRecord(CO_A));
    setActiveTenantId(CO_A);
    expect(getPayrollCutoff().cutoffDay).toBe(25);
    expect(getLeaveTopUps().annual).toBe(2);

    // Settings doc overrides the company config for the same tenant.
    setCollection('settings', [{ id: 'ext:payroll', cutoffDay: 20 }], CO_A);
    expect(getPayrollCutoff().cutoffDay).toBe(20);
    setCollection('settings', [{ id: 'ext:leaveTopups', days: { annual: 5 } }], CO_A);
    expect(getLeaveTopUps().annual).toBe(5);

    // Switch tenant → different config, and tenant-A docs no longer visible.
    upsertCompany(companySeedRecord(CO_B)); // payrollCutoffDay 26
    setActiveTenantId(CO_B);
    expect(getPayrollCutoff().cutoffDay).toBe(26);
    expect(getLeaveTopUps().annual).toBe(0);
  });

  it('claim policy reads Company.config.claimPolicy as a base layer', () => {
    const co = companySeedRecord(CO_A);
    co.config.claimPolicy = { mileageRatePerKm: 1.1 };
    upsertCompany(co);
    setActiveTenantId(CO_A);
    expect(getClaimPolicy().mileageRatePerKm).toBe(1.1);
    setCollection('settings', [{ id: 'claimPolicy', mileageRatePerKm: 1.4 }], CO_A);
    expect(getClaimPolicy().mileageRatePerKm).toBe(1.4); // doc beats config
  });
});

describe('active tenant persistence', () => {
  it('defaults to co-asm when nothing was ever stored', () => {
    localStorage.removeItem('myhrms:activeTenant');
    expect(getActiveTenantId()).toBe(DEFAULT_COMPANY_ID);
  });

  it('system view (null) round-trips through storage', () => {
    setActiveTenantId(null);
    expect(getActiveTenantId()).toBeNull();
    setActiveTenantId(CO_A);
    expect(getActiveTenantId()).toBe(CO_A);
  });
});
