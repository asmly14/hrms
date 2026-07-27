/**
 * M2-local types.
 *
 * WAVE 2 NOTE: the core agent adds `ytdCarryIn?: YTDCarryIn` to the core
 * `Employee` interface in src/lib/types.ts this wave. This local mirror keeps
 * the module compiling regardless of landing order — the shapes are identical
 * and localStorage is schemaless, so records interoperate either way. Once the
 * core export is confirmed in the integration wave, `YTDCarryIn` here can be
 * replaced by a re-export from '@/lib/types'.
 */
import type { Employee } from '@/lib/types';

/** TP3-style year-to-date figures from a previous employer (same YA). */
export interface YTDCarryIn {
  year: number;       // tax year the figures belong to
  gross: number;      // RM — YTD gross remuneration from prior employer(s)
  epf: number;        // RM — YTD employee EPF deducted
  socso: number;      // RM — YTD employee SOCSO + EIS deducted
  pcb: number;        // RM — YTD PCB/MTD already deducted
  note?: string;      // e.g. prior employer name
}

/** Employee as stored, possibly carrying the M2-added ytdCarryIn property. */
export type EmployeeRecord = Employee & {
  ytdCarryIn?: YTDCarryIn;
  /** Company-defined custom field values, keyed by field id
   *  (Company.config.customFields — built in /company, rendered below). */
  custom?: Record<string, unknown>;
};

/** Read the optional carry-in safely from any Employee-shaped object. */
export function carryInOf(emp: Employee): YTDCarryIn | undefined {
  return (emp as EmployeeRecord).ytdCarryIn;
}

/** Read company-defined custom field values safely ({} when absent). */
export function customOf(emp: Employee): Record<string, unknown> {
  const c = (emp as EmployeeRecord).custom;
  return c && typeof c === 'object' ? c : {};
}

/** Form state for add/edit + wizard (numbers kept as strings for inputs). */
export interface AllowanceForm {
  name: string;
  amount: string;
}

export interface EmployeeFormState {
  name: string;
  ic: string;
  email: string;
  phone: string;
  departmentId: string;
  positionId: string;
  role: Employee['role'];
  joinDate: string;
  state: Employee['state'];
  employmentType: Employee['employmentType'];
  status: Employee['status'];
  baseSalary: string;
  maritalStatus: Employee['maritalStatus'];
  children: string;
  bankName: string;
  bankAccount: string;
  epfNo: string;
  socsoNo: string;
  taxNo: string;
  isForeignWorker: boolean;
  dateOfBirth: string;
  gender: Employee['gender'];
  fixedAllowances: AllowanceForm[];
  resignDate: string;
}

export interface CarryInFormState {
  enabled: boolean;
  gross: string;
  epf: string;
  socso: string;
  pcb: string;
  note: string;
}

export type FormErrors = Partial<Record<string, string>>;
