/**
 * Year-end pack tests — per-employee annual totals, CP8D row math (annual
 * totals vs the sum of the monthly payslips), Form E company totals, CP21
 * leaver filtering, validation warnings, deadlines, readiness checklist and
 * batch-distribution progress.
 *
 * All functions under test are pure (arrays in, values out), so no
 * localStorage stub is needed. Every money expectation is hand-verified;
 * monthly fixture values use .00/.25/.50/.75 decimals only, which are exact
 * in binary floating point, so the annual sums are drift-free.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateFinalizedYear, aggregateSlips, buildCp21Rows, buildCp8dRows,
  buildFormESummary, buildReadinessChecklist, cp21Csv, cp21CsvRows, cp8dCsv,
  cp8dCsvRows, distributionProgress, employedDuringYear,
  employeeValidationWarnings, expectedMonths, finalizedSlipsForYear,
  formECsvRows, yearEndDeadlines,
} from '../yearEnd';
import type { Employee, PayrollRun, Payslip, Settings } from '../types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TODAY = new Date('2027-02-10T00:00:00'); // 2026 is a closed past year

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
    epfNo: 'EPF-1',
    socsoNo: 'SOC-1',
    taxNo: 'TAX-1',
    isForeignWorker: false,
    dateOfBirth: '1990-01-01',
    gender: 'male',
    fixedAllowances: [],
    ...over,
  };
}

function mkRun(monthKey: string, status: 'draft' | 'finalized', id?: string): PayrollRun {
  return {
    id: id ?? `run-${monthKey}`,
    monthKey,
    status,
    runAt: `${monthKey}-28T09:00:00.000Z`,
    runBy: 'test',
    employeeCount: 1,
    totalGross: 0,
    totalNet: 0,
    totalEmployerCost: 0,
    warnings: [],
    ...(status === 'finalized' ? { finalizedAt: `${monthKey}-28T10:00:00.000Z` } : {}),
  };
}

type SlipSeed = Partial<Payslip> & { runId: string; employeeId: string; monthKey: string };

function mkSlip(seed: SlipSeed): Payslip {
  return {
    basicPay: 0,
    unpaidLeaveDeduction: 0,
    otPay: 0,
    otHours: 0,
    allowances: 0,
    claimsTotal: 0,
    grossPay: 0,
    epfEmployee: 0,
    epfEmployer: 0,
    socsoEmployee: 0,
    socsoEmployer: 0,
    socsoCategory: 1,
    eisEmployee: 0,
    eisEmployer: 0,
    pcb: 0,
    hrdLevy: 0,
    netPay: 0,
    employerCost: 0,
    lines: [],
    ytd: { gross: 0, epf: 0, socso: 0, pcb: 0, net: 0 },
    ...seed,
    id: seed.id ?? `${seed.runId}:${seed.employeeId}`,
  };
}

/** emp-1's identical monthly payslip figures (11 finalized months, Jan–Nov). */
const EMP1_MONTH = {
  basicPay: 3000, allowances: 200, otPay: 100.5, grossPay: 3200.5, claimsTotal: 50,
  epfEmployee: 352, epfEmployer: 416,
  socsoEmployee: 9.75, socsoEmployer: 34.25,
  eisEmployee: 6.5, eisEmployer: 6.5,
  pcb: 120.25, hrdLevy: 16, netPay: 2700, employerCost: 3723.25,
};

/** emp-2's identical monthly payslip figures (3 finalized months, Jan–Mar). */
const EMP2_MONTH = {
  basicPay: 2000, grossPay: 2000,
  epfEmployee: 220, epfEmployer: 260,
  socsoEmployee: 5.5, socsoEmployer: 19.25,
  eisEmployee: 4, eisEmployer: 4,
  pcb: 0, hrdLevy: 10, netPay: 1770.5, employerCost: 2293.25,
};

const MONTHS_11 = [
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
  '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
];

