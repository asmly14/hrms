/**
 * Write authorization for the generic /api/:collection CRUD routes
 * (assertWriteAllowed + selfPolicy rules). Pure: the only DB access is the
 * manager-department lookup, served by an in-memory fake.
 *
 * Fixture tenant co-a:
 *   emp-mgr  (Manager, dept-eng)   emp-dev (Employee, dept-eng)
 *   emp-fin  (Employee, dept-fin — outside the manager's department)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECTIONS,
  HttpError,
  assertCollectionWritable,
  assertWriteAllowed,
  type JwtUser,
} from '../src/db/collections';
import type { Queryable } from '../src/db/pool';

const CO = 'co-a';
const DEPTS: Record<string, string> = { 'emp-mgr': 'dept-eng', 'emp-dev': 'dept-eng', 'emp-fin': 'dept-fin' };

const db = {
  async query(text: string, params: unknown[]) {
    if (text.startsWith('SELECT department_id FROM employees')) {
      const dept = DEPTS[params[1] as string];
      return { rows: dept ? [{ department_id: dept }] : [] };
    }
    if (text.startsWith('SELECT EXISTS')) {
      return { rows: [{ ok: DEPTS[params[1] as string] === params[2] }] };
    }
    throw new Error(`unexpected query: ${text}`);
  },
} as unknown as Queryable;

const user = (role: JwtUser['role'], employeeId?: string): JwtUser => ({
  userId: `u-${role}-${employeeId ?? 'x'}`,
  username: role.toLowerCase(),
  role,
  companyId: role === 'SuperAdmin' ? null : CO,
  employeeId,
});
const employee = user('Employee', 'emp-dev');
const manager = user('Manager', 'emp-mgr');
const admin = user('Admin');

type Doc = Record<string, unknown>;
const write = (u: JwtUser, collection: string, doc: Doc, existing?: Doc) =>
  assertWriteAllowed(u, COLLECTIONS[collection]!, CO, doc, existing, db);

async function denied(p: Promise<void>, pattern?: RegExp): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.statusCode, 403);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

const leave = (over: Doc = {}): Doc => ({
  id: 'lv-1', employeeId: 'emp-dev', type: 'annual', startDate: '2026-11-02', endDate: '2026-11-03',
  days: 2, status: 'pending', appliedAt: '2026-10-22', ...over,
});
const claim = (over: Doc = {}): Doc => ({
  id: 'cl-1', employeeId: 'emp-dev', category: 'travel', title: 'Taxi', amount: 42, claimDate: '2026-10-20',
  status: 'submitted', ...over,
});
const attendance = (over: Doc = {}): Doc => ({
  id: 'at-1', employeeId: 'emp-dev', date: '2026-10-21', clockIn: '09:00', status: 'present',
  otHours: 0, otDayType: 'normal', otApproved: false, ...over,
});
const review = (over: Doc = {}): Doc => ({
  id: 'rv-1', employeeId: 'emp-dev', reviewerId: 'emp-mgr', period: '2026-H2', scores: [],
  overallScore: 0, status: 'draft', createdAt: '2026-10-01', ...over,
});

describe('employee self-approval', () => {
  it('may apply for leave as pending, edit it, and withdraw it', async () => {
    await write(employee, 'leaves', leave());
    await write(employee, 'leaves', leave({ days: 1, endDate: '2026-11-02' }), leave());
    await write(employee, 'leaves', leave({ status: 'cancelled' }), leave());
  });

  it('cannot create or flip their own leave to approved', async () => {
    await denied(write(employee, 'leaves', leave({ status: 'approved' })), /pending approval/);
    await denied(write(employee, 'leaves', leave({ status: 'approved', decidedBy: 'me' }), leave()));
  });

  it('cannot stamp a decision or touch a decided request', async () => {
    await denied(write(employee, 'leaves', leave({ decidedBy: 'HR' })), /approver/);
    const approved = leave({ status: 'approved', decidedBy: 'HR', decidedAt: '2026-10-22' });
    await denied(write(employee, 'leaves', { ...approved, days: 5 }, approved), /Only pending/);
    await denied(write(employee, 'leaves', { ...approved, status: 'cancelled' }, approved), /Only pending/);
  });

  it('may save, submit and rework claims', async () => {
    await write(employee, 'claims', claim({ status: 'draft' }));
    await write(employee, 'claims', claim(), claim({ status: 'draft' }));
    const rejected = claim({ status: 'rejected', decidedBy: 'mgr', decidedAt: '2026-10-21', decisionRemarks: 'no receipt' });
    await write(employee, 'claims', { ...rejected, status: 'draft' }, rejected); // decision kept as stored
    await write(employee, 'claims', { ...rejected, status: 'submitted', decidedBy: null, decidedAt: null }, rejected);
  });

  it('cannot approve, pay or edit an approved claim', async () => {
    await denied(write(employee, 'claims', claim({ status: 'approved', amount: 9000 })), /draft or submitted/);
    await denied(write(employee, 'claims', claim({ status: 'approved' }), claim()), /draft or submitted/);
    await denied(write(employee, 'claims', claim({ paidInRunId: 'run-1' })), /approver/);
    const approved = claim({ status: 'approved', decidedBy: 'mgr' });
    await denied(write(employee, 'claims', { ...approved, amount: 9000 }, approved), /no longer be changed/);
  });

  it('may clock and request OT, but not approve or re-time approved OT', async () => {
    await write(employee, 'attendance', attendance());
    await write(employee, 'attendance', attendance({ otHours: 2, otRequested: true }), attendance());
    await denied(write(employee, 'attendance', attendance({ otHours: 4, otApproved: true })), /approved by a manager/);
    await denied(write(employee, 'attendance', attendance({ otApproved: true }), attendance({ otHours: 2 })));
    const approvedOt = attendance({ otHours: 2, otApproved: true, otRequested: true });
    await denied(write(employee, 'attendance', { ...approvedOt, otHours: 10 }, approvedOt), /no longer be changed/);
    await denied(write(employee, 'attendance', { ...approvedOt, otDayType: 'holiday' }, approvedOt));
    await write(employee, 'attendance', { ...approvedOt, clockOut: '20:00' }, approvedOt); // clocking out is fine
  });

  it('may self-assess and acknowledge their review, nothing more', async () => {
    const draft = review();
    await write(employee, 'reviews', { ...draft, selfScores: [{ kpiId: 'k1', score: 80 }], selfComments: 'ok' }, draft);
    await denied(write(employee, 'reviews', { ...draft, overallScore: 100 }, draft), /self-assessment/);
    await denied(write(employee, 'reviews', draft), /opened by your manager/);
    const submitted = review({ status: 'submitted', overallScore: 70 });
    await write(employee, 'reviews', { ...submitted, status: 'acknowledged', acknowledgedAt: '2026-10-22' }, submitted);
    await denied(write(employee, 'reviews', { ...submitted, status: 'draft' }, submitted), /acknowledged/);
    await denied(write(employee, 'reviews', { ...submitted, status: 'acknowledged', overallScore: 99 }, submitted));
    const acked = review({ status: 'acknowledged' });
    await denied(write(employee, 'reviews', { ...acked, selfComments: 'x' }, acked), /locked/);
  });

  it('cannot post a check-in as the manager, or edit the manager’s', async () => {
    const note = { id: 'ci-1', reviewId: 'rv-1', employeeId: 'emp-dev', authorName: 'Dev', note: 'hi', createdAt: 'x' };
    await write(employee, 'checkins', { ...note, authorRole: 'employee' });
    await denied(write(employee, 'checkins', { ...note, authorRole: 'manager' }), /employee notes/);
    const mgrNote = { ...note, authorRole: 'manager' };
    await denied(write(employee, 'checkins', { ...mgrNote, note: 'edited' }, mgrNote), /Only the manager/);
  });

  it('still cannot write collections that are not self-service', async () => {
    await denied(write(employee, 'payslips', { id: 'ps-1', employeeId: 'emp-dev', netPay: 99999 }), /only HR or an Admin/);
    await denied(write(employee, 'leaveBalances', { id: 'lb-1', employeeId: 'emp-dev', annualEntitled: 99 }));
  });
});

describe('record takeover', () => {
  it("cannot re-point another employee's row at yourself", async () => {
    const theirs = claim({ id: 'cl-9', employeeId: 'emp-fin', status: 'draft' });
    // PATCH merges the stored row with {employeeId: me}; POST upserts the same id.
    await denied(write(employee, 'claims', { ...theirs, employeeId: 'emp-dev' }, theirs), /moved to another employee/);
    await denied(write(employee, 'leaves', leave({ id: 'lv-9' }), leave({ id: 'lv-9', employeeId: 'emp-fin' })), /moved/);
  });

  it("cannot write another employee's row at all", async () => {
    await denied(write(employee, 'leaves', leave({ employeeId: 'emp-fin' })), /own records/);
  });

  it('a manager cannot pull a row from outside the department into it', async () => {
    const outside = leave({ id: 'lv-8', employeeId: 'emp-fin' });
    await denied(write(manager, 'leaves', { ...outside, employeeId: 'emp-dev' }, outside), /moved/);
    await denied(write(manager, 'leaves', { ...outside, status: 'approved' }, outside), /outside your department/);
  });
});

describe('manager writes', () => {
  it('may approve department leave, claims and OT, and deduct the balance', async () => {
    await write(manager, 'leaves', leave({ status: 'approved', decidedBy: 'mgr' }), leave());
    await write(manager, 'claims', claim({ status: 'approved' }), claim());
    await write(manager, 'attendance', attendance({ otHours: 2, otApproved: true }), attendance({ otHours: 2 }));
    await write(manager, 'leaveBalances', { id: 'lb-1', employeeId: 'emp-dev', annualUsed: 2 });
    await write(manager, 'reviews', review({ scores: [{ kpiId: 'k1', score: 70 }], status: 'submitted' }), review());
  });

  it('cannot write payslips, even in their department', async () => {
    await denied(write(manager, 'payslips', { id: 'ps-1', employeeId: 'emp-dev', netPay: 1 }), /Managers cannot write/);
  });

  it('follows the self-service rules on their own records', async () => {
    const own = leave({ id: 'lv-m', employeeId: 'emp-mgr' });
    await write(manager, 'leaves', own); // apply as pending
    await denied(write(manager, 'leaves', { ...own, status: 'approved' }, own), /pending/);
    const ownClaim = claim({ id: 'cl-m', employeeId: 'emp-mgr' });
    await denied(write(manager, 'claims', { ...ownClaim, status: 'approved' }, ownClaim));
    await denied(write(manager, 'payslips', { id: 'ps-m', employeeId: 'emp-mgr', netPay: 99999 }), /only HR or an Admin/);
    await denied(write(manager, 'leaveBalances', { id: 'lb-m', employeeId: 'emp-mgr', annualEntitled: 99 }));
    const ownReview = review({ id: 'rv-m', employeeId: 'emp-mgr', reviewerId: 'emp-boss' });
    await denied(write(manager, 'reviews', { ...ownReview, overallScore: 100 }, ownReview), /self-assessment/);
  });

  it('cannot write outside their department or company-level rows', async () => {
    await denied(write(manager, 'claims', claim({ employeeId: 'emp-fin', status: 'approved' })), /outside your department/);
    await denied(write(manager, 'settings', { id: 'payroll' }), /Managers cannot write/);
  });
});

describe('national holidays', () => {
  const holiday = { id: 'hol-x', date: '2026-12-31', name: 'Fake day off' };

  it('tenant Admin/HR cannot write the shared calendar', async () => {
    await denied(write(admin, 'holidays', holiday), /SuperAdmin/);
    assert.throws(() => assertCollectionWritable(user('HR'), COLLECTIONS.holidays!), HttpError);
  });

  it('SuperAdmin can', async () => {
    await assertWriteAllowed(user('SuperAdmin'), COLLECTIONS.holidays!, '', holiday, undefined, db);
    assertCollectionWritable(user('SuperAdmin'), COLLECTIONS.holidays!);
  });
});

describe('privileged roles keep full tenant access', () => {
  it('Admin/HR can write any tenant collection, including decisions and payslips', async () => {
    await write(admin, 'leaves', leave({ status: 'approved' }), leave());
    await write(user('HR'), 'payslips', { id: 'ps-1', employeeId: 'emp-dev', netPay: 4000 });
    await write(admin, 'claims', claim({ employeeId: 'emp-fin' }), claim());
  });
});
