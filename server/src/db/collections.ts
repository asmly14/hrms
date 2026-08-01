/**
 * Collection registry — maps the web app's localStorage collection names
 * (hrms-web/src/lib/db.ts COLLECTIONS + orgChart/kpiEngine extras) to their
 * Postgres tables, and owns all generic document reads/writes.
 *
 * Documents are stored as JSONB; the columns listed in `extract` are pulled
 * out of the doc at write time so hot filters stay index-backed.
 */
import type { Queryable } from './pool';
import { pool } from './pool';
import { uid } from '../calc/utils';

export type Role = 'Admin' | 'HR' | 'Manager' | 'Employee' | 'SuperAdmin';

export interface JwtUser {
  userId: string;
  username: string;
  role: Role;
  /** NULL only for SuperAdmin. */
  companyId: string | null;
  employeeId?: string;
}

export interface CollectionDef {
  /** Postgres table name. */
  table: string;
  /** Rows carry employee_id → role scoping applies (Manager dept / Employee self). */
  employeeLinked?: boolean;
  /** Employee role may CREATE/PATCH rows tied to their own employeeId only. */
  selfService?: boolean;
  /** Global (national) collection — no tenant scope (holidays). */
  global?: boolean;
  /** Extra columns extracted from the JSON doc at write time. */
  extract?: (doc: Record<string, unknown>) => Record<string, unknown>;
}

const empId = (d: Record<string, unknown>) => ({ employee_id: (d.employeeId as string) ?? null });

export const COLLECTIONS: Record<string, CollectionDef> = {
  employees: {
    table: 'employees',
    extract: (d) => ({
      department_id: (d.departmentId as string) ?? null,
      employee_no: (d.employeeNo as string) ?? null,
      status: (d.status as string) ?? null,
    }),
  },
  departments: { table: 'departments' },
  positions: {
    table: 'positions',
    extract: (d) => ({ department_id: (d.departmentId as string) ?? null }),
  },
  shifts: { table: 'shifts' },
  attendance: {
    table: 'attendance',
    employeeLinked: true,
    selfService: true,
    extract: (d) => ({ ...empId(d), date: (d.date as string) ?? null }),
  },
  leaves: {
    table: 'leaves',
    employeeLinked: true,
    selfService: true,
    extract: (d) => ({ ...empId(d), status: (d.status as string) ?? null }),
  },
  leaveBalances: {
    table: 'leave_balances',
    employeeLinked: true,
    extract: (d) => ({ ...empId(d), year: Number.isFinite(Number(d.year)) ? Number(d.year) : null }),
  },
  claims: {
    table: 'claims',
    employeeLinked: true,
    selfService: true,
    extract: (d) => ({ ...empId(d), status: (d.status as string) ?? null }),
  },
  payrollRuns: {
    table: 'payroll_runs',
    extract: (d) => ({ month_key: (d.monthKey as string) ?? null }),
  },
  payslips: {
    table: 'payslips',
    employeeLinked: true,
    extract: (d) => ({
      ...empId(d),
      run_id: (d.runId as string) ?? null,
      month_key: (d.monthKey as string) ?? null,
    }),
  },
  kpis: { table: 'kpis', employeeLinked: true, extract: empId },
  reviews: { table: 'reviews', employeeLinked: true, extract: empId },
  cycles: { table: 'cycles' },
  objectives: { table: 'objectives', employeeLinked: true, selfService: true, extract: empId },
  checkins: { table: 'checkins', employeeLinked: true, selfService: true, extract: empId },
  pips: { table: 'pips', employeeLinked: true, extract: empId },
  holidays: { table: 'holidays', global: true, extract: (d) => ({ date: (d.date as string) ?? null }) },
  settings: { table: 'settings' },
  positionProfiles: {
    table: 'position_profiles',
    extract: (d) => ({ position_id: (d.positionId as string) ?? null }),
  },
  departmentProfiles: {
    table: 'department_profiles',
    extract: (d) => ({ department_id: (d.departmentId as string) ?? null }),
  },
};

