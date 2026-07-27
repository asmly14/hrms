/**
 * Settings → Users & roles: read-only directory of the real login accounts
 * from the mock auth system (src/lib/auth.ts) — username, role and the
 * linked employee record. Passwords are demo-only; noted in the info alert.
 */
import { useEffect, useMemo, useState } from 'react';
import { Info, Search, ShieldCheck } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { seedUsers, type AuthRole, type UserAccount } from '@/lib/auth';
import { useTenant } from '@/lib/tenantContext';
import { cn } from '@/lib/utils';
import type { Department, Employee } from '@/lib/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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

const ROLE_ORDER: AuthRole[] = ['SuperAdmin', 'Admin', 'HR', 'Manager', 'Employee'];

export default function UsersSection() {
  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { activeCompanyId } = useTenant();
  const [accounts, setAccounts] = useState<UserAccount[]>([]);
  const [q, setQ] = useState('');

  // seedUsers() is idempotent + merge-based: it appends accounts for any
  // newly seeded employees and preserves existing (possibly changed) demo
  // passwords. Re-run whenever the employee directory changes (e.g. reseed).
  // Accounts are then scoped to the ACTIVE tenant (SuperAdmin accounts, which
  // have companyId null, are only visible from the system-level directory).
  useEffect(() => {
    const all = seedUsers();
    setAccounts(activeCompanyId ? all.filter((a) => a.companyId === activeCompanyId) : all);
  }, [employees, activeCompanyId]);

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? '—';

  const roleCounts = useMemo(() => {
    const counts: Record<AuthRole, number> = { SuperAdmin: 0, Admin: 0, HR: 0, Manager: 0, Employee: 0 };
    for (const a of accounts) counts[a.role] += 1;
    return counts;
  }, [accounts]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const sorted = [...accounts].sort((a, b) => a.username.localeCompare(b.username));
    if (!needle) return sorted;
    return sorted.filter((a) => {
      const emp = a.employeeId ? empById.get(a.employeeId) : undefined;
      return (
        a.username.toLowerCase().includes(needle) ||
        (emp?.name.toLowerCase().includes(needle) ?? false) ||
        (emp?.email.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [accounts, empById, q]);

  const linkedLabel = (a: UserAccount): { name: string; sub: string } => {
    if (!a.employeeId) return { name: '—', sub: 'standalone account' };
    const emp = empById.get(a.employeeId);
    if (!emp) return { name: '—', sub: 'employee not in dataset' };
    return { name: emp.name, sub: `${deptName(emp.departmentId)} · ${emp.email}` };
  };

  return (
    <div className="space-y-6">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Demo accounts — passwords are not real</AlertTitle>
        <AlertDescription>
          These are the actual sign-in accounts from the mock auth (<code className="rounded bg-muted px-1 py-0.5">src/lib/auth.ts</code>),
          scoped to the ACTIVE company — the directory now includes per-company Admin / HR / Manager / Employee
          accounts (e.g. <span className="font-medium">admin</span> for ASM Tech,{' '}
          <span className="font-medium">admin2</span> for Merdeka) plus the cross-company{' '}
          <span className="font-medium">superadmin</span> account, which is only listed in the system view.
          Passwords are demo-only (<span className="font-medium">admin/admin123</span>,{' '}
          <span className="font-medium">hr/hr123</span>, <span className="font-medium">manager123</span> for managers,{' '}
          <span className="font-medium">password123</span> for employee accounts,{' '}
          <span className="font-medium">superadmin/super123</span>) and stored in plaintext in
          localStorage — never use real credentials. This directory is read-only.
        </AlertDescription>
      </Alert>

      <SectionCard
        icon={ShieldCheck}
        title="Users & roles"
        description={`${accounts.length} login accounts across ${Object.values(roleCounts).filter((n) => n > 0).length} access roles.`}
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((a) => {
                    const linked = linkedLabel(a);
                    return (
                      <TableRow key={a.id}>
                        <TableCell>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-medium">{a.username}</code>
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
                      <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-medium">{a.username}</code>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {linked.name}
                        {linked.name !== '—' ? ` · ${linked.sub}` : ''}
                      </p>
                    </div>
                    <Badge variant="outline" className={cn('shrink-0', ROLE_STYLE[a.role])}>
                      {a.role}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}
