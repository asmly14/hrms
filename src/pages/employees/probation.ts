/**
 * Probation mutations — extend / confirm, storage-backed like separations.ts.
 * Pure patch builders are exported for tests; the mutations persist through
 * the collection store, append to the employee's probationHistory, and write
 * an audit entry. `confirmProbationAction` is the toast-wrapped one-click
 * confirm shared by the tracker strip and the detail page.
 */
import { toast } from 'sonner';
import { getCollection, logAudit, setCollection } from '@/lib/db';
import type { Employee, ProbationHistoryEntry } from '@/lib/types';
import { probationEndDate } from './helpers';

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function persist(emp: Employee): void {
  setCollection(
    'employees',
    getCollection<Employee>('employees').map((e) => (e.id === emp.id ? emp : e)),
  );
}

/** Latest extension entry, if any — drives the "reason on hover" badge. */
export function lastExtension(emp: Employee): ProbationHistoryEntry | undefined {
  return [...(emp.probationHistory ?? [])].reverse().find((h) => h.action === 'extended');
}

/** Pure: patch that extends probation to `newEnd` and appends the trail entry. */
export function extensionPatch(
  emp: Employee,
  newEnd: string,
  by: string,
  reason?: string,
  at: string = new Date().toISOString(),
): Pick<Employee, 'probationExtendedTo' | 'probationHistory'> {
  const entry: ProbationHistoryEntry = {
    action: 'extended',
    fromEnd: probationEndDate(emp),
    toEnd: newEnd,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
    by,
    at,
  };
  return {
    probationExtendedTo: newEnd,
    probationHistory: [...(emp.probationHistory ?? []), entry],
  };
}

/** Pure: patch that confirms the employee (probation → active) with a trail entry. */
export function confirmPatch(
  emp: Employee,
  by: string,
  at: string = new Date().toISOString(),
): Pick<Employee, 'status' | 'probationHistory'> {
  const entry: ProbationHistoryEntry = {
    action: 'confirmed',
    fromEnd: probationEndDate(emp),
    toEnd: todayISO(),
    by,
    at,
  };
  return {
    status: 'active',
    probationHistory: [...(emp.probationHistory ?? []), entry],
  };
}

/**
 * Extend probation to `newEnd` (ISO date, must be after the current end).
 * Persists the record, appends history and audits. Returns null when the
 * employee is not on probation or the date is invalid.
 */
export function extendProbation(
  emp: Employee,
  newEnd: string,
  by: string,
  reason?: string,
): Employee | null {
  if (emp.status !== 'probation') return null;
  if (!newEnd || newEnd <= probationEndDate(emp)) return null;
  const next: Employee = { ...emp, ...extensionPatch(emp, newEnd, by, reason) };
  persist(next);
  logAudit({
    actorName: by,
    action: 'employee.probation_extend',
    entity: 'employees',
    entityId: emp.id,
    detail: `${emp.name} probation extended ${probationEndDate(emp)} → ${newEnd}${
      reason?.trim() ? ` — ${reason.trim()}` : ''
    }`,
  });
  return next;
}

/**
 * Confirm the employee in role — status flips to active, the trail records
 * the scheduled end vs. the actual confirmation date. Returns null when the
 * employee is not on probation.
 */
export function confirmEmployee(emp: Employee, by: string): Employee | null {
  if (emp.status !== 'probation') return null;
  const next: Employee = { ...emp, ...confirmPatch(emp, by) };
  persist(next);
  logAudit({
    actorName: by,
    action: 'employee.confirm',
    entity: 'employees',
    entityId: emp.id,
    detail: `${emp.name} confirmed in role after probation`,
  });
  return next;
}

/** One-click confirm (probation → active) with audit + toast feedback. */
export function confirmProbationAction(employee: Employee, actorName: string): void {
  if (confirmEmployee(employee, actorName)) {
    toast.success(`${employee.name} confirmed in role after probation`);
  } else {
    toast.error(`${employee.name} is not on probation`);
  }
}
