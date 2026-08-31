/**
 * Employer gazetted-holiday selection — EA 1955 s.60D.
 *
 * Employees are entitled to 11 gazetted PAID public holidays per calendar
 * year: 5 compulsory (National Day, Yang di-Pertuan Agong's Birthday, State
 * Ruler / FT Day, Labour Day, Malaysia Day — flagged `isCompulsoryEA` in
 * holidayData.ts) plus 6 CHOSEN BY THE EMPLOYER from the remaining gazetted
 * list. The chosen 6 must be displayed conspicuously before the year begins
 * (s.60D(1)); any of them may later be substituted by agreement (s.60D(1A)).
 *
 * Storage: ONE settings doc per tenant per year — id `ext:gazetted:<year>`,
 * `kind: 'gazettedSelection'` — in the tenant-scoped 'settings' collection
 * (same pattern as 'ext:payroll' / 'ext:leaveTopups'; selections are company
 * policy, NOT shared law, so they must not live in the global 'holidays'
 * collection). The doc keeps a working copy (`chosenDates`) and, once
 * published, an immutable snapshot (`publishedDates` + `publishedAt`) so the
 * "displayed notice" never drifts silently when HR edits the draft again.
 *
 * Scope note: this module only designates WHICH days are the statutory paid
 * PHs. Leave/attendance observance is unchanged — every holiday in
 * getEffectiveHolidays() is still a non-working day regardless of selection.
 */

import { getCollection, setCollection } from './db';
import { getHolidays, stateInfo } from './holidays';
import { isRestDay } from './appSettings';
import type { Holiday, StateCode } from './types';

export const COMPULSORY_COUNT = 5;
export const CHOSEN_COUNT = 6;
export const STATUTORY_TOTAL = COMPULSORY_COUNT + CHOSEN_COUNT; // 11

/** Per-company per-year selection record (settings-doc pattern per tenant). */
export interface GazettedSelection {
  year: number;
  state: StateCode;
  /** Working copy — the employer's chosen dates ('YYYY-MM-DD'), 6 expected. */
  chosenDates: string[];
  updatedAt: string; // ISO datetime of the last draft save / publish
  publishedAt?: string; // ISO datetime — set when the selection is published
  /** Immutable snapshot of chosenDates at publish time (the "displayed notice"). */
  publishedDates?: string[];
}

/** Raw row shape of the doc in the mixed 'settings' collection. */
interface GazettedDoc {
  id: string;
  kind?: string;
  year?: unknown;
  state?: unknown;
  chosenDates?: unknown;
  publishedDates?: unknown;
  updatedAt?: unknown;
  publishedAt?: unknown;
}

function docId(year: number): string {
  return `ext:gazetted:${year}`;
}

/** Keep well-formed ISO dates only, deduped and sorted. */
function normalizeDates(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const d of v) {
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d);
  }
  return [...out].sort();
}

function isStateCode(v: unknown): v is StateCode {
  return typeof v === 'string' && stateInfo(v as StateCode).code === v;
}

/** The tenant's selection record for a year, or null when none / malformed. */
export function getGazettedSelection(year: number): GazettedSelection | null {
  const doc = getCollection<GazettedDoc>('settings').find((r) => r.id === docId(year));
  if (!doc) return null;
  if (doc.year !== year || !isStateCode(doc.state) || !Array.isArray(doc.chosenDates)) return null;
  return {
    year,
    state: doc.state,
    chosenDates: normalizeDates(doc.chosenDates),
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '',
    publishedAt: typeof doc.publishedAt === 'string' && doc.publishedAt ? doc.publishedAt : undefined,
    publishedDates: Array.isArray(doc.publishedDates) ? normalizeDates(doc.publishedDates) : undefined,
  };
}

function writeSelection(sel: GazettedSelection): GazettedSelection {
  const rows = getCollection<GazettedDoc>('settings');
  const doc: GazettedDoc = {
    id: docId(sel.year),
    kind: 'gazettedSelection',
    year: sel.year,
    state: sel.state,
    chosenDates: normalizeDates(sel.chosenDates),
    publishedDates: sel.publishedDates ? normalizeDates(sel.publishedDates) : undefined,
    updatedAt: sel.updatedAt,
    publishedAt: sel.publishedAt,
  };
  setCollection('settings', [...rows.filter((r) => r.id !== doc.id), doc]);
  return sel;
}

/** Save the working copy without publishing (preserves any published snapshot). */
export function saveGazettedSelection(year: number, state: StateCode, chosenDates: string[]): GazettedSelection {
  const prior = getGazettedSelection(year);
  return writeSelection({
    year,
    state,
    chosenDates,
    updatedAt: new Date().toISOString(),
    publishedAt: prior?.publishedAt,
    publishedDates: prior?.publishedDates,
  });
}

/** Delete the year's selection record entirely (per-year reset). */
export function resetGazettedSelection(year: number): boolean {
  const rows = getCollection<GazettedDoc>('settings');
  const next = rows.filter((r) => r.id !== docId(year));
  if (next.length === rows.length) return false;
  setCollection('settings', next);
  return true;
}

// ── Pools ────────────────────────────────────────────────────────────────────

/** The 5 EA-compulsory holidays for a state/year (from curated data + overrides). */
export function compulsoryHolidays(year: number, state: StateCode): Holiday[] {
  return getHolidays(year, state).filter((h) => h.isCompulsoryEA);
}

/**
 * The employer-choosable pool: every NON-compulsory holiday applying to the
 * state/year — curated gazetted days plus admin-declared custom holidays
 * ('holidays' overrides, e.g. company off-days / cuti peristiwa). In-lieu
 * replacement entries are excluded (they are computed, not chosen).
 */
