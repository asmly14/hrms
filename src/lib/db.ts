/**
 * localStorage-backed, MULTI-TENANT repository with React pub/sub.
 *
 * Tenant model
 * ────────────
 * Every operational collection is physically namespaced per company:
 *
 *     myhrms:t:<companyId>:<collection>
 *
 * Global (system-level) keys — never tenant-scoped:
 *     myhrms:companies      → Company[]            (tenant directory)
 *     myhrms:activeTenant   → companyId | '__system__'
 *     myhrms:holidays       → holiday overrides    (law is national — shared)
 *     myhrms:migrated:v2    → legacy-data migration flag
 *     myhrms:seeded:v1      → seed flag (legacy name kept for compat)
 *     hrms.users / hrms.session → mock-auth directory & session (lib/auth.ts)
 *
 * Transparent scoping
 * ───────────────────
 * Pages keep calling `useCollection(name)` / `getCollection(name)` /
 * `setCollection(name, items)` exactly as before — reads and writes silently
 * target the ACTIVE tenant (set via `setActiveTenantId`, normally driven by
 * `TenantProvider` in lib/tenantContext.tsx). `getCollection`/`setCollection`
 * (and `logAudit`) accept an optional trailing `tenantId` for cross-tenant
 * tooling (SuperAdmin console, seeding, migrations).
 *
 * Migration
 * ─────────
 * `migrateLegacyData()` runs lazily on first storage access. Pre-multitenant
 * keys (`myhrms:<collection>`) are moved under the ASM Tech tenant
 * ('co-asm') and a flag is written. Idempotent — safe to call repeatedly.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { Company } from './types';
import { companySeedRecord, DEMO_COMPANY_IDS } from './tenants';

/** Ids of the demo companies seeded by seedIfEmpty (re-exported for convenience). */
export { DEMO_COMPANY_IDS };

export const COLLECTIONS = [
  'departments',
  'positions',
  'employees',
  'shifts',
  'attendance',
  'leaves',
  'leaveBalances',
  'claims',
  'payrollRuns',
  'payslips',
  'kpis',
  'reviews',
  'holidays',
  'settings',
  'audit',
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

const PREFIX = 'myhrms:';
const TENANT_PREFIX = `${PREFIX}t:`;
const SEED_FLAG = `${PREFIX}seeded:v1`;

/** Collections that stay GLOBAL (single shared key) — law is national. */
const GLOBAL_COLLECTIONS: ReadonlySet<string> = new Set<CollectionName>(['holidays']);

/** Storage keys for the tenant machinery itself. */
export const COMPANIES_KEY = `${PREFIX}companies`;
const ACTIVE_TENANT_KEY = `${PREFIX}activeTenant`;
const MIGRATION_FLAG = `${PREFIX}migrated:v2`;

/** Sentinel stored in ACTIVE_TENANT_KEY for the SuperAdmin "system view". */
const SYSTEM_VIEW = '__system__';

/** The original single-tenant dataset becomes this company on migration. */
export const DEFAULT_COMPANY_ID = 'co-asm';

/** Unique ID — wraps crypto.randomUUID() with a fallback. */
export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const tenantListeners = new Set<Listener>();

// ─────────────────────────────────────────────────────────────────────────────
// Active tenant resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the active tenant id. `null` = SuperAdmin system view (no company
 * selected). Defaults to DEFAULT_COMPANY_ID when nothing was ever stored —
 * this keeps non-React callers (tests, engines, scripts) working against the
 * original ASM Tech dataset without any setup.
 */
export function getActiveTenantId(): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_TENANT_KEY);
    if (raw === null) return DEFAULT_COMPANY_ID;
    if (raw === SYSTEM_VIEW) return null;
    return raw;
  } catch {
    return DEFAULT_COMPANY_ID;
  }
}

/**
 * Set the active tenant (`null` = system view) and notify every collection
 * subscriber plus tenant listeners so React re-reads the new namespace.
 * Normally called by TenantProvider / auth login — pages should not call this.
 */
export function setActiveTenantId(companyId: string | null): void {
  try {
    localStorage.setItem(ACTIVE_TENANT_KEY, companyId ?? SYSTEM_VIEW);
  } catch {
    /* non-fatal */
  }
  tenantListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break the switch */
    }
  });
  notifyAll();
}

/** Subscribe to active-tenant changes (used by TenantProvider). */
export function subscribeTenant(fn: Listener): () => void {
  tenantListeners.add(fn);
  return () => tenantListeners.delete(fn);
}

/**
 * Resolve which tenant a call targets: explicit arg wins, then the active
 * tenant; in system view with no explicit arg, fall back to
 * DEFAULT_COMPANY_ID so legacy non-React callers never crash.
 */
function resolveTenant(tenantId?: string): string {
  return tenantId ?? getActiveTenantId() ?? DEFAULT_COMPANY_ID;
}

// ─────────────────────────────────────────────────────────────────────────────
// Key machinery + pub/sub
// ─────────────────────────────────────────────────────────────────────────────

