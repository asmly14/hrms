import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { setActiveTenantId } from '../db';
import { isWeekend } from '../holidays';
import {
  choosablePool,
  compulsoryHolidays,
  effectiveGazettedDays,
  getGazettedSelection,
  publishedGazettedDates,
  publishGazettedSelection,
  resetGazettedSelection,
  saveGazettedSelection,
  validateSelection,
  CHOSEN_COUNT,
  COMPULSORY_COUNT,
  STATUTORY_TOTAL,
} from '../gazetted';

const YEAR = 2026;
const STATE = 'KUL' as const;

/** Six valid non-compulsory KUL 2026 dates (all present in the curated pool). */
const SIX = ['2026-02-17', '2026-02-18', '2026-03-21', '2026-05-27', '2026-11-08', '2026-12-25'];

beforeEach(() => {
  installLocalStorage();
  setActiveTenantId('co-asm');
});

describe('pools', () => {
  it('every state/year has exactly the 5 EA-compulsory holidays flagged', () => {
    expect(compulsoryHolidays(YEAR, STATE)).toHaveLength(COMPULSORY_COUNT);
    expect(compulsoryHolidays(YEAR, STATE).map((h) => h.date)).toEqual([
      '2026-02-01', // Federal Territory Day
      '2026-05-01', // Labour Day
      '2026-06-01', // Agong's Birthday
      '2026-08-31', // National Day
      '2026-09-16', // Malaysia Day
    ]);
  });

  it('the choosable pool excludes compulsory days but keeps curated + custom holidays', () => {
    const pool = choosablePool(YEAR, STATE);
    expect(pool.length).toBeGreaterThanOrEqual(CHOSEN_COUNT);
    expect(pool.every((h) => !h.isCompulsoryEA)).toBe(true);
    for (const d of SIX) expect(pool.map((h) => h.date)).toContain(d);
  });
});

describe('validateSelection', () => {
  it('flags an insufficient selection with the s.60D shortfall message', () => {
    const v = validateSelection(YEAR, STATE, SIX.slice(0, 3));
    expect(v.valid).toBe(false);
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]).toBe(
      'Insufficient — only 8 of the statutory 11 days selected. ' +
        'EA 1955 s.60D requires 11 gazetted paid holidays (5 compulsory + 6 chosen).',
    );
  });

  it('counts an empty selection as 5 of 11', () => {
    const v = validateSelection(YEAR, STATE, []);
    expect(v.valid).toBe(false);
    expect(v.issues[0]).toContain('only 5 of the statutory 11 days selected');
  });

  it('rejects dates that are not holidays in that state/year', () => {
    const v = validateSelection(YEAR, STATE, [...SIX, '2026-07-04']);
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.includes('2026-07-04 is not a gazetted holiday in W.P. Kuala Lumpur for 2026'))).toBe(true);
  });

  it('rejects a holiday that does not apply to the selected state', () => {
    // Thaipusam is gazetted in KUL but Good Friday (SBH/SWK only) is not.
    const v = validateSelection(YEAR, STATE, [...SIX, '2026-04-03']);
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.includes('2026-04-03 is not a gazetted holiday'))).toBe(true);
  });

  it('rejects compulsory dates — they already count toward the 11', () => {
    const v = validateSelection(YEAR, STATE, [...SIX.slice(0, 5), '2026-05-01']); // Labour Day
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.includes('2026-05-01 is one of the 5 EA-compulsory holidays'))).toBe(true);
  });

  it('flags duplicates (which also shrink the usable count)', () => {
    // 6 entries but only 5 unique — duplicate flagged AND count falls short.
    const v = validateSelection(YEAR, STATE, [SIX[0], SIX[0], ...SIX.slice(1, 5)]);
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.includes(`Duplicate dates selected (${SIX[0]})`))).toBe(true);
    expect(v.issues.some((i) => i.includes('Insufficient'))).toBe(true);
  });

  it('accepts exactly 6 valid chosen dates', () => {
    const v = validateSelection(YEAR, STATE, SIX);
    expect(v.valid).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it('warns (without blocking) when more than 6 are chosen', () => {
    const extra = '2026-01-01'; // New Year's Day — in the KUL pool
    const v = validateSelection(YEAR, STATE, [...SIX, extra]);
    expect(v.valid).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.warnings.some((w) => w.includes('beyond the statutory 6'))).toBe(true);
  });

  it('warns when a chosen date falls on a rest day (s.60D proviso substitution)', () => {
    const restDay = choosablePool(YEAR, STATE).find((h) => isWeekend(h.date, STATE));
    expect(restDay).toBeDefined();
    const v = validateSelection(YEAR, STATE, [restDay!.date]);
    expect(v.warnings.some((w) => w.includes(restDay!.date) && w.includes('falls on a rest day'))).toBe(true);
    // advisory only — the insufficient-count issue is what blocks
    expect(v.valid).toBe(false);
  });
});

