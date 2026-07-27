/**
 * e-Claims module — /claims.
 * Compose: dashboard strip → My claims / Approver inbox tabs → payroll &
 * MyInvois notes. Submission form lives in a dialog shared by the header
 * button and the list's edit action.
 *
 * Scoping (Wave 2): once <AuthProvider> is wired, the session drives role and
 * identity — Employee sees only their own claims and personal dashboard stats
 * (no company-wide totals or leaderboard), a Manager gets department-scoped
 * stats and a department-scoped approver inbox, Admin/HR see everything.
 * decidedBy/audit always use the logged-in user, never the acting-as stub.
 * Until the provider lands, the legacy role stub + acting-as selector drive
 * the same rules so the demo keeps working.
 */
import { useEffect, useMemo, useState } from 'react';
import { Info, Plus, Receipt, ScanLine, UserRound } from 'lucide-react';
import type { Employee } from '@/lib/types';
import { useCollection } from '@/lib/db';
import { useRole } from '@/lib/roleContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ApproverInbox from './ApproverInbox';
import ClaimFormDialog from './ClaimFormDialog';
import ClaimsDashboard from './ClaimsDashboard';
import MyClaimsList from './MyClaimsList';
import { useAuthSafe } from './useAuthSafe';
import {
  resolvePolicy, type ClaimPolicyDoc, type ClaimRecord,
} from './claimPolicy';

const ACTING_AS_KEY = 'myhrms:claims:actingAs';
const DEFAULT_EMP_ID = 'emp-13'; // Deepak (Sales) — a frequent claimant in the seed data

