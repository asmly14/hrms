/**
 * Org chart data bridge — Organization designer (M10, /org + /org/chart).
 *
 * Two concerns live here:
 *
 * 1. EXTRA PER-TENANT COLLECTIONS. `lib/db.ts` keeps a fixed CollectionName
 *    union that module agents must not extend, so the org designer persists
 *    its own documents under the SAME physical naming convention
 *    (`myhrms:t:<companyId>:<collection>`) with a tiny private pub/sub that
 *    also re-reads on tenant switches (subscribeTenant from db.ts):
 *
 *      positionProfiles   → PositionProfile[]   (keyed by positionId)
 *      departmentProfiles → DepartmentProfile[] (keyed by departmentId)
 *
 *    Position fields that do not exist on `Position` in lib/types.ts (grade
 *    L1–L8, reporting-line overrides, dotted-line co-manager, job
 *    description, responsibilities, qualifications, headcount budget) live
 *    in PositionProfile. Department extras (cost centre, colour) live in
 *    DepartmentProfile. Base records stay in the seeded 'positions' /
 *    'departments' collections; profiles are merged at read time.
 *
 * 2. HIERARCHY DERIVATION. Seed positions carry no reportsToPositionId, so
 *    buildInitialChart() derives a sensible tree (MD/GM/CEO-style root →
 *    department leads → staff). User edits (drag-to-reparent in the chart,
 *    form selects) persist as explicit overrides in PositionProfile and win
 *    over the derivation, so the chart is stable across reloads.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { DEFAULT_COMPANY_ID, getActiveTenantId, subscribeTenant, uid } from './db';
import { bandForYears, listRoles, suggestSalary, type SalarySuggestion } from './salaryBenchmark';
import type { Department, Employee, Position, PositionLevel, StateCode } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Profile document shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Org-designer extras for one Position (id === positionId). */
export interface PositionProfile {
  id: string;                       // === positionId (document key)
  positionId: string;
  /** Pay grade, e.g. 'L1'…'L8'. Defaults derive from Position.level. */
  grade?: string;
  /** Explicit reporting-line override. undefined = derive via buildInitialChart; null = root. */
  reportsToPositionId?: string | null;
  /** Secondary (matrix/dotted-line) manager, rendered as a dashed edge. */
  dottedLineReportsToPositionId?: string | null;
  jobDescription?: string;
  responsibilities: string[];
  qualifications: string[];
  /** Planned headcount; vacancy when headcountBudget > actual active holders. */
  headcountBudget?: number;
  updatedAt: string;                // ISO datetime
}

/** Org-designer extras for one Department (id === departmentId). */
export interface DepartmentProfile {
  id: string;                       // === departmentId (document key)
  departmentId: string;
  /** Cost centre / GL code for finance rollups, e.g. 'CC-100'. */
  costCenter?: string;
  /** Hex colour used on chart nodes, badges and tables, e.g. '#b45309'. */
  color?: string;
  updatedAt: string;
}

export type PositionProfilePatch = Partial<
  Omit<PositionProfile, 'id' | 'positionId' | 'updatedAt'>
>;
export type DepartmentProfilePatch = Partial<
  Omit<DepartmentProfile, 'id' | 'departmentId' | 'updatedAt'>
>;

// ─────────────────────────────────────────────────────────────────────────────
// Private per-tenant storage (mirrors db.ts key convention + pub/sub)
// ─────────────────────────────────────────────────────────────────────────────

const TENANT_PREFIX = 'myhrms:t:';
type ExtraCollection = 'positionProfiles' | 'departmentProfiles';

type Listener = () => void;
const listeners = new Map<ExtraCollection, Set<Listener>>();

function keyFor(name: ExtraCollection, tenantId?: string): string {
  return `${TENANT_PREFIX}${tenantId ?? getActiveTenantId() ?? DEFAULT_COMPANY_ID}:${name}`;
}

function readRaw<T>(name: ExtraCollection, tenantId?: string): T[] {
  try {
    const raw = localStorage.getItem(keyFor(name, tenantId));
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function writeRaw<T>(name: ExtraCollection, items: T[], tenantId?: string): void {
  try {
    localStorage.setItem(keyFor(name, tenantId), JSON.stringify(items));
  } catch {
    /* storage unavailable — demo mode keeps running in-memory */
  }
  listeners.get(name)?.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break writes */
    }
  });
}

function subscribe(name: ExtraCollection, fn: Listener): () => void {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
  return () => {
    listeners.get(name)?.delete(fn);
  };
}

