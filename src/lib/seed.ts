/**
 * Multi-tenant demo seed.
 *
 * Three demo companies (tenant registry: lib/tenants.ts):
 *  - co-asm      ASM Tech Sdn Bhd (KUL) — the original 30-employee dataset,
 *                preserved verbatim (same people, salaries, samples).
 *  - co-merdeka  Merdeka Manufacturing Sdn Bhd (JHR, fri-sat weekend) —
 *                12 manufacturing employees, generated via buildCompanySeedData.
 *  - co-desa     Desa Retail Group (PNG) — 8 retail employees, same generator.
 *
 * `buildTenantSeedData(companyId)` is the single entry db.ts seeding uses.
 * Per-company parameters: name/state/settings, departments, positions,
 * headcount (empRows), salary bands (on positions), shifts and weekend days;
 * attendance / leave balances / leave / claims / KPI samples scale with
 * headcount. Deterministic RNG (seeded per company) keeps reseeds stable.
 * No external images — pages render initials avatars via utils.initialsOf().
 */

import { uid } from './db';
import { monthKey } from './utils';
import { companySeedRecord, COMPANY_ID_ASM, COMPANY_ID_MERDEKA, COMPANY_ID_DESA, COMPANY_ID_ASMDIV } from './tenants';
import type {
  AttendanceRecord, Claim, Company, Department, Employee, KPI, KPIReview, LeaveBalance,
  LeaveRequest, Position, Settings, Shift, StateCode,
} from './types';

/** Deterministic RNG so reseeds look stable. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Employee tuple shared by every company's seed table. */
export type EmpRow = [
  id: string, name: string, dept: string, pos: string, state: StateCode,
  salary: number, type: Employee['employmentType'], status: Employee['status'],
  joinDate: string, marital: Employee['maritalStatus'], children: number,
  foreign: boolean, dob: string, gender: Employee['gender'], accessRole: Employee['role'],
  allowances: [string, number][],
];

/* ────────────────────────────────────────────────────────────────────────────
 * Shared builders (the "existing seed generator", parameterized)
 * ──────────────────────────────────────────────────────────────────────────── */

const BANKS = ['Maybank', 'CIMB Bank', 'Public Bank', 'RHB Bank', 'Hong Leong Bank'];

function buildEmployees(
  empRows: EmpRow[],
  emailDomain: string,
  employeeNoPrefix: string,
): Employee[] {
  return empRows.map((r, i) => {
    const [id, name, dept, pos, state, salary, type, status, joinDate, marital, children, foreign, dob, gender, accessRole, allowances] = r;
    const first = name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
    return {
      id,
      employeeNo: `${employeeNoPrefix}${String(i + 1).padStart(4, '0')}`,
      name,
      ic: foreign ? `P${1000000 + i * 137}` : `${dob.slice(2, 10).replaceAll('-', '')}${String(1000 + i * 7).slice(1)}`,
      email: `${first}${i + 1}@${emailDomain}`,
      phone: `+601${3 + (i % 6)}-${String(2000000 + i * 91357).slice(0, 7)}`,
      departmentId: dept,
      positionId: pos,
      role: accessRole,
      joinDate,
      state,
      employmentType: type,
      status,
      baseSalary: salary,
      maritalStatus: marital,
      children,
      bankName: BANKS[i % BANKS.length],
      bankAccount: `${100000000 + i * 777777}`,
      epfNo: foreign ? '' : `${12000000 + i * 45678}`,
      socsoNo: `${210000000 + i * 34567}`,
      taxNo: `SG ${31000000 + i * 23456}`,
      isForeignWorker: foreign,
      dateOfBirth: dob,
      gender,
      fixedAllowances: allowances.map(([n, amount]) => ({ name: n, amount })),
    };
  });
}

export interface AttendanceSeedOpts {
  rnd: () => number;
  /** Days-of-week treated as weekend for rest-day markers (KUL: [0,6], JHR: [5,6]). */
  weekendDows: number[];
  /** Which shift each employee works. */
  shiftFor: (e: Employee) => Shift;
  /** Employees randomly accruing OT (~22% of worked days). */
  otEmployeeIds?: Set<string>;
  /** Optional extra rest-day OT record (ASM ops staff pattern). */
  extraRestDayOt?: (e: Employee, dow: number) => boolean;
}

/** Previous month + current month-to-date attendance for every employee. */
function generateAttendance(employees: Employee[], opts: AttendanceSeedOpts): AttendanceRecord[] {
  const { rnd, weekendDows, shiftFor } = opts;
  const now = new Date();
  const thisMonth = monthKey(now);
  const prevMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const months = [prevMonth, thisMonth];

  const attendance: AttendanceRecord[] = [];
  employees.forEach((emp, ei) => {
    const shift = shiftFor(emp);
    for (const mk of months) {
      const [y, m] = mk.split('-').map(Number);
      const lastDay = mk === thisMonth ? now.getDate() : new Date(y, m, 0).getDate();
      for (let day = 1; day <= lastDay; day++) {
        const d = new Date(y, m - 1, day);
        const dow = d.getDay();
        const works = emp.employmentType === 'part-time'
          ? [1, 3, 5].includes(dow)
          : shift.workDays.includes(dow);
        const dateISO = iso(d);
        if (!works) {
          if (weekendDows.includes(dow)) {
            attendance.push({
              id: uid(), employeeId: emp.id, date: dateISO, shiftId: shift.id,
              status: 'rest-day', otHours: 0, otDayType: 'rest', otApproved: false,
            });
          }
          continue;
        }
        // Occasional approved leave / absence sprinkled in (previous month only)
        const roll = rnd();
        if (roll < 0.03 && mk === prevMonth) {
          attendance.push({ id: uid(), employeeId: emp.id, date: dateISO, shiftId: shift.id, status: 'leave', otHours: 0, otDayType: 'normal', otApproved: false });
          continue;
        }
        const jitter = Math.floor(rnd() * 14) - 7; // ±7 min
        const [sh, sm] = shift.startTime.split(':').map(Number);
        const [eh, em] = shift.endTime.split(':').map(Number);
        const inMin = sh * 60 + sm + jitter;
        const outMin = eh * 60 + em + Math.floor(rnd() * 20);
        const fmt = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
        const hasOT = (opts.otEmployeeIds?.has(emp.id) ?? false) && rnd() < 0.22;
        const otHours = hasOT ? Math.min(3, 1 + Math.floor(rnd() * 3)) : 0;
        attendance.push({
          id: uid(), employeeId: emp.id, date: dateISO, shiftId: shift.id,
          clockIn: fmt(inMin), clockOut: fmt(outMin + (hasOT ? otHours * 60 : 0)),
          status: 'present',
          otHours,
          otDayType: 'normal',
          otApproved: hasOT ? (ei + day) % 5 !== 0 : false, // ~80% approved
        });
        if (hasOT && opts.extraRestDayOt?.(emp, dow) && rnd() < 0.4) {
          attendance.push({
            id: uid(), employeeId: emp.id, date: dateISO, shiftId: shift.id,
            status: 'present', clockIn: '09:00', clockOut: '14:00',
            otHours: 4, otDayType: 'rest', otApproved: true, notes: 'Weekend operations cover',
          });
        }
      }
    }
  });
  return attendance;
}

