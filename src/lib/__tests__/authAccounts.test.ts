/**
 * Account lifecycle management — login gates (disabled block + no-leak),
 * lastLoginAt stamping, and the public Admin API (create / status / role /
 * reset / remove / list) incl. guards (self, last-active-admin, SuperAdmin)
 * and the employee-form account linkage helper.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './storageStub';
import { getCollection, logAudit, saveCompanies, setActiveTenantId, setCollection } from '../db';
import {
  accountForEmployee,
  createUserAccount,
  findUser,
  findUserById,
  generatePassword,
  getSession,
  listCompanyUsers,
  login,
  logout,
  removeUserAccount,
  resetUserPassword,
  seedUsers,
  setUserRole,
  setUserStatus,
  statusOf,
  suggestUsername,
  validatePassword,
  validateUsername,
  type UserAccount,
} from '../auth';
import { attemptAccountCreation, emptyAccountForm } from '@/pages/employees/accountForm';
import { COMPANY_ID_ASM, COMPANY_ID_MERDEKA, demoCompanyRecords } from '../tenants';
import type { AuditLog } from '../types';

const CO_A = COMPANY_ID_ASM;
const CO_B = COMPANY_ID_MERDEKA;

const auditTrail = (companyId: string = CO_A) => getCollection<AuditLog>('audit', companyId);
const lastAudit = (companyId: string = CO_A) => auditTrail(companyId).at(-1);

/** Directly inject a raw account into the directory (legacy fixtures). */
function injectRawAccount(account: UserAccount): void {
  const users = JSON.parse(localStorage.getItem('hrms.users') ?? '[]') as UserAccount[];
  localStorage.setItem('hrms.users', JSON.stringify([...users, account]));
}

beforeEach(() => {
  installLocalStorage();
  logout();
  setActiveTenantId(CO_A);
  saveCompanies(demoCompanyRecords()); // createUserAccount validates the tenant
  seedUsers(); // fixed demo accounts (admin/hr/managers/superadmin, …)
});

describe('account model', () => {
  it('treats legacy accounts without a status field as active', () => {
    expect(statusOf({})).toBe('active');
    expect(statusOf({ status: 'active' })).toBe('active');
    expect(statusOf({ status: 'disabled' })).toBe('disabled');
  });

  it('a legacy plaintext account without status can still log in (migrated to hash)', () => {
    injectRawAccount({
      id: 'user-legacy',
      username: 'legacy.user',
      password: 'legacy123', // pre-hashing storage format
      role: 'Employee',
      companyId: CO_A,
      // no status, no passwordHash
    });
    const res = login('legacy.user', 'legacy123');
    expect(res.ok).toBe(true);
    const stored = findUser('legacy.user');
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored?.password).toBeUndefined();
  });
});

describe('login gates', () => {
  it('blocks a disabled account with a clear message', () => {
    const created = createUserAccount(
      { username: 'disabled.user', password: 'secret123', role: 'Employee', companyId: CO_A },
      'admin',
    );
    expect(created.ok).toBe(true);
    setUserStatus(created.ok ? created.user.id : '', 'disabled', 'admin');

    const res = login('disabled.user', 'secret123');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Your access has been disabled. Contact your HR/admin.');
    expect(getSession()).toBeNull();
  });

  it('never leaks disabled status to a wrong-password guess', () => {
    const created = createUserAccount(
      { username: 'stealth.user', password: 'secret123', role: 'Employee', companyId: CO_A },
      'admin',
    );
    setUserStatus(created.ok ? created.user.id : '', 'disabled', 'admin');

    const res = login('stealth.user', 'wrong-password');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Invalid username or password.');
  });

  it('stamps lastLoginAt on successful login', () => {
    const before = findUser('hr')?.lastLoginAt;
    expect(before).toBeUndefined();
    const res = login('hr', 'hr123');
    expect(res.ok).toBe(true);
    const after = findUser('hr')?.lastLoginAt;
    expect(after).toBeTruthy();
    expect(after).toBe(getSession()?.loginAt);
  });

  it('does not stamp lastLoginAt on failed or blocked logins', () => {
    login('hr', 'wrong-password');
    expect(findUser('hr')?.lastLoginAt).toBeUndefined();
    setUserStatus(findUser('hr')!.id, 'disabled', 'admin');
    login('hr', 'hr123');
    expect(findUser('hr')?.lastLoginAt).toBeUndefined();
  });
});

