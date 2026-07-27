import { describe, it, expect } from 'vitest';
import {
  calcEPF, calcSOCSO, calcEIS, calcPCB, calcOT, hrdfLevy, annualTax,
  orpFromMonthly, hourlyFromMonthly,
  MINIMUM_WAGE, OT_SALARY_THRESHOLD, MAX_OT_HOURS_MONTH, PCB_RELIEFS,
} from '../statutory';

// Researched anchors: docs/research/statutory-rates.md
// EPF Third Schedule: 11% employee; employer 13% (≤RM5,000) / 12% (>RM5,000),
// banded to RM20 and rounded UP to the next ringgit.

describe('calcEPF — Third Schedule anchors', () => {
  it('RM3,000 wages → employee 330 / employer 390 (13%)', () => {
    expect(calcEPF(3000, 30, true, false)).toEqual({ employee: 330, employer: 390 });
  });

  it('RM6,000 wages → employee 660 / employer 720 (12% > RM5,000)', () => {
    expect(calcEPF(6000, 30, true, false)).toEqual({ employee: 660, employer: 720 });
  });

  it('employer rate switches at exactly RM5,000 boundary', () => {
    expect(calcEPF(5000, 30, true, false).employer).toBe(650); // 13%
    // 5,000.01 > 5,000 → 12% on band ceiling 5,020 = 602.40 → round up 603
    expect(calcEPF(5000.01, 30, true, false).employer).toBe(603);
  });

  it('age 60+ citizen → employee 0 / employer 4%', () => {
    expect(calcEPF(3000, 61, true, false)).toEqual({ employee: 0, employer: 120 });
    expect(calcEPF(6000, 70, true, false)).toEqual({ employee: 0, employer: 240 });
  });

  it('age 75+ → nil', () => {
    expect(calcEPF(3000, 75, true, false)).toEqual({ employee: 0, employer: 0 });
  });

  it('foreign worker → 2% / 2% (mandatory from Oct 2025)', () => {
    expect(calcEPF(3000, 30, false, true)).toEqual({ employee: 60, employer: 60 });
    expect(calcEPF(6000, 30, false, true)).toEqual({ employee: 120, employer: 120 });
  });

  it('bands snap UP to the next RM20 and round UP to the next ringgit', () => {
    // 3001 → band ceiling 3020 → 3020 × 11% = 332.20 → ceil 333
    expect(calcEPF(3001, 30, true, false).employee).toBe(333);
    // exact multiple of 20 stays in its band
    expect(calcEPF(3020, 30, true, false).employee).toBe(333);
  });

  it('zero / negative wages → nil', () => {
    expect(calcEPF(0, 30, true, false)).toEqual({ employee: 0, employer: 0 });
    expect(calcEPF(-100, 30, true, false)).toEqual({ employee: 0, employer: 0 });
  });
});

describe('calcSOCSO — Act 4 Third Schedule, ceiling RM6,000', () => {
  it('cat 1 max at RM6,000+ → employee 29.75 / employer 104.15', () => {
    const r = calcSOCSO(6000, 30);
    expect(r).toEqual({ employee: 29.75, employer: 104.15, category: 1 });
    // above the ceiling the contribution stays capped
    expect(calcSOCSO(8000, 30)).toEqual(r);
  });

  it('cat 2 (age 60+) employer-only → max 74.40', () => {
    expect(calcSOCSO(6000, 61)).toEqual({ employee: 0, employer: 74.4, category: 2 });
    expect(calcSOCSO(9000, 65).employer).toBe(74.4);
  });

  it('mid-band wage uses band midpoint base', () => {
    // RM3,000 falls in the "exceeding RM2,900 ≤ RM3,000" band → base RM2,950.
    // Matches the published PERKESO schedule: ee 14.75 / er 51.625 → 51.65 (5-sen grid).
    const r = calcSOCSO(3000, 30);
    expect(r.employee).toBe(14.75);
    expect(r.employer).toBe(51.65);
  });

  it('zero wages → nil but category still derived from age', () => {
    expect(calcSOCSO(0, 30)).toEqual({ employee: 0, employer: 0, category: 1 });
    expect(calcSOCSO(0, 62)).toEqual({ employee: 0, employer: 0, category: 2 });
  });
});

describe('calcEIS — Act 800, 0.2% + 0.2%, ceiling RM6,000', () => {
  it('max contribution 11.90 / 11.90 at RM6,000+', () => {
    expect(calcEIS(6000, 30, true)).toEqual({ employee: 11.9, employer: 11.9 });
    expect(calcEIS(7500, 30, true)).toEqual({ employee: 11.9, employer: 11.9 });
  });

  it('coverage: citizens/PR aged 18–59 only', () => {
    expect(calcEIS(3000, 17, true)).toEqual({ employee: 0, employer: 0 });
    expect(calcEIS(3000, 60, true)).toEqual({ employee: 0, employer: 0 });
    expect(calcEIS(3000, 30, false)).toEqual({ employee: 0, employer: 0 });
  });

  it('below RM30 wages → nil', () => {
    expect(calcEIS(29.99, 30, true)).toEqual({ employee: 0, employer: 0 });
  });
});

