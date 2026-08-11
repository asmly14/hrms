/**
 * Critical flow (e) — RoleGate: direct-URL role enforcement. An Employee
 * session typing an Admin-only route (/settings, /employees) is redirected
 * to the dashboard; an Admin session reaches /settings. Fails closed.
 */
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import { freshDemoTenant, loginAs } from '../test/helpers';

function renderAppAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('RoleGate (direct-URL guard)', () => {
  beforeEach(async () => {
    await freshDemoTenant();
  });

  it('employee navigating to /settings is redirected to the dashboard', async () => {
    loginAs('siti5', 'password123'); // Employee, linked to emp-05
    renderAppAt('/settings');

    // Lands on '/' — the Employee-scoped personal dashboard.
    expect(
      await screen.findByText(/your attendance, leave and claims at a glance/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument();
    // Settings content never rendered.
    expect(screen.queryByRole('heading', { name: /^settings$/i })).not.toBeInTheDocument();
  }, 25000);

  it('employee navigating to /employees is redirected to the dashboard', async () => {
    loginAs('siti5', 'password123');
    renderAppAt('/employees');

    expect(
      await screen.findByText(/your attendance, leave and claims at a glance/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^employees$/i })).not.toBeInTheDocument();
  }, 25000);

  it('admin navigating to /settings reaches the settings page', async () => {
    loginAs('admin', 'admin123');
    renderAppAt('/settings');

    expect(
      await screen.findByRole('heading', { name: /settings/i }, { timeout: 15000 }),
    ).toBeInTheDocument();
  }, 25000);
});
