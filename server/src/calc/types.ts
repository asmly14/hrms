/**
 * ⚠️ SYNC SUBSET — payroll-relevant entity types copied verbatim from
 * hrms-web/src/lib/types.ts (self-contained; no imports). The server persists
 * documents as JSONB, so these are compile-time shapes only. Keep in sync with
 * the web types when the engine starts consuming new fields.
 */

export type StateCode =
  | 'JHR' | 'KDH' | 'KTN' | 'MLK' | 'NSB' | 'PHG' | 'PNG' | 'PRK'
  | 'PLS' | 'SBH' | 'SWK' | 'SGR' | 'TRG' | 'KUL' | 'LBN' | 'PJY';

export type EmploymentType = 'full-time' | 'part-time' | 'contract';
export type EmployeeStatus = 'active' | 'probation' | 'resigned';
export type MaritalStatus = 'single' | 'married' | 'divorced' | 'widowed';
export type Gender = 'male' | 'female';
export type AccessRole = 'admin' | 'hr' | 'manager' | 'employee';

export interface FixedAllowance {
  name: string;
  amount: number; // RM per month, fixed allowances are EPF/SOCSO/HRD-able
}

/** TP3-style year-to-date figures from a previous employer (same year of assessment). */
export interface YTDCarryIn {
  year: number;
  gross: number;
  epf: number;
  socso: number;
  pcb: number;
  note?: string;
}

export interface Employee {
  id: string;
  employeeNo?: string;
  name: string;
  ic: string;
  email: string;
  phone: string;
  departmentId: string;
  positionId: string;
  role: AccessRole;
  joinDate: string;       // ISO date
  state: StateCode;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  baseSalary: number;     // RM monthly
  maritalStatus: MaritalStatus;
  children: number;
  bankName: string;
  bankAccount: string;
  epfNo: string;
  socsoNo: string;
  taxNo: string;
  isForeignWorker: boolean;
  dateOfBirth: string;    // ISO date
  gender: Gender;
  fixedAllowances: FixedAllowance[];
  resignDate?: string;
  ytdCarryIn?: YTDCarryIn;
}

export type OTDayType = 'normal' | 'rest' | 'holiday';

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  date: string;           // ISO date
  shiftId?: string;
  clockIn?: string;
  clockOut?: string;
  status: 'present' | 'absent' | 'leave' | 'rest-day' | 'holiday' | 'half-day';
  otHours: number;
  otDayType: OTDayType;
  otApproved: boolean;
  notes?: string;
}

export type LeaveType =
  | 'annual' | 'sick' | 'hospitalization' | 'maternity'
  | 'paternity' | 'unpaid' | 'emergency' | 'compassionate';

export interface LeaveRequest {
  id: string;
  employeeId: string;
  type: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  appliedAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface Claim {
  id: string;
  employeeId: string;
  category: 'travel' | 'meal' | 'medical' | 'parking' | 'telephone' | 'training' | 'other';
  title: string;
  amount: number;
  claimDate: string;
  receiptName?: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid';
  submittedAt?: string;
  decidedBy?: string;
  decidedAt?: string;
  paidInRunId?: string;
}

export interface PayrollRun {
  id: string;
  monthKey: string;       // 'YYYY-MM'
  status: 'draft' | 'finalized';
  runAt: string;
  runBy: string;
  employeeCount: number;
  totalGross: number;
  totalNet: number;
  totalEmployerCost: number;
  warnings: string[];
  /** Proration basis used for this run (absent on legacy runs = 'calendar'). */
  prorationMethod?: PayrollProrationMethod;
  /** ISO datetime when a draft run was finalized (absent while still draft). */
  finalizedAt?: string;
}

export type PayrollProrationMethod = 'calendar' | 'working-days' | 'fixed-26';

/** Preset ad-hoc adjustment types offered by the per-employee payslip editor. */
export type AdjustmentPreset = 'cp38' | 'zakat' | 'ptptn' | 'custom';

export interface PayslipAdjustment {
  id: string;
  kind: 'earning' | 'deduction';
  preset: AdjustmentPreset;
  label: string;
  amount: number;
}

export type PayslipLineKind = 'earning' | 'deduction' | 'employer' | 'info';

export interface PayslipLine {
  label: string;
  amount: number;
  kind: PayslipLineKind;
  nonStatutory?: boolean;
}

export interface Payslip {
  id: string;
  runId: string;
  employeeId: string;
  monthKey: string;
  basicPay: number;
  unpaidLeaveDeduction: number;
  otPay: number;
  otHours: number;
  allowances: number;
  claimsTotal: number;
  grossPay: number;
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  socsoCategory: 1 | 2;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  hrdLevy: number;
  netPay: number;
  employerCost: number;
  lines: PayslipLine[];
  ytd: { gross: number; epf: number; socso: number; pcb: number; net: number };
  // ── Proration transparency (absent on legacy payslips) ──
  daysWorked?: number;
  daysInBasis?: number;
  prorationMethod?: PayrollProrationMethod;
  prorationFactor?: number;
  // ── Ad-hoc editor adjustments (draft runs) ──
  adjustments?: PayslipAdjustment[];
  adjustmentEarnings?: number;
  adjustmentDeductions?: number;
}

export interface Holiday {
  id: string;
  date: string;           // ISO date
  name: string;
  nameMs?: string;
  states: StateCode[] | 'ALL';
  except?: StateCode[];
  isCompulsoryEA: boolean;
  tentative: boolean;
  source?: string;
  isOverride?: boolean;
  replacesDate?: string;
}

export interface AuditLog {
  id: string;
  at: string;             // ISO datetime
  actorId?: string;
  actorName: string;
  action: string;
  entity: string;
  entityId?: string;
  detail?: string;
}