export function choosablePool(year: number, state: StateCode): Holiday[] {
  return getHolidays(year, state).filter((h) => !h.isCompulsoryEA);
}

// ── Validation + advice ──────────────────────────────────────────────────────

export interface SelectionValidation {
  /** True when there are no blocking issues (warnings are advisory only). */
  valid: boolean;
  /** Blocking problems (must be fixed before publishing). */
  issues: string[];
  /** Non-blocking compliance advice (rest-day substitution, >6 chosen, …). */
  warnings: string[];
}

/**
 * Validate an employer selection for a state/year.
 *  - at least 6 chosen from the non-compulsory pool (fewer = s.60D shortfall);
 *  - every chosen date must be an actual holiday in that state/year
 *    (curated or a declared custom holiday) — compulsory days are not choosable;
 *  - no duplicates.
 * Warnings (advisory): a chosen date on a rest day is auto-substituted by the
 * s.60D proviso; more than 6 chosen exceeds the statutory minimum.
 */
export function validateSelection(year: number, state: StateCode, chosenDates: string[]): SelectionValidation {
  const pool = choosablePool(year, state);
  const poolDates = new Set(pool.map((h) => h.date));
  const issues: string[] = [];
  const warnings: string[] = [];

  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const d of chosenDates) {
    if (seen.has(d)) dupes.add(d);
    seen.add(d);
  }
  if (dupes.size > 0) {
    issues.push(
      `Duplicate dates selected (${[...dupes].sort().join(', ')}) — each chosen holiday counts once toward the 6.`,
    );
  }

  const compulsoryDates = new Set(compulsoryHolidays(year, state).map((h) => h.date));
  const unknown = [...seen].filter((d) => !poolDates.has(d));
  for (const d of unknown.sort()) {
    issues.push(
      compulsoryDates.has(d)
        ? `${d} is one of the ${COMPULSORY_COUNT} EA-compulsory holidays — it already counts toward the ` +
            `${STATUTORY_TOTAL} and cannot be chosen again. Pick from the non-compulsory pool.`
        : `${d} is not a gazetted holiday in ${stateInfo(state).name} for ${year}. ` +
            'Choose from the holiday pool, or add it as a custom company holiday first.',
    );
  }

  const usable = [...seen].filter((d) => poolDates.has(d));
  if (usable.length < CHOSEN_COUNT) {
    issues.push(
      `Insufficient — only ${COMPULSORY_COUNT + usable.length} of the statutory ${STATUTORY_TOTAL} days selected. ` +
        `EA 1955 s.60D requires ${STATUTORY_TOTAL} gazetted paid holidays (${COMPULSORY_COUNT} compulsory + ${CHOSEN_COUNT} chosen).`,
    );
  } else if (usable.length > CHOSEN_COUNT) {
    warnings.push(
      `${usable.length - CHOSEN_COUNT} day(s) beyond the statutory ${CHOSEN_COUNT} chosen — allowed (more paid holidays ` +
        'than the EA minimum), but confirm this is intended before publishing.',
    );
  }

  for (const d of usable) {
    if (isRestDay(d, state)) {
      const name = pool.find((h) => h.date === d)?.name ?? d;
      warnings.push(
        `${name} (${d}) falls on a rest day — the s.60D proviso automatically substitutes the next working day, ` +
          'so consider choosing a different gazetted day instead.',
      );
    }
  }

  return { valid: issues.length === 0, issues, warnings };
}

// ── Effective / published gazetted days ─────────────────────────────────────

/** The dates the published snapshot designates (working copy when unpublished). */
function designatedDates(sel: GazettedSelection): string[] {
  return sel.publishedAt && sel.publishedDates ? sel.publishedDates : sel.chosenDates;
}

/**
 * The effective statutory gazetted days for a state/year — the 5 compulsory
 * holidays plus the employer's chosen dates from the stored selection
 * (published snapshot when published; working copy otherwise), sorted by
 * date. With no selection for the year (or one saved for a different state),
 * only the compulsory days are returned.
 */
export function effectiveGazettedDays(year: number, state: StateCode): Holiday[] {
  const base = getHolidays(year, state);
  const sel = getGazettedSelection(year);
  const chosen = new Set(sel && sel.state === state ? designatedDates(sel) : []);
  return base
    .filter((h) => h.isCompulsoryEA || chosen.has(h.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Date set of the PUBLISHED effective gazetted days (the statutory 11) for a
 * state/year — null when no published selection exists for that year/state.
 * Drives the 'Gazetted' badge on the calendar list.
 */
export function publishedGazettedDates(year: number, state: StateCode): Set<string> | null {
  const sel = getGazettedSelection(year);
  if (!sel?.publishedAt || sel.state !== state) return null;
  return new Set(effectiveGazettedDays(year, state).map((h) => h.date));
}

// ── Publish ──────────────────────────────────────────────────────────────────

export type PublishResult =
  | { ok: true; selection: GazettedSelection }
  | { ok: false; issues: string[] };

/**
 * Publish the selection — the compliance act: validates, then stamps
 * `publishedAt` and freezes `publishedDates` as the notice to display
 * conspicuously before the year starts (s.60D(1)). Refuses to publish an
 * invalid selection (issues returned unchanged).
 */
export function publishGazettedSelection(year: number, state: StateCode, chosenDates: string[]): PublishResult {
  const v = validateSelection(year, state, chosenDates);
  if (!v.valid) return { ok: false, issues: v.issues };
  const now = new Date().toISOString();
  const dates = normalizeDates(chosenDates);
  const selection = writeSelection({
    year,
    state,
    chosenDates: dates,
    publishedDates: dates,
    updatedAt: now,
    publishedAt: now,
  });
  return { ok: true, selection };
}
