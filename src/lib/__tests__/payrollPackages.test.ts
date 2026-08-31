/**
 * Payroll packages — kakitangan-style salary types (monthly/daily/hourly),
 * attendance-counted worked quantities, 'Full amount' basic overrides,
 * per-line statutory wage-base tags (pay-items catalog), statutory opt-outs,
 * and the preview-vs-persist parity guarantee of the draft editor.
 *
 * All figures hand-verified. Cut-off day 25 ⇒ the March 2026 run covers
 * 2026-02-26 → 2026-03-25 (inclusive) for attendance/claims.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { getCollection, saveCompanies, setCollection } from '../db';
import {
  previewPayslip, runPayroll, setPayslipAdjustments, updateDraftPayslip,
  workedDaysInPeriod, workedHoursInPeriod, payrollPeriodFor,
} from '../payrollEngine';
import { calcEPF, calcSOCSO, calcEIS, calcPCB, calcOT } from '../statutory';
import { PAY_ITEM_PRESETS, newEarningFromPreset, payItemPreset } from '../payItems';
import { round2 } from '../utils';
import type {
  AttendanceRecord, Company, Employee, PayslipAdjustment, PayslipEditInput,
  Settings, WageBaseTags,
} from '../types';

const MONTH = '2026-03'; // cut-off window: 2026-02-26 → 2026-03-25

function company(): Company {
  return {
    id: 'co-asm',
    code: 'ASM',
    name: 'ASM Tech Sdn Bhd',
    regNo: '202401000001',
    hqState: 'KUL',
    status: 'active',
    plan: 'pro',
    createdAt: '2026-01-01T00:00:00.000Z',
    branding: { logoText: 'ASM', accentColor: '#b45309' },
    config: {
      workingWeek: 'sat-sun',
      payrollCutoffDay: 25,
      payrollProration: 'calendar',
      claimPolicy: {},
      leaveTopUps: {},
      enabledModules: ['payroll'],
      customFields: [],
      numberFormats: { employeeIdPrefix: 'ASM', payslipPrefix: 'ASM-PS' },
      orgChart: { showDottedLineReports: false },
    },
  };
}

function mkEmp(id: string, over: Partial<Employee> = {}): Employee {
  return {
    id,
    name: `Employee ${id}`,
    ic: '900101-01-1234',
    email: `${id}@test.my`,
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
    ...over,
  };
}

function seed(employees: Employee[], extra?: { attendance?: AttendanceRecord[]; settings?: Settings[] }): void {
  saveCompanies([company()]);
  setCollection('employees', employees);
  setCollection('attendance', extra?.attendance ?? []);
  setCollection('leaves', []);
  setCollection('claims', []);
  setCollection('settings', extra?.settings ?? []);
  setCollection('payrollRuns', []);
  setCollection('payslips', []);
  setCollection('audit', []);
}

beforeEach(() => {
  installLocalStorage();
});

/** Attendance inside the March cut-off window exercising every counting rule. */
const WINDOW_ATTENDANCE: AttendanceRecord[] = [
  { id: 'a1', employeeId: 'e-1', date: '2026-03-02', status: 'present', otHours: 0, otDayType: 'normal', otApproved: false },
  { id: 'a2', employeeId: 'e-1', date: '2026-03-03', status: 'present', otHours: 0, otDayType: 'normal', otApproved: false },
  { id: 'a3', employeeId: 'e-1', date: '2026-03-04', status: 'half-day', otHours: 0, otDayType: 'normal', otApproved: false },
  { id: 'a4', employeeId: 'e-1', date: '2026-03-05', status: 'absent', otHours: 0, otDayType: 'normal', otApproved: false },
  { id: 'a5', employeeId: 'e-1', date: '2026-03-06', status: 'leave', otHours: 0, otDayType: 'normal', otApproved: false },
  // Rest-day record carrying approved OT: counts 1 worked day; OT pays separately.
  { id: 'a6', employeeId: 'e-1', date: '2026-03-07', status: 'rest-day', otHours: 4, otDayType: 'rest', otApproved: true },
  // Outside the cut-off window (before 2026-02-26) — never counted.
  { id: 'a7', employeeId: 'e-1', date: '2026-02-20', status: 'present', otHours: 0, otDayType: 'normal', otApproved: false },
];