function buildFixtures() {
  const employees = [
    mkEmp('emp-1', { name: 'Zara Ibrahim' }),
    mkEmp('emp-2', { name: 'Ahmad Faizal', status: 'resigned', resignDate: '2026-03-15' }),
    mkEmp('emp-3', { name: 'Chen Wei', joinDate: '2026-01-05' }),
    mkEmp('emp-4', { name: 'Dina Ria', status: 'resigned', resignDate: '2025-11-30' }),
  ];
  const runs: PayrollRun[] = [
    ...MONTHS_11.map((mk) => mkRun(mk, 'finalized')),
    mkRun('2026-12', 'draft'), // draft — must never enter the annual return
    mkRun('2025-12', 'finalized'), // prior year — year filter boundary
  ];
  const payslips: Payslip[] = [
    ...MONTHS_11.map((mk) =>
      mkSlip({ ...EMP1_MONTH, runId: `run-${mk}`, employeeId: 'emp-1', monthKey: mk })),
    ...['2026-01', '2026-02', '2026-03'].map((mk) =>
      mkSlip({ ...EMP2_MONTH, runId: `run-${mk}`, employeeId: 'emp-2', monthKey: mk })),
    mkSlip({ runId: 'run-2026-12', employeeId: 'emp-1', monthKey: '2026-12', grossPay: 9999, netPay: 9999 }),
    mkSlip({ runId: 'run-2025-12', employeeId: 'emp-1', monthKey: '2025-12', grossPay: 8888, netPay: 8888 }),
  ];
  const settings: Settings = {
    id: 'company',
    companyName: 'ASM Tech Sdn Bhd',
    companyRegNo: '202401000001 (1234567-A)',
    hqState: 'KUL',
    address: '1 Jalan Testing, 50000 Kuala Lumpur',
    epfEmployerNo: 'EPF-EMP-01',
    socsoEmployerNo: 'SOC-EMP-01',
    taxEmployerNo: 'E-123456',
    paydayDay: 28,
    standardDailyHours: 8,
    standardWeeklyHours: 45,
  };
  return { employees, runs, payslips, settings };
}

// Hand-verified annual figures: EMP1_MONTH × 11 and EMP2_MONTH × 3.
const EMP1_ANNUAL = {
  months: 11,
  basic: 33000, allowances: 2200, ot: 1105.5, gross: 35205.5, claims: 550,
  epfEmployee: 3872, epfEmployer: 4576,
  socsoEmployee: 107.25, socsoEmployer: 376.75,
  eisEmployee: 71.5, eisEmployer: 71.5,
  pcb: 1322.75, hrdLevy: 176, net: 29700, employerCost: 40955.75,
};
const EMP2_ANNUAL = {
  months: 3,
  basic: 6000, allowances: 0, ot: 0, gross: 6000, claims: 0,
  epfEmployee: 660, epfEmployer: 780,
  socsoEmployee: 16.5, socsoEmployer: 57.75,
  eisEmployee: 12, eisEmployer: 12,
  pcb: 0, hrdLevy: 30, net: 5311.5, employerCost: 6879.75,
};

// ── finalizedSlipsForYear / aggregateSlips ───────────────────────────────────