/** EA 1955 s.60E/60F tiered leave balances for the current year. */
function generateLeaveBalances(employees: Employee[], year: number, rnd: () => number): LeaveBalance[] {
  const serviceYears = (join: string) => (Date.parse(`${year}-01-01`) - Date.parse(join)) / (365.25 * 86_400_000);
  return employees.map((e) => {
    const yrs = serviceYears(e.joinDate);
    const pt = e.employmentType === 'part-time';
    const annual = pt ? (yrs < 2 ? 6 : yrs < 5 ? 8 : 11) : yrs < 2 ? 8 : yrs < 5 ? 12 : 16;
    const sick = pt ? (yrs < 2 ? 10 : yrs < 5 ? 13 : 15) : yrs < 2 ? 14 : yrs < 5 ? 18 : 22;
    const annualUsed = Math.floor(rnd() * Math.min(4, annual));
    return {
      id: uid(), employeeId: e.id, year,
      annualEntitled: annual, annualUsed,
      sickEntitled: sick, sickUsed: Math.floor(rnd() * 3),
      hospitalizationEntitled: 60, hospitalizationUsed: 0,
      carriedForward: yrs >= 2 ? Math.floor(rnd() * 3) : 0,
    };
  });
}

const mkLeave = (
  empId: string, type: LeaveRequest['type'], start: string, end: string, days: number,
  status: LeaveRequest['status'], reason: string, decidedBy?: string,
): LeaveRequest => ({
  id: uid(), employeeId: empId, type, startDate: start, endDate: end, days, reason, status,
  appliedAt: `${start.slice(0, 8)}01`,
  ...(status !== 'pending' ? { decidedBy: decidedBy ?? 'hr', decidedAt: `${start.slice(0, 8)}03` } : {}),
});