// ─────────────────────────────────────────────────────────────────────────────
// Attendance counting rule
// ─────────────────────────────────────────────────────────────────────────────

describe('attendance counting for daily/hourly salary types', () => {
  it('worked days: present = 1, half-day = 0.5, rest-day with approved OT = 1, absent/leave = 0; outside window excluded', () => {
    const period = payrollPeriodFor(MONTH, 25);
    expect(period).toEqual({ start: '2026-02-26', end: '2026-03-25', cutoffDay: 25 });
    expect(workedDaysInPeriod(WINDOW_ATTENDANCE, 'e-1', period)).toBe(3.5);
  });

  it('worked base hours: present = standard hours, half-day = half; OT hours never base hours', () => {
    const period = payrollPeriodFor(MONTH, 25);
    expect(workedHoursInPeriod(WINDOW_ATTENDANCE, 'e-1', period, 8)).toBe(20); // 8 + 8 + 4
    expect(workedHoursInPeriod(WINDOW_ATTENDANCE, 'e-1', period, 9)).toBe(22.5); // 9 + 9 + 4.5
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Daily / hourly computation from attendance
// ─────────────────────────────────────────────────────────────────────────────

describe('runPayroll — daily & hourly salary types', () => {
  it('daily: basic = dailyRate × counted days; OT rated at dailyRate ÷ 8; rest-day OT day counts', () => {
    seed([mkEmp('e-1', { salaryType: 'daily', dailyRate: 100 })], { attendance: WINDOW_ATTENDANCE });
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.salaryTypeUsed).toBe('daily');
    expect(p.rateUsed).toBe(100);
    expect(p.workedQty).toBe(3.5);
    expect(p.workedUnit).toBe('day');
    expect(p.basicPay).toBe(350); // 100 × 3.5
    // OT: 4h rest-day at hrp = 100 ÷ 8 = 12.5 → 12.5 × 4 × 2 = 100
    expect(p.otPay).toBe(calcOT(12.5, 4, 'rest'));
    expect(p.otPay).toBe(100);
    expect(p.grossPay).toBe(450);
    // Wage bases: EPF excludes OT; SOCSO/EIS include it.
    expect(p.epfBase).toBe(350);
    expect(p.socsoBase).toBe(450);
    expect(p.eisBase).toBe(450);
    // Transparency line.
    expect(p.lines.some((l) => l.kind === 'info' && l.label.startsWith('Worked: 3.5 day(s)'))).toBe(true);
    // No unpaid-leave deduction machinery for daily-rated staff.
    expect(p.unpaidLeaveDeduction).toBe(0);
  });

  it('hourly: basic = hourlyRate × counted base hours; approved OT pays via the OT mechanism (never double-paid)', () => {
    seed([mkEmp('e-1', { salaryType: 'hourly', hourlyRate: 20 })], { attendance: WINDOW_ATTENDANCE });
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.workedQty).toBe(20); // 2 × 8 + 4 (half-day)
    expect(p.workedUnit).toBe('hour');
    expect(p.basicPay).toBe(400); // 20 × 20
    expect(p.otPay).toBe(calcOT(20, 4, 'rest')); // hrp = the hourly rate itself
    expect(p.otPay).toBe(160);
    expect(p.grossPay).toBe(560);
  });

  it('fallback rates derive from baseSalary (÷26 daily, ÷26÷8 hourly)', () => {
    seed([mkEmp('e-1', { salaryType: 'daily', baseSalary: 2600 })], { attendance: WINDOW_ATTENDANCE });
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.rateUsed).toBe(100); // 2600 ÷ 26
    expect(p.basicPay).toBe(350);

    seed([mkEmp('e-1', { salaryType: 'hourly', baseSalary: 2600 })], { attendance: WINDOW_ATTENDANCE });
    const h = runPayroll(MONTH).payslips[0]!;
    expect(h.rateUsed).toBe(12.5); // 2600 ÷ 26 ÷ 8
    expect(h.basicPay).toBe(250); // 12.5 × 20
  });

  it('standard daily hours come from Settings (9h day)', () => {
    const settings: Settings = {
      id: 'company',
      companyName: 'ASM Tech',
      companyRegNo: '202401000001',
      hqState: 'KUL',
      address: '',
      epfEmployerNo: '',
      socsoEmployerNo: '',
      taxEmployerNo: '',
      paydayDay: 7,
      standardDailyHours: 9,
      standardWeeklyHours: 45,
    };
    seed([mkEmp('e-1', { salaryType: 'hourly', hourlyRate: 10 })], { attendance: WINDOW_ATTENDANCE, settings: [settings] });
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.workedQty).toBe(22.5); // 9 + 9 + 4.5
    expect(p.basicPay).toBe(225);
  });

  it('mid-month joiner on daily rate: allowances prorate by the employment window, basic stays attendance-based', () => {
    seed([
      mkEmp('e-1', {
        salaryType: 'daily',
        dailyRate: 100,
        joinDate: '2026-03-10',
        fixedAllowances: [{ name: 'Transport', amount: 310 }],
      }),
    ], { attendance: WINDOW_ATTENDANCE });
    const p = runPayroll(MONTH).payslips[0]!;
    expect(p.basicPay).toBe(350); // attendance unchanged
    expect(p.prorationFactor).toBeCloseTo(22 / 31, 10); // employed 10–31 Mar
    expect(p.allowances).toBe(round2(310 * (22 / 31))); // 220.00
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-run overrides (draft editor)
// ─────────────────────────────────────────────────────────────────────────────

describe('draft editor — salary type / rate / worked-quantity overrides', () => {
  it('switch a monthly employee to daily for one run, with rate + worked-qty overrides', () => {
    seed([mkEmp('e-1')]); // monthly RM3,000
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });

    const slip = updateDraftPayslip(run.id, 'e-1', {
      salaryType: 'daily',
      rate: 150,
      workedQty: 10,
    }, 'hr-admin')!;

    expect(slip.salaryTypeUsed).toBe('daily');
    expect(slip.rateUsed).toBe(150);
    expect(slip.workedQty).toBe(10);
    expect(slip.basicPay).toBe(1500);
    // Override markers persisted for the editor's round-trip.
    expect(slip.salaryTypeOverride).toBe('daily');
    expect(slip.rateOverride).toBe(150);
    expect(slip.workedQtyOverride).toBe(10);
    // The employee record itself is untouched — next run reverts to monthly.
    const rerun = runPayroll('2026-04', undefined, 'hr-admin').payslips[0]!;
    expect(rerun.salaryTypeUsed).toBe('monthly');
    expect(rerun.basicPay).toBe(3000);
  });

  it("monthly 'Worked: N month(s)' override bypasses joiner/leaver proration", () => {
    seed([mkEmp('e-1', { joinDate: '2026-03-10' })]); // would prorate 22/31
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    expect(payslips[0]!.basicPay).toBe(round2(3000 * (22 / 31))); // prorated

    const slip = updateDraftPayslip(run.id, 'e-1', { workedQty: 1 }, 'hr-admin')!;
    expect(slip.basicPay).toBe(3000); // full month forced
    expect(slip.workedQty).toBe(1);
    expect(slip.lines.some((l) => l.label.includes('1 month(s) — overridden'))).toBe(true);

    const half = updateDraftPayslip(run.id, 'e-1', { workedQty: 0.5 }, 'hr-admin')!;
    expect(half.basicPay).toBe(1500); // 3000 × 0.5
  });

  it("'Full amount' basicOverride replaces the computed basic, is persisted, shown and audit-logged", () => {
    seed([mkEmp('e-1')]);
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });

    const slip = updateDraftPayslip(run.id, 'e-1', { basicOverride: 4000 }, 'hr-admin')!;
    expect(slip.basicPay).toBe(4000);
    expect(slip.basicOverride).toBe(4000);
    expect(slip.grossPay).toBe(4000);
    expect(slip.epfBase).toBe(4000);
    expect(slip.lines.some((l) => l.label === 'Basic salary (overridden)')).toBe(true);

    const audit = getCollection<{ action: string; detail?: string }>('audit');
    expect(audit.some((a) => a.action === 'payroll.payslip.adjust' && a.detail?.includes('basic overridden to 4000.00'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-line wage-base tags
// ─────────────────────────────────────────────────────────────────────────────

/** Draft-run helper: apply an edit to e-1 and return the slip. */
function editE1(runId: string, edit: PayslipEditInput) {
  const slip = updateDraftPayslip(runId, 'e-1', edit, 'hr-admin');
  expect(slip).not.toBeNull();
  return slip!;
}

describe('per-line statutory wage-base tags', () => {
  const earning = (partial: Partial<PayslipAdjustment>): PayslipAdjustment => ({
    id: partial.id ?? `adj-${Math.random()}`,
    kind: 'earning',
    preset: 'custom',
    label: 'Line',
    amount: 0,
    ...partial,
  });

  it('fixed allowance (all tags on): joins every base as normal remuneration', () => {
    seed([mkEmp('e-1')]);
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const p = editE1(run.id, {
      adjustments: [earning({ label: 'General allowance', amount: 200, tags: { epf: true, socso: true, eis: true, pcb: true } })],
    });
    expect(p.grossPay).toBe(3200);
    expect(p.epfBase).toBe(3200);
    expect(p.socsoBase).toBe(3200);
    expect(p.eisBase).toBe(3200);
    expect(p.pcbBase).toBe(3200); // normal remuneration, not the bonus mechanism
    expect(p.pcbAdditional).toBe(0);
    expect(p.epfEmployee).toBe(calcEPF(3200, 36, true, false).employee);
    expect(p.socsoEmployee).toBe(calcSOCSO(3200, 36).employee);
    expect(p.eisEmployee).toBe(calcEIS(3200, 36, true).employee);
  });

  it('bonus (EPF ✓ SOCSO ✗ EIS ✗ PCB ✓, additional remuneration): EPF base only + LHDN bonus mechanism', () => {
    seed([mkEmp('e-1')]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const base = payslips[0]!;
    const p = editE1(run.id, {
      adjustments: [earning({ label: 'Bonus', amount: 1000, tags: { epf: true, socso: false, eis: false, pcb: true }, additionalRemuneration: true })],
    });
    expect(p.grossPay).toBe(4000);
    expect(p.epfBase).toBe(4000);        // bonus is EPF-able
    expect(p.socsoBase).toBe(3000);      // …but not SOCSO/EIS-able
    expect(p.eisBase).toBe(3000);
    expect(p.pcbBase).toBe(3000);        // normal remuneration unchanged
    expect(p.pcbAdditional).toBe(1000);  // taxed via the aggregate delta
    expect(p.epfEmployee).toBe(calcEPF(4000, 36, true, false).employee);
    expect(p.socsoEmployee).toBe(base.socsoEmployee);
    expect(p.pcb).toBeGreaterThanOrEqual(base.pcb); // bonus PCB spike
  });

  it('manual OT (EPF ✗ SOCSO ✓ EIS ✓ PCB ✓): excluded from EPF only', () => {
    seed([mkEmp('e-1')]);
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const p = editE1(run.id, {
      adjustments: [earning({ label: 'Overtime (manual entry)', amount: 300, tags: { epf: false, socso: true, eis: true, pcb: true } })],
    });
    expect(p.epfBase).toBe(3000);
    expect(p.socsoBase).toBe(3300);
    expect(p.eisBase).toBe(3300);
    expect(p.pcbBase).toBe(3300);
    expect(p.pcbAdditional).toBe(0);
  });

  it('claims/reimbursement (all tags off, non-statutory): paid in net, outside gross and every base', () => {
    seed([mkEmp('e-1')]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const base = payslips[0]!;
    const p = editE1(run.id, {
      adjustments: [earning({ label: 'Toll reimbursement', amount: 150, tags: { epf: false, socso: false, eis: false, pcb: false }, nonStatutory: true })],
    });
    expect(p.grossPay).toBe(base.grossPay);       // gross untouched
    expect(p.adjustmentReimbursements).toBe(150);
    expect(p.adjustmentEarnings).toBe(0);
    expect(p.epfBase).toBe(base.epfBase);
    expect(p.socsoBase).toBe(base.socsoBase);
    expect(p.netPay).toBe(round2(base.netPay + 150)); // paid in net like claims
    expect(p.employerCost).toBe(round2(base.employerCost + 150));
    const line = p.lines.find((l) => l.label === 'Toll reimbursement')!;
    expect(line.nonStatutory).toBe(true);
  });

  it('BIK/VOLA (non-cash, PCB ✓ only): feeds the PCB base, never gross or net', () => {
    seed([mkEmp('e-1')]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const base = payslips[0]!;
    const p = editE1(run.id, {
      adjustments: [earning({ label: 'BIK — company car', amount: 500, tags: { epf: false, socso: false, eis: false, pcb: true }, nonStatutory: true, nonCash: true })],
    });
    expect(p.grossPay).toBe(base.grossPay);
    expect(p.adjustmentNonCash).toBe(500);
    expect(p.pcbBase).toBe(3500);          // TP2 valuation joins normal remuneration
    expect(p.pcbAdditional).toBe(0);
    expect(p.epfBase).toBe(3000);
    expect(p.netPay).toBeLessThanOrEqual(base.netPay); // only PCB can move it (down)
    const line = p.lines.find((l) => l.label === 'BIK — company car')!;
    expect(line.nonCash).toBe(true);
    expect(line.nonStatutory).toBe(true);
  });

  it('mixed tagged + untagged lines accumulate independently', () => {
    seed([mkEmp('e-1')]);
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const p = editE1(run.id, {
      adjustments: [
        earning({ id: 't1', label: 'Bonus', amount: 1000, tags: { epf: true, socso: false, eis: false, pcb: true }, additionalRemuneration: true }),
        earning({ id: 'u1', label: 'Legacy commission', amount: 500 }), // untagged
      ],
    });
    expect(p.grossPay).toBe(4500);
    expect(p.epfBase).toBe(4000);      // basic + tagged EPF-on only
    expect(p.socsoBase).toBe(3500);    // basic + untagged legacy
    expect(p.eisBase).toBe(3500);
    expect(p.pcbBase).toBe(3000);      // normal: basic only
    expect(p.pcbAdditional).toBe(1500); // tagged additional + untagged legacy
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backward compatibility of untagged (legacy) lines
// ─────────────────────────────────────────────────────────────────────────────

describe('backward compatibility — untagged adjustment lines', () => {
  it('legacy behaviour preserved: SOCSO/EIS ✓, EPF ✗, PCB via the legacy gross-inclusive bonus path', () => {
    // Mid-year-2026 hire → true zero YTD basis, so the exact legacy PCB is reproducible.
    seed([mkEmp('e-1', { joinDate: '2026-01-05' })]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const base = payslips[0]!;
    expect(base.grossPay).toBe(3000);

    const legacyLines: PayslipAdjustment[] = [
      { id: 'a1', kind: 'earning', preset: 'custom', label: 'Sales commission', amount: 500 },
    ];
    const p = setPayslipAdjustments(run.id, 'e-1', legacyLines, 'hr-admin')!;

    expect(p.grossPay).toBe(3500);
    expect(p.epfBase).toBe(3000);                       // untagged: never EPF
    expect(p.epfEmployee).toBe(base.epfEmployee);
    expect(p.socsoBase).toBe(3500);                     // legacy: gross feeds SOCSO/EIS
    expect(p.eisBase).toBe(3500);
    expect(p.socsoEmployee).toBe(calcSOCSO(3500, 36).employee);
    expect(p.eisEmployee).toBe(calcEIS(3500, 36, true).employee);
    // Exact legacy PCB: annualized on the gross AND the full 500 again as the
    // bonus delta (the pinned pre-tag behaviour — see git history).
    const expectedPcb = calcPCB(3500, { gross: 0, epf: 0, socso: 0, pcb: 0 }, {
      marital: 'single',
      children: 0,
      monthIndex: 3,
      bonus: 500,
      epfEmployee: p.epfEmployee,
      socsoEmployee: round2(p.socsoEmployee + p.eisEmployee),
    });
    expect(p.pcb).toBe(expectedPcb);
    expect(p.pcbBase).toBe(3500);
    expect(p.pcbAdditional).toBe(500);
    // Net identity intact.
    expect(p.netPay).toBe(round2(p.grossPay - p.epfEmployee - p.socsoEmployee - p.eisEmployee - p.pcb));
  });

  it('setPayslipAdjustments and updateDraftPayslip agree for the same untagged lines', () => {
    seed([mkEmp('e-1')]);
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const lines: PayslipAdjustment[] = [
      { id: 'a1', kind: 'earning', preset: 'custom', label: 'Commission', amount: 500 },
      { id: 'a2', kind: 'deduction', preset: 'cp38', label: 'Order', amount: 100 },
    ];
    const viaLegacy = setPayslipAdjustments(run.id, 'e-1', lines, 'hr-admin')!;
    const viaEdit = updateDraftPayslip(run.id, 'e-1', { adjustments: lines }, 'hr-admin')!;
    expect(viaEdit).toEqual(viaLegacy);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Statutory opt-outs
// ─────────────────────────────────────────────────────────────────────────────

describe('statutory opt-outs', () => {
  it('opting out of EPF + PCB zeroes BOTH shares, prints reason lines, stores the reason', () => {
    seed([mkEmp('e-1')]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const base = payslips[0]!;
    expect(base.epfEmployee).toBeGreaterThan(0);

    const p = editE1(run.id, {
      excludeEpf: true,
      excludePcb: true,
      optOutReasons: { epf: 'Written agreement on file', pcb: 'LHDN direction letter' },
    });

    expect(p.epfEmployee).toBe(0);
    expect(p.epfEmployer).toBe(0);
    expect(p.pcb).toBe(0);
    expect(p.excludeEpf).toBe(true);
    expect(p.excludePcb).toBe(true);
    expect(p.excludeSocso).toBeUndefined();
    expect(p.optOutReasons).toEqual({ epf: 'Written agreement on file', pcb: 'LHDN direction letter' });
    // SOCSO/EIS untouched.
    expect(p.socsoEmployee).toBe(base.socsoEmployee);
    expect(p.eisEmployee).toBe(base.eisEmployee);
    // Zero '— opted out (reason)' lines replace the normal statutory lines.
    const labels = p.lines.map((l) => l.label);
    expect(labels).toContain('EPF employee — opted out (Written agreement on file)');
    expect(labels).toContain('EPF employer — opted out (Written agreement on file)');
    expect(labels).toContain('PCB / MTD — opted out (LHDN direction letter)');
    expect(labels.some((l) => l.startsWith('EPF employee (11%)'))).toBe(false);
    const epfLine = p.lines.find((l) => l.label.startsWith('EPF employee'))!;
    expect(epfLine.amount).toBe(0);
    // Net rises by exactly the foregone employee EPF + PCB.
    expect(p.netPay).toBe(round2(base.netPay + base.epfEmployee + base.pcb));
    // YTD accumulates the zeros.
    expect(p.ytd.epf).toBe(round2(base.ytd.epf - base.epfEmployee));
  });

  it('opting out of SOCSO + EIS zeroes employee and employer shares only for those schemes', () => {
    seed([mkEmp('e-1')]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const base = payslips[0]!;

    const p = editE1(run.id, { excludeSocso: true, excludeEis: true });
    expect(p.socsoEmployee).toBe(0);
    expect(p.socsoEmployer).toBe(0);
    expect(p.eisEmployee).toBe(0);
    expect(p.eisEmployer).toBe(0);
    expect(p.epfEmployee).toBe(base.epfEmployee);
    expect(p.socsoCategory).toBe(base.socsoCategory); // category still recorded
    const labels = p.lines.map((l) => l.label);
    expect(labels).toContain('SOCSO employee — opted out');
    expect(labels).toContain('EIS employer — opted out');
    expect(p.netPay).toBe(round2(base.netPay + base.socsoEmployee + base.eisEmployee));
  });

  it('opt-outs are rejected once the run is finalized', () => {
    seed([mkEmp('e-1')]);
    const { run } = runPayroll(MONTH, undefined, 'hr-admin'); // finalized immediately
    expect(updateDraftPayslip(run.id, 'e-1', { excludeEpf: true })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// previewPayslip parity with the persisted run
// ─────────────────────────────────────────────────────────────────────────────

describe('previewPayslip — live panel parity', () => {
  it('preview of an edit state is EXACTLY what updateDraftPayslip persists', () => {
    seed([mkEmp('e-1', { salaryType: 'daily', dailyRate: 120 })], { attendance: WINDOW_ATTENDANCE });
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });

    const edit: PayslipEditInput = {
      adjustments: [
        { id: 'b1', kind: 'earning', preset: 'custom', label: 'Bonus', amount: 800, itemKey: 'bonus', tags: { epf: true, socso: false, eis: false, pcb: true }, additionalRemuneration: true },
        { id: 'c1', kind: 'deduction', preset: 'zakat', label: 'Monthly tithe', amount: 50 },
      ],
      workedQty: 12,
      excludeSocso: true,
      optOutReasons: { socso: 'Exemption certificate' },
    };
    const preview = previewPayslip(run.id, 'e-1', edit)!;
    const persisted = updateDraftPayslip(run.id, 'e-1', edit, 'hr-admin')!;
    expect(preview).toEqual(persisted);
  });

  it('preview persists nothing', () => {
    seed([mkEmp('e-1')]);
    const { run, payslips } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    const before = payslips[0]!;
    previewPayslip(run.id, 'e-1', { basicOverride: 9999 });
    const stored = getCollection<{ id: string; basicPay: number; basicOverride?: number }>('payslips')
      .find((p) => p.id === before.id)!;
    expect(stored.basicPay).toBe(before.basicPay);
    expect(stored.basicOverride).toBeUndefined();
  });

  it('preview returns null for unknown run / employee', () => {
    seed([mkEmp('e-1')]);
    const { run } = runPayroll(MONTH, undefined, 'hr-admin', { draft: true });
    expect(previewPayslip('no-such-run', 'e-1', {})).toBeNull();
    expect(previewPayslip(run.id, 'no-such-emp', {})).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pay-items catalog vs the research-doc tagging matrix
// ─────────────────────────────────────────────────────────────────────────────

describe('pay-items catalog — statutory-rates.md §6 matrix', () => {
  const tagsOf = (key: string): WageBaseTags => payItemPreset(key)!.tags;

  it('allowances attract all four schemes; bonus is EPF-only + PCB; OT is not EPF-able', () => {
    for (const key of ['general-allowance', 'transport', 'phone', 'meals', 'childcare', 'hadir-attendance', 'hadir-meals', 'commission', 'reward']) {
      expect(tagsOf(key)).toEqual({ epf: true, socso: true, eis: true, pcb: true });
    }
    expect(tagsOf('bonus')).toEqual({ epf: true, socso: false, eis: false, pcb: true });
    expect(tagsOf('overtime-manual')).toEqual({ epf: false, socso: true, eis: true, pcb: true });
  });

  it('reimbursement-style items attract nothing and pay outside gross', () => {
    for (const key of ['petrol', 'parking', 'claims']) {
      expect(tagsOf(key)).toEqual({ epf: false, socso: false, eis: false, pcb: false });
      expect(payItemPreset(key)!.nonStatutory).toBe(true);
    }
  });

  it('BIK/VOLA and director fees are taxable only (research doc §6: N/N/N/Y); BIK is non-cash', () => {
    expect(tagsOf('bik-vola')).toEqual({ epf: false, socso: false, eis: false, pcb: true });
    expect(payItemPreset('bik-vola')!.nonCash).toBe(true);
    expect(tagsOf('director-fees')).toEqual({ epf: false, socso: false, eis: false, pcb: true });
    expect(payItemPreset('director-fees')!.additionalRemuneration).toBe(true);
  });

  it('additional remuneration flagged on bonus/commission/director fees only', () => {
    const flagged = PAY_ITEM_PRESETS.filter((p) => p.additionalRemuneration).map((p) => p.key);
    expect(flagged.sort()).toEqual(['bonus', 'commission', 'director-fees']);
  });

  it('newEarningFromPreset stamps the preset defaults; custom stays untagged legacy', () => {
    const bonus = newEarningFromPreset(payItemPreset('bonus'), '', 1000);
    expect(bonus.label).toBe('Bonus');
    expect(bonus.tags).toEqual({ epf: true, socso: false, eis: false, pcb: true });
    expect(bonus.additionalRemuneration).toBe(true);

    const custom = newEarningFromPreset(undefined, 'Arrears', 250);
    expect(custom.tags).toBeUndefined();
    expect(custom.amount).toBe(250);
  });
});
