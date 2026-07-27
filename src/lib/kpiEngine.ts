/**
 * KPI engine — Wave 2 module library for the KPI & Performance product.
 *
 * Owned by the KPI module (KPIFull_Builder). Extends the Wave-1 module-local
 * helpers in `src/pages/kpi/lib.ts` with:
 *
 *   - First-class review-cycle entities with a stage machine
 *     (setup → self-review → manager-review → calibration → acknowledged → closed)
 *     and per-transition guards.
 *   - OKR mode: objectives + measurable key results with progress roll-up.
 *   - Goal cascading: parent → child objective links (tree by department).
 *   - Check-ins: dated 1:1 notes threaded per review.
 *   - PIPs: performance improvement plans with goals, dates and check-in notes.
 *   - Reviewer routing (department headId → dept seniority → HR; never self).
 *   - Unified per-employee weight validation (=100%) used by every write path.
 *   - Role-gating predicates built on the Wave-1 auth API (`AuthContextValue`);
 *     all predicates fail OPEN when auth is null (pre-integration demo mode).
 *
 * Persistence: new localStorage collections 'cycles', 'objectives', 'checkins',
 * 'pips'. The db layer is schemaless JSON keyed by collection name; the
 * CollectionName union in db.ts is owned by another scope, so the names are
 * cast here (runtime behaviour is identical — a string key prefix).
 */
import { useCollection, type CollectionName } from './db';
import type {
  Department, Employee, KPI, KPIReview, Position, PositionLevel, ReviewStatus,
} from './types';
import type { AuthContextValue } from './authContext';

// ── Collections (new this wave) ──────────────────────────────────────────────

const asCollection = (name: string): CollectionName => name as unknown as CollectionName;

export const CYCLES_COLLECTION = asCollection('cycles');
export const OBJECTIVES_COLLECTION = asCollection('objectives');
export const CHECKINS_COLLECTION = asCollection('checkins');
export const PIPS_COLLECTION = asCollection('pips');

// ── Review status helpers ────────────────────────────────────────────────────

/** Reviews that count as final for analytics (calibration, 9-box, outcomes). */
export const FINAL_REVIEW_STATUSES: ReviewStatus[] = ['submitted', 'acknowledged'];

/**
 * Draft-free analytics predicate: only submitted / acknowledged reviews with a
 * real score. Partial drafts (depressed overalls) never leak into histograms,
 * bias flags, 9-box or increment tables.
 */
export function isFinalReview(r: Pick<KPIReview, 'status' | 'overallScore'>): boolean {
  return FINAL_REVIEW_STATUSES.includes(r.status) && r.overallScore > 0;
}

// ── Cycle entity + stage machine ─────────────────────────────────────────────

export type CycleStage =
  | 'setup'
  | 'self-review'
  | 'manager-review'
  | 'calibration'
  | 'acknowledged'
  | 'closed';

export const CYCLE_STAGES: CycleStage[] = [
  'setup', 'self-review', 'manager-review', 'calibration', 'acknowledged', 'closed',
];

export const CYCLE_STAGE_LABELS: Record<CycleStage, string> = {
  setup: 'Setup',
  'self-review': 'Self-review',
  'manager-review': 'Manager review',
  calibration: 'Calibration',
  acknowledged: 'Acknowledgment',
  closed: 'Closed',
};

export interface StageTransition {
  stage: CycleStage;
  at: string; // ISO datetime
  by?: string; // actor name
}

export interface KpiCycle {
  id: string;
  name: string;
  period: string; // e.g. '2026-H1'
  departmentIds: string[];
  stage: CycleStage;
  stageHistory: StageTransition[];
  /** Optional per-stage due dates (ISO dates). */
  dueDates?: Partial<Record<CycleStage, string>>;
  createdAt: string;
  createdBy?: string;
}

export const useKpiCycles = () => useCollection<KpiCycle>(CYCLES_COLLECTION);

/** Aggregate progress stats for the reviews belonging to one cycle. */
export interface CycleStats {
  total: number;
  selfDone: number;
  managerDone: number;
  submitted: number;
  acknowledged: number;
}

export interface StageGuard {
  ok: boolean;
  reason?: string;
}

/**
 * Guard for a stage transition. Only forward, single-step transitions are
 * allowed (plus an explicit "reopen" backward step to the immediately previous
 * stage, used for rework). Guards are data-driven so the UI can show WHY a
 * transition is blocked.
 */
