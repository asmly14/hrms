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
 * Collection registry
 * ───────────────────
 * `COLLECTIONS` / `CollectionName` are the SINGLE source of truth for every
 * persisted collection, including the module stores (lifecycle, orgChart,
 * contracts, employeeRecords, onboardLinks, kpiEngine) which previously
 * bypassed the registry via typed casts. Registry membership drives JSON
 * export/import (`exportTenantData`/`importTenantData`), legacy migration,
 * per-tenant seed init and storage accounting — a collection that is not in
 * the registry is silently dropped by all of them. Module stores use
 * `useCollection` directly; no private pub/sub, no casts.
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
  // ── Core scaffold (Wave-0) ──────────────────────────────────────────────
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
  // ── Module collections (P1 registry unification — audit-database Phase 0).
  // These used to bypass the registry via typed casts in their module stores,
  // which made JSON export / import / the Postgres migrator silently drop
  // them. They are now first-class CollectionName entries; the stores below
  // use the registry directly (no private pub/sub, no casts):
  'onboardingChecklists', // lib/lifecycle.ts
  'offboardingCases', //     lib/lifecycle.ts
  'positionProfiles', //     lib/orgChart.ts
  'departmentProfiles', //   lib/orgChart.ts
  'contracts', //            lib/contracts.ts
  'contractFeePayments', //  lib/contracts.ts
  'employeeRecords', //      lib/employeeRecords.ts
  'onboardLinks', //         lib/onboardLinks.ts
  'onboardSubmissions', //   lib/onboardLinks.ts
  'onboardingExtras', //     lib/onboardLinks.ts
  'cycles', //               lib/kpiEngine.ts
  'objectives', //           lib/kpiEngine.ts
  'checkins', //             lib/kpiEngine.ts
  'pips', //                 lib/kpiEngine.ts
  // Attendance rotation plans. Physically a SUB-KEY
  // (`myhrms:t:<companyId>:attendance:rotations`); the registry key builder
  // composes exactly that, so export / import / legacy migration / per-tenant
  // seed init now cover it. NOTE: pages/attendance/model.ts (outside the
  // registry scope) still owns its private pub/sub + legacy-key migration, so
  // registry-driven writes (e.g. an import) do not live-refresh already
  // mounted attendance screens — they re-read on next mount. Keep model.ts
  // as-is until its owner folds it into useCollection.
  'attendance:rotations',
  // Per-tenant document byte store (P1 docStore — deep-audit item 9). Base64
  // document bytes used to be inlined in onboardSubmissions / employeeRecords
  // records (one 700 KB file ≈ 934 KB of base64; a 5-doc onboarding ≈ the
  // whole ~5 MB origin budget). Bytes now live here, gzip-compressed when
  // beneficial, referenced by docId; records carry metadata only. Registry
  // membership gives export/import, legacy migration and seed init for free.
  'docBytes', //               lib/docStore.ts
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
/**
 * GLOBAL system audit stream (tenant-lifecycle + impersonation events).
 * Unlike the per-tenant `audit` collection, this key is NEVER namespaced and
 * is never purged by removeCompany — tombstones for deleted tenants live
 * here precisely because their tenant trail is gone.
 */
export const SYSTEM_AUDIT_KEY = `${PREFIX}system:audit`;

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

/**
 * Per-tenant audit log cap. The log is append-only, so without rotation it
 * grows without bound (audit-database finding). On every append the log is
 * trimmed to the newest MAX_AUDIT_ENTRIES entries.
 */
export const MAX_AUDIT_ENTRIES = 2000;

