/**
 * workdays.ts — working-day counts, employment windows, proration math.
 *
 * Expected 2026 figures below are hand-verified against the gazetted calendar
 * in holidayData.ts (incl. EA s.60D in-lieu replacements):
 *  - 2026-02 KUL (sat-sun): 20 weekdays − {FT in-lieu 02-02, Thaipusam in-lieu
 *    02-03, CNY 02-17, CNY2 02-18} = 16. FT Day + Thaipusam both fell on
 *    Sun 02-01 and were replaced (compulsory EA holiday takes the first slot).
 *  - 2026-02 JHR (fri-sat): 20 weekdays − {Thaipusam 02-01 (a Sunday = working
 *    day in JHR), CNY 02-17, CNY2 02-18, Awal Ramadan 02-19} = 16. Same count,
 *    completely different composition — Sunday is a working day in Johor.
 *  - 2026-03 KUL: 22 weekdays − {Nuzul in-lieu 03-09, Raya in-lieu 03-23/24} = 19.
 *  - 2026-03 JHR: 23 weekdays − {Raya Day2 03-22 (Sunday = working day),
 *    Sultan of Johor 03-23, Raya in-lieu 03-24} = 20.
 *  - 2026-06 KUL: 22 weekdays − {Agong 06-01, Wesak in-lieu 06-02, Muharram
 *    06-17} = 19. JHR: Wesak fell on Sun 05-31 (a JHR working day, in MAY) so
 *    June loses only Agong + Muharram = 20.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import {
  calendarDaysInMonth, daysInBasis, employedDaysInMonth, prorate,
  resolveProrationMethod, unpaidLeaveDaysInMonth, workingDaysInMonth,
} from '../workdays';
import { saveCompanies } from '../db';
import type { Company, LeaveRequest } from '../types';

beforeEach(() => {
  installLocalStorage();
});

describe('calendarDaysInMonth', () => {
  it('returns the true month lengths incl. leap years', () => {
    expect(calendarDaysInMonth('2026-01')).toBe(31);
    expect(calendarDaysInMonth('2026-02')).toBe(28);
    expect(calendarDaysInMonth('2024-02')).toBe(29);
    expect(calendarDaysInMonth('2026-04')).toBe(30);
  });
});

describe('workingDaysInMonth — state-aware weekends + effective holidays', () => {
  it('2026-02: KUL and JHR both land on 16 via different holiday compositions', () => {
    expect(workingDaysInMonth('2026-02', 'KUL')).toBe(16); // FT + Thaipusam in-lieu
    expect(workingDaysInMonth('2026-02', 'JHR')).toBe(16); // Sun Thaipusam + Awal Ramadan
  });

  it('2026-03: KUL 19 vs JHR 20 (in-lieu placement follows the weekend rule)', () => {
    expect(workingDaysInMonth('2026-03', 'KUL')).toBe(19);
    expect(workingDaysInMonth('2026-03', 'JHR')).toBe(20);
  });

  it('2026-06: KUL 19 vs JHR 20 (Wesak in-lieu only replaces a rest day)', () => {
    expect(workingDaysInMonth('2026-06', 'KUL')).toBe(19);
    expect(workingDaysInMonth('2026-06', 'JHR')).toBe(20);
  });

  it('never exceeds the weekday count implied by the weekend rule', () => {
    // KUL March 2026 has 9 Sat/Sun → at most 22 working days.
    expect(workingDaysInMonth('2026-03', 'KUL')).toBeLessThanOrEqual(22);
    // JHR March 2026 has 8 Fri/Sat → at most 23.
    expect(workingDaysInMonth('2026-03', 'JHR')).toBeLessThanOrEqual(23);
  });
});

describe('daysInBasis', () => {
  it('matches the method denominator', () => {
    expect(daysInBasis('2026-03', 'KUL', 'calendar')).toBe(31);
    expect(daysInBasis('2026-03', 'KUL', 'working-days')).toBe(19);
    expect(daysInBasis('2026-03', 'JHR', 'working-days')).toBe(20);
    expect(daysInBasis('2026-02', 'KUL', 'fixed-26')).toBe(26);
  });
});

describe('employedDaysInMonth', () => {
  const joiner = { joinDate: '2026-03-10', state: 'KUL' as const };
  const leaver = { joinDate: '2020-01-01', resignDate: '2026-03-15', state: 'KUL' as const };

  it('full-month employment returns the whole basis on every method', () => {
    const full = { joinDate: '2020-01-01', state: 'KUL' as const };
    expect(employedDaysInMonth(full, '2026-03', 'calendar')).toBe(31);
    expect(employedDaysInMonth(full, '2026-03', 'working-days')).toBe(19);
    expect(employedDaysInMonth(full, '2026-03', 'fixed-26')).toBe(26);
  });

  it('mid-month joiner: calendar & fixed-26 count calendar days, working-days counts working days', () => {
    expect(employedDaysInMonth(joiner, '2026-03', 'calendar')).toBe(22); // Mar 10–31
    expect(employedDaysInMonth(joiner, '2026-03', 'fixed-26')).toBe(22);
    expect(employedDaysInMonth(joiner, '2026-03', 'working-days')).toBe(14); // 19 − 5 worked Mar 1–9
  });

  it('mid-month joiner in a fri-sat state uses that weekend rule', () => {
    const jhr = { joinDate: '2026-03-10', state: 'JHR' as const };
    expect(employedDaysInMonth(jhr, '2026-03', 'working-days')).toBe(13); // 20 − 7 worked Mar 1–9
  });

  it('mid-month leaver: same basis logic from the resignation boundary', () => {
    expect(employedDaysInMonth(leaver, '2026-03', 'calendar')).toBe(15); // Mar 1–15
    expect(employedDaysInMonth(leaver, '2026-03', 'fixed-26')).toBe(15);
    expect(employedDaysInMonth(leaver, '2026-03', 'working-days')).toBe(9);
  });

  it('fixed-26 caps the numerator at 26 for long months', () => {
    const full = { joinDate: '2020-01-01', state: 'KUL' as const };
    expect(employedDaysInMonth(full, '2026-03', 'fixed-26')).toBe(26); // 31 → capped
  });

  it('returns 0 when the employee was not employed during the month', () => {
    expect(employedDaysInMonth({ joinDate: '2026-04-01', state: 'KUL' }, '2026-03', 'calendar')).toBe(0);
    expect(
      employedDaysInMonth({ joinDate: '2020-01-01', resignDate: '2026-02-28', state: 'KUL' }, '2026-03', 'calendar'),
    ).toBe(0);
  });
});

describe('prorate', () => {
  const joiner = { joinDate: '2026-03-10', state: 'KUL' as const };

  it('calendar: 3100 × 22/31 = 2200.00', () => {
    const r = prorate(3100, joiner, '2026-03', 'calendar');
    expect(r.daysWorked).toBe(22);
    expect(r.daysInBasis).toBe(31);
    expect(r.factor).toBeCloseTo(22 / 31, 10);
    expect(r.amount).toBe(2200);
  });

  it('working-days: 3100 × 14/19', () => {
    const r = prorate(3100, joiner, '2026-03', 'working-days');
    expect(r.daysWorked).toBe(14);
    expect(r.daysInBasis).toBe(19);
    expect(r.amount).toBe(2284.21);
  });

  it('fixed-26: 3100 × 22/26', () => {
    const r = prorate(3100, joiner, '2026-03', 'fixed-26');
    expect(r.daysWorked).toBe(22);
    expect(r.daysInBasis).toBe(26);
    expect(r.amount).toBe(2623.08);
  });

  it('full-month employment is never prorated (factor 1, amount untouched)', () => {
    const full = { joinDate: '2020-01-01', state: 'KUL' as const };
    for (const method of ['calendar', 'working-days', 'fixed-26'] as const) {
      const r = prorate(3100, full, '2026-03', method);
      expect(r.factor).toBe(1);
      expect(r.amount).toBe(3100);
    }
  });
});

describe('unpaidLeaveDaysInMonth — same basis as the proration method', () => {
  const leaves: LeaveRequest[] = [
    // Sat 7th + Sun 8th + Mon 9th (Nuzul in-lieu, a KUL holiday) → 3 calendar days, 0 working days
    { id: 'l1', employeeId: 'e1', type: 'unpaid', startDate: '2026-03-07', endDate: '2026-03-09', days: 1, status: 'approved', appliedAt: '2026-03-01' },
    // Thu 12th + Fri 13th → 2 calendar days, 2 working days
    { id: 'l2', employeeId: 'e1', type: 'unpaid', startDate: '2026-03-12', endDate: '2026-03-13', days: 2, status: 'approved', appliedAt: '2026-03-01' },
    // Rejected leave never counts
    { id: 'l3', employeeId: 'e1', type: 'unpaid', startDate: '2026-03-16', endDate: '2026-03-16', days: 1, status: 'rejected', appliedAt: '2026-03-01' },
  ];

  it('calendar / fixed-26 count calendar days', () => {
    expect(unpaidLeaveDaysInMonth(leaves, 'e1', '2026-03', 'KUL', 'calendar')).toBe(5);
    expect(unpaidLeaveDaysInMonth(leaves, 'e1', '2026-03', 'KUL', 'fixed-26')).toBe(5);
  });

  it('working-days counts only working days (weekends & in-lieu holidays excluded)', () => {
    expect(unpaidLeaveDaysInMonth(leaves, 'e1', '2026-03', 'KUL', 'working-days')).toBe(2);
  });
});

describe('resolveProrationMethod', () => {
  const base: Company = {
    id: 'co-asm',
    code: 'ASM',
    name: 'Co',
    regNo: '1',
    hqState: 'KUL',
    status: 'active',
    plan: 'pro',
    createdAt: '2026-01-01T00:00:00.000Z',
    branding: { logoText: 'A', accentColor: '#000000' },
    config: {
      workingWeek: 'sat-sun',
      payrollCutoffDay: 25,
      claimPolicy: {},
      leaveTopUps: {},
      enabledModules: [],
      customFields: [],
      numberFormats: { employeeIdPrefix: 'A', payslipPrefix: 'A-PS' },
      orgChart: { showDottedLineReports: false },
    },
  };

  it("defaults to 'calendar' when no company/config is present", () => {
    expect(resolveProrationMethod()).toBe('calendar');
  });

  it('reads the active company config and rejects invalid values', () => {
    saveCompanies([{ ...base, config: { ...base.config, payrollProration: 'working-days' } }]);
    expect(resolveProrationMethod()).toBe('working-days');
    saveCompanies([
      { ...base, config: { ...base.config, payrollProration: 'bogus' as never } },
    ]);
    expect(resolveProrationMethod()).toBe('calendar');
  });
});
