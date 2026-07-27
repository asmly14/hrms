/**
 * Malaysian statutory computations, 2025/2026.
 * Module agents MUST call these functions — never hardcode rates in pages.
 *
 * Primary sources (see docs/research/statutory-rates.md for the full log):
 *  - EPF Act 1991 (Act 452), Third Schedule; EPF (Amendment) Act 2025
 *  - Employees' Social Security Act 1969 (Act 4), Third Schedule (ceiling RM6,000 from 1 Oct 2024)
 *  - Employment Insurance System Act 2017 (Act 800), Second Schedule
 *  - PSMB Act 2001 (HRD Corp levy)
 *  - Income Tax Act 1967 s.83 + ITA (Deduction from Remuneration) Rules — LHDN computerized PCB spec, YA2025 brackets
 *  - Employment Act 1955 s.60A/60D + Employment (Limitation of Overtime Work) Regulations 1980
 *  - Minimum Wages Order 2024
 */

import { round2 } from './utils';

// Source: Minimum Wages Order 2024 — RM1,700/month from 1 Feb 2025 (≥5 employees) / 1 Aug 2025 (all).
export const MINIMUM_WAGE = 1700;
// Source: Employment (Amendment of First Schedule) Order 2022 — OT/rest-day/PH-pay provisions
// apply up to RM4,000/month (manual workers etc. always covered).
export const OT_SALARY_THRESHOLD = 4000;
// Source: Employment (Limitation of Overtime Work) Regulations 1980, reg. 2.
export const MAX_OT_HOURS_MONTH = 104;
// Source: PERKESO — SOCSO & EIS wage ceiling RM6,000/month from 1 Oct 2024.
export const SOCSO_CEILING = 6000;
export const EIS_CEILING = 6000;
// Source: EPF Third Schedule applies to wages below RM20,000/month; exact percentages above.
const EPF_TABLE_LIMIT = 20000;

// ─────────────────────────────────────────────────────────────────────────────
// EPF / KWSP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Third-Schedule banded lookup: wages < RM20,000 are snapped UP to the next
 * RM20 band ceiling, the rate is applied to the band ceiling, and the result
 * is rounded UP to the next ringgit (no cents in the Third Schedule).
 * Source: EPF Act 1991 Third Schedule rounding rule ("rounded up to the next ringgit").
 */
function epfBanded(wages: number, rate: number): number {
  if (wages <= 0) return 0;
  if (wages >= EPF_TABLE_LIMIT) return Math.ceil(wages * rate);
  const bandCeiling = Math.ceil(wages / 20) * 20;
  return Math.ceil(bandCeiling * rate - 1e-9);
}

export interface EPFResult {
  employee: number;
  employer: number;
}

/**
 * EPF contribution.
 *  - Malaysian/PR, age < 60: employee 11%; employer 13% (wages ≤ RM5,000) / 12% (> RM5,000).
 *  - Age 60–75 (citizen): employee 0%, employer 4% (Third Schedule s.E).
 *  - Age ≥ 75: nil.
 *  - Foreign workers: 2% + 2%, mandatory from 1 Oct 2025 (EPF (Amendment) Act 2025).
 * `wagesRM` = EPF-able wages (basic + fixed allowances; OT excluded, bonus computed separately).
 */