/** Append an audit entry (per-tenant; defaults to the active tenant). */
export function logAudit(
  entry: Omit<import('./types').AuditLog, 'id' | 'at'> & { at?: string },
  tenantId?: string,
): void {
  const log: import('./types').AuditLog = { ...entry, id: uid(), at: entry.at ?? new Date().toISOString() };
  const all = [...getCollection<import('./types').AuditLog>('audit', tenantId), log];
  // Rotate: keep the newest MAX_AUDIT_ENTRIES (entries are appended chronologically).
  setCollection(
    'audit',
    all.length > MAX_AUDIT_ENTRIES ? all.slice(all.length - MAX_AUDIT_ENTRIES) : all,
    tenantId,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// System audit (GLOBAL — lifecycle tombstones + SuperAdmin impersonation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One entry in the GLOBAL system audit stream (`myhrms:system:audit`).
 * Kept deliberately close to AuditLog, but adds `companyId`/`companyName`
 * because these events describe cross-tenant actions (tenant deletion,
 * impersonation) that do not belong inside any single tenant's trail.
 */
export interface SystemAuditEntry {
  id: string;
  /** ISO datetime. */
  at: string;
  actorName: string;
  /** e.g. 'company.delete', 'superadmin.enter_company', 'superadmin.exit_company'. */
  action: string;
  companyId?: string;
  companyName?: string;
  detail?: string;
}

/**
 * Append an entry to the GLOBAL system audit (never tenant-namespaced).
 * Capped at the newest MAX_AUDIT_ENTRIES, same rotation policy as the
 * per-tenant log. Used for tenant-deletion tombstones (removeCompany) and
 * SuperAdmin impersonation enter/exit events (tenantContext).
 */
export function logSystemAudit(
  entry: Omit<SystemAuditEntry, 'id' | 'at'> & { at?: string },
): void {
  if (typeof localStorage === 'undefined') return;
  const log: SystemAuditEntry = { ...entry, id: uid(), at: entry.at ?? new Date().toISOString() };
  try {
    const raw = localStorage.getItem(SYSTEM_AUDIT_KEY);
    const all = [...(raw ? (JSON.parse(raw) as SystemAuditEntry[]) : []), log];
    const trimmed = all.length > MAX_AUDIT_ENTRIES ? all.slice(all.length - MAX_AUDIT_ENTRIES) : all;
    localStorage.setItem(SYSTEM_AUDIT_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage unavailable — non-fatal in demo mode */
  }
}

/** Read the GLOBAL system audit stream (oldest first). */
export function getSystemAudit(): SystemAuditEntry[] {
  try {
    const raw = localStorage.getItem(SYSTEM_AUDIT_KEY);
    return raw ? (JSON.parse(raw) as SystemAuditEntry[]) : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry-wide export / import (Settings → Data management)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot EVERY registry collection for a tenant (default: active) into one
 * JSON-serializable map — the 'Export all data' payload. Iterating the
 * COLLECTIONS registry (never a hardcoded list) means module collections
 * (contracts, cycles, onboardingChecklists, …) can no longer be dropped.
 * Global collections (holidays) read the shared key.
 */
export function exportTenantData(tenantId?: string): Record<CollectionName, unknown[]> {
  const data = {} as Record<CollectionName, unknown[]>;
  for (const name of COLLECTIONS) {
    data[name] = getCollection(name, tenantId);
  }
  return data;
}

export interface ImportReport {
  /** Registry collections that were restored. */
  touched: number;
  /** Rows read from the file across restored collections. */
  rows: number;
  /** Collection names in the file that are NOT in the registry (skipped). */
  skipped: string[];
}

/**
 * Restore an export payload into a tenant (default: active). Any registry
 * collection is accepted; unknown keys are skipped and reported. `replace`
 * overwrites each collection outright; `merge` upserts by record id (rows the
 * file doesn't mention are kept). Global collections (holidays) write the
 * shared key regardless of tenant.
 */
export function importTenantData(
  data: Record<string, unknown[]>,
  tenantId?: string,
  mode: 'merge' | 'replace' = 'merge',
): ImportReport {
  const tenant = resolveTenant(tenantId);
  const known = new Set<string>(COLLECTIONS);
  const report: ImportReport = { touched: 0, rows: 0, skipped: [] };
  for (const [name, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;
    if (!known.has(name)) {
      report.skipped.push(name);
      continue;
    }
    if (mode === 'replace') {
      setCollection(name as CollectionName, items, tenant);
    } else {
      // Merge by id: imported rows overwrite same-id rows, existing rows the
      // file doesn't mention are kept.
      const byId = new Map(
        getCollection<{ id: string }>(name as CollectionName, tenant).map((r) => [r.id, r]),
      );
      for (const item of items) {
        const id = (item as { id?: unknown })?.id;
        if (typeof id === 'string') byId.set(id, item as { id: string });
      }
      setCollection(name as CollectionName, [...byId.values()], tenant);
    }
    report.rows += items.length;
    report.touched += 1;
  }
  return report;
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

// ── Trial clock ──────────────────────────────────────────────────────────────

/** Resolved trial state for a company (see Company.trialEndsAt). */
export interface TrialStatus {
  /** True when company.status === 'trial'. */
  isTrial: boolean;
  /** The configured trial end (ISO), or null when the trial has no clock. */
  trialEndsAt: string | null;
  /**
   * Whole days remaining (0 once expired). Null when the trial has no clock
   * or the company is not on trial.
   */
  daysLeft: number | null;
  /**
   * True only for a trial company whose trialEndsAt is in the past — these
   * tenants are blocked at login (lib/auth.ts) and flagged in the console.
   */
  expired: boolean;
}

const MS_PER_DAY = 86_400_000;

/**
 * Pure trial-state resolver. `now` is injectable for tests.
 * A non-trial company is never expired; a trial without trialEndsAt never
 * expires (open trial — the pre-clock behaviour).
 */
export function trialStatusOf(
  company: Pick<Company, 'status' | 'trialEndsAt'>,
  now: Date = new Date(),
): TrialStatus {
  const isTrial = company.status === 'trial';
  const trialEndsAt = company.trialEndsAt ?? null;
  if (!isTrial || !trialEndsAt) {
    return { isTrial, trialEndsAt, daysLeft: null, expired: false };
  }
  const end = new Date(trialEndsAt).getTime();
  if (Number.isNaN(end)) {
    return { isTrial, trialEndsAt, daysLeft: null, expired: false };
  }
  const expired = end < now.getTime();
  const daysLeft = expired ? 0 : Math.ceil((end - now.getTime()) / MS_PER_DAY);
  return { isTrial, trialEndsAt, daysLeft, expired };
}

// ── Tenant deletion (PDPA erasure) ──────────────────────────────────────────

/** What removeCompany purged (returned for the confirm toast / tombstone). */
export interface RemoveCompanyReport {
  companyId: string;
  companyName: string;
  /** localStorage keys removed under `myhrms:t:<companyId>:` (all collections,
   *  sub-keys like attendance:rotations, page-local keys, the seed flag). */
  removedKeys: number;
  /** Mock-auth accounts removed from hrms.users (SuperAdmin is never touched). */
  removedUsers: number;
}

/**
 * DELETE a tenant — the PDPA erasure path (audit-multitenant §2.2/§6 P1-3).
 *
 * Purges, in order:
 *  1. EVERY localStorage key under the tenant prefix `myhrms:t:<companyId>:`
 *     — all registry collections, sub-keys (attendance:rotations), page-local
 *     keys (claims:actingAs) and the per-tenant seed flag. Prefix scanning
 *     (not registry iteration) guarantees nothing tenant-owned survives.
 *  2. The Company record from the global directory (myhrms:companies).
 *  3. The company's accounts from the global hrms.users directory
 *     (SuperAdmin, companyId null, is structurally exempt).
 *  4. The active session, if it belongs to the deleted company.
 *
 * If the deleted company was the ACTIVE tenant, the active-tenant pointer is
 * reset to the system view so no later write can silently resurrect keys
 * under the purged namespace.
 *
 * Finally a GLOBAL tombstone (actor, company name, timestamp, key count) is
 * appended to `myhrms:system:audit` — the only trace left of the tenant,
 * which is exactly what PDPA erasure evidence needs.
 *
 * Access control lives at the call site (SuperAdmin console only); the db
 * layer is intentionally session-agnostic. Returns null when the company id
 * is unknown (nothing written).
 */
export function removeCompany(companyId: string, actorName = 'system'): RemoveCompanyReport | null {
  if (typeof localStorage === 'undefined') return null;
  const company = getCompany(companyId);
  if (!company) return null;

  // 1. Purge every tenant-namespaced key (scan, don't iterate the registry —
  //    sub-keys and page-local keys are not registry members).
  const tenantPrefix = `${TENANT_PREFIX}${companyId}:`;
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k && k.startsWith(tenantPrefix)) doomed.push(k);
  }
  doomed.forEach((k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* non-fatal */
    }
  });

  // 2. Remove from the global directory (notifies tenant subscribers).
  saveCompanies(getCompanies().filter((c) => c.id !== companyId));

  // 3. Remove the company's mock-auth accounts; SuperAdmin (companyId null)
  //    and other tenants' accounts are untouched.
  let removedUsers = 0;
  try {
    const raw = localStorage.getItem('hrms.users');
    if (raw) {
      const users = JSON.parse(raw) as { companyId: string | null }[];
      const kept = users.filter((u) => u.companyId !== companyId);
      removedUsers = users.length - kept.length;
      localStorage.setItem('hrms.users', JSON.stringify(kept));
    }
  } catch {
    /* non-fatal */
  }

  // 4. Drop a session pinned to the deleted company.
  try {
    const raw = localStorage.getItem('hrms.session');
    if (raw) {
      const session = JSON.parse(raw) as { companyId?: string | null };
      if (session.companyId === companyId) localStorage.removeItem('hrms.session');
    }
  } catch {
    /* non-fatal */
  }

  // 5. Reset the active-tenant pointer when it targeted the purged company.
  if (getActiveTenantId() === companyId) setActiveTenantId(null);

  // 6. Global tombstone — the only surviving trace of the tenant.
  logSystemAudit({
    actorName,
    action: 'company.delete',
    companyId,
    companyName: company.name,
    detail: `Tenant purged: ${doomed.length} storage key${doomed.length === 1 ? '' : 's'} and ${removedUsers} user account${removedUsers === 1 ? '' : 's'} removed (PDPA erasure).`,
  });

  return { companyId, companyName: company.name, removedKeys: doomed.length, removedUsers };
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
 *
 * Returns a promise that resolves AFTER the dynamic seed-module import and
 * all collection writes have landed — callers that must not read before the
 * seed completes should `await` it (the seed module is code-split, so the
 * work is inherently async; everything else here is synchronous localStorage).
 */
export async function seedTenantIfEmpty(companyId: string, force = false): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  ensureMigrated();
  if (!force && localStorage.getItem(tenantSeedFlag(companyId))) return;
  const { buildTenantSeedData } = await import('./seed');
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
}

/**
 * Idempotent seeding of ALL demo tenants. Called automatically on module
 * import; safe to call again — it no-ops once every tenant flag is set.
 * Pass `force` to reseed everything.
 *
 * Awaited by `dbReady()` at module scope; direct callers should await it too
 * when they need the writes to have landed (previously fire-and-forget —
 * the seed race from audit-database Phase 0).
 */
export async function seedIfEmpty(force = false): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  ensureMigrated();
  const { buildTenantSeedData } = await import('./seed');
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
}

/** Handle for the module-bottom auto-seed (null when storage was unavailable at import time). */
let autoSeedPromise: Promise<void> | null = null;

/**
 * Ready pattern: resolves once the automatic first-run seed has finished
 * (immediately when storage is unavailable — e.g. node tests that install a
 * localStorage stub after import — or when everything was already seeded).
 * Reactive pages converge on their own (seed writes notify subscribers), but
 * non-React callers that must not read before initialization can
 * `await dbReady()`.
 */
export function dbReady(): Promise<void> {
  return autoSeedPromise ?? Promise.resolve();
}

// Module init: run migration + seed when storage is available (no-op in
// node test environments until the localStorage stub is installed).
if (typeof localStorage !== 'undefined') {
  ensureMigrated();
  autoSeedPromise = seedIfEmpty();
  // Seeding is best-effort in demo mode — never an unhandled rejection.
  autoSeedPromise.catch(() => undefined);
}
