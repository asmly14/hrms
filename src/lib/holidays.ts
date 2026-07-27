/**
 * Holiday query engine.
 *  - Curated local data (holidayData.ts) is the source of truth.
 *  - Admin overrides live in the 'holidays' db collection (isOverride: true).
 *  - `refreshHolidays()` optionally merges the community API
 *    (sabah-holiday.dydxsoft.my, CORS-open) over the local data with a 5s
 *    timeout; the app never hard-fails on third-party uptime.
 *  - Per-state weekend rules (Fri–Sat for JHR/KDH/KTN/TRG) drive
 *    replacement-holiday computation (EA 1955 s.60D proviso).
 */

import { getCollection, uid } from './db';
import { HOLIDAY_DATA, type HolidayDef } from './holidayData';
import type { Holiday, StateCode } from './types';

export interface StateInfo {
  code: StateCode;
  name: string;
  weekend: 'fri-sat' | 'sat-sun';
  /** API slug used by sabah-holiday.dydxsoft.my */
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
  return states.find((s) => s.code === code) ?? states[13]; // default KUL
}

const API_BASE = 'https://sabah-holiday.dydxsoft.my';
const CACHE_PREFIX = 'myhrms:holidayCache:';

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
 *  1. curated local data, 2. API-refreshed cache (if refreshHolidays ran),
 *  3. admin overrides from the 'holidays' collection.
 */
export function getHolidays(year: number, state?: StateCode): Holiday[] {
  const defs = (HOLIDAY_DATA[year] ?? []).map(defToHoliday);
  const cached = getCached(year);
  const overrides = getCollection<Holiday>('holidays').filter(
    (h) => h.date.startsWith(String(year)) && h.isOverride,
  );
  // Shadow set: only overrides that apply to the REQUESTED state may hide a
  // curated holiday — a JHR-scoped override must not shadow the curated entry
  // for KUL (QA B4).
  const overridden = new Set(
    overrides
      .filter((o) => !state || appliesTo(o, state))
      .map((o) => `${o.date}|${o.name.toLowerCase()}`),
  );
  const merged = [...defs, ...cached, ...overrides].filter(
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
 * public holiday) is substituted by the next working day. Returns the
 * replacement entry, or null when no substitution is needed.
 * Self-contained (no isHoliday/getNextWorkingDay calls) to avoid recursion;
 * `occupied` carries dates already taken by base holidays + earlier replacements.
 */
export function replacementHoliday(holiday: Holiday, state: StateCode, occupied?: Set<string>): Holiday | null {
  if (!appliesTo(holiday, state)) return null;
  const year = Number(holiday.date.slice(0, 4));
  const taken = occupied ?? new Set(getHolidays(year, state).map((h) => h.date));
  const d = parseDate(holiday.date);
  // PH on a weekly rest day (Fri/Sat for fri-sat states, Sat/Sun elsewhere)
  // or clashing with another PH on the same date → substituted. Source: EA s.60D proviso.
  const onRestDay = isWeekend(d, state);
  const clash = getHolidays(year, state).some(
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
export function getEffectiveHolidays(year: number, state: StateCode): Holiday[] {
  const base = getHolidays(year, state);
  const occupied = new Set(base.map((h) => h.date));
  const replacements: Holiday[] = [];
  // Sequential assignment: each replacement occupies its day before the next is computed
  // (e.g. 2026 FT Day + Thaipusam both on Sun 1 Feb → FT Day Mon 2, Thaipusam Tue 3 —
  //  compulsory EA holidays take the first available slot).
  const ordered = [...base].sort(
    (a, b) => a.date.localeCompare(b.date) || Number(b.isCompulsoryEA) - Number(a.isCompulsoryEA),
  );
  for (const h of ordered) {
    const r = replacementHoliday(h, state, occupied);
    if (r && !occupied.has(r.date)) {
      occupied.add(r.date);
      replacements.push(r);
    }
  }
  return [...base, ...replacements].sort((a, b) => a.date.localeCompare(b.date));
}

/** Holiday on a given date for a state (incl. replacement-day matches), else null. */
export function isHoliday(date: string | Date, state: StateCode): Holiday | null {
  const iso = toISO(parseDate(date));
  const year = Number(iso.slice(0, 4));
  return getEffectiveHolidays(year, state).find((h) => h.date === iso) ?? null;
}

/** Fri–Sat weekend for JHR/KDH/KTN/TRG; Sat–Sun elsewhere (research §1.1). */
export function isWeekend(date: string | Date, state: StateCode): boolean {
  const day = parseDate(date).getDay();
  return stateInfo(state).weekend === 'fri-sat' ? day === 5 || day === 6 : day === 0 || day === 6;
}

/** Next date that is neither a weekend day nor a holiday for the state. */
export function getNextWorkingDay(date: string | Date, state: StateCode): Date {
  const d = new Date(parseDate(date).getTime());
  do {
    d.setDate(d.getDate() + 1);
  } while (isWeekend(d, state) || isHoliday(d, state));
  return d;
}

// ── Optional live refresh ────────────────────────────────────────────────────

interface ApiHolidayRow {
  date: string; // 'Jan 01'
  day_of_week: string;
  holiday_name: string;
  is_mandatory: boolean;
}

function getCached(year: number): Holiday[] {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${year}`);
    return raw ? (JSON.parse(raw) as Holiday[]) : [];
  } catch {
    return [];
  }
}

export interface RefreshResult {
  updated: number;
  source: 'api' | 'local';
  error?: string;
}

/**
 * Fetches the community API for the given year (all 16 jurisdictions) and
 * merges over local data with a 5s timeout. API rows are matched by date;
 * entries already present locally are skipped (local data wins). Result is
 * cached in localStorage so subsequent getHolidays() calls use it.
 */
export async function refreshHolidays(year: number, state?: StateCode): Promise<RefreshResult> {
  const targets = state ? [stateInfo(state)] : states;
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  try {
    const fetched: Holiday[] = [];
    for (const st of targets) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${API_BASE}/api/${st.slug}/${year}.json`, { signal: ctrl.signal });
        if (!res.ok) continue;
        const rows = (await res.json()) as ApiHolidayRow[];
        for (const row of rows) {
          const m = monthNames.findIndex((mn) => row.date.toLowerCase().startsWith(mn));
          if (m < 0) continue;
          const iso = `${year}-${String(m + 1).padStart(2, '0')}-${row.date.slice(4).trim().padStart(2, '0')}`;
          fetched.push({
            id: uid(),
            date: iso,
            name: row.holiday_name.replace(/ \(in lieu\)$/i, ''),
            states: [st.code],
            isCompulsoryEA: row.is_mandatory,
            tentative: false,
            source: `${API_BASE}/api/${st.slug}/${year}.json`,
          });
        }
      } finally {
        clearTimeout(timer);
      }
    }
    if (fetched.length === 0) return { updated: 0, source: 'local', error: 'API returned no data' };
    // Merge: keep curated entries, add API entries that fill gaps for a state+date.
    const local = getHolidays(year);
    const fresh = fetched.filter(
      (f) => !local.some((l) => l.date === f.date && appliesTo(l, (f.states as StateCode[])[0])),
    );
    const prior = getCached(year).filter((h) => !targets.some((t) => t.code === (h.states as StateCode[])[0]));
    localStorage.setItem(`${CACHE_PREFIX}${year}`, JSON.stringify([...prior, ...fetched]));
    return { updated: fresh.length, source: 'api' };
  } catch (err) {
    return { updated: 0, source: 'local', error: err instanceof Error ? err.message : 'fetch failed' };
  }
}
