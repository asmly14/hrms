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
 *
 * Account LIFECYCLE (see the "Account lifecycle management" section below):
 * accounts carry `status` ('active'/'disabled' — legacy entries default to
 * active) and `lastLoginAt`; login() rejects disabled accounts only AFTER the
 * credential check (status never leaks to wrong-password guesses). Admins
 * manage accounts via createUserAccount / setUserStatus / setUserRole /
 * resetUserPassword / removeUserAccount / listCompanyUsers — all bcrypt-hashed,
 * all audited into the company's trail, all guarded (no self disable/remove,
 * no orphaning a company's last active Admin, SuperAdmin protected).
 */
import bcrypt from 'bcryptjs';
import {
  getCollection, getCompanies, getCompany, logAudit, logSystemAudit, setActiveTenantId,
  trialStatusOf, uid,
} from './db';
import { COMPANY_ID_ASM, COMPANY_ID_DESA, COMPANY_ID_MERDEKA, COMPANY_ID_ASMDIV } from './tenants';
import type { Employee } from './types';

/** bcrypt cost factor. 8 keeps the pure-JS demo login fast (~15ms/verify). */
export const BCRYPT_ROUNDS = 8;

/** Display-name role (matches AppRole in roleContext.tsx, plus SuperAdmin). */
export type AuthRole = 'Admin' | 'HR' | 'Manager' | 'Employee' | 'SuperAdmin';

/** Roles an Admin may assign through account management (never SuperAdmin). */
export type ManagedRole = Exclude<AuthRole, 'SuperAdmin'>;

/** Lifecycle state of an account. Legacy accounts without the field are 'active'. */
export type AccountStatus = 'active' | 'disabled';

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
  /**
   * Lifecycle state. OPTIONAL for backwards compatibility — accounts written
   * before account management shipped carry no `status` and are treated as
   * 'active' (see statusOf). New accounts always write it explicitly.
   */
  status?: AccountStatus;
  /** ISO datetime of the last successful login (absent = never logged in). */
  lastLoginAt?: string;
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

// ── Change feed (account directory) ──────────────────────────────────────────
// UI surfaces (Settings → Users, employee detail chip) subscribe via
// subscribeUsers + getUsersVersion with useSyncExternalStore so account
// mutations (create / role / status / reset / remove / login stamps) refresh
// them without a page reload.
const userListeners = new Set<() => void>();
let usersVersion = 0;

function notifyUsers(): void {
  usersVersion += 1;
  userListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break the write path */
    }
  });
}

/** Subscribe to account-directory changes. Returns an unsubscribe function. */
export function subscribeUsers(fn: () => void): () => void {
  userListeners.add(fn);
  return () => {
    userListeners.delete(fn);
  };
}

/** Monotonic snapshot of the account directory (for useSyncExternalStore). */
export function getUsersVersion(): number {
  return usersVersion;
}

/** Lifecycle status of an account; legacy accounts without `status` are active. */
export function statusOf(account: Pick<UserAccount, 'status'>): AccountStatus {
  return account.status === 'disabled' ? 'disabled' : 'active';
}