export interface ProfileCollectionApi<T extends { id: string }, TPatch> {
  items: T[];
  upsert: (keyId: string, patch: TPatch) => T;
  remove: (keyId: string) => void;
}

/**
 * Reactive profile-collection hook — re-renders on own writes AND on
 * active-tenant switches (via db.ts subscribeTenant). Always scoped to the
 * active tenant, matching useCollection semantics.
 */
function useProfileCollection<T extends { id: string }, TPatch>(
  name: ExtraCollection,
  keyOf: (item: T) => string,
  make: (keyId: string, patch: TPatch) => T,
): ProfileCollectionApi<T, TPatch> {
  // Re-render on tenant switch so the snapshot below re-reads the new namespace.
  useSyncExternalStore(subscribeTenant, () => getActiveTenantId() ?? '__system__');
  const raw = useSyncExternalStore(
    (fn) => subscribe(name, fn),
    () => {
      try {
        return localStorage.getItem(keyFor(name)) ?? '';
      } catch {
        return '';
      }
    },
  );
  // Parse once per snapshot: keyed by the raw string so `items` keeps a
  // stable reference across re-renders (a fresh array identity per render
  // cascades through consumer useMemo chains into infinite setState loops).
  const items = useMemo(() => (raw ? (JSON.parse(raw) as T[]) : []), [raw]);
  return {
    items,
    upsert: (keyId, patch) => {
      const all = readRaw<T>(name);
      const idx = all.findIndex((it) => keyOf(it) === keyId);
      const next = idx >= 0 ? { ...all[idx], ...patch, id: keyId } : make(keyId, patch);
      if (idx >= 0) all[idx] = next;
      else all.push(next);
      writeRaw(name, all);
      return next;
    },
    remove: (keyId) => {
      writeRaw(
        name,
        readRaw<T>(name).filter((it) => keyOf(it) !== keyId),
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Position profiles — public API
// ─────────────────────────────────────────────────────────────────────────────

/** All position profiles for the active (or given) tenant. Non-reactive. */
export function getPositionProfiles(tenantId?: string): PositionProfile[] {
  return readRaw<PositionProfile>('positionProfiles', tenantId);
}

/** One profile by positionId, or undefined when never customised. */
export function getPositionProfile(positionId: string, tenantId?: string): PositionProfile | undefined {
  return getPositionProfiles(tenantId).find((p) => p.positionId === positionId);
}

/**
 * Insert-or-update the profile for a position. Accepts a shallow patch; a new
 * document is created (with safe defaults) on first customisation.
 */
export function upsertPositionProfile(
  positionId: string,
  patch: PositionProfilePatch,
  tenantId?: string,
): PositionProfile {
  const all = readRaw<PositionProfile>('positionProfiles', tenantId);
  const idx = all.findIndex((p) => p.positionId === positionId);
  const base: PositionProfile =
    idx >= 0
      ? all[idx]
      : {
          id: positionId,
          positionId,
          responsibilities: [],
          qualifications: [],
          updatedAt: new Date().toISOString(),
        };
  const next: PositionProfile = { ...base, ...patch, id: positionId, positionId, updatedAt: new Date().toISOString() };
  if (idx >= 0) all[idx] = next;
  else all.push(next);
  writeRaw('positionProfiles', all, tenantId);
  return next;
}

/** Delete a position's profile (called when the position itself is deleted). */
export function removePositionProfile(positionId: string, tenantId?: string): void {
  writeRaw(
    'positionProfiles',
    readRaw<PositionProfile>('positionProfiles', tenantId).filter((p) => p.positionId !== positionId),
    tenantId,
  );
}

/** Reactive position-profile collection (active tenant). */
export function usePositionProfiles(): ProfileCollectionApi<PositionProfile, PositionProfilePatch> {
  return useProfileCollection<PositionProfile, PositionProfilePatch>(
    'positionProfiles',
    (p) => p.positionId,
    (positionId, patch) => ({
      id: positionId,
      positionId,
      responsibilities: [],
      qualifications: [],
      ...patch,
      updatedAt: new Date().toISOString(),
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Department profiles — public API
// ─────────────────────────────────────────────────────────────────────────────

/** All department profiles for the active (or given) tenant. Non-reactive. */
export function getDepartmentProfiles(tenantId?: string): DepartmentProfile[] {
  return readRaw<DepartmentProfile>('departmentProfiles', tenantId);
}

/** One profile by departmentId, or undefined when never customised. */
export function getDepartmentProfile(departmentId: string, tenantId?: string): DepartmentProfile | undefined {
  return getDepartmentProfiles(tenantId).find((p) => p.departmentId === departmentId);
}

/** Insert-or-update the profile for a department (cost centre, colour). */
export function upsertDepartmentProfile(
  departmentId: string,
  patch: DepartmentProfilePatch,
  tenantId?: string,
): DepartmentProfile {
  const all = readRaw<DepartmentProfile>('departmentProfiles', tenantId);
  const idx = all.findIndex((p) => p.departmentId === departmentId);
  const base: DepartmentProfile =
    idx >= 0
      ? all[idx]
      : { id: departmentId, departmentId, updatedAt: new Date().toISOString() };
  const next: DepartmentProfile = { ...base, ...patch, id: departmentId, departmentId, updatedAt: new Date().toISOString() };
  if (idx >= 0) all[idx] = next;
  else all.push(next);
  writeRaw('departmentProfiles', all, tenantId);
  return next;
}

/** Delete a department's profile (called when the department itself is deleted). */
export function removeDepartmentProfile(departmentId: string, tenantId?: string): void {
  writeRaw(
    'departmentProfiles',
    readRaw<DepartmentProfile>('departmentProfiles', tenantId).filter((p) => p.departmentId !== departmentId),
    tenantId,
  );
}

/** Reactive department-profile collection (active tenant). */
export function useDepartmentProfiles(): ProfileCollectionApi<DepartmentProfile, DepartmentProfilePatch> {
  return useProfileCollection<DepartmentProfile, DepartmentProfilePatch>(
    'departmentProfiles',
    (p) => p.departmentId,
    (departmentId, patch) => ({ id: departmentId, departmentId, ...patch, updatedAt: new Date().toISOString() }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Grades & levels
// ─────────────────────────────────────────────────────────────────────────────

/** Seniority ordering of Position.level (higher = more senior). */
export const LEVEL_RANK: Record<PositionLevel, number> = {
  junior: 0,
  senior: 1,
  lead: 2,
  manager: 3,
  exec: 4,
};

/** Pay grades offered in the designer (L1 entry … L8 executive). */
export const GRADES = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'] as const;
export type Grade = (typeof GRADES)[number];

/** Default grade for a Position.level when no profile grade is set. */
export function gradeForLevel(level: PositionLevel): Grade {
  switch (level) {
    case 'junior':
      return 'L2';
    case 'senior':
      return 'L4';
    case 'lead':
      return 'L5';
    case 'manager':
      return 'L6';
    case 'exec':
      return 'L8';
  }
}

/** Representative years-of-experience per level, for salaryBenchmark bands. */
export function seniorityForLevel(level: PositionLevel): number {
  switch (level) {
    case 'junior':
      return 1;
    case 'senior':
      return 4;
    case 'lead':
      return 6;
    case 'manager':
      return 8;
    case 'exec':
      return 12;
  }
}

/** Effective grade shown in the UI: profile override wins, else level default. */
export function effectiveGrade(position: Position, profile?: PositionProfile): Grade | string {
  return profile?.grade || gradeForLevel(position.level);
}

// ─────────────────────────────────────────────────────────────────────────────
// Headcount & vacancies
// ─────────────────────────────────────────────────────────────────────────────

/** Employees that count toward headcount (active + probation, not resigned). */
export function activeEmployees(employees: Employee[]): Employee[] {
  return employees.filter((e) => e.status !== 'resigned');
}

/** positionId → number of active holders. */
export function headcountByPosition(employees: Employee[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of activeEmployees(employees)) {
    map.set(e.positionId, (map.get(e.positionId) ?? 0) + 1);
  }
  return map;
}

/**
 * Vacancy test: a budgeted position with fewer active holders than its
 * headcount budget. Unbudgeted positions are never "vacant" by this flag
 * (they are simply unmanaged).
 */
export function isVacant(profile: PositionProfile | undefined, actual: number): boolean {
  const budget = profile?.headcountBudget;
  return typeof budget === 'number' && budget > actual;
}

/** Open requisition count (0 when not vacant). */
export function vacancyCount(profile: PositionProfile | undefined, actual: number): number {
  const budget = profile?.headcountBudget ?? 0;
  return Math.max(0, budget - actual);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchy derivation + resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Titles that mark the organisation root when present in seed data. */
const ROOT_TITLE_RE = /managing director|general manager|chief executive|\bceo\b|\bmd\b/i;

function bySeniorityDesc(a: Position, b: Position): number {
  return LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.maxSalary - a.maxSalary;
}

/**
 * Derive an initial reporting tree for tenants whose positions carry no
 * reporting lines. Returns positionId → parentPositionId (null for the root).
 *
 * Rules:
 *  1. Root = position titled MD / General Manager / CEO / Chief Executive
 *     when present, else the most senior position (level, then salary band).
 *  2. Each department's lead position = the position held by the department
 *     head (Department.headId), else the most senior position in that
 *     department. Leads report to the root.
 *  3. Every other position reports to its own department's lead.
 *  4. Positions in unknown/empty departments attach directly to the root.
 */
export function buildInitialChart(
  positions: Position[],
  employees: Employee[],
  departments: Department[],
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  if (positions.length === 0) return result;

  // 1. Root
  const named = positions.filter((p) => ROOT_TITLE_RE.test(p.title));
  const root = [...(named.length > 0 ? named : positions)].sort(bySeniorityDesc)[0];

  // 2. Department leads
  const active = activeEmployees(employees);
  const empById = new Map(active.map((e) => [e.id, e]));
  const posById = new Map(positions.map((p) => [p.id, p]));
  const deptIds = new Set(departments.map((d) => d.id));
  const leadByDept = new Map<string, Position>();
  for (const dept of departments) {
    const head = dept.headId ? empById.get(dept.headId) : undefined;
    let lead = head ? posById.get(head.positionId) : undefined;
    if (!lead || lead.departmentId !== dept.id) {
      lead = positions.filter((p) => p.departmentId === dept.id).sort(bySeniorityDesc)[0];
    }
    if (lead) leadByDept.set(dept.id, lead);
  }

  // 3. Assign parents
  for (const p of positions) {
    if (p.id === root.id) {
      result[p.id] = null;
      continue;
    }
    const lead = deptIds.has(p.departmentId) ? leadByDept.get(p.departmentId) : undefined;
    if (lead && lead.id !== p.id) {
      result[p.id] = lead.id;
    } else {
      // Department leads themselves, unknown departments, singletons → root.
      result[p.id] = root.id;
    }
  }
  return result;
}

/**
 * Effective reporting tree: buildInitialChart overlaid with explicit
 * PositionProfile overrides. Overrides pointing at missing positions or
 * creating cycles are ignored (fall back to the derived parent) so the chart
 * can never wedge itself.
 */
export function resolveReportsTo(
  positions: Position[],
  profiles: PositionProfile[],
  employees: Employee[],
  departments: Department[],
): Record<string, string | null> {
  const derived = buildInitialChart(positions, employees, departments);
  const posIds = new Set(positions.map((p) => p.id));
  const result: Record<string, string | null> = { ...derived };
  for (const profile of profiles) {
    if (!posIds.has(profile.positionId)) continue;
    if (profile.reportsToPositionId === undefined) continue;
    const target = profile.reportsToPositionId;
    if (target === null) {
      result[profile.positionId] = null;
      continue;
    }
    if (!posIds.has(target) || target === profile.positionId) continue;
    // Apply tentatively; reject when it would create a cycle.
    const trial = { ...result, [profile.positionId]: target };
    if (!createsCycle(trial, profile.positionId)) {
      result[profile.positionId] = target;
    }
  }
  return result;
}

/** True when following parent pointers from `startId` loops back to itself. */
function createsCycle(parentMap: Record<string, string | null>, startId: string): boolean {
  const seen = new Set<string>();
  let cursor: string | null | undefined = parentMap[startId];
  while (cursor) {
    if (cursor === startId) return true;
    if (seen.has(cursor)) return false; // pre-existing loop elsewhere — not ours
    seen.add(cursor);
    cursor = parentMap[cursor];
  }
  return false;
}

/**
 * Would assigning `childId` to report to `newParentId` create a cycle?
 * (i.e. newParentId is the child itself or one of its descendants.)
 */
export function wouldCreateCycle(
  parentMap: Record<string, string | null>,
  childId: string,
  newParentId: string,
): boolean {
  if (childId === newParentId) return true;
  return collectDescendants(parentMap, childId).has(newParentId);
}

/** All positionIds under `rootId` in the given parent map (excluding rootId). */
export function collectDescendants(
  parentMap: Record<string, string | null>,
  rootId: string,
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const [id, parent] of Object.entries(parentMap)) {
    if (!parent) continue;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(id);
  }
  const out = new Set<string>();
  const queue = [...(childrenOf.get(rootId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return out;
}

/** Direct children of `positionId` in the parent map. */
export function directReports(parentMap: Record<string, string | null>, positionId: string): string[] {
  return Object.entries(parentMap)
    .filter(([, parent]) => parent === positionId)
    .map(([id]) => id);
}

/**
 * Employee-level reporting tree for the chart's "People" mode:
 * employeeId → managerEmployeeId (null for the root holder / orphans).
 *
 * Manager resolution climbs the POSITION tree from the employee's position:
 * the first active holder of the nearest ancestor position wins. Employees
 * whose position chain finds no holder attach to the root holder.
 */
export function buildEmployeeTree(
  employees: Employee[],
  positionParentMap: Record<string, string | null>,
): Record<string, string | null> {
  const active = activeEmployees(employees);
  const result: Record<string, string | null> = {};
  if (active.length === 0) return result;

  // positionId → holders (stable: longest-serving first = most senior holder)
  const holders = new Map<string, Employee[]>();
  const bySeniority = [...active].sort((a, b) => a.joinDate.localeCompare(b.joinDate));
  for (const e of bySeniority) {
    if (!holders.has(e.positionId)) holders.set(e.positionId, []);
    holders.get(e.positionId)!.push(e);
  }
  const firstHolder = (positionId: string | null | undefined): Employee | undefined =>
    positionId ? holders.get(positionId)?.[0] : undefined;

  const rootPositionId = Object.entries(positionParentMap).find(([, p]) => p === null)?.[0];
  const rootEmployee = firstHolder(rootPositionId) ?? bySeniority[0];

  for (const e of active) {
    if (e.id === rootEmployee.id) {
      result[e.id] = null;
      continue;
    }
    let manager: Employee | undefined;
    const seen = new Set<string>();
    let cursor: string | null | undefined = positionParentMap[e.positionId];
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const holder = firstHolder(cursor);
      if (holder && holder.id !== e.id) {
        manager = holder;
        break;
      }
      cursor = positionParentMap[cursor];
    }
    result[e.id] = manager?.id ?? (rootEmployee.id !== e.id ? rootEmployee.id : null);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark bridge (salaryBenchmark)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Market suggestion for a position: wraps salaryBenchmark.suggestSalary with
 * the position's title, a seniority derived from its level, the tenant HQ
 * state (wage-market factor) and the department name (fallback matching).
 */
export function benchmarkForPosition(
  title: string,
  level: PositionLevel,
  state: StateCode = 'KUL',
  departmentName?: string,
): SalarySuggestion {
  return suggestSalary(title, seniorityForLevel(level), state, departmentName);
}

/**
 * JD template lookup: find a researched benchmark row by role name so the
 * editor can prefill description / qualifications / band from market data
 * (salaryBenchmark.listRoles is the source list).
 */
export function benchmarkTemplate(role: string): ReturnType<typeof listRoles>[number] | undefined {
  return listRoles().find((r) => r.role === role);
}

/** Benchmark band for a template role at a position level (no state factor). */
export function templateBand(role: string, level: PositionLevel): { min: number; median: number; max: number } | undefined {
  const row = benchmarkTemplate(role);
  return row ? row.bands[bandForYears(seniorityForLevel(level))] : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Department colours
// ─────────────────────────────────────────────────────────────────────────────

/** Warm palette offered in the department editor (hex values). */
export const DEPT_COLOR_PALETTE: { name: string; value: string }[] = [
  { name: 'Amber', value: '#b45309' },
  { name: 'Orange', value: '#c2410c' },
  { name: 'Rust', value: '#9a3412' },
  { name: 'Rose', value: '#be185d' },
  { name: 'Olive', value: '#4d7c0f' },
  { name: 'Teal', value: '#0f766e' },
  { name: 'Steel', value: '#475569' },
  { name: 'Taupe', value: '#78716c' },
];

/** Deterministic fallback colour when a department has no profile colour. */
export function defaultDeptColor(departmentId: string): string {
  let h = 0;
  for (const c of departmentId) h = (h * 31 + c.charCodeAt(0)) % 997;
  return DEPT_COLOR_PALETTE[h % DEPT_COLOR_PALETTE.length].value;
}

/** Effective colour for a department: profile override wins. */
export function deptColor(departmentId: string, profiles: DepartmentProfile[]): string {
  return profiles.find((p) => p.departmentId === departmentId)?.color || defaultDeptColor(departmentId);
}

/** Re-export uid so org pages generate ids consistently with db.ts. */
export { uid };
