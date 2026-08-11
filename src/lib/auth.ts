/**
 * Mock authentication CORE — user accounts, seeding, sessions (MULTI-TENANT).
 *
 * DEMO ONLY: there is no backend; this module exists so the app can exercise
 * real login / logout / role-based data scoping flows before a real IdP is
 * wired in. Passwords are stored as bcrypt hashes (bcryptjs, cost factor 8 —
 * keeps demo login latency at ~15ms while never persisting plaintext at
 * rest). Legacy plaintext entries written by older builds are transparently
 * migrated to hashes on their first successful login (see verifyAndMigrate).
 * The documented demo passwords themselves (admin123, super123, …) are
 * unchanged — only the at-rest storage format changed.
 *
 * Storage keys (GLOBAL — shared across tenants):
 *   - 'hrms.users'   → UserAccount[] (the account directory, all companies)
 *   - 'hrms.session' → Session | null (the active session, carries companyId)
 *
 * Tenant model:
 *   - Every account belongs to exactly one company (`companyId`), EXCEPT the
 *     SuperAdmin (`companyId: null`) who is cross-company by design.
 *   - login() resolves the account → stores {userId, companyId} in the session
 *     and switches the db layer's active tenant to that company. SuperAdmin
 *     sessions start in the system view (no active company); TenantProvider's
 *     setActiveCompany()/leaveCompany() move them in and out of companies.
 *
 * Account seeding (`seedUsers()`) — idempotent, merge-based, per company:
 *   - SuperAdmin:  superadmin / super123   (no company, no employee link)
 *   - ASM Tech:    admin / admin123, hr / hr123 (standalone),
 *                  ahmad.faizal / manager123 (emp-01), tan.weiling / manager123 (emp-03)
 *   - Merdeka:     admin2 / admin123, hr2 / hr123 (standalone)
 *   - Desa:        admin3 / admin123, hr3 / hr123 (standalone)
 *   - One Employee account per seeded employee of EVERY company
 *     (username = email local-part, password `password123`).
 *   Password pattern: fixed staff accounts reuse the ASM pattern
 *   (admin123 / hr123 / manager123 / password123); the numeric suffix on the
 *   username (admin2/admin3) is the only per-company distinguisher.
 *   Username collision across companies (same email local-part): the later
 *   account is suffixed with the company code, e.g. `zulkifli1.mrd`.
 *
 * Existing accounts keep their (possibly changed) passwords; accounts for
 * newly-seeded employees are added on the next call. `login()` calls
 * `seedUsers()` first, so accounts appear even if demo seeding finished after
 * the first page load.
 */
import bcrypt from 'bcryptjs';
import { getCollection, getCompanies, getCompany, setActiveTenantId, uid } from './db';
import { COMPANY_ID_ASM, COMPANY_ID_DESA, COMPANY_ID_MERDEKA, COMPANY_ID_ASMDIV } from './tenants';
import type { Employee } from './types';

/** bcrypt cost factor. 8 keeps the pure-JS demo login fast (~15ms/verify). */
export const BCRYPT_ROUNDS = 8;

/** Display-name role (matches AppRole in roleContext.tsx, plus SuperAdmin). */
export type AuthRole = 'Admin' | 'HR' | 'Manager' | 'Employee' | 'SuperAdmin';

export interface UserAccount {
  id: string;
  username: string;
  /**
   * bcrypt hash ($2b$08$…) of the account password. Absent ONLY on legacy
   * accounts written before hashing shipped — those are migrated on their
   * first successful login and then carry a hash going forward.
   */
  passwordHash?: string;
  /**
   * LEGACY plaintext password. Never written by current code; kept as an
   * optional field only so pre-migration `hrms.users` directories still
   * parse. Deleted from the account the moment it is migrated to a hash.
   */
  password?: string;
  /**
   * Tenant this account belongs to. REQUIRED for every role — the sole
   * exception is SuperAdmin, which is cross-company and carries `null`.
   */
  companyId: string | null;
  /** Link to the Employee record (inside the same tenant) this account belongs to. */
  employeeId?: string;
  role: AuthRole;
}

/** UserAccount without any credential material — safe to expose to the UI tree. */
export type PublicUser = Omit<UserAccount, 'password' | 'passwordHash'>;

export interface Session {
  userId: string;
  username: string;
  role: AuthRole;
  /** Tenant of the logged-in account (null = SuperAdmin, system view). */
  companyId: string | null;
  employeeId?: string;
  /** ISO datetime of the successful login. */
  loginAt: string;
}