export function canAdvanceStage(cycle: KpiCycle, stats: CycleStats): StageGuard {
  switch (cycle.stage) {
    case 'setup':
      return stats.total > 0
        ? { ok: true }
        : { ok: false, reason: 'No reviews in this cycle yet.' };
    case 'self-review':
      return stats.selfDone >= stats.total && stats.total > 0
        ? { ok: true }
        : { ok: false, reason: `${stats.total - stats.selfDone} self-review(s) still pending.` };
    case 'manager-review':
      return stats.managerDone >= stats.total && stats.total > 0
        ? { ok: true }
        : { ok: false, reason: `${stats.total - stats.managerDone} manager review(s) still pending.` };
    case 'calibration':
      return stats.submitted + stats.acknowledged >= stats.total && stats.total > 0
        ? { ok: true }
        : { ok: false, reason: 'All reviews must be submitted before acknowledgment opens.' };
    case 'acknowledged':
      return stats.acknowledged >= stats.total && stats.total > 0
        ? { ok: true }
        : { ok: false, reason: `${stats.total - stats.acknowledged} review(s) not yet acknowledged.` };
    case 'closed':
      return { ok: false, reason: 'Cycle is closed.' };
  }
}

/** Next stage in the machine, or null when closed. */
export function nextStage(stage: CycleStage): CycleStage | null {
  const i = CYCLE_STAGES.indexOf(stage);
  return i >= 0 && i < CYCLE_STAGES.length - 1 ? CYCLE_STAGES[i + 1] : null;
}

/** True when the cycle stage forbids any further scoring edits. */
export function cycleLocksScoring(cycle: KpiCycle | undefined): boolean {
  return cycle?.stage === 'closed';
}

// ── OKR mode ─────────────────────────────────────────────────────────────────

export interface KeyResult {
  id: string;
  title: string;
  /** Numeric target and current actual (unit below). */
  target: number;
  current: number;
  unit?: string;
}

export type ObjectiveStatus = 'active' | 'completed' | 'cancelled';

export interface Objective {
  id: string;
  employeeId: string;
  /** Denormalized for cascade tree grouping (kept in sync on write). */
  departmentId?: string;
  period: string;
  title: string;
  description?: string;
  /** Parent objective id for goal cascading (company/dept → individual). */
  parentId?: string;
  keyResults: KeyResult[];
  status: ObjectiveStatus;
  createdAt: string;
}

export const useObjectives = () => useCollection<Objective>(OBJECTIVES_COLLECTION);

/** Progress % of a single key result (capped 0–100; 0 when target <= 0). */
export function krProgress(kr: Pick<KeyResult, 'target' | 'current'>): number {
  if (kr.target <= 0) return kr.current > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((kr.current / kr.target) * 100)));
}

/** Objective progress = mean of its key-result progress (0 when no KRs). */
export function objectiveProgress(o: Pick<Objective, 'keyResults'>): number {
  if (o.keyResults.length === 0) return 0;
  const sum = o.keyResults.reduce((s, kr) => s + krProgress(kr), 0);
  return Math.round(sum / o.keyResults.length);
}

/** Direct children of an objective (goal cascading). */
export function childObjectives(all: Objective[], parentId: string): Objective[] {
  return all.filter((o) => o.parentId === parentId);
}

// ── Check-ins (1:1 notes per review) ─────────────────────────────────────────

export interface CheckIn {
  id: string;
  reviewId: string;
  employeeId: string; // review subject (for scoping/filtering)
  authorId?: string;
  authorName: string;
  authorRole: 'employee' | 'manager';
  note: string;
  createdAt: string; // ISO datetime
}

export const useCheckins = () => useCollection<CheckIn>(CHECKINS_COLLECTION);

