/**
 * Unified approvals inbox — aggregation math + role scoping tests.
 *
 * Covers the pure logic in ../model (the same functions the /approvals page
 * and the NotificationBell consume via usePendingApprovals):
 *   - scoping mirrors lib/authContext (Admin/HR/SuperAdmin unrestricted,
 *     Manager own department, Employee own records, fail closed when
 *     unlinked, fail open in pre-auth permissive mode);
 *   - pending filters/order mirror the source modules (ApprovalsQueue /
 *     ApproverInbox / OTManager);
 *   - counts are the shared badge numbers (bell === inbox);
 *   - self rows are visible but never decidable;
 *   - "recently decided (7 days)" windows per module;
 *   - the 104h/month OT cap re-check and row age math.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from '../../../lib/__tests__/storageStub';
import type { Employee } from '../../../lib/types';
import type { AttendanceX } from '../../attendance/model';
import type { ClaimRecord } from '../../claims/claimPolicy';
import type { LeaveRequestEx } from '../../leave/leaveLogic';
import {
  ageInDays,
  approveWouldExceedOtCap,
  approvedOtHoursFor,
  buildPendingQueues,
  buildRecentDecisions,
  countQueues,
  excludeSelf,
  scopeByEmployee,
  visibleEmployeeIds,
  type ApprovalData,
  type ApprovalScope,
} from '../model';

beforeEach(() => {
  installLocalStorage();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const mkEmp = (id: string, departmentId: string): Employee =>
  ({ id, name: `Name ${id}`, departmentId, status: 'active' }) as unknown as Employee;

const employees = [
  mkEmp('m1', 'dept-a'), // the manager's linked record
  mkEmp('e1', 'dept-a'),
  mkEmp('e2', 'dept-a'),
  mkEmp('e3', 'dept-b'),
];

const leave = (
  id: string,
  employeeId: string,
  status: LeaveRequestEx['status'],
  appliedAt: string,
  decidedAt?: string,
): LeaveRequestEx => ({
  id,
  employeeId,
  type: 'annual',
  startDate: '2026-08-12',
  endDate: '2026-08-14',
  days: 3,
  status,
  appliedAt,
  decidedAt,
});

const claim = (
  id: string,
  employeeId: string,
  status: ClaimRecord['status'],
  submittedAt?: string,
  decidedAt?: string,
): ClaimRecord => ({
  id,
  employeeId,
  category: 'meal',
  title: `Claim ${id}`,
  amount: 100,
  claimDate: '2026-08-01',
  status,
  submittedAt,
  decidedAt,
});

const ot = (
  id: string,
  employeeId: string,
  date: string,
  flags: { requested?: boolean; approved?: boolean; rejected?: boolean; hours?: number },
): AttendanceX => ({
  id,
  employeeId,
  date,
  status: 'present',
  otHours: flags.hours ?? 2,
  otDayType: 'normal',
  otApproved: flags.approved ?? false,
  otRequested: flags.requested,
  otRejected: flags.rejected,
});

const data: ApprovalData = {
  leaves: [
    leave('l1', 'e1', 'pending', '2026-08-01'),
    leave('l2', 'e2', 'pending', '2026-08-03'),
    leave('l3', 'e3', 'pending', '2026-08-02'),
    leave('l4', 'e1', 'approved', '2026-07-20', '2026-08-09T09:00:00'),
    leave('l5', 'e2', 'rejected', '2026-07-10', '2026-07-30T10:00:00'),
    leave('l6', 'm1', 'pending', '2026-08-04'), // the manager's OWN request
  ],
  claims: [
    claim('c1', 'e1', 'submitted', '2026-08-02'),
    claim('c2', 'e3', 'submitted', '2026-08-01'),
    claim('c3', 'e2', 'draft'),
    claim('c4', 'e1', 'approved', '2026-07-25', '2026-08-08T08:00:00'),
    claim('c5', 'e2', 'approved', '2026-06-20', '2026-07-01T08:00:00'),
  ],
  attendance: [
    ot('a1', 'e1', '2026-08-05', { requested: true }),
    ot('a2', 'e3', '2026-08-07', { requested: true, hours: 3 }),
    ot('a3', 'e2', '2026-08-08', { requested: true, approved: true }),
    // Plain clock record with OT hours but NO request workflow — must not queue.
    ot('a4', 'e1', '2026-08-05', { hours: 2 }),
    ot('a5', 'e2', '2026-08-06', { requested: true, rejected: true, hours: 1 }),
    ot('a6', 'e1', '2026-07-20', { requested: true, approved: true }),
  ],
};

const scopeOf = (
  role: string | null,
  employeeId: string | null,
  permissive = false,
): ApprovalScope => ({ role, employeeId, employees, permissive });

const NOW = new Date('2026-08-10T12:00:00').getTime();

// ── Scoping (mirrors lib/authContext) ───────────────────────────────────────

describe('visibleEmployeeIds scoping', () => {
  it('Admin, HR and SuperAdmin are unrestricted (null)', () => {
    expect(visibleEmployeeIds(scopeOf('Admin', null))).toBeNull();
    expect(visibleEmployeeIds(scopeOf('HR', 'e1'))).toBeNull();
    expect(visibleEmployeeIds(scopeOf('SuperAdmin', null))).toBeNull();
  });

  it('Manager sees their own department plus themselves', () => {
    const ids = visibleEmployeeIds(scopeOf('Manager', 'm1'));
    expect(ids).toEqual(new Set(['m1', 'e1', 'e2']));
  });

  it('Manager whose linked record is missing falls back to self only', () => {
    const ids = visibleEmployeeIds(scopeOf('Manager', 'ghost'));
    expect(ids).toEqual(new Set(['ghost']));
  });

  it('Manager without a linked employee fails closed to nothing', () => {
    expect(visibleEmployeeIds(scopeOf('Manager', null))).toEqual(new Set());
  });

  it('Employee sees only their own id; unlinked Employee sees nothing', () => {
    expect(visibleEmployeeIds(scopeOf('Employee', 'e1'))).toEqual(new Set(['e1']));
    expect(visibleEmployeeIds(scopeOf('Employee', null))).toEqual(new Set());
  });

  it('permissive (pre-auth demo) mode fails open for any role', () => {
    expect(visibleEmployeeIds(scopeOf('Manager', null, true))).toBeNull();
    expect(visibleEmployeeIds(scopeOf('Employee', null, true))).toBeNull();
  });

  it('scopeByEmployee filters rows to the visible ids', () => {
    const rows = scopeByEmployee(data.leaves, (l) => l.employeeId, scopeOf('Manager', 'm1'));
    expect(rows.map((l) => l.id).sort()).toEqual(['l1', 'l2', 'l4', 'l5', 'l6']);
  });
});

// ── Pending queues (module-canonical filters + order) ───────────────────────

describe('buildPendingQueues', () => {
  it('Admin sees every pending queue, in each module’s canonical order', () => {
    const q = buildPendingQueues(data, scopeOf('Admin', null));
    // Leave: newest application first (ApprovalsQueue).
    expect(q.leave.map((l) => l.id)).toEqual(['l6', 'l2', 'l3', 'l1']);
    // Claims: FIFO by submittedAt (ApproverInbox).
    expect(q.claims.map((c) => c.id)).toEqual(['c2', 'c1']);
    // OT: newest work date first (OTManager).
    expect(q.ot.map((a) => a.id)).toEqual(['a2', 'a1']);
  });

  it('only decision-worthy rows queue: drafts, decided and non-request rows excluded', () => {
    const q = buildPendingQueues(data, scopeOf('Admin', null));
    expect(q.claims.find((c) => c.id === 'c3')).toBeUndefined(); // draft claim
    expect(q.claims.find((c) => c.id === 'c4')).toBeUndefined(); // already approved
    expect(q.leave.find((l) => l.id === 'l4')).toBeUndefined(); // approved leave
    expect(q.ot.find((a) => a.id === 'a3')).toBeUndefined(); // approved OT
    expect(q.ot.find((a) => a.id === 'a4')).toBeUndefined(); // no otRequested flag
    expect(q.ot.find((a) => a.id === 'a5')).toBeUndefined(); // rejected OT
  });

  it('Manager queues are limited to their own department', () => {
    const q = buildPendingQueues(data, scopeOf('Manager', 'm1'));
    expect(q.leave.map((l) => l.id)).toEqual(['l6', 'l2', 'l1']);
    expect(q.claims.map((c) => c.id)).toEqual(['c1']);
    expect(q.ot.map((a) => a.id)).toEqual(['a1']);
  });

  it('Employee queues contain only their own pending requests', () => {
    const q = buildPendingQueues(data, scopeOf('Employee', 'e1'));
    expect(q.leave.map((l) => l.id)).toEqual(['l1']);
    expect(q.claims.map((c) => c.id)).toEqual(['c1']);
    expect(q.ot.map((a) => a.id)).toEqual(['a1']);
  });

  it('unlinked Manager/Employee get empty queues (fail closed)', () => {
    const mgr = buildPendingQueues(data, scopeOf('Manager', null));
    expect(countQueues(mgr)).toEqual({ leave: 0, claims: 0, ot: 0, total: 0 });
    const emp = buildPendingQueues(data, scopeOf('Employee', null));
    expect(countQueues(emp)).toEqual({ leave: 0, claims: 0, ot: 0, total: 0 });
  });
});

// ── Counts — the shared bell/inbox badge numbers ────────────────────────────

describe('countQueues (bell badge === inbox badge)', () => {
  it('counts every queue row (including locked self rows) and sums the total', () => {
    const counts = countQueues(buildPendingQueues(data, scopeOf('Admin', null)));
    expect(counts).toEqual({ leave: 4, claims: 2, ot: 2, total: 8 });
  });

  it('Manager counts match the scoped inbox tabs', () => {
    const counts = countQueues(buildPendingQueues(data, scopeOf('Manager', 'm1')));
    expect(counts).toEqual({ leave: 3, claims: 1, ot: 1, total: 5 });
  });
});

// ── Self-exclusion (decidable subset) ───────────────────────────────────────

describe('excludeSelf (self-approval block)', () => {
  it('removes the acting user’s own rows from the decidable subset', () => {
    const q = buildPendingQueues(data, scopeOf('Manager', 'm1'));
    // The manager SEES their own l6 in the queue…
    expect(q.leave.map((l) => l.id)).toContain('l6');
    // …but can never decide it.
    expect(excludeSelf(q.leave, 'm1').map((l) => l.id)).toEqual(['l2', 'l1']);
  });

  it('keeps everything when the account has no linked employee', () => {
    const q = buildPendingQueues(data, scopeOf('Admin', null));
    expect(excludeSelf(q.leave, null)).toHaveLength(q.leave.length);
  });
});

// ── Recently decided (7 days) ───────────────────────────────────────────────

describe('buildRecentDecisions', () => {
  it('includes decisions inside the 7-day window, newest first, across modules', () => {
    const r = buildRecentDecisions(data, scopeOf('Admin', null), NOW);
    // Cutoff is 2026-08-03T12:00 — l4/c4 are in, l5/c5 are too old.
    expect(r.leave.map((l) => l.id)).toEqual(['l4']);
    expect(r.claims.map((c) => c.id)).toEqual(['c4']);
    // OT has no decidedAt — the window runs on the OT date (≥ 2026-08-03).
    expect(r.ot.map((a) => a.id)).toEqual(['a3', 'a5']);
  });

  it('excludes pending rows and decisions older than the window', () => {
    const r = buildRecentDecisions(data, scopeOf('Admin', null), NOW);
    expect(r.leave.find((l) => l.id === 'l1')).toBeUndefined(); // pending
    expect(r.leave.find((l) => l.id === 'l5')).toBeUndefined(); // decided 11 days ago
    expect(r.claims.find((c) => c.id === 'c5')).toBeUndefined(); // decided in July
    expect(r.ot.find((a) => a.id === 'a6')).toBeUndefined(); // decided OT dated 2026-07-20
  });

  it('is scoped like the pending queues (Employee sees only their own)', () => {
    const r = buildRecentDecisions(data, scopeOf('Employee', 'e1'), NOW);
    expect(r.leave.map((l) => l.id)).toEqual(['l4']);
    expect(r.claims.map((c) => c.id)).toEqual(['c4']);
    expect(r.ot).toEqual([]); // e1's decided OT is older than the window
  });
});

// ── OT monthly cap (OTManager approval-time rule) ───────────────────────────

describe('OT 104h monthly cap', () => {
  const month = [
    ot('x1', 'e9', '2026-08-02', { requested: true, approved: true, hours: 50 }),
    ot('x2', 'e9', '2026-08-09', { requested: true, approved: true, hours: 52 }),
    ot('x3', 'e9', '2026-08-10', { requested: true, hours: 5 }), // pending — not counted
    ot('x4', 'e9', '2026-09-01', { requested: true, approved: true, hours: 10 }), // other month
    ot('x5', 'e8', '2026-08-03', { requested: true, approved: true, hours: 40 }), // other employee
  ];

  it('approvedOtHoursFor sums only approved hours of that employee in that month', () => {
    expect(approvedOtHoursFor(month, 'e9', '2026-08')).toBe(102);
  });

  it('blocks approvals that would push past 104h, allows exactly-104 and below', () => {
    const over = ot('y1', 'e9', '2026-08-11', { requested: true, hours: 3 });
    expect(approveWouldExceedOtCap(month, over)).toBe(true); // 102 + 3 > 104
    const exact = ot('y2', 'e9', '2026-08-11', { requested: true, hours: 2 });
    expect(approveWouldExceedOtCap(month, exact)).toBe(false); // 102 + 2 = 104 — allowed
    const otherEmployee = ot('y3', 'e8', '2026-08-11', { requested: true, hours: 60 });
    expect(approveWouldExceedOtCap(month, otherEmployee)).toBe(false); // 40 + 60 = 100
  });
});

// ── Row age ─────────────────────────────────────────────────────────────────

describe('ageInDays', () => {
  const now = new Date('2026-08-10T12:00:00');

  it('is 0 for same-day requests, counts whole days, clamps future dates to 0', () => {
    expect(ageInDays('2026-08-10', now)).toBe(0);
    expect(ageInDays('2026-08-07', now)).toBe(3);
    expect(ageInDays('2026-08-12', now)).toBe(0);
  });

  it('accepts datetime stamps (appliedAt/submittedAt) and floors partial days', () => {
    // Aug 5 18:00 → Aug 10 12:00 is 4 full days (the 5th is still in progress).
    expect(ageInDays('2026-08-05T18:00:00', now)).toBe(4);
  });
});