export type LoginResult =
  | { ok: true; user: PublicUser }
  | { ok: false; error: string };

const USERS_KEY = 'hrms.users';
const SESSION_KEY = 'hrms.session';

/**
 * Fixed demo accounts (besides the per-employee derived ones). These are SEED
 * constants: they carry the documented plaintext demo passwords so seedUsers()
 * can hash them on first write — the hashes (not these strings) are what end
 * up in `hrms.users`.
 */
type FixedAccountSeed = Omit<UserAccount, 'password' | 'passwordHash'> & { password: string };

const FIXED_ACCOUNTS: FixedAccountSeed[] = [
  // System SuperAdmin — cross-company, no employee link, no fixed tenant.
  { id: 'user-superadmin', username: 'superadmin', password: 'super123', role: 'SuperAdmin', companyId: null },
  // ASM Tech (co-asm)
  { id: 'user-admin', username: 'admin', password: 'admin123', role: 'Admin', companyId: COMPANY_ID_ASM },
  { id: 'user-hr', username: 'hr', password: 'hr123', role: 'HR', companyId: COMPANY_ID_ASM },
  {
    id: 'user-mgr-eng',
    username: 'ahmad.faizal',
    password: 'manager123',
    role: 'Manager',
    companyId: COMPANY_ID_ASM,
    employeeId: 'emp-01', // Ahmad Faizal — Head of Engineering (seed dept head)
  },
  {
    id: 'user-mgr-fin',
    username: 'tan.weiling',
    password: 'manager123',
    role: 'Manager',
    companyId: COMPANY_ID_ASM,
    employeeId: 'emp-03', // Tan Wei Ling — Head of Finance (seed dept head)
  },
  // Merdeka Manufacturing (co-merdeka)
  { id: 'user-admin-mrd', username: 'admin2', password: 'admin123', role: 'Admin', companyId: COMPANY_ID_MERDEKA },
  { id: 'user-hr-mrd', username: 'hr2', password: 'hr123', role: 'HR', companyId: COMPANY_ID_MERDEKA },
  // Desa Retail Group (co-desa)
  { id: 'user-admin-desa', username: 'admin3', password: 'admin123', role: 'Admin', companyId: COMPANY_ID_DESA },
  { id: 'user-hr-desa', username: 'hr3', password: 'hr123', role: 'HR', companyId: COMPANY_ID_DESA },
  // ASM Tech Division Sdn Bhd (co-asm-division) — real tenant, empty by design
  { id: 'user-admin-asmd', username: 'smithang', password: '123123', role: 'Admin', companyId: COMPANY_ID_ASMDIV },
];

export const DEMO_PASSWORD = 'password123';

function readUsers(): UserAccount[] {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    return raw ? (JSON.parse(raw) as UserAccount[]) : [];
  } catch {
    return [];
  }
}

function writeUsers(users: UserAccount[]): void {
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  } catch {
    /* storage full / unavailable — non-fatal in demo mode */
  }
}

function stripPassword(account: UserAccount): PublicUser {
  const { password: _pw, passwordHash: _hash, ...pub } = account;
  void _pw;
  void _hash;
  return pub;
}

/** True when the stored value is a bcrypt hash ($2a$/$2b$/$2y$ + cost). */
function isBcryptHash(v: string | undefined): v is string {
  return typeof v === 'string' && /^\$2[aby]\$\d{2}\$/.test(v);
}

/** bcrypt-hash a plaintext demo password for at-rest storage. */
function hashPassword(plaintext: string): string {
  return bcrypt.hashSync(plaintext, BCRYPT_ROUNDS);
}

/** Persist a single account mutation back into the directory (matched by id). */
function updateUser(updated: UserAccount): void {
  writeUsers(readUsers().map((u) => (u.id === updated.id ? updated : u)));
}

/**
 * Verify a login attempt against an account. Hashed accounts compare via
 * bcrypt. Legacy plaintext entries (pre-hashing builds, or direct
 * localStorage writes) compare directly and — on success — are transparently
 * migrated: hash stored, plaintext deleted. Fails closed when the account
 * carries neither a hash nor a legacy plaintext password.
 */
function verifyAndMigrate(account: UserAccount, password: string): boolean {
  if (isBcryptHash(account.passwordHash)) {
    return bcrypt.compareSync(password, account.passwordHash);
  }
  if (typeof account.password === 'string' && account.password === password) {
    const migrated: UserAccount = { ...account, passwordHash: hashPassword(password) };
    delete migrated.password;
    updateUser(migrated);
    return true;
  }
  return false;
}