describe('createUserAccount', () => {
  it('creates an active bcrypt-hashed account and audits it (no password in audit)', () => {
    const res = createUserAccount(
      { username: 'new.starter', password: 'pw123456', role: 'Employee', companyId: CO_A, employeeId: 'emp-99' },
      'admin',
    );
    expect(res.ok).toBe(true);
    const stored = findUser('new.starter');
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored?.password).toBeUndefined();
    expect(stored?.status).toBe('active');
    expect(stored?.employeeId).toBe('emp-99');
    // Credential-free public shape.
    if (res.ok) {
      expect('passwordHash' in res.user).toBe(false);
      expect('password' in res.user).toBe(false);
    }
    const log = lastAudit();
    expect(log?.action).toBe('user.create');
    expect(log?.actorName).toBe('admin');
    expect(log?.detail).toContain('new.starter');
    expect(log?.detail).not.toContain('pw123456');
  });

  it('rejects a duplicate username — including one taken in ANOTHER company', () => {
    // 'admin2' is a Merdeka account; usernames are global across tenants.
    const res = createUserAccount(
      { username: 'admin2', password: 'pw123456', role: 'HR', companyId: CO_A },
      'admin',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already taken/i);
  });

  it('validates username and password format', () => {
    expect(createUserAccount({ username: 'ab', password: 'pw123456', role: 'Employee', companyId: CO_A }, 'admin')).toMatchObject({ ok: false });
    expect(createUserAccount({ username: 'bad name!', password: 'pw123456', role: 'Employee', companyId: CO_A }, 'admin')).toMatchObject({ ok: false });
    expect(createUserAccount({ username: 'ok.name', password: '12345', role: 'Employee', companyId: CO_A }, 'admin')).toMatchObject({ ok: false });
    // Uppercase input is normalized to lowercase rather than rejected.
    const normalized = createUserAccount({ username: 'UPPER.Case', password: 'pw123456', role: 'Employee', companyId: CO_A }, 'admin');
    expect(normalized.ok).toBe(true);
    if (normalized.ok) expect(normalized.user.username).toBe('upper.case');
    expect(validateUsername('good.name-1')).toBeNull();
    expect(validatePassword('123456')).toBeNull();
  });

  it('rejects SuperAdmin creation and unknown companies', () => {
    const sup = createUserAccount({ username: 'evil.root', password: 'pw123456', role: 'SuperAdmin', companyId: CO_A }, 'admin');
    expect(sup.ok).toBe(false);
    const ghost = createUserAccount({ username: 'ghost.user', password: 'pw123456', role: 'Employee', companyId: 'co-nope' }, 'admin');
    expect(ghost.ok).toBe(false);
  });

  it('suggestUsername derives the email prefix and namespaces collisions', () => {
    expect(suggestUsername('Fresh.Person@asmtech.my')).toBe('fresh.person');
    // Collision with the seeded admin account → suffixed with company code.
    expect(suggestUsername('admin@asmtech.my', 'ASM')).toBe('admin.asm');
    expect(generatePassword()).toHaveLength(10);
    expect(validatePassword(generatePassword())).toBeNull();
  });
});

