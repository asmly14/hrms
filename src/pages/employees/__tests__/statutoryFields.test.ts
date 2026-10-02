import { describe, it, expect } from 'vitest';
import type { Employee } from '@/lib/types';
import {
  emptyCarryIn,
  emptyForm,
  employeeFromForm,
  formFromEmployee,
  validateForm,
} from '../helpers';
import type { EmployeeFormState } from '../types';

/**
 * Statutory applicability tri-state plumbing in the employee form:
 * form ↔ entity mapping (auto persists as null so overrides clear cleanly)
 * and the EPF-no validation gate.
 */

const empBase: Employee = {
  id: 'emp-1',
  name: 'Test Employee',
  ic: '900101-01-1234',
  email: 'one@test.my',
  phone: '012-3456789',
  departmentId: 'dept-1',
  positionId: 'pos-1',
  role: 'employee',
  joinDate: '2023-01-01',
  state: 'KUL',
  employmentType: 'full-time',
  status: 'active',
  baseSalary: 3000,
  maritalStatus: 'single',
  children: 0,
  bankName: 'Maybank',
  bankAccount: '1234567890',
  epfNo: 'EPF1',
  socsoNo: 'SOC1',
  taxNo: 'TAX1',
  isForeignWorker: false,
  dateOfBirth: '1990-01-01',
  gender: 'male',
  fixedAllowances: [],
};

function validForm(): EmployeeFormState {
  return {
    ...emptyForm(),
    name: 'Test Employee',
    ic: '900101-01-1234',
    email: 'one@test.my',
    phone: '012-3456789',
    departmentId: 'dept-1',
    positionId: 'pos-1',
    baseSalary: '3000',
    epfNo: 'EPF1',
    bankName: 'Maybank',
    bankAccount: '1234567890',
    dateOfBirth: '1990-01-01',
  };
}

describe('statutory applicability form mapping', () => {
  it('emptyForm defaults both schemes to auto', () => {
    const f = emptyForm();
    expect(f.epfApplicable).toBe('auto');
    expect(f.socsoApplicable).toBe('auto');
  });

  it('formFromEmployee maps boolean/null/undefined flags to tri-state', () => {
    expect(formFromEmployee({ ...empBase, epfApplicable: true }).epfApplicable).toBe('yes');
    expect(formFromEmployee({ ...empBase, epfApplicable: false }).epfApplicable).toBe('no');
    expect(formFromEmployee({ ...empBase, epfApplicable: null }).epfApplicable).toBe('auto');
    expect(formFromEmployee(empBase).epfApplicable).toBe('auto'); // absent (legacy record)
    expect(formFromEmployee({ ...empBase, socsoApplicable: false }).socsoApplicable).toBe('no');
  });

  it('employeeFromForm maps tri-state to boolean|null — auto persists as null (clears overrides)', () => {
    const yes = employeeFromForm({ ...validForm(), epfApplicable: 'yes' }, emptyCarryIn());
    expect(yes.epfApplicable).toBe(true);

    const no = employeeFromForm({ ...validForm(), epfApplicable: 'no', socsoApplicable: 'no' }, emptyCarryIn());
    expect(no.epfApplicable).toBe(false);
    expect(no.socsoApplicable).toBe(false);

    const auto = employeeFromForm({ ...validForm(), epfApplicable: 'auto' }, emptyCarryIn());
    // Key must be present with null (db shallow-merge drops undefined keys,
    // which would leave a stale override behind on edit).
    expect('epfApplicable' in auto).toBe(true);
    expect(auto.epfApplicable).toBeNull();
    expect(auto.socsoApplicable).toBeNull();
  });

  it('round-trips an override through form state without drift', () => {
    const overridden = { ...empBase, epfApplicable: false, socsoApplicable: true };
    const form = formFromEmployee(overridden);
    const back = employeeFromForm({ ...validForm(), epfApplicable: form.epfApplicable, socsoApplicable: form.socsoApplicable }, emptyCarryIn());
    expect(back.epfApplicable).toBe(false);
    expect(back.socsoApplicable).toBe(true);
  });
});

describe('statutory validation gate with applicability', () => {
  it('EPF member no. required for Malaysian employees when EPF applies (auto)', () => {
    const errs = validateForm({ ...validForm(), epfNo: '' }, 'statutory');
    expect(errs.statutory).toBeTruthy();
  });

  it('EPF member no. not required when EPF is explicitly not applicable', () => {
    const errs = validateForm({ ...validForm(), epfNo: '', epfApplicable: 'no' }, 'statutory');
    expect(errs.statutory).toBeUndefined();
  });

  it('EPF member no. never required for foreign workers', () => {
    const errs = validateForm({ ...validForm(), epfNo: '', isForeignWorker: true }, 'statutory');
    expect(errs.statutory).toBeUndefined();
  });
});
