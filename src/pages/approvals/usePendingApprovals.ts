/**
 * Shared pending-approvals hook — the single counting source for BOTH the
 * /approvals inbox and the NotificationBell badge (audit-business-value.md
 * quick win: bell counts must equal inbox counts). All queue/scoping rules
 * live in ./model (pure functions); this hook only wires the live collections
 * and the session/legacy role into them.
 *
 * Role resolution mirrors the module pages: session role wins (SuperAdmin
 * maps to Admin); the legacy dev role stub is the pre-auth fallback. Scoping
 * is fail-open only while the AuthProvider is absent (demo mode) — with a
 * session the strict authContext rules apply (Manager → own department,
 * Employee → own records, both fail closed when unlinked).
 */
import { useMemo, useState } from 'react';
import { useCollection } from '@/lib/db';
import type { Employee } from '@/lib/types';
import { useAuthSafe } from '@/lib/useAuthSafe';
import { useRole, type AppRole } from '@/lib/useRole';
import type { AttendanceX } from '@/pages/attendance/model';
import type { ClaimRecord } from '@/pages/claims/claimPolicy';
import type { LeaveRequestEx } from '@/pages/leave/leaveLogic';
import {
  buildPendingQueues,
  buildRecentDecisions,
  countQueues,
  excludeSelf,
  scopeByEmployee,
  type ApprovalCounts,
  type ApprovalData,
  type ApprovalScope,
  type PendingQueues,
} from './model';

export interface PendingApprovals {
  /** Effective role (session role, else legacy dev stub). SuperAdmin → Admin. */
  role: AppRole;
  /** Admin/HR/Manager — may decide requests. */
  isApprover: boolean;
  /** Linked employee id of the acting user — drives the self-approval block. */
  employeeId: string | null;
  /** Scoped pending queues in each module's canonical order. */
  queues: PendingQueues;
  /** Queues minus the acting user's own items — what they may actually decide. */
  decidable: PendingQueues;
  /** Decided within the last 7 days (scoped), newest first. */
  recent: PendingQueues;
  /** Scoped collections WITHOUT status filtering (policy-warning pools etc.). */
  scopedData: ApprovalData;
  /** Queue lengths — the badge numbers shared by the bell and the inbox. */
  counts: ApprovalCounts;
}

export function usePendingApprovals(): PendingApprovals {
  const auth = useAuthSafe();
  const { role: legacyRole } = useRole();
  const { items: employees } = useCollection<Employee>('employees');
  const { items: leaves } = useCollection<LeaveRequestEx>('leaves');
  const { items: claims } = useCollection<ClaimRecord>('claims');
  const { items: attendance } = useCollection<AttendanceX>('attendance');

  const role: AppRole = auth?.role === 'SuperAdmin' ? 'Admin' : auth?.role ?? legacyRole;
  const employeeId = auth?.employeeId ?? null;
  const isApprover = role === 'Admin' || role === 'HR' || role === 'Manager';

  // Mount-time "now" keeps render pure (react-hooks/purity); the 7-day
  // decision window doesn't need to tick live within a session — same
  // pattern as NotificationBell.
  const [nowMs] = useState(() => Date.now());

  const scope: ApprovalScope = useMemo(
    () => ({ role, employeeId, employees, permissive: auth === null }),
    [role, employeeId, employees, auth],
  );
  const data: ApprovalData = useMemo(
    () => ({ leaves, claims, attendance }),
    [leaves, claims, attendance],
  );

  const queues = useMemo(() => buildPendingQueues(data, scope), [data, scope]);
  const recent = useMemo(() => buildRecentDecisions(data, scope, nowMs), [data, scope, nowMs]);
  const decidable = useMemo<PendingQueues>(
    () => ({
      leave: excludeSelf(queues.leave, employeeId),
      claims: excludeSelf(queues.claims, employeeId),
      ot: excludeSelf(queues.ot, employeeId),
    }),
    [queues, employeeId],
  );
  const scopedData = useMemo<ApprovalData>(
    () => ({
      leaves: scopeByEmployee(data.leaves, (l) => l.employeeId, scope),
      claims: scopeByEmployee(data.claims, (c) => c.employeeId, scope),
      attendance: scopeByEmployee(data.attendance, (a) => a.employeeId, scope),
    }),
    [data, scope],
  );
  const counts = useMemo(() => countQueues(queues), [queues]);

  return { role, isApprover, employeeId, queues, decidable, recent, scopedData, counts };
}
