/**
 * Live notification bell — replaces the old static demo bell (3 hardcoded
 * items, always-lit fake dot).
 *
 * Items are computed from the real collections and scoped by the effective
 * role via useAuth's scoping helpers:
 *   - Admin / HR : pending leaves + pending (submitted) claims + unapproved OT,
 *                  across the whole active company.
 *   - Manager    : the same queues, limited to their own department
 *                  (scopeByEmployee).
 *   - Employee   : their own pending leave/claim requests, recent decisions on
 *                  them (approved/rejected within the last week) and unread
 *                  payslips from finalized runs (seen-set kept in localStorage).
 *
 * The badge renders ONLY while there is at least one item. The dropdown lists
 * up to 8 entries (icon + label + relative time), each deep-linking to the
 * relevant page, plus a "View all" shortcut and an "All caught up" empty state.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, CalendarClock, CheckCircle2, Clock3, Receipt, Wallet, XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { useCollection } from '@/lib/db';
import type {
  AttendanceRecord, Claim, Employee, LeaveRequest, PayrollRun, Payslip,
} from '@/lib/types';
import { cn, fmtDate, fmtRM } from '@/lib/utils';
import { useEffectiveRole } from './useEffectiveRole';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface NotificationItem {
  id: string;
  icon: LucideIcon;
  label: string;
  detail: string;
  /** ISO date/datetime — used for sorting and the relative-time display. */
  at: string;
  href: string;
  /** Tone for the leading icon (decisions are green/red, queue items amber). */
  tone: 'queue' | 'good' | 'bad' | 'info';
}

