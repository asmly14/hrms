/**
 * Tenant lifecycle tests (audit-multitenant §lifecycle):
 *  - removeCompany: PDPA erasure — full tenant-key purge, directory removal,
 *    account cleanup, active-tenant/session safety, GLOBAL tombstone.
 *  - trialStatusOf + the login trial gate (lib/auth.ts).
 *  - auditImpersonation: the session-guarded seam tenantContext calls on
 *    SuperAdmin enter/exit (the React wiring is a thin guard + one call).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import {
  getCollection, setCollection, getCompanies, upsertCompany, getCompany,
  getActiveTenantId, setActiveTenantId, removeCompany, trialStatusOf,
  getSystemAudit, logSystemAudit, SYSTEM_AUDIT_KEY, MAX_AUDIT_ENTRIES,
} from '../db';
import { companySeedRecord } from '../tenants';
import { auditImpersonation, findUser, getSession, login, logout, seedUsers } from '../auth';
import type { Company, Employee } from '../types';

const CO_A = 'co-asm';
const CO_B = 'co-merdeka';

const emp = (id: string): Employee => ({
  id,
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

/** Count live storage keys under a tenant prefix. */
function tenantKeyCount(companyId: string): number {
  const prefix = `myhrms:t:${companyId}:`;
  let n = 0;
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) n += 1;
  }
  return n;
}

/** Append a legacy-plaintext account directly (verifyAndMigrate handles it). */
function appendPlaintextAccount(username: string, password: string, companyId: string): void {
  const users = JSON.parse(localStorage.getItem('hrms.users') ?? '[]') as unknown[];
  users.push({ id: `u-${username}`, username, password, role: 'Admin', companyId });
  localStorage.setItem('hrms.users', JSON.stringify(users));
}

function trialCompany(patch: Partial<Company>): Company {
  return {
    ...companySeedRecord(CO_A),
    id: 'co-trialco',
    code: 'TRL',
    name: 'Trial Co',
    status: 'trial',
    ...patch,
  };
}

beforeEach(() => {
  installLocalStorage();
  logout();
  setActiveTenantId(CO_A);
});

