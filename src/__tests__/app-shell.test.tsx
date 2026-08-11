/**
 * Critical flow (b) — App shell smoke: after an admin login, the routed
 * shell mounts, the sidebar nav renders, and the dashboard's stat cards
 * appear without crashing (lazy route chunks included).
 */
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
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

describe('App shell (admin)', () => {
  beforeEach(async () => {
    await freshDemoTenant();
    loginAs('admin', 'admin123');
  });

  it('renders the sidebar nav and the dashboard stat cards after login', async () => {
    renderAppAt('/');

    // Dashboard heading (lazy chunk resolves).
    expect(
      await screen.findByRole('heading', { name: 'Dashboard', level: 1 }),
    ).toBeInTheDocument();

    // Shell nav: key module links visible for Admin.
    const nav = screen.getAllByRole('navigation')[0];
    const navLinks = within(nav);
    expect(navLinks.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(navLinks.getByRole('link', { name: /employees/i })).toBeInTheDocument();
    expect(navLinks.getByRole('link', { name: /payroll/i })).toBeInTheDocument();
    expect(navLinks.getByRole('link', { name: /settings/i })).toBeInTheDocument();

    // Stat cards derived from the seeded tenant render (Admin sees payroll).
    expect(await screen.findByText('Active headcount')).toBeInTheDocument();
    expect(screen.getByText('Present today')).toBeInTheDocument();
    expect(screen.getByText('Payroll cost this month')).toBeInTheDocument();
  }, 20000);

  it('unauthenticated visitors are redirected to /login', async () => {
    // Fresh storage, NO login.
    await freshDemoTenant();
    renderAppAt('/');

    expect(
      await screen.findByText('Welcome back', {}, { timeout: 10000 }),
    ).toBeInTheDocument();
  }, 20000);
});