describe('effectiveGazettedDays', () => {
  it('returns only the 5 compulsory days when no selection exists', () => {
    const eff = effectiveGazettedDays(YEAR, STATE);
    expect(eff).toHaveLength(COMPULSORY_COUNT);
    expect(eff.every((h) => h.isCompulsoryEA)).toBe(true);
  });

  it('returns the 5 compulsory + 6 chosen, sorted by date', () => {
    saveGazettedSelection(YEAR, STATE, [...SIX].reverse()); // unsorted input
    const eff = effectiveGazettedDays(YEAR, STATE);
    expect(eff).toHaveLength(STATUTORY_TOTAL);
    const dates = eff.map((h) => h.date);
    expect(dates).toEqual([...dates].sort());
    for (const d of SIX) expect(dates).toContain(d);
    expect(dates).toContain('2026-05-01'); // Labour Day (compulsory)
    expect(dates).not.toContain('2026-01-01'); // in the pool but not chosen
  });

  it('ignores a selection saved for a different state', () => {
    saveGazettedSelection(YEAR, 'JHR', SIX);
    expect(effectiveGazettedDays(YEAR, STATE)).toHaveLength(COMPULSORY_COUNT);
  });
});

describe('publish flow', () => {
  it('refuses to publish an invalid selection and writes nothing', () => {
    const r = publishGazettedSelection(YEAR, STATE, SIX.slice(0, 2));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.includes('Insufficient'))).toBe(true);
    expect(getGazettedSelection(YEAR)).toBeNull();
    expect(publishedGazettedDates(YEAR, STATE)).toBeNull();
  });

  it('publishes a valid selection: stamps publishedAt + freezes the snapshot', () => {
    const r = publishGazettedSelection(YEAR, STATE, SIX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selection.publishedAt).toBeTruthy();
    expect(r.selection.publishedDates).toEqual([...SIX].sort());

    const stored = getGazettedSelection(YEAR);
    expect(stored).toMatchObject({ year: YEAR, state: STATE });
    expect(stored!.publishedAt).toBe(r.selection.publishedAt);

    const published = publishedGazettedDates(YEAR, STATE);
    expect(published).not.toBeNull();
    expect(published!.size).toBe(STATUTORY_TOTAL);
    for (const d of SIX) expect(published!.has(d)).toBe(true);
    expect(published!.has('2026-09-16')).toBe(true); // Malaysia Day
  });

  it('draft edits after publish keep the published snapshot until re-published', () => {
    publishGazettedSelection(YEAR, STATE, SIX);
    const draft = [...SIX.slice(0, 5), '2026-01-01']; // swap one date in the draft
    saveGazettedSelection(YEAR, STATE, draft);

    const sel = getGazettedSelection(YEAR);
    expect(sel!.chosenDates).toEqual([...draft].sort()); // working copy updated
    expect(sel!.publishedDates).toEqual([...SIX].sort()); // snapshot untouched
    expect(sel!.publishedAt).toBeTruthy();
    expect(publishedGazettedDates(YEAR, STATE)!.has('2026-01-01')).toBe(false); // badge follows the notice

    // Re-publish moves the snapshot to the new draft.
    const r = publishGazettedSelection(YEAR, STATE, draft);
    expect(r.ok).toBe(true);
    expect(publishedGazettedDates(YEAR, STATE)!.has('2026-01-01')).toBe(true);
  });

  it('returns null from publishedGazettedDates for a state mismatch', () => {
    publishGazettedSelection(YEAR, 'JHR', SIX);
    expect(publishedGazettedDates(YEAR, STATE)).toBeNull();
  });
});

describe('per-year reset', () => {
  it('returns false when nothing exists, true after removing a selection', () => {
    expect(resetGazettedSelection(YEAR)).toBe(false);
    saveGazettedSelection(YEAR, STATE, SIX);
    expect(resetGazettedSelection(YEAR)).toBe(true);
    expect(getGazettedSelection(YEAR)).toBeNull();
  });

  it('resetting one year leaves other years untouched', () => {
    saveGazettedSelection(YEAR, STATE, SIX);
    saveGazettedSelection(YEAR + 1, STATE, SIX.map((d) => d.replace('2026', '2027').replace('02-17', '02-06').replace('02-18', '02-07')));
    resetGazettedSelection(YEAR);
    expect(getGazettedSelection(YEAR)).toBeNull();
    expect(getGazettedSelection(YEAR + 1)).not.toBeNull();
  });
});

describe('per-tenant isolation', () => {
  it('selections are invisible across tenants', () => {
    publishGazettedSelection(YEAR, STATE, SIX);
    expect(getGazettedSelection(YEAR)).not.toBeNull();

    setActiveTenantId('co-merdeka');
    expect(getGazettedSelection(YEAR)).toBeNull();
    expect(publishedGazettedDates(YEAR, STATE)).toBeNull();
    expect(effectiveGazettedDays(YEAR, STATE)).toHaveLength(COMPULSORY_COUNT);

    // A different tenant makes its own independent selection.
    const other = SIX.map((d) => d).slice(0, 6);
    publishGazettedSelection(YEAR, STATE, other);
    expect(getGazettedSelection(YEAR)!.chosenDates).toEqual([...other].sort());

    setActiveTenantId('co-asm');
    expect(getGazettedSelection(YEAR)!.chosenDates).toEqual([...SIX].sort());
  });
});
