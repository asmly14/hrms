/**
 * Critical flow (a) — LoginPage: renders, rejects bad credentials with an
 * inline error, and a successful login persists the session + navigates on.
 */
import { Route, Routes } from 'react-router-dom';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import LoginPage from '@/pages/login/LoginPage';
import { AuthProvider } from '@/lib/authContext';
import { getSession } from '@/lib/auth';
import { freshDemoTenant } from '../test/helpers';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>HOME LANDING</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(async () => {
    await freshDemoTenant();
  });

  it('renders the sign-in form with demo quick-fill chips', () => {
    renderLogin();
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    // Demo chips mirror the seeded fixed accounts.
    expect(screen.getByText('admin · Full access')).toBeInTheDocument();
    expect(screen.getByText(/ahmad\.faizal · /)).toBeInTheDocument();
  });

  it('shows an inline error on invalid credentials and keeps the user on /login', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid username or password/i);
    // No session persisted, still on the login page.
    expect(getSession()).toBeNull();
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
  });

  it('shows an inline error when the form is submitted empty', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/please enter both username and password/i);
    expect(getSession()).toBeNull();
  });

  it('quick-fill chip fills the credentials fields', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByText('admin · Full access'));

    expect(screen.getByLabelText(/username/i)).toHaveValue('admin');
    expect(screen.getByLabelText('Password')).toHaveValue('admin123');
  });

  it('successful login writes the session and navigates to the app', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText('Password'), 'admin123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('HOME LANDING')).toBeInTheDocument();
    const session = getSession();
    expect(session).not.toBeNull();
    expect(session?.username).toBe('admin');
    expect(session?.role).toBe('Admin');
    expect(session?.companyId).toBe('co-asm');
  });
});