export function calcEPF(
  wagesRM: number,
  age: number,
  citizen: boolean,
  isForeignWorker: boolean,
): EPFResult {
  if (wagesRM <= 0) return { employee: 0, employer: 0 };
  if (isForeignWorker) {
    // Source: EPF (Amendment) Act 2025 — foreign employees 2%/2% mandatory from 1 Oct 2025.
    return { employee: epfBanded(wagesRM, 0.02), employer: epfBanded(wagesRM, 0.02) };
  }
  if (age >= 75) return { employee: 0, employer: 0 };
  if (age >= 60) {
    // Source: Third Schedule s.E — Malaysian citizens 60+: employee 0%, employer 4%.
    // (PR/pre-1998 non-citizen 60+ reduced 5.5%/6–6.5% handled by passing citizen=false below.)
    if (citizen) return { employee: 0, employer: epfBanded(wagesRM, 0.04) };
    const er = wagesRM > 5000 ? 0.06 : 0.065;
    return { employee: epfBanded(wagesRM, 0.055), employer: epfBanded(wagesRM, er) };
  }
  // Source: Third Schedule s.A — 11% employee; employer 13% ≤RM5,000, 12% >RM5,000.
  const employerRate = wagesRM > 5000 ? 0.12 : 0.13;
  return { employee: epfBanded(wagesRM, 0.11), employer: epfBanded(wagesRM, employerRate) };
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCSO / PERKESO (Act 4)
// ─────────────────────────────────────────────────────────────────────────────

/** Nearest 5 sen, half-up — the rounding grid of the Act 4 Third Schedule. */
function round5sen(n: number): number {
  return Math.round((n + 1e-9) / 0.05) * 0.05;
}

/**
 * Act 4 Third Schedule banded base: RM100 bands, contribution computed on the
 * band midpoint; wages ≥ RM5,900 use the RM5,900–6,000 band (base RM5,950,
 * giving the published maxima employer RM104.15 / employee RM29.75 / cat-2 RM74.40).
 */
function socsoBandBase(wages: number): number {
  if (wages <= 0) return 0;
  if (wages >= 5950) return 5950; // ceiling band
  const lower = Math.floor((wages - 1e-9) / 100) * 100;
  return lower + 50;
}

export interface SOCSOResult {
  employee: number;
  employer: number;
  category: 1 | 2;
}

/**
 * SOCSO contribution.
 *  - Category 1 (age < 60): employer 1.75% + employee 0.5% (Employment Injury + Invalidity).
 *  - Category 2 (age ≥ 60): employer-only 1.25% (Employment Injury only).
 *  - Wage ceiling RM6,000 (from 1 Oct 2024); foreign workers covered since 1 Jul 2024.
 * Source: Act 4 Third Schedule; PERKESO rate-of-contribution notice 2024.
 */
export function calcSOCSO(wagesRM: number, age: number): SOCSOResult {
  if (wagesRM <= 0) return { employee: 0, employer: 0, category: age >= 60 ? 2 : 1 };
  const base = socsoBandBase(Math.min(wagesRM, SOCSO_CEILING));
  if (age >= 60) {
    // Source: Act 4 Second Category — employer-only 1.25%.
    return { employee: 0, employer: round2(round5sen(base * 0.0125)), category: 2 };
  }
  return {
    employee: round2(round5sen(base * 0.005)),
    employer: round2(round5sen(base * 0.0175)),
    category: 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EIS / SIP (Act 800)
// ─────────────────────────────────────────────────────────────────────────────

export interface EISResult {
  employee: number;
  employer: number;
}

/**
 * EIS contribution: 0.2% + 0.2%, same RM100-band table as SOCSO, ceiling RM6,000
 * (max RM11.90 each side). Coverage: Malaysian citizens & PRs aged 18–60 only;
 * foreign workers and employees ≥ 60 are exempt.
 * Source: Act 800 s.18 + Second Schedule; PERKESO.
 */
export function calcEIS(wagesRM: number, age: number, citizen: boolean): EISResult {
  if (wagesRM < 30 || !citizen || age < 18 || age >= 60) return { employee: 0, employer: 0 };
  const base = socsoBandBase(Math.min(wagesRM, EIS_CEILING));
  return {
    employee: round2(round5sen(base * 0.002)),
    employer: round2(round5sen(base * 0.002)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HRD Corp levy (PSMB Act 2001)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HRD levy on (basic + fixed allowances) — OT, bonus, commission excluded.
 * 1% when the employer has ≥ 10 Malaysian employees (mandatory),
 * 0.5% for 5–9 (opt-in), 0 below 5. Employer-only; no wage ceiling.
 * Source: PSMB Act 2001 ss.2, 14; HRD Corp Levy Calculation Guideline.
 */
export function hrdfLevy(monthlyWages: number, numLocalEmployees: number): number {
  if (monthlyWages <= 0) return 0;
  const rate = numLocalEmployees >= 10 ? 0.01 : numLocalEmployees >= 5 ? 0.005 : 0;
  return round2(monthlyWages * rate);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overtime (EA 1955)
// ─────────────────────────────────────────────────────────────────────────────

/** Ordinary rate of pay: monthly wages ÷ 26. Source: EA 1955 s.60I(a). */
export function orpFromMonthly(monthlyWages: number): number {
  return monthlyWages / 26;
}

/** Hourly rate of pay: ORP ÷ 8 normal hours. Source: EA 1955 s.60A(3). */
export function hourlyFromMonthly(monthlyWages: number): number {
  return orpFromMonthly(monthlyWages) / 8;
}

/**
 * OT payment.
 *  normal  → 1.5 × HRP (EA s.60A(3)(a))
 *  rest    → 2.0 × HRP for hours beyond normal (EA s.60(3)(c))
 *  holiday → 3.0 × HRP for hours beyond normal (EA s.60D(3)(b))
 * `hourlyRate` = hourlyFromMonthly(baseSalary). Eligibility (≤ RM4,000 or
 * always-covered categories) is enforced by callers against OT_SALARY_THRESHOLD.
 */
export function calcOT(hourlyRate: number, hours: number, dayType: 'normal' | 'rest' | 'holiday'): number {
  const mult = dayType === 'holiday' ? 3 : dayType === 'rest' ? 2 : 1.5;
  return round2(hourlyRate * hours * mult);
}

// ─────────────────────────────────────────────────────────────────────────────
// PCB / MTD (LHDN computerized calculation, YA2025)
// ─────────────────────────────────────────────────────────────────────────────

// Source: YA2025/YA2026 resident individual brackets (unchanged) — PwC Tax Summaries; LHDN.
const TAX_BRACKETS: { upTo: number; base: number; rate: number }[] = [
  { upTo: 5000, base: 0, rate: 0 },
  { upTo: 20000, base: 0, rate: 0.01 },
  { upTo: 35000, base: 150, rate: 0.03 },
  { upTo: 50000, base: 600, rate: 0.06 },
  { upTo: 70000, base: 1500, rate: 0.11 },
  { upTo: 100000, base: 3700, rate: 0.19 },
  { upTo: 400000, base: 9400, rate: 0.25 },
  { upTo: 600000, base: 84400, rate: 0.26 },
  { upTo: 2000000, base: 136400, rate: 0.28 },
  { upTo: Infinity, base: 528400, rate: 0.3 },
];

/** Annual resident tax on chargeable income, incl. RM400 rebate ≤ RM35,000. */
export function annualTax(chargeableIncome: number): number {
  const ci = Math.max(0, chargeableIncome);
  let tax = 0;
  let lower = 0;
  for (const b of TAX_BRACKETS) {
    if (ci <= b.upTo) {
      tax = b.base + (ci - lower) * b.rate;
      break;
    }
    lower = b.upTo;
  }
  // Source: ITA s.6A rebate — RM400 individual rebate when chargeable income ≤ RM35,000.
  if (ci <= 35000) tax = Math.max(0, tax - 400);
  return tax;
}

export const PCB_RELIEFS = {
  self: 9000,        // Source: YA2025 personal relief
  spouse: 4000,      // Source: YA2025 spouse relief (spouse with no income)
  child: 2000,       // Source: YA2025 per child below 18
  epfCap: 4000,      // Source: YA2025 EPF relief cap
  socsoCap: 350,     // Source: YA2025 SOCSO+EIS relief cap
} as const;

export interface PCBYearToDate {
  gross: number;  // YTD normal remuneration (months BEFORE the current month)
  epf: number;    // YTD employee EPF on normal remuneration
  socso: number;  // YTD employee SOCSO+EIS
  pcb: number;    // YTD PCB already deducted
}

export interface PCBOptions {
  marital: 'single' | 'married' | 'divorced' | 'widowed';
  children: number;
  monthIndex: number; // 1–12, the month being computed
  bonus?: number;     // additional remuneration paid THIS month (bonus/commission/arrears)
  /** Actual current-month employee EPF/SOCSO if known; estimated at 11%/0.5% otherwise. */
  epfEmployee?: number;
  socsoEmployee?: number;
}

/**
 * Monthly PCB via the LHDN computerized (annualized) method.
 *
 * Normal remuneration (per LHDN spec):
 *   P = [(Y − K) × n] + (Y1 − K1) + (Yt − Kt) − reliefs
 * where Y = current month gross, K = current EPF, n = months remaining incl.
 * current, Y1/K1 = YTD remuneration/EPF. EPF relief capped at RM4,000/yr,
 * SOCSO+EIS relief at RM350/yr. Annual tax → less PCB already deducted →
 * divided by remaining months.
 *
 * Additional remuneration (bonus): taxed via the aggregate delta —
 *   bonusPCB = Tax(P + bonus − bonusEpfWithinCap) − Tax(P)
 * added in full in the payment month (causing the normal LHDN PCB spike).
 * Source: LHDN Specification for MTD Computerised Calculation; ITA (Deduction
 * from Remuneration) Rules 1994.
 */
export function calcPCB(monthlyGross: number, ytd: PCBYearToDate, opts: PCBOptions): number {
  const n = Math.max(1, 13 - opts.monthIndex);
  const curEpf = opts.epfEmployee ?? round2(monthlyGross * 0.11);
  const curSocso = opts.socsoEmployee ?? round2(monthlyGross * 0.005);

  const socsoRelief = Math.min(ytd.socso + curSocso * n, PCB_RELIEFS.socsoCap);
  const personal =
    PCB_RELIEFS.self +
    (opts.marital === 'married' ? PCB_RELIEFS.spouse : 0) +
    Math.max(0, opts.children) * PCB_RELIEFS.child;

  // Step 1 — annual tax on NORMAL remuneration alone (LHDN category A).
  const annualGrossNormal = ytd.gross + monthlyGross * n;
  const epfReliefNormal = Math.min(ytd.epf + curEpf * n, PCB_RELIEFS.epfCap);
  const chargeableNormal = Math.max(0, annualGrossNormal - epfReliefNormal - socsoRelief - personal);
  const taxNormalAnnual = annualTax(chargeableNormal);

  // Step 2 — with the bonus added (aggregate method); delta = bonus PCB.
  const bonus = opts.bonus ?? 0;
  const bonusEpf = bonus > 0 ? round2(bonus * 0.11) : 0;
  const epfReliefTotal = Math.min(ytd.epf + curEpf * n + bonusEpf, PCB_RELIEFS.epfCap);
  const chargeableTotal = Math.max(0, annualGrossNormal + bonus - epfReliefTotal - socsoRelief - personal);
  const bonusPCB = bonus > 0 ? Math.max(0, annualTax(chargeableTotal) - taxNormalAnnual) : 0;

  const monthlyNormal = Math.max(0, (taxNormalAnnual - ytd.pcb) / n);
  return round2(monthlyNormal + bonusPCB);
}