export function checkinsForReview(all: CheckIn[], reviewId: string): CheckIn[] {
  return all
    .filter((c) => c.reviewId === reviewId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── PIP (performance improvement plan) ───────────────────────────────────────

export type PipGoalStatus = 'open' | 'done' | 'missed';

export interface PipGoal {
  id: string;
  title: string;
  dueDate: string; // ISO date
  status: PipGoalStatus;
  note?: string;
}

export interface PipNote {
  id: string;
  date: string; // ISO datetime
  authorName: string;
  note: string;
}

export type PipStatus = 'active' | 'completed' | 'cancelled';

export interface Pip {
  id: string;
  employeeId: string;
  /** Review that triggered the PIP (Poor band), when applicable. */
  reviewId?: string;
  period: string;
  startDate: string; // ISO date
  endDate: string; // ISO date
  goals: PipGoal[];
  notes: PipNote[]; // dated check-in notes
  status: PipStatus;
  createdAt: string;
}

export const usePips = () => useCollection<Pip>(PIPS_COLLECTION);

export function activePipFor(all: Pip[], employeeId: string): Pip | undefined {
  return all.find((p) => p.employeeId === employeeId && p.status === 'active');
}

// ── Reviewer routing ─────────────────────────────────────────────────────────

const LEVEL_RANK: Record<PositionLevel, number> = {
  exec: 5, manager: 4, lead: 3, senior: 2, junior: 1,
};

export interface ReviewerContext {
  employees: Employee[];
  departments: Department[];
  positions: Position[];
}

/**
 * Resolve the reviewer for an employee. Order:
 *   1. Department.headId (when set, exists and isn't the employee)
 *   2. Department-seniority pick: highest position level in the employee's
 *      department (tie-break: earliest join date) — the "dept head by rank"
 *   3. HR department head / any HR-role employee
 *   4. Any admin-role employee
 *   5. undefined — NEVER the employee themselves (self-review is invalid)
 */
export function resolveReviewer(emp: Employee, ctx: ReviewerContext): string | undefined {
  const { employees, departments, positions } = ctx;
  const alive = (id?: string) =>
    !!id && id !== emp.id && employees.some((e) => e.id === id && e.status !== 'resigned');

  const dept = departments.find((d) => d.id === emp.departmentId);
  if (alive(dept?.headId)) return dept!.headId;

  const rankOf = (e: Employee): number =>
    LEVEL_RANK[positions.find((p) => p.id === e.positionId)?.level ?? 'junior'];
  const senior = employees
    .filter((e) => e.departmentId === emp.departmentId && e.id !== emp.id && e.status !== 'resigned')
    .sort((a, b) => rankOf(b) - rankOf(a) || a.joinDate.localeCompare(b.joinDate))[0];
  if (senior) return senior.id;

  const hrDept = departments.find((d) => d.code === 'HR' || /human resources/i.test(d.name));
  if (alive(hrDept?.headId)) return hrDept!.headId;

  const hr = employees.find((e) => e.role === 'hr' && e.id !== emp.id && e.status !== 'resigned');
  if (hr) return hr.id;

  const admin = employees.find((e) => e.role === 'admin' && e.id !== emp.id && e.status !== 'resigned');
  return admin?.id;
}

// ── Unified weight validation ────────────────────────────────────────────────

export interface WeightCheck {
  total: number;
  ok: boolean; // total === 100
}

/**
 * THE per-employee weight validator. Every KPI write path (library CRUD,
 * template-pack assign, cycle materialization) must land an employee's
 * non-archived KPIs for a period at exactly 100%.
 */
export function checkWeightTotal(kpis: Pick<KPI, 'weight' | 'status'>[]): WeightCheck {
  const total = kpis
    .filter((k) => k.status !== 'archived')
    .reduce((s, k) => s + k.weight, 0);
  return { total, ok: total === 100 };
}

/**
 * Scale a weight list to total exactly 100 (largest-remainder rounding so the
 * integers always sum to 100). Used as the "auto-balance" option.
 */
export function renormalizeWeights(weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || weights.length === 0) return weights;
  const raw = weights.map((w) => (w / total) * 100);
  const floored = raw.map((x) => Math.floor(x));
  let drift = 100 - floored.reduce((s, x) => s + x, 0);
  const byRemainder = raw
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => b.rem - a.rem);
  for (const { i } of byRemainder) {
    if (drift <= 0) break;
    floored[i] += 1;
    drift -= 1;
  }
  return floored;
}

// ── Role-gating predicates (fail OPEN when auth is null pre-integration) ─────

type Auth = AuthContextValue | null;

const isAdminOrHR = (auth: Auth): boolean => auth?.role === 'Admin' || auth?.role === 'HR';

/** Admin/HR oversee the whole module; managers their scope; employees self. */
export function canManageKpiModule(auth: Auth): boolean {
  if (!auth) return true; // pre-integration demo behaviour
  return isAdminOrHR(auth);
}