/** Username for an employee's derived account: email local-part, lowercased. */
export function usernameForEmployee(emp: Employee): string {
  const local = emp.email.split('@')[0] ?? '';
  return local.toLowerCase().replace(/[^a-z0-9.]/g, '') || emp.id;
}

/**
 * Idempotently (re)build the account directory from the seeded employees of
 * EVERY company plus the fixed demo accounts. Existing usernames are
 * preserved as-is (so a changed demo password survives reseeding); only
 * missing accounts are appended. Safe to call on every app boot and before login.
 */
export function seedUsers(): UserAccount[] {
  const existing = readUsers();
  const byUsername = new Map(existing.map((u) => [u.username, u]));

  // Fixed accounts first (superadmin / admins / hr / managers) — seeded with
  // a bcrypt hash of their documented demo password, never the plaintext.
  for (const acc of FIXED_ACCOUNTS) {
    if (!byUsername.has(acc.username)) {
      const { password, ...rest } = acc;
      const stored: UserAccount = { ...rest, passwordHash: hashPassword(password) };
      existing.push(stored);
      byUsername.set(acc.username, stored);
    }
  }

  // One Employee account per seeded employee, per company.
  for (const company of getCompanies()) {
    const employees = getCollection<Employee>('employees', company.id);
    for (const emp of employees) {
      let username = usernameForEmployee(emp);
      const taken = byUsername.get(username);
      if (taken) {
        // Cross-tenant collision: namespace the later account with the
        // company code (e.g. `zulkifli1.mrd`). Same-company → keep the
        // account and make sure it stays linked to the employee.
        if (taken.companyId === company.id) {
          taken.employeeId = taken.employeeId ?? emp.id;
          continue;
        }
        username = `${username}.${company.code.toLowerCase()}`;
        if (byUsername.has(username)) continue;
      }
      const acc: UserAccount = {
        id: uid(),
        username,
        passwordHash: hashPassword(DEMO_PASSWORD),
        companyId: company.id,
        employeeId: emp.id,
        role: 'Employee',
      };
      existing.push(acc);
      byUsername.set(username, acc);
    }
  }

  writeUsers(existing);
  return existing;
}

/** Look up an account by username (case-insensitive). */
export function findUser(username: string): UserAccount | undefined {
  const needle = username.trim().toLowerCase();
  return readUsers().find((u) => u.username.toLowerCase() === needle);
}

/**
 * Attempt a login. On success, persists the session to 'hrms.session',
 * switches the db layer's active tenant to the account's company (SuperAdmin
 * → system view), and returns the public user profile. On failure returns a
 * generic error (never reveals whether the username or the password was wrong).
 */
export function login(username: string, password: string): LoginResult {
  if (!username.trim() || !password) {
    return { ok: false, error: 'Please enter both username and password.' };
  }
  seedUsers(); // make sure late-arriving demo seed data has accounts
  const account = findUser(username);
  if (!account || !verifyAndMigrate(account, password)) {
    return { ok: false, error: 'Invalid username or password.' };
  }
  // Tenant suspension gate: users of a SUSPENDED company cannot sign in.
  // Checked only after credentials verify (never leak suspension to bad
  // passwords). SuperAdmin carries companyId null and is never blocked.
  if (account.companyId) {
    const company = getCompany(account.companyId);
    if (company?.status === 'suspended') {
      return {
        ok: false,
        error: `Access for ${company.name} has been suspended. Please contact your SuperAdmin or support to reactivate the company.`,
      };
    }
  }
  const session: Session = {
    userId: account.id,
    username: account.username,
    role: account.role,
    companyId: account.companyId,
    employeeId: account.employeeId,
    loginAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* non-fatal */
  }
  // Switch the active tenant: company users are pinned to their tenant;
  // SuperAdmin starts in the system view (TenantProvider enters companies).
  setActiveTenantId(account.companyId);
  return { ok: true, user: stripPassword(account) };
}

/** Clear the active session. */
export function logout(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Read the persisted session (null when logged out or corrupted). */
export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s && typeof s.userId === 'string' ? s : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the currently logged-in user. Prefers re-validating the session
 * against the account directory; falls back to the session snapshot so a
 * session survives a directory rebuild (e.g. demo reseed).
 */
export function currentUser(): PublicUser | null {
  const session = getSession();
  if (!session) return null;
  const account = readUsers().find((u) => u.id === session.userId);
  if (account) return stripPassword(account);
  return {
    id: session.userId,
    username: session.username,
    role: session.role,
    companyId: session.companyId,
    employeeId: session.employeeId,
  };
}
