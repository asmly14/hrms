/**
 * User account management UI — Settings → Users & Roles section (stats strip,
 * status badges, search, create-account dialog with one-time credentials) and
 * the employee-form 'Login account' section (toggle + email-driven username
 * suggestion + linked account on save) plus the employee-detail status chip.
 */
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import UsersSection from '@/pages/settings/sections/UsersSection';
import { EmployeeFormDialog } from '@/pages/employees/EmployeeFormDialog';
import EmployeeDetailPage from '@/pages/employees/EmployeeDetailPage';
import { findUser, getSession } from '@/lib/auth';
import { freshDemoTenant, loginAs, renderWithProviders } from '../test/helpers';

beforeEach(async () => {
  await freshDemoTenant();
});

describe('Settings → Users & Roles', () => {
  it('renders the stats strip and account table with status badges', async () => {
    loginAs('admin', 'admin123');
    renderWithProviders(<UsersSection />);

    // Stats strip
    expect(screen.getByText('Total accounts')).toBeInTheDocument();
    expect(screen.getByText('Never logged in')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();

    // Seeded ASM accounts are listed (desktop table) with Active badges.
    expect(await screen.findAllByText('ahmad.faizal')).not.toHaveLength(0);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    // Create button for Admin.
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('search filters the account list', async () => {
    loginAs('admin', 'admin123');
    const user = userEvent.setup();
    renderWithProviders(<UsersSection />);

    await screen.findAllByText('ahmad.faizal');
    await user.type(screen.getByPlaceholderText(/search username or employee/i), 'ahmad');
    await waitFor(() => {
      expect(screen.queryAllByText(/^hr$/)).toHaveLength(0);
    });
    expect(screen.getAllByText('ahmad.faizal').length).toBeGreaterThan(0);
  });

  it('creates a standalone account via the dialog and shows credentials once', async () => {
    loginAs('admin', 'admin123');
    const user = userEvent.setup();
    renderWithProviders(<UsersSection />);

    await user.click(await screen.findByRole('button', { name: /create account/i }));
    // Dialog opens with employee picker, username, password, role.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Create login account')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Username'), 'ui.created');
    await user.type(within(dialog).getByLabelText('Password'), 'ui-pass-123');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));

    // Success view shows the credentials once (scoped: the table behind the
    // dialog also refreshes to list the new account).
    expect(await within(dialog).findByText('Account created')).toBeInTheDocument();
    expect(within(dialog).getByText('ui.created')).toBeInTheDocument();
    expect(within(dialog).getByText('ui-pass-123')).toBeInTheDocument();
    expect(within(dialog).getByText(/share these credentials securely/i)).toBeInTheDocument();

    // Account exists in the directory, linked to the active company.
    const stored = findUser('ui.created');
    expect(stored?.companyId).toBe('co-asm');
    expect(stored?.status).toBe('active');
    expect(stored?.employeeId).toBeUndefined(); // standalone default
  });
});

describe('Employee form — Login account section', () => {
  it('toggle reveals fields and username auto-syncs from the email prefix', async () => {
    loginAs('admin', 'admin123');
    const user = userEvent.setup();
    renderWithProviders(<EmployeeFormDialog open onOpenChange={() => {}} />);

    // Collapsed by default — no username field until the toggle is on.
    expect(screen.queryByLabelText('Username')).toBeNull();
    await user.click(screen.getByLabelText(/create login account/i));

    // Fields appear; typing the email drives the username suggestion.
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/email/i), 'Siti.Nurhaliza@asmtech.my');
    await waitFor(() => {
      expect(screen.getByLabelText('Username')).toHaveValue('siti.nurhaliza');
    });
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText('Access role')).toBeInTheDocument();
  });

  it('is not shown when editing an existing employee', () => {
    loginAs('admin', 'admin123');
    const emp = {
      id: 'emp-edit-1', name: 'Edit Me', ic: '900101-14-5566', email: 'edit.me@asmtech.my',
      phone: '+6012-1112222', departmentId: 'dept-eng', positionId: 'pos-eng-senior', role: 'employee' as const,
      joinDate: '2024-01-15', state: 'KUL' as const, employmentType: 'full-time' as const, status: 'active' as const,
      baseSalary: 4000, maritalStatus: 'single' as const, children: 0, bankName: 'Maybank',
      bankAccount: '123456', epfNo: '12345678', socsoNo: '', taxNo: '', isForeignWorker: false,
      dateOfBirth: '1990-01-01', gender: 'female' as const, fixedAllowances: [],
    };
    renderWithProviders(<EmployeeFormDialog open onOpenChange={() => {}} employee={emp} />);
    expect(screen.queryByLabelText(/create login account/i)).toBeNull();
  });
});

describe('Employee detail — account status chip', () => {
  /** The chip lives on the Employment tab (Radix unmounts inactive tabs). */
  async function openEmploymentTab(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('tab', { name: /employment/i }));
  }

  it('shows the linked account chip with Admin quick actions', async () => {
    loginAs('admin', 'admin123');
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/employees/:id" element={<EmployeeDetailPage />} />
      </Routes>,
      { initialEntries: ['/employees/emp-01'] },
    );
    await openEmploymentTab(user);
    // emp-01 Ahmad Faizal has the seeded ahmad.faizal account (badge text is
    // split across JSX text nodes — match on the badge's full textContent).
    expect(
      await screen.findByText((_, el) => el?.textContent === 'Active · ahmad.faizal'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(getSession()?.username).toBe('admin');
  });

  it('shows an account chip + exactly one Admin quick action for any employee', async () => {
    loginAs('admin', 'admin123');
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/employees/:id" element={<EmployeeDetailPage />} />
      </Routes>,
      { initialEntries: ['/employees/emp-02'] },
    );
    await openEmploymentTab(user);
    // seedUsers derives an account for every seeded employee, so emp-02 has
    // one — assert the chip exists (any state) with one quick action.
    const chips = await screen.findAllByText((_, el) =>
      /^(Active · \S+|Revoked · \S+|No account)$/.test(el?.textContent ?? ''),
    );
    expect(chips.length).toBeGreaterThan(0);
    const actions = screen.queryAllByRole('button', { name: /^(Create account|Revoke|Re-enable)$/ });
    expect(actions).toHaveLength(1);
  });
});