describe('removeCompany — PDPA tenant erasure', () => {
  it('purges every tenant-namespaced key, the directory record and the company accounts, and writes a global tombstone', () => {
    upsertCompany(companySeedRecord(CO_A));
    upsertCompany(companySeedRecord(CO_B));
    // Registry collections (core + module) in BOTH tenants.
    setCollection('employees', [emp('a1')], CO_A);
    setCollection('employees', [emp('b1')], CO_B);
    setCollection('contracts', [{ id: 'ct-1' }], CO_B);
    setCollection('attendance:rotations', [{ id: 'rot-1' }], CO_B);
    // Non-registry tenant keys: page-local pointer + the per-tenant seed flag.
    localStorage.setItem(`myhrms:t:${CO_B}:claims:actingAs`, '"b1"');
    localStorage.setItem(`myhrms:t:${CO_B}:seeded:v1`, new Date().toISOString());
    // Accounts: fixed demo accounts + one derived employee account per tenant.
    seedUsers();
    expect(findUser('admin2')?.companyId).toBe(CO_B);

    const doomedBefore = tenantKeyCount(CO_B);
    expect(doomedBefore).toBeGreaterThanOrEqual(5);

    const report = removeCompany(CO_B, 'superadmin (test)');

    expect(report).not.toBeNull();
    expect(report!.companyId).toBe(CO_B);
    expect(report!.companyName).toBe('Merdeka Manufacturing Sdn Bhd');
    expect(report!.removedKeys).toBe(doomedBefore);
    // admin2 + hr2 + the derived b1 employee account.
    expect(report!.removedUsers).toBe(3);

    // 1. Nothing survives under the tenant prefix — not even sub-keys.
    expect(tenantKeyCount(CO_B)).toBe(0);
    // 2. The other tenant is completely untouched.
    expect(getCollection<Employee>('employees', CO_A).map((e) => e.id)).toEqual(['a1']);
    expect(tenantKeyCount(CO_A)).toBeGreaterThan(0);
    // 3. Directory record gone.
    expect(getCompany(CO_B)).toBeUndefined();
    expect(getCompanies().map((c) => c.id)).toEqual([CO_A]);
    // 4. Company accounts gone; SuperAdmin + other tenants kept.
    expect(findUser('admin2')).toBeUndefined();
    expect(findUser('hr2')).toBeUndefined();
    expect(findUser('admin')?.companyId).toBe(CO_A);
    expect(findUser('superadmin')).toMatchObject({ role: 'SuperAdmin', companyId: null });

    // 5. GLOBAL tombstone: actor, company name, timestamp, key count.
    const sys = getSystemAudit();
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({
      actorName: 'superadmin (test)',
      action: 'company.delete',
      companyId: CO_B,
      companyName: 'Merdeka Manufacturing Sdn Bhd',
    });
    expect(sys[0]!.detail).toContain(`${doomedBefore} storage key`);
    expect(sys[0]!.detail).toContain('3 user accounts');
    expect(Number.isNaN(new Date(sys[0]!.at).getTime())).toBe(false);
  });

  it('resets the active-tenant pointer and drops a session pinned to the purged company', () => {
    upsertCompany(companySeedRecord(CO_A));
    upsertCompany(companySeedRecord(CO_B));
    setCollection('employees', [emp('b1')], CO_B);
    seedUsers();
    expect(login('admin2', 'admin123').ok).toBe(true);
    expect(getSession()?.companyId).toBe(CO_B);
    expect(getActiveTenantId()).toBe(CO_B);

    removeCompany(CO_B, 'superadmin');

    expect(getSession()).toBeNull();
    expect(getActiveTenantId()).toBeNull(); // system view — no resurrection writes
  });

  it('returns null for an unknown company and writes nothing', () => {
    upsertCompany(companySeedRecord(CO_A));
    const before = getCompanies().length;
    expect(removeCompany('co-nope', 'superadmin')).toBeNull();
    expect(getCompanies()).toHaveLength(before);
    expect(getSystemAudit()).toHaveLength(0);
  });
});

describe('trialStatusOf — trial badge math', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');

  it('computes whole days left for a live trial', () => {
    const ts = trialStatusOf({ status: 'trial', trialEndsAt: '2026-06-20T00:00:00.000Z' }, now);
    expect(ts).toMatchObject({ isTrial: true, expired: false, daysLeft: 5 });
    expect(ts.trialEndsAt).toBe('2026-06-20T00:00:00.000Z');
  });

  it('flags a past trial end as expired with 0 days left', () => {
    const ts = trialStatusOf({ status: 'trial', trialEndsAt: '2026-06-15T11:59:59.000Z' }, now);
    expect(ts).toMatchObject({ isTrial: true, expired: true, daysLeft: 0 });
  });

  it('never expires an open trial (no trialEndsAt) or an invalid clock', () => {
    expect(trialStatusOf({ status: 'trial' }, now)).toMatchObject({
      isTrial: true, daysLeft: null, expired: false,
    });
    expect(trialStatusOf({ status: 'trial', trialEndsAt: 'not-a-date' }, now)).toMatchObject({
      isTrial: true, daysLeft: null, expired: false,
    });
  });

  it('ignores trialEndsAt for non-trial companies', () => {
    const ts = trialStatusOf({ status: 'active', trialEndsAt: '2020-01-01T00:00:00.000Z' }, now);
    expect(ts).toMatchObject({ isTrial: false, daysLeft: null, expired: false });
  });
});

