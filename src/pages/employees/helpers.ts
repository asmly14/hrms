/**
 * M2-local helpers: probation math, form ⇄ entity conversion, validation.
 * All statutory figures come from src/lib/statutory.ts — nothing hardcoded.
 */
import { MINIMUM_WAGE } from '@/lib/statutory';
import { daysBetween } from '@/lib/utils';
import type { Department, Employee, Position } from '@/lib/types';
import { carryInOf } from './types';
import type {
  CarryInFormState,
  EmployeeFormState,
  FormErrors,
  YTDCarryIn,
} from './types';

/**
 * Probation policy assumption (contract gap — `Employee` has no
 * probationEndDate): Malaysian private-sector practice is a 3-month
 * probation from join date. Used by the probation tracker only.
 */
export const PROBATION_MONTHS = 3;

export function addMonths(iso: string, months: number): Date {
  const d = new Date(`${iso}T00:00:00`);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // Clamp month-end overflows (e.g. 31 Jan + 1 month → Feb 28/29).
  if (d.getDate() !== day) d.setDate(0);
  return d;
}

export function probationEnd(joinDate: string): Date {
  return addMonths(joinDate, PROBATION_MONTHS);
}

/** Whole days until probation ends; negative = overdue for confirmation. */
export function probationDaysLeft(joinDate: string, asOf: Date = new Date()): number {
  const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  const end = probationEnd(joinDate);
  return daysBetween(today, end);
}

/** 0–1 progress through the probation period. */
export function probationProgress(joinDate: string, asOf: Date = new Date()): number {
  const start = new Date(`${joinDate}T00:00:00`);
  const total = daysBetween(start, probationEnd(joinDate));
  if (total <= 0) return 1;
  const elapsed = daysBetween(start, asOf);
  return Math.min(1, Math.max(0, elapsed / total));
}

/** Completed service years (1 decimal, floored — 1.96 yrs shows as 1.9, not 2.0). */
export function serviceYears(joinDate: string, asOf: Date = new Date()): number {
  return Math.max(0, Math.floor((daysBetween(joinDate, asOf) / 365.25) * 10) / 10);
}

export function deptName(departments: Department[], id: string): string {
  return departments.find((d) => d.id === id)?.name ?? '—';
}

export function positionTitle(positions: Position[], id: string): string {
  return positions.find((p) => p.id === id)?.title ?? '—';
}

export function positionOf(positions: Position[], id: string): Position | undefined {
  return positions.find((p) => p.id === id);
}

// ── Form state ───────────────────────────────────────────────────────────────

export function emptyForm(): EmployeeFormState {
  return {
    name: '',
    ic: '',
    email: '',
    phone: '',
    departmentId: '',
    positionId: '',
    role: 'employee',
    joinDate: new Date().toISOString().slice(0, 10),
    state: 'KUL',
    employmentType: 'full-time',
    status: 'probation',
    baseSalary: '',
    maritalStatus: 'single',
    children: '0',
    bankName: '',
    bankAccount: '',
    epfNo: '',
    socsoNo: '',
    taxNo: '',
    isForeignWorker: false,
    dateOfBirth: '',
    gender: 'male',
    fixedAllowances: [],
    resignDate: '',
  };
}

export function emptyCarryIn(): CarryInFormState {
  return { enabled: false, gross: '', epf: '', socso: '', pcb: '', note: '' };
}

export function formFromEmployee(emp: Employee): EmployeeFormState {
  return {
    name: emp.name,
    ic: emp.ic,
    email: emp.email,
    phone: emp.phone,
    departmentId: emp.departmentId,
    positionId: emp.positionId,
    role: emp.role,
    joinDate: emp.joinDate,
    state: emp.state,
    employmentType: emp.employmentType,
    status: emp.status,
    baseSalary: String(emp.baseSalary),
    maritalStatus: emp.maritalStatus,
    children: String(emp.children),
    bankName: emp.bankName,
    bankAccount: emp.bankAccount,
    epfNo: emp.epfNo,
    socsoNo: emp.socsoNo,
    taxNo: emp.taxNo,
    isForeignWorker: emp.isForeignWorker,
    dateOfBirth: emp.dateOfBirth,
    gender: emp.gender,
    fixedAllowances: (emp.fixedAllowances ?? []).map((a) => ({
      name: a.name,
      amount: String(a.amount),
    })),
    resignDate: emp.resignDate ?? '',
  };
}

