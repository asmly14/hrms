/**
 * Core entity types for MY HRMS.
 * Contract: docs/architecture.md — module agents code against these types only.
 * All IDs are strings (uid() in db.ts wraps crypto.randomUUID()).
 * Dates are ISO strings: 'YYYY-MM-DD' for dates, 'YYYY-MM' for monthKeys.
 */

/** Malaysian state / federal-territory codes (16 jurisdictions). */
export type StateCode =
  | 'JHR' | 'KDH' | 'KTN' | 'MLK' | 'NSB' | 'PHG' | 'PNG' | 'PRK'
  | 'PLS' | 'SBH' | 'SWK' | 'SGR' | 'TRG' | 'KUL' | 'LBN' | 'PJY';

export type EmploymentType = 'full-time' | 'part-time' | 'contract';
export type EmployeeStatus = 'active' | 'probation' | 'resigned';
export type MaritalStatus = 'single' | 'married' | 'divorced' | 'widowed';
export type Gender = 'male' | 'female';
/** System access role (drives nav visibility via roleContext). */
export type AccessRole = 'admin' | 'hr' | 'manager' | 'employee';

// ─────────────────────────────────────────────────────────────────────────────
// Multi-tenant: Company (tenant) entity + per-company configuration
// ─────────────────────────────────────────────────────────────────────────────

export type CompanyStatus = 'active' | 'suspended' | 'trial';
export type CompanyPlan = 'free' | 'pro' | 'enterprise';
/** Weekend pattern; defaults by HQ state (fri-sat for JHR/KDH/KTN/TRG). */
export type WorkingWeek = 'sat-sun' | 'fri-sat';

/** Feature modules a company may toggle on/off. */
export type ModuleKey =
  | 'attendance' | 'leave' | 'claims' | 'payroll'
  | 'kpi' | 'insights' | 'reports' | 'onboarding' | 'offboarding';

/** Admin-defined extra field on the Employee record. */
export interface CustomField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  options?: string[];       // required when type === 'select'
  appliesTo: 'employee';    // extensible later ('department', …)
}

/** Claim policy overrides (RM amounts); unset fields fall back to module defaults. */
export interface CompanyClaimPolicyOverride {
  mileageRatePerKm?: number;
  mealDailyLimit?: number;
  medicalClaimLimit?: number;
  phoneMonthlyLimit?: number;
}

/** Bonus leave days per type, granted on top of EA 1955 statutory tiers. */
export interface CompanyLeaveTopUps {
  annual?: number;
  sick?: number;
  hospitalization?: number;
  maternity?: number;
  paternity?: number;
}

/** Document/ID numbering conventions. */
export interface NumberFormats {
  /** Prefix for generated employee numbers, e.g. 'ASM' → ASM0007. */
  employeeIdPrefix: string;
  /** Prefix for payslip document numbers, e.g. 'ASM-PS'. */
  payslipPrefix: string;
}

export interface OrgChartSettings {
  /** Show assistant/co-report dashed lines (cosmetic hint for the org chart UI). */
  showDottedLineReports: boolean;
}

/**
 * Per-company customization. Every field is optional at the storage layer so
 * older tenants keep working when new knobs are added; readers merge over
 * system defaults (see lib/appSettings.ts).
 */
export interface CompanyConfig {
  workingWeek: WorkingWeek;
  /** Day of month (1–28) when attendance/OT/claims close for payroll. */
  payrollCutoffDay: number;
  claimPolicy: CompanyClaimPolicyOverride;
  leaveTopUps: CompanyLeaveTopUps;
  enabledModules: ModuleKey[];
  customFields: CustomField[];
  numberFormats: NumberFormats;
  orgChart: OrgChartSettings;
}

/** Visual identity shown in the app shell / payslips. */
export interface CompanyBranding {
  logoText: string;         // short mark, e.g. 'ASM'
  accentColor: string;      // hex color, e.g. '#b45309'
}

/**
 * A tenant. Companies live in the GLOBAL storage key `myhrms:companies`
 * (see lib/db.ts); all operational collections are physically namespaced per
 * company under `myhrms:t:<companyId>:<collection>`.
 */
