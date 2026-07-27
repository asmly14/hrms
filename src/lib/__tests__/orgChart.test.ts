/**
 * Org chart data-bridge tests: initial tree derivation (root/dept-lead/staff),
 * profile-override resolution with cycle protection, headcount/vacancy math,
 * employee-tree resolution, and per-tenant profile persistence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { setActiveTenantId } from '../db';
import {
  buildEmployeeTree,
  buildInitialChart,
  collectDescendants,
  defaultDeptColor,
  deptColor,
  directReports,
  effectiveGrade,
  getDepartmentProfile,
  getPositionProfile,
  gradeForLevel,
  headcountByPosition,
  isVacant,
  removePositionProfile,
  resolveReportsTo,
  seniorityForLevel,
  upsertDepartmentProfile,
  upsertPositionProfile,
  vacancyCount,
  wouldCreateCycle,
  type PositionProfile,
} from '../orgChart';
import type { Department, Employee, Position } from '../types';

beforeEach(() => {
  installLocalStorage();
  setActiveTenantId('co-asm');
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const departments: Department[] = [
  { id: 'dept-exec', name: 'Executive', code: 'EXEC', state: 'KUL' },
  { id: 'dept-eng', name: 'Engineering', code: 'ENG', state: 'KUL', headId: 'emp-pm' },
  { id: 'dept-hr', name: 'Human Resources', code: 'HR', state: 'KUL', headId: 'emp-hrm' },
];

const positions: Position[] = [
  { id: 'pos-md', title: 'Managing Director', departmentId: 'dept-exec', level: 'exec', minSalary: 15000, maxSalary: 25000 },
  { id: 'pos-pm', title: 'Project Manager', departmentId: 'dept-eng', level: 'manager', minSalary: 8000, maxSalary: 14000 },
  { id: 'pos-sswe', title: 'Senior Software Engineer', departmentId: 'dept-eng', level: 'senior', minSalary: 6500, maxSalary: 11000 },
  { id: 'pos-swe', title: 'Software Engineer', departmentId: 'dept-eng', level: 'junior', minSalary: 3500, maxSalary: 6000 },
  { id: 'pos-hrm', title: 'HR Manager', departmentId: 'dept-hr', level: 'manager', minSalary: 7000, maxSalary: 12000 },
  { id: 'pos-hre', title: 'HR Executive', departmentId: 'dept-hr', level: 'junior', minSalary: 2500, maxSalary: 4500 },
];

let seq = 0;
function emp(id: string, positionId: string, departmentId: string, status: Employee['status'] = 'active'): Employee {
  seq += 1;
  return {
    id,
    name: `Employee ${id}`,
    ic: `90010${seq}-01-1234`,
    email: `${id}@example.com`,
    phone: '012-3456789',
    departmentId,
    positionId,
    role: 'employee',
    joinDate: `2020-0${(seq % 9) + 1}-15`,
    state: 'KUL',
    employmentType: 'full-time',
    status,
    baseSalary: 4000,
    maritalStatus: 'single',
    children: 0,
    bankName: 'Maybank',
    bankAccount: '1234567890',
    epfNo: `EPF${seq}`,
    socsoNo: `SOC${seq}`,
    taxNo: `TAX${seq}`,
    isForeignWorker: false,
    dateOfBirth: '1990-01-01',
    gender: 'male',
    fixedAllowances: [],
  };
}

const employees: Employee[] = [
  emp('emp-md', 'pos-md', 'dept-exec'),
  emp('emp-pm', 'pos-pm', 'dept-eng'),
  emp('emp-dev1', 'pos-swe', 'dept-eng'),
  emp('emp-dev2', 'pos-swe', 'dept-eng'),
  emp('emp-hrm', 'pos-hrm', 'dept-hr'),
  emp('emp-gone', 'pos-hre', 'dept-hr', 'resigned'),
];

// ── buildInitialChart ───────────────────────────────────────────────────────

describe('buildInitialChart', () => {
  it('roots the tree at the MD/CEO-titled position', () => {
    const map = buildInitialChart(positions, employees, departments);
    expect(map['pos-md']).toBeNull();
  });

  it('puts department leads under the root and staff under their lead', () => {
    const map = buildInitialChart(positions, employees, departments);
    expect(map['pos-pm']).toBe('pos-md'); // eng lead (via headId)
    expect(map['pos-hrm']).toBe('pos-md'); // hr lead
    expect(map['pos-swe']).toBe('pos-pm');
    expect(map['pos-sswe']).toBe('pos-pm');
    expect(map['pos-hre']).toBe('pos-hrm');
  });

  it('falls back to the most senior position as root when no MD/GM title exists', () => {
    const noMd = positions.filter((p) => p.id !== 'pos-md');
    const noExec = departments.filter((d) => d.id !== 'dept-exec');
    const noMdEmps = employees.filter((e) => e.id !== 'emp-md');
    const map = buildInitialChart(noMd, noMdEmps, noExec);
    // Both managers tie on level — the higher salary band (Project Manager) wins.
    expect(map['pos-pm']).toBeNull();
    expect(map['pos-hrm']).toBe('pos-pm');
    expect(map['pos-hre']).toBe('pos-hrm');
  });

  it('handles empty input', () => {
    expect(buildInitialChart([], [], [])).toEqual({});
  });
});

// ── resolveReportsTo (override + cycle protection) ─────────────────────────

describe('resolveReportsTo', () => {
  it('lets a profile override win over the derived parent', () => {
    const profiles: PositionProfile[] = [
      { id: 'pos-swe', positionId: 'pos-swe', reportsToPositionId: 'pos-hrm', responsibilities: [], qualifications: [], updatedAt: '' },
    ];
    const map = resolveReportsTo(positions, profiles, employees, departments);
    expect(map['pos-swe']).toBe('pos-hrm');
    expect(map['pos-sswe']).toBe('pos-pm'); // untouched derivation
  });

  it('ignores overrides that would create a cycle', () => {
    const profiles: PositionProfile[] = [
      { id: 'pos-md', positionId: 'pos-md', reportsToPositionId: 'pos-swe', responsibilities: [], qualifications: [], updatedAt: '' },
    ];
    const map = resolveReportsTo(positions, profiles, employees, departments);
    expect(map['pos-md']).toBeNull(); // stays root
  });

  it('ignores overrides pointing at missing positions or self', () => {
    const profiles: PositionProfile[] = [
      { id: 'pos-swe', positionId: 'pos-swe', reportsToPositionId: 'pos-ghost', responsibilities: [], qualifications: [], updatedAt: '' },
      { id: 'pos-sswe', positionId: 'pos-sswe', reportsToPositionId: 'pos-sswe', responsibilities: [], qualifications: [], updatedAt: '' },
    ];
    const map = resolveReportsTo(positions, profiles, employees, departments);
    expect(map['pos-swe']).toBe('pos-pm');
    expect(map['pos-sswe']).toBe('pos-pm');
  });
});

// ── Tree helpers ────────────────────────────────────────────────────────────

describe('tree helpers', () => {
  const map = buildInitialChart(positions, employees, departments);

  it('collectDescendants walks the whole subtree', () => {
    const under = collectDescendants(map, 'pos-md');
    expect(under.size).toBe(5);
    expect(collectDescendants(map, 'pos-pm').has('pos-swe')).toBe(true);
    expect(collectDescendants(map, 'pos-pm').has('pos-hre')).toBe(false);
  });

  it('directReports lists immediate children only', () => {
    expect(directReports(map, 'pos-md').sort()).toEqual(['pos-hrm', 'pos-pm']);
  });

  it('wouldCreateCycle flags descendant targets', () => {
    expect(wouldCreateCycle(map, 'pos-md', 'pos-swe')).toBe(true);
    expect(wouldCreateCycle(map, 'pos-swe', 'pos-hrm')).toBe(false);
    expect(wouldCreateCycle(map, 'pos-swe', 'pos-swe')).toBe(true);
  });
});

// ── Headcount & vacancy ─────────────────────────────────────────────────────

describe('headcount & vacancy', () => {
  it('counts only active/probation holders (resigned excluded)', () => {
    const counts = headcountByPosition(employees);
    expect(counts.get('pos-swe')).toBe(2);
    expect(counts.get('pos-hre')).toBeUndefined(); // only a resigned holder
  });

  it('flags vacancies when budget exceeds actual holders', () => {
    const profile: PositionProfile = {
      id: 'pos-swe', positionId: 'pos-swe', headcountBudget: 3, responsibilities: [], qualifications: [], updatedAt: '',
    };
    expect(isVacant(profile, 2)).toBe(true);
    expect(vacancyCount(profile, 2)).toBe(1);
    expect(isVacant(profile, 3)).toBe(false);
    expect(isVacant(undefined, 0)).toBe(false); // unmanaged positions never flagged
  });
});

// ── buildEmployeeTree ───────────────────────────────────────────────────────

describe('buildEmployeeTree', () => {
  it('resolves managers via the position tree holders', () => {
    const posMap = buildInitialChart(positions, employees, departments);
    const tree = buildEmployeeTree(employees, posMap);
    expect(tree['emp-md']).toBeNull(); // root holder
    expect(tree['emp-pm']).toBe('emp-md');
    expect(tree['emp-dev1']).toBe('emp-pm');
    expect(tree['emp-dev2']).toBe('emp-pm');
    expect(tree['emp-hrm']).toBe('emp-md');
  });

  it('attaches employees to the root holder when no ancestor is occupied', () => {
    const lean = employees.filter((e) => ['emp-md', 'emp-dev1'].includes(e.id));
    const posMap = buildInitialChart(positions, lean, departments);
    const tree = buildEmployeeTree(lean, posMap);
    expect(tree['emp-dev1']).toBe('emp-md'); // pm position empty → climbs to root
  });
});

// ── Grades ──────────────────────────────────────────────────────────────────

describe('grades', () => {
  it('maps levels to default grades and seniority years', () => {
    expect(gradeForLevel('junior')).toBe('L2');
    expect(gradeForLevel('exec')).toBe('L8');
    expect(seniorityForLevel('manager')).toBe(8);
    expect(effectiveGrade(positions[3])).toBe('L2'); // pos-swe, no profile
    expect(
      effectiveGrade(positions[3], {
        id: 'pos-swe', positionId: 'pos-swe', grade: 'L5', responsibilities: [], qualifications: [], updatedAt: '',
      }),
    ).toBe('L5'); // profile wins
  });
});

// ── Profile persistence (per-tenant) ───────────────────────────────────────

describe('profile persistence', () => {
  it('round-trips position profiles and deletes them', () => {
    upsertPositionProfile('pos-swe', { grade: 'L3', jobDescription: 'Builds features', headcountBudget: 4 });
    const p = getPositionProfile('pos-swe');
    expect(p?.grade).toBe('L3');
    expect(p?.jobDescription).toBe('Builds features');
    expect(p?.responsibilities).toEqual([]);
    removePositionProfile('pos-swe');
    expect(getPositionProfile('pos-swe')).toBeUndefined();
  });

  it('scopes profiles to the active tenant', () => {
    upsertPositionProfile('pos-swe', { grade: 'L3' });
    setActiveTenantId('co-merdeka');
    expect(getPositionProfile('pos-swe')).toBeUndefined();
    upsertPositionProfile('pos-swe', { grade: 'L7' });
    setActiveTenantId('co-asm');
    expect(getPositionProfile('pos-swe')?.grade).toBe('L3');
    setActiveTenantId('co-merdeka');
    expect(getPositionProfile('pos-swe')?.grade).toBe('L7');
  });

  it('round-trips department profiles with deterministic colour fallback', () => {
    expect(deptColor('dept-eng', [])).toBe(defaultDeptColor('dept-eng'));
    upsertDepartmentProfile('dept-eng', { costCenter: 'CC-100', color: '#0f766e' });
    expect(getDepartmentProfile('dept-eng')?.costCenter).toBe('CC-100');
    expect(deptColor('dept-eng', [getDepartmentProfile('dept-eng')!])).toBe('#0f766e');
  });
});
