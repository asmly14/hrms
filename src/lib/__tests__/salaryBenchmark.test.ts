import { describe, it, expect } from 'vitest';
import {
  BENCHMARKS,
  COST_OF_LIVING,
  INCOME_THRESHOLDS,
  NATIONAL_MEDIAN_WAGE,
  STATE_DECILES,
  bandForYears,
  colAdjustedSalary,
  colForState,
  incomeClass,
  listIndustries,
  listRoles,
  stateDecilePlacement,
  stateFactor,
  suggestSalary,
  type SeniorityBand,
} from '../salaryBenchmark';
import { states } from '../holidays';

const BAND_ORDER: SeniorityBand[] = ['0-2', '3-5', '6-10', '10+'];

describe('benchmark table integrity', () => {
  it('covers the researched dataset: 62 roles across 13 industries', () => {
    expect(BENCHMARKS).toHaveLength(62);
    expect(listIndustries()).toHaveLength(13);
  });

  it('every role carries industry, job description, qualifications and demand info', () => {
    for (const row of BENCHMARKS) {
      expect(row.industry.length, row.role).toBeGreaterThan(0);
      expect(row.jobDescription.length, row.role).toBeGreaterThan(10);
      expect(row.qualifications.length, row.role).toBeGreaterThan(5);
      expect(row.demandTrend.length, row.role).toBeGreaterThan(10);
      expect(row.demandLevel, row.role).toBeTruthy();
      expect(row.department.length, row.role).toBeGreaterThan(0);
    }
  });

  it('every role: min ≤ median ≤ max within each band', () => {
    for (const row of BENCHMARKS) {
      for (const band of BAND_ORDER) {
        const b = row.bands[band];
        expect(b.min, `${row.role} ${band}`).toBeLessThanOrEqual(b.median);
        expect(b.median, `${row.role} ${band}`).toBeLessThanOrEqual(b.max);
      }
    }
  });

  it('bands strictly increase with seniority for every role', () => {
    for (const row of BENCHMARKS) {
      for (let i = 1; i < BAND_ORDER.length; i++) {
        const prev = row.bands[BAND_ORDER[i - 1]!]!;
        const cur = row.bands[BAND_ORDER[i]!]!;
        expect(cur.min, `${row.role}: ${BAND_ORDER[i]} min ≤ prev`).toBeGreaterThan(prev.min);
        expect(cur.median, `${row.role}: ${BAND_ORDER[i]} median ≤ prev`).toBeGreaterThan(prev.median);
        expect(cur.max, `${row.role}: ${BAND_ORDER[i]} max ≤ prev`).toBeGreaterThan(prev.max);
      }
    }
  });

  it('no band drops below the RM1,700 minimum wage', () => {
    for (const row of BENCHMARKS) {
      expect(row.bands['0-2'].min, row.role).toBeGreaterThanOrEqual(1700);
    }
  });
});

describe('listIndustries / listRoles', () => {
  it('listIndustries returns unique industries in dataset order', () => {
    const industries = listIndustries();
    expect(new Set(industries).size).toBe(industries.length);
    expect(industries[0]).toBe('Technology');
    expect(industries).toContain('Finance & Banking');
    expect(industries).toContain('Corporate Functions (Cross-Industry)');
  });

  it('listRoles filters by industry; no arg returns all rows', () => {
    expect(listRoles()).toHaveLength(62);
    const tech = listRoles('Technology');
    expect(tech.length).toBe(7);
    expect(tech.every((r) => r.industry === 'Technology')).toBe(true);
    expect(tech.map((r) => r.role)).toContain('Software Engineer');
  });
});

describe('bandForYears', () => {
  it('maps years of experience to the right seniority band', () => {
    expect(bandForYears(0)).toBe('0-2');
    expect(bandForYears(2)).toBe('0-2');
    expect(bandForYears(3)).toBe('3-5');
    expect(bandForYears(5)).toBe('3-5');
    expect(bandForYears(6)).toBe('6-10');
    expect(bandForYears(10)).toBe('6-10');
    expect(bandForYears(11)).toBe('10+');
    expect(bandForYears(25)).toBe('10+');
  });
});

describe('stateFactor — wage-market factors (research §A.6)', () => {
  it('Klang Valley baseline: KUL and SGR are ×1.00', () => {
    expect(stateFactor('KUL')).toBe(1);
    expect(stateFactor('SGR')).toBe(1);
  });

  it('matches the researched factor for every state', () => {
    const expected: Record<string, number> = {
      KUL: 1, SGR: 1, PJY: 0.98, PNG: 0.95, JHR: 0.93,
      MLK: 0.88, NSB: 0.88, LBN: 0.88, SWK: 0.87, SBH: 0.85,
      PRK: 0.85, PHG: 0.84, TRG: 0.84, KDH: 0.82, PLS: 0.8, KTN: 0.8,
    };
    for (const s of states) {
      expect(stateFactor(s.code), s.code).toBe(expected[s.code]);
    }
  });

  it('no state exceeds the Klang Valley baseline', () => {
    for (const s of states) {
      expect(stateFactor(s.code)).toBeLessThanOrEqual(1);
      expect(stateFactor(s.code)).toBeGreaterThan(0.5);
    }
  });
});