export function carryInFromEmployee(emp: Employee): CarryInFormState {
  const c = carryInOf(emp);
  if (!c) return emptyCarryIn();
  return {
    enabled: true,
    gross: String(c.gross),
    epf: String(c.epf),
    socso: String(c.socso),
    pcb: String(c.pcb),
    note: c.note ?? '',
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUM_RE = /^\d+(\.\d{1,2})?$/;
/** Malaysian NRIC: YYMMDD-PB-#### (dashes optional on input). */
const IC_RE = /^\d{6}-?\d{2}-?\d{4}$/;

/**
 * Mask an NRIC for non-HR viewers — only the last two digits stay visible
 * (e.g. 900101-14-5566 → ***-**-**66). Passports get the same treatment.
 */
export function maskIc(ic: string): string {
  const digits = ic.replace(/\D/g, '');
  if (digits.length < 2) return '••••';
  return `***-**-**${digits.slice(-2)}`;
}

/** Mask a bank account number for non-HR viewers, showing only the last 4 digits. */
export function maskAccount(account: string): string {
  const digits = account.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

/**
 * Duplicate detector for add/edit: finds another employee already using the
 * same NRIC or email (case-insensitive). `excludeId` skips the record being
 * edited. Returns the clashing field and the other employee's name.
 */
export function findDuplicate(
  employees: Employee[],
  form: EmployeeFormState,
  excludeId?: string,
): { field: 'ic' | 'email'; name: string } | null {
  const ic = form.ic.trim().toLowerCase();
  const email = form.email.trim().toLowerCase();
  for (const e of employees) {
    if (excludeId && e.id === excludeId) continue;
    if (ic && e.ic.trim().toLowerCase() === ic) return { field: 'ic', name: e.name };
    if (email && e.email.trim().toLowerCase() === email) return { field: 'email', name: e.name };
  }
  return null;
}

/** Validates required fields. `step` scopes validation for the wizard. */
export function validateForm(
  form: EmployeeFormState,
  step?: 'personal' | 'employment' | 'statutory' | 'bank',
): FormErrors {
  const errors: FormErrors = {};
  const inStep = (...steps: NonNullable<typeof step>[]) => !step || steps.includes(step);

  if (inStep('personal')) {
    if (!form.name.trim()) errors.name = 'Full name is required';
    if (!form.ic.trim()) errors.ic = 'NRIC / passport no. is required';
    else if (!form.isForeignWorker && !IC_RE.test(form.ic.trim()))
      errors.ic = 'Enter NRIC as ######-##-#### (passports: tick Foreign worker)';
    if (!form.email.trim()) errors.email = 'Email is required';
    else if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Enter a valid email address';
    if (!form.phone.trim()) errors.phone = 'Phone number is required';
    if (!form.dateOfBirth) errors.dateOfBirth = 'Date of birth is required';
    else {
      const dob = new Date(`${form.dateOfBirth}T00:00:00`);
      if (Number.isNaN(dob.getTime())) errors.dateOfBirth = 'Invalid date';
      else if (dob >= new Date()) errors.dateOfBirth = 'Date of birth must be in the past';
    }
  }

  if (inStep('employment')) {
    if (!form.departmentId) errors.departmentId = 'Select a department';
    if (!form.positionId) errors.positionId = 'Select a position';
    if (!form.joinDate) errors.joinDate = 'Join date is required';
    if (!form.baseSalary.trim()) errors.baseSalary = 'Base salary is required';
    else if (!NUM_RE.test(form.baseSalary.trim())) errors.baseSalary = 'Enter a valid amount';
    else if (Number(form.baseSalary.trim()) <= 0) errors.baseSalary = 'Salary must be greater than zero';
    if (form.status === 'resigned') {
      // A resigned employee with no date vanishes from payroll incl. their final month.
      if (!form.resignDate) errors.resignDate = 'Resignation date is required when status is Resigned';
      else if (form.joinDate && form.resignDate < form.joinDate)
        errors.resignDate = 'Resignation date cannot precede join date';
    }
    if (form.children.trim() && !/^\d+$/.test(form.children.trim()))
      errors.children = 'Whole number of children';
    form.fixedAllowances.forEach((a, i) => {
      if (!a.name.trim()) errors[`allowance-${i}`] = 'Allowance name required';
      else if (!NUM_RE.test(a.amount.trim())) errors[`allowance-${i}`] = 'Valid amount required';
    });
  }

  if (inStep('statutory')) {
    // Malaysian citizens/PR must be EPF members — block the wizard gate without it.
    if (!form.isForeignWorker && !form.epfNo.trim())
      errors.statutory = 'EPF / KWSP member no. is required for Malaysian employees';
  }

  if (inStep('bank')) {
    if (!form.bankName.trim()) errors.bankName = 'Bank name is required';
    if (!form.bankAccount.trim()) errors.bankAccount = 'Account number is required';
  }

  return errors;
}

/**
 * Validates TP3 carry-in amounts — non-blank entries must be plain numbers so
 * nothing is silently stored as NaN/0 (e.g. "12,000" is rejected, not zeroed).
 */
export function validateCarryIn(carryIn: CarryInFormState): FormErrors {
  const errors: FormErrors = {};
  if (!carryIn.enabled) return errors;
  (['gross', 'epf', 'socso', 'pcb'] as const).forEach((k) => {
    const v = carryIn[k].trim();
    if (v === '') return; // blank is treated as 0 — allowed
    if (!NUM_RE.test(v)) errors[`carryIn-${k}`] = 'Enter a valid amount (digits only, e.g. 12000.00)';
  });
  return errors;
}

/**
 * True when a monthly salary sits below the MWO 2024 floor. The order covers
 * full-time and contract staff, and part-time staff on a pro-rated basis.
 */
export function belowMinimumWage(monthlySalary: number): boolean {
  return Number.isFinite(monthlySalary) && monthlySalary > 0 && monthlySalary < MINIMUM_WAGE;
}

/** Non-blocking minimum-wage warning (MWO 2024), or null. */
export function minimumWageWarning(form: EmployeeFormState): string | null {
  const salary = Number(form.baseSalary);
  if (!belowMinimumWage(salary)) return null;
  const mw = `RM ${MINIMUM_WAGE.toLocaleString('en-MY')}`;
  if (form.employmentType === 'part-time') {
    return `Part-time pay is below the ${mw} monthly minimum wage. MWO 2024 applies to part-timers pro-rated by agreed hours — verify the hourly equivalent complies.`;
  }
  return `Base salary is below the ${mw} national minimum wage (Minimum Wages Order 2024).`;
}

/** Convert validated form state to a persistable Employee (without id). */
export function employeeFromForm(
  form: EmployeeFormState,
  carryIn: CarryInFormState,
  /** The record being edited, if any — preserves the original TP3 tax year. */
  previous?: Employee,
): Omit<Employee, 'id'> {
  const base: Omit<Employee, 'id'> = {
    name: form.name.trim(),
    ic: form.ic.trim(),
    email: form.email.trim().toLowerCase(),
    phone: form.phone.trim(),
    departmentId: form.departmentId,
    positionId: form.positionId,
    role: form.role,
    joinDate: form.joinDate,
    state: form.state,
    employmentType: form.employmentType,
    status: form.status,
    baseSalary: Math.round(Number(form.baseSalary) * 100) / 100,
    maritalStatus: form.maritalStatus,
    children: Math.max(0, parseInt(form.children.trim() || '0', 10) || 0),
    bankName: form.bankName.trim(),
    bankAccount: form.bankAccount.trim(),
    epfNo: form.epfNo.trim(),
    socsoNo: form.socsoNo.trim(),
    taxNo: form.taxNo.trim(),
    isForeignWorker: form.isForeignWorker,
    dateOfBirth: form.dateOfBirth,
    gender: form.gender,
    fixedAllowances: form.fixedAllowances
      .filter((a) => a.name.trim())
      .map((a) => ({ name: a.name.trim(), amount: Math.round(Number(a.amount) * 100) / 100 })),
    // db.update is a shallow merge — always emit the key so a stale resignDate
    // is explicitly cleared on reactivation (undefined is dropped on save).
    resignDate: form.status === 'resigned' && form.resignDate ? form.resignDate : undefined,
  };

  // Same merge caveat for ytdCarryIn — always emit the key so toggling TP3 off
  // clears the stored figures. Year is preserved on edit (December hires keep
  // their original YA); it defaults to the current year only on create.
  if (carryIn.enabled) {
    const ytd: YTDCarryIn = {
      year: (previous ? carryInOf(previous)?.year : undefined) ?? new Date().getFullYear(),
      gross: Number(carryIn.gross) || 0,
      epf: Number(carryIn.epf) || 0,
      socso: Number(carryIn.socso) || 0,
      pcb: Number(carryIn.pcb) || 0,
      ...(carryIn.note.trim() ? { note: carryIn.note.trim() } : {}),
    };
    return { ...base, ytdCarryIn: ytd } as Omit<Employee, 'id'>;
  }
  return { ...base, ytdCarryIn: undefined } as Omit<Employee, 'id'>;
}

/** Malaysian bank list for the bank-name datalist. */
export const MY_BANKS = [
  'Maybank',
  'CIMB Bank',
  'Public Bank',
  'RHB Bank',
  'Hong Leong Bank',
  'AmBank',
  'Bank Islam',
  'Bank Rakyat',
  'OCBC Bank',
  'HSBC Bank',
  'Standard Chartered',
  'UOB Malaysia',
  'Alliance Bank',
  'Affin Bank',
  'GXBank',
];