describe('overtime — EA 1955 s.60A/60D', () => {
  it('ORP = monthly ÷ 26; hourly = ORP ÷ 8', () => {
    expect(orpFromMonthly(2600)).toBeCloseTo(100, 10);
    expect(hourlyFromMonthly(2600)).toBeCloseTo(12.5, 10);
  });

  it('1.5× normal / 2× rest day / 3× public holiday', () => {
    const hrp = hourlyFromMonthly(2600); // 12.5
    expect(calcOT(hrp, 10, 'normal')).toBe(187.5);
    expect(calcOT(hrp, 10, 'rest')).toBe(250);
    expect(calcOT(hrp, 10, 'holiday')).toBe(375);
  });
});

describe('statutory constants', () => {
  it('minimum wage RM1,700 (MWO 2024); OT threshold RM4,000 (EA First Schedule)', () => {
    expect(MINIMUM_WAGE).toBe(1700);
    expect(OT_SALARY_THRESHOLD).toBe(4000);
    expect(MAX_OT_HOURS_MONTH).toBe(104);
  });

  it('HRD levy: 1% ≥10 staff, 0.5% 5–9, 0 below 5', () => {
    expect(hrdfLevy(5000, 12)).toBe(50);
    expect(hrdfLevy(5000, 7)).toBe(25);
    expect(hrdfLevy(5000, 3)).toBe(0);
  });
});

describe('calcPCB — LHDN computerized annualized method', () => {
  const ytd0 = { gross: 0, epf: 0, socso: 0, pcb: 0 };
  const single = { marital: 'single' as const, children: 0, monthIndex: 1 };

  it('RM3,000 single no children → small value (rebate wipes tax below ~RM3.1k)', () => {
    const pcb = calcPCB(3000, ytd0, single);
    expect(pcb).toBeGreaterThanOrEqual(0);
    expect(pcb).toBeLessThan(50);
  });

  it('monotonically increases with salary', () => {
    let prev = -1;
    for (const s of [3000, 4000, 5000, 6000, 8000, 10000, 15000]) {
      const pcb = calcPCB(s, ytd0, single);
      expect(pcb).toBeGreaterThanOrEqual(prev);
      prev = pcb;
    }
    expect(prev).toBeGreaterThan(0); // high earners definitely pay PCB
  });

  it('bonus month PCB exceeds normal month PCB (additional-remuneration delta)', () => {
    // Salary high enough that the annualized projection is above the rebate zone.
    const normal = calcPCB(6000, ytd0, { ...single, monthIndex: 1 });
    const withBonus = calcPCB(6000, ytd0, { ...single, monthIndex: 1, bonus: 10000 });
    expect(normal).toBeGreaterThan(0);
    expect(withBonus).toBeGreaterThan(normal);
  });

  it('EPF relief cap RM4,000 respected — excess EPF gives no extra relief', () => {
    // Once YTD EPF hits the cap, adding more must not change PCB.
    const atCap = calcPCB(3000, { ...ytd0, epf: PCB_RELIEFS.epfCap }, single);
    const overCap = calcPCB(3000, { ...ytd0, epf: 99999 }, single);
    expect(overCap).toBe(atCap);
    // Below the cap, more EPF relief means strictly less (or equal) PCB.
    const noEpf = calcPCB(3000, ytd0, single);
    expect(atCap).toBeLessThanOrEqual(noEpf);
  });

  it('children and spouse reliefs reduce PCB', () => {
    const base = calcPCB(6000, ytd0, { marital: 'single', children: 0, monthIndex: 1 });
    const family = calcPCB(6000, ytd0, { marital: 'married', children: 3, monthIndex: 1 });
    expect(family).toBeLessThan(base);
  });

  it('YTD PCB already paid reduces the remaining-month charge', () => {
    // Identical annual projection; only the PCB already deducted differs.
    const ytdBase = { gross: 30000, epf: 3300, socso: 150, pcb: 0 };
    const none = calcPCB(6000, ytdBase, { ...single, monthIndex: 6 });
    const paid = calcPCB(6000, { ...ytdBase, pcb: 1200 }, { ...single, monthIndex: 6 });
    expect(none).toBeGreaterThan(0);
    expect(paid).toBeLessThan(none);
  });
});

describe('annualTax — YA2025 brackets + RM400 rebate ≤ RM35,000', () => {
  it('first RM20,000 band: 1% on the excess over RM5,000, then rebate', () => {
    // CI 20,000 → tax 150 → rebate → 0
    expect(annualTax(20000)).toBe(0);
    // CI 36,000 → 600 + 1,000×0.06 = 660, no rebate (>35,000)
    expect(annualTax(36000)).toBe(660);
  });

  it('monotonic across bracket boundaries', () => {
    let prev = 0;
    for (const ci of [5000, 20000, 35000, 50000, 70000, 100000, 400000, 600000]) {
      const t = annualTax(ci + 1);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});
