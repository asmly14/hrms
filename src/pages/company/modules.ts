/**
 * Module registry + feature-gate helper for per-company feature toggles.
 *
 * `isModuleEnabled(key)` is the NON-React gate the integration agent should
 * use to hide nav items and guard routes:
 *
 *   import { isModuleEnabled } from '@/pages/company/modules';
 *   // nav:    navItems.filter((item) => !item.module || isModuleEnabled(item.module))
 *   // routes: if (!isModuleEnabled('claims')) return <Navigate to="/" replace />;
 *
 * Semantics: when no company is active (SuperAdmin system view) or a legacy
 * tenant predates `config.enabledModules`, every module is treated as ON —
 * toggles only ever REMOVE access, never break pre-existing tenants.
 */
import { getActiveCompany } from '@/lib/db';
import type { ModuleKey } from '@/lib/types';

/** Plan tier a module is pitched at (displayed as a hint badge only). */
export type PlanHint = 'All plans' | 'Pro' | 'Enterprise';

export interface ModuleDef {
  key: ModuleKey;
  label: string;
  description: string;
  /** Minimum plan the module is bundled in — cosmetic hint, not enforced. */
  planHint: PlanHint;
}

export const MODULE_DEFS: ModuleDef[] = [
  {
    key: 'attendance',
    label: 'Attendance',
    description: 'Clock-in/out with geofence validation, shifts, rest days and overtime tracking.',
    planHint: 'All plans',
  },
  {
    key: 'leave',
    label: 'Leave',
    description: 'EA 1955 entitlements, applications, approvals and balances with company top-ups.',
    planHint: 'All plans',
  },
  {
    key: 'claims',
    label: 'Claims',
    description: 'Expense claims with company policy limits, approvals and payroll reimbursement.',
    planHint: 'All plans',
  },
  {
    key: 'payroll',
    label: 'Payroll',
    description: 'Monthly runs with EPF / SOCSO / EIS / PCB statutory math and payslips.',
    planHint: 'All plans',
  },
  {
    key: 'kpi',
    label: 'KPI & Performance',
    description: 'Weighted KPIs, review cycles and acknowledgement tracking per employee.',
    planHint: 'Pro',
  },
  {
    key: 'insights',
    label: 'Insights',
    description: 'Headcount, cost and attrition analytics drawn from live operational data.',
    planHint: 'Pro',
  },
  {
    key: 'reports',
    label: 'Reports',
    description: 'Statutory-form-ready exports and cross-module management reports.',
    planHint: 'Pro',
  },
  {
    key: 'onboarding',
    label: 'Onboarding',
    description: 'Guided new-hire checklists from offer acceptance to first payroll.',
    planHint: 'Enterprise',
  },
  {
    key: 'offboarding',
    label: 'Offboarding',
    description: 'Resignation workflows — clearance, final pay and access handover.',
    planHint: 'Enterprise',
  },
];

/** Every toggleable module key (default state for new tenants). */
export const ALL_MODULE_KEYS: ModuleKey[] = MODULE_DEFS.map((m) => m.key);

/**
 * Is `key` enabled for the ACTIVE company? Defaults to true when there is no
 * active company (system view) or when the tenant record predates the
 * enabledModules knob.
 */
export function isModuleEnabled(key: ModuleKey): boolean {
  const company = getActiveCompany();
  if (!company) return true;
  const mods = company.config?.enabledModules;
  if (!Array.isArray(mods)) return true;
  return mods.includes(key);
}
