/**
 * Demo tenant registry — Company records for the seeded companies.
 *
 * Lives in its own module (imports types only) so BOTH db.ts (migration)
 * and seed.ts (dataset builders) can use it without an import cycle.
 */
import type { Company, ModuleKey, StateCode, WorkingWeek } from './types';

export const COMPANY_ID_ASM = 'co-asm';
export const COMPANY_ID_MERDEKA = 'co-merdeka';
export const COMPANY_ID_DESA = 'co-desa';

/** Ids of the companies seeded by seedIfEmpty(). */
export const DEMO_COMPANY_IDS = [COMPANY_ID_ASM, COMPANY_ID_MERDEKA, COMPANY_ID_DESA] as const;

/** Fri–Sat weekend states (mirrors lib/holidays.ts, kept dependency-free). */
const FRI_SAT_STATES: StateCode[] = ['JHR', 'KDH', 'KTN', 'TRG'];

/** Default working week for a HQ state. */
export function defaultWorkingWeek(state: StateCode): WorkingWeek {
  return FRI_SAT_STATES.includes(state) ? 'fri-sat' : 'sat-sun';
}

const ALL_MODULES: ModuleKey[] = [
  'attendance', 'leave', 'claims', 'payroll', 'kpi', 'insights', 'reports',
  'onboarding', 'offboarding',
];

interface CompanySeedSpec {
  id: string;
  code: string;
  name: string;
  regNo: string;
  hqState: StateCode;
  plan: Company['plan'];
  status: Company['status'];
  accentColor: string;
  payrollCutoffDay: number;
  leaveTopUps?: Company['config']['leaveTopUps'];
}

const SPECS: CompanySeedSpec[] = [
  {
    id: COMPANY_ID_ASM,
    code: 'ASM',
    name: 'ASM Tech Sdn Bhd',
    regNo: '201501023456 (1144228-K)',
    hqState: 'KUL',
    plan: 'enterprise',
    status: 'active',
    accentColor: '#b45309',
    payrollCutoffDay: 25,
    leaveTopUps: { annual: 2 },
  },
  {
    id: COMPANY_ID_MERDEKA,
    code: 'MRD',
    name: 'Merdeka Manufacturing Sdn Bhd',
    regNo: '201108004321 (932211-A)',
    hqState: 'JHR',
    plan: 'pro',
    status: 'active',
    accentColor: '#4d7c0f',
    payrollCutoffDay: 26,
  },
  {
    id: COMPANY_ID_DESA,
    code: 'DESA',
    name: 'Desa Retail Group',
    regNo: '201901007654 (1317765-V)',
    hqState: 'PNG',
    plan: 'free',
    status: 'trial',
    accentColor: '#0f766e',
    payrollCutoffDay: 25,
  },
];

/** Build the Company record for one demo tenant (new object each call). */
export function companySeedRecord(companyId: string): Company {
  const spec = SPECS.find((s) => s.id === companyId) ?? SPECS[0]!;
  return {
    id: spec.id,
    code: spec.code,
    name: spec.name,
    regNo: spec.regNo,
    hqState: spec.hqState,
    status: spec.status,
    plan: spec.plan,
    createdAt: '2025-01-01T00:00:00.000Z',
    branding: { logoText: spec.code, accentColor: spec.accentColor },
    config: {
      workingWeek: defaultWorkingWeek(spec.hqState),
      payrollCutoffDay: spec.payrollCutoffDay,
      claimPolicy: {},
      leaveTopUps: spec.leaveTopUps ?? {},
      enabledModules: [...ALL_MODULES],
      customFields: [],
      numberFormats: {
        employeeIdPrefix: spec.code,
        payslipPrefix: `${spec.code}-PS`,
      },
      orgChart: { showDottedLineReports: false },
    },
  };
}

/** All demo company records. */
export function demoCompanyRecords(): Company[] {
  return DEMO_COMPANY_IDS.map((id) => companySeedRecord(id));
}
