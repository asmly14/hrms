/**
 * Salary benchmarking — Malaysian salary market data 2025–2026.
 *
 * Researched dataset: 62 roles across 13 industries, banded by seniority
 * (0–2, 3–5, 6–10, 10+ years), Klang-Valley baseline (RM/month gross basic,
 * excludes bonuses/commissions/employer statutory).
 * Sources: docs/research/salary-market.md (Robert Walters Salary Survey 2025,
 * FastLaneRecruit 2025-07, DOSM Salaries & Wages 2024, AJobThing aggregates)
 * and docs/research/cost-of-living.md (Numbeo 2026-07, EPF Belanjawanku
 * 2024/25, DOSM Household Income Survey 2024).
 *
 * Figures are indicative market medians for budgeting/benchmarking — not a
 * paid salary survey. Re-anchor annually (recruitment guides refresh Jan–Mar;
 * DOSM publishes ~Sep/Oct).
 *
 * Backward-compatible API (Wave 1): BENCHMARKS, suggestSalary, stateFactor,
 * bandForYears — the employees module imports these. Wave 2 additions:
 * industry/role listings, job profiles + demand, cost-of-living table,
 * COL-adjusted salaries, DOSM income classification, state deciles.
 */

import type { StateCode } from './types';
import { round2 } from './utils';

export type SeniorityBand = '0-2' | '3-5' | '6-10' | '10+';

/** Coarse demand signal derived from the researched demand-trend text. */
export type DemandLevel =
  | 'very-high'
  | 'high'
  | 'moderate-high'
  | 'stable-high'
  | 'stable'
  | 'moderate'
  | 'high-volume';

export interface BenchmarkBand {
  min: number;
  median: number;
  max: number;
}

export interface BenchmarkRow {
  role: string;
  aliases: string[];
  /**
   * Legacy app-department mapping (Engineering / Human Resources / Finance /
   * Sales & Marketing / Operations / Customer Support). Kept so the
   * department fallback in suggestSalary keeps working for seeded data.
   */
  department: string;
  /** Researched industry section (salary-market.md §3–§15). */
  industry: string;
  jobDescription: string;
  qualifications: string;
  /** Researched 2025–2026 hiring commentary. */
  demandTrend: string;
  demandLevel: DemandLevel;
  /** True when commissions/allowances materially top up base (retail, sales, O&G offshore). */
  variablePay?: boolean;
  /** RM/month base ranges by seniority band, Klang-Valley baseline. */
  bands: Record<SeniorityBand, BenchmarkBand>;
}

// ── Industry names (13) ─────────────────────────────────────────────────────
const TECH = 'Technology';
const FIN = 'Finance & Banking';
const MFG = 'Manufacturing';
const RETAIL = 'Retail & FMCG';
const HEALTH = 'Healthcare';
const CONSTRUCTION = 'Construction & Engineering';
const LOGISTICS = 'Logistics & Supply Chain';
const HOSPITALITY = 'Hospitality & F&B';
const OGE = 'Oil, Gas & Energy';
const SSC = 'Shared Services / BPO';
const EDU = 'Education';
const PROF = 'Professional Services';
const CORP = 'Corporate Functions (Cross-Industry)';

// ── Legacy app departments (for the department fallback) ────────────────────
const DEPT_ENG = 'Engineering';
const DEPT_HR = 'Human Resources';
const DEPT_FIN = 'Finance';
const DEPT_SM = 'Sales & Marketing';
const DEPT_OPS = 'Operations';
const DEPT_CS = 'Customer Support';

