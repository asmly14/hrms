/**
 * Shared UI-test helpers: fresh in-memory storage + deterministic demo
 * tenant seeding + session helpers + payroll fixtures.
 *
 * The db layer reads/writes localStorage synchronously; we reuse the
 * lib-test MemoryStorage stub (jsdom's own localStorage persists across
 * tests within a file, which would leak state between tests).
 *
 * This module exports NO components (react-refresh lint) — the provider
 * stack lives in ./providers and is composed here via createElement.
 */
import { createElement, type ReactElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { installLocalStorage } from '../lib/__tests__/storageStub';
import { seedTenantIfEmpty, setActiveTenantId, setCollection } from '@/lib/db';
import { login as authLogin, logout as authLogout, seedUsers, type PublicUser } from '@/lib/auth';
import { COMPANY_ID_ASM } from '@/lib/tenants';
import { Providers } from './providers';
import type { PayrollRun, Payslip } from '@/lib/types';

export { installLocalStorage };

/**
 * Install a fresh storage stub and seed the ASM Tech demo tenant
 * (employees, departments, positions, leave balances, …; async because the
 * seed module is code-split). Also seeds the mock-auth account directory.
 */
export async function freshDemoTenant(): Promise<void> {
  installLocalStorage();
  authLogout();
  await seedTenantIfEmpty(COMPANY_ID_ASM, true);
  setActiveTenantId(COMPANY_ID_ASM);
  seedUsers();
}

/** Log in (writes hrms.session + sets the active tenant). Fails hard on bad creds. */
export function loginAs(username: string, password: string): PublicUser {
  const result = authLogin(username, password);
  if (!result.ok) throw new Error(`test login failed for ${username}: ${result.error}`);
  return result.user;
}

/** Render inside MemoryRouter + the full provider stack. */
export function renderWithProviders(
  ui: ReactElement,
  { initialEntries = ['/'] }: { initialEntries?: string[] } = {},
) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries },
      createElement(Providers, null, ui as ReactNode),
    ),
  );
}

// ── Payroll fixtures ────────────────────────────────────────────────────────

export function makeRun(overrides: Partial<PayrollRun> = {}): PayrollRun {
  return {
    id: 'run-1',
    monthKey: '2026-01',
    status: 'finalized',
    runAt: '2026-01-28T09:00:00.000Z',
    runBy: 'hr',
    employeeCount: 1,
    totalGross: 5200,
    totalNet: 4200,
    totalEmployerCost: 6100,
    warnings: [],
    finalizedAt: '2026-01-28T10:00:00.000Z',
    ...overrides,
  };
}

export function makePayslip(overrides: Partial<Payslip> = {}): Payslip {
  return {
    id: 'ps-1',
    runId: 'run-1',
    employeeId: 'emp-05',
    monthKey: '2026-01',
    basicPay: 5200,
    unpaidLeaveDeduction: 0,
    otPay: 0,
    otHours: 0,
    allowances: 0,
    claimsTotal: 0,
    grossPay: 5200,
    epfEmployee: 572,
    epfEmployer: 676,
    socsoEmployee: 26,
    socsoEmployer: 91,
    socsoCategory: 1,
    eisEmployee: 10,
    eisEmployer: 10,
    pcb: 392,
    hrdLevy: 26,
    netPay: 4200,
    employerCost: 6100,
    lines: [],
    ytd: { gross: 5200, epf: 572, socso: 26, pcb: 392, net: 4200 },
    ...overrides,
  };
}

/** Inject payroll runs + payslips into the active tenant. */
export function seedPayroll(runs: PayrollRun[], payslips: Payslip[]): void {
  setCollection<PayrollRun>('payrollRuns', runs);
  setCollection<Payslip>('payslips', payslips);
}