function key(name: CollectionName, tenantId?: string): string {
  if (GLOBAL_COLLECTIONS.has(name)) return `${PREFIX}${name}`;
  return `${TENANT_PREFIX}${resolveTenant(tenantId)}:${name}`;
}

function notify(name: CollectionName): void {
  // Collection listeners are keyed by name only (not name+tenant): a write to
  // any tenant re-reads every subscriber; useSyncExternalStore then compares
  // the snapshot for the subscriber's OWN active tenant, so stale tenants
  // simply no-op. Over-notification is cheap and keeps switching trivial.
  listeners.get(name)?.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break writes */
    }
  });
}

function notifyAll(): void {
  listeners.forEach((fns) => {
    fns.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
  });
}

function subscribe(name: CollectionName, fn: Listener): () => void {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
  return () => listeners.get(name)?.delete(fn);
}

/** Read the whole collection (non-reactive). Defaults to the active tenant. */
export function getCollection<T>(name: CollectionName, tenantId?: string): T[] {
  ensureMigrated();
  try {
    const raw = localStorage.getItem(key(name, tenantId));
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

/** Overwrite the whole collection and notify subscribers. Defaults to the active tenant. */
export function setCollection<T>(name: CollectionName, items: T[], tenantId?: string): void {
  ensureMigrated();
  localStorage.setItem(key(name, tenantId), JSON.stringify(items));
  notify(name);
}

function versionOf(name: CollectionName): string {
  return localStorage.getItem(key(name)) ?? '';
}

export interface CollectionApi<T extends { id: string }> {
  items: T[];
  /** Adds an item; id is generated when omitted. Returns the stored item. */
  add: (item: Omit<T, 'id'> & { id?: string }) => T;
  /** Shallow-merge patch into the item with the given id. */
  update: (id: string, patch: Partial<T>) => void;
  remove: (id: string) => void;
  /** Replace the whole collection (or clear it when called with no args). */
  reset: (items?: T[]) => void;
}

/**
 * Reactive collection hook — re-renders on every write to `name` AND on
 * active-tenant switches. Always reads/writes the ACTIVE tenant.
 */
export function useCollection<T extends { id: string }>(name: CollectionName): CollectionApi<T> {
  const raw = useSyncExternalStore(
    (fn) => subscribe(name, fn),
    () => versionOf(name),
  );
  // Parse once per snapshot: keyed by the raw string so `items` keeps a stable
  // reference across re-renders. Without this, every render produces a new
  // array identity, which cascades through consumer useMemo chains and can
  // close an infinite setState loop (see OrgChartPage structure-sync effect).
  const items = useMemo(() => (raw ? (JSON.parse(raw) as T[]) : []), [raw]);
  return {
    items,
    add: (item) => {
      const full = { ...item, id: item.id ?? uid() } as T;
      setCollection(name, [...getCollection<T>(name), full]);
      return full;
    },
    update: (id, patch) => {
      setCollection(
        name,
        getCollection<T>(name).map((it) => (it.id === id ? { ...it, ...patch } : it)),
      );
    },
    remove: (id) => {
      setCollection(
        name,
        getCollection<T>(name).filter((it) => it.id !== id),
      );
    },
    reset: (next) => setCollection(name, next ?? []),
  };
}

/** Append an audit entry (per-tenant; defaults to the active tenant). */
export function logAudit(
  entry: Omit<import('./types').AuditLog, 'id' | 'at'> & { at?: string },
  tenantId?: string,
): void {
  const log: import('./types').AuditLog = { ...entry, id: uid(), at: entry.at ?? new Date().toISOString() };
  setCollection('audit', [...getCollection<import('./types').AuditLog>('audit', tenantId), log], tenantId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Companies (global tenant directory)
// ─────────────────────────────────────────────────────────────────────────────

/** All companies (tenants), from the global directory. */
export function getCompanies(): Company[] {
  try {
    const raw = localStorage.getItem(COMPANIES_KEY);
    return raw ? (JSON.parse(raw) as Company[]) : [];
  } catch {
    return [];
  }
}

/** Overwrite the global company directory and notify tenant subscribers. */
export function saveCompanies(companies: Company[]): void {
  try {
    localStorage.setItem(COMPANIES_KEY, JSON.stringify(companies));
  } catch {
    /* non-fatal in demo mode */
  }
  tenantListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break the write */
    }
  });
}

/** Look up one company by id. */
export function getCompany(companyId: string): Company | undefined {
  return getCompanies().find((c) => c.id === companyId);
}

/** Insert or update a company (matched by id). Returns the stored record. */
export function upsertCompany(company: Company): Company {
  const all = getCompanies();
  const idx = all.findIndex((c) => c.id === company.id);
  if (idx >= 0) all[idx] = company;
  else all.push(company);
  saveCompanies(all);
  return company;
}

/** The ACTIVE company record (undefined in system view or when unknown). */
export function getActiveCompany(): Company | undefined {
  const id = getActiveTenantId();
  return id ? getCompany(id) : undefined;
}

/**
 * Next employee number for a company, applying its
 * config.numberFormats.employeeIdPrefix: scans existing `employeeNo` values
 * with the same prefix and returns prefix + (max+1) zero-padded to 4
 * (e.g. 'ASM0031'). Falls back to the uppercased company code as prefix.
 */
export function nextEmployeeNo(companyId: string): string {
  const company = getCompany(companyId);
  const prefix = (
    company?.config.numberFormats.employeeIdPrefix ||
    company?.code ||
    'EMP'
  ).toUpperCase();
  const employees = getCollection<import('./types').Employee>('employees', companyId);
  let max = 0;
  for (const e of employees) {
    const no = e.employeeNo;
    if (!no || !no.toUpperCase().startsWith(prefix)) continue;
    const n = Number(no.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy migration (single-tenant → multi-tenant)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move pre-multitenant data (`myhrms:<collection>`) under the ASM Tech
 * tenant (`myhrms:t:co-asm:<collection>`), ensure the co-asm company record
 * exists, and write the migration flag. Idempotent: no-ops once the flag is
 * set; when both legacy and tenant keys exist, the tenant copy wins and the
 * legacy key is removed. Safe to call at any time.
 */
export function migrateLegacyData(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(MIGRATION_FLAG)) return;

    for (const name of COLLECTIONS) {
      if (GLOBAL_COLLECTIONS.has(name)) continue; // already global
      const legacyKey = `${PREFIX}${name}`;
      const tenantKey = `${TENANT_PREFIX}${DEFAULT_COMPANY_ID}:${name}`;
      const legacy = localStorage.getItem(legacyKey);
      if (legacy !== null) {
        if (localStorage.getItem(tenantKey) === null) {
          localStorage.setItem(tenantKey, legacy);
        }
        localStorage.removeItem(legacyKey);
      }
    }

    // Ensure the ASM Tech company record exists in the global directory
    // (synchronous — tenants.ts is cycle-free).
    if (!getCompany(DEFAULT_COMPANY_ID)) {
      upsertCompany(companySeedRecord(DEFAULT_COMPANY_ID));
    }

    localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
  } catch {
    /* storage unavailable — retry on next access */
  }
}

let migrationChecked = false;

/** Cheap guard run on every storage access; O(1) after the first call. */
function ensureMigrated(): void {
  if (migrationChecked) return;
  migrationChecked = true;
  migrateLegacyData();
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeding (per-tenant)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-tenant seed flag key. */
export function tenantSeedFlag(companyId: string): string {
  return `${TENANT_PREFIX}${companyId}:seeded:v1`;
}

/**
 * Seed ONE company if its tenant namespace is empty (idempotent per tenant).
 * Pass `force` to reseed. Demo companies come from seed.ts's registry;
 * unknown companies get an empty (but initialized) namespace.
 */
export function seedTenantIfEmpty(companyId: string, force = false): void {
  if (typeof localStorage === 'undefined') return;
  ensureMigrated();
  if (!force && localStorage.getItem(tenantSeedFlag(companyId))) return;
  void import('./seed').then(({ buildTenantSeedData }) => {
    const data = buildTenantSeedData(companyId);
    if (!data) {
      // Unknown company: initialize empty collections so reads are stable.
      (COLLECTIONS as readonly CollectionName[])
        .filter((n) => !GLOBAL_COLLECTIONS.has(n))
        .forEach((name) => {
          if (localStorage.getItem(`${TENANT_PREFIX}${companyId}:${name}`) === null) {
            localStorage.setItem(`${TENANT_PREFIX}${companyId}:${name}`, '[]');
          }
        });
    } else {
      (Object.keys(data.collections) as CollectionName[]).forEach((name) => {
        setCollection(name, data.collections[name] as unknown[], companyId);
      });
      upsertCompany(data.company);
    }
    localStorage.setItem(tenantSeedFlag(companyId), new Date().toISOString());
  });
}

/**
 * Idempotent seeding of ALL demo tenants. Called automatically on module
 * import; safe to call again — it no-ops once every tenant flag is set.
 * Pass `force` to reseed everything.
 */
export function seedIfEmpty(force = false): void {
  if (typeof localStorage === 'undefined') return;
  ensureMigrated();
  void import('./seed').then(({ buildTenantSeedData }) => {
    DEMO_COMPANY_IDS.forEach((companyId) => {
      if (!force && localStorage.getItem(tenantSeedFlag(companyId))) return;
      const data = buildTenantSeedData(companyId);
      if (!data) return;
      (Object.keys(data.collections) as CollectionName[]).forEach((name) => {
        setCollection(name, data.collections[name] as unknown[], companyId);
      });
      upsertCompany(data.company);
      localStorage.setItem(tenantSeedFlag(companyId), new Date().toISOString());
    });
    // Legacy global flag — kept for pages that probe "has the seed run".
    localStorage.setItem(SEED_FLAG, new Date().toISOString());
  });
}

// Module init: run migration + seed when storage is available (no-op in
// node test environments until the localStorage stub is installed).
if (typeof localStorage !== 'undefined') {
  ensureMigrated();
  seedIfEmpty();
}
