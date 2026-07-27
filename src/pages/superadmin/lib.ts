/**
 * Shared helpers for the SuperAdmin console — cross-tenant reads, billing
 * math, and the mock-auth account write used by the create-company wizard.
 *
 * CONTRACT NOTE: lib/auth.ts exposes no public "add user" API (readUsers /
 * writeUsers are private). The wizard therefore appends to the documented
 * global storage key 'hrms.users' directly (docs/tenant-api.md §1). If a
 * public addUserAccount() is added to lib/auth later, switch to it.
 */
import { findUser, type UserAccount } from '@/lib/auth';
import { getCollection } from '@/lib/db';
import { fmtDate } from '@/lib/utils';
import type { AuditLog, Company, CompanyPlan, Employee, ModuleKey } from '@/lib/types';

/** Demo billing rates (RM per employee per month) behind the MRR estimate. */
export const PLAN_RATES: Record<CompanyPlan, number> = {
  free: 0,
  pro: 10,
  enterprise: 18,
};

export const PLAN_LABELS: Record<CompanyPlan, string> = {
  free: 'Free',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

export const MODULE_LABELS: Record<ModuleKey, string> = {
  attendance: 'Attendance',
  leave: 'Leave',
  claims: 'Claims',
  payroll: 'Payroll',
  kpi: 'KPI & Performance',
  insights: 'Insights',
  reports: 'Reports',
  onboarding: 'Onboarding',
  offboarding: 'Offboarding',
};

export const ALL_MODULES = Object.keys(MODULE_LABELS) as ModuleKey[];

/** Live headcount of a tenant — non-resigned employees (billable seats). */
export function headcountOf(companyId: string): number {
  return getCollection<Employee>('employees', companyId).filter(
    (e) => e.status !== 'resigned',
  ).length;
}

/**
 * Estimated MRR contribution of one company: seats × plan rate.
 * Only ACTIVE companies are billed — trial and suspended tenants add RM0.
 */
export function mrrOf(company: Company): number {
  if (company.status !== 'active') return 0;
  return headcountOf(company.id) * PLAN_RATES[company.plan];
}

/** An audit entry tagged with the tenant it belongs to (cross-tenant views). */
export interface TenantAuditRow extends AuditLog {
  company: Company;
}

/** Read one tenant's audit trail, tagging each row with its company. */
export function auditOf(company: Company): TenantAuditRow[] {
  return getCollection<AuditLog>('audit', company.id).map((a) => ({ ...a, company }));
}

/**
 * Collision-free company id derived from the company code:
 * 'Merdeka' → 'co-merdeka' (→ 'co-merdeka-2' when taken).
 */
export function generateCompanyId(code: string, existing: Company[]): string {
  const slug = code.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = `co-${slug || 'company'}`;
  let id = base;
  let n = 2;
  while (existing.some((c) => c.id === id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

// ── Mock-auth account directory (demo only — plaintext, see lib/auth.ts) ─────

const USERS_KEY = 'hrms.users';

/** True when no account with this username exists (case-insensitive). */
export function usernameAvailable(username: string): boolean {
  return !findUser(username);
}

/**
 * Append an account to the global mock-auth directory. Returns false when the
 * username is already taken (nothing written). Direct localStorage write —
 * see the contract note at the top of this file.
 */
export function addUserAccount(account: UserAccount): boolean {
  if (!usernameAvailable(account.username)) return false;
  try {
    const raw = localStorage.getItem(USERS_KEY);
    const users = raw ? (JSON.parse(raw) as UserAccount[]) : [];
    localStorage.setItem(USERS_KEY, JSON.stringify([...users, account]));
    return true;
  } catch {
    return false; // storage unavailable / full — non-fatal in demo mode
  }
}

/** '2026-03-05T09:30:00.000Z' → '5 Mar 2026, 09:30'. */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fmtDate(d)}, ${d.toLocaleTimeString('en-MY', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}
