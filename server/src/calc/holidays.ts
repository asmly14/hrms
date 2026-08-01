/**
 * Holiday query engine — SERVER PORT.
 *
 * ⚠️ SYNC NOTE: dependency-free port of hrms-web/src/lib/holidays.ts.
 * Differences by design:
 *  - Admin overrides are PASSED IN (`overrides` param — the caller loads them
 *    from the `holidays` table) instead of read from lib/db.
 *  - The optional community-API refresh layer (localStorage cache) is omitted;
 *    the curated calendar (./holidayData.ts, sync-verified copy) + DB
 *    overrides are the server's sources of truth.
 * Re-port manually when the web holidays.ts changes.
 */

import { HOLIDAY_DATA, type HolidayDef } from './holidayData';
import { uid } from './utils';
import type { Holiday, StateCode } from './types';

export interface StateInfo {
  code: StateCode;
  name: string;
  weekend: 'fri-sat' | 'sat-sun';
  slug: string;
}

export const states: StateInfo[] = [
  { code: 'JHR', name: 'Johor', weekend: 'fri-sat', slug: 'johor' },
  { code: 'KDH', name: 'Kedah', weekend: 'fri-sat', slug: 'kedah' },
  { code: 'KTN', name: 'Kelantan', weekend: 'fri-sat', slug: 'kelantan' },
  { code: 'MLK', name: 'Melaka', weekend: 'sat-sun', slug: 'melaka' },
  { code: 'NSB', name: 'Negeri Sembilan', weekend: 'sat-sun', slug: 'negeri-sembilan' },
  { code: 'PHG', name: 'Pahang', weekend: 'sat-sun', slug: 'pahang' },
  { code: 'PNG', name: 'Pulau Pinang', weekend: 'sat-sun', slug: 'penang' },
  { code: 'PRK', name: 'Perak', weekend: 'sat-sun', slug: 'perak' },
  { code: 'PLS', name: 'Perlis', weekend: 'sat-sun', slug: 'perlis' },
  { code: 'SBH', name: 'Sabah', weekend: 'sat-sun', slug: 'sabah' },
  { code: 'SWK', name: 'Sarawak', weekend: 'sat-sun', slug: 'sarawak' },
  { code: 'SGR', name: 'Selangor', weekend: 'sat-sun', slug: 'selangor' },
  { code: 'TRG', name: 'Terengganu', weekend: 'fri-sat', slug: 'terengganu' },
  { code: 'KUL', name: 'W.P. Kuala Lumpur', weekend: 'sat-sun', slug: 'kuala-lumpur' },
  { code: 'LBN', name: 'W.P. Labuan', weekend: 'sat-sun', slug: 'labuan' },
  { code: 'PJY', name: 'W.P. Putrajaya', weekend: 'sat-sun', slug: 'putrajaya' },
];