describe('trial expiry login gate (auth.login)', () => {
  it('blocks company users of an expired-trial tenant with a clear contact-support message', () => {
    upsertCompany(trialCompany({ trialEndsAt: '2020-01-01T00:00:00.000Z' }));
    appendPlaintextAccount('trial.admin', 'trial123', 'co-trialco');

    const res = login('trial.admin', 'trial123');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/trial for Trial Co has expired/i);
      expect(res.error).toMatch(/contact support/i);
    }
    expect(getSession()).toBeNull();
  });

  it('does not leak the trial state on a bad password', () => {
    upsertCompany(trialCompany({ trialEndsAt: '2020-01-01T00:00:00.000Z' }));
    appendPlaintextAccount('trial.admin', 'trial123', 'co-trialco');
    const res = login('trial.admin', 'wrong-pass');
    expect(res).toEqual({ ok: false, error: 'Invalid username or password.' });
  });

  it('lets a live (unexpired) trial tenant sign in', () => {
    upsertCompany(
      trialCompany({ trialEndsAt: new Date(Date.now() + 10 * 86_400_000).toISOString() }),
    );
    appendPlaintextAccount('trial.admin', 'trial123', 'co-trialco');
    expect(login('trial.admin', 'trial123').ok).toBe(true);
    expect(getSession()?.companyId).toBe('co-trialco');
  });

  it('lets an open trial (no clock) and non-trial tenants sign in regardless of stale dates', () => {
    upsertCompany(trialCompany({ trialEndsAt: undefined }));
    appendPlaintextAccount('open.admin', 'open123', 'co-trialco');
    expect(login('open.admin', 'open123').ok).toBe(true);

    upsertCompany(
      trialCompany({ id: 'co-activeco', status: 'active', trialEndsAt: '2020-01-01T00:00:00.000Z' }),
    );
    appendPlaintextAccount('active.admin', 'active123', 'co-activeco');
    expect(login('active.admin', 'active123').ok).toBe(true);
  });

  it('never blocks the SuperAdmin (companyId null)', () => {
    const res = login('superadmin', 'super123');
    expect(res.ok).toBe(true);
    expect(getSession()?.companyId).toBeNull();
  });
});

describe('impersonation audit trail (auth.auditImpersonation)', () => {
  it('writes superadmin.enter_company / superadmin.exit_company into the GLOBAL system audit', () => {
    upsertCompany(companySeedRecord(CO_A));
    expect(login('superadmin', 'super123').ok).toBe(true);

    auditImpersonation('enter', CO_A);
    auditImpersonation('exit', CO_A);

    const sys = getSystemAudit();
    expect(sys.map((e) => e.action)).toEqual([
      'superadmin.enter_company',
      'superadmin.exit_company',
    ]);
    expect(sys[0]).toMatchObject({
      actorName: 'superadmin',
      companyId: CO_A,
      companyName: 'ASM Tech Sdn Bhd',
    });
    expect(sys[1]!.detail).toContain('ASM Tech Sdn Bhd');
    // The trail is global — never written into the tenant's own audit log.
    expect(getCollection('audit', CO_A)).toHaveLength(0);
  });

  it('is guarded: regular company sessions cannot write impersonation events', () => {
    upsertCompany(companySeedRecord(CO_A));
    expect(login('admin', 'admin123').ok).toBe(true);
    auditImpersonation('enter', CO_A);
    auditImpersonation('exit', CO_A);
    expect(getSystemAudit()).toHaveLength(0);
  });

  it('no-ops with no session or an unknown company', () => {
    upsertCompany(companySeedRecord(CO_A));
    auditImpersonation('enter', CO_A); // logged out
    expect(login('superadmin', 'super123').ok).toBe(true);
    auditImpersonation('enter', 'co-nope'); // unknown tenant
    expect(getSystemAudit()).toHaveLength(0);
  });
});

describe('global system audit stream', () => {
  it('persists under myhrms:system:audit, survives tenant purge, and rotates at the cap', () => {
    upsertCompany(companySeedRecord(CO_B));
    logSystemAudit({ actorName: 'root', action: 'company.delete', companyId: CO_B, companyName: 'X' });
    removeCompany(CO_B, 'root');
    // Purge never touches the global stream (prefix is tenant-scoped).
    expect(getSystemAudit().length).toBe(2);
    expect(localStorage.getItem(SYSTEM_AUDIT_KEY)).not.toBeNull();

    // Rotation: capped at the newest MAX_AUDIT_ENTRIES.
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 10; i += 1) {
      logSystemAudit({ actorName: 'root', action: 'probe' });
    }
    expect(getSystemAudit().length).toBe(MAX_AUDIT_ENTRIES);
  });
});
