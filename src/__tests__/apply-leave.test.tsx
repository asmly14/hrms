/**
 * Critical flow (c) — ApplyLeaveForm: renders for the scoped employee list,
 * blocks invalid submissions with inline errors, and a valid submission
 * fires the success toast + adds the request through the collection API.
 *
 * sonner is mocked: jsdom has no layout/viewport for the toast host, and the
 * assertion target is that the page CALLS toast.success (spy), not pixels.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApplyLeaveForm from '@/pages/leave/components/ApplyLeaveForm';
import { RoleProvider } from '@/lib/roleContext';
import { getCollection } from '@/lib/db';
import { freshDemoTenant } from '../test/helpers';
import type { CollectionApi } from '@/lib/db';
import type { Employee, LeaveBalance, LeaveRequest } from '@/lib/types';
import type { LeaveRequestEx } from '@/pages/leave/leaveLogic';

const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  Toaster: () => null,
}));

function makeLeavesApi(items: LeaveRequestEx[] = []) {
  const added: LeaveRequest[] = [];
  const api: CollectionApi<LeaveRequestEx> = {
    items,
    add: (item) => {
      const full = { ...item, id: item.id ?? `leave-test-${added.length + 1}` } as LeaveRequestEx;
      added.push(full);
      return full;
    },
    update: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
  };
  return { api, added };
}

/** Next Monday (strictly in the future) — guaranteed chargeable for KUL (Sat–Sun weekend). */
function nextMondayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface Rendered {
  added: LeaveRequest[];
}

function renderForm(employees: Employee[], balances: LeaveBalance[] = []): Rendered {
  const { api, added } = makeLeavesApi();
  render(
    <RoleProvider>
      <ApplyLeaveForm employees={employees} leavesApi={api} balances={balances} />
    </RoleProvider>,
  );
  return { added };
}

describe('ApplyLeaveForm', () => {
  let employees: Employee[];

  beforeEach(async () => {
    toastSuccess.mockClear();
    await freshDemoTenant();
    employees = getCollection<Employee>('employees');
  });

  it('renders the form with the employee picker and defaults to annual leave', () => {
    renderForm(employees);
    expect(screen.getByText('Apply for leave')).toBeInTheDocument();
    expect(screen.getByLabelText(/employee/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/leave type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/start date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/end date/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit request/i })).toBeInTheDocument();
  });

  it('blocks an empty date range with an inline error and a disabled submit', () => {
    renderForm(employees);

    // Clear both date inputs (native date inputs — set value directly).
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '' } });

    expect(screen.getByText(/choose both start and end dates/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit request/i })).toBeDisabled();
  });

  it('blocks an end date before the start date', () => {
    renderForm(employees);
    const monday = nextMondayISO();

    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: monday } });
    // The form auto-corrects end ≥ start when start moves; move END backwards.
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '2020-01-01' } });
    expect(
      screen.getByText(/end date must be on or after the start date/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit request/i })).toBeDisabled();
  });

  it('valid submission adds the leave request and fires the success toast', async () => {
    const user = userEvent.setup();
    const { added } = renderForm(employees);
    const monday = nextMondayISO();

    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: monday } });
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: monday } });

    const submit = screen.getByRole('button', { name: /submit request/i });
    expect(submit).toBeEnabled();
    await user.click(submit);

    // Request went through the collection API for the first active employee.
    expect(added).toHaveLength(1);
    expect(added[0].employeeId).toBe(employees[0].id);
    expect(added[0].type).toBe('annual');
    expect(added[0].status).toBe('pending');
    expect(added[0].days).toBe(1);

    // Success toast fired + inline confirmation shown.
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess.mock.calls[0][0]).toMatch(/annual leave submitted/i);
    expect(screen.getByText(/leave submitted for .* — 1 day\(s\), pending approval/i)).toBeInTheDocument();
  });
});