export interface Company {
  id: string;               // e.g. 'co-asm'
  code: string;             // short unique code, e.g. 'ASM'
  name: string;
  regNo: string;            // SSM registration number
  hqState: StateCode;
  status: CompanyStatus;
  plan: CompanyPlan;
  createdAt: string;        // ISO datetime
  branding: CompanyBranding;
  config: CompanyConfig;
}

export interface FixedAllowance {
  name: string;
  amount: number; // RM per month, fixed allowances are EPF/SOCSO/HRD-able
}

/**
 * TP3-style year-to-date figures from a previous employer (same year of
 * assessment). Captured by the Employees new-hire wizard; consumed by
 * payrollEngine to seed the PCB annualization basis for the first recorded
 * run of the year instead of assuming the current package since January.
 */
export interface YTDCarryIn {
  year: number;       // tax year the figures belong to
  gross: number;      // RM — YTD gross remuneration from prior employer(s)
  epf: number;        // RM — YTD employee EPF deducted
  socso: number;      // RM — YTD employee SOCSO + EIS deducted
  pcb: number;        // RM — YTD PCB/MTD already deducted
  note?: string;      // e.g. prior employer name
}

export interface Employee {
  id: string;
  /** Human-facing staff number (company-scoped), e.g. 'ASM0007'. Generated via
   *  nextEmployeeNo(companyId) using the company's numberFormats.employeeIdPrefix.
   *  Optional for backwards compatibility with pre-multitenant records. */
  employeeNo?: string;
  name: string;
  ic: string;             // NRIC / passport no.
  email: string;
  phone: string;
  departmentId: string;
  positionId: string;
  role: AccessRole;
  joinDate: string;       // ISO date
  state: StateCode;       // work location — drives holidays & weekend rule
  employmentType: EmploymentType;
  status: EmployeeStatus;
  baseSalary: number;     // RM monthly
  maritalStatus: MaritalStatus;
  children: number;       // count of eligible children (PCB relief RM2,000 each)
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
  /** TP3 prior-employer YTD carry-in (see YTDCarryIn) — seeds PCB/YTD chains. */
  ytdCarryIn?: YTDCarryIn;
}

export type AttendanceStatus =
  | 'present' | 'absent' | 'leave' | 'rest-day' | 'holiday' | 'half-day';

export type OTDayType = 'normal' | 'rest' | 'holiday';

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  date: string;           // ISO date
  shiftId?: string;
  clockIn?: string;       // 'HH:mm'
  clockOut?: string;      // 'HH:mm'
  status: AttendanceStatus;
  otHours: number;        // hours beyond normal
  otDayType: OTDayType;   // rate multiplier bucket for the OT
  otApproved: boolean;    // only approved OT is paid by payrollEngine
  notes?: string;
}

export interface Shift {
  id: string;
  name: string;
  startTime: string;      // 'HH:mm'
  endTime: string;        // 'HH:mm' (may cross midnight)
  breakMinutes: number;
  workDays: number[];     // 0=Sun … 6=Sat
  restDay: number;        // statutory weekly rest day (EA 1955 s.59)
}

export type LeaveType =
  | 'annual' | 'sick' | 'hospitalization' | 'maternity'
  | 'paternity' | 'unpaid' | 'emergency' | 'compassionate';

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LeaveRequest {
  id: string;
  employeeId: string;
  type: LeaveType;
  startDate: string;      // ISO date
  endDate: string;        // ISO date
  days: number;           // working/calendar days per company policy
  reason?: string;
  status: LeaveStatus;
  appliedAt: string;      // ISO date
  decidedBy?: string;
  decidedAt?: string;
}

/** Annual entitlement snapshot per employee per year (EA 1955 s.60E/60F tiers). */
export interface LeaveBalance {
  id: string;
  employeeId: string;
  year: number;
  annualEntitled: number;   // 8 / 12 / 16 by service tier
  annualUsed: number;
  sickEntitled: number;     // 14 / 18 / 22
  sickUsed: number;
  hospitalizationEntitled: number; // 60 aggregate (incl. sick days used for hosp.)
  hospitalizationUsed: number;
  carriedForward: number;   // days carried from last year (policy)
}

export type ClaimCategory =
  | 'travel' | 'meal' | 'medical' | 'parking' | 'telephone' | 'training' | 'other';

export type ClaimStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid';

