/**
 * M7 KPI module — shared helpers, template packs, rating bands.
 *
 * Contract notes (docs/architecture.md):
 * - KPI / KPIReview base types come from '@/lib/types'; collections 'kpis' and
 *   'reviews'. The base types have no category / department-applicability /
 *   self-score / potential fields, so this module extends them with OPTIONAL
 *   fields (KpiExt / ReviewExt). The localStorage layer is schemaless JSON, so
 *   extra fields are ignored by every other module reading the base types.
 * - KPIReview.scores[].score stays on the contract's 0–100 scale; the UI scores
 *   1–5 and stores managerScore × 20. Self-scores (1–5) live in the optional
 *   `selfScores` extension field. `potential` (1–5) feeds the 9-box grid.
 */
import type { KPI, KPIReview } from '@/lib/types';

// ── Module-local type extensions ─────────────────────────────────────────────

export type KpiCategory = 'Financial' | 'Customer' | 'Process' | 'People';
export const KPI_CATEGORIES: KpiCategory[] = ['Financial', 'Customer', 'Process', 'People'];

export interface KpiExt extends KPI {
  category?: KpiCategory;
  /** Department the KPI applies to; undefined/'' = company-wide. */
  departmentId?: string;
  /** Set when created from a template pack item. */
  templateKey?: string;
}

export interface ReviewExt extends KPIReview {
  cycleName?: string;
  /** First-class cycle entity id (Wave 2). Legacy reviews have none and are
   *  grouped by period only. */
  cycleId?: string;
  /** Self-review scores, 1–5 per KPI (manager scores live in `scores`, 0–100).
   *  `comment` = per-KPI self evidence / notes. */
  selfScores?: { kpiId: string; score: number; comment?: string }[];
  /** Manager potential rating 1–5 — y-axis of the 9-box grid. */
  potential?: number;
  /** Self-review narrative (employee's overall comment). */
  selfComments?: string;
  /** ISO datetime of the employee acknowledgment (set on acknowledge). */
  acknowledgedAt?: string;
}

// ── Scoring scale ────────────────────────────────────────────────────────────

export const score5to100 = (s5: number): number => Math.round(s5 * 20);
export const score100to5 = (s100: number): number => s100 / 20;

/** Weighted overall (0–100) from 0–100 scores and KPI weights.
 *  Rounded to 1 decimal — rounding to an integer BEFORE banding can flip a
 *  boundary rating (89.6 → 90 → Outstanding instead of Exceeds). */
export function weightedOverall(
  scores: { kpiId: string; score: number }[],
  kpis: Pick<KPI, 'id' | 'weight'>[],
): number {
  if (scores.length === 0) return 0;
  const totalWeight = kpis.reduce((s, k) => s + k.weight, 0);
  if (totalWeight <= 0) {
    return Math.round((scores.reduce((s, sc) => s + sc.score, 0) / scores.length) * 10) / 10;
  }
  const sum = scores.reduce((s, sc) => {
    const k = kpis.find((kk) => kk.id === sc.kpiId);
    return s + (sc.score * (k?.weight ?? 0)) / totalWeight;
  }, 0);
  return Math.round(sum * 10) / 10;
}

export const weightTotal = (kpis: Pick<KPI, 'weight'>[]): number =>
  kpis.reduce((s, k) => s + k.weight, 0);

// ── Rating bands ─────────────────────────────────────────────────────────────

export interface BandInfo {
  label: string;
  /** Minimum 1–5 score (inclusive) for this band. */
  min5: number;
  badge: string; // tailwind classes
  dot: string;
  increment: [number, number]; // suggested increment % range
}

export const BANDS: BandInfo[] = [
  { label: 'Outstanding', min5: 4.5, badge: 'bg-emerald-100 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500', increment: [8, 12] },
  { label: 'Exceeds Expectations', min5: 3.5, badge: 'bg-lime-100 text-lime-800 border-lime-200', dot: 'bg-lime-500', increment: [5, 8] },
  { label: 'Meets Expectations', min5: 2.5, badge: 'bg-amber-100 text-amber-800 border-amber-200', dot: 'bg-amber-500', increment: [3, 5] },
  { label: 'Below Expectations', min5: 1.5, badge: 'bg-orange-100 text-orange-800 border-orange-200', dot: 'bg-orange-500', increment: [0, 2] },
  { label: 'Poor', min5: 0, badge: 'bg-red-100 text-red-800 border-red-200', dot: 'bg-red-500', increment: [0, 0] },
];

/** Band for a 0–100 weighted score (band thresholds are on the 1–5 scale). */
export function bandFor100(score100: number): BandInfo {
  const s5 = score100to5(score100);
  return BANDS.find((b) => s5 >= b.min5) ?? BANDS[BANDS.length - 1];
}