export function stateInfo(code: StateCode): StateInfo {
  return states.find((s) => s.code === code) ?? states[13]!; // default KUL
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(date: string | Date): Date {
  if (date instanceof Date) return date;
  return new Date(date.length === 10 ? `${date}T00:00:00` : date);
}

function defToHoliday(def: HolidayDef): Holiday {
  return {
    id: uid(),
    date: def.date,
    name: def.name,
    nameMs: def.nameMs,
    states: def.states,
    except: def.except,
    isCompulsoryEA: def.isCompulsoryEA ?? false,
    tentative: def.tentative ?? false,
    source: 'curated',
  };
}

function appliesTo(h: Pick<Holiday, 'states' | 'except'>, state: StateCode): boolean {
  if (h.states === 'ALL') return !(h.except ?? []).includes(state);
  return h.states.includes(state);
}

/**
 * Holidays for a year (+ state filter). Layers:
 *  1. curated local data, 2. admin overrides (passed in — isOverride rows of
 *     the holidays table). The web's third layer (community-API cache) does
 *     not exist server-side.
 */
export function getHolidays(year: number, state?: StateCode, overrides: Holiday[] = []): Holiday[] {
  const defs = (HOLIDAY_DATA[year] ?? []).map(defToHoliday);
  const yearOverrides = overrides.filter(
    (h) => h.date.startsWith(String(year)) && h.isOverride,
  );
  // Shadow set: only overrides that apply to the REQUESTED state may hide a
  // curated holiday (QA B4).
  const overridden = new Set(
    yearOverrides
      .filter((o) => !state || appliesTo(o, state))
      .map((o) => `${o.date}|${o.name.toLowerCase()}`),
  );
  const merged = [...defs, ...yearOverrides].filter(
    (h) => h.isOverride || !overridden.has(`${h.date}|${h.name.toLowerCase()}`),
  );
  const seen = new Set<string>();
  return merged
    .filter((h) => {
      const key = `${h.date}|${h.name.toLowerCase()}|${JSON.stringify(h.states)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((h) => (state ? appliesTo(h, state) : true))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * EA 1955 s.60D proviso: a public holiday falling on a rest day (or another
 * public holiday) is substituted by the next working day.
 */
export function replacementHoliday(
  holiday: Holiday,
  state: StateCode,
  occupied?: Set<string>,
  overrides: Holiday[] = [],
): Holiday | null {
  if (!appliesTo(holiday, state)) return null;
  const year = Number(holiday.date.slice(0, 4));
  const taken = occupied ?? new Set(getHolidays(year, state, overrides).map((h) => h.date));
  const d = parseDate(holiday.date);
  const onRestDay = isWeekend(d, state);
  const clash = getHolidays(year, state, overrides).some(
    (h) => h.name !== holiday.name && h.date === holiday.date,
  );
  if (!onRestDay && !clash) return null;
  const next = new Date(d.getTime());
  do {
    next.setDate(next.getDate() + 1);
  } while (isWeekend(next, state) || taken.has(toISO(next)));
  return {
    ...holiday,
    id: uid(),
    date: toISO(next),
    name: `${holiday.name} (in lieu)`,
    replacesDate: holiday.date,
    source: 'replacement',
  };
}

/** Effective calendar for a state: base holidays + replacement days appended. */
export function getEffectiveHolidays(year: number, state: StateCode, overrides: Holiday[] = []): Holiday[] {
  const base = getHolidays(year, state, overrides);
  const occupied = new Set(base.map((h) => h.date));
  const replacements: Holiday[] = [];
  // Sequential assignment: each replacement occupies its day before the next
  // is computed (compulsory EA holidays take the first available slot).
  const ordered = [...base].sort(
    (a, b) => a.date.localeCompare(b.date) || Number(b.isCompulsoryEA) - Number(a.isCompulsoryEA),
  );
  for (const h of ordered) {
    const r = replacementHoliday(h, state, occupied, overrides);
    if (r && !occupied.has(r.date)) {
      occupied.add(r.date);
      replacements.push(r);
    }
  }
  return [...base, ...replacements].sort((a, b) => a.date.localeCompare(b.date));
}

/** Holiday on a given date for a state (incl. replacement-day matches), else null. */
export function isHoliday(date: string | Date, state: StateCode, overrides: Holiday[] = []): Holiday | null {
  const iso = toISO(parseDate(date));
  const year = Number(iso.slice(0, 4));
  return getEffectiveHolidays(year, state, overrides).find((h) => h.date === iso) ?? null;
}

/** Fri–Sat weekend for JHR/KDH/KTN/TRG; Sat–Sun elsewhere. */
export function isWeekend(date: string | Date, state: StateCode): boolean {
  const day = parseDate(date).getDay();
  return stateInfo(state).weekend === 'fri-sat' ? day === 5 || day === 6 : day === 0 || day === 6;
}

/** Next date that is neither a weekend day nor a holiday for the state. */
export function getNextWorkingDay(date: string | Date, state: StateCode, overrides: Holiday[] = []): Date {
  const d = new Date(parseDate(date).getTime());
  do {
    d.setDate(d.getDate() + 1);
  } while (isWeekend(d, state) || isHoliday(d, state, overrides));
  return d;
}

/** Effective-holiday ISO-date set for a state across the given years. */
export function effectiveHolidayDates(
  years: Iterable<number>,
  state: StateCode,
  overrides: Holiday[] = [],
): Set<string> {
  const out = new Set<string>();
  for (const y of years) {
    for (const h of getEffectiveHolidays(y, state, overrides)) out.add(h.date);
  }
  return out;
}
