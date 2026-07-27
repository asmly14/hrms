/**
 * Onboarding module — /onboarding.
 * New-hire checklist list (seeded from the employees collection), progress
 * tracking, pre-boarding document requirements, welcome packet stub.
 */
import { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, FileText, Gift, Plus, UserPlus, Users } from 'lucide-react';
import type { Employee } from '@/lib/types';
import { useCollection } from '@/lib/db';
import { useAuth } from '@/lib/authContext';
import { useOnboardingChecklists } from '@/lib/lifecycle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ChecklistCard from './ChecklistCard';
import NewChecklistDialog from './NewChecklistDialog';

const PREBOARDING_DOCS = [
  { label: 'NRIC / passport copy', note: 'Identity & statutory registration' },
  { label: 'Bank account details', note: 'Salary must be paid via bank (EA 1955 s.25)' },
  { label: 'EPF (KWSP) number', note: 'Or register new membership before first payroll' },
  { label: 'SOCSO number', note: 'Usually the NRIC number for Malaysians' },
  { label: 'Income tax number', note: 'LHDN registration for PCB withholding' },
  { label: 'TP3 form', note: 'Previous-employer remuneration details for accurate PCB' },
];

export default function OnboardingPage() {
  const { user, role } = useAuth();
  const actorName = user?.username ?? role ?? 'HR'; // session user for audit attribution
  const { items: employees } = useCollection<Employee>('employees');
  const { items: checklists } = useOnboardingChecklists();

  const [tab, setTab] = useState<'active' | 'completed' | 'all'>('active');
  const [dialogOpen, setDialogOpen] = useState(false);

  // Grace window while the async seed resolves on first launch.
  const [grace, setGrace] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setGrace(false), 600);
    return () => clearTimeout(t);
  }, []);
  const loading = grace && employees.length === 0;

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const existingEmployeeIds = useMemo(
    () => new Set(checklists.map((c) => c.employeeId)),
    [checklists],
  );

  const sorted = useMemo(
    () =>
      [...checklists].sort(
        (a, b) => a.startDate.localeCompare(b.startDate) || b.createdAt.localeCompare(a.createdAt),
      ),
    [checklists],
  );

  const active = sorted.filter((c) => c.status !== 'completed');
  const completed = sorted.filter((c) => c.status === 'completed');
  const visible = tab === 'all' ? sorted : tab === 'active' ? active : completed;

  const avgProgress = useMemo(() => {
    if (active.length === 0) return 0;
    const sum = active.reduce((s, c) => {
      const done = c.items.filter((i) => i.done).length;
      return s + (c.items.length === 0 ? 0 : done / c.items.length);
    }, 0);
    return Math.round((sum / active.length) * 100);
  }, [active]);

  const startingThisWeek = useMemo(() => {
    const now = new Date();
    const weekAhead = new Date(now);
    weekAhead.setDate(now.getDate() + 7);
    const lo = now.toISOString().slice(0, 10);
    const hi = weekAhead.toISOString().slice(0, 10);
    return active.filter((c) => c.startDate >= lo && c.startDate <= hi).length;
  }, [active]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Onboarding</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pre-boarding documents, first-weeks checklists and buddy tracking for new hires.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="bg-amber-600 text-white hover:bg-amber-700">
          <Plus className="mr-1.5 h-4 w-4" /> Start onboarding
        </Button>
      </div>

      {/* ── Stat strip ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-xl">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-amber-100 p-2 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{active.length}</p>
              <p className="text-xs text-muted-foreground">Active onboardings</p>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-stone-200/70 p-2 text-stone-700 dark:bg-stone-800 dark:text-stone-300">
              <ClipboardCheck className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{avgProgress}%</p>
              <p className="text-xs text-muted-foreground">Avg. checklist progress</p>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-lime-100 p-2 text-lime-700 dark:bg-lime-950/60 dark:text-lime-400">
              <UserPlus className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{startingThisWeek}</p>
              <p className="text-xs text-muted-foreground">Starting in the next 7 days</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Checklist list ── */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="active" className="gap-1.5">
            In progress
            <Badge variant="secondary" className="px-1.5">{active.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="completed" className="gap-1.5">
            Completed
            <Badge variant="secondary" className="px-1.5">{completed.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="py-12 text-center">
            <UserPlus className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {tab === 'completed'
                ? 'No completed onboardings yet.'
                : 'No onboarding checklists yet — start one for an incoming hire.'}
            </p>
            {tab !== 'completed' && (
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => setDialogOpen(true)}
              >
                <Plus className="mr-1.5 h-4 w-4" /> Start onboarding
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {visible.map((c) => (
            <ChecklistCard
              key={c.id}
              checklist={c}
              employee={empById.get(c.employeeId)}
              buddy={c.buddyId ? empById.get(c.buddyId) : undefined}
              actorName={actorName}
            />
          ))}
        </div>
      )}

      {/* ── Pre-boarding documents + welcome packet ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-amber-600" /> Pre-boarding documents
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5 text-sm">
              {PREBOARDING_DOCS.map((d) => (
                <li key={d.label} className="flex items-start justify-between gap-3">
                  <span className="font-medium">{d.label}</span>
                  <span className="text-right text-xs text-muted-foreground">{d.note}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 rounded-lg bg-stone-100 p-3 text-xs text-muted-foreground dark:bg-stone-900/60">
              These map to the <span className="font-medium text-foreground">Documents</span>{' '}
              category of every onboarding checklist — collect them before day one so statutory
              registration (EPF / SOCSO / EIS / PCB) never blocks the first payroll.
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gift className="h-4 w-4 text-amber-600" /> Welcome packet
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              A day-one packet template will live here — offer pack, employee handbook
              acknowledgement, EA 1955 particulars summary, org chart and IT setup guide.
            </p>
            <p>
              For now, the orientation items in each checklist track delivery step-by-step, and the
              buddy assignment keeps a human accountable for the first week.
            </p>
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
              Coming in Wave 2
            </Badge>
          </CardContent>
        </Card>
      </div>

      <NewChecklistDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        employees={employees}
        existingEmployeeIds={existingEmployeeIds}
        actorName={actorName}
      />
    </div>
  );
}