describe('suggestSalary — seniority & state factors', () => {
  it('suggestions increase with seniority for the same role & state', () => {
    let prevMedian = 0;
    for (const years of [1, 4, 8, 15]) {
      const s = suggestSalary('Software Engineer', years, 'KUL');
      expect(s.median).toBeGreaterThan(prevMedian);
      prevMedian = s.median;
    }
  });

  it('KUL keeps the Klang-Valley baseline (×1.00), Perak applies ×0.85', () => {
    const kul = suggestSalary('Accountant', 4, 'KUL');
    const prk = suggestSalary('Accountant', 4, 'PRK');
    expect(kul.stateFactor).toBe(1);
    expect(prk.stateFactor).toBe(0.85);
    expect(kul.median).toBe(5500); // researched 3-5 median, GL/Financial Accountant
    expect(prk.median).toBeCloseTo(5500 * 0.85, 2);
    expect(prk.min).toBeCloseTo(kul.min * 0.85, 2);
    expect(prk.max).toBeCloseTo(kul.max * 0.85, 2);
  });

  it('East Malaysia factor applied (SBH ×0.85, SWK ×0.87)', () => {
    const base = suggestSalary('Technician', 1, 'KUL');
    const sbh = suggestSalary('Technician', 1, 'SBH');
    const swk = suggestSalary('Technician', 1, 'SWK');
    expect(sbh.stateFactor).toBe(0.85);
    expect(swk.stateFactor).toBe(0.87);
    expect(sbh.median).toBeCloseTo(base.median * 0.85, 2);
    expect(swk.median).toBeCloseTo(base.median * 0.87, 2);
  });

  it('role aliases resolve to the right benchmark row', () => {
    expect(suggestSalary('full stack developer', 4, 'KUL').matchedRole).toBe('Full-Stack / Senior Developer');
    expect(suggestSalary('software developer', 4, 'KUL').matchedRole).toBe('Software Engineer');
    expect(suggestSalary('Data Analyst', 4, 'KUL').matchedRole).toBe('Data Scientist');
    expect(suggestSalary('Warehouse Assistant', 2, 'KUL').matchedRole).toBe('Warehouse Executive / Manager');
    expect(suggestSalary('Admin Clerk', 2, 'KUL').matchedRole).toBe('Admin / Office Executive');
  });

  it('regression (QA B2): seniority prefixes are stripped before matching', () => {
    const plain = suggestSalary('Software Engineer', 4, 'KUL');
    const senior = suggestSalary('Senior Software Engineer', 4, 'KUL');
    expect(senior.matchedRole).toBe('Software Engineer');
    expect(senior.median).toBe(plain.median);
    expect(suggestSalary('Senior HR Manager', 6, 'KUL').matchedRole).toBe('HR Manager');
    expect(suggestSalary('junior accountant', 1, 'KUL').matchedRole).toBe('Accountant (GL/Financial)');
  });

  it('unknown role falls back to the generic band (no crash, no zero)', () => {
    const s = suggestSalary('Chief Happiness Officer', 4, 'KUL');
    expect(s.matchedRole).toBe('Generic');
    expect(s.median).toBeGreaterThan(0);
    expect(s.min).toBeLessThanOrEqual(s.median);
    expect(s.median).toBeLessThanOrEqual(s.max);
  });

  it('regression: empty role string must not match an arbitrary benchmark row', () => {
    const s = suggestSalary('   ', 4, 'KUL');
    expect(s.matchedRole).toBe('Generic');
  });

  it('department fallback still works when the role has no direct match', () => {
    const s = suggestSalary('Chief Happiness Officer', 4, 'KUL', 'Human Resources');
    expect(s.matchedRole).toBe('HR Executive');
  });

  it('percentiles sit inside [min, max] and bracket the median', () => {
    for (const years of [1, 4, 8, 15]) {
      const s = suggestSalary('HR Executive', years, 'PNG');
      expect(s.percentile25).toBeGreaterThanOrEqual(s.min);
      expect(s.percentile25).toBeLessThanOrEqual(s.median);
      expect(s.percentile75).toBeGreaterThanOrEqual(s.median);
      expect(s.percentile75).toBeLessThanOrEqual(s.max);
    }
  });

  it('drivers explain the match and the location factor', () => {
    const s = suggestSalary('Software Engineer', 4, 'KUL');
    expect(s.drivers.join(' ')).toContain('Software Engineer');
    expect(s.drivers.join(' ')).toContain('Klang Valley baseline');
    const sbh = suggestSalary('Software Engineer', 4, 'SBH');
    expect(sbh.drivers.join(' ')).toContain('0.85');
  });

  it('researched profile fields ride along on a match; absent on generic', () => {
    const s = suggestSalary('Software Engineer', 4, 'KUL');
    expect(s.industry).toBe('Technology');
    expect(s.jobDescription).toContain('Designs, builds and maintains');
    expect(s.qualifications).toContain('Computer Science');
    expect(s.demandTrend).toContain('Very high');
    expect(s.demandLevel).toBe('very-high');
    const g = suggestSalary('Chief Happiness Officer', 4, 'KUL');
    expect(g.industry).toBeUndefined();
    expect(g.jobDescription).toBeUndefined();
  });
});

