/**
 * SuperAdmin → Cross-tenant audit & activity: merges every tenant's audit
 * trail (getCollection('audit', tenantId) per company), sorts newest-first,
 * and shows the latest 50 entries with a company badge per row. A per-tenant
 * filter is provided for drilling into one company.
 */
import { useMemo, useState } from 'react';
import { Activity, Building2 } from 'lucide-react';
import { useTenant } from '@/lib/tenantContext';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { auditOf, fmtDateTime } from './lib';
import { AccentDot, EmptyState, SectionCard } from './shared';

const LIMIT = 50;

export default function ActivitySection() {
  const { companies } = useTenant();
  const [companyFilter, setCompanyFilter] = useState<'all' | string>('all');

  const rows = useMemo(() => {
    const targets =
      companyFilter === 'all' ? companies : companies.filter((c) => c.id === companyFilter);
    const merged = targets.flatMap((c) => auditOf(c));
    merged.sort((a, b) => b.at.localeCompare(a.at));
    return merged.slice(0, LIMIT);
  }, [companies, companyFilter]);

  return (
    <SectionCard
      icon={Activity}
      title="Cross-tenant activity"
      description={`Latest ${LIMIT} audit entries across ${companies.length} tenant${
        companies.length === 1 ? '' : 's'
      }, newest first.`}
      action={
        <Select value={companyFilter} onValueChange={setCompanyFilter}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue placeholder="All companies" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All companies</SelectItem>
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
          note="Activity appears here as tenants create employees, run payroll and change settings. SuperAdmin actions (create/edit/suspend) are logged to the affected tenant too."
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
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {fmtDateTime(r.at)}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-stone-100 px-2 py-0.5 text-xs font-medium dark:bg-stone-800">
                      <AccentDot color={r.company.branding.accentColor} />
                      {r.company.code}
                    </span>
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
          {companyFilter === 'all' ? ' across all tenants' : ' for the selected tenant'}.
        </p>
      )}
    </SectionCard>
  );
}