export default function ClaimsPage() {
  const { role: stubRole } = useRole();
  const auth = useAuthSafe();
  // A logged-in session wins over the legacy stub; logged-out (or the provider
  // not being wired yet) falls back to the stub so the demo stays usable.
  const session = auth?.user ? auth : null;
  const role = session?.role ?? stubRole;

  const { items: claims } = useCollection<ClaimRecord>('claims');
  const { items: employees } = useCollection<Employee>('employees');
  const { items: settingsDocs } = useCollection<ClaimPolicyDoc>('settings');

  const [actingAsId, setActingAsId] = useState<string>(() => {
    try {
      return localStorage.getItem(ACTING_AS_KEY) || DEFAULT_EMP_ID;
    } catch {
      return DEFAULT_EMP_ID;
    }
  });
  const [tab, setTab] = useState<'my' | 'approvals'>('my');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ClaimRecord | null>(null);

  // Brief grace window while the async seed resolves on first launch.
  const [grace, setGrace] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setGrace(false), 600);
    return () => clearTimeout(t);
  }, []);
  const loading = grace && employees.length === 0;

  // Role downgraded to Employee while viewing the approvals tab → bounce back.
  const canApprove = role !== 'Employee';
  useEffect(() => {
    if (!canApprove) setTab('my');
  }, [canApprove]);

  useEffect(() => {
    try {
      localStorage.setItem(ACTING_AS_KEY, actingAsId);
    } catch {
      /* ignore */
    }
  }, [actingAsId]);

  // Legacy demo identity — only consulted while no auth session exists.
  const actingEmployee = useMemo(
    () => employees.find((e) => e.id === actingAsId) ?? employees[0],
    [employees, actingAsId],
  );

  // Auth identity — the employee record linked to the logged-in account.
  const authEmployee = useMemo(
    () => employees.find((e) => e.id === session?.employeeId),
    [employees, session?.employeeId],
  );

  /** Whose claims "My claims" shows. Null = account not linked to an employee. */
  const viewEmployee: Employee | null = session ? authEmployee ?? null : actingEmployee ?? null;

  /**
   * Approver identity for decidedBy + audit. With a session this is the
   * logged-in user (linked employee id, or the user id for standalone
   * Admin/HR accounts) — never the impersonated acting-as employee.
   */
  const actor = useMemo<{ id: string; name: string }>(() => {
    if (session?.user) {
      return {
        id: session.employeeId ?? session.user.id,
        name: authEmployee?.name ?? session.user.username,
      };
    }
    return actingEmployee
      ? { id: actingEmployee.id, name: actingEmployee.name }
      : { id: 'unknown', name: 'Unknown' };
  }, [session, authEmployee, actingEmployee]);

  const policy = useMemo(() => resolvePolicy(settingsDocs), [settingsDocs]);

  /** Claims visible to the current role (Admin/HR all, Manager dept, Employee own). */
  const scopedClaims = useMemo(() => {
    if (session) return session.scopeByEmployee(claims, (c) => c.employeeId);
    // Legacy fallback — same rules, driven by the role stub + acting-as employee.
    if (role === 'Employee') return claims.filter((c) => c.employeeId === actingEmployee?.id);
    if (role === 'Manager' && actingEmployee) {
      const deptIds = new Set(
        employees.filter((e) => e.departmentId === actingEmployee.departmentId).map((e) => e.id),
      );
      return claims.filter((c) => deptIds.has(c.employeeId));
    }
    return claims;
  }, [session, claims, role, actingEmployee, employees]);

  /** Employee directory rows visible to the current role (names/avatars only). */
  const scopedEmployees = useMemo(() => {
    if (session) return session.scopeEmployees(employees);
    if (role === 'Employee') return employees.filter((e) => e.id === actingEmployee?.id);
    if (role === 'Manager' && actingEmployee) {
      return employees.filter((e) => e.departmentId === actingEmployee.departmentId);
    }
    return employees;
  }, [session, employees, role, actingEmployee]);

  const myClaims = useMemo(
    () => claims.filter((c) => c.employeeId === viewEmployee?.id),
    [claims, viewEmployee?.id],
  );

  // Badge = claims this approver can actually decide (scoped, minus their own).
  const pendingCount = useMemo(
    () => scopedClaims.filter((c) => c.status === 'submitted' && c.employeeId !== actor.id).length,
    [scopedClaims, actor.id],
  );

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(c: ClaimRecord) {
    setEditing(c);
    setFormOpen(true);
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  if (employees.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No employees found — the employee directory has not been seeded yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Receipt className="h-6 w-6 text-amber-600" /> e-Claims
          </h1>
          <p className="text-sm text-muted-foreground">
            Submit expenses, track the approval pipeline, and watch reimbursements flow into payroll.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Acting-as is the pre-auth demo stub — hidden once a session exists. */}
          {!session && (
            <div className="flex items-center gap-1.5">
              <UserRound className="h-4 w-4 text-muted-foreground" />
              <Select value={actingEmployee?.id ?? actingAsId} onValueChange={setActingAsId}>
                <SelectTrigger className="w-[210px]" aria-label="Acting as employee">
                  <SelectValue placeholder="Acting as…" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper keeps the tooltip alive on the disabled button */}
              <span>
                <Button variant="outline" disabled>
                  <ScanLine className="h-4 w-4" /> Scan receipt
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Coming soon — OCR will pre-fill claims from receipt photos</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button onClick={openNew} disabled={!viewEmployee}>
                  <Plus className="h-4 w-4" /> New claim
                </Button>
              </span>
            </TooltipTrigger>
            {!viewEmployee && (
              <TooltipContent>This login isn&apos;t linked to an employee record</TooltipContent>
            )}
          </Tooltip>
        </div>
      </div>

      {/* ── Dashboard strip (role-scoped; no leaderboard for Employee) ── */}
      <ClaimsDashboard
        claims={scopedClaims}
        employees={scopedEmployees}
        hideLeaderboard={role === 'Employee'}
      />

      {/* ── Tabs: my claims + approver inbox ── */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'my' | 'approvals')}>
        <TabsList>
          <TabsTrigger value="my" className="gap-1.5">
            My claims
            <Badge variant="secondary" className="px-1.5">{myClaims.length}</Badge>
          </TabsTrigger>
          {canApprove && (
            <TabsTrigger value="approvals" className="gap-1.5">
              Approvals
              {pendingCount > 0 && (
                <Badge className="bg-amber-600 px-1.5 text-white hover:bg-amber-600">{pendingCount}</Badge>
              )}
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="my" className="mt-4">
          {viewEmployee ? (
            <MyClaimsList claims={myClaims} employee={viewEmployee} onNew={openNew} onEdit={openEdit} />
          ) : (
            <Card className="rounded-xl">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                This login isn&apos;t linked to an employee record, so it has no personal claims.
                The approvals queue and company dashboard remain available.
              </CardContent>
            </Card>
          )}
        </TabsContent>
        {canApprove && (
          <TabsContent value="approvals" className="mt-4">
            <ApproverInbox actor={actor} policy={policy} claims={scopedClaims} />
          </TabsContent>
        )}
      </Tabs>

      {/* ── Notes: payroll flow + MyInvois readiness ── */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Info className="h-4 w-4 text-amber-600" /> How claims reach your payslip
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm text-muted-foreground md:grid-cols-2">
          <p>
            <span className="font-medium text-foreground">Automatic payroll flow.</span> Approved
            claims are picked up by the next payroll run for the claim month and appear on the
            payslip as <span className="font-medium text-foreground">non-statutory reimbursement
            lines</span> — paid in net, excluded from EPF / SOCSO / EIS / PCB wage bases — then the
            claim is marked <Badge variant="outline" className="border-lime-600 bg-lime-600 text-white">Paid</Badge>.
          </p>
          <p>
            <span className="font-medium text-foreground">MyInvois e-invoice readiness.</span> Receipt
            labels are stored against every claim, ready to map onto LHDN MyInvois self-billed
            e-invoice fields when the company enables e-invoicing for employee expenses. Keep the
            original receipts for 7 years (Income Tax Act 1967, s.82).
          </p>
        </CardContent>
      </Card>

      {viewEmployee && (
        <ClaimFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          employee={viewEmployee}
          claims={scopedClaims}
          policy={policy}
          editing={editing}
        />
      )}
    </div>
  );
}