describe('setUserStatus', () => {
  const makeUser = (username: string, role: 'Employee' | 'Admin' = 'Employee') => {
    const res = createUserAccount({ username, password: 'pw123456', role, companyId: CO_A }, 'admin');
    if (!res.ok) throw new Error('setup failed');
    return res.user;
  };

  it('disable blocks login; re-enable restores it (both audited)', () => {
    const u = makeUser('toggle.user');
    expect(setUserStatus(u.id, 'disabled', 'admin').ok).toBe(true);
    expect(login('toggle.user', 'pw123456').ok).toBe(false);
    expect(lastAudit()?.action).toBe('user.disable');

    expect(setUserStatus(u.id, 'active', 'admin').ok).toBe(true);
    expect(login('toggle.user', 'pw123456').ok).toBe(true);
    expect(lastAudit()?.action).toBe('user.enable');
  });

  it('cannot disable your own account (actor name or live session)', () => {
    const admin = findUser('admin')!;
    const byName = setUserStatus(admin.id, 'disabled', 'admin');
    expect(byName.ok).toBe(false);
    if (!byName.ok) expect(byName.error).toMatch(/own account/i);

    login('admin', 'admin123');
    const bySession = setUserStatus(admin.id, 'disabled', 'someone-else');
    expect(bySession.ok).toBe(false);
    logout();
  });

  it('cannot disable the LAST active Admin of a company', () => {
    const admin = findUser('admin')!; // sole Admin of co-asm
    const res = setUserStatus(admin.id, 'disabled', 'hr');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/last active Admin/i);

    // With a second Admin in place the first one CAN be disabled.
    const second = makeUser('admin.backup', 'Admin');
    expect(setUserStatus(admin.id, 'disabled', 'hr').ok).toBe(true);
    // …but now the second one is the last active Admin and is protected.
    expect(setUserStatus(second.id, 'disabled', 'hr').ok).toBe(false);
  });

  it('protects the SuperAdmin account', () => {
    const sup = findUser('superadmin')!;
    const res = setUserStatus(sup.id, 'disabled', 'admin');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/SuperAdmin/);
  });
});

describe('setUserRole', () => {
  it('changes the role and audits it', () => {
    const hr = findUser('hr')!;
    const res = setUserRole(hr.id, 'Manager', 'admin');
    expect(res.ok).toBe(true);
    expect(findUser('hr')?.role).toBe('Manager');
    const log = lastAudit();
    expect(log?.action).toBe('user.role_change');
    expect(log?.detail).toContain('HR');
    expect(log?.detail).toContain('Manager');
  });

  it('blocks demoting the last active Admin and SuperAdmin assignment', () => {
    const admin = findUser('admin')!;
    expect(setUserRole(admin.id, 'Employee', 'hr').ok).toBe(false);
    expect(setUserRole(findUser('hr')!.id, 'SuperAdmin', 'admin').ok).toBe(false);
    expect(setUserRole(findUser('superadmin')!.id, 'Admin', 'admin').ok).toBe(false);
  });
});