const mkClaim = (
  empId: string, cat: Claim['category'], title: string, amount: number,
  date: string, status: Claim['status'], decidedBy?: string,
): Claim => ({
  id: uid(), employeeId: empId, category: cat, title, amount, claimDate: date, status,
  receiptName: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`,
  submittedAt: date,
  ...(status === 'approved' || status === 'rejected' ? { decidedBy: decidedBy ?? 'hr', decidedAt: date } : {}),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Generic per-company generator (used by the smaller demo tenants)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CompanySeedParams {
  companyId: string;
  emailDomain: string;
  /** RNG seed — pass a distinct stable number per company. */
  rngSeed: number;
  departments: Department[];
  /** deptId → employeeId of the department head. */
  deptHeads: Record<string, string>;
  positions: Position[];
  empRows: EmpRow[];
  shifts: Shift[];
  /** Weekend days-of-week (fri-sat companies: [5,6]; sat-sun: [0,6]). */
  weekendDows: number[];
  settings: Omit<Settings, 'id'>;
}

/**
 * Builds a complete tenant dataset (departments → KPI reviews) that scales
 * with the company's headcount: attendance for every employee, EA-tiered
 * leave balances, and proportional leave/claim/KPI samples.
 */
export function buildCompanySeedData(p: CompanySeedParams): Record<string, unknown[]> {
  const rnd = mulberry32(p.rngSeed);
  const now = new Date();
  const year = now.getFullYear();
  const thisMonth = monthKey(now);
  const prevMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const period = `${year}-H1`;

  const departments = p.departments.map((d) => ({ ...d, headId: p.deptHeads[d.id] }));
  const prefix = companySeedRecord(p.companyId).config.numberFormats.employeeIdPrefix;
  const employees = buildEmployees(p.empRows, p.emailDomain, prefix);

  const attendance = generateAttendance(employees, {
    rnd,
    weekendDows: p.weekendDows,
    shiftFor: (e) => {
      const idx = p.empRows.findIndex((r) => r[0] === e.id);
      return p.shifts[idx % p.shifts.length]!;
    },
    otEmployeeIds: new Set(employees.filter((_, i) => i % 3 === 0).map((e) => e.id)),
  });

  const leaveBalances = generateLeaveBalances(employees, year, rnd);

  // ── Proportional samples (≈ ½ headcount leaves, ⅔ claims, ⅓ KPI owners) ──
  const hrDecider = p.deptHeads[Object.keys(p.deptHeads)[0]!] ?? employees[0]!.id;
  const leaveTypes: LeaveRequest['type'][] = ['annual', 'sick', 'annual', 'emergency', 'annual', 'unpaid'];
  const leaveReasons = ['Family matter', 'Fever, MC attached', 'Short break', 'Father hospitalised', 'Travel', 'Personal matters (unpaid)'];
  const leaveStatuses: LeaveRequest['status'][] = ['approved', 'approved', 'pending', 'approved', 'rejected', 'approved'];
  const leaves: LeaveRequest[] = employees
    .filter((_, i) => i % 2 === 1)
    .map((e, i) => {
      const mk = i % 2 === 0 ? thisMonth : prevMonth;
      const startDay = 5 + ((i * 7) % 18);
      const start = `${mk}-${String(Math.min(28, startDay)).padStart(2, '0')}`;
      const days = (i % 3) + 1;
      const end = `${mk}-${String(Math.min(28, startDay + days - 1)).padStart(2, '0')}`;
      return mkLeave(e.id, leaveTypes[i % leaveTypes.length], start, end, days, leaveStatuses[i % leaveStatuses.length], leaveReasons[i % leaveReasons.length], hrDecider);
    });

  const claimCats: Claim['category'][] = ['travel', 'meal', 'parking', 'telephone', 'medical', 'training'];
  const claimTitles = ['Site visit toll & petrol', 'Team lunch', 'Monthly parking', 'Mobile top-up', 'Panel clinic', 'Certification exam'];
  const claimAmounts = [86.5, 120, 150, 50, 75.9, 350];
  const claimStatuses: Claim['status'][] = ['approved', 'submitted', 'approved', 'submitted', 'approved', 'submitted'];
  const claims: Claim[] = employees
    .filter((_, i) => i % 3 !== 2)
    .map((e, i) => {
      const mk = i % 2 === 0 ? thisMonth : prevMonth;
      const date = `${mk}-${String(3 + ((i * 5) % 20)).padStart(2, '0')}`;
      return mkClaim(e.id, claimCats[i % claimCats.length], claimTitles[i % claimTitles.length], claimAmounts[i % claimAmounts.length], date, claimStatuses[i % claimStatuses.length], hrDecider);
    });

  const kpiOwners = employees.filter((_, i) => i % 3 === 0);
  const kpiTemplates: [string, string][] = [
    ['Hit quarterly output target', '100% of plan'],
    ['Keep defect / error rate low', '≤ 1%'],
    ['Attendance discipline', '< 2 late days/month'],
  ];
  const kpis: KPI[] = kpiOwners.flatMap((e) =>
    kpiTemplates.slice(0, 2).map(([title, target], j) => ({
      id: uid(), employeeId: e.id, title, target, weight: j === 0 ? 60 : 40, period, status: 'active' as const,
    })),
  );

  const reviews: KPIReview[] = kpiOwners.slice(0, 2).map((e, i) => {
    const mine = kpis.filter((k) => k.employeeId === e.id);
    const scores = mine.map((k) => ({ kpiId: k.id, score: 65 + Math.floor(rnd() * 28) }));
    const overall = Math.round(
      scores.reduce((s, sc) => s + (sc.score * (mine.find((k) => k.id === sc.kpiId)!.weight)) / 100, 0),
    );
    return {
      id: uid(), employeeId: e.id,
      reviewerId: hrDecider,
      period: `${year - 1}-H2`,
      scores, overallScore: overall,
      comments: overall >= 80 ? 'Strong half — stretch targets proposed.' : 'Solid progress; tighten execution discipline.',
      status: i === 1 ? 'submitted' : 'acknowledged',
      createdAt: `${year}-01-15T09:00:00`,
    };
  });

  const settings: Settings[] = [{ id: 'company', ...p.settings }];

  return {
    departments, positions: p.positions, employees, shifts: p.shifts, attendance,
    leaves, leaveBalances, claims, kpis, reviews, settings,
    payrollRuns: [], payslips: [], holidays: [], audit: [],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * co-asm — ASM Tech Sdn Bhd: the original 30-employee dataset (verbatim)
 * ──────────────────────────────────────────────────────────────────────────── */

export function buildSeedData(): Record<string, unknown[]> {
  const rnd = mulberry32(20260115);
  const now = new Date();
  const year = now.getFullYear();
  const thisMonth = monthKey(now);
  const prevMonthDate = new Date(year, now.getMonth() - 1, 1);
  const prevMonth = monthKey(prevMonthDate);

  // ── Departments ────────────────────────────────────────────────────────────
  const departments: Department[] = [
    { id: 'dept-eng', name: 'Engineering', code: 'ENG', state: 'KUL' },
    { id: 'dept-hr', name: 'Human Resources', code: 'HR', state: 'KUL' },
    { id: 'dept-fin', name: 'Finance', code: 'FIN', state: 'KUL' },
    { id: 'dept-snm', name: 'Sales & Marketing', code: 'S&M', state: 'KUL' },
    { id: 'dept-ops', name: 'Operations', code: 'OPS', state: 'SGR' },
    { id: 'dept-cs', name: 'Customer Support', code: 'CS', state: 'KUL' },
  ];

  // ── Positions ──────────────────────────────────────────────────────────────
  const positions: Position[] = [
    { id: 'pos-swe', title: 'Software Engineer', departmentId: 'dept-eng', level: 'junior', minSalary: 3500, maxSalary: 6000 },
    { id: 'pos-sswe', title: 'Senior Software Engineer', departmentId: 'dept-eng', level: 'senior', minSalary: 6500, maxSalary: 11000 },
    { id: 'pos-pm', title: 'Project Manager', departmentId: 'dept-eng', level: 'manager', minSalary: 8000, maxSalary: 14000 },
    { id: 'pos-da', title: 'Data Analyst', departmentId: 'dept-eng', level: 'junior', minSalary: 3200, maxSalary: 6500 },
    { id: 'pos-hre', title: 'HR Executive', departmentId: 'dept-hr', level: 'junior', minSalary: 2500, maxSalary: 4500 },
    { id: 'pos-hrm', title: 'HR Manager', departmentId: 'dept-hr', level: 'manager', minSalary: 7000, maxSalary: 12000 },
    { id: 'pos-acc', title: 'Accountant', departmentId: 'dept-fin', level: 'junior', minSalary: 3000, maxSalary: 5500 },
    { id: 'pos-fm', title: 'Finance Manager', departmentId: 'dept-fin', level: 'manager', minSalary: 8500, maxSalary: 15000 },
    { id: 'pos-se', title: 'Sales Executive', departmentId: 'dept-snm', level: 'junior', minSalary: 2500, maxSalary: 5000 },
    { id: 'pos-mke', title: 'Marketing Executive', departmentId: 'dept-snm', level: 'junior', minSalary: 2600, maxSalary: 5000 },
    { id: 'pos-csr', title: 'Customer Service Representative', departmentId: 'dept-cs', level: 'junior', minSalary: 1900, maxSalary: 3200 },
    { id: 'pos-om', title: 'Operations Manager', departmentId: 'dept-ops', level: 'manager', minSalary: 6500, maxSalary: 12000 },
    { id: 'pos-tech', title: 'Technician / Service Staff', departmentId: 'dept-ops', level: 'junior', minSalary: 1800, maxSalary: 3500 },
    { id: 'pos-wh', title: 'Warehouse Assistant', departmentId: 'dept-ops', level: 'junior', minSalary: 1700, maxSalary: 2800 },
    { id: 'pos-drv', title: 'Driver', departmentId: 'dept-ops', level: 'junior', minSalary: 1700, maxSalary: 3000 },
    { id: 'pos-clerk', title: 'Admin Clerk', departmentId: 'dept-ops', level: 'junior', minSalary: 1700, maxSalary: 2800 },
  ];

  // ── Employees ──────────────────────────────────────────────────────────────
  const empRows: EmpRow[] = [
    ['emp-01', 'Ahmad Faizal bin Razak', 'dept-eng', 'pos-pm', 'KUL', 12500, 'full-time', 'active', '2019-03-04', 'married', 3, false, '1985-06-12', 'male', 'manager', [['Transport', 500]]],
    ['emp-02', 'Nurul Ain binti Hassan', 'dept-hr', 'pos-hrm', 'KUL', 9800, 'full-time', 'active', '2020-01-13', 'married', 2, false, '1988-02-25', 'female', 'hr', []],
    ['emp-03', 'Tan Wei Ling', 'dept-fin', 'pos-fm', 'KUL', 11800, 'full-time', 'active', '2018-07-02', 'married', 2, false, '1984-11-08', 'female', 'manager', [['Transport', 500]]],
    ['emp-04', 'Rajesh Kumar a/l Muthu', 'dept-eng', 'pos-sswe', 'KUL', 8600, 'full-time', 'active', '2021-05-10', 'married', 1, false, '1990-04-17', 'male', 'employee', []],
    ['emp-05', 'Siti Mariam binti Abdullah', 'dept-eng', 'pos-swe', 'KUL', 5200, 'full-time', 'active', '2022-08-01', 'single', 0, false, '1996-09-03', 'female', 'employee', []],
    ['emp-06', 'Lim Jun Hao', 'dept-eng', 'pos-swe', 'SGR', 4800, 'full-time', 'active', '2023-02-20', 'single', 0, false, '1997-12-21', 'male', 'employee', []],
    ['emp-07', 'Priya a/p Raman', 'dept-eng', 'pos-da', 'KUL', 4500, 'full-time', 'active', '2022-11-14', 'single', 0, false, '1995-03-30', 'female', 'employee', []],
    ['emp-08', 'Muhammad Hafiz bin Ismail', 'dept-eng', 'pos-swe', 'PJY', 3900, 'full-time', 'probation', '2025-12-01', 'single', 0, false, '1999-07-14', 'male', 'employee', []],
    ['emp-09', 'Chong Mei Yee', 'dept-hr', 'pos-hre', 'KUL', 3400, 'full-time', 'active', '2023-06-05', 'single', 0, false, '1997-01-19', 'female', 'hr', []],
    ['emp-10', 'Kavitha a/p Subramaniam', 'dept-fin', 'pos-acc', 'KUL', 4200, 'full-time', 'active', '2021-09-27', 'married', 2, false, '1992-05-06', 'female', 'employee', []],
    ['emp-11', 'Wong Kah Wai', 'dept-fin', 'pos-acc', 'PNG', 3600, 'full-time', 'active', '2024-03-11', 'single', 0, false, '1998-10-02', 'male', 'employee', []],
    ['emp-12', 'Nur Aisyah binti Mohd Noor', 'dept-snm', 'pos-se', 'KUL', 3300, 'full-time', 'active', '2022-04-18', 'married', 1, false, '1994-08-23', 'female', 'employee', [['Mobile', 100]]],
    ['emp-13', 'Deepak a/l Gopal', 'dept-snm', 'pos-se', 'JHR', 3100, 'full-time', 'active', '2023-10-02', 'single', 0, false, '1996-02-11', 'male', 'employee', [['Mobile', 100]]],
    ['emp-14', 'Lee Sze Min', 'dept-snm', 'pos-mke', 'KUL', 3800, 'full-time', 'probation', '2025-11-03', 'single', 0, false, '1998-06-27', 'female', 'employee', []],
    ['emp-15', 'Mohd Syafiq bin Hamid', 'dept-snm', 'pos-se', 'PHG', 2800, 'full-time', 'active', '2024-07-15', 'married', 2, false, '1993-12-05', 'male', 'employee', [['Mobile', 100]]],
    ['emp-16', 'Alice Anak Janting', 'dept-cs', 'pos-csr', 'SWK', 2400, 'full-time', 'active', '2023-01-09', 'single', 0, false, '1999-04-16', 'female', 'employee', []],
    ['emp-17', 'Veronica Sintal', 'dept-cs', 'pos-csr', 'SBH', 2350, 'full-time', 'active', '2024-05-20', 'single', 0, false, '2000-01-08', 'female', 'employee', []],
    ['emp-18', 'Goh Kian Beng', 'dept-cs', 'pos-csr', 'KUL', 2600, 'full-time', 'active', '2022-12-12', 'married', 0, false, '1995-11-29', 'male', 'employee', []],
    ['emp-19', 'Farah Nabila binti Zainal', 'dept-cs', 'pos-csr', 'KUL', 1500, 'part-time', 'active', '2024-09-02', 'single', 0, false, '2001-03-22', 'female', 'employee', []],
    ['emp-20', 'Harjit Singh a/l Balwant', 'dept-ops', 'pos-om', 'SGR', 8200, 'full-time', 'active', '2020-06-08', 'married', 3, false, '1986-07-19', 'male', 'manager', [['Transport', 400]]],
    ['emp-21', 'Mohd Rizal bin Yusof', 'dept-ops', 'pos-tech', 'SGR', 2900, 'full-time', 'active', '2021-11-01', 'married', 2, false, '1991-09-14', 'male', 'employee', []],
    ['emp-22', 'Ramesh Shrestha', 'dept-ops', 'pos-wh', 'SGR', 1850, 'full-time', 'active', '2024-02-05', 'married', 1, true, '1995-05-30', 'male', 'employee', []],
    ['emp-23', 'Md Rafiqul Islam', 'dept-ops', 'pos-tech', 'KUL', 1900, 'full-time', 'active', '2024-08-19', 'married', 0, true, '1994-10-11', 'male', 'employee', []],
    ['emp-24', 'Saravanan a/l Perumal', 'dept-ops', 'pos-drv', 'PRK', 2300, 'full-time', 'active', '2022-05-23', 'married', 2, false, '1989-12-01', 'male', 'employee', []],
    ['emp-25', 'Teoh Ai Ling', 'dept-ops', 'pos-clerk', 'KUL', 2100, 'part-time', 'active', '2015-04-06', 'widowed', 1, false, '1963-08-15', 'female', 'employee', []],
    ['emp-26', 'Amirul Hakim bin Roslan', 'dept-eng', 'pos-da', 'KUL', 4100, 'full-time', 'probation', '2025-10-13', 'single', 0, false, '1999-11-24', 'male', 'employee', []],
    ['emp-27', 'Grace Ling Su Yin', 'dept-snm', 'pos-mke', 'PNG', 3500, 'full-time', 'active', '2023-08-28', 'single', 0, false, '1997-04-09', 'female', 'employee', []],
    ['emp-28', 'Kumar a/l Veloo', 'dept-ops', 'pos-wh', 'KDH', 1750, 'contract', 'active', '2025-01-06', 'single', 0, false, '2000-06-18', 'male', 'employee', []],
    ['emp-29', 'Noraini binti Sulaiman', 'dept-fin', 'pos-acc', 'KUL', 6800, 'full-time', 'active', '2017-10-16', 'married', 4, false, '1983-01-27', 'female', 'employee', []],
    ['emp-30', 'Brandon Koh Jin Wei', 'dept-eng', 'pos-swe', 'JHR', 5500, 'full-time', 'active', '2021-06-21', 'married', 1, false, '1993-08-31', 'male', 'employee', []],
  ];

  const employees = buildEmployees(empRows, 'asmtech.my', 'ASM');

  // Department heads
  const headOf: Record<string, string> = {
    'dept-eng': 'emp-01', 'dept-hr': 'emp-02', 'dept-fin': 'emp-03',
    'dept-snm': 'emp-12', 'dept-ops': 'emp-20', 'dept-cs': 'emp-18',
  };
  departments.forEach((d) => { d.headId = headOf[d.id]; });

  // ── Shifts ─────────────────────────────────────────────────────────────────
  const shifts: Shift[] = [
    { id: 'shift-normal', name: 'Normal (9–6)', startTime: '09:00', endTime: '18:00', breakMinutes: 60, workDays: [1, 2, 3, 4, 5], restDay: 0 },
    { id: 'shift-svc-a', name: 'Service Shift A (7–3)', startTime: '07:00', endTime: '15:00', breakMinutes: 45, workDays: [1, 2, 3, 4, 5, 6], restDay: 0 },
    { id: 'shift-svc-b', name: 'Service Shift B (2–10)', startTime: '14:00', endTime: '22:00', breakMinutes: 45, workDays: [1, 2, 3, 4, 5, 6], restDay: 0 },
    { id: 'shift-support', name: 'Support Roster (8–5)', startTime: '08:00', endTime: '17:00', breakMinutes: 60, workDays: [1, 2, 3, 4, 5], restDay: 0 },
  ];

  // ── Attendance: previous month + current month-to-date ────────────────────
  const otEmployees = new Set(['emp-05', 'emp-06', 'emp-08', 'emp-12', 'emp-13', 'emp-16', 'emp-18', 'emp-21', 'emp-22', 'emp-23', 'emp-24', 'emp-28', 'emp-11']);
  const attendance = generateAttendance(employees, {
    rnd,
    weekendDows: [0, 6],
    shiftFor: (e) =>
      e.departmentId === 'dept-cs' ? shifts[3]
      : e.departmentId === 'dept-ops' && e.positionId === 'pos-tech' ? shifts[e.id === 'emp-21' ? 1 : 2]
      : shifts[0],
    otEmployeeIds: otEmployees,
    extraRestDayOt: (e, dow) => e.departmentId === 'dept-ops' && dow === 6,
  });

  // ── Leave balances (EA 1955 s.60E/60F tiers on service length) ────────────
  const leaveBalances = generateLeaveBalances(employees, year, rnd);

  // ── Leave requests ─────────────────────────────────────────────────────────
  const leaves: LeaveRequest[] = [
    mkLeave('emp-05', 'annual', `${thisMonth}-24`, `${thisMonth}-25`, 2, 'approved', 'Family matter', 'emp-02'),
    mkLeave('emp-13', 'annual', `${thisMonth}-20`, `${thisMonth}-21`, 2, 'pending', 'Kenduri in Johor'),
    mkLeave('emp-16', 'annual', `${prevMonth}-10`, `${prevMonth}-11`, 2, 'approved', 'Short break', 'emp-02'),
    mkLeave('emp-09', 'sick', `${thisMonth}-06`, `${thisMonth}-06`, 1, 'approved', 'Fever, MC attached', 'emp-02'),
    mkLeave('emp-11', 'sick', `${prevMonth}-18`, `${prevMonth}-19`, 2, 'approved', 'Food poisoning', 'emp-02'),
    mkLeave('emp-27', 'annual', `${thisMonth}-28`, `${thisMonth}-29`, 2, 'pending', 'Travel'),
    mkLeave('emp-21', 'unpaid', `${thisMonth}-10`, `${thisMonth}-12`, 3, 'approved', 'Hajj preparation (unpaid)', 'emp-02'),
    mkLeave('emp-15', 'annual', `${prevMonth}-26`, `${prevMonth}-27`, 2, 'rejected', 'Peak sales period', 'emp-02'),
    mkLeave('emp-24', 'emergency', `${thisMonth}-08`, `${thisMonth}-08`, 1, 'approved', 'Father hospitalised', 'emp-02'),
    mkLeave('emp-02', 'maternity', `${thisMonth}-01`, `${thisMonth}-31`, 30, 'approved', 'Maternity leave (98 days, part 1)', 'emp-02'),
    mkLeave('emp-30', 'paternity', `${prevMonth}-05`, `${prevMonth}-11`, 7, 'approved', 'Paternity leave (7 days)', 'emp-02'),
    mkLeave('emp-08', 'annual', `${thisMonth}-15`, `${thisMonth}-16`, 2, 'pending', 'Personal'),
  ];

  // ── Claims ─────────────────────────────────────────────────────────────────
  const claims: Claim[] = [
    mkClaim('emp-13', 'travel', 'Client visit JB–Kluang toll & petrol', 186.5, `${thisMonth}-07`, 'approved', 'emp-03'),
    mkClaim('emp-12', 'meal', 'Team lunch with distributor', 240, `${thisMonth}-05`, 'approved', 'emp-03'),
    mkClaim('emp-15', 'travel', 'Kuantan site trip mileage', 312.4, `${thisMonth}-11`, 'submitted'),
    mkClaim('emp-27', 'training', 'Meta Ads certification exam', 450, `${thisMonth}-09`, 'submitted'),
    mkClaim('emp-04', 'telephone', 'On-call mobile top-up', 50, `${prevMonth}-22`, 'approved', 'emp-03'),
    mkClaim('emp-21', 'medical', 'Panel clinic — not covered portion', 75.9, `${thisMonth}-14`, 'submitted'),
    mkClaim('emp-10', 'parking', 'KL Sentral monthly parking (audit week)', 180, `${prevMonth}-28`, 'approved', 'emp-03'),
    mkClaim('emp-30', 'travel', 'JB office commute — grab receipts', 96.2, `${thisMonth}-03`, 'rejected', 'emp-03'),
    mkClaim('emp-18', 'meal', 'Support team OT dinner', 132.8, `${thisMonth}-17`, 'submitted'),
    mkClaim('emp-01', 'travel', 'Flight KUL–BKI partner meeting', 688, `${prevMonth}-15`, 'approved', 'emp-03'),
  ];

  // ── KPIs + one review cycle ────────────────────────────────────────────────
  const period = `${year}-H1`;
  const kpiSeeds: [string, string, string, number][] = [
    ['emp-04', 'Ship payment-gateway v2', 'Zero sev-1 defects at launch', 40],
    ['emp-04', 'Reduce API p95 latency', 'p95 < 250ms', 30],
    ['emp-04', 'Mentor 2 junior engineers', '4 pairing sessions/mth', 30],
    ['emp-05', 'Deliver onboarding revamp', 'Activation +8%', 50],
    ['emp-05', 'Cut build time', '< 6 min CI', 50],
    ['emp-09', 'Time-to-hire', '≤ 35 days avg', 60],
    ['emp-09', 'eNPS pulse', '≥ +20', 40],
    ['emp-10', 'Close month-end', 'By WD+3', 50],
    ['emp-10', 'AR days', '≤ 45 days', 50],
    ['emp-12', 'New business pipeline', 'RM 400k qualified', 70],
    ['emp-12', 'CRM hygiene', '100% fields current', 30],
    ['emp-13', 'Southern region revenue', 'RM 150k/quarter', 100],
    ['emp-16', 'CSAT score', '≥ 92%', 50],
    ['emp-16', 'First-response time', '≤ 2h', 50],
    ['emp-20', 'OT utilization within cap', '0 months > 104h', 40],
    ['emp-20', 'Warehouse accuracy', '≥ 99.2%', 60],
    ['emp-07', 'Dashboard adoption', '80% weekly actives', 60],
    ['emp-07', 'Data quality incidents', '≤ 1/quarter', 40],
  ];
  const kpis: KPI[] = kpiSeeds.map(([empId, title, target, weight]) => ({
    id: uid(), employeeId: empId, title, target, weight, period, status: 'active',
  }));

  const reviews: KPIReview[] = ['emp-04', 'emp-12', 'emp-16'].map((empId, i) => {
    const mine = kpis.filter((k) => k.employeeId === empId);
    const scores = mine.map((k) => ({ kpiId: k.id, score: 62 + Math.floor(rnd() * 30) }));
    const overall = Math.round(
      scores.reduce((s, sc) => {
        const k = mine.find((kk) => kk.id === sc.kpiId)!;
        return s + (sc.score * k.weight) / 100;
      }, 0),
    );
    return {
      id: uid(), employeeId: empId,
      reviewerId: i === 1 ? 'emp-01' : 'emp-02',
      period: `${year - 1}-H2`,
      scores, overallScore: overall,
      comments: overall >= 80 ? 'Strong half — stretch targets proposed.' : 'Solid progress; tighten execution discipline.',
      status: i === 2 ? 'submitted' : 'acknowledged',
      createdAt: `${year}-01-15T09:00:00`,
    };
  });

  // ── Settings singleton ─────────────────────────────────────────────────────
  const settings: Settings[] = [
    {
      id: 'company',
      companyName: 'ASM Tech Sdn Bhd',
      companyRegNo: '201501023456 (1144228-K)',
      hqState: 'KUL',
      address: 'Level 12, Menara ASM, Jalan Sultan Ismail, 50250 Kuala Lumpur',
      epfEmployerNo: 'KWSP 1234567-01',
      socsoEmployerNo: 'PERKESO B12345678',
      taxEmployerNo: 'E 1234567890',
      paydayDay: 7,
      standardDailyHours: 8,
      standardWeeklyHours: 45,
    },
  ];

  return {
    departments, positions, employees, shifts, attendance,
    leaves, leaveBalances, claims, kpis, reviews, settings,
    payrollRuns: [], payslips: [], holidays: [], audit: [],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * co-merdeka — Merdeka Manufacturing Sdn Bhd (JHR, fri-sat weekend)
 * ──────────────────────────────────────────────────────────────────────────── */

function buildMerdekaSeedData(): Record<string, unknown[]> {
  const departments: Department[] = [
    { id: 'mdept-prd', name: 'Production', code: 'PRD', state: 'JHR' },
    { id: 'mdept-qa', name: 'Quality Assurance', code: 'QA', state: 'JHR' },
    { id: 'mdept-mnt', name: 'Maintenance', code: 'MNT', state: 'JHR' },
    { id: 'mdept-hra', name: 'HR & Admin', code: 'HRA', state: 'JHR' },
    { id: 'mdept-wh', name: 'Warehouse', code: 'WH', state: 'JHR' },
  ];
  const positions: Position[] = [
    { id: 'mpos-pm', title: 'Production Manager', departmentId: 'mdept-prd', level: 'manager', minSalary: 7000, maxSalary: 11000 },
    { id: 'mpos-ll', title: 'Line Leader', departmentId: 'mdept-prd', level: 'lead', minSalary: 2800, maxSalary: 4200 },
    { id: 'mpos-op', title: 'Production Operator', departmentId: 'mdept-prd', level: 'junior', minSalary: 1700, maxSalary: 2600 },
    { id: 'mpos-qa', title: 'QA Inspector', departmentId: 'mdept-qa', level: 'junior', minSalary: 2000, maxSalary: 3200 },
    { id: 'mpos-mt', title: 'Maintenance Technician', departmentId: 'mdept-mnt', level: 'senior', minSalary: 2600, maxSalary: 4000 },
    { id: 'mpos-hr', title: 'HR & Admin Executive', departmentId: 'mdept-hra', level: 'junior', minSalary: 2800, maxSalary: 4500 },
    { id: 'mpos-wh', title: 'Warehouse Assistant', departmentId: 'mdept-wh', level: 'junior', minSalary: 1700, maxSalary: 2500 },
  ];
  const empRows: EmpRow[] = [
    ['mrd-01', 'Zulkifli bin Ahmad', 'mdept-prd', 'mpos-pm', 'JHR', 8800, 'full-time', 'active', '2016-04-11', 'married', 3, false, '1982-03-19', 'male', 'manager', [['Transport', 400]]],
    ['mrd-02', 'Maslina binti Omar', 'mdept-hra', 'mpos-hr', 'JHR', 3600, 'full-time', 'active', '2021-02-01', 'married', 1, false, '1993-07-08', 'female', 'hr', []],
    ['mrd-03', 'Tan Ah Kow', 'mdept-prd', 'mpos-ll', 'JHR', 3400, 'full-time', 'active', '2019-08-19', 'married', 2, false, '1988-12-02', 'male', 'employee', []],
    ['mrd-04', 'Suresh a/l Krishnan', 'mdept-prd', 'mpos-op', 'JHR', 1950, 'full-time', 'active', '2023-03-06', 'single', 0, false, '1998-05-21', 'male', 'employee', []],
    ['mrd-05', 'Nurul Huda binti Kamal', 'mdept-prd', 'mpos-op', 'JHR', 1900, 'full-time', 'active', '2024-01-15', 'single', 0, false, '2000-09-11', 'female', 'employee', []],
    ['mrd-06', 'Mohd Faiz bin Sulaiman', 'mdept-prd', 'mpos-op', 'JHR', 2100, 'full-time', 'probation', '2025-11-10', 'single', 0, false, '1999-02-14', 'male', 'employee', []],
    ['mrd-07', 'Revathi a/p Muniandy', 'mdept-qa', 'mpos-qa', 'JHR', 2600, 'full-time', 'active', '2022-06-20', 'married', 1, false, '1994-10-30', 'female', 'employee', []],
    ['mrd-08', 'Lim Chee Keong', 'mdept-qa', 'mpos-qa', 'JHR', 2400, 'full-time', 'active', '2023-09-04', 'single', 0, false, '1997-04-05', 'male', 'employee', []],
    ['mrd-09', 'Hamdan bin Yusof', 'mdept-mnt', 'mpos-mt', 'JHR', 3300, 'full-time', 'active', '2020-10-12', 'married', 2, false, '1990-01-27', 'male', 'employee', []],
    ['mrd-10', 'Nguyen Van Thanh', 'mdept-wh', 'mpos-wh', 'JHR', 1850, 'contract', 'active', '2024-05-02', 'married', 0, true, '1996-08-16', 'male', 'employee', []],
    ['mrd-11', 'Azlina binti Mohd Nor', 'mdept-wh', 'mpos-wh', 'JHR', 1900, 'part-time', 'active', '2023-11-20', 'single', 0, false, '2001-06-09', 'female', 'employee', []],
    ['mrd-12', 'Koh Boon Seng', 'mdept-prd', 'mpos-op', 'JHR', 2000, 'full-time', 'active', '2025-02-17', 'single', 0, false, '2000-11-23', 'male', 'employee', []],
  ];
  const shifts: Shift[] = [
    { id: 'mshift-day', name: 'Day Shift (8–5, Sun–Thu)', startTime: '08:00', endTime: '17:00', breakMinutes: 60, workDays: [0, 1, 2, 3, 4], restDay: 5 },
    { id: 'mshift-eve', name: 'Evening Shift (2–10, Sun–Thu)', startTime: '14:00', endTime: '22:00', breakMinutes: 45, workDays: [0, 1, 2, 3, 4], restDay: 5 },
  ];
  return buildCompanySeedData({
    companyId: COMPANY_ID_MERDEKA,
    emailDomain: 'merdekamfg.my',
    rngSeed: 20260211,
    departments,
    deptHeads: { 'mdept-prd': 'mrd-01', 'mdept-hra': 'mrd-02', 'mdept-qa': 'mrd-07', 'mdept-mnt': 'mrd-09', 'mdept-wh': 'mrd-10' },
    positions,
    empRows,
    shifts,
    weekendDows: [5, 6],
    settings: {
      companyName: 'Merdeka Manufacturing Sdn Bhd',
      companyRegNo: '201108004321 (932211-A)',
      hqState: 'JHR',
      address: 'Lot 14, Jalan Perindustrian 5, Kawasan Perindustrian Tebrau, 81100 Johor Bahru, Johor',
      epfEmployerNo: 'KWSP 7654321-02',
      socsoEmployerNo: 'PERKESO B87654321',
      taxEmployerNo: 'E 9876543210',
      paydayDay: 7,
      standardDailyHours: 8,
      standardWeeklyHours: 45,
    },
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * co-desa — Desa Retail Group (PNG)
 * ──────────────────────────────────────────────────────────────────────────── */

function buildDesaSeedData(): Record<string, unknown[]> {
  const departments: Department[] = [
    { id: 'ddept-store', name: 'Store Operations', code: 'STORE', state: 'PNG' },
    { id: 'ddept-mch', name: 'Merchandising', code: 'MCH', state: 'PNG' },
    { id: 'ddept-hq', name: 'Head Office', code: 'HQ', state: 'PNG' },
  ];
  const positions: Position[] = [
    { id: 'dpos-sm', title: 'Store Manager', departmentId: 'ddept-store', level: 'manager', minSalary: 4500, maxSalary: 7500 },
    { id: 'dpos-ra', title: 'Retail Associate', departmentId: 'ddept-store', level: 'junior', minSalary: 1700, maxSalary: 2600 },
    { id: 'dpos-cs', title: 'Cashier', departmentId: 'ddept-store', level: 'junior', minSalary: 1700, maxSalary: 2400 },
    { id: 'dpos-md', title: 'Merchandiser', departmentId: 'ddept-mch', level: 'junior', minSalary: 2000, maxSalary: 3200 },
    { id: 'dpos-hr', title: 'HR & Accounts Clerk', departmentId: 'ddept-hq', level: 'junior', minSalary: 2400, maxSalary: 3800 },
  ];
  const empRows: EmpRow[] = [
    ['desa-01', 'Ooi Ee Ling', 'ddept-store', 'dpos-sm', 'PNG', 5600, 'full-time', 'active', '2019-05-13', 'married', 2, false, '1987-09-02', 'female', 'manager', [['Transport', 300]]],
    ['desa-02', 'Balqis binti Mohd Amin', 'ddept-hq', 'dpos-hr', 'PNG', 2900, 'full-time', 'active', '2022-03-07', 'single', 0, false, '1996-01-25', 'female', 'hr', []],
    ['desa-03', 'Hari Prasad a/l Nair', 'ddept-mch', 'dpos-md', 'PNG', 2500, 'full-time', 'active', '2023-07-10', 'single', 0, false, '1997-12-17', 'male', 'employee', []],
    ['desa-04', 'Chia Pei Shan', 'ddept-store', 'dpos-ra', 'PNG', 1900, 'full-time', 'active', '2024-04-22', 'single', 0, false, '2000-03-08', 'female', 'employee', []],
    ['desa-05', 'Amirul Aiman bin Zaki', 'ddept-store', 'dpos-cs', 'PNG', 1850, 'full-time', 'active', '2024-09-16', 'single', 0, false, '2001-07-29', 'male', 'employee', []],
    ['desa-06', 'Devika a/p Selvam', 'ddept-store', 'dpos-cs', 'PNG', 1800, 'part-time', 'active', '2025-01-06', 'single', 0, false, '2002-05-14', 'female', 'employee', []],
    ['desa-07', 'Firdaus bin Rahman', 'ddept-store', 'dpos-ra', 'PNG', 2100, 'full-time', 'probation', '2025-12-08', 'single', 0, false, '1999-10-01', 'male', 'employee', []],
    ['desa-08', 'Wong Siew May', 'ddept-mch', 'dpos-md', 'PNG', 2650, 'full-time', 'active', '2021-11-29', 'married', 1, false, '1992-08-19', 'female', 'employee', []],
  ];
  const shifts: Shift[] = [
    { id: 'dshift-am', name: 'Morning (9–6)', startTime: '09:00', endTime: '18:00', breakMinutes: 60, workDays: [1, 2, 3, 4, 5, 6], restDay: 0 },
    { id: 'dshift-pm', name: 'Evening (12–9)', startTime: '12:00', endTime: '21:00', breakMinutes: 60, workDays: [1, 2, 3, 4, 5, 6], restDay: 0 },
  ];
  return buildCompanySeedData({
    companyId: COMPANY_ID_DESA,
    emailDomain: 'desaretail.my',
    rngSeed: 20260307,
    departments,
    deptHeads: { 'ddept-store': 'desa-01', 'ddept-hq': 'desa-02', 'ddept-mch': 'desa-08' },
    positions,
    empRows,
    shifts,
    weekendDows: [0, 6],
    settings: {
      companyName: 'Desa Retail Group',
      companyRegNo: '201901007654 (1317765-V)',
      hqState: 'PNG',
      address: '88, Jalan Macalister, 10400 George Town, Pulau Pinang',
      epfEmployerNo: 'KWSP 5551234-03',
      socsoEmployerNo: 'PERKESO B55512345',
      taxEmployerNo: 'E 5551234567',
      paydayDay: 7,
      standardDailyHours: 8,
      standardWeeklyHours: 45,
    },
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Entry point used by db.ts seeding
 * ──────────────────────────────────────────────────────────────────────────── */

export interface TenantSeed {
  company: Company;
  collections: Record<string, unknown[]>;
}

/** Full seed (Company record + tenant collections) for one demo company. */
export function buildTenantSeedData(companyId: string): TenantSeed | null {
  switch (companyId) {
    case COMPANY_ID_ASM:
      return { company: companySeedRecord(companyId), collections: buildSeedData() };
    case COMPANY_ID_MERDEKA:
      return { company: companySeedRecord(companyId), collections: buildMerdekaSeedData() };
    case COMPANY_ID_DESA:
      return { company: companySeedRecord(companyId), collections: buildDesaSeedData() };
    case COMPANY_ID_ASMDIV:
      // ASM Tech Division Sdn Bhd — REAL tenant, intentionally EMPTY:
      // no demo employees/attendance/claims; the owner customizes from scratch.
      return { company: companySeedRecord(companyId), collections: {} };
    default:
      return null;
  }
}
