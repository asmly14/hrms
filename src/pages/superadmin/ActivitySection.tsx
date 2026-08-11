/**
 * SuperAdmin → Cross-tenant audit & activity: merges every tenant's audit
 * trail (getCollection('audit', tenantId) per company) with the GLOBAL system
 * audit stream (myhrms:system:audit — tenant-deletion tombstones and
 * SuperAdmin impersonation enter/exit events), sorts newest-first, and shows
 * the latest 50 entries with a company (or SYSTEM) badge per row. A
 * per-tenant filter is provided for drilling into one company, plus a
 * "System events" filter for the global stream only.
 */
import { useMemo, useState } from 'react';
import { Activity, Building2, ShieldCheck } from 'lucide-react';
import { useTenant } from '@/lib/useTenant';
import { getSystemAudit, type SystemAuditEntry } from '@/lib/db';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { auditOf, fmtDateTime, type TenantAuditRow } from './lib';
import { AccentDot, EmptyState, SectionCard } from './shared';

const LIMIT = 50;
/** Filter value selecting the global system audit stream. */
const SYSTEM_FILTER = '__system__';

/** Unified row: either a tenant audit entry or a global system event. */
type ActivityRow =
  | { kind: 'tenant'; id: string; at: string; actorName: string; action: string; entity: string; detail?: string; row: TenantAuditRow }
  | { kind: 'system'; id: string; at: string; actorName: string; action: string; entity: string; detail?: string; row: SystemAuditEntry };

export default function ActivitySection() {
  const { companies } = useTenant();
  const [companyFilter, setCompanyFilter] = useState<'all' | string>('all');

  const rows = useMemo<ActivityRow[]>(() => {
    const tenantRows: ActivityRow[] =
      companyFilter === SYSTEM_FILTER
        ? []
        : (companyFilter === 'all' ? companies : companies.filter((c) => c.id === companyFilter))
            .flatMap((c) => auditOf(c))
            .map((r) => ({
              kind: 'tenant' as const,
              id: r.id,
              at: r.at,
              actorName: r.actorName,
              action: r.action,
              entity: r.entity,
              detail: r.detail,
              row: r,
            }));
    // Global system events (tombstones + impersonation) — shown under 'all'
    // and under the dedicated system filter.
    const systemRows: ActivityRow[] =
      companyFilter === 'all' || companyFilter === SYSTEM_FILTER
        ? getSystemAudit().map((r) => ({
            kind: 'system' as const,
            id: r.id,
            at: r.at,
            actorName: r.actorName,
            action: r.action,
            entity: 'system',
            detail: r.detail ?? (r.companyName ? `${r.companyName}` : undefined),
            row: r,
          }))
        : [];
    return [...tenantRows, ...systemRows]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, LIMIT);
  }, [companies, companyFilter]);

  return (
    <SectionCard
      icon={Activity}
      title="Cross-tenant activity"
      description={`Latest ${LIMIT} audit entries across ${companies.length} tenant${
        companies.length === 1 ? '' : 's'
      } plus system events (impersonation, tenant deletion), newest first.`}
      action={
        <Select value={companyFilter} onValueChange={setCompanyFilter}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue placeholder="All companies" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All companies + system</SelectItem>
            <SelectItem value={SYSTEM_FILTER}>System events</SelectItem>
            {companies.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No audit entries yet"
          note="Activity appears here as tenants create employees, run payroll and change settings. SuperAdmin actions (create/edit/suspend) are logged to the affected tenant; impersonation and tenant deletions appear as SYSTEM events."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="hidden md:table-cell">Entity</TableHead>
                <TableHead className="hidden lg:table-cell">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.kind}-${r.id}`}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {fmtDateTime(r.at)}
                  </TableCell>
                  <TableCell>
                    {r.kind === 'tenant' ? (
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-stone-100 px-2 py-0.5 text-xs font-medium dark:bg-stone-800">
                        <AccentDot color={r.row.company.branding.accentColor} />
                        {r.row.company.code}
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        title={r.row.companyName ? `Regarding ${r.row.companyName}` : 'Global system event'}
                      >
                        <ShieldCheck className="h-3 w-3" />
                        SYSTEM
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[14ch] truncate">{r.actorName}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.action}</code>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{r.entity}</TableCell>
                  <TableCell className="hidden max-w-[32ch] truncate lg:table-cell">
                    {r.detail ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {rows.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Building2 className="h-3.5 w-3.5" />
          Showing the {rows.length} most recent entries
          {companyFilter === 'all'
            ? ' across all tenants and the system stream'
            : companyFilter === SYSTEM_FILTER
              ? ' in the global system stream'
              : ' for the selected tenant'}
          .
        </p>
      )}
    </SectionCard>
  );
}