describe('cost of living table', () => {
  it('covers all 16 states with KUL = 100', () => {
    expect(COST_OF_LIVING).toHaveLength(16);
    expect(colForState('KUL').index).toBe(100);
    for (const s of states) {
      const row = colForState(s.code);
      expect(row.state, s.code).toBe(s.code);
      expect(row.index).toBeGreaterThan(0);
      expect(row.index).toBeLessThanOrEqual(100);
      expect(row.basket).toBeGreaterThan(0);
      expect(row.rent1BrCity).toBeGreaterThan(0);
    }
  });

  it('colAdjustedSalary converts at purchasing-power parity', () => {
    // KUL (100) → PLS (44.5): RM1,000 buys what RM445 buys in Kangar.
    expect(colAdjustedSalary(1000, 'KUL', 'PLS')).toBe(445);
    expect(colAdjustedSalary(5000, 'PLS', 'KUL')).toBeCloseTo(5000 * (100 / 44.5), 2);
    // Same state = identity.
    expect(colAdjustedSalary(4200, 'JHR', 'JHR')).toBe(4200);
  });
});

describe('incomeClass — DOSM HIS 2024 B40/M40/T20', () => {
  it('places income in the right band and sub-band', () => {
    expect(incomeClass(2500)).toMatchObject({ band: 'B40', subBand: 'B1' });
    expect(incomeClass(3000)).toMatchObject({ band: 'B40', subBand: 'B2' });
    expect(incomeClass(5000)).toMatchObject({ band: 'B40', subBand: 'B4' });
    expect(incomeClass(6000)).toMatchObject({ band: 'M40', subBand: 'M1' });
    expect(incomeClass(9000)).toMatchObject({ band: 'M40', subBand: 'M3' });
    expect(incomeClass(12000)).toMatchObject({ band: 'M40', subBand: 'M4' });
    expect(incomeClass(13000)).toMatchObject({ band: 'T20', subBand: 'T1' });
    expect(incomeClass(20000)).toMatchObject({ band: 'T20', subBand: 'T2' });
  });

  it('honours the exact thresholds (5,859 / 12,680)', () => {
    expect(incomeClass(5859).band).toBe('B40');
    expect(incomeClass(5860).band).toBe('M40');
    expect(incomeClass(12679).band).toBe('M40');
    expect(incomeClass(12680).band).toBe('T20');
  });

  it('compares against the national median wage and flags the T15 zone', () => {
    const s = incomeClass(NATIONAL_MEDIAN_WAGE * 2);
    expect(s.nationalMedian).toBe(NATIONAL_MEDIAN_WAGE);
    expect(s.vsNationalMedian).toBeCloseTo(2, 2);
    expect(s.t15Zone).toBe(false);
    expect(incomeClass(14000).t15Zone).toBe(true);
    expect(incomeClass(0).t15Zone).toBe(false);
  });

  it('thresholds are versioned by survey year', () => {
    expect(INCOME_THRESHOLDS.surveyYear).toBe(2024);
    expect(INCOME_THRESHOLDS.subBands).toHaveLength(10);
  });
});

describe('stateDecilePlacement — DOSM HIS 2024 deciles', () => {
  it('covers all 16 states with 10 deciles each', () => {
    for (const s of states) {
      expect(STATE_DECILES[s.code], s.code).toHaveLength(10);
    }
  });

  it('places an income on the state decile ladder', () => {
    const top = stateDecilePlacement(50000, 'KUL');
    expect(top.decile).toBe(10);
    const bottom = stateDecilePlacement(1000, 'KUL');
    expect(bottom.decile).toBe(1);
    // KUL D5 median is 10,242: RM11,000 sits in D6.
    const mid = stateDecilePlacement(11000, 'KUL');
    expect(mid.decile).toBe(6);
    expect(mid.decileMedian).toBe(11559);
    expect(mid.belowShare).toBeCloseTo(0.6, 2);
  });
});