/** Forced-distribution guide (calibration target mix). */
export const FORCED_DISTRIBUTION: { band: string; pct: number; dot: string }[] = [
  { band: 'Outstanding', pct: 10, dot: 'bg-emerald-500' },
  { band: 'Exceeds Expectations', pct: 20, dot: 'bg-lime-500' },
  { band: 'Meets Expectations', pct: 40, dot: 'bg-amber-500' },
  { band: 'Below Expectations', pct: 20, dot: 'bg-orange-500' },
  { band: 'Poor', pct: 10, dot: 'bg-red-500' },
];

/** Manager-bias flag threshold on the 1–5 scale. */
export const BIAS_THRESHOLD_5 = 0.5;

// ── Category styling ─────────────────────────────────────────────────────────

export function categoryBadge(c?: KpiCategory): string {
  switch (c) {
    case 'Financial':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'Customer':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'People':
      return 'bg-lime-100 text-lime-800 border-lime-200';
    case 'Process':
    default:
      return 'bg-stone-200 text-stone-700 border-stone-300';
  }
}

// ── Template packs ───────────────────────────────────────────────────────────

export interface KpiTemplateItem {
  title: string;
  description: string;
  unit: string;
  target: string;
  weight: number;
  category: KpiCategory;
}

export interface TemplatePack {
  key: string;
  label: string;
  blurb: string;
  /** Departments this pack is designed for (seed dept ids). */
  forDepartments: string[];
  items: KpiTemplateItem[];
}

