/**
 * Regression tests — the claims "acting as" demo pointer is tenant-namespaced.
 *
 * Audit L2 (docs/research/audit-multitenant.md §isolation): the pointer used
 * to persist under ONE global key `myhrms:claims:actingAs`, so it could
 * reference another tenant's employee after a company switch. It now lives
 * under `myhrms:t:<companyId>:claims:actingAs`; the legacy global key
 * migrates into the DEFAULT company (co-asm) namespace once, then is removed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from '../../../lib/__tests__/storageStub';
import { setActiveTenantId } from '../../../lib/db';
import { getActingAsId, setActingAsId } from '../actingAsStorage';

const CO_A = 'co-asm';
const CO_B = 'co-merdeka';

const LEGACY_KEY = 'myhrms:claims:actingAs';
const keyOf = (co: string) => `myhrms:t:${co}:claims:actingAs`;

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

function globalLeaks(stub: Storage): string[] {
  return keysOf(stub).filter(
    (k) => k.startsWith('myhrms:') && !k.startsWith('myhrms:t:') && !KNOWN_GLOBALS.has(k),
  );
}

beforeEach(() => {
  installLocalStorage();
  setActiveTenantId(CO_A); // deterministic starting point for every test
});

describe('claims acting-as pointer — tenant isolation', () => {
  it('writes under the tenant prefix, never the legacy global key', () => {
    const stub = installLocalStorage();
    setActingAsId('emp-13', CO_A);
    expect(stub.getItem(keyOf(CO_A))).toBe('emp-13');
    expect(stub.getItem(LEGACY_KEY)).toBeNull();
  });

  it('a pointer stored in tenant A is invisible in tenant B', () => {
    setActingAsId('emp-13', CO_A);
    setActingAsId('mrd-03', CO_B);
    expect(getActingAsId(CO_A)).toBe('emp-13');
    expect(getActingAsId(CO_B)).toBe('mrd-03');

    setActiveTenantId(CO_A);
    expect(getActingAsId()).toBe('emp-13');
    setActiveTenantId(CO_B);
    expect(getActingAsId()).toBe('mrd-03');
  });
});

describe('legacy global key migration', () => {
  it('moves the pre-multi-tenant pointer into the default company (co-asm) namespace once', () => {
    const stub = installLocalStorage();
    stub.setItem(LEGACY_KEY, 'emp-13');

    // First access migrates (read path).
    expect(getActingAsId(CO_A)).toBe('emp-13');
    expect(stub.getItem(LEGACY_KEY)).toBeNull(); // global key removed

    // The pointer belongs to co-asm only — tenant B must not see it.
    expect(getActingAsId(CO_B)).toBeNull();
    setActiveTenantId(CO_B);
    expect(getActingAsId()).toBeNull();
  });

  it('write path also migrates; existing tenant value wins and is never clobbered', () => {
    const stub = installLocalStorage();
    setActingAsId('emp-07', CO_A);
    stub.setItem(LEGACY_KEY, 'emp-99'); // leftover from a crashed pre-tenant session

    expect(getActingAsId(CO_A)).toBe('emp-07');
    expect(stub.getItem(LEGACY_KEY)).toBeNull();

    // Idempotent: a re-appearing legacy key migrates again, tenant value wins.
    stub.setItem(LEGACY_KEY, 'emp-98');
    expect(getActingAsId(CO_A)).toBe('emp-07');
    expect(stub.getItem(LEGACY_KEY)).toBeNull();
  });
});

describe('no global keys remain after operations', () => {
  it('every myhrms:* key is tenant-namespaced or a known db.ts global', () => {
    const stub = installLocalStorage();
    stub.setItem(LEGACY_KEY, 'emp-13'); // seed a legacy leak

    setActiveTenantId(CO_A);
    getActingAsId();
    setActingAsId('emp-05');
    setActiveTenantId(CO_B);
    setActingAsId('mrd-02');

    expect(globalLeaks(stub)).toEqual([]);
    expect(stub.getItem(LEGACY_KEY)).toBeNull();
  });
});
