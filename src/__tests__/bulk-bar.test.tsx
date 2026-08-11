/**
 * Critical flow (f) — EmployeesPage bulk selection: the separations bulk
 * bar appears when Admin selects rows, shows the count, and clears.
 *
 * EmployeesPage mounts fine under jsdom (no chart/layout deps), so the real
 * page is exercised rather than a lighter substitute.
 *
 * Query note: every row ALSO carries an icon-only "Separation actions"
 * trigger, so the bulk bar is identified by its bar-only controls —
 * the "N selected" count text and the "Clear selection" button.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import EmployeesPage from '@/pages/employees/EmployeesPage';
import { freshDemoTenant, loginAs, renderWithProviders } from '../test/helpers';

const bulkBarCount = () => screen.queryAllByText('selected');
const clearButtons = () => screen.queryAllByRole('button', { name: /clear selection/i });

describe('EmployeesPage bulk selection bar (Admin)', () => {
  beforeEach(async () => {
    await freshDemoTenant();
    loginAs('admin', 'admin123');
  });

  it('no bulk bar is shown before any selection', async () => {
    renderWithProviders(<EmployeesPage />);

    expect(await screen.findByRole('heading', { name: 'Employees' })).toBeInTheDocument();
    expect(bulkBarCount()).toHaveLength(0);
    expect(clearButtons()).toHaveLength(0);
  });

  it('selecting an employee reveals the bulk bar with the selection count', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeesPage />);

    // Desktop table + mobile cards both render in jsdom → take the first
    // duplicate checkbox with this accessible name.
    const checkbox = (await screen.findAllByRole('checkbox', {
      name: /select ahmad faizal bin razak/i,
    }))[0];
    await user.click(checkbox);

    // "1 selected" appears in both the sticky bar and the mobile sheet.
    expect((await screen.findAllByText('selected')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('1')[0]).toBeInTheDocument();
    expect(clearButtons().length).toBeGreaterThan(0);
  });

  it('clear selection dismisses the bulk bar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeesPage />);

    const checkbox = (await screen.findAllByRole('checkbox', {
      name: /select nurul ain binti hassan/i,
    }))[0];
    await user.click(checkbox);
    expect((await screen.findAllByText('selected')).length).toBeGreaterThan(0);

    await user.click(clearButtons()[0]);

    expect(clearButtons()).toHaveLength(0);
    expect(screen.queryAllByText('selected')).toHaveLength(0);
  });

  it('select-all checkbox selects every filtered employee at once', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmployeesPage />);

    const selectAll = await screen.findByRole('checkbox', {
      name: /select all filtered employees/i,
    });
    await user.click(selectAll);

    // Seeded ASM tenant has 30 employees → the bulk bar shows the full count.
    expect((await screen.findAllByText('30')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('selected')).length).toBeGreaterThan(0);
  });
});
