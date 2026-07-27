import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import {
  getHolidays, getEffectiveHolidays, isHoliday, isWeekend,
  replacementHoliday, states, stateInfo,
} from '../holidays';

beforeEach(() => {
  installLocalStorage();
});

describe('weekend rules per state', () => {
  // 2025-01-03 = Friday, 2025-01-04 = Saturday, 2025-01-05 = Sunday
  it('KUL (sat-sun): Friday is a working day, Sat & Sun are rest days', () => {
    expect(isWeekend('2025-01-03', 'KUL')).toBe(false);
    expect(isWeekend('2025-01-04', 'KUL')).toBe(true);
    expect(isWeekend('2025-01-05', 'KUL')).toBe(true);
    expect(isWeekend('2025-01-06', 'KUL')).toBe(false); // Monday
  });

  it('JHR (fri-sat): Fri & Sat are rest days, Sunday is a working day', () => {
    expect(isWeekend('2025-01-03', 'JHR')).toBe(true);
    expect(isWeekend('2025-01-04', 'JHR')).toBe(true);
    expect(isWeekend('2025-01-05', 'JHR')).toBe(false);
  });

  it('all four fri-sat states behave like JHR; the rest like KUL', () => {
    const friSat = ['JHR', 'KDH', 'KTN', 'TRG'] as const;
    for (const s of states) {
      const expectFriSat = (friSat as readonly string[]).includes(s.code);
      expect(isWeekend('2025-01-03', s.code), `${s.code} Friday`).toBe(expectFriSat);
      expect(isWeekend('2025-01-05', s.code), `${s.code} Sunday`).toBe(!expectFriSat);
    }
    expect(stateInfo('JHR').weekend).toBe('fri-sat');
    expect(stateInfo('KUL').weekend).toBe('sat-sun');
  });
});

describe('holiday coverage', () => {
  it('every state gets at least 14 gazetted holidays per year (EA s.60D scale)', () => {
    for (const year of [2025, 2026, 2027]) {
      for (const s of states) {
        const count = getHolidays(year, s.code).length;
        expect(count, `${s.code} ${year} has only ${count} holidays`).toBeGreaterThanOrEqual(14);
      }
    }
  });

  it('national holidays apply to all states; state-only ones do not leak', () => {
    const kul = getHolidays(2025, 'KUL');
    expect(kul.some((h) => h.name.includes('Merdeka'))).toBe(true);
    // Sarawak Day must not appear for KUL
    expect(kul.some((h) => h.name === 'Sarawak Day')).toBe(false);
    const swk = getHolidays(2025, 'SWK');
    expect(swk.some((h) => h.name === 'Sarawak Day')).toBe(true);
    // FT Day only for KUL/LBN/PJY
    expect(getHolidays(2025, 'JHR').some((h) => h.name === 'Federal Territory Day')).toBe(false);
    expect(kul.some((h) => h.name === 'Federal Territory Day')).toBe(true);
  });

  it('5 compulsory EA s.60D holidays are flagged per state', () => {
    for (const s of states) {
      const compulsory = getHolidays(2025, s.code).filter((h) => h.isCompulsoryEA);
      // Labour Day, Agong's Birthday, National Day, Malaysia Day + state ruler/FT day
      expect(compulsory.length, `${s.code} compulsory`).toBeGreaterThanOrEqual(5);
      expect(compulsory.some((h) => h.name === 'Labour Day')).toBe(true);
      expect(compulsory.some((h) => h.name.includes('Merdeka'))).toBe(true);
      expect(compulsory.some((h) => h.name === 'Malaysia Day')).toBe(true);
    }
  });
});

describe('replacement holidays (EA s.60D proviso)', () => {
  // National Day 2025-08-31 falls on a Sunday.
  it('PH on a Sunday rest day (KUL) → replaced by the next working day', () => {
    const merdeka = getHolidays(2025, 'KUL').find((h) => h.date === '2025-08-31')!;
    expect(merdeka).toBeDefined();
    const r = replacementHoliday(merdeka, 'KUL');
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2025-09-01'); // Monday
    expect(r!.replacesDate).toBe('2025-08-31');
    expect(r!.name).toContain('in lieu');
  });

  it('same PH on a Sunday working day (JHR, fri-sat weekend) → no replacement', () => {
    const merdeka = getHolidays(2025, 'JHR').find((h) => h.date === '2025-08-31')!;
    expect(replacementHoliday(merdeka, 'JHR')).toBeNull();
    expect(isHoliday('2025-09-01', 'JHR')).toBeNull();
  });

  it('getEffectiveHolidays appends the in-lieu day; isHoliday matches it', () => {
    const eff = getEffectiveHolidays(2025, 'KUL');
    const inLieu = eff.find((h) => h.replacesDate === '2025-08-31');
    expect(inLieu).toBeDefined();
    expect(inLieu!.source).toBe('replacement');
    const hit = isHoliday('2025-09-01', 'KUL');
    expect(hit).not.toBeNull();
    expect(hit!.name).toContain('in lieu');
    // the original date is still a holiday too
    expect(isHoliday('2025-08-31', 'KUL')!.name).toContain('Merdeka');
  });

  it('replacement never lands on another weekend or occupied holiday', () => {
    for (const s of states) {
      const eff = getEffectiveHolidays(2025, s.code);
      for (const h of eff.filter((x) => x.source === 'replacement')) {
        expect(isWeekend(h.date, s.code), `${s.code} ${h.name} on weekend`).toBe(false);
        const sameDay = eff.filter((x) => x.date === h.date && x.id !== h.id);
        expect(sameDay.length, `${s.code} ${h.date} clash`).toBe(0);
      }
    }
  });
});