export const BENCHMARKS: BenchmarkRow[] = [
  // ── §3 Technology ────────────────────────────────────────────────────────
  {
    role: 'Software Engineer',
    aliases: ['developer', 'programmer', 'software developer', 'backend', 'frontend', 'web developer'],
    department: DEPT_ENG,
    industry: TECH,
    jobDescription:
      'Designs, builds and maintains web, mobile or backend applications; writes tested, reviewed production code and participates in agile delivery. Works with product and QA to ship features and fix defects.',
    qualifications:
      'BSc Computer Science/Software Engineering or equivalent; portfolio or internship experience; stack-specific skills (e.g. Java, .NET, Node, React).',
    demandTrend:
      'Very high — digital banks, e-commerce and AI adoption keep demand above supply, especially mid-senior.',
    demandLevel: 'very-high',
    bands: {
      '0-2': { min: 3500, median: 4500, max: 5500 },
      '3-5': { min: 5500, median: 7000, max: 9000 },
      '6-10': { min: 8500, median: 11000, max: 14000 },
      '10+': { min: 13000, median: 16000, max: 20000 },
    },
  },
  {
    role: 'Full-Stack / Senior Developer',
    aliases: ['full stack', 'full-stack', 'full stack developer', 'senior developer'],
    department: DEPT_ENG,
    industry: TECH,
    jobDescription:
      'Owns end-to-end feature delivery across frontend and backend services, mentors juniors and reviews architecture. Expected to handle system design, performance and deployment pipelines.',
    qualifications:
      '4+ yrs production experience; deep JS/TS + a backend stack; CI/CD and cloud (AWS/Azure/GCP) exposure.',
    demandTrend:
      'Very high — full-stack versatility commands a premium; RW 2025 range RM120–216k/yr.',
    demandLevel: 'very-high',
    bands: {
      '0-2': { min: 4000, median: 5000, max: 6500 },
      '3-5': { min: 6000, median: 8000, max: 10000 },
      '6-10': { min: 9000, median: 12000, max: 15000 },
      '10+': { min: 14000, median: 17000, max: 21000 },
    },
  },
  {
    role: 'Data Scientist',
    aliases: ['data scientist', 'data analyst', 'business analyst', 'bi analyst', 'machine learning', 'ml engineer'],
    department: DEPT_ENG,
    industry: TECH,
    jobDescription:
      'Builds statistical/ML models for forecasting, recommendation and automation; translates business questions into data experiments. Presents findings to stakeholders and productionises models with engineers.',
    qualifications:
      'BSc/MSc in quantitative field; Python, SQL, ML frameworks; domain knowledge a plus.',
    demandTrend:
      'Very high — AI/ML and data roles saw the fastest salary growth; RW 2025 RM144–240k/yr.',
    demandLevel: 'very-high',
    bands: {
      '0-2': { min: 4500, median: 5500, max: 7000 },
      '3-5': { min: 6500, median: 8500, max: 11000 },
      '6-10': { min: 10000, median: 13000, max: 16000 },
      '10+': { min: 15000, median: 18000, max: 22000 },
    },
  },
  {
    role: 'DevOps / Cloud Engineer',
    aliases: ['devops', 'cloud engineer', 'sre', 'site reliability', 'platform engineer'],
    department: DEPT_ENG,
    industry: TECH,
    jobDescription:
      'Automates infrastructure, CI/CD pipelines, observability and reliability of cloud workloads. Manages containers, IaC and incident response.',
    qualifications:
      'CS/IT degree; AWS/Azure/GCP certs (e.g. CKA, AWS SA); Terraform/Kubernetes experience.',
    demandTrend:
      'High — cloud migration and platform engineering keep demand strong; fastest-growing ops niche.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 4500, median: 5500, max: 7000 },
      '3-5': { min: 6500, median: 8000, max: 10500 },
      '6-10': { min: 9000, median: 11500, max: 14500 },
      '10+': { min: 13500, median: 16500, max: 20000 },
    },
  },
  {
    role: 'Cybersecurity Analyst',
    aliases: ['cybersecurity', 'security analyst', 'infosec', 'soc analyst', 'penetration tester'],
    department: DEPT_ENG,
    industry: TECH,
    jobDescription:
      'Monitors, detects and responds to security incidents; runs vulnerability assessments and supports compliance (ISO 27001, BNM RMiT). Senior paths lead to pen-testing or security architecture.',
    qualifications:
      'CS/IT/Security degree; CompTIA Security+/CEH; SOC or networking background.',
    demandTrend:
      'High — BNM regulations and rising breach costs drive hiring; senior pen-testers reach RM14–22k/mo.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3800, median: 4500, max: 5500 },
      '3-5': { min: 5500, median: 7000, max: 9000 },
      '6-10': { min: 8000, median: 10500, max: 14000 },
      '10+': { min: 13000, median: 16000, max: 22000 },
    },
  },
  {
    role: 'UI/UX Designer',
    aliases: ['ui ux', 'ux designer', 'ui designer', 'product designer'],
    department: DEPT_ENG,
    industry: TECH,
    jobDescription:
      'Researches users, designs interfaces and design systems, and validates with usability testing. Partners with PMs and engineers through delivery.',
    qualifications: 'Design/HCI degree or bootcamp + portfolio; Figma proficiency; research methods.',
    demandTrend: 'Moderate-high — steady demand in product companies; RW 2025 RM96–156k/yr.',
    demandLevel: 'moderate-high',
    bands: {
      '0-2': { min: 3200, median: 4000, max: 5000 },
      '3-5': { min: 4800, median: 6000, max: 7500 },
      '6-10': { min: 7000, median: 9000, max: 12000 },
      '10+': { min: 10000, median: 13000, max: 16000 },
    },
  },
  {
    role: 'IT Project Manager',
    aliases: ['project manager', 'it project manager', 'pm', 'delivery manager', 'scrum master'],
    department: DEPT_ENG,
    industry: TECH,
    jobDescription:
      'Plans and delivers software/infra projects on scope, budget and timeline; manages vendors, risks and stakeholder communication. Often runs hybrid agile-waterfall governance.',
    qualifications: 'Degree + PMP/PRINCE2/Scrum certs; 5+ yrs delivery experience.',
    demandTrend: 'High — transformation programmes across banking and GLCs sustain demand.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 5000, median: 6000, max: 7500 },
      '3-5': { min: 7500, median: 9500, max: 12000 },
      '6-10': { min: 10000, median: 13000, max: 16000 },
      '10+': { min: 15000, median: 18000, max: 24000 },
    },
  },

  // ── §4 Finance & Banking ─────────────────────────────────────────────────
  {
    role: 'Accountant (GL/Financial)',
    aliases: ['accountant', 'accounts', 'finance executive', 'gl accountant', 'financial accountant'],
    department: DEPT_FIN,
    industry: FIN,
    jobDescription:
      'Owns general ledger, month-end close, management accounts and statutory reporting (MFRS). Supervises juniors and liaises with auditors and tax agents.',
    qualifications: 'Degree + professional qualification progress (ACCA/CPA/MIA); 2–5 yrs for senior grade.',
    demandTrend: 'High — qualified accountants (MIA-eligible) remain scarce; RW 2025 RM84–120k/yr.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3000, median: 3600, max: 4500 },
      '3-5': { min: 4500, median: 5500, max: 7000 },
      '6-10': { min: 6500, median: 8000, max: 10000 },
      '10+': { min: 9500, median: 12000, max: 15000 },
    },
  },
  {
    role: 'Accounts Executive',
    aliases: ['accounts executive', 'account executive', 'accounts assistant', 'ap ar'],
    department: DEPT_FIN,
    industry: FIN,
    jobDescription:
      'Handles day-to-day AP/AR, reconciliations, invoicing and month-end close support. Prepares schedules for audit and tax filings.',
    qualifications: 'Diploma/Degree in Accounting; LCCI acceptable at junior level; Excel and ERP (SAP/SQL/Oracle) skills.',
    demandTrend: 'Stable — perennial volume hiring; automation shifts mix toward review work. RW 2025 RM48–72k/yr.',
    demandLevel: 'stable',
    bands: {
      '0-2': { min: 2800, median: 3300, max: 4000 },
      '3-5': { min: 3800, median: 4800, max: 6000 },
      '6-10': { min: 5500, median: 6800, max: 8500 },
      '10+': { min: 7500, median: 9500, max: 12000 },
    },
  },
  {
    role: 'FP&A / Financial Analyst',
    aliases: ['fp&a', 'financial analyst', 'finance analyst', 'budget analyst'],
    department: DEPT_FIN,
    industry: FIN,
    jobDescription:
      'Builds budgets, forecasts and variance analysis; partners with business units on performance and investment cases. Produces dashboards and board packs.',
    qualifications: 'Finance/Accounting degree; CFA/ACCA an advantage; strong Excel/BI (Power BI, SQL).',
    demandTrend: 'High — FP&A managers among "top roles in demand" per 2025 guides.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3200, median: 3800, max: 4800 },
      '3-5': { min: 5000, median: 6500, max: 8500 },
      '6-10': { min: 7500, median: 9500, max: 12500 },
      '10+': { min: 11000, median: 14000, max: 18000 },
    },
  },
  {
    role: 'Internal Auditor',
    aliases: ['internal auditor', 'internal audit', 'auditor'],
    department: DEPT_FIN,
    industry: FIN,
    jobDescription:
      'Executes risk-based audits of processes, controls and compliance; drafts findings and tracks remediation. Increasingly covers IT and data-analytics audit.',
    qualifications: 'Accounting/Finance degree; CIA/ACCA; Big 4 background preferred for seniors.',
    demandTrend: 'Stable-high — governance push in GLCs and listed cos; RW 2025 RM60–96k/yr.',
    demandLevel: 'stable-high',
    bands: {
      '0-2': { min: 3000, median: 3500, max: 4200 },
      '3-5': { min: 4500, median: 5800, max: 7500 },
      '6-10': { min: 7000, median: 8800, max: 11500 },
      '10+': { min: 10000, median: 13000, max: 17000 },
    },
  },
  {
    role: 'Risk & Compliance Manager',
    aliases: ['risk', 'compliance', 'aml', 'regulatory'],
    department: DEPT_FIN,
    industry: FIN,
    jobDescription:
      'Designs and runs enterprise risk frameworks, regulatory compliance (BNM, SC, AMLA) and internal controls. Advises business on new-product risk.',
    qualifications: 'Degree + FRM/CAMCO/ICA certs; banking or fintech regulatory exposure.',
    demandTrend: 'High — digital bank licensing and AML scrutiny sustain demand.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3800, median: 4500, max: 5500 },
      '3-5': { min: 6000, median: 7500, max: 9500 },
      '6-10': { min: 8500, median: 10500, max: 13500 },
      '10+': { min: 12000, median: 15000, max: 20000 },
    },
  },
  {
    role: 'Finance Manager',
    aliases: ['finance manager', 'financial controller', 'head of finance', 'finance lead'],
    department: DEPT_FIN,
    industry: FIN,
    jobDescription:
      'Leads the finance function: reporting, treasury, tax, budgeting and team management. Business-partners with leadership on strategy and funding.',
    qualifications: 'ACCA/CPA/MIA fully qualified; 6–10+ yrs incl. supervisory experience.',
    demandTrend: 'High — RW 2025 RM144–192k/yr; Financial Controllers in demand (MNC RM180k+).',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 4000, median: 4800, max: 6000 },
      '3-5': { min: 6500, median: 8000, max: 10000 },
      '6-10': { min: 9500, median: 12000, max: 15000 },
      '10+': { min: 14000, median: 17000, max: 22000 },
    },
  },

  // ── §5 Manufacturing ─────────────────────────────────────────────────────
  {
    role: 'Production Operator',
    aliases: ['production operator', 'operator', 'machine operator', 'assembly'],
    department: DEPT_OPS,
    industry: MFG,
    jobDescription:
      'Runs machinery and assembly lines, performs in-process checks and records output. Follows SOPs, 5S and safety rules on shift.',
    qualifications: 'SPM/vocational certificate; on-the-job training; E&E plants may require cleanroom discipline.',
    demandTrend: 'Stable — Penang/Kulim E&E cluster hiring; minimum-wage floor lifted base pay.',
    demandLevel: 'stable',
    bands: {
      '0-2': { min: 1700, median: 1900, max: 2200 },
      '3-5': { min: 2200, median: 2500, max: 3000 },
      '6-10': { min: 2800, median: 3200, max: 3800 },
      '10+': { min: 3500, median: 4000, max: 4800 },
    },
  },
  {
    role: 'QA/QC Technician',
    aliases: ['qa', 'qc', 'quality', 'quality control', 'quality assurance', 'quality inspector'],
    department: DEPT_OPS,
    industry: MFG,
    jobDescription:
      'Inspects incoming, in-process and outgoing product against specs; maintains quality records and supports NCR/CAPA investigations.',
    qualifications: 'Diploma in engineering/science; SPC tools; ISO 9001 awareness.',
    demandTrend: 'High in E&E — semiconductor MNCs (Intel, Micron, AMD) compete for QC talent.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2200, median: 2600, max: 3200 },
      '3-5': { min: 3000, median: 3600, max: 4500 },
      '6-10': { min: 4200, median: 5000, max: 6000 },
      '10+': { min: 5500, median: 6500, max: 8000 },
    },
  },
  {
    role: 'Production Supervisor',
    aliases: ['production supervisor', 'line supervisor', 'shift supervisor'],
    department: DEPT_OPS,
    industry: MFG,
    jobDescription:
      'Leads a shift team to hit output, quality and safety targets; handles line staffing, training and escalation. Bridges operators and management.',
    qualifications: 'Diploma + 3–6 yrs line experience; leadership and basic lean knowledge.',
    demandTrend: 'Stable-high — supervisory layer is a known pinch point in Penang/Johor plants.',
    demandLevel: 'stable-high',
    bands: {
      '0-2': { min: 2800, median: 3200, max: 3800 },
      '3-5': { min: 3800, median: 4500, max: 5500 },
      '6-10': { min: 5000, median: 6000, max: 7500 },
      '10+': { min: 6500, median: 8000, max: 10000 },
    },
  },
  {
    role: 'Process/Manufacturing Engineer',
    aliases: ['process engineer', 'manufacturing engineer', 'industrial engineer', 'production engineer'],
    department: DEPT_OPS,
    industry: MFG,
    jobDescription:
      'Improves yield, cycle time and cost via process design, SPC and lean/Six Sigma projects. Qualifies new equipment and products into production.',
    qualifications: 'BEng (mechanical/electrical/chemical/industrial); Six Sigma Green Belt a plus.',
    demandTrend: 'High — automation and Industry 4.0 retrofitting drive engineer demand.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3000, median: 3500, max: 4200 },
      '3-5': { min: 4200, median: 5200, max: 6500 },
      '6-10': { min: 6000, median: 7500, max: 9500 },
      '10+': { min: 8500, median: 11000, max: 14000 },
    },
  },
  {
    role: 'Plant Manager',
    aliases: ['plant manager', 'operations manager', 'ops manager', 'factory manager'],
    department: DEPT_OPS,
    industry: MFG,
    jobDescription:
      'Accountable for the whole site: production, quality, safety, cost and people. Sets capacity plans and represents the plant to group HQ and customers.',
    qualifications:
      'Engineering degree + 8–15 yrs manufacturing; P&L exposure; MNC plants prefer English + Mandarin/Japanese.',
    demandTrend: 'High at senior end — RW 2025 production/plant managers RM192–306k/yr in MNCs.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 4500, median: 5500, max: 7000 },
      '3-5': { min: 7000, median: 8500, max: 11000 },
      '6-10': { min: 10000, median: 13000, max: 17000 },
      '10+': { min: 15000, median: 19000, max: 25000 },
    },
  },

  // ── §6 Retail & FMCG ─────────────────────────────────────────────────────
  {
    role: 'Retail Sales Associate',
    aliases: ['retail', 'sales associate', 'promoter', 'retail assistant'],
    department: DEPT_CS,
    industry: RETAIL,
    jobDescription:
      'Serves customers, restocks, merchandises and operates POS. Meets sales and conversion targets; commissions can materially top up base.',
    qualifications: 'SPM minimum; product training in-house; language skills valued.',
    demandTrend: 'High volume, high churn — floor pay anchored by RM1,700 minimum wage.',
    demandLevel: 'high-volume',
    variablePay: true,
    bands: {
      '0-2': { min: 1700, median: 1900, max: 2200 },
      '3-5': { min: 2100, median: 2400, max: 2900 },
      '6-10': { min: 2600, median: 3100, max: 3800 },
      '10+': { min: 3200, median: 3800, max: 4600 },
    },
  },
  {
    role: 'Store Supervisor',
    aliases: ['store supervisor', 'retail supervisor', 'outlet supervisor'],
    department: DEPT_CS,
    industry: RETAIL,
    jobDescription:
      'Runs a shift/section: staff rostering, cash control, stock counts and escalations. Deputises for the store manager.',
    qualifications: 'SPM/Diploma + 2–4 yrs retail floor experience.',
    demandTrend: 'Stable — chains expanding outside KV need shift leaders.',
    demandLevel: 'stable',
    variablePay: true,
    bands: {
      '0-2': { min: 2000, median: 2300, max: 2700 },
      '3-5': { min: 2600, median: 3100, max: 3800 },
      '6-10': { min: 3400, median: 4000, max: 5000 },
      '10+': { min: 4200, median: 5000, max: 6200 },
    },
  },
  {
    role: 'Retail Store Manager',
    aliases: ['store manager', 'retail manager', 'outlet manager'],
    department: DEPT_CS,
    industry: RETAIL,
    jobDescription:
      'Owns store P&L: sales targets, staffing, shrinkage, visual standards and local marketing. Reports to area/regional manager.',
    qualifications: 'Diploma/Degree + 4–8 yrs retail; KPI-driven; mall operations knowledge.',
    demandTrend: 'Stable — RM42–63.6k/yr typical range (AJobThing 2025).',
    demandLevel: 'stable',
    variablePay: true,
    bands: {
      '0-2': { min: 2500, median: 2900, max: 3500 },
      '3-5': { min: 3400, median: 4100, max: 5000 },
      '6-10': { min: 4600, median: 5600, max: 7000 },
      '10+': { min: 6000, median: 7500, max: 9500 },
    },
  },
  {
    role: 'Category / Buying Executive (FMCG)',
    aliases: ['category', 'buying', 'buyer', 'merchandiser'],
    department: DEPT_SM,
    industry: RETAIL,
    jobDescription:
      'Manages assortment, pricing, supplier negotiations and promotions for a category. Analyses sell-through and margin to plan ranges.',
    qualifications: 'Degree in business/marketing; strong Excel; 2+ yrs retail HQ or key-account exposure.',
    demandTrend: 'Moderate-high — grocery/pharmacy chains professionalising buying teams.',
    demandLevel: 'moderate-high',
    bands: {
      '0-2': { min: 3000, median: 3500, max: 4200 },
      '3-5': { min: 4500, median: 5500, max: 7000 },
      '6-10': { min: 6500, median: 8000, max: 10000 },
      '10+': { min: 9000, median: 11000, max: 14000 },
    },
  },
  {
    role: 'Brand Manager (FMCG)',
    aliases: ['brand manager', 'brand', 'product marketing'],
    department: DEPT_SM,
    industry: RETAIL,
    jobDescription:
      "Owns a brand's P&L and marketing mix: positioning, media, promotions and NPD launches. Works with agencies and trade teams on share growth.",
    qualifications: 'Marketing/business degree; 4–7 yrs FMCG brand or agency experience.',
    demandTrend: 'High — RW 2025 RM108–172k/yr; digital commerce skills command premium.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3500, median: 4200, max: 5200 },
      '3-5': { min: 5500, median: 7000, max: 9000 },
      '6-10': { min: 8000, median: 10000, max: 13000 },
      '10+': { min: 11000, median: 14000, max: 18000 },
    },
  },

  // ── §7 Healthcare ────────────────────────────────────────────────────────
  {
    role: 'Staff Nurse (RN)',
    aliases: ['nurse', 'staff nurse', 'registered nurse', 'nursing'],
    department: DEPT_OPS,
    industry: HEALTH,
    jobDescription:
      'Delivers direct patient care, medication administration and ward documentation under nursing standards. Rotates shifts and may specialise (ICU, OT, ED).',
    qualifications: 'Diploma/BSc Nursing + APC registration with Malaysian Nursing Board.',
    demandTrend: 'Very high — chronic shortage; private groups (IHH, KPJ) and Singapore poaching push wages up.',
    demandLevel: 'very-high',
    bands: {
      '0-2': { min: 2500, median: 2900, max: 3400 },
      '3-5': { min: 3200, median: 3800, max: 4600 },
      '6-10': { min: 4200, median: 5000, max: 6000 },
      '10+': { min: 5500, median: 6500, max: 8000 },
    },
  },
  {
    role: 'Pharmacist',
    aliases: ['pharmacist', 'pharmacy'],
    department: DEPT_OPS,
    industry: HEALTH,
    jobDescription:
      'Dispenses medication, counsels patients and manages pharmacy operations in hospital or retail settings. Ensures compliance with Poisons Act and MDA rules.',
    qualifications: 'BPharm + provisional registration (PRP) year; full registration with Pharmacy Board.',
    demandTrend: 'High — retail chains expanding; hospital clinical pharmacist roles growing.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3800, median: 4300, max: 5000 },
      '3-5': { min: 4800, median: 5600, max: 6500 },
      '6-10': { min: 6000, median: 7200, max: 8800 },
      '10+': { min: 8000, median: 9500, max: 12000 },
    },
  },
  {
    role: 'Medical Officer / GP',
    aliases: ['doctor', 'medical officer', 'gp', 'physician'],
    department: DEPT_OPS,
    industry: HEALTH,
    jobDescription:
      'Provides primary or hospital-based clinical care: diagnosis, treatment plans, referrals and procedures within scope. Public-sector MOs follow MOH UD scales; private GPs earn on consultation volume.',
    qualifications: 'MBBS/MD + housemanship + full MMC registration; CPD hours maintained.',
    demandTrend: 'High — private GP clinics and telehealth expanding; specialists RM12–25k+.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 4500, median: 5200, max: 6000 },
      '3-5': { min: 6000, median: 7000, max: 8500 },
      '6-10': { min: 8000, median: 9500, max: 12000 },
      '10+': { min: 11000, median: 14000, max: 18000 },
    },
  },
  {
    role: 'Medical Laboratory Technologist',
    aliases: ['lab technologist', 'medical lab', 'mlt', 'laboratory'],
    department: DEPT_OPS,
    industry: HEALTH,
    jobDescription:
      'Runs diagnostic tests (haematology, biochemistry, microbiology), maintains analysers and QC, and releases validated results to clinicians.',
    qualifications: 'Diploma/BSc Medical Laboratory Technology; MLTB registration.',
    demandTrend: 'Stable-high — post-pandemic lab capacity expansion sustained.',
    demandLevel: 'stable-high',
    bands: {
      '0-2': { min: 2400, median: 2800, max: 3300 },
      '3-5': { min: 3200, median: 3800, max: 4600 },
      '6-10': { min: 4300, median: 5200, max: 6300 },
      '10+': { min: 5600, median: 6800, max: 8300 },
    },
  },

  // ── §8 Construction & Engineering ────────────────────────────────────────
  {
    role: 'Site Supervisor',
    aliases: ['site supervisor', 'site agent', 'construction supervisor'],
    department: DEPT_OPS,
    industry: CONSTRUCTION,
    jobDescription:
      'Directs daily site work: trades coordination, progress tracking, safety (OSH/CIDB) compliance and material calls. Keeps site diaries and reports to the site agent.',
    qualifications: 'Certificate/Diploma in construction; CIDB green card; 2+ yrs site exposure.',
    demandTrend: 'Stable — infra pipeline (MRT3, flood mitigation) sustains site hiring.',
    demandLevel: 'stable',
    bands: {
      '0-2': { min: 2200, median: 2600, max: 3200 },
      '3-5': { min: 3000, median: 3600, max: 4500 },
      '6-10': { min: 4200, median: 5000, max: 6200 },
      '10+': { min: 5500, median: 6500, max: 8000 },
    },
  },
  {
    role: 'Civil Engineer',
    aliases: ['civil engineer', 'structural engineer', 'site engineer'],
    department: DEPT_ENG,
    industry: CONSTRUCTION,
    jobDescription:
      'Designs and delivers structural/infrastructure works, reviews drawings and method statements, and supervises quality on site. Progresses toward PE (Ir.) sign-off authority.',
    qualifications: 'BEng Civil; BEM graduate registration; PE after 3+ yrs supervised experience.',
    demandTrend: 'High — public infra and data-centre construction boom; RW 2025 RM96–138k/yr for experienced hires.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2800, median: 3300, max: 4000 },
      '3-5': { min: 4000, median: 4800, max: 6000 },
      '6-10': { min: 5800, median: 7000, max: 9000 },
      '10+': { min: 8000, median: 10000, max: 13000 },
    },
  },
  {
    role: 'Quantity Surveyor',
    aliases: ['quantity surveyor', 'qs', 'cost estimator'],
    department: DEPT_OPS,
    industry: CONSTRUCTION,
    jobDescription:
      'Measures and values works, prepares BOQs, tenders, interim claims and final accounts. Controls project cost and variation exposure.',
    qualifications: 'BSc Quantity Surveying; RICS/BQSM registration path.',
    demandTrend: 'High — cost-control focus in a tight-margin market keeps QS in demand.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2600, median: 3000, max: 3600 },
      '3-5': { min: 3600, median: 4400, max: 5500 },
      '6-10': { min: 5200, median: 6400, max: 8000 },
      '10+': { min: 7200, median: 9000, max: 12000 },
    },
  },
  {
    role: 'Construction Project Manager',
    aliases: ['construction manager', 'construction project manager'],
    department: DEPT_ENG,
    industry: CONSTRUCTION,
    jobDescription:
      'Leads whole-project delivery: programme, budget, contractors, consultants and authority approvals. Accountable for handover, defects and claims strategy.',
    qualifications: 'Engineering/construction degree + 7–12 yrs; PMP/CIOB an advantage.',
    demandTrend: 'High — AJobThing 2025 construction managers RM84–120k/yr; data-centre and industrial projects pay above band.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 4000, median: 4800, max: 5800 },
      '3-5': { min: 6000, median: 7500, max: 9500 },
      '6-10': { min: 8500, median: 11000, max: 14000 },
      '10+': { min: 12000, median: 15000, max: 19000 },
    },
  },

  // ── §9 Logistics & Supply Chain ──────────────────────────────────────────
  {
    role: 'Logistics / Shipping Coordinator',
    aliases: ['logistics', 'shipping coordinator', 'freight', 'customs', 'driver', 'dispatch', 'lorry driver'],
    department: DEPT_OPS,
    industry: LOGISTICS,
    jobDescription:
      'Books and tracks shipments, prepares customs documentation (K1/K2), and coordinates hauliers, forwarders and warehouses. Handles Incoterms and delivery exceptions.',
    qualifications: 'Diploma in logistics/supply chain or business; freight-forwarding exposure.',
    demandTrend: 'High — Port Klang/Penang trade volumes and e-commerce fulfilment growth; RW 2025 RM48–96k/yr.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2500, median: 2900, max: 3500 },
      '3-5': { min: 3500, median: 4300, max: 5500 },
      '6-10': { min: 5000, median: 6200, max: 8000 },
      '10+': { min: 7000, median: 8500, max: 11000 },
    },
  },
  {
    role: 'Warehouse Executive / Manager',
    aliases: ['warehouse', 'warehouse assistant', 'storekeeper', 'warehouse manager', 'inventory'],
    department: DEPT_OPS,
    industry: LOGISTICS,
    jobDescription:
      'Runs inbound/outbound operations, inventory accuracy, WMS and picking productivity. Managers own layout, manpower and safety for the DC.',
    qualifications: 'Diploma/Degree + WMS (SAP EWM, Manhattan) experience; forklift/MHE knowledge.',
    demandTrend: 'High — RW 2025 warehouse/inventory managers RM96–144k/yr; Johor and Shah Alam DC corridors hiring.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2600, median: 3000, max: 3600 },
      '3-5': { min: 3800, median: 4600, max: 5800 },
      '6-10': { min: 5500, median: 7000, max: 9000 },
      '10+': { min: 8000, median: 10000, max: 13000 },
    },
  },
  {
    role: 'Procurement Executive',
    aliases: ['procurement', 'purchasing', 'sourcing'],
    department: DEPT_OPS,
    industry: LOGISTICS,
    jobDescription:
      'Sources suppliers, issues POs, negotiates prices and terms, and tracks delivery and quality performance. Supports tenders and cost-saving initiatives.',
    qualifications: 'Degree in business/supply chain/engineering; CIPS a plus at senior level.',
    demandTrend: 'High — RW 2025 procurement officers RM60–108k/yr; localisation drives strategic sourcing roles.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2800, median: 3300, max: 4000 },
      '3-5': { min: 4200, median: 5200, max: 6500 },
      '6-10': { min: 6000, median: 7500, max: 9500 },
      '10+': { min: 8500, median: 10500, max: 13500 },
    },
  },
  {
    role: 'Supply Chain Manager',
    aliases: ['supply chain', 'scm', 'demand planner'],
    department: DEPT_OPS,
    industry: LOGISTICS,
    jobDescription:
      'Owns end-to-end planning: S&OP, inventory policy, logistics network and service levels. Leads planners, warehouse and procurement teams.',
    qualifications: 'Degree + 6–10 yrs supply chain; APICS/CPIM preferred.',
    demandTrend: 'High — RW 2025 RM120–204k/yr; demand planners and trade compliance named as hot roles.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 4000, median: 4800, max: 6000 },
      '3-5': { min: 6500, median: 8000, max: 10000 },
      '6-10': { min: 9500, median: 12000, max: 15000 },
      '10+': { min: 13000, median: 16000, max: 20000 },
    },
  },

  // ── §10 Hospitality & F&B ────────────────────────────────────────────────
  {
    role: 'Service Crew / Waitstaff',
    aliases: ['waiter', 'waitress', 'service crew', 'f&b', 'server'],
    department: DEPT_CS,
    industry: HOSPITALITY,
    jobDescription:
      'Takes orders, serves food and beverages, and maintains dining-area standards. Handles payments and guest requests during shifts.',
    qualifications: 'SPM; F&B hygiene certificate (typhoid vaccination) required.',
    demandTrend: 'High volume, high churn — tourism recovery (Visit Malaysia 2026) lifting demand; base at wage floor.',
    demandLevel: 'high-volume',
    variablePay: true,
    bands: {
      '0-2': { min: 1700, median: 1800, max: 2000 },
      '3-5': { min: 1900, median: 2100, max: 2400 },
      '6-10': { min: 2200, median: 2500, max: 3000 },
      '10+': { min: 2600, median: 3000, max: 3600 },
    },
  },
  {
    role: 'Chef de Partie / Chef',
    aliases: ['chef', 'cook', 'kitchen'],
    department: DEPT_CS,
    industry: HOSPITALITY,
    jobDescription:
      'Runs a kitchen section (grill, wok, pastry), preps to recipe standards and controls food cost and wastage. Senior chefs design menus and manage the brigade.',
    qualifications: "Culinary diploma (e.g. KDU, Taylor's) or apprenticeship; 2–6 yrs kitchen experience.",
    demandTrend: 'High — chef shortage is structural; head/executive chefs reach RM5–8.5k+.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 1800, median: 2100, max: 2500 },
      '3-5': { min: 2500, median: 3000, max: 3800 },
      '6-10': { min: 3500, median: 4300, max: 5500 },
      '10+': { min: 5000, median: 6500, max: 8500 },
    },
  },
  {
    role: 'Front Office Executive (Hotel)',
    aliases: ['front office', 'receptionist', 'front desk', 'hotel'],
    department: DEPT_CS,
    industry: HOSPITALITY,
    jobDescription:
      'Handles check-in/out, reservations, guest relations and upselling. Coordinates with housekeeping and F&B on guest experience.',
    qualifications: 'Diploma in hospitality/tourism; Opera/PMS exposure; English + a second language preferred.',
    demandTrend: 'Moderate-high — hotel openings in KL/Penang/Langkawi; service charge tops up base.',
    demandLevel: 'moderate-high',
    variablePay: true,
    bands: {
      '0-2': { min: 1900, median: 2200, max: 2600 },
      '3-5': { min: 2500, median: 2900, max: 3500 },
      '6-10': { min: 3300, median: 3900, max: 4800 },
      '10+': { min: 4200, median: 5000, max: 6200 },
    },
  },
  {
    role: 'Restaurant Manager',
    aliases: ['restaurant manager', 'f&b manager'],
    department: DEPT_CS,
    industry: HOSPITALITY,
    jobDescription:
      'Owns outlet operations: staffing, COGS, hygiene compliance, reservations and reviews. Drives covers, average spend and delivery-channel mix.',
    qualifications: 'Diploma/Degree + 4–7 yrs F&B; food-safety certification.',
    demandTrend: 'Stable-high — RM48–72k/yr typical (AJobThing 2025).',
    demandLevel: 'stable-high',
    variablePay: true,
    bands: {
      '0-2': { min: 2600, median: 3000, max: 3600 },
      '3-5': { min: 3600, median: 4300, max: 5200 },
      '6-10': { min: 4800, median: 5800, max: 7200 },
      '10+': { min: 6200, median: 7500, max: 9500 },
    },
  },
  {
    role: 'Hotel General Manager',
    aliases: ['hotel manager', 'general manager hotel', 'gm hotel'],
    department: DEPT_CS,
    industry: HOSPITALITY,
    jobDescription:
      'Leads all hotel operations and P&L: rooms, F&B, sales and engineering. Sets rate strategy with revenue management and represents the property to owners/brand.',
    qualifications: 'Hospitality degree + 10+ yrs rooms/F&B leadership; brand GMs need multi-property exposure.',
    demandTrend: 'High — RM8–12k typical, 5-star/international-brand GMs well above (FastLaneRecruit 2025).',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 4000, median: 4800, max: 6000 },
      '3-5': { min: 6000, median: 7500, max: 9500 },
      '6-10': { min: 8500, median: 11000, max: 14000 },
      '10+': { min: 12000, median: 16000, max: 22000 },
    },
  },

  // ── §11 Oil, Gas & Energy ────────────────────────────────────────────────
  {
    role: 'Process Engineer (O&G)',
    aliases: ['process engineer o&g', 'oil gas engineer', 'upstream process'],
    department: DEPT_OPS,
    industry: OGE,
    jobDescription:
      'Designs and optimises process units (separation, gas treatment, utilities), runs simulations and HAZOPs, and supports plant troubleshooting and turnarounds.',
    qualifications: 'BEng Chemical/Petroleum; PETRONAS/Shell/Sapura graduate programmes common entry.',
    demandTrend: 'Moderate-high — energy-transition reskilling; upstream projects in Sarawak/Sabah sustain hiring.',
    demandLevel: 'moderate-high',
    bands: {
      '0-2': { min: 3800, median: 4500, max: 5500 },
      '3-5': { min: 5500, median: 6800, max: 8500 },
      '6-10': { min: 8000, median: 10000, max: 13000 },
      '10+': { min: 11500, median: 14500, max: 19000 },
    },
  },
  {
    role: 'Petroleum Engineer',
    aliases: ['petroleum engineer', 'drilling engineer', 'reservoir engineer'],
    department: DEPT_ENG,
    industry: OGE,
    jobDescription:
      'Plans drilling, completion and reservoir management to maximise recovery. Works with geoscience on field development and production optimisation.',
    qualifications: 'BEng Petroleum/Chemical/Mechanical; SPE membership; offshore survival certs (BOSIET) for site roles.',
    demandTrend: 'Moderate — cyclical with capex; Miri/Bintulu clusters pay RM5.6–13.7k spread (Glassdoor 2026).',
    demandLevel: 'moderate',
    variablePay: true,
    bands: {
      '0-2': { min: 4500, median: 5500, max: 7000 },
      '3-5': { min: 7000, median: 8500, max: 11000 },
      '6-10': { min: 10000, median: 12500, max: 16000 },
      '10+': { min: 14000, median: 18000, max: 24000 },
    },
  },
  {
    role: 'HSE Officer / Engineer',
    aliases: ['hse', 'safety officer', 'safety engineer', 'health safety'],
    department: DEPT_OPS,
    industry: OGE,
    jobDescription:
      'Implements site HSE systems: permits to work, toolbox talks, incident investigation and DOSH/DOE compliance. Conducts audits and emergency drills.',
    qualifications: 'Diploma/Degree + NEBOSH IGC / OSHA certs; site experience preferred.',
    demandTrend: 'High — regulatory scrutiny and ESG reporting expand HSE headcount.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2800, median: 3300, max: 4000 },
      '3-5': { min: 4000, median: 4800, max: 6000 },
      '6-10': { min: 5800, median: 7000, max: 9000 },
      '10+': { min: 8000, median: 10000, max: 13000 },
    },
  },
  {
    role: 'Field / Production Technician',
    aliases: ['technician', 'service staff', 'field service', 'maintenance', 'field technician', 'production technician'],
    department: DEPT_OPS,
    industry: OGE,
    jobDescription:
      'Operates and maintains plant equipment, performs routine checks and sampling, and supports maintenance isolation under permit. Shift-based, often offshore.',
    qualifications: 'Vocational diploma (e.g. INSTEP, ADTEC) or SKM Level 2/3; offshore certs for platform roles.',
    demandTrend: 'Stable — operations core crew steady; offshore allowances materially raise total pay.',
    demandLevel: 'stable',
    variablePay: true,
    bands: {
      '0-2': { min: 2200, median: 2600, max: 3200 },
      '3-5': { min: 3200, median: 3900, max: 4800 },
      '6-10': { min: 4500, median: 5400, max: 6800 },
      '10+': { min: 6000, median: 7200, max: 9000 },
    },
  },

  // ── §12 Shared Services / BPO ────────────────────────────────────────────
  {
    role: 'Customer Service Representative',
    aliases: ['customer service', 'support', 'call centre', 'customer success', 'csr', 'contact centre'],
    department: DEPT_CS,
    industry: SSC,
    jobDescription:
      'Resolves customer queries via phone/chat/email against SLAs, logs cases in CRM and escalates exceptions. Often shift-based across global time zones.',
    qualifications: 'SPM/Diploma; strong English; typing and CRM basics.',
    demandTrend: 'Very high volume — KL/Penang BPO hubs hire continuously; RM2.8–3.3k typical entry (AJobThing 2025).',
    demandLevel: 'high-volume',
    bands: {
      '0-2': { min: 1900, median: 2300, max: 2800 },
      '3-5': { min: 2600, median: 3100, max: 3800 },
      '6-10': { min: 3500, median: 4200, max: 5200 },
      '10+': { min: 4500, median: 5500, max: 7000 },
    },
  },
  {
    role: 'AP / AR Analyst (SSC)',
    aliases: ['ap analyst', 'ar analyst', 'accounts payable', 'accounts receivable'],
    department: DEPT_FIN,
    industry: SSC,
    jobDescription:
      'Processes invoices, payments, billings and collections for regional entities; reconciles vendor/customer accounts and supports month-end close.',
    qualifications: 'Diploma/Degree in accounting/finance; SAP/Oracle; regional language an advantage.',
    demandTrend: 'High — MNCs keep consolidating finance ops into Malaysian SSCs (Cyberjaya, PJ, Penang).',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2600, median: 3100, max: 3800 },
      '3-5': { min: 3600, median: 4400, max: 5500 },
      '6-10': { min: 5000, median: 6200, max: 7800 },
      '10+': { min: 6800, median: 8500, max: 10500 },
    },
  },
  {
    role: 'GL / RTR Accountant (SSC)',
    aliases: ['rtr', 'record to report', 'gl accountant ssc'],
    department: DEPT_FIN,
    industry: SSC,
    jobDescription:
      'Owns journal posting, reconciliations and statutory reporting for assigned entities; drives close calendar and audit support across time zones.',
    qualifications: 'Accounting degree; ACCA/CPA part-qualified or qualified; 2–5 yrs GL.',
    demandTrend: 'High — qualified RTR accountants are the SSC premium tier.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3000, median: 3500, max: 4200 },
      '3-5': { min: 4200, median: 5200, max: 6500 },
      '6-10': { min: 6000, median: 7500, max: 9500 },
      '10+': { min: 8500, median: 10500, max: 13000 },
    },
  },
  {
    role: 'Multilingual Support Specialist',
    aliases: ['multilingual', 'japanese support', 'korean support', 'language specialist'],
    department: DEPT_CS,
    industry: SSC,
    jobDescription:
      'Provides customer or IT helpdesk support in a niche language (Japanese, Korean, Mandarin, Thai, Vietnamese) for regional markets.',
    qualifications: 'Language proficiency (JLPT N2/TOPIK 4+ etc.) + support aptitude.',
    demandTrend: 'High — language premiums of 20–40% over English-only roles persist.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2500, median: 3200, max: 4200 },
      '3-5': { min: 3500, median: 4500, max: 6000 },
      '6-10': { min: 4800, median: 6000, max: 7500 },
      '10+': { min: 6000, median: 7500, max: 9500 },
    },
  },
  {
    role: 'SSC Team Lead / Manager',
    aliases: ['ssc', 'shared services', 'team lead'],
    department: DEPT_CS,
    industry: SSC,
    jobDescription:
      'Manages a process tower (P2P/O2C/RTR or CX team): SLA delivery, quality, staffing and continuous improvement. Interfaces with client-country stakeholders.',
    qualifications: 'Degree + 5–8 yrs SSC/BPO with people leadership; Lean/Six Sigma valued.',
    demandTrend: 'High — RM80–103k/yr for CS managers (AJobThing 2025); Heads of SSC RM420–660k/yr (Resumewriter 2025).',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3800, median: 4500, max: 5500 },
      '3-5': { min: 5500, median: 6800, max: 8500 },
      '6-10': { min: 7500, median: 9500, max: 12000 },
      '10+': { min: 10500, median: 13000, max: 17000 },
    },
  },

  // ── §13 Education ────────────────────────────────────────────────────────
  {
    role: 'School Teacher (Govt/Private)',
    aliases: ['teacher', 'school teacher', 'guru'],
    department: DEPT_OPS,
    industry: EDU,
    jobDescription:
      'Plans and delivers curriculum lessons, assesses students and manages classroom discipline. Public teachers follow DG service grades with fixed scales and allowances.',
    qualifications: "Bachelor's + teaching qualification (PGDE/IPG for public sector); SPM for private varies.",
    demandTrend: 'Stable — public hiring cyclical via SPP; private/international segment growing faster.',
    demandLevel: 'stable',
    bands: {
      '0-2': { min: 2300, median: 2700, max: 3200 },
      '3-5': { min: 3000, median: 3500, max: 4200 },
      '6-10': { min: 3800, median: 4500, max: 5500 },
      '10+': { min: 5000, median: 6000, max: 7500 },
    },
  },
  {
    role: 'International School Teacher',
    aliases: ['international teacher', 'igcse teacher', 'ib teacher'],
    department: DEPT_OPS,
    industry: EDU,
    jobDescription:
      'Teaches international curricula (IGCSE, IB, AUSMAT) to expatriate and local students. Plans inquiry-based lessons and supports co-curricular programmes.',
    qualifications: 'Education degree + home-country teaching licence preferred; 2+ yrs curriculum experience.',
    demandTrend: 'High — KL/Penang/JB international school expansion; premium over national schools.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 4000, median: 5000, max: 6000 },
      '3-5': { min: 5500, median: 7000, max: 8500 },
      '6-10': { min: 7500, median: 9000, max: 11000 },
      '10+': { min: 9500, median: 11500, max: 14000 },
    },
  },
  {
    role: 'University Lecturer',
    aliases: ['lecturer', 'tutor', 'academic'],
    department: DEPT_OPS,
    industry: EDU,
    jobDescription:
      'Delivers lectures, supervises projects and conducts research or industry consultancy. Progresses via senior lecturer to associate professor on publications and service.',
    qualifications: "Master's minimum; PhD for progression at public/private universities.",
    demandTrend: 'Stable-high — RM60–96k/yr typical (AJobThing 2025); private universities pay for industry-experienced hires.',
    demandLevel: 'stable-high',
    bands: {
      '0-2': { min: 3500, median: 4200, max: 5000 },
      '3-5': { min: 4500, median: 5500, max: 6800 },
      '6-10': { min: 6000, median: 7500, max: 9500 },
      '10+': { min: 8500, median: 10500, max: 13500 },
    },
  },
  {
    role: 'Corporate Trainer',
    aliases: ['trainer', 'corporate trainer', 'training specialist'],
    department: DEPT_OPS,
    industry: EDU,
    jobDescription:
      'Designs and delivers workplace training (technical, leadership, compliance) for corporate clients. Measures learning outcomes and customises content per engagement.',
    qualifications: 'Degree + HRD Corp TTT certification; subject-matter expertise.',
    demandTrend: 'Moderate-high — HRD Corp levy utilisation keeps corporate training budgets flowing.',
    demandLevel: 'moderate-high',
    bands: {
      '0-2': { min: 3000, median: 3500, max: 4200 },
      '3-5': { min: 4200, median: 5200, max: 6500 },
      '6-10': { min: 5800, median: 7200, max: 9000 },
      '10+': { min: 8000, median: 10000, max: 12500 },
    },
  },

  // ── §14 Professional Services ────────────────────────────────────────────
  {
    role: 'Audit Associate (Big 4 / mid-tier)',
    aliases: ['audit associate', 'external audit', 'big 4', 'assurance'],
    department: DEPT_FIN,
    industry: PROF,
    jobDescription:
      'Executes statutory audit fieldwork: testing, walkthroughs and working papers under MFRS/ISA. Progresses to senior leading engagements and coaching juniors.',
    qualifications: 'Accounting degree + ACCA/CPA in progress; Big 4 hiring cycles twice yearly.',
    demandTrend: 'High — persistent talent leakage to commerce keeps firms hiring; managers RM120–216k/yr (RW 2025).',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3000, median: 3400, max: 4000 },
      '3-5': { min: 4500, median: 5500, max: 7000 },
      '6-10': { min: 7000, median: 8800, max: 11500 },
      '10+': { min: 10000, median: 13000, max: 18000 },
    },
  },
  {
    role: 'Legal Associate',
    aliases: ['lawyer', 'legal', 'associate lawyer', 'advocate'],
    department: DEPT_OPS,
    industry: PROF,
    jobDescription:
      'Drafts and reviews contracts, conducts research and supports transactions or litigation under a partner. Corporate associates handle due diligence and closings.',
    qualifications: 'LLB + CLP/BPTC + chambering (pupillage); called to the Malaysian Bar.',
    demandTrend: 'Stable-high — corporate/tech practices growing; top-tier firms pay above band for seniors.',
    demandLevel: 'stable-high',
    bands: {
      '0-2': { min: 3500, median: 4200, max: 5000 },
      '3-5': { min: 5000, median: 6200, max: 7800 },
      '6-10': { min: 7500, median: 9500, max: 12500 },
      '10+': { min: 11000, median: 14000, max: 18000 },
    },
  },
  {
    role: 'Management Consultant',
    aliases: ['consultant', 'management consultant', 'strategy'],
    department: DEPT_OPS,
    industry: PROF,
    jobDescription:
      'Diagnoses client problems, analyses data and markets, and develops strategy or transformation recommendations. Presents to C-suite and supports implementation.',
    qualifications: 'Top-tier degree; case-interview entry at MBB/Big 4 advisory; MBA for senior track.',
    demandTrend: 'High — transformation and ESG advisory demand strong; wide band reflects tier spread.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 4000, median: 5000, max: 6500 },
      '3-5': { min: 6500, median: 8500, max: 11000 },
      '6-10': { min: 10000, median: 13000, max: 17000 },
      '10+': { min: 15000, median: 19000, max: 26000 },
    },
  },
  {
    role: 'HR Consultant / Recruiter',
    aliases: ['recruiter', 'recruitment', 'talent acquisition', 'hr consultant'],
    department: DEPT_HR,
    industry: PROF,
    jobDescription:
      'Sources, screens and places candidates for client roles; manages client relationships and candidate pipelines. Agency recruiters earn base plus placement commissions.',
    qualifications: 'Degree in HR/business/psychology; agency experience for seniors.',
    demandTrend: 'Moderate-high — hiring recovery in tech/finance lifts placement volumes.',
    demandLevel: 'moderate-high',
    variablePay: true,
    bands: {
      '0-2': { min: 2600, median: 3100, max: 3800 },
      '3-5': { min: 3800, median: 4600, max: 5800 },
      '6-10': { min: 5500, median: 6800, max: 8500 },
      '10+': { min: 7500, median: 9500, max: 12000 },
    },
  },

  // ── §15 Corporate Functions (cross-industry) ─────────────────────────────
  {
    role: 'HR Executive',
    aliases: ['hr officer', 'human resources', 'people ops', 'hr executive'],
    department: DEPT_HR,
    industry: CORP,
    jobDescription:
      'Runs recruitment, onboarding, payroll inputs, leave/attendance administration and employee-relations first response. Maintains HRIS data and statutory compliance touchpoints.',
    qualifications: 'Degree in HR/business; knowledge of Employment Act 1955 and statutory contributions.',
    demandTrend: 'High — HR shared-services and HRBP models expanding; senior HR RM100–420k/yr (HRO 2025).',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2500, median: 3200, max: 4000 },
      '3-5': { min: 3800, median: 4800, max: 6000 },
      '6-10': { min: 5500, median: 7000, max: 8500 },
      '10+': { min: 8000, median: 10000, max: 13000 },
    },
  },
  {
    role: 'HR Manager',
    aliases: ['hr manager', 'hrbp', 'hr business partner', 'head of hr'],
    department: DEPT_HR,
    industry: CORP,
    jobDescription:
      'Leads HR operations or an HRBP portfolio: policy, performance cycles, IR/ER cases and workforce planning. Advises leadership on org design and retention.',
    qualifications: 'HR degree + 6–10 yrs; MIHRM/CHRP an advantage.',
    demandTrend: 'High — retention pressure makes experienced HR managers hard to replace.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 3800, median: 4500, max: 5500 },
      '3-5': { min: 5500, median: 6800, max: 8500 },
      '6-10': { min: 7500, median: 9500, max: 12000 },
      '10+': { min: 10500, median: 13500, max: 18000 },
    },
  },
  {
    role: 'Admin / Office Executive',
    aliases: ['admin', 'clerk', 'office admin', 'admin assistant', 'admin clerk', 'office executive'],
    department: DEPT_OPS,
    industry: CORP,
    jobDescription:
      'Manages office operations, scheduling, documentation, procurement of supplies and front-desk coverage. Supports management with reports and travel arrangements.',
    qualifications: 'SPM/Diploma; MS Office; bilingual (BM/English) preferred.',
    demandTrend: 'Stable — volume role in every SME; pay anchored near floor, rises with scope (office manager).',
    demandLevel: 'stable',
    bands: {
      '0-2': { min: 1800, median: 2200, max: 2700 },
      '3-5': { min: 2500, median: 3000, max: 3700 },
      '6-10': { min: 3400, median: 4100, max: 5000 },
      '10+': { min: 4400, median: 5300, max: 6500 },
    },
  },
  {
    role: 'Digital Marketing Specialist',
    aliases: ['marketing', 'digital marketing', 'content', 'social media', 'seo', 'marketing executive'],
    department: DEPT_SM,
    industry: CORP,
    jobDescription:
      'Plans and executes paid/organic campaigns (Google, Meta, TikTok), analyses funnel metrics and optimises CAC/ROAS. Produces content calendars with design support.',
    qualifications: 'Marketing/communications degree or portfolio; platform certifications (Google Ads, Meta).',
    demandTrend: 'High — e-commerce and social-commerce budgets keep shifting to digital.',
    demandLevel: 'high',
    bands: {
      '0-2': { min: 2600, median: 3200, max: 4000 },
      '3-5': { min: 3800, median: 4800, max: 6200 },
      '6-10': { min: 5500, median: 7000, max: 9000 },
      '10+': { min: 8000, median: 10000, max: 13000 },
    },
  },
  {
    role: 'Sales Executive (B2B)',
    aliases: ['sales', 'account manager', 'business development', 'sales executive'],
    department: DEPT_SM,
    industry: CORP,
    jobDescription:
      'Prospects, qualifies and closes business customers; manages pipeline in CRM and negotiates quotes. Commission often equals 30–100% of base at target.',
    qualifications: 'Diploma/Degree; industry product training; driving licence for field sales.',
    demandTrend: 'High — commission-heavy structures; base ranges per table, OTE materially higher.',
    demandLevel: 'high',
    variablePay: true,
    bands: {
      '0-2': { min: 2500, median: 3200, max: 4200 },
      '3-5': { min: 4000, median: 5200, max: 6800 },
      '6-10': { min: 6000, median: 7800, max: 10000 },
      '10+': { min: 9000, median: 11500, max: 15000 },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Industry / role listings
// ─────────────────────────────────────────────────────────────────────────────

/** All researched industries, in dataset order. */
export function listIndustries(): string[] {
  return [...new Set(BENCHMARKS.map((b) => b.industry))];
}

/** Benchmark rows, optionally filtered to one industry (dataset order). */
export function listRoles(industry?: string): BenchmarkRow[] {
  if (!industry) return BENCHMARKS;
  return BENCHMARKS.filter((b) => b.industry === industry);
}

// ─────────────────────────────────────────────────────────────────────────────
// State wage-market adjustment factors (cost-of-living.md §A.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wage-market factors vs the Klang Valley baseline (KV = 1.00). These are
 * tuned estimates between DOSM state wage means (0.79–1.06× KL) and pure COL
 * ratios (0.45–1.00× KL), weighted to wages — not direct DOSM ratios.
 */
const STATE_FACTOR: Record<StateCode, number> = {
  KUL: 1.0,
  SGR: 1.0,
  PJY: 0.98,
  PNG: 0.95,
  JHR: 0.93,
  MLK: 0.88,
  NSB: 0.88,
  LBN: 0.88,
  SWK: 0.87,
  SBH: 0.85,
  PRK: 0.85,
  PHG: 0.84,
  TRG: 0.84,
  KDH: 0.82,
  PLS: 0.8,
  KTN: 0.8,
};

export function stateFactor(state: StateCode): number {
  return STATE_FACTOR[state] ?? 1.0;
}

export function bandForYears(years: number): SeniorityBand {
  if (years <= 2) return '0-2';
  if (years <= 5) return '3-5';
  if (years <= 10) return '6-10';
  return '10+';
}

// ─────────────────────────────────────────────────────────────────────────────
// Salary suggestion (backward-compatible, plus researched profile fields)
// ─────────────────────────────────────────────────────────────────────────────

const GENERIC: BenchmarkRow['bands'] = {
  '0-2': { min: 2000, median: 2800, max: 3800 },
  '3-5': { min: 3500, median: 4500, max: 6000 },
  '6-10': { min: 5500, median: 7000, max: 9000 },
  '10+': { min: 8500, median: 10500, max: 13500 },
};

/** Seniority prefixes stripped before matching ("Senior Software Engineer" → "Software Engineer"). */
const SENIORITY_PREFIX = /^(senior|junior|lead)\s+/i;

/**
 * Flagship benchmark role per app department — the department fallback
 * resolves to these first so common SME departments land on the most
 * representative role (legacy Wave-1 behavior), regardless of dataset order.
 */
const DEPT_FLAGSHIP: Record<string, string> = {
  engineering: 'Software Engineer',
  'human resources': 'HR Executive',
  finance: 'Accountant (GL/Financial)',
  'sales & marketing': 'Sales Executive (B2B)',
  operations: 'Admin / Office Executive',
  'customer support': 'Customer Service Representative',
};

export interface SalarySuggestion {
  min: number;
  median: number;
  max: number;
  percentile25: number;
  percentile75: number;
  drivers: string[];
  matchedRole: string;
  band: SeniorityBand;
  stateFactor: number;
  /** Researched profile fields — present only when a benchmark row matched. */
  industry?: string;
  jobDescription?: string;
  qualifications?: string;
  demandTrend?: string;
  demandLevel?: DemandLevel;
  /** True when commissions/allowances materially top up base salary. */
  variablePay?: boolean;
}

export function suggestSalary(
  role: string,
  seniorityYears: number,
  state: StateCode,
  department?: string,
): SalarySuggestion {
  // Normalise seniority prefixes so every caller (suggestion tool free text,
  // equity analyzer titles) hits the underlying benchmark row.
  const q = role.trim().replace(SENIORITY_PREFIX, '').trim().toLowerCase();
  // Guard: an empty query must fall through to the department/generic bands —
  // `a.includes('')` is true for every alias and would match an arbitrary row.
  const deptKey = department?.trim().toLowerCase();
  // Match order: exact role → exact alias → fuzzy (substring either way).
  // The exact-alias phase keeps "full stack developer" on its own row even
  // though "developer" is a fuzzy alias of Software Engineer.
  const row =
    (q
      ? BENCHMARKS.find((b) => b.role.toLowerCase() === q) ??
        BENCHMARKS.find((b) => b.aliases.some((a) => a === q)) ??
        BENCHMARKS.find((b) => b.aliases.some((a) => q.includes(a) || a.includes(q)))
      : undefined) ??
    (deptKey
      ? BENCHMARKS.find((b) => b.role === DEPT_FLAGSHIP[deptKey]) ??
        BENCHMARKS.find((b) => b.department.toLowerCase() === deptKey)
      : undefined);

  const band = bandForYears(seniorityYears);
  const base = row ? row.bands[band] : GENERIC[band];
  const f = stateFactor(state);
  const adj = (n: number) => round2(n * f);

  const min = adj(base.min);
  const median = adj(base.median);
  const max = adj(base.max);

  const drivers: string[] = [];
  drivers.push(
    row
      ? `Benchmark: ${row.role} (${row.industry}), seniority band ${band} yrs`
      : `No exact role match — generic Malaysian white/blue-collar band ${band} yrs used`,
  );
  if (f !== 1) {
    drivers.push(
      f > 1
        ? `${state} location premium ×${f} (above Klang Valley baseline)`
        : `${state} wage-market factor ×${f} (DOSM state wages vs Klang Valley — tuned estimate)`,
    );
  } else {
    drivers.push(`${state}: Klang Valley baseline (×1.00)`);
  }
  if (department && row && row.department.toLowerCase() !== department.toLowerCase()) {
    drivers.push(`Role benchmark is under ${row.department}, not ${department}`);
  }

  return {
    min,
    median,
    max,
    percentile25: round2(min + (median - min) * 0.5),
    percentile75: round2(median + (max - median) * 0.5),
    drivers,
    matchedRole: row?.role ?? 'Generic',
    band,
    stateFactor: f,
    industry: row?.industry,
    jobDescription: row?.jobDescription,
    qualifications: row?.qualifications,
    demandTrend: row?.demandTrend,
    demandLevel: row?.demandLevel,
    variablePay: row?.variablePay,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost of living by state (cost-of-living.md §A.2 — KUL = 100)
// ─────────────────────────────────────────────────────────────────────────────

export interface CostOfLivingRow {
  state: StateCode;
  stateName: string;
  /** Reference city used for the Numbeo components. */
  refCity: string;
  /** 1BR city-centre rent, RM/month. */
  rent1BrCity: number;
  /** 1BR suburb rent, RM/month. */
  rent1BrSuburb: number;
  /** Single-person monthly basket: avg(rents) + food + transport + utilities. */
  basket: number;
  /** Composite COL index, Kuala Lumpur = 100. */
  index: number;
  /** True when one or more components were estimated — treat as ±15%. */
  estimated: boolean;
}

export const COST_OF_LIVING: CostOfLivingRow[] = [
  { state: 'KUL', stateName: 'W.P. Kuala Lumpur', refCity: 'Kuala Lumpur', rent1BrCity: 2588, rent1BrSuburb: 1453, basket: 3887, index: 100.0, estimated: false },
  { state: 'PJY', stateName: 'W.P. Putrajaya', refCity: 'Putrajaya', rent1BrCity: 2100, rent1BrSuburb: 1400, basket: 3500, index: 90.0, estimated: true },
  { state: 'JHR', stateName: 'Johor', refCity: 'Johor Bahru', rent1BrCity: 2125, rent1BrSuburb: 1600, basket: 3445, index: 88.6, estimated: false },
  { state: 'SGR', stateName: 'Selangor', refCity: 'Petaling Jaya', rent1BrCity: 1988, rent1BrSuburb: 1508, basket: 3368, index: 86.7, estimated: false },
  { state: 'SBH', stateName: 'Sabah', refCity: 'Kota Kinabalu', rent1BrCity: 1760, rent1BrSuburb: 775, basket: 2863, index: 73.6, estimated: false },
  { state: 'PNG', stateName: 'Pulau Pinang', refCity: 'George Town', rent1BrCity: 1648, rent1BrSuburb: 939, basket: 2817, index: 72.4, estimated: false },
  { state: 'PRK', stateName: 'Perak', refCity: 'Ipoh', rent1BrCity: 1500, rent1BrSuburb: 1000, basket: 2666, index: 68.6, estimated: true },
  { state: 'SWK', stateName: 'Sarawak', refCity: 'Kuching', rent1BrCity: 1488, rent1BrSuburb: 984, basket: 2528, index: 65.0, estimated: false },
  { state: 'LBN', stateName: 'W.P. Labuan', refCity: 'Labuan', rent1BrCity: 1000, rent1BrSuburb: 700, basket: 2300, index: 59.2, estimated: true },
  { state: 'MLK', stateName: 'Melaka', refCity: 'Melaka City', rent1BrCity: 1000, rent1BrSuburb: 700, basket: 2282, index: 58.7, estimated: true },
  { state: 'KTN', stateName: 'Kelantan', refCity: 'Kota Bharu', rent1BrCity: 1000, rent1BrSuburb: 500, basket: 2018, index: 51.9, estimated: false },
  { state: 'NSB', stateName: 'Negeri Sembilan', refCity: 'Seremban', rent1BrCity: 750, rent1BrSuburb: 500, basket: 1972, index: 50.7, estimated: false },
  { state: 'TRG', stateName: 'Terengganu', refCity: 'Kuala Terengganu', rent1BrCity: 800, rent1BrSuburb: 550, basket: 1935, index: 49.8, estimated: true },
  { state: 'PHG', stateName: 'Pahang', refCity: 'Kuantan', rent1BrCity: 800, rent1BrSuburb: 450, basket: 1885, index: 48.5, estimated: false },
  { state: 'KDH', stateName: 'Kedah', refCity: 'Alor Setar', rent1BrCity: 700, rent1BrSuburb: 400, basket: 1795, index: 46.2, estimated: false },
  { state: 'PLS', stateName: 'Perlis', refCity: 'Kangar', rent1BrCity: 600, rent1BrSuburb: 400, basket: 1730, index: 44.5, estimated: true },
];

/** The COL table under its mission name (alias of COST_OF_LIVING). */
export const costOfLiving = COST_OF_LIVING;

/** COL row for a state (falls back to Kuala Lumpur). */
export function colForState(state: StateCode): CostOfLivingRow {
  return COST_OF_LIVING.find((r) => r.state === state) ?? COST_OF_LIVING[0]!;
}

/**
 * Convert a salary between states at purchasing-power parity:
 * `amount × COL(to) ÷ COL(from)`. Pure living-cost conversion — wages vary
 * less than living costs, so for an equivalent *offer* also see stateFactor.
 */
export function colAdjustedSalary(amount: number, fromState: StateCode, toState: StateCode): number {
  const from = colForState(fromState).index;
  const to = colForState(toState).index;
  if (from <= 0) return round2(amount);
  return round2((amount * to) / from);
}

// ─────────────────────────────────────────────────────────────────────────────
// Household income classification — DOSM HIS 2024 (pub. 2025-10)
// ─────────────────────────────────────────────────────────────────────────────

/** DOSM 2024 national median monthly salaries & wages (individual, citizens). */
export const NATIONAL_MEDIAN_WAGE = 2793;

export type IncomeBand = 'B40' | 'M40' | 'T20';
export type IncomeSubBand =
  | 'B1' | 'B2' | 'B3' | 'B4'
  | 'M1' | 'M2' | 'M3' | 'M4'
  | 'T1' | 'T2';

/** DOSM HIS 2024 thresholds (RM/month household gross). Version by survey year. */
export const INCOME_THRESHOLDS = {
  surveyYear: 2024,
  b40Ceiling: 5859, // B40: up to 5,859
  t20Floor: 12680, // T20: 12,680 and above
  t15Floor: 14000, // T15 policy flag ≈ RM13–14k (2024 survey, pending_revision)
  subBands: [
    { sub: 'B1', min: 0, max: 2889 },
    { sub: 'B2', min: 2890, max: 3809 },
    { sub: 'B3', min: 3810, max: 4839 },
    { sub: 'B4', min: 4840, max: 5859 },
    { sub: 'M1', min: 5860, max: 7019 },
    { sub: 'M2', min: 7020, max: 8599 },
    { sub: 'M3', min: 8600, max: 10279 },
    { sub: 'M4', min: 10280, max: 12679 },
    { sub: 'T1', min: 12680, max: 16519 },
    { sub: 'T2', min: 16520, max: Infinity },
  ] as { sub: IncomeSubBand; min: number; max: number }[],
} as const;

export interface IncomeClassResult {
  band: IncomeBand;
  subBand: IncomeSubBand;
  /** DOSM 2024 median monthly individual wage (RM2,793). */
  nationalMedian: number;
  /** gross ÷ national median wage (1.00 = exactly at the median). */
  vsNationalMedian: number;
  /** True at/above the T15 policy-flag floor (≈RM14,000, 2024 survey — pending revision). */
  t15Zone: boolean;
  surveyYear: number;
}

/**
 * Classify a monthly gross income into DOSM B40/M40/T20 (+ sub-band).
 * NOTE: DOSM classes are defined on HOUSEHOLD gross income; applying them to
 * an individual salary is a proxy — disclose that in the UI.
 */
export function incomeClass(monthlyGross: number): IncomeClassResult {
  const g = Math.max(0, monthlyGross);
  const band: IncomeBand = g <= INCOME_THRESHOLDS.b40Ceiling ? 'B40' : g < INCOME_THRESHOLDS.t20Floor ? 'M40' : 'T20';
  const sub = INCOME_THRESHOLDS.subBands.find((s) => g >= s.min && g <= s.max) ?? INCOME_THRESHOLDS.subBands[9]!;
  return {
    band,
    subBand: sub.sub,
    nationalMedian: NATIONAL_MEDIAN_WAGE,
    vsNationalMedian: round2(g / NATIONAL_MEDIAN_WAGE),
    t15Zone: g >= INCOME_THRESHOLDS.t15Floor,
    surveyYear: INCOME_THRESHOLDS.surveyYear,
  };
}

/**
 * State-level group thresholds where DOSM published extracts exist
 * (cost-of-living.md §B.3). Missing states: derive from the decile table.
 */
export const STATE_INCOME_THRESHOLDS: Partial<Record<StateCode, { b40Ceiling?: number; t20Floor?: number }>> = {
  KTN: { b40Ceiling: 3520, t20Floor: 7000 },
  KDH: { b40Ceiling: 3940, t20Floor: 7820 },
  PLS: { t20Floor: 8010 },
  PHG: { t20Floor: 8090 },
  PRK: { t20Floor: 8220 },
  SWK: { t20Floor: 9710 },
  PNG: { t20Floor: 12680 },
  JHR: { t20Floor: 13560 },
  SGR: { t20Floor: 16040 },
  KUL: { t20Floor: 17030 },
  PJY: { t20Floor: 19030 },
};

/** Decile median household gross income by state, DOSM HIS 2024 (D1…D10). */
export const STATE_DECILES: Record<StateCode, number[]> = {
  JHR: [2833, 4068, 5057, 6057, 7066, 8259, 9742, 12640, 14590, 21191],
  KDH: [1733, 2593, 3162, 3661, 4541, 5262, 6100, 7121, 9107, 12996],
  KTN: [1629, 2311, 2774, 3279, 3762, 4400, 5187, 6265, 8296, 13045],
  MLK: [3043, 3935, 4740, 5562, 6401, 7531, 8787, 10432, 13241, 19266],
  NSB: [2189, 3012, 3643, 4367, 5153, 6135, 7308, 8673, 11348, 17248],
  PHG: [2369, 3019, 3509, 4043, 4672, 5245, 5860, 6771, 9167, 14232],
  PNG: [2440, 3697, 4712, 5769, 6854, 7993, 9440, 11231, 14016, 20759],
  PRK: [2065, 2575, 3146, 3666, 4329, 5154, 6041, 7278, 9567, 15395],
  PLS: [1886, 2760, 3274, 3917, 4601, 5319, 6026, 7297, 9135, 14452],
  SBH: [1764, 2512, 3087, 3783, 4484, 5268, 6391, 7903, 10709, 16115],
  SWK: [2008, 2802, 3516, 4278, 5098, 5961, 7070, 8647, 11150, 16442],
  SGR: [4567, 6559, 8043, 9077, 10274, 11170, 12808, 14465, 18105, 28901],
  TRG: [2971, 3716, 4521, 5375, 6307, 7008, 7806, 9022, 11015, 16960],
  KUL: [3950, 5855, 7527, 8979, 10242, 11559, 13126, 15568, 19494, 31816],
  LBN: [2504, 3890, 4844, 5739, 6937, 7735, 9157, 10800, 13316, 17923],
  PJY: [4752, 5977, 7695, 9090, 10444, 11848, 15315, 18405, 21570, 30018],
};

/** National decile medians (Malaysia row of the DOSM HIS 2024 table). */
export const NATIONAL_DECILES = [2298, 3354, 4326, 5351, 6506, 7820, 9343, 11161, 14112, 21425];

export interface StateDecilePlacement {
  /** First decile whose median the income meets or exceeds (1 = bottom … 10 = top). */
  decile: number;
  /** Median household income of that decile in the state. */
  decileMedian: number;
  /** Approximate share of state households at or below this income, e.g. 0.7. */
  belowShare: number;
}

/**
 * Place an income on the state's household-income decile ladder (HIS 2024).
 * Household-based medians — individual salary is again a proxy.
 */
export function stateDecilePlacement(monthlyGross: number, state: StateCode): StateDecilePlacement {
  const deciles = STATE_DECILES[state] ?? NATIONAL_DECILES;
  const g = Math.max(0, monthlyGross);
  let d = 0;
  while (d < 10 && g > deciles[d]!) d += 1;
  const decile = Math.min(10, d + 1);
  return {
    decile,
    decileMedian: deciles[Math.min(9, decile - 1)]!,
    belowShare: round2(Math.min(1, decile / 10)),
  };
}
