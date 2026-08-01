/**
 * Contracts module — /contracts.
 * Registry of Contract OF Service (employees, EA 1955) and Contract FOR
 * Service (independent contractors/consultants) with expiry watch, renewal
 * workflow, consultant fee logs and printable contract letters.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Briefcase,
  FileClock,
  FilePlus2,
  FileText,
  Search,
  ScrollText,
} from 'lucide-react';
import type { Employee } from '@/lib/types';
import { useCollection } from '@/lib/db';
import { useAuth } from '@/lib/authContext';
import {
  CONTRACT_STATUS_LABELS,
  contractStats,
  contractStatus,
  useContracts,
  todayISO,
  type ContractKind,
  type ContractStatus,
  type EmploymentContract,
} from '@/lib/contracts';
import { kindBadgeClass, remunerationUnit, statusBadgeClass } from './contractBadges';
import { fmtDate, fmtRM } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import ContractEditorDialog from './ContractEditorDialog';
import ContractDetailSheet from './ContractDetailSheet';

export default function ContractsPage() {
  const { user, role } = useAuth();
  const actorName = user?.username ?? role ?? 'HR';
  const { items: employees } = useCollection<Employee>('employees');
  const { items: contracts } = useContracts();

  const [kindTab, setKindTab] = useState<'all' | ContractKind>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ContractStatus>('all');
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EmploymentContract | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const [grace, setGrace] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setGrace(false), 600);
    return () => clearTimeout(t);
  }, []);
  const loading = grace && contracts.length === 0;

  const today = useMemo(() => todayISO(), []);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const stats = useMemo(() => contractStats(contracts, today), [contracts, today]);

  const nameOf = (c: EmploymentContract) =>
    c.employeeId ? (empById.get(c.employeeId)?.name ?? 'Unknown employee') : (c.contractorName ?? '—');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contracts
      .filter((c) => (kindTab === 'all' ? true : c.kind === kindTab))
      .filter((c) => (statusFilter === 'all' ? true : contractStatus(c, today) === statusFilter))
      .filter((c) => {
        if (!q) return true;
        return (
          nameOf(c).toLowerCase().includes(q) ||
          c.title.toLowerCase().includes(q) ||
          c.refNo.toLowerCase().includes(q)
        );
      })
      .sort(
        (a, b) =>
          contractStatusRank(contractStatus(a, today)) - contractStatusRank(contractStatus(b, today)) ||
          (a.endDate ?? '9999').localeCompare(b.endDate ?? '9999') ||
          b.createdAt.localeCompare(a.createdAt),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, kindTab, statusFilter, query, today, empById]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const detail = detailId ? (contracts.find((c) => c.id === detailId) ?? null) : null;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contracts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Contracts of service (employees — EA 1955, EPF/SOCSO/EIS/PCB) and contracts for service
            (independent contractors — fees invoiced, no statutory deductions).
          </p>
        </div>
        <Button
          onClick={() => {
            setEditTarget(null);
            setEditorOpen(true);
          }}
          className="bg-amber-600 text-white hover:bg-amber-700"
        >
          <FilePlus2 className="mr-1.5 h-4 w-4" /> New contract
        </Button>
      </div>

      {/* ── Stat strip ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<ScrollText className="h-5 w-5" />}
          tone="bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400"
          value={stats.activeOfService}
          label="Active of-service"
        />
        <StatCard
          icon={<Briefcase className="h-5 w-5" />}
          tone="bg-stone-200/70 text-stone-700 dark:bg-stone-800 dark:text-stone-300"
          value={stats.activeForService}
          label="Active for-service"
        />
        <StatCard
          icon={<FileClock className="h-5 w-5" />}
          tone="bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400"
          value={stats.expiringSoon}
          label="Expiring ≤ 60 days"
        />
        <StatCard
          icon={<AlertTriangle className="h-5 w-5" />}
          tone="bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400"
          value={stats.expiredUnrenewed}
          label="Expired, unrenewed"
        />
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs value={kindTab} onValueChange={(v) => setKindTab(v as typeof kindTab)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="of-service">Of Service</TabsTrigger>
            <TabsTrigger value="for-service">For Service</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, title or ref no…"
              className="w-full pl-8 sm:w-64"
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
          >
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(Object.keys(CONTRACT_STATUS_LABELS) as ContractStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {CONTRACT_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Registry table ── */}
      {visible.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="py-12 text-center">
            <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {contracts.length === 0
                ? 'No contracts yet — register the first employment contract or consultant engagement.'
                : 'No contracts match the current filters.'}
            </p>
            {contracts.length === 0 && (
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setEditTarget(null);
                  setEditorOpen(true);
                }}
              >
                <FilePlus2 className="mr-1.5 h-4 w-4" /> New contract
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-xl">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref no.</TableHead>
                  <TableHead>Counterparty</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Engagement</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Remuneration</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((c) => {
                  const s = contractStatus(c, today);
                  return (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => setDetailId(c.id)}
                    >
                      <TableCell className="font-medium">
                        {c.refNo}
                        {c.version > 1 && (
                          <span className="ml-1 text-xs text-muted-foreground">v{c.version}</span>
                        )}
                      </TableCell>
                      <TableCell>{nameOf(c)}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={kindBadgeClass(c.kind)}>
                          {c.kind === 'of-service' ? 'Of Service' : 'For Service'}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-48 truncate">{c.title}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {fmtDate(c.startDate)} → {c.endDate ? fmtDate(c.endDate) : 'indefinite'}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {fmtRM(c.remuneration.amount)}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {remunerationUnit(c)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={statusBadgeClass(s)}>
                          {CONTRACT_STATUS_LABELS[s]}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      <ContractEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        employees={employees}
        existing={editTarget}
        actorName={actorName}
      />
      <ContractDetailSheet
        contract={detail}
        contracts={contracts}
        employees={employees}
        actorName={actorName}
        onClose={() => setDetailId(null)}
        onEdit={(c) => {
          setDetailId(null);
          setEditTarget(c);
          setEditorOpen(true);
        }}
        onOpenContract={(id) => setDetailId(id)}
      />
    </div>
  );
}

function contractStatusRank(s: ContractStatus): number {
  switch (s) {
    case 'expiring':
      return 0;
    case 'expired':
      return 1;
    case 'active':
      return 2;
    case 'draft':
      return 3;
    case 'renewed':
      return 4;
    case 'terminated':
      return 5;
  }
}

function StatCard({
  icon,
  tone,
  value,
  label,
}: {
  icon: ReactNode;
  tone: string;
  value: number;
  label: string;
}) {
  return (
    <Card className="rounded-xl">
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`rounded-lg p-2 ${tone}`}>{icon}</div>
        <div>
          <p className="text-2xl font-semibold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}