export function collectionDef(name: string): CollectionDef | undefined {
  return COLLECTIONS[name];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant + role scope resolution
// ─────────────────────────────────────────────────────────────────────────────

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Which company a request targets. Company users are PINNED to their tenant —
 * an explicit scope for another company is a 403. SuperAdmin is cross-tenant
 * and must pass an explicit scope (header `x-company-id` or `?companyId=`) for
 * tenant collections; without one, tenant-scoped routes 400.
 */
export function resolveCompanyScope(
  user: JwtUser,
  requested: string | undefined,
  opts: { required?: boolean } = {},
): string | null {
  if (user.role === 'SuperAdmin') {
    if (requested) return requested;
    if (opts.required === false) return null;
    return null; // caller decides whether null is acceptable
  }
  if (!user.companyId) throw new HttpError(403, 'Account has no company scope.');
  if (requested && requested !== user.companyId) {
    throw new HttpError(403, 'Cross-company access is not permitted for this account.');
  }
  return user.companyId;
}

/** Resolve a manager's department within their company (null if unlinked). */
export async function managerDepartmentId(user: JwtUser, db: Queryable = pool): Promise<string | null> {
  if (!user.employeeId || !user.companyId) return null;
  const r = await db.query<{ department_id: string | null }>(
    'SELECT department_id FROM employees WHERE company_id = $1 AND id = $2',
    [user.companyId, user.employeeId],
  );
  return r.rows[0]?.department_id ?? null;
}

export interface ScopeFilter {
  /** SQL fragment (AND-prefixed) or empty string. */
  sql: string;
  params: unknown[];
}

/**
 * Row-visibility filter for a collection, mirroring the web app's scoping
 * (docs/auth-integration.md §4): Admin/HR/SuperAdmin → everything in company;
 * Manager → own department; Employee → self only. Fail-closed: a restricted
 * account with no resolvable scope sees nothing.
 */
export async function visibilityFilter(
  user: JwtUser,
  def: CollectionDef,
  companyId: string,
  startParam: number,
  db: Queryable = pool,
): Promise<ScopeFilter> {
  if (user.role === 'Admin' || user.role === 'HR' || user.role === 'SuperAdmin') {
    return { sql: '', params: [] };
  }
  if (user.role === 'Manager') {
    const dept = await managerDepartmentId(user, db);
    if (!dept) return { sql: ' AND FALSE', params: [] }; // fail closed
    if (def.table === 'employees') {
      return { sql: ` AND department_id = $${startParam}`, params: [dept] };
    }
    if (def.employeeLinked) {
      // Rows whose employee is in the manager's department; rows with no
      // employee link (company-level docs) stay visible to managers.
      return {
        sql:
          ` AND (employee_id IS NULL OR employee_id IN ` +
          `(SELECT id FROM employees WHERE company_id = $${startParam} AND department_id = $${startParam + 1}))`,
        params: [companyId, dept],
      };
    }
    return { sql: '', params: [] }; // non-employee-linked: readable in-company
  }
  // Employee — self only.
  if (!user.employeeId) return { sql: ' AND FALSE', params: [] };
  if (def.table === 'employees') {
    return { sql: ` AND id = $${startParam}`, params: [user.employeeId] };
  }
  if (def.employeeLinked) {
    return { sql: ` AND employee_id = $${startParam}`, params: [user.employeeId] };
  }
  return { sql: '', params: [] };
}

/**
 * May `user` WRITE a doc belonging to `targetEmployeeId` (undefined = doc has
 * no employee link)? Mirrors read scoping, stricter: Employee writes are only
 * allowed on selfService collections for their own rows; Manager only within
 * their department on employee-linked collections; non-linked collections are
 * Admin/HR/SuperAdmin-only.
 */
export async function assertWriteAllowed(
  user: JwtUser,
  def: CollectionDef,
  companyId: string,
  doc: Record<string, unknown>,
  db: Queryable = pool,
): Promise<void> {
  if (user.role === 'Admin' || user.role === 'HR' || user.role === 'SuperAdmin') return;
  const docEmployeeId = (doc.employeeId as string | undefined) ?? undefined;

  if (user.role === 'Employee') {
    if (!def.selfService) throw new HttpError(403, 'Employees cannot write this collection.');
    if (!user.employeeId || docEmployeeId !== user.employeeId) {
      throw new HttpError(403, 'Employees can only modify their own records.');
    }
    return;
  }
  if (user.role === 'Manager') {
    if (!def.employeeLinked) throw new HttpError(403, 'Managers cannot write this collection.');
    const dept = await managerDepartmentId(user, db);
    if (!dept) throw new HttpError(403, 'Manager account is not linked to an employee record.');
    // Writing a doc with no employee link (company-level) is Admin/HR-only.
    if (!docEmployeeId) throw new HttpError(403, 'Managers cannot write company-level records.');
    const r = await db.query<{ ok: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM employees WHERE company_id = $1 AND id = $2 AND department_id = $3) AS ok',
      [companyId, docEmployeeId, dept],
    );
    if (!r.rows[0]?.ok) throw new HttpError(403, 'Record is outside your department.');
    return;
  }
  throw new HttpError(403, 'Unknown role.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic document access
// ─────────────────────────────────────────────────────────────────────────────

interface DocRow {
  id: string;
  data: Record<string, unknown>;
}

function toDoc(row: DocRow): Record<string, unknown> {
  // id lives in the column; the JSONB doc mirrors the web record shape.
  return { ...row.data, id: row.data.id ?? row.id };
}

export async function listDocs(
  def: CollectionDef,
  companyId: string | null,
  filter: ScopeFilter = { sql: '', params: [] },
  db: Queryable = pool,
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  let where: string;
  if (def.global) {
    where = 'company_id IS NULL';
  } else {
    params.push(companyId);
    where = 'company_id = $1';
  }
  const r = await db.query<DocRow>(
    `SELECT id, data FROM ${def.table} WHERE ${where}${filter.sql} ORDER BY created_at ASC, id ASC`,
    [...params, ...filter.params],
  );
  return r.rows.map(toDoc);
}

export async function getDoc(
  def: CollectionDef,
  companyId: string | null,
  id: string,
  db: Queryable = pool,
): Promise<Record<string, unknown> | undefined> {
  const scopeSql = def.global ? 'company_id IS NULL' : 'company_id = $2';
  const params = def.global ? [id] : [id, companyId];
  const r = await db.query<DocRow>(`SELECT id, data FROM ${def.table} WHERE id = $1 AND ${scopeSql}`, params);
  return r.rows[0] ? toDoc(r.rows[0]) : undefined;
}

/** Insert or update a document; extracted columns are refreshed. Returns the stored doc. */
export async function upsertDoc(
  def: CollectionDef,
  companyId: string | null,
  doc: Record<string, unknown>,
  db: Queryable = pool,
): Promise<Record<string, unknown>> {
  const id = (doc.id as string) || uid();
  const full = { ...doc, id };
  const extra = def.extract ? def.extract(full) : {};
  const cols = ['company_id', 'id', 'data', ...Object.keys(extra)];
  const vals = [def.global ? null : companyId, id, JSON.stringify(full), ...Object.values(extra)];
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = ['data = EXCLUDED.data', 'updated_at = now()', ...Object.keys(extra).map((c) => `${c} = EXCLUDED.${c}`)];
  // holidays has an id-only PK (company_id is nullable); every other table
  // keys on (company_id, id).
  const conflict = def.global ? '(id)' : '(company_id, id)';
  await db.query(
    `INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ` +
      `ON CONFLICT ${conflict} DO UPDATE SET ${updates.join(', ')}`,
    vals,
  );
  return full;
}

export async function deleteDoc(
  def: CollectionDef,
  companyId: string | null,
  id: string,
  db: Queryable = pool,
): Promise<boolean> {
  const scopeSql = def.global ? 'company_id IS NULL' : 'company_id = $2';
  const params = def.global ? [id] : [id, companyId];
  const r = await db.query(`DELETE FROM ${def.table} WHERE id = $1 AND ${scopeSql}`, params);
  return (r.rowCount ?? 0) > 0;
}

/** setCollection() mirror: replace the whole tenant collection with `docs`. */
export async function replaceCollection(
  def: CollectionDef,
  companyId: string | null,
  docs: Record<string, unknown>[],
  db: Queryable,
): Promise<void> {
  const scopeSql = def.global ? 'company_id IS NULL' : 'company_id = $1';
  await db.query(`DELETE FROM ${def.table} WHERE ${scopeSql}`, def.global ? [] : [companyId]);
  for (const doc of docs) {
    await upsertDoc(def, companyId, doc, db);
  }
}