function writeUsers(users: UserAccount[]): void {
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  } catch {
    /* storage full / unavailable — non-fatal in demo mode */
  }
  notifyUsers();
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
  // Write back ONLY when the directory actually changed — subscribers
  // (useSyncExternalStore) re-read on every write, so an unconditional write
  // would loop when seedUsers() runs during render.
  let changed = false;

  // Fixed accounts first (superadmin / admins / hr / managers) — seeded with
  // a bcrypt hash of their documented demo password, never the plaintext.
  for (const acc of FIXED_ACCOUNTS) {
    if (!byUsername.has(acc.username)) {
      const { password, ...rest } = acc;
      const stored: UserAccount = { ...rest, passwordHash: hashPassword(password), status: 'active' };
      existing.push(stored);
      byUsername.set(acc.username, stored);
      changed = true;
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
          if (taken.employeeId === undefined) {
            taken.employeeId = emp.id;
            changed = true;
          }
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
        status: 'active',
      };
      existing.push(acc);
      byUsername.set(username, acc);
      changed = true;
    }
  }

  if (changed) writeUsers(existing);
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
  // Disabled-account gate: checked ONLY after credentials verify, so a wrong
  // password on a disabled account still returns the generic credential error
  // (account status never leaks to password guesses).
  if (statusOf(account) === 'disabled') {
    return { ok: false, error: 'Your access has been disabled. Contact your HR/admin.' };
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
    // Trial-expiry gate: same pattern as suspension — trial companies whose
    // trialEndsAt has passed cannot sign in (upgrade path is via support /
    // the SuperAdmin console). SuperAdmin is never blocked.
    if (company && trialStatusOf(company).expired) {
      return {
        ok: false,
        error: `The trial for ${company.name} has expired. Please contact support to upgrade and reactivate access.`,
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
  // Stamp lastLoginAt. Re-read the account first: verifyAndMigrate may have
  // just persisted a hash migration — stamping the stale in-memory copy would
  // resurrect the legacy plaintext field.
  const fresh = readUsers().find((u) => u.id === account.id) ?? account;
  const stamped: UserAccount = { ...fresh, lastLoginAt: session.loginAt };
  updateUser(stamped);
  // Switch the active tenant: company users are pinned to their tenant;
  // SuperAdmin starts in the system view (TenantProvider enters companies).
  setActiveTenantId(account.companyId);
  return { ok: true, user: stripPassword(stamped) };
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

/**
 * SuperAdmin impersonation audit (audit-multitenant §4.2). Writes
 * 'superadmin.enter_company' / 'superadmin.exit_company' into the GLOBAL
 * system audit stream (db.logSystemAudit) — never into a tenant trail, so the
 * record survives tenant deletion and is not editable by tenant admins.
 *
 * The SuperAdmin guard lives HERE (session check), not just at the call
 * sites in tenantContext, so the trail cannot be written by regular
 * sessions even if a caller forgets to check. No-op when the session is not
 * SuperAdmin or the company is unknown.
 */
export function auditImpersonation(action: 'enter' | 'exit', companyId: string): void {
  const session = getSession();
  if (session?.role !== 'SuperAdmin') return;
  const company = getCompany(companyId);
  if (!company) return;
  logSystemAudit({
    actorName: session.username,
    action: action === 'enter' ? 'superadmin.enter_company' : 'superadmin.exit_company',
    companyId: company.id,
    companyName: company.name,
    detail:
      action === 'enter'
        ? `Impersonation started — working inside ${company.name} (${company.code}).`
        : `Impersonation ended — left ${company.name} (${company.code}) for the system view.`,
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// Account lifecycle management (Admin) — public API
// ─────────────────────────────────────────────────────────────────────────────
//
// All mutations bcrypt-hash credentials, write through the same directory as
// seedUsers()/login(), and record a tenant-scoped audit entry (logAudit) in the
// account's own company trail. Passwords are NEVER written into audit details.
//
// Guards enforced here (not just in the UI):
//   - SuperAdmin accounts are protected (no disable / remove / reset / role change;
//     no new SuperAdmin accounts can be created).
//   - An actor cannot disable or remove their OWN account (checked against both
//     the live session and the actor name).
//   - The LAST active Admin of a company cannot be disabled, removed or demoted.

export type AccountResult = { ok: true; user: PublicUser } | { ok: false; error: string };
export type SimpleResult = { ok: true } | { ok: false; error: string };

/** Username rules: ≥3 chars, lowercase letters/digits plus . _ -, starts alnum. */
export function validateUsername(username: string): string | null {
  const u = username.trim().toLowerCase();
  if (u.length < 3) return 'Username must be at least 3 characters.';
  if (!/^[a-z0-9._-]+$/.test(u)) return 'Use lowercase letters, digits, dots, dashes or underscores only.';
  if (!/^[a-z0-9]/.test(u)) return 'Username must start with a letter or digit.';
  return null;
}

/** Password rule: ≥6 characters (demo-grade policy). */
export function validatePassword(password: string): string | null {
  if (password.length < 6) return 'Password must be at least 6 characters.';
  return null;
}

/** Readable temporary password (no ambiguous chars) for the generate buttons. */
export function generatePassword(length = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const buf = new Uint32Array(length);
    crypto.getRandomValues(buf);
    for (const n of buf) out += alphabet[n % alphabet.length];
    return out;
  }
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Username suggestion from an email address: the local-part, sanitized. When
 * taken (usernames are GLOBAL across companies) suffix with the company code,
 * then a numeric counter — the same namespacing seedUsers() applies.
 */
export function suggestUsername(email: string, companyCode?: string): string {
  const base = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const users = readUsers();
  const taken = (u: string) => users.some((x) => x.username.toLowerCase() === u);
  let candidate = base.length >= 3 ? base : `${base}user`;
  if (!taken(candidate)) return candidate;
  if (companyCode) {
    const coded = `${candidate}.${companyCode.toLowerCase()}`;
    if (!taken(coded)) return coded;
    candidate = coded;
  }
  let i = 2;
  while (taken(`${candidate}${i}`)) i += 1;
  return `${candidate}${i}`;
}

/** Look up an account by id. */
export function findUserById(userId: string): UserAccount | undefined {
  return readUsers().find((u) => u.id === userId);
}

/** Public (credential-free) accounts of one company, sorted by username. */
export function listCompanyUsers(companyId: string): PublicUser[] {
  return readUsers()
    .filter((u) => u.companyId === companyId)
    .sort((a, b) => a.username.localeCompare(b.username))
    .map(stripPassword);
}

/** Public accounts across ALL companies (SuperAdmin system view). */
export function listAllUsers(): PublicUser[] {
  return readUsers()
    .slice()
    .sort((a, b) => a.username.localeCompare(b.username))
    .map(stripPassword);
}

/** The account linked to an employee record, if one exists. */
export function accountForEmployee(employeeId: string, companyId?: string | null): PublicUser | undefined {
  const acc = readUsers().find(
    (u) => u.employeeId === employeeId && (companyId === undefined || u.companyId === companyId),
  );
  return acc ? stripPassword(acc) : undefined;
}

/** True when the actor IS the target account (session id or username match). */
function isSelf(account: UserAccount, actor: string): boolean {
  const session = getSession();
  if (session?.userId === account.id) return true;
  return account.username.toLowerCase() === actor.trim().toLowerCase();
}

/**
 * Guard: is `account` the last ACTIVE Admin of its company? Used to block
 * disable / remove / demote so a company never loses its only admin door.
 */
function isLastActiveAdmin(account: UserAccount): boolean {
  if (account.role !== 'Admin' || !account.companyId) return false;
  if (statusOf(account) !== 'active') return false;
  return !readUsers().some(
    (u) =>
      u.id !== account.id &&
      u.companyId === account.companyId &&
      u.role === 'Admin' &&
      statusOf(u) === 'active',
  );
}

/** Shared guard for destructive ops (disable / remove / reset / role change). */
function guardProtected(account: UserAccount | undefined): string | null {
  if (!account) return 'Account not found.';
  if (account.role === 'SuperAdmin') return 'The SuperAdmin account is protected and cannot be modified.';
  return null;
}

export interface CreateAccountInput {
  username: string;
  password: string;
  /** Assignable role — SuperAdmin is rejected at runtime (protected account). */
  role: AuthRole;
  /** Owning tenant — required (use the fixed SuperAdmin seed for system access). */
  companyId: string;
  /** Optional link to an Employee record inside the same tenant. */
  employeeId?: string;
}

/**
 * Create a login account. Usernames are globally unique (checked across ALL
 * tenants, case-insensitive). The password is stored only as a bcrypt hash.
 * Audited as 'user.create' in the company's trail (password never logged).
 */
export function createUserAccount(input: CreateAccountInput, actor?: string): AccountResult {
  const actorName = actor ?? getSession()?.username ?? 'system';
  const username = input.username.trim().toLowerCase();
  const usernameError = validateUsername(username);
  if (usernameError) return { ok: false, error: usernameError };
  const passwordError = validatePassword(input.password);
  if (passwordError) return { ok: false, error: passwordError };
  if (input.role === 'SuperAdmin') {
    return { ok: false, error: 'SuperAdmin accounts cannot be created here.' };
  }
  const company = getCompany(input.companyId);
  if (!company) return { ok: false, error: 'Unknown company.' };
  if (findUser(username)) {
    return { ok: false, error: `Username "${username}" is already taken (usernames are global across companies).` };
  }
  const account: UserAccount = {
    id: uid(),
    username,
    passwordHash: hashPassword(input.password),
    companyId: company.id,
    ...(input.employeeId ? { employeeId: input.employeeId } : {}),
    role: input.role,
    status: 'active',
  };
  writeUsers([...readUsers(), account]);
  logAudit(
    {
      actorName,
      action: 'user.create',
      entity: 'users',
      entityId: account.id,
      detail: `Created login account "${username}" (${input.role})${input.employeeId ? ` linked to employee ${input.employeeId}` : ', standalone'}.`,
    },
    company.id,
  );
  return { ok: true, user: stripPassword(account) };
}

/**
 * Revoke ('disabled') or restore ('active') an account's login access. The
 * account (and its password hash) is kept — the employee can be re-enabled
 * later. Audited as 'user.disable' / 'user.enable'.
 */
export function setUserStatus(userId: string, status: AccountStatus, actor: string): AccountResult {
  const account = findUserById(userId);
  const protectedError = guardProtected(account);
  if (protectedError) return { ok: false, error: protectedError };
  const acc = account as UserAccount;
  if (status === 'disabled') {
    if (isSelf(acc, actor)) return { ok: false, error: 'You cannot disable your own account.' };
    if (isLastActiveAdmin(acc)) {
      return { ok: false, error: 'This is the last active Admin account for the company — assign another Admin first.' };
    }
  }
  if (statusOf(acc) === status) return { ok: true, user: stripPassword(acc) }; // no-op
  const updated: UserAccount = { ...acc, status };
  updateUser(updated);
  logAudit(
    {
      actorName: actor,
      action: status === 'disabled' ? 'user.disable' : 'user.enable',
      entity: 'users',
      entityId: acc.id,
      detail:
        status === 'disabled'
          ? `Disabled login access for "${acc.username}" (${acc.role}).`
          : `Re-enabled login access for "${acc.username}" (${acc.role}).`,
    },
    acc.companyId ?? undefined,
  );
  return { ok: true, user: stripPassword(updated) };
}

/**
 * Change an account's role (Admin/HR/Manager/Employee). Demoting the last
 * active Admin of a company is blocked by the same guard as disable/remove.
 * Audited as 'user.role_change'.
 */
export function setUserRole(userId: string, role: AuthRole, actor: string): AccountResult {
  const account = findUserById(userId);
  const protectedError = guardProtected(account);
  if (protectedError) return { ok: false, error: protectedError };
  const acc = account as UserAccount;
  if (role === 'SuperAdmin') {
    return { ok: false, error: 'SuperAdmin cannot be assigned here.' };
  }
  if (acc.role === 'Admin' && role !== 'Admin' && isLastActiveAdmin(acc)) {
    return { ok: false, error: 'This is the last active Admin account for the company — assign another Admin first.' };
  }
  if (acc.role === role) return { ok: true, user: stripPassword(acc) }; // no-op
  const updated: UserAccount = { ...acc, role };
  updateUser(updated);
  logAudit(
    {
      actorName: actor,
      action: 'user.role_change',
      entity: 'users',
      entityId: acc.id,
      detail: `Changed "${acc.username}" role from ${acc.role} to ${role}.`,
    },
    acc.companyId ?? undefined,
  );
  return { ok: true, user: stripPassword(updated) };
}

/**
 * Reset an account's password (bcrypt-hashed at rest). The audit entry records
 * the reset WITHOUT the new password — credentials are shared out-of-band.
 */
export function resetUserPassword(userId: string, newPassword: string, actor: string): SimpleResult {
  const account = findUserById(userId);
  const protectedError = guardProtected(account);
  if (protectedError) return { ok: false, error: protectedError };
  const acc = account as UserAccount;
  const passwordError = validatePassword(newPassword);
  if (passwordError) return { ok: false, error: passwordError };
  const updated: UserAccount = { ...acc, passwordHash: hashPassword(newPassword) };
  delete updated.password; // belt & braces: a reset always leaves a hash-only record
  updateUser(updated);
  logAudit(
    {
      actorName: actor,
      action: 'user.reset_password',
      entity: 'users',
      entityId: acc.id,
      detail: `Reset the password for "${acc.username}" (${acc.role}). New password not recorded.`,
    },
    acc.companyId ?? undefined,
  );
  return { ok: true };
}

/**
 * Remove a login account from the directory. The linked EMPLOYEE record is
 * deliberately untouched — only sign-in access is removed. Audited as
 * 'user.remove' in the company trail BEFORE the account disappears.
 */
export function removeUserAccount(userId: string, actor: string): SimpleResult {
  const account = findUserById(userId);
  const protectedError = guardProtected(account);
  if (protectedError) return { ok: false, error: protectedError };
  const acc = account as UserAccount;
  if (isSelf(acc, actor)) return { ok: false, error: 'You cannot remove your own account.' };
  if (isLastActiveAdmin(acc)) {
    return { ok: false, error: 'This is the last active Admin account for the company — assign another Admin first.' };
  }
  logAudit(
    {
      actorName: actor,
      action: 'user.remove',
      entity: 'users',
      entityId: acc.id,
      detail: `Removed login account "${acc.username}" (${acc.role}); the employee record is kept.`,
    },
    acc.companyId ?? undefined,
  );
  writeUsers(readUsers().filter((u) => u.id !== acc.id));
  return { ok: true };
}
