/**
 * Collection-registry unification tests (P1 — audit-database Phase 0).
 *
 * Covers the four registry guarantees:
 *  1. Every previously-bypassed module collection (lifecycle, orgChart,
 *     contracts, employeeRecords, onboardLinks, kpiEngine + the attendance
 *     rotations sub-key) is a first-class COLLECTIONS member.
 *  2. Module stores persist through the registry — same physical tenant keys,
 *     no private side-channels, no typed casts.
 *  3. exportTenantData covers every registry collection; importTenantData
 *     restores any registry collection and skips unknown keys with a report.
 *  4. logAudit rotates the per-tenant log to the newest MAX_AUDIT_ENTRIES.
 *  5. seedIfEmpty / seedTenantIfEmpty are awaitable — the returned promise
 *     resolves only after the seed-module import and all writes have landed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import {
  COLLECTIONS,
  MAX_AUDIT_ENTRIES,
  dbReady,
  exportTenantData,
  getCollection,
  importTenantData,
  logAudit,
  seedIfEmpty,
  seedTenantIfEmpty,
  setActiveTenantId,
  setCollection,
  tenantSeedFlag,
} from '../db';
import {
  CONTRACTS_COLLECTION,
  FEE_PAYMENTS_COLLECTION,
  renewContract,
  type EmploymentContract,
} from '../contracts';
import { EMPLOYEE_RECORDS_COLLECTION, mutateRecordFile } from '../employeeRecords';
import {
  ONBOARD_LINKS_KEY,
  ONBOARD_SUBMISSIONS_KEY,
  ONBOARDING_EXTRAS_KEY,
  createChecklistForEmployee,
  createOnboardLink,
} from '../onboardLinks';
import {
  CHECKINS_COLLECTION,
  CYCLES_COLLECTION,
  OBJECTIVES_COLLECTION,
  PIPS_COLLECTION,
} from '../kpiEngine';
import {
  getDepartmentProfiles,
  getPositionProfiles,
  upsertDepartmentProfile,
  upsertPositionProfile,
} from '../orgChart';

const CO_A = 'co-asm';
const CO_B = 'co-merdeka';

beforeEach(() => {
  installLocalStorage();
  setActiveTenantId(CO_A);
});

// ── 1. Registry membership ──────────────────────────────────────────────────

describe('collection registry membership', () => {
  it('includes every previously-bypassed module collection', () => {
    const registry = new Set<string>(COLLECTIONS);
    const expected = [
      // lifecycle
      'onboardingChecklists',
      'offboardingCases',
      // orgChart
      'positionProfiles',
      'departmentProfiles',
      // contracts
      'contracts',
      'contractFeePayments',
      // employeeRecords
      'employeeRecords',
      // onboardLinks
      'onboardLinks',
      'onboardSubmissions',
      'onboardingExtras',
      // kpiEngine
      'cycles',
      'objectives',
      'checkins',
      'pips',
      // attendance rotation plans (sub-key store, physical key
      // `myhrms:t:<companyId>:attendance:rotations`)
      'attendance:rotations',
    ];
    for (const name of expected) expect(registry.has(name), name).toBe(true);
  });

  it('every module store collection constant is a registry member', () => {
    const registry = new Set<string>(COLLECTIONS);
    const constants = [
      CONTRACTS_COLLECTION,
      FEE_PAYMENTS_COLLECTION,
      EMPLOYEE_RECORDS_COLLECTION,
      ONBOARD_LINKS_KEY,
      ONBOARD_SUBMISSIONS_KEY,
      ONBOARDING_EXTRAS_KEY,
      CYCLES_COLLECTION,
      OBJECTIVES_COLLECTION,
      CHECKINS_COLLECTION,
      PIPS_COLLECTION,
    ];
    for (const c of constants) expect(registry.has(c), c).toBe(true);
  });
});

// ── 2. Module stores flow through the registry ──────────────────────────────

describe('module stores flow through the registry', () => {
  it('orgChart profiles persist under the standard tenant keys (no private store)', () => {
    upsertPositionProfile('pos-1', { grade: 'L5' }, CO_A);
    upsertDepartmentProfile('dept-1', { color: '#b45309' }, CO_A);

    // Readable through the registry — identical physical keys.
    expect(getCollection('positionProfiles', CO_A)).toHaveLength(1);
    expect(getCollection('departmentProfiles', CO_A)).toHaveLength(1);
    expect(localStorage.getItem(`myhrms:t:${CO_A}:positionProfiles`)).not.toBeNull();
    expect(localStorage.getItem(`myhrms:t:${CO_A}:departmentProfiles`)).not.toBeNull();

    // Module getters and the registry agree (single store, not two).
    expect(getPositionProfiles(CO_A)[0]).toMatchObject({ positionId: 'pos-1', grade: 'L5' });
    expect(getDepartmentProfiles(CO_A)[0]).toMatchObject({ departmentId: 'dept-1' });

    // Tenant isolation holds through the registry path.
    expect(getCollection('positionProfiles', CO_B)).toHaveLength(0);
    expect(getCollection('departmentProfiles', CO_B)).toHaveLength(0);
  });

  it('lifecycle checklists land in the onboardingChecklists registry collection', () => {
    createChecklistForEmployee('emp-x', '2025-07-01', 'full-time', CO_A);
    const all = getCollection<{ employeeId: string; template: string }>('onboardingChecklists', CO_A);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ employeeId: 'emp-x', template: 'standard' });
    expect(getCollection('onboardingChecklists', CO_B)).toHaveLength(0);
  });

  it('contracts mutations flow through the registry', () => {
    const contract: EmploymentContract = {
      id: 'ct-1',
      kind: 'of-service',
      title: 'Software Engineer',
      refNo: 'ASM-CT-2024-001',
      party: { companySigner: 'Datin Aisha Rahman' },
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      status: 'active',
      remuneration: { mode: 'monthly-salary', amount: 5000, currency: 'MYR' },
      terms: { ipClause: true, confidentiality: true },
      statutoryApplies: true,
      version: 1,
      createdAt: '2024-01-01T09:00:00.000Z',
    };
    setCollection(CONTRACTS_COLLECTION, [contract], CO_A);

    const draft = renewContract('ct-1', 'HR Admin', '2025-06-15');
    expect(draft).toBeDefined();

    const all = getCollection<EmploymentContract>(CONTRACTS_COLLECTION, CO_A);
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.id === 'ct-1')?.status).toBe('renewed');
    expect(all.find((c) => c.id === draft!.id)?.version).toBe(2);
  });

  it('employeeRecords mutations write the registry collection', () => {
    mutateRecordFile(
      'emp-1',
      (file) => file,
      { action: 'records.note.add', detail: 'Registry test', actorName: 'HR Admin' },
    );
    const all = getCollection<{ employeeId: string }>(EMPLOYEE_RECORDS_COLLECTION, CO_A);
    expect(all).toHaveLength(1);
    expect(all[0].employeeId).toBe('emp-1');
  });

  it('onboardLinks creation writes the registry collection', () => {
    createOnboardLink({ label: 'Ahmad (pending hire)', companyId: CO_A, createdBy: 'HR Admin' });
    const links = getCollection<{ label: string }>(ONBOARD_LINKS_KEY, CO_A);
    expect(links).toHaveLength(1);
    expect(links[0].label).toContain('Ahmad');
  });
});

// ── 3. Registry-wide export / import ────────────────────────────────────────

describe('registry-wide export', () => {
  it('exportTenantData covers EVERY registry collection automatically', () => {
    setCollection('employees', [{ id: 'emp-9' }], CO_A);
    setCollection('contracts', [{ id: 'ct-9' }], CO_A);
    setCollection('cycles', [{ id: 'cy-9' }], CO_A);
    setCollection('attendance:rotations', [{ id: 'rot-9' }], CO_A);

    const data = exportTenantData(CO_A);
    // The export map keys are exactly the registry — no hardcoded subset.
    expect(Object.keys(data).sort()).toEqual([...COLLECTIONS].sort());
    expect(data.employees).toEqual([{ id: 'emp-9' }]);
    expect(data.contracts).toEqual([{ id: 'ct-9' }]);
    expect(data.cycles).toEqual([{ id: 'cy-9' }]);
    // The rotations sub-key store is now exportable under its registry name.
    expect(data['attendance:rotations']).toEqual([{ id: 'rot-9' }]);
    // Module collections with no data export as empty arrays, not omissions.
    expect(data.pips).toEqual([]);
    expect(data.onboardingExtras).toEqual([]);
  });
});

describe('registry-wide import', () => {
  it('replace restores any registry collection and reports unknown keys', () => {
    const report = importTenantData(
      {
        contracts: [{ id: 'ct-1' }],
        offboardingCases: [{ id: 'ob-1' }],
        'attendance:rotations': [{ id: 'rot-1' }],
        bogusCollection: [{ id: 'x' }],
      },
      CO_A,
      'replace',
    );
    expect(report.touched).toBe(3);
    expect(report.rows).toBe(3);
    expect(report.skipped).toEqual(['bogusCollection']);
    expect(getCollection('contracts', CO_A)).toEqual([{ id: 'ct-1' }]);
    expect(getCollection('offboardingCases', CO_A)).toEqual([{ id: 'ob-1' }]);
    // Import writes the exact physical sub-key the attendance store reads.
    expect(localStorage.getItem(`myhrms:t:${CO_A}:attendance:rotations`)).toBe(
      JSON.stringify([{ id: 'rot-1' }]),
    );
  });

  it('merge upserts by id and keeps rows the file does not mention', () => {
    setCollection(
      'employeeRecords',
      [
        { id: 'f1', employeeId: 'e1' },
        { id: 'f2', employeeId: 'e2' },
      ],
      CO_A,
    );
    const report = importTenantData(
      {
        employeeRecords: [
          { id: 'f2', employeeId: 'e2', flagged: true },
          { id: 'f3', employeeId: 'e3' },
        ],
      },
      CO_A,
      'merge',
    );
    expect(report.touched).toBe(1);
    expect(report.rows).toBe(2);
    const all = getCollection<{ id: string; flagged?: boolean }>('employeeRecords', CO_A);
    expect(all.map((f) => f.id).sort()).toEqual(['f1', 'f2', 'f3']);
    expect(all.find((f) => f.id === 'f2')?.flagged).toBe(true);
  });

  it('import targets the given tenant and never leaks sideways', () => {
    importTenantData({ contracts: [{ id: 'ct-b' }] }, CO_B, 'replace');
    expect(getCollection('contracts', CO_B)).toHaveLength(1);
    expect(getCollection('contracts', CO_A)).toHaveLength(0);
  });

  it('holidays import writes the shared global key (law is national)', () => {
    importTenantData({ holidays: [{ id: 'h1', date: '2025-01-01' }] }, CO_B, 'replace');
    expect(localStorage.getItem('myhrms:holidays')).not.toBeNull();
    expect(getCollection('holidays', CO_A)).toHaveLength(1); // visible from any tenant
  });
});

// ── 4. Audit rotation ───────────────────────────────────────────────────────

describe('audit rotation', () => {
  it('caps the per-tenant log at MAX_AUDIT_ENTRIES, keeping the newest', () => {
    const backlog = Array.from({ length: MAX_AUDIT_ENTRIES }, (_, i) => ({
      id: `old-${i}`,
      at: '2025-01-01T00:00:00.000Z',
      actorName: 'System',
      action: 'seed.bulk',
      entity: 'settings',
    }));
    setCollection('audit', backlog, CO_A);

    logAudit({ actorName: 'HR Admin', action: 'test.append', entity: 'settings', detail: 'newest' }, CO_A);

    const all = getCollection<{ id: string; action: string }>('audit', CO_A);
    expect(all).toHaveLength(MAX_AUDIT_ENTRIES);
    expect(all[all.length - 1].action).toBe('test.append'); // newest kept
    expect(all[0].id).toBe('old-1'); // oldest entry trimmed
  });

  it('appends without trimming while under the cap', () => {
    logAudit({ actorName: 'A', action: 'one', entity: 'employees' }, CO_A);
    logAudit({ actorName: 'A', action: 'two', entity: 'employees' }, CO_A);
    const all = getCollection<{ action: string }>('audit', CO_A);
    expect(all.map((a) => a.action)).toEqual(['one', 'two']);
  });
});

// ── 5. Awaited seeding (seed race fix) ──────────────────────────────────────

describe('awaited seeding (seed race fix)', () => {
  it('seedIfEmpty resolves only after all demo-tenant writes have landed', async () => {
    await seedIfEmpty(true);
    // Reads immediately after the await must see the seeded data.
    expect(getCollection('employees', CO_A)).toHaveLength(30);
    expect(getCollection('employees', CO_B)).toHaveLength(12);
    expect(localStorage.getItem(tenantSeedFlag(CO_A))).not.toBeNull();
  });

  it('seedTenantIfEmpty resolves after writes for a known demo tenant', async () => {
    await seedTenantIfEmpty(CO_B, true);
    expect(getCollection('employees', CO_B)).toHaveLength(12);
    expect(localStorage.getItem(tenantSeedFlag(CO_B))).not.toBeNull();
  });

  it('unknown tenants get an initialized namespace covering EVERY registry collection', async () => {
    await seedTenantIfEmpty('co-newco');
    for (const name of COLLECTIONS) {
      if (name === 'holidays') continue; // global — never tenant-initialized
      expect(
        localStorage.getItem(`myhrms:t:co-newco:${name}`),
        `collection ${name} should be initialized`,
      ).not.toBeNull();
    }
    expect(localStorage.getItem(tenantSeedFlag('co-newco'))).not.toBeNull();
  });

  it('dbReady() is an awaitable handle for the module-bottom auto-seed', async () => {
    // In node tests the storage stub is installed after module import, so the
    // auto-seed never fired and dbReady resolves immediately.
    await expect(dbReady()).resolves.toBeUndefined();
  });
});