describe('finalizedSlipsForYear', () => {
  const { runs, payslips } = buildFixtures();

  it('keeps only payslips from FINALIZED runs of the requested year', () => {
    const slips = finalizedSlipsForYear(payslips, runs, 2026);
    expect(slips).toHaveLength(14); // 11 + 3, draft Dec + 2025 payslip dropped
    expect(slips.every((p) => p.monthKey.startsWith('2026'))).toBe(true);
    expect(slips.some((p) => p.runId === 'run-2026-12')).toBe(false);
    expect(slips.some((p) => p.monthKey.startsWith('2025'))).toBe(false);
  });

  it('drops payslips whose run no longer exists', () => {
    const orphan = mkSlip({ runId: 'run-ghost', employeeId: 'emp-1', monthKey: '2026-05' });
    const slips = finalizedSlipsForYear([...payslips, orphan], runs, 2026);
    expect(slips.some((p) => p.runId === 'run-ghost')).toBe(false);
  });

  it('sorts by month then employee', () => {
    const slips = finalizedSlipsForYear(payslips, runs, 2026);
    const keys = slips.map((p) => `${p.monthKey}:${p.employeeId}`);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('aggregateSlips / aggregateFinalizedYear', () => {
  const { runs, payslips } = buildFixtures();

  it('sums monthly payslips into per-employee annual totals (emp-1 × 11)', () => {
    const totals = aggregateFinalizedYear(payslips, runs, 2026);
    const t1 = totals.find((t) => t.employeeId === 'emp-1');
    expect(t1).toBeDefined();
    expect(t1).toMatchObject(EMP1_ANNUAL);
    expect(t1?.firstMonth).toBe('2026-01');
    expect(t1?.lastMonth).toBe('2026-11');
    expect(t1?.lastNet).toBe(2700);
  });

  it('sums monthly payslips into per-employee annual totals (emp-2 × 3)', () => {
    const totals = aggregateFinalizedYear(payslips, runs, 2026);
    const t2 = totals.find((t) => t.employeeId === 'emp-2');
    expect(t2).toMatchObject(EMP2_ANNUAL);
    expect(t2?.firstMonth).toBe('2026-01');
    expect(t2?.lastMonth).toBe('2026-03');
    expect(t2?.lastNet).toBe(1770.5);
  });

  it('rounds each annual field to the sen', () => {
    const slips = [0.1, 0.1, 0.1].map((g, i) =>
      mkSlip({ runId: `r${i}`, employeeId: 'e', monthKey: `2026-0${i + 1}`, grossPay: g }));
    const [t] = aggregateSlips(slips);
    expect(t?.gross).toBe(0.3); // 0.30000000000000004 unrounded
  });

  it('aggregates employees independently of insertion order', () => {
    const totals = aggregateFinalizedYear([...payslips].reverse(), runs, 2026);
    expect(totals.find((t) => t.employeeId === 'emp-1')).toMatchObject(EMP1_ANNUAL);
    expect(totals.find((t) => t.employeeId === 'emp-2')).toMatchObject(EMP2_ANNUAL);
  });
});

// ── Validation warnings ──────────────────────────────────────────────────────

describe('employeeValidationWarnings', () => {
  it('returns no warnings for a complete record', () => {
    expect(employeeValidationWarnings(mkEmp('e'))).toEqual([]);
  });

  it('flags a missing employee record', () => {
    expect(employeeValidationWarnings(undefined)).toEqual(['No employee record found']);
  });

  it('flags missing IC / tax / EPF / SOCSO numbers individually', () => {
    const w = employeeValidationWarnings(
      mkEmp('e', { ic: '', taxNo: ' ', epfNo: '', socsoNo: undefined as unknown as string }),
    );
    expect(w).toContain('Missing NRIC / passport no.');
    expect(w).toContain('Missing income tax no.');
    expect(w).toContain('Missing EPF member no.');
    expect(w).toContain('Missing SOCSO no.');
    expect(w).toHaveLength(4);
  });
});

// ── CP8D ─────────────────────────────────────────────────────────────────────

describe('buildCp8dRows', () => {
  const { employees, runs, payslips } = buildFixtures();
  const totals = aggregateFinalizedYear(payslips, runs, 2026);
  const rows = buildCp8dRows(totals, employees);

  it('produces one row per remunerated employee with annual totals matching the monthly sums', () => {
    expect(rows).toHaveLength(2);
    const zara = rows.find((r) => r.employeeId === 'emp-1');
    expect(zara).toMatchObject({
      months: EMP1_ANNUAL.months,
      grossRemuneration: EMP1_ANNUAL.gross,
      epfEmployee: EMP1_ANNUAL.epfEmployee,
      epfEmployer: EMP1_ANNUAL.epfEmployer,
      socsoEmployee: EMP1_ANNUAL.socsoEmployee,
      socsoEmployer: EMP1_ANNUAL.socsoEmployer,
      eisEmployee: EMP1_ANNUAL.eisEmployee,
      eisEmployer: EMP1_ANNUAL.eisEmployer,
      pcb: EMP1_ANNUAL.pcb,
      netPay: EMP1_ANNUAL.net,
    });
  });

  it('sorts rows by employee name and numbers them sequentially', () => {
    expect(rows.map((r) => r.name)).toEqual(['Ahmad Faizal', 'Zara Ibrahim']);
    expect(rows.map((r) => r.no)).toEqual([1, 2]);
  });

  it('carries employee statutory IDs onto the row', () => {
    expect(rows[0]).toMatchObject({ ic: '900101-01-1234', taxNo: 'TAX-1', epfNo: 'EPF-1', socsoNo: 'SOC-1' });
  });

  it('attaches validation warnings for missing statutory numbers', () => {
    const broken = mkEmp('emp-9', { ic: '', taxNo: '' });
    const brokenTotals = aggregateSlips([
      mkSlip({ runId: 'r', employeeId: 'emp-9', monthKey: '2026-01', grossPay: 100 }),
    ]);
    const [row] = buildCp8dRows(brokenTotals, [broken]);
    expect(row?.warnings).toContain('Missing NRIC / passport no.');
    expect(row?.warnings).toContain('Missing income tax no.');
    expect(row?.warnings).toHaveLength(2); // EPF/SOCSO present on mkEmp
  });

  it('warns when the payslip belongs to an unknown employee', () => {
    const orphanTotals = aggregateSlips([
      mkSlip({ runId: 'r', employeeId: 'ghost', monthKey: '2026-01', grossPay: 100 }),
    ]);
    const [row] = buildCp8dRows(orphanTotals, employees);
    expect(row?.name).toBe('ghost');
    expect(row?.warnings).toEqual(['No employee record found']);
  });
});

describe('CP8D CSV', () => {
  const { employees, runs, payslips } = buildFixtures();
  const rows = buildCp8dRows(aggregateFinalizedYear(payslips, runs, 2026), employees);

  it('appends a TOTAL row equal to the sum of the employee rows', () => {
    const csvRows = cp8dCsvRows(rows);
    const total = csvRows[csvRows.length - 1]!;
    expect(total[1]).toBe('TOTAL');
    expect(total[6]).toBe(14); // months
    expect(total[7]).toBe('41205.50'); // gross
    expect(total[8]).toBe('4532.00'); // EPF employee
    expect(total[9]).toBe('5356.00'); // EPF employer
    expect(total[10]).toBe('123.75'); // SOCSO employee
    expect(total[14]).toBe('1322.75'); // PCB
    expect(total[15]).toBe('35011.50'); // net
  });

  it('emits header + one line per employee + TOTAL', () => {
    const lines = cp8dCsv(rows).split('\r\n');
    expect(lines).toHaveLength(1 + 2 + 1);
    expect(lines[0]).toContain('Gross Remuneration (RM)');
    expect(lines[0]).toContain('Income Tax No');
    expect(lines[1]).toContain('Ahmad Faizal');
  });
});

// ── Form E ───────────────────────────────────────────────────────────────────

describe('buildFormESummary', () => {
  const { runs, payslips, settings } = buildFixtures();
  const totals = aggregateFinalizedYear(payslips, runs, 2026);
  const s = buildFormESummary(totals, runs, payslips, 2026, TODAY);

  it('counts employees and payslip-months', () => {
    expect(s.employeeCount).toBe(2);
    expect(s.payslipMonths).toBe(14);
  });

  it('sums company remuneration from the employee totals', () => {
    expect(s.remuneration).toEqual({
      salary: 39000, allowances: 2200, overtime: 1105.5, gross: 41205.5, claims: 550,
    });
  });

  it('sums company statutory totals from the employee totals', () => {
    expect(s).toMatchObject({
      epfEmployee: 4532, epfEmployer: 5356,
      socsoEmployee: 123.75, socsoEmployer: 434.5,
      eisEmployee: 83.5, eisEmployer: 83.5,
      pcb: 1322.75, hrdLevy: 206, net: 35011.5, employerCost: 47835.5,
    });
  });

  it('flags expected months without a finalized run (Dec is draft only)', () => {
    expect(s.monthsFinalized).toBe(11);
    expect(s.monthsMissingFinalized).toEqual(['2026-12']);
  });

  it('renders the e-Filing helper rows with employer numbers and due dates', () => {
    const rows = formECsvRows(s, settings);
    const flat = rows.map((r) => r.join(' ')).join('\n');
    expect(flat).toContain('E-123456');
    expect(flat).toContain('EPF-EMP-01');
    expect(flat).toContain('Number of employees (per CP8D) 2');
    expect(flat).toContain('Total gross remuneration (RM) 41205.50');
    expect(flat).toContain('31 March 2027');
    expect(flat).toContain('30 April 2027');
  });
});

// ── CP21 ─────────────────────────────────────────────────────────────────────

describe('buildCp21Rows (leaver filter)', () => {
  const { employees, runs, payslips } = buildFixtures();
  const totals = aggregateFinalizedYear(payslips, runs, 2026);

  it('includes only employees whose resignDate falls inside the year', () => {
    const rows = buildCp21Rows(employees, totals, 2026);
    expect(rows).toHaveLength(1); // emp-4 left in 2025, emp-1/emp-3 not resigned
    expect(rows[0]?.employeeId).toBe('emp-2');
  });

  it('carries leaving date, final pay month and final net from the last payslip', () => {
    const [row] = buildCp21Rows(employees, totals, 2026);
    expect(row).toMatchObject({
      name: 'Ahmad Faizal',
      leavingDate: '2026-03-15',
      finalMonth: '2026-03',
      finalNet: 1770.5,
    });
  });

  it('uses the reason map when provided, else a resigned-status default', () => {
    const reasons = new Map([['emp-2', 'Retrenchment']]);
    expect(buildCp21Rows(employees, totals, 2026, reasons)[0]?.reason).toBe('Retrenchment');
    expect(buildCp21Rows(employees, totals, 2026)[0]?.reason).toBe('Resignation');
  });

  it('flags leavers with no finalized payslip in the year', () => {
    const leaver = mkEmp('emp-5', {
      name: 'Elena Soon', status: 'resigned', resignDate: '2026-07-01',
    });
    const rows = buildCp21Rows([...employees, leaver], totals, 2026);
    const elena = rows.find((r) => r.employeeId === 'emp-5');
    expect(elena?.finalMonth).toBe('—');
    expect(elena?.finalNet).toBeNull();
    expect(elena?.warnings).toContain('No finalized payslip in 2026 — final pay unknown');
    // Still a valid row alongside emp-2, sorted by leaving date.
    expect(rows.map((r) => r.employeeId)).toEqual(['emp-2', 'emp-5']);
  });

  it('warns on missing IC / tax numbers for leavers too', () => {
    const leaver = mkEmp('emp-6', { ic: '', taxNo: '', resignDate: '2026-02-01' });
    const [row] = buildCp21Rows([leaver], totals, 2026);
    expect(row?.warnings).toContain('Missing NRIC / passport no.');
    expect(row?.warnings).toContain('Missing income tax no.');
  });

  it('CSV leaves final pay blank when unknown and numbers the rest', () => {
    const leaver = mkEmp('emp-5', { status: 'resigned', resignDate: '2026-07-01' });
    const rows = buildCp21Rows([...employees, leaver], totals, 2026);
    const csvRows = cp21CsvRows(rows);
    expect(csvRows[0]).toEqual([1, 'Ahmad Faizal', '900101-01-1234', 'TAX-1', '2026-03-15', '2026-03', '1770.50', 'Resignation']);
    expect(csvRows[1]?.[6]).toBe(''); // final net unknown
    const csv = cp21Csv(rows);
    expect(csv.split('\r\n')).toHaveLength(1 + 2);
    expect(csv).toContain('Leaving Date');
  });
});

// ── expectedMonths / deadlines / readiness ───────────────────────────────────

describe('expectedMonths', () => {
  const { runs, payslips } = buildFixtures();

  it('spans first active month through December for a past year', () => {
    const months = expectedMonths(2026, runs, payslips, TODAY);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2026-01');
    expect(months[11]).toBe('2026-12');
  });

  it('stops at the current month for the current year', () => {
    const today = new Date('2026-03-15T00:00:00');
    const months = expectedMonths(2026, runs, payslips, today);
    expect(months).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('is empty for a future year or a year with no activity', () => {
    expect(expectedMonths(2028, runs, payslips, TODAY)).toEqual([]);
    expect(expectedMonths(2024, runs, payslips, TODAY)).toEqual([]);
  });
});

describe('yearEndDeadlines', () => {
  it('Form E + CP8D due 31 Mar, e-file grace 30 Apr of the following year', () => {
    const d = yearEndDeadlines(2026, TODAY);
    expect(d.formEDue).toBe('2027-03-31');
    expect(d.eFileGrace).toBe('2027-04-30');
    expect(d.daysToFormEDue).toBe(49); // 10 Feb → 31 Mar 2027
    expect(d.daysToEFileGrace).toBe(79);
  });

  it('reports negative days once the deadline has passed', () => {
    const d = yearEndDeadlines(2026, new Date('2027-05-01T00:00:00'));
    expect(d.daysToFormEDue).toBeLessThan(0);
    expect(d.daysToEFileGrace).toBeLessThan(0);
  });
});

describe('buildReadinessChecklist', () => {
  it('flags missing employer numbers, unfinished months, uncovered employees and missing IDs', () => {
    const { employees, runs, payslips, settings } = buildFixtures();
    const totals = aggregateFinalizedYear(payslips, runs, 2026);
    const items = buildReadinessChecklist({
      year: 2026, employees, totals, runs, payslips,
      settings: { ...settings, socsoEmployerNo: '' },
      today: TODAY,
    });
    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.get('employer-numbers')?.ok).toBe(false);
    expect(byKey.get('employer-numbers')?.detail).toContain('SOCSO employer no.');
    expect(byKey.get('months-finalized')?.ok).toBe(false);
    expect(byKey.get('months-finalized')?.detail).toContain('2026-12');
    expect(byKey.get('employee-coverage')?.ok).toBe(false);
    expect(byKey.get('employee-coverage')?.detail).toContain('Chen Wei');
    expect(byKey.get('employee-ids')?.ok).toBe(true); // covered employees have full IDs
  });

  it('is fully green on a complete dataset', () => {
    const today = new Date('2026-03-15T00:00:00');
    const employees = [mkEmp('emp-1', { name: 'Zara Ibrahim' })];
    const runs = ['2026-01', '2026-02', '2026-03'].map((mk) => mkRun(mk, 'finalized'));
    const payslips = runs.map((r) =>
      mkSlip({ ...EMP1_MONTH, runId: r.id, employeeId: 'emp-1', monthKey: r.monthKey }));
    const totals = aggregateFinalizedYear(payslips, runs, 2026);
    const { settings } = buildFixtures();
    const items = buildReadinessChecklist({
      year: 2026, employees, totals, runs, payslips, settings, today,
    });
    expect(items.every((i) => i.ok)).toBe(true);
  });

  it('reports years with no payroll activity', () => {
    const items = buildReadinessChecklist({
      year: 2024, employees: [], totals: [], runs: [], payslips: [], settings: undefined,
    });
    const months = items.find((i) => i.key === 'months-finalized');
    expect(months?.ok).toBe(false);
    expect(months?.detail).toContain('No payroll activity');
  });
});

describe('employedDuringYear', () => {
  const { employees } = buildFixtures();

  it('keeps joiners of the year and leavers of the year, drops earlier leavers', () => {
    const ids = employedDuringYear(employees, 2026).map((e) => e.id);
    expect(ids).toContain('emp-1');
    expect(ids).toContain('emp-2'); // resigned Mar 2026 — still owed an EA form
    expect(ids).toContain('emp-3'); // joined Jan 2026
    expect(ids).not.toContain('emp-4'); // left Nov 2025
  });
});

// ── Batch distribution ───────────────────────────────────────────────────────

describe('distributionProgress', () => {
  it('counts distributed payslips and computes the percent', () => {
    const slips = [
      mkSlip({ runId: 'r', employeeId: 'a', monthKey: '2026-01', distributedAt: '2026-02-01T09:00:00.000Z' }),
      mkSlip({ runId: 'r', employeeId: 'b', monthKey: '2026-01' }),
      mkSlip({ runId: 'r', employeeId: 'c', monthKey: '2026-01' }),
      mkSlip({ runId: 'r', employeeId: 'd', monthKey: '2026-01', distributedAt: '2026-02-02T09:00:00.000Z' }),
    ];
    expect(distributionProgress(slips)).toEqual({
      total: 4, distributed: 2, pending: 2, percent: 50,
    });
  });

  it('handles empty runs without dividing by zero', () => {
    expect(distributionProgress([])).toEqual({ total: 0, distributed: 0, pending: 0, percent: 0 });
  });
});