describe('resetUserPassword', () => {
  it('resets to a bcrypt hash (old password dies, new works) and audits WITHOUT the password', () => {
    const emp = findUser('hr')!;
    const res = resetUserPassword(emp.id, 'brand-new-pw', 'admin');
    expect(res.ok).toBe(true);
    expect(findUser('hr')?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(login('hr', 'hr123').ok).toBe(false);
    expect(login('hr', 'brand-new-pw').ok).toBe(true);
    const log = lastAudit();
    expect(log?.action).toBe('user.reset_password');
    expect(log?.detail).not.toContain('brand-new-pw');
  });

  it('rejects short passwords and protects SuperAdmin', () => {
    expect(resetUserPassword(findUser('hr')!.id, '12345', 'admin').ok).toBe(false);
    expect(resetUserPassword(findUser('superadmin')!.id, 'pw123456', 'admin').ok).toBe(false);
  });
});

describe('removeUserAccount', () => {
  it('removes only the account — the employee record is untouched', () => {
    setCollection('employees', [
      {
        id: 'emp-x1', name: 'Removed Login', ic: '900101-14-5566', email: 'removed.login@asmtech.my',
        phone: '+6012-1112222', departmentId: 'd1', positionId: 'p1', role: 'employee',
        joinDate: '2024-01-15', state: 'KUL', employmentType: 'full-time', status: 'active',
        baseSalary: 4000, maritalStatus: 'single', children: 0, bankName: 'Maybank',
        bankAccount: '123', epfNo: '12345678', socsoNo: '', taxNo: '', isForeignWorker: false,
        dateOfBirth: '1990-01-01', gender: 'female', fixedAllowances: [],
      },
    ], CO_A);
    const created = createUserAccount(
      { username: 'removed.login', password: 'pw123456', role: 'Employee', companyId: CO_A, employeeId: 'emp-x1' },
      'admin',
    );
    expect(created.ok).toBe(true);

    const res = removeUserAccount(created.ok ? created.user.id : '', 'admin');
    expect(res.ok).toBe(true);
    expect(findUser('removed.login')).toBeUndefined();
    expect(getCollection<{ id: string }>('employees', CO_A).some((e) => e.id === 'emp-x1')).toBe(true);
    const log = lastAudit();
    expect(log?.action).toBe('user.remove');
    expect(log?.detail).toMatch(/employee record is kept/i);
  });

  it('guards: self-removal, last active Admin and SuperAdmin are blocked', () => {
    const admin = findUser('admin')!;
    expect(removeUserAccount(admin.id, 'admin').ok).toBe(false); // self
    expect(removeUserAccount(admin.id, 'hr').ok).toBe(false); // last active Admin of co-asm
    expect(removeUserAccount(findUser('superadmin')!.id, 'admin').ok).toBe(false); // protected
    expect(findUser('admin')).toBeDefined();
  });

  it('accounts of other companies are unaffected', () => {
    const created = createUserAccount({ username: 'gone.user', password: 'pw123456', role: 'Employee', companyId: CO_A }, 'admin');
    removeUserAccount(created.ok ? created.user.id : '', 'admin');
    expect(listCompanyUsers(CO_B).map((u) => u.username)).toContain('admin2');
  });
});

describe('listCompanyUsers / accountForEmployee', () => {
  it('lists only the company’s accounts, credential-free', () => {
    const users = listCompanyUsers(CO_A);
    expect(users.map((u) => u.username)).toContain('admin');
    expect(users.map((u) => u.username)).not.toContain('admin2'); // Merdeka
    expect(users.map((u) => u.username)).not.toContain('superadmin'); // system
    for (const u of users) {
      expect('passwordHash' in u).toBe(false);
      expect('password' in u).toBe(false);
    }
  });

  it('resolves the account linked to an employee', () => {
    expect(accountForEmployee('emp-01')?.username).toBe('ahmad.faizal');
    expect(accountForEmployee('emp-nope')).toBeUndefined();
  });
});

describe('employee-form account linkage (attemptAccountCreation)', () => {
  it('creates the account linked to the freshly saved employee id', () => {
    const account = {
      ...emptyAccountForm(),
      enabled: true,
      username: 'linked.hire',
      password: 'pw123456',
      role: 'Employee' as const,
    };
    const res = attemptAccountCreation(account, CO_A, 'emp-new-1', 'admin');
    expect(res.ok).toBe(true);
    const stored = findUser('linked.hire');
    expect(stored?.employeeId).toBe('emp-new-1');
    expect(stored?.companyId).toBe(CO_A);
    expect(accountForEmployee('emp-new-1')?.username).toBe('linked.hire');
  });

  it('duplicate username → failure result (caller keeps the employee record)', () => {
    const account = {
      ...emptyAccountForm(),
      enabled: true,
      username: 'admin', // taken
      password: 'pw123456',
    };
    const res = attemptAccountCreation(account, CO_A, 'emp-new-2', 'admin');
    expect(res.ok).toBe(false);
    expect(findUserById('emp-new-2')).toBeUndefined();
    expect(accountForEmployee('emp-new-2')).toBeUndefined();
  });
});

describe('audit isolation', () => {
  it('account audits land in the account’s own company trail', () => {
    createUserAccount({ username: 'mrd.user', password: 'pw123456', role: 'Employee', companyId: CO_B }, 'admin');
    expect(auditTrail(CO_B).at(-1)?.action).toBe('user.create');
    expect(auditTrail(CO_A).some((l) => l.detail?.includes('mrd.user'))).toBe(false);
  });

  it('logAudit default-tenant sanity: unrelated tenant trails stay readable', () => {
    logAudit({ actorName: 'test', action: 'sanity.check', entity: 'users', detail: 'x' });
    expect(auditTrail(CO_A).at(-1)?.action).toBe('sanity.check');
  });
});
