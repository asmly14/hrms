/**
 * Critical flow (d) — MyPayslipsPage ownership: an Employee session sees
 * ONLY their own payslips, from FINALIZED runs only. Other employees'
 * payslips and draft-run figures never render.
 */
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import MyPayslipsPage from '@/pages/payroll/MyPayslipsPage';
import { freshDemoTenant, loginAs, makePayslip, makeRun, renderWithProviders, seedPayroll } from '../test/helpers';

// siti5 / password123 → derived Employee account linked to emp-05 (seeded).
const EMP_SELF = 'emp-05';
const EMP_OTHER = 'emp-01';

describe('MyPayslipsPage ownership', () => {
  beforeEach(async () => {
    await freshDemoTenant();
    seedPayroll(
      [
        makeRun({ id: 'run-jan', monthKey: '2026-01' }),
        makeRun({ id: 'run-dec', monthKey: '2025-12', runAt: '2025-12-28T09:00:00.000Z', finalizedAt: '2025-12-28T10:00:00.000Z' }),
        makeRun({ id: 'run-feb-draft', monthKey: '2026-02', status: 'draft', finalizedAt: undefined }),
      ],
      [
        makePayslip({ id: 'ps-self-jan', runId: 'run-jan', employeeId: EMP_SELF, monthKey: '2026-01', refNo: 'ASM-PS-2026-01-0005' }),
        makePayslip({ id: 'ps-other-jan', runId: 'run-jan', employeeId: EMP_OTHER, monthKey: '2026-01', refNo: 'ASM-PS-2026-01-0001' }),
        makePayslip({ id: 'ps-self-draft', runId: 'run-feb-draft', employeeId: EMP_SELF, monthKey: '2026-02', refNo: 'ASM-PS-2026-02-0005' }),
      ],
    );
    loginAs('siti5', 'password123');
  });

  it('renders only the logged-in employee’s payslips from finalized runs', async () => {
    renderWithProviders(<MyPayslipsPage />);

    // Own finalized payslip is listed (month link + ref number; both the
    // desktop table and the mobile cards render in jsdom → use findAll).
    expect((await screen.findAllByText('January 2026')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('ASM-PS-2026-01-0005').length).toBeGreaterThan(0);

    // Another employee's payslip from the same run is NOT leaked.
    expect(screen.queryByText('ASM-PS-2026-01-0001')).not.toBeInTheDocument();

    // Own payslip from a DRAFT run is withheld until finalized.
    expect(screen.queryByText('February 2026')).not.toBeInTheDocument();
    expect(screen.queryByText('ASM-PS-2026-02-0005')).not.toBeInTheDocument();
  });

  it('shows the empty state when the employee has no finalized payslips', async () => {
    seedPayroll(
      [makeRun({ id: 'run-jan', monthKey: '2026-01' })],
      [makePayslip({ id: 'ps-other-jan', runId: 'run-jan', employeeId: EMP_OTHER, monthKey: '2026-01' })],
    );
    renderWithProviders(<MyPayslipsPage />);

    expect(await screen.findByText('No payslips yet')).toBeInTheDocument();
    expect(screen.queryByText('January 2026')).not.toBeInTheDocument();
  });

  it('standalone accounts (no linked employee) see the link-employee notice, not data', async () => {
    // hr account has NO employeeId link.
    const { logout } = await import('@/lib/auth');
    logout();
    loginAs('hr', 'hr123');
    renderWithProviders(<MyPayslipsPage />);

    expect(await screen.findByText('No employee record linked')).toBeInTheDocument();
    expect(screen.queryByText('January 2026')).not.toBeInTheDocument();
  });
});