export interface Claim {
  id: string;
  employeeId: string;
  category: ClaimCategory;
  title: string;
  amount: number;
  claimDate: string;      // ISO date of expense
  receiptName?: string;   // file label only — no binary storage
  status: ClaimStatus;
  submittedAt?: string;
  decidedBy?: string;
  decidedAt?: string;
  paidInRunId?: string;   // set when reimbursed via a payroll run
}

export type PayrollRunStatus = 'draft' | 'finalized';

export interface PayrollRun {
  id: string;
  monthKey: string;       // 'YYYY-MM'
  status: PayrollRunStatus;
  runAt: string;          // ISO datetime
  runBy: string;
  employeeCount: number;
  totalGross: number;
  totalNet: number;
  totalEmployerCost: number;
  warnings: string[];     // e.g. below-minimum-wage, OT > 104h
}

export type PayslipLineKind = 'earning' | 'deduction' | 'employer' | 'info';

export interface PayslipLine {
  label: string;
  amount: number;
  kind: PayslipLineKind;
  /** true = excluded from EPF/SOCSO/EIS/PCB wage bases (e.g. claim reimbursements). */
  nonStatutory?: boolean;
}

export interface Payslip {
  id: string;
  runId: string;
  employeeId: string;
  monthKey: string;       // 'YYYY-MM'
  basicPay: number;       // after unpaid-leave proration
  unpaidLeaveDeduction: number;
  otPay: number;
  otHours: number;
  allowances: number;     // fixed allowances total
  claimsTotal: number;    // non-statutory reimbursements
  grossPay: number;       // basicPay + otPay + allowances (claims excluded)
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  socsoCategory: 1 | 2;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  hrdLevy: number;        // employer-only
  netPay: number;         // grossPay − employee statutory − pcb + claimsTotal
  employerCost: number;   // grossPay + employer statutory + hrdLevy + claimsTotal
  lines: PayslipLine[];
  ytd: { gross: number; epf: number; socso: number; pcb: number; net: number };
}

export type KPIStatus = 'active' | 'completed' | 'archived';

export interface KPI {
  id: string;
  employeeId: string;
  title: string;
  description?: string;
  weight: number;         // percent; per-employee KPIs should sum to 100
  target: string;         // human-readable target
  unit?: string;
  period: string;         // e.g. '2026-H1'
  status: KPIStatus;
}

export type ReviewStatus = 'draft' | 'submitted' | 'acknowledged';

export interface KPIReview {
  id: string;
  employeeId: string;
  reviewerId: string;
  period: string;
  scores: { kpiId: string; score: number; comment?: string }[]; // score 0–100
  overallScore: number;   // weighted 0–100
  comments?: string;
  status: ReviewStatus;
  createdAt: string;      // ISO datetime
}

export interface Holiday {
  id: string;
  date: string;           // ISO date
  name: string;
  nameMs?: string;
  states: StateCode[] | 'ALL';
  except?: StateCode[];   // excluded jurisdictions when states === 'ALL'
  isCompulsoryEA: boolean;  // one of the 5 EA 1955 s.60D compulsory holidays
  tentative: boolean;       // moon-sighting / projected — pending official gazette
  source?: string;
  isOverride?: boolean;     // admin override stored in 'holidays' collection
  replacesDate?: string;    // set for replacement (in-lieu) holiday entries
}

export interface Department {
  id: string;
  name: string;
  code: string;
  headId?: string;        // employeeId
  state: StateCode;
}

export type PositionLevel = 'junior' | 'senior' | 'lead' | 'manager' | 'exec';

export interface Position {
  id: string;
  title: string;
  departmentId: string;
  level: PositionLevel;
  minSalary: number;
  maxSalary: number;
}

export interface Settings {
  id: string;             // singleton: 'company'
  companyName: string;
  companyRegNo: string;
  hqState: StateCode;
  address: string;
  epfEmployerNo: string;
  socsoEmployerNo: string;
  taxEmployerNo: string;
  paydayDay: number;      // day of month wages are paid (EA: ≤ 7th after wage period)
  standardDailyHours: number;  // default 8
  standardWeeklyHours: number; // default 45
}

export interface AuditLog {
  id: string;
  at: string;             // ISO datetime
  actorId?: string;
  actorName: string;
  action: string;         // e.g. 'payroll.run', 'employee.update'
  entity: string;         // collection name
  entityId?: string;
  detail?: string;
}
