/**
 * api.ts — HTTP-backed data layer for the HRMS (DUAL MODE).
 *
 * The app today persists to localStorage via `./db` (local mode). This module
 * provides the SAME function surface — getCollection / setCollection /
 * useCollection / logAudit / login / logout — backed by the production API
 * (`server/`), selected at build time:
 *
 *     VITE_DATA_MODE=local   (default — localStorage, demo)
 *     VITE_DATA_MODE=api     (Fastify + Postgres; needs VITE_API_URL)
 *     VITE_API_URL=http://localhost:4010
 *
 * `db.ts` is intentionally UNTOUCHED. The integration recipe — who calls what
 * and how authContext/tenantContext switch over — lives in
 * docs/enterprise-deployment.md §6. In short: both backends satisfy the
 * `DataProvider` interface below; `getDataProvider()` picks one by DATA_MODE.
 *
 * Notes
 * ─────
 * • HTTP is async: every provider method returns a Promise. The localStorage
 *   provider is a thin async wrapper over db.ts (lazy-imported so API mode
 *   never triggers db.ts's demo-seed side effects).
 * • The JWT lives in localStorage 'hrms.api.token'; login() ALSO writes a
 *   db.ts-compatible Session to 'hrms.session' and the active-tenant key, so
 *   the existing authContext/tenantContext keep working unchanged.
 * • useCollection() here is the API-mode reactive hook: an in-memory cache +
 *   fetch-on-subscribe + refetch-after-write. Local mode keeps using
 *   db.ts's useCollection.
 */
import { useSyncExternalStore } from 'react';
import type { CollectionApi, CollectionName } from './db';
import type { AuthRole, Session } from './auth';
import type { Company } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Mode + config
// ─────────────────────────────────────────────────────────────────────────────

export type DataMode = 'local' | 'api';

/** Active backend — set VITE_DATA_MODE=api to run against the server. */
export const DATA_MODE: DataMode =
  ((import.meta.env?.VITE_DATA_MODE as string | undefined) ?? 'local') === 'api' ? 'api' : 'local';

/** Base URL of server/ (no trailing slash). */
export const API_URL: string = (
  (import.meta.env?.VITE_API_URL as string | undefined) ?? 'http://localhost:4010'
).replace(/\/+$/, '');

const TOKEN_KEY = 'hrms.api.token';
const SESSION_KEY = 'hrms.session'; // shared with lib/auth.ts (same Session shape)
const ACTIVE_TENANT_KEY = 'myhrms:activeTenant'; // shared with lib/db.ts
const SYSTEM_VIEW = '__system__';

// ─────────────────────────────────────────────────────────────────────────────
// DataProvider — the interface BOTH backends satisfy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One storage backend. `createLocalProvider()` adapts lib/db.ts (localStorage);
 * `createApiProvider()` talks to server/. All methods are Promise-based so the
 * two are interchangeable; hooks are NOT part of the interface (local mode:
 * useCollection from lib/db.ts; api mode: useCollection from this module).
 */
export interface DataProvider {
  readonly mode: DataMode;

  // Auth
  login(username: string, password: string): Promise<Session>;
  logout(): Promise<void>;
  getSession(): Promise<Session | null>;

  // Tenant directory
  getCompanies(): Promise<Company[]>;

  // Collections (tenantId only for SuperAdmin cross-tenant tooling)
  getCollection<T>(name: CollectionName, tenantId?: string): Promise<T[]>;
  setCollection<T>(name: CollectionName, items: T[], tenantId?: string): Promise<void>;
  addItem<T extends { id: string }>(name: CollectionName, item: Omit<T, 'id'> & { id?: string }, tenantId?: string): Promise<T>;
  updateItem<T>(name: CollectionName, id: string, patch: Partial<T>, tenantId?: string): Promise<T>;
  removeItem(name: CollectionName, id: string, tenantId?: string): Promise<void>;