/** Can the current user create/edit cycles and advance stages? */
export function canManageCycles(auth: Auth): boolean {
  if (!auth) return true;
  return isAdminOrHR(auth);
}

/** Can the current user enter SELF scores for this review? Own review only. */
export function canSelfScore(auth: Auth, review: Pick<KPIReview, 'employeeId' | 'status'>): boolean {
  if (review.status !== 'draft') return false;
  if (!auth) return true;
  if (isAdminOrHR(auth)) return false; // HR oversees; the employee self-scores
  return auth.employeeId === review.employeeId;
}

/**
 * Can the current user enter MANAGER scores / potential / submit?
 * Only the assigned reviewer (or Admin/HR overseeing), and only while draft.
 */
export function canManagerScore(
  auth: Auth,
  review: Pick<KPIReview, 'reviewerId' | 'status'>,
): boolean {
  if (review.status !== 'draft') return false;
  if (!auth) return true;
  if (isAdminOrHR(auth)) return true;
  return auth.employeeId === review.reviewerId;
}

/**
 * Acknowledgment is the employee's sign-off on a submitted review.
 * Admin/HR may record it on the employee's behalf. Acknowledged = locked.
 */
export function canAcknowledge(
  auth: Auth,
  review: Pick<KPIReview, 'employeeId' | 'status'>,
): boolean {
  if (review.status !== 'submitted') return false;
  if (!auth) return true;
  if (isAdminOrHR(auth)) return true;
  return auth.employeeId === review.employeeId;
}

/** Can the current user open/view a review's detail? */
export function canViewReview(
  auth: Auth,
  review: Pick<KPIReview, 'employeeId' | 'reviewerId'>,
): boolean {
  if (!auth) return true;
  if (isAdminOrHR(auth)) return true;
  return auth.employeeId === review.employeeId || auth.employeeId === review.reviewerId
    || auth.canViewEmployee(review.employeeId);
}

/** Can the current user start / manage a PIP for an employee? */
export function canManagePip(auth: Auth, employeeId: string): boolean {
  if (!auth) return true;
  if (isAdminOrHR(auth)) return true;
  return auth.canViewEmployee(employeeId); // manager of that department
}

// ── Pending-action computation (hub notification badges) ─────────────────────

export interface PendingActions {
  /** Reviews awaiting MY self-score (employee) — or the team's, for HR. */
  selfPending: number;
  /** Reviews awaiting manager scoring where I am the reviewer (all, for HR). */
  managerPending: number;
  /** Submitted reviews awaiting MY acknowledgment. */
  ackPending: number;
  /** Active PIPs in my scope. */
  activePips: number;
}

export function computePendingActions(
  auth: Auth,
  reviews: (KPIReview & { selfScores?: { kpiId: string; score: number }[] })[],
  kpiCount: (r: KPIReview) => number,
  pips: Pip[],
): PendingActions {
  const selfDone = (r: KPIReview & { selfScores?: unknown[] }) =>
    kpiCount(r) > 0 && (r.selfScores?.length ?? 0) >= kpiCount(r);
  const mgrDone = (r: KPIReview) =>
    kpiCount(r) > 0 && r.scores.length >= kpiCount(r) && r.scores.every((s) => s.score > 0);

  const drafts = reviews.filter((r) => r.status === 'draft');
  const submitted = reviews.filter((r) => r.status === 'submitted');

  if (!auth || isAdminOrHR(auth)) {
    // Global view (demo mode or HR/Admin oversight).
    return {
      selfPending: drafts.filter((r) => !selfDone(r)).length,
      managerPending: drafts.filter((r) => selfDone(r) && !mgrDone(r)).length,
      ackPending: submitted.length,
      activePips: pips.filter((p) => p.status === 'active').length,
    };
  }
  const me = auth.employeeId;
  return {
    selfPending: drafts.filter((r) => r.employeeId === me && !selfDone(r)).length,
    managerPending: drafts.filter((r) => r.reviewerId === me && !mgrDone(r)).length,
    ackPending: submitted.filter((r) => r.employeeId === me).length,
    activePips: pips.filter((p) => p.status === 'active' && (p.employeeId === me || auth.canViewEmployee(p.employeeId))).length,
  };
}
