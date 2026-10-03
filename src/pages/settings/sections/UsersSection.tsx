/**
 * Settings → Users & roles: full account lifecycle management for the ACTIVE
 * company (Admin). Table of login accounts with status + last login, per-row
 * actions (reset password, change role, revoke / re-enable, remove) and a
 * Create-account dialog. The /settings route is Admin-gated; a non-admin who
 * somehow lands here gets the read-only directory.
 *
 * All mutations go through the public API in src/lib/auth.ts (bcrypt-hashed,
 * audited, guarded: no self disable/remove, last active Admin protected,
 * SuperAdmin protected). The table refreshes via the auth change feed
 * (subscribeUsers / getUsersVersion).
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  Activity,
  Ban,
  CircleCheck,
  Info,
  KeyRound,
  MoreHorizontal,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useCollection } from '@/lib/db';
import {
  getUsersVersion,
  listAllUsers,
  listCompanyUsers,
  removeUserAccount,
  seedUsers,
  setUserRole,
  setUserStatus,
  statusOf,
  subscribeUsers,
  type AccountStatus,
  type AuthRole,
  type ManagedRole,
  type PublicUser,
} from '@/lib/auth';
import { useAuth } from '@/lib/useAuth';
import { useTenant } from '@/lib/useTenant';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { Department, Employee } from '@/lib/types';
import { CreateAccountDialog } from '@/components/auth/CreateAccountDialog';
import { ResetPasswordDialog } from '@/components/auth/ResetPasswordDialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SectionCard } from '../shared';

const ROLE_STYLE: Record<AuthRole, string> = {
  SuperAdmin: 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  Admin: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  HR: 'border-transparent bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  Manager: 'border-transparent bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
  Employee: 'border-transparent bg-muted text-muted-foreground',
};

const STATUS_STYLE: Record<AccountStatus, string> = {
  active: 'border-transparent bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-300',
  disabled: 'border-transparent bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
};

const ROLE_ORDER: AuthRole[] = ['SuperAdmin', 'Admin', 'HR', 'Manager', 'Employee'];
const ASSIGNABLE_ROLES: ManagedRole[] = ['Admin', 'HR', 'Manager', 'Employee'];

/** '12 Mar 2026, 09:41' for account last-login timestamps. */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export default function UsersSection() {
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { activeCompanyId, activeCompany } = useTenant();
  const { role, user } = useAuth();
  /** The /settings route is Admin-gated; this is the in-section fallback. */
  const canManage = role === 'Admin' || role === 'SuperAdmin';
  const actorName = user?.username ?? 'admin';
  const [q, setQ] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<PublicUser | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PublicUser | null>(null);
  const [removeTarget, setRemoveTarget] = useState<PublicUser | null>(null);

  // seedUsers() is idempotent and now writes only when the directory changed,
  // so running it inside this memo is loop-safe. The usersVersion subscription
  // re-reads the directory after every account mutation (create / role /
  // status / reset / remove / login stamps).
  const usersVersion = useSyncExternalStore(subscribeUsers, getUsersVersion);
  const accounts = useMemo(() => {
    void employees; // reseed trigger (demo reseed adds employees → accounts)
    void usersVersion;
    seedUsers();
    return activeCompanyId ? listCompanyUsers(activeCompanyId) : listAllUsers();
  }, [employees, activeCompanyId, usersVersion]);

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? '—';

  const stats = useMemo(() => {
    const active = accounts.filter((a) => statusOf(a) === 'active').length;
    return {
      total: accounts.length,
      active,
      revoked: accounts.length - active,
      neverLoggedIn: accounts.filter((a) => !a.lastLoginAt).length,
    };
  }, [accounts]);

  const roleCounts = useMemo(() => {
    const counts: Record<AuthRole, number> = { SuperAdmin: 0, Admin: 0, HR: 0, Manager: 0, Employee: 0 };
    for (const a of accounts) counts[a.role] += 1;
    return counts;
  }, [accounts]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return accounts; // listCompanyUsers/listAllUsers are pre-sorted
    return accounts.filter((a) => {
      const emp = a.employeeId ? empById.get(a.employeeId) : undefined;
      return (
        a.username.toLowerCase().includes(needle) ||
        (emp?.name.toLowerCase().includes(needle) ?? false) ||
        (emp?.email.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [accounts, empById, q]);

  const linkedLabel = (a: PublicUser): { name: string; sub: string } => {
    if (!a.employeeId) return { name: '—', sub: 'standalone account' };
    const emp = empById.get(a.employeeId);
    if (!emp) return { name: '—', sub: 'employee not in dataset' };
    return { name: emp.name, sub: `${deptName(emp.departmentId)} · ${emp.email}` };
  };

  const changeRole = (a: PublicUser, r: ManagedRole) => {
    const res = setUserRole(a.id, r, actorName);
    if (res.ok) toast.success(`${a.username} is now ${r}.`);
    else toast.error(res.error);
  };

  const reEnable = (a: PublicUser) => {
    const res = setUserStatus(a.id, 'active', actorName);
    if (res.ok) toast.success(`Access re-enabled for ${a.username}.`);
    else toast.error(res.error);
  };

  const confirmRevoke = () => {
    if (!revokeTarget) return;
    const res = setUserStatus(revokeTarget.id, 'disabled', actorName);
    if (res.ok) toast.success(`Access revoked for ${revokeTarget.username}. They can no longer sign in.`);
    else toast.error(res.error);
    setRevokeTarget(null);
  };

  const confirmRemove = () => {
    if (!removeTarget) return;
    const res = removeUserAccount(removeTarget.id, actorName);
    if (res.ok) toast.success(`Account ${removeTarget.username} removed — the employee record is kept.`);
    else toast.error(res.error);
    setRemoveTarget(null);
  };

  /** Per-row actions dropdown (disabled entirely for protected accounts). */
  const actionsMenu = (a: PublicUser) => {
    const status = statusOf(a);
    const isSelf = a.id === user?.id;
    const isProtected = a.role === 'SuperAdmin';
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${a.username}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem disabled={isProtected} onSelect={() => setResetTarget(a)}>
            <KeyRound className="mr-2 h-4 w-4" /> Reset password…
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={isProtected}>
              <ShieldCheck className="mr-2 h-4 w-4" /> Change role
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={a.role} onValueChange={(v) => changeRole(a, v as ManagedRole)}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <DropdownMenuRadioItem key={r} value={r}>
                    {r}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          {status === 'active' ? (
            <DropdownMenuItem
              disabled={isProtected || isSelf}
              className="text-orange-700 focus:text-orange-800 dark:text-orange-400"
              onSelect={() => setRevokeTarget(a)}
            >
              <Ban className="mr-2 h-4 w-4" /> Revoke access…
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={isProtected} onSelect={() => reEnable(a)}>
              <RotateCcw className="mr-2 h-4 w-4" /> Re-enable access
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={isProtected || isSelf}
            className="text-red-600 focus:text-red-700 dark:text-red-400"
            onSelect={() => setRemoveTarget(a)}
          >
            <Trash2 className="mr-2 h-4 w-4" /> Remove account…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const statusBadge = (a: PublicUser) => {
    const status = statusOf(a);
    return (
      <Badge variant="outline" className={STATUS_STYLE[status]}>
        {status === 'active' ? 'Active' : 'Revoked'}
      </Badge>
    );
  };

  const statTiles = [
    { label: 'Total accounts', value: stats.total, icon: Users, cls: 'text-stone-600' },
    { label: 'Active', value: stats.active, icon: CircleCheck, cls: 'text-lime-700' },
    { label: 'Revoked', value: stats.revoked, icon: Ban, cls: 'text-orange-700' },
    { label: 'Never logged in', value: stats.neverLoggedIn, icon: Activity, cls: 'text-stone-500' },
  ];

  return (
    <div className="space-y-6">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Account management — demo-grade auth</AlertTitle>
        <AlertDescription>
          These are the real sign-in accounts from the mock auth (<code className="rounded bg-muted px-1 py-0.5">src/lib/auth.ts</code>),
          scoped to the ACTIVE company. Creating, disabling or removing an account changes only sign-in access —
          employee records are never touched. Passwords are stored as bcrypt hashes and shown exactly once at
          creation/reset — share them securely. Seeded demo passwords: <span className="font-medium">admin/admin123</span>,{' '}
          <span className="font-medium">hr/hr123</span>, <span className="font-medium">manager123</span> for managers,{' '}
          <span className="font-medium">password123</span> for employee accounts,{' '}
          <span className="font-medium">superadmin/super123</span> (system view only). The production deployment
          authenticates against the backend API (<code className="rounded bg-muted px-1 py-0.5">server/</code>).
        </AlertDescription>
      </Alert>

      {/* Stats strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {statTiles.map((s) => (
          <div key={s.label} className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <s.icon className={cn('h-3.5 w-3.5', s.cls)} />
              {s.label}
            </div>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</p>
          </div>
        ))}
      </div>

      <SectionCard
        icon={ShieldCheck}
        title="Users & roles"
        description={`${stats.total} login accounts across ${Object.values(roleCounts).filter((n) => n > 0).length} access roles.`}
        action={
          canManage && activeCompanyId ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <UserPlus className="mr-1.5 h-4 w-4" /> Create account
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {ROLE_ORDER.map((r) => (
            <Badge key={r} variant="outline" className={ROLE_STYLE[r]}>
              {r} · {roleCounts[r]}
            </Badge>
          ))}
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search username or employee…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {accounts.length === 0
              ? 'No accounts yet — they are created automatically once the demo employees are seeded.'
              : `No accounts match “${q}”.`}
          </p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Username</TableHead>
                    <TableHead>Access role</TableHead>
                    <TableHead>Linked employee</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last login</TableHead>
                    {canManage && <TableHead className="w-12 text-right"> </TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((a) => {
                    const linked = linkedLabel(a);
                    return (
                      <TableRow key={a.id} className={statusOf(a) === 'disabled' ? 'opacity-60' : undefined}>
                        <TableCell>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-medium">{a.username}</code>
                          {a.id === user?.id && (
                            <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={ROLE_STYLE[a.role]}>
                            {a.role}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <p className="text-sm">{linked.name}</p>
                          <p className="text-xs text-muted-foreground">{linked.sub}</p>
                        </TableCell>
                        <TableCell>{statusBadge(a)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {a.lastLoginAt ? fmtDateTime(a.lastLoginAt) : 'Never'}
                        </TableCell>
                        {canManage && <TableCell className="text-right">{actionsMenu(a)}</TableCell>}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {filtered.map((a) => {
                const linked = linkedLabel(a);
                return (
                  <div key={a.id} className="flex items-center gap-3 rounded-lg border p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-medium">{a.username}</code>
                        {statusBadge(a)}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {linked.name}
                        {linked.name !== '—' ? ` · ${linked.sub}` : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Last login: {a.lastLoginAt ? fmtDateTime(a.lastLoginAt) : 'never'}
                      </p>
                    </div>
                    <Badge variant="outline" className={cn('shrink-0', ROLE_STYLE[a.role])}>
                      {a.role}
                    </Badge>
                    {canManage && actionsMenu(a)}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </SectionCard>

      {/* Create account */}
      {activeCompanyId && (
        <CreateAccountDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          companyId={activeCompanyId}
          companyCode={activeCompany?.code}
          employees={employees}
          existingAccounts={accounts}
          actorName={actorName}
        />
      )}

      {/* Reset password */}
      <ResetPasswordDialog
        account={resetTarget}
        open={resetTarget !== null}
        onOpenChange={(o) => {
          if (!o) setResetTarget(null);
        }}
        actorName={actorName}
      />

      {/* Revoke access confirm */}
      <AlertDialog open={revokeTarget !== null} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke access for {revokeTarget?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              They will no longer be able to sign in. The account, password and employee record are kept — you can
              re-enable access at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-orange-600 text-white hover:bg-orange-700" onClick={confirmRevoke}>
              Revoke access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove account confirm */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove account {removeTarget?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              The employee record is kept; only login access is removed. This cannot be undone — you would need to
              create a new account to restore access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={confirmRemove}>
              Remove account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
