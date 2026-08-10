/**
 * Regression tests — attendance rotation plans are tenant-namespaced.
 *
 * Audit L1 (docs/research/audit-multitenant.md §isolation): rotation plans
 * used to persist under ONE global key `myhrms:attendance:rotations`, making
 * tenant A's plans readable/overwritable from tenant B. They now live under
 * `myhrms:t:<companyId>:attendance:rotations`; the legacy global key migrates
 * into the DEFAULT company (co-asm) namespace once, then is removed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from '../../../lib/__tests__/storageStub';
import { setActiveTenantId } from '../../../lib/db';
import { getRotations, saveRotations, type RotationPlan } from '../model';

const CO_A = 'co-asm';
const CO_B = 'co-merdeka';

const LEGACY_ROT_KEY = 'myhrms:attendance:rotations';
const rotKeyOf = (co: string) => `myhrms:t:${co}:attendance:rotations`;

/** db.ts global machinery keys that are allowed to exist (not leaks). */
const KNOWN_GLOBALS = new Set([
  'myhrms:companies',
  'myhrms:activeTenant',
  'myhrms:holidays',
  'myhrms:migrated:v2',
  'myhrms:seeded:v1',
]);

function keysOf(stub: Storage): string[] {
  const out: string[] = [];
  for (let i = 0; i < stub.length; i++) out.push(stub.key(i)!);
  return out;
}

/** Non-namespaced myhrms:* keys outside the db.ts global machinery. */
function globalLeaks(stub: Storage): string[] {
  return keysOf(stub).filter(
    (k) => k.startsWith('myhrms:') && !k.startsWith('myhrms:t:') && !KNOWN_GLOBALS.has(k),
  );
}

const plan = (id: string, employeeId: string): RotationPlan => ({
  id,
  name: `Plan ${id}`,
  shiftIds: ['shift-normal'],
  weeksEach: 2,
  anchorDate: '2024-01-01',
  employeeIds: [employeeId],
});

beforeEach(() => {
  installLocalStorage();
  setActiveTenantId(CO_A); // deterministic starting point for every test
});

describe('attendance rotations — tenant isolation', () => {
  it('writes under the tenant prefix, never the legacy global key', () => {
    const stub = installLocalStorage();
    saveRotations([plan('r1', 'emp-01')], CO_A);
    expect(stub.getItem(rotKeyOf(CO_A))).not.toBeNull();
    expect(stub.getItem(LEGACY_ROT_KEY)).toBeNull();
  });

  it('plans written in tenant A are invisible in tenant B (isolation)', () => {
    saveRotations([plan('r-a', 'emp-01')], CO_A);
    saveRotations([plan('r-b', 'mrd-01')], CO_B);
    expect(getRotations(CO_A).map((p) => p.id)).toEqual(['r-a']);
    expect(getRotations(CO_B).map((p) => p.id)).toEqual(['r-b']);
  });

  it('default reads/writes follow the ACTIVE tenant; B cannot overwrite A', () => {
    setActiveTenantId(CO_A);
    saveRotations([plan('r-a', 'emp-01')]);

    setActiveTenantId(CO_B);
    expect(getRotations()).toEqual([]); // A's plans not visible here
    saveRotations([plan('r-b', 'mrd-01')]); // B writes its own namespace

    setActiveTenantId(CO_A);
    expect(getRotations().map((p) => p.id)).toEqual(['r-a']); // untouched by B
  });
});

describe('legacy global key migration', () => {
  it('moves pre-multi-tenant plans into the default company (co-asm) namespace once', () => {
    const stub = installLocalStorage();
    stub.setItem(LEGACY_ROT_KEY, JSON.stringify([plan('legacy', 'emp-02')]));

    // First access migrates (read path).
    expect(getRotations(CO_A).map((p) => p.id)).toEqual(['legacy']);
    expect(stub.getItem(LEGACY_ROT_KEY)).toBeNull(); // global key removed
    expect(stub.getItem(rotKeyOf(CO_A))).not.toBeNull();

    // The migrated plans belong to co-asm only — tenant B must not see them.
    setActiveTenantId(CO_B);
    expect(getRotations()).toEqual([]);
  });

  it('write path also migrates, and never clobbers existing tenant data', () => {
    const stub = installLocalStorage();
    saveRotations([plan('tenant-wins', 'emp-03')], CO_A);
    // Leftover legacy key from a partial/crashed pre-tenant session.
    stub.setItem(LEGACY_ROT_KEY, JSON.stringify([plan('legacy-loser', 'emp-99')]));

    saveRotations([plan('tenant-wins', 'emp-03'), plan('r2', 'emp-04')], CO_A);

    expect(getRotations(CO_A).map((p) => p.id)).toEqual(['tenant-wins', 'r2']);
    expect(stub.getItem(LEGACY_ROT_KEY)).toBeNull();
  });

  it('is idempotent — a re-appearing legacy key migrates again but tenant data wins', () => {
    const stub = installLocalStorage();
    saveRotations([plan('tenant-wins', 'emp-03')], CO_A);

    stub.setItem(LEGACY_ROT_KEY, JSON.stringify([plan('late-legacy', 'emp-98')]));
    expect(getRotations(CO_A).map((p) => p.id)).toEqual(['tenant-wins']); // not clobbered
    expect(stub.getItem(LEGACY_ROT_KEY)).toBeNull(); // cleaned up again
    expect(getRotations(CO_A).map((p) => p.id)).toEqual(['tenant-wins']); // stable
  });
});

describe('no global keys remain after operations', () => {
  it('every myhrms:* key is tenant-namespaced or a known db.ts global', () => {
    const stub = installLocalStorage();
    // Seed a legacy leak, then exercise read + write paths in both tenants.
    stub.setItem(LEGACY_ROT_KEY, JSON.stringify([plan('legacy', 'emp-02')]));

    setActiveTenantId(CO_A);
    getRotations();
    saveRotations([plan('r-a', 'emp-01')]);
    setActiveTenantId(CO_B);
    saveRotations([plan('r-b', 'mrd-01')]);
    getRotations(CO_A);

    expect(globalLeaks(stub)).toEqual([]);
    expect(stub.getItem(LEGACY_ROT_KEY)).toBeNull();
  });
});