  // Audit
  logAudit(entry: Omit<import('./types').AuditLog, 'id' | 'at'> & { at?: string }, tenantId?: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token + session plumbing
// ─────────────────────────────────────────────────────────────────────────────

export function getApiToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setApiToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Session written by api login() — identical shape to lib/auth.ts Session. */
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

/** Company scope for outgoing requests: explicit arg, else the active tenant. */
function scopeCompany(tenantId?: string): string | undefined {
  if (tenantId) return tenantId;
  try {
    const raw = localStorage.getItem(ACTIVE_TENANT_KEY);
    if (raw && raw !== SYSTEM_VIEW) return raw;
  } catch {
    /* ignore */
  }
  return getSession()?.companyId ?? undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP core
// ─────────────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  method: string,
  path: string,
  opts: { body?: unknown; tenantId?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getApiToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const company = scopeCompany(opts.tenantId);
  if (company) headers['x-company-id'] = company;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API_URL}${path}`, { method, headers, body });
  if (res.status === 401) {
    setApiToken(null);
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(res.status, (data.error as string) ?? `Request failed (${res.status})`);
  }
  return data as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — mirrors lib/db.ts + lib/auth.ts surface
// ─────────────────────────────────────────────────────────────────────────────

export interface LoginResponse {
  token: string;
  expiresIn: string;
  user: { id: string; username: string; role: AuthRole; companyId: string | null; employeeId?: string };
}

/**
 * Log in against the API. Stores the JWT AND a db.ts-compatible Session
 * ('hrms.session') + active-tenant key, so the existing AuthProvider /
 * TenantProvider read the same keys they already use.
 */
export async function login(username: string, password: string): Promise<Session> {
  const res = await request<LoginResponse>('POST', '/auth/login', { body: { username, password } });
  setApiToken(res.token);
  const session: Session = {
    userId: res.user.id,
    username: res.user.username,
    role: res.user.role,
    companyId: res.user.companyId,
    employeeId: res.user.employeeId,
    loginAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.setItem(ACTIVE_TENANT_KEY, res.user.companyId ?? SYSTEM_VIEW);
  } catch {
    /* non-fatal */
  }
  return session;
}

export async function logout(): Promise<void> {
  setApiToken(null);
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* non-fatal */
  }
}

export async function getCompanies(): Promise<Company[]> {
  return request<Company[]>('GET', '/api/companies');
}

export async function getCollection<T>(name: CollectionName, tenantId?: string): Promise<T[]> {
  return request<T[]>('GET', `/api/${name}`, { tenantId });
}

/** setCollection() mirror — whole-collection replace (Admin/HR server-side). */
export async function setCollection<T>(name: CollectionName, items: T[], tenantId?: string): Promise<void> {
  await request('PUT', `/api/${name}`, { body: items, tenantId });
}

export async function addItem<T extends { id: string }>(
  name: CollectionName,
  item: Omit<T, 'id'> & { id?: string },
  tenantId?: string,
): Promise<T> {
  return request<T>('POST', `/api/${name}`, { body: item, tenantId });
}

export async function updateItem<T>(
  name: CollectionName,
  id: string,
  patch: Partial<T>,
  tenantId?: string,
): Promise<T> {
  return request<T>('PATCH', `/api/${name}/${encodeURIComponent(id)}`, { body: patch, tenantId });
}

export async function removeItem(name: CollectionName, id: string, tenantId?: string): Promise<void> {
  await request('DELETE', `/api/${name}/${encodeURIComponent(id)}`, { tenantId });
}

export async function logAudit(
  entry: Omit<import('./types').AuditLog, 'id' | 'at'> & { at?: string },
  tenantId?: string,
): Promise<void> {
  await request('POST', '/api/audit', {
    body: {
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      detail: entry.detail,
    },
    tenantId,
  });
}

/** Payroll run — server computes with the same statutory engine. */
export async function runPayroll(
  month: string,
  employeeIds?: string[],
  opts: { draft?: boolean; tenantId?: string } = {},
): Promise<{ run: unknown; payslips: unknown[] }> {
  return request('POST', '/api/payroll/run', {
    body: { month, employeeIds, draft: opts.draft },
    tenantId: opts.tenantId,
  });
}

/** Finalize a draft run (stamps its claims 'paid'). */
export async function finalizePayroll(runId: string, tenantId?: string): Promise<{ run: unknown }> {
  return request('POST', '/api/payroll/finalize', { body: { runId }, tenantId });
}

/** Undo by runId, or the latest run of a month ('YYYY-MM'). */
export async function undoPayroll(
  target: { runId: string } | { month: string },
  tenantId?: string,
): Promise<{ ok: boolean }> {
  return request('POST', '/api/payroll/undo', { body: target, tenantId });
}

export interface PayslipAdjustmentInput {
  id: string;
  kind: 'earning' | 'deduction';
  preset: 'cp38' | 'zakat' | 'ptptn' | 'custom';
  label: string;
  amount: number;
}

/** Replace one employee's ad-hoc adjustments inside a draft run. */
export async function adjustPayslip(
  runId: string,
  employeeId: string,
  adjustments: PayslipAdjustmentInput[],
  tenantId?: string,
): Promise<{ run: unknown; payslip: unknown }> {
  return request('POST', '/api/payroll/payslip/adjust', {
    body: { runId, employeeId, adjustments },
    tenantId,
  });
}

/** Reset one employee's draft payslip to computed defaults. */
export async function resetPayslip(
  runId: string,
  employeeId: string,
  tenantId?: string,
): Promise<{ run: unknown; payslip: unknown }> {
  return request('POST', '/api/payroll/payslip/reset', { body: { runId, employeeId }, tenantId });
}

/** Exclude one employee from a draft run. */
export async function excludeFromRun(
  runId: string,
  employeeId: string,
  tenantId?: string,
): Promise<{ run: unknown; removedSlipId: string }> {
  return request('POST', '/api/payroll/payslip/exclude', { body: { runId, employeeId }, tenantId });
}

// ─────────────────────────────────────────────────────────────────────────────
// API-mode reactive hook: cache + fetch-on-subscribe + refetch-after-write
// ─────────────────────────────────────────────────────────────────────────────

const cache = new Map<string, unknown[]>();
const versions = new Map<string, number>();
const listenerSets = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();

function cacheKey(name: CollectionName, tenantId?: string): string {
  return `${scopeCompany(tenantId) ?? ''}:${name}`;
}

function emit(key: string): void {
  versions.set(key, (versions.get(key) ?? 0) + 1);
  listenerSets.get(key)?.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break writes */
    }
  });
}

/** Fetch (or refetch) a collection into the cache and notify subscribers. */
export async function refreshCollection(name: CollectionName, tenantId?: string): Promise<void> {
  const key = cacheKey(name, tenantId);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      cache.set(key, await getCollection(name, tenantId));
      emit(key);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Clear cached collections (call on logout / tenant switch). */
export function clearApiCache(): void {
  cache.clear();
  versions.clear();
  listenerSets.forEach((fns) =>
    fns.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }),
  );
}

/**
 * API-mode useCollection — same CollectionApi shape as lib/db.ts.
 * Reads come from the in-memory cache (fetched on first subscribe); mutations
 * hit the API and then refresh the cache. NOT used in local mode.
 */
export function useCollection<T extends { id: string }>(name: CollectionName): CollectionApi<T> {
  const key = cacheKey(name);
  const version = useSyncExternalStore(
    (fn) => {
      if (!listenerSets.has(key)) listenerSets.set(key, new Set());
      listenerSets.get(key)!.add(fn);
      if (!cache.has(key) && !inflight.has(key)) void refreshCollection(name);
      return () => listenerSets.get(key)?.delete(fn);
    },
    () => versions.get(key) ?? 0,
  );
  void version; // snapshot token — the cache is the source
  const items = (cache.get(key) ?? []) as T[];
  return {
    items,
    add: (item) => {
      void addItem<T>(name, item).finally(() => void refreshCollection(name));
      // CollectionApi.add is synchronous in db.ts; in API mode the optimistic
      // return carries the caller-provided fields and the row appears for real
      // on refresh. Integration agents should prefer the async addItem().
      return { ...item, id: item.id ?? `pending-${Date.now()}` } as T;
    },
    update: (id, patch) => {
      void updateItem(name, id, patch).finally(() => void refreshCollection(name));
    },
    remove: (id) => {
      void removeItem(name, id).finally(() => void refreshCollection(name));
    },
    reset: (next) => {
      void setCollection(name, next ?? []).finally(() => void refreshCollection(name));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider factory
// ─────────────────────────────────────────────────────────────────────────────

/** The API-backed provider. */
export function createApiProvider(): DataProvider {
  return {
    mode: 'api',
    login,
    logout,
    getSession: async () => getSession(),
    getCompanies,
    getCollection,
    setCollection,
    addItem,
    updateItem,
    removeItem,
    logAudit,
  };
}

/**
 * The localStorage-backed provider — thin async wrapper over lib/db.ts.
 * db.ts is loaded lazily so API mode never triggers its demo-seed side effects.
 */
export function createLocalProvider(): DataProvider {
  return {
    mode: 'local',
    async login(username, password) {
      const auth = await import('./auth');
      const res = auth.login(username, password);
      if (!res.ok) throw new ApiError(401, res.error);
      return auth.getSession()!;
    },
    async logout() {
      (await import('./auth')).logout();
    },
    getSession: async () => (await import('./auth')).getSession(),
    getCompanies: async () => (await import('./db')).getCompanies(),
    getCollection: async <T>(name: CollectionName, tenantId?: string) =>
      (await import('./db')).getCollection<T>(name, tenantId),
    setCollection: async <T>(name: CollectionName, items: T[], tenantId?: string) => {
      (await import('./db')).setCollection(name, items, tenantId);
    },
    addItem: async <T extends { id: string }>(
      name: CollectionName,
      item: Omit<T, 'id'> & { id?: string },
      tenantId?: string,
    ) => {
      const db = await import('./db');
      const full = { ...item, id: item.id ?? db.uid() } as T;
      db.setCollection(name, [...db.getCollection<T>(name, tenantId), full], tenantId);
      return full;
    },
    updateItem: async <T>(name: CollectionName, id: string, patch: Partial<T>, tenantId?: string) => {
      const db = await import('./db');
      const items = db.getCollection<T & { id: string }>(name, tenantId);
      const next = items.map((it) => (it.id === id ? ({ ...it, ...patch } as T & { id: string }) : it));
      db.setCollection(name, next, tenantId);
      return next.find((it) => it.id === id)! as T;
    },
    removeItem: async (name, id, tenantId) => {
      const db = await import('./db');
      db.setCollection(
        name,
        db.getCollection<{ id: string }>(name, tenantId).filter((it) => it.id !== id),
        tenantId,
      );
    },
    logAudit: async (entry, tenantId) => {
      (await import('./db')).logAudit(entry, tenantId);
    },
  };
}

let provider: DataProvider | undefined;

/** The active backend, selected by VITE_DATA_MODE. */
export function getDataProvider(): DataProvider {
  if (!provider) provider = DATA_MODE === 'api' ? createApiProvider() : createLocalProvider();
  return provider;
}