export const TEMPLATE_PACKS: TemplatePack[] = [
  {
    key: 'sales',
    label: 'Sales & Marketing',
    blurb: 'Revenue, pipeline growth and collections discipline for commercial roles.',
    forDepartments: ['dept-snm'],
    items: [
      { title: 'Revenue vs target', description: 'Closed revenue against quarterly quota.', unit: 'RM', target: '100% of quota', weight: 40, category: 'Financial' },
      { title: 'New accounts opened', description: 'New paying customers signed in the period.', unit: 'accounts', target: '≥ 8 / quarter', weight: 30, category: 'Customer' },
      { title: 'Collection / AR days', description: 'Average debtor days for owned accounts.', unit: 'days', target: '≤ 45 days', weight: 30, category: 'Financial' },
    ],
  },
  {
    key: 'service',
    label: 'Service & Operations',
    blurb: 'Throughput, responsiveness and service quality for field / ops staff.',
    forDepartments: ['dept-ops'],
    items: [
      { title: 'Jobs completed', description: 'Completed service jobs / work orders.', unit: 'jobs', target: '≥ 95% of plan', weight: 40, category: 'Process' },
      { title: 'Response time', description: 'Average time to respond to a job ticket.', unit: 'hours', target: '≤ 4 hours', weight: 30, category: 'Process' },
      { title: 'Customer satisfaction (CSAT)', description: 'Post-job customer rating.', unit: '%', target: '≥ 90%', weight: 30, category: 'Customer' },
    ],
  },
  {
    key: 'hr',
    label: 'Human Resources',
    blurb: 'Hiring speed, retention and employee sentiment for HR roles.',
    forDepartments: ['dept-hr'],
    items: [
      { title: 'Time-to-hire', description: 'Average days from approval to accepted offer.', unit: 'days', target: '≤ 35 days', weight: 40, category: 'Process' },
      { title: 'Attrition rate', description: 'Voluntary attrition, annualised.', unit: '%', target: '≤ 12%', weight: 30, category: 'People' },
      { title: 'eNPS pulse', description: 'Employee net promoter score from pulse surveys.', unit: 'score', target: '≥ +20', weight: 30, category: 'People' },
    ],
  },
  {
    key: 'engineering',
    label: 'Engineering & Product',
    blurb: 'Delivery, quality and knowledge-sharing for technical roles.',
    forDepartments: ['dept-eng'],
    items: [
      { title: 'Milestone delivery', description: 'Committed milestones shipped on time.', unit: '%', target: '≥ 90% on time', weight: 40, category: 'Process' },
      { title: 'Defect rate', description: 'Sev-1/Sev-2 defects per release.', unit: 'defects', target: '0 sev-1', weight: 30, category: 'Process' },
      { title: 'Mentoring & docs', description: 'Pairing sessions / runbooks contributed.', unit: 'sessions', target: '≥ 4 / month', weight: 30, category: 'People' },
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    blurb: 'Close speed, working capital and forecast reliability.',
    forDepartments: ['dept-fin'],
    items: [
      { title: 'Month-end close', description: 'Working days to complete close.', unit: 'days', target: 'By WD+3', weight: 40, category: 'Process' },
      { title: 'AR days', description: 'Average receivable days.', unit: 'days', target: '≤ 45 days', weight: 30, category: 'Financial' },
      { title: 'Forecast accuracy', description: 'Actual vs forecast variance.', unit: '%', target: '± 5%', weight: 30, category: 'Financial' },
    ],
  },
  {
    key: 'support',
    label: 'Customer Support',
    blurb: 'Satisfaction, responsiveness and resolution for support teams.',
    forDepartments: ['dept-cs'],
    items: [
      { title: 'CSAT score', description: 'Customer satisfaction after ticket closure.', unit: '%', target: '≥ 92%', weight: 40, category: 'Customer' },
      { title: 'First-response time', description: 'Average first reply to a new ticket.', unit: 'hours', target: '≤ 2 hours', weight: 30, category: 'Process' },
      { title: 'Resolution rate', description: 'Tickets resolved within SLA.', unit: '%', target: '≥ 95%', weight: 30, category: 'Customer' },
    ],
  },
  {
    key: 'general',
    label: 'General / All Roles',
    blurb: 'Balanced mix for departments without a dedicated pack.',
    forDepartments: [],
    items: [
      { title: 'Delivery vs plan', description: 'Committed work delivered on time.', unit: '%', target: '≥ 90% on time', weight: 40, category: 'Process' },
      { title: 'Quality of work', description: 'Rework / error rate on deliverables.', unit: '%', target: '≤ 5% rework', weight: 30, category: 'Process' },
      { title: 'Collaboration & growth', description: 'Cross-team support and skill development.', unit: 'rating', target: 'Positive peer feedback', weight: 30, category: 'People' },
    ],
  },
];

/** Default template pack for a department. Unknown departments get the
 *  generic all-roles pack (never silently a wrong department's pack). */
export function packForDepartment(departmentId: string): TemplatePack {
  return (
    TEMPLATE_PACKS.find((p) => p.forDepartments.includes(departmentId)) ??
    TEMPLATE_PACKS.find((p) => p.key === 'general') ??
    TEMPLATE_PACKS[0]
  );
}

// ── Cycle helpers ────────────────────────────────────────────────────────────

export interface CycleSummary {
  period: string;
  name: string;
  /** First-class cycle id when one exists for this period (Wave 2). */
  cycleId?: string;
  total: number;
  selfDone: number;
  managerDone: number;
  acknowledged: number;
  avg100: number;
}

/** Map key for per-employee, per-period KPI counts (B8 fix: the count must be
 *  scoped to the review's period, not all periods). */
export const empPeriodKey = (empId: string, period: string): string => `${empId}|${period}`;

export function selfDoneOf(r: ReviewExt, kpiCount: number): boolean {
  return kpiCount > 0 && (r.selfScores?.length ?? 0) >= kpiCount;
}

export function managerDoneOf(r: ReviewExt, kpiCount: number): boolean {
  return kpiCount > 0 && r.scores.length >= kpiCount && r.scores.every((s) => s.score > 0);
}

/** Cycle-stage progress stats consumed by the stage machine guards. */
export function cycleStatsOf(reviews: ReviewExt[], kpiCount: (r: ReviewExt) => number) {
  return {
    total: reviews.length,
    selfDone: reviews.filter((r) => selfDoneOf(r, kpiCount(r))).length,
    managerDone: reviews.filter((r) => managerDoneOf(r, kpiCount(r))).length,
    submitted: reviews.filter((r) => r.status === 'submitted').length,
    acknowledged: reviews.filter((r) => r.status === 'acknowledged').length,
  };
}

export function summariseCycle(period: string, reviews: ReviewExt[], kpiCountByEmpPeriod: Map<string, number>): CycleSummary {
  const mine = reviews.filter((r) => r.period === period);
  // Draft-free average: only final (submitted/acknowledged) scored reviews.
  const scored = mine.filter((r) => r.status !== 'draft' && r.overallScore > 0);
  const count = (r: ReviewExt) => kpiCountByEmpPeriod.get(empPeriodKey(r.employeeId, r.period)) ?? 0;
  return {
    period,
    name: mine.find((r) => r.cycleName)?.cycleName ?? period,
    cycleId: mine.find((r) => r.cycleId)?.cycleId,
    total: mine.length,
    selfDone: mine.filter((r) => selfDoneOf(r, count(r))).length,
    managerDone: mine.filter((r) => managerDoneOf(r, count(r))).length,
    acknowledged: mine.filter((r) => r.status === 'acknowledged').length,
    avg100: scored.length ? Math.round(scored.reduce((s, r) => s + r.overallScore, 0) / scored.length) : 0,
  };
}