const MAX_ITEMS = 8;
/** Employee decision notifications fade out after this long. */
const DECISION_WINDOW_MS = 7 * 86_400_000;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** '2026-08' → 'August 2026'. */
function monthLabel(monthKey: string): string {
  const d = new Date(`${monthKey}-01T00:00:00`);
  return Number.isNaN(d.getTime())
    ? monthKey
    : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Compact relative time: 'just now' / '5m ago' / '3h ago' / '2d ago' / date. */
function timeAgo(iso: string): string {
  const t = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return fmtDate(iso);
}

/** Per-employee "which payslips have I already seen" set (cheap unread tracking). */
function seenKey(employeeId: string): string {
  return `myhrms:seenPayslips:${employeeId}`;
}
function readSeen(employeeId: string): Set<string> {
  try {
    const raw = localStorage.getItem(seenKey(employeeId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export default function NotificationBell() {
  const { role } = useEffectiveRole();
  const { employeeId, scopeByEmployee } = useAuth();
  const navigate = useNavigate();
  const { items: employees } = useCollection<Employee>('employees');
  const { items: leaves } = useCollection<LeaveRequest>('leaves');
  const { items: claims } = useCollection<Claim>('claims');
  const { items: attendance } = useCollection<AttendanceRecord>('attendance');
  const { items: payslips } = useCollection<Payslip>('payslips');
  const { items: runs } = useCollection<PayrollRun>('payrollRuns');

  const isApprover = role === 'Admin' || role === 'HR' || role === 'Manager';

  const nameOf = useMemo(() => {
    const names = new Map(employees.map((e) => [e.id, e.name]));
    return (id: string) => names.get(id) ?? 'Unknown employee';
  }, [employees]);

  // Employee-role unread tracking: payslip ids the user has already opened the
  // bell for. Re-read when the session's linked employee changes — render-phase
  // adjust keyed on employeeId, no effect.
  const [seenPayslips, setSeenPayslips] = useState<Set<string>>(
    () => (employeeId ? readSeen(employeeId) : new Set()),
  );
  const [seenFor, setSeenFor] = useState(employeeId);
  if (seenFor !== employeeId) {
    setSeenFor(employeeId);
    setSeenPayslips(employeeId ? readSeen(employeeId) : new Set());
  }

  /** Approval queues (Admin/HR company-wide, Manager own-department). */
  const approverItems = useMemo<NotificationItem[]>(() => {
    if (!isApprover) return [];
    const out: NotificationItem[] = [];
    for (const l of scopeByEmployee(leaves, (x) => x.employeeId)) {
      if (l.status !== 'pending') continue;
      out.push({
        id: `leave-${l.id}`,
        icon: CalendarClock,
        label: `Leave request — ${nameOf(l.employeeId)}`,
        detail: `${capitalize(l.type)} · ${plural(l.days, 'day')} · starts ${fmtDate(l.startDate)}`,
        at: l.appliedAt,
        href: '/leave',
        tone: 'queue',
      });
    }
    for (const c of scopeByEmployee(claims, (x) => x.employeeId)) {
      if (c.status !== 'submitted') continue;
      out.push({
        id: `claim-${c.id}`,
        icon: Receipt,
        label: `Claim — ${nameOf(c.employeeId)}`,
        detail: `${c.title} · ${fmtRM(c.amount)}`,
        at: c.submittedAt ?? c.claimDate,
        href: '/claims',
        tone: 'queue',
      });
    }
    for (const a of scopeByEmployee(attendance, (x) => x.employeeId)) {
      if (a.otHours <= 0 || a.otApproved) continue;
      out.push({
        id: `ot-${a.id}`,
        icon: Clock3,
        label: `OT approval — ${nameOf(a.employeeId)}`,
        detail: `${a.otHours}h OT on ${fmtDate(a.date)}`,
        at: a.date,
        href: '/attendance',
        tone: 'queue',
      });
    }
    return out;
  }, [isApprover, scopeByEmployee, leaves, claims, attendance, nameOf]);

  /** Self-service view (Employee role): own pending + recent decisions + payslips. */
  // "Now" snapshot taken once at mount keeps render pure (react-hooks/purity);
  // the 7-day decision window doesn't need to tick live within a session.
  const [nowMs] = useState(() => Date.now());
  const employeeItems = useMemo<NotificationItem[]>(() => {
    if (isApprover || !employeeId) return [];
    const out: NotificationItem[] = [];
    const cutoff = nowMs - DECISION_WINDOW_MS;
    for (const l of leaves) {
      if (l.employeeId !== employeeId) continue;
      if (l.status === 'pending') {
        out.push({
          id: `leave-${l.id}`,
          icon: CalendarClock,
          label: `Your ${l.type} leave is pending`,
          detail: `${plural(l.days, 'day')} · starts ${fmtDate(l.startDate)}`,
          at: l.appliedAt,
          href: '/leave',
          tone: 'queue',
        });
      } else if (
        (l.status === 'approved' || l.status === 'rejected') &&
        l.decidedAt &&
        new Date(l.decidedAt).getTime() >= cutoff
      ) {
        out.push({
          id: `leave-decision-${l.id}`,
          icon: l.status === 'approved' ? CheckCircle2 : XCircle,
          label: `${capitalize(l.type)} leave ${l.status}`,
          detail: `${plural(l.days, 'day')} from ${fmtDate(l.startDate)}`,
          at: l.decidedAt,
          href: '/leave',
          tone: l.status === 'approved' ? 'good' : 'bad',
        });
      }
    }
    for (const c of claims) {
      if (c.employeeId !== employeeId) continue;
      if (c.status === 'submitted') {
        out.push({
          id: `claim-${c.id}`,
          icon: Receipt,
          label: `Claim “${c.title}” awaiting review`,
          detail: fmtRM(c.amount),
          at: c.submittedAt ?? c.claimDate,
          href: '/claims',
          tone: 'queue',
        });
      } else if (
        (c.status === 'approved' || c.status === 'rejected') &&
        c.decidedAt &&
        new Date(c.decidedAt).getTime() >= cutoff
      ) {
        out.push({
          id: `claim-decision-${c.id}`,
          icon: c.status === 'approved' ? CheckCircle2 : XCircle,
          label: `Claim ${c.status} — ${c.title}`,
          detail: fmtRM(c.amount),
          at: c.decidedAt,
          href: '/claims',
          tone: c.status === 'approved' ? 'good' : 'bad',
        });
      }
    }
    // Unread payslips — only from finalized runs (draft payslips aren't real yet).
    const runById = new Map(runs.map((r) => [r.id, r]));
    for (const p of payslips) {
      if (p.employeeId !== employeeId || seenPayslips.has(p.id)) continue;
      const run = runById.get(p.runId);
      if (!run || run.status !== 'finalized') continue;
      out.push({
        id: `payslip-${p.id}`,
        icon: Wallet,
        label: `Payslip for ${monthLabel(p.monthKey)} is ready`,
        detail: `Net pay ${fmtRM(p.netPay)}`,
        at: run.finalizedAt ?? run.runAt,
        href: '/my-payslips',
        tone: 'info',
      });
    }
    return out;
  }, [isApprover, employeeId, leaves, claims, payslips, runs, seenPayslips, nowMs]);

  const items = useMemo(
    () =>
      [...(isApprover ? approverItems : employeeItems)].sort((a, b) =>
        b.at.localeCompare(a.at),
      ),
    [isApprover, approverItems, employeeItems],
  );
  const count = items.length;

  // Freeze the visible list while the dropdown is open so "mark payslips seen
  // on open" clears the badge without items vanishing mid-read.
  const [open, setOpen] = useState(false);
  const [frozen, setFrozen] = useState<NotificationItem[] | null>(null);
  const displayed = open && frozen ? frozen : items;
  const viewAllHref = displayed[0]?.href ?? '/';

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setFrozen(items);
      if (!isApprover && employeeId) {
        const ownIds = payslips.filter((p) => p.employeeId === employeeId).map((p) => p.id);
        if (ownIds.length > 0) {
          const nextSeen = new Set([...readSeen(employeeId), ...ownIds]);
          try {
            localStorage.setItem(seenKey(employeeId), JSON.stringify([...nextSeen]));
          } catch {
            /* non-fatal */
          }
          setSeenPayslips(nextSeen);
        }
      }
    } else {
      setFrozen(null);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={count > 0 ? `Notifications (${count} pending)` : 'Notifications'}
        >
          <Bell className="h-4 w-4" />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
              {count > 9 ? '9+' : count}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          {count > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              {count} pending
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {displayed.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
            <CheckCircle2 className="h-6 w-6 text-emerald-500" />
            <p className="text-sm font-medium">All caught up</p>
            <p className="text-xs text-muted-foreground">
              Nothing needs your attention right now.
            </p>
          </div>
        ) : (
          <>
            {displayed.slice(0, MAX_ITEMS).map((n) => (
              <DropdownMenuItem
                key={n.id}
                className="flex items-start gap-3"
                onSelect={() => navigate(n.href)}
              >
                <n.icon
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0',
                    n.tone === 'good' && 'text-emerald-500',
                    n.tone === 'bad' && 'text-red-500',
                    (n.tone === 'queue' || n.tone === 'info') && 'text-amber-500',
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{n.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{n.detail}</span>
                </span>
                <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">
                  {timeAgo(n.at)}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="justify-center text-sm font-medium text-primary"
              onSelect={() => navigate(viewAllHref)}
            >
              View all
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
