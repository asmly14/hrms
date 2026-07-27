/**
 * Settings → Audit log viewer: newest-first, searchable table over the
 * 'audit' collection (time, actor, action, entity, detail).
 */
import { useMemo, useState } from 'react';
import { ScrollText, Search } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { fmtDate } from '@/lib/utils';
import type { AuditLog } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SectionCard } from '../shared';

const MAX_ROWS = 200;

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fmtDate(iso)}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export default function AuditSection() {
  const { items: logs } = useCollection<AuditLog>('audit');
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const sorted = [...logs].sort((a, b) => b.at.localeCompare(a.at));
    const needle = q.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((l) =>
      [l.actorName, l.action, l.entity, l.detail ?? ''].join(' ').toLowerCase().includes(needle),
    );
  }, [logs, q]);

  const shown = filtered.slice(0, MAX_ROWS);

  return (
    <SectionCard
      icon={ScrollText}
      title="Audit log"
      description="Every mutation made through the app (payroll runs, record edits, settings changes) is recorded here."
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search actor, action, entity…"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'}
          {filtered.length > MAX_ROWS ? ` · showing latest ${MAX_ROWS}` : ''}
        </p>
      </div>

      {shown.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollText className="h-5 w-5" />
            </EmptyMedia>
            <EmptyTitle>{logs.length === 0 ? 'No audit entries yet' : 'No matches'}</EmptyTitle>
            <EmptyDescription>
              {logs.length === 0
                ? 'Actions such as payroll runs, settings changes and record edits will appear here, newest first.'
                : `Nothing matches “${q}”. Try a different search.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[170px]">Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(l.at)}</TableCell>
                    <TableCell className="font-medium">{l.actorName}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-[11px]">
                        {l.action}
                      </Badge>
                    </TableCell>
                    <TableCell>{l.entity}</TableCell>
                    <TableCell className="max-w-[280px] truncate text-muted-foreground">{l.detail ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {shown.map((l) => (
              <div key={l.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="secondary" className="font-mono text-[11px]">
                    {l.action}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{fmtDateTime(l.at)}</span>
                </div>
                <p className="mt-1.5 text-sm font-medium">
                  {l.actorName} <span className="font-normal text-muted-foreground">on {l.entity}</span>
                </p>
                {l.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{l.detail}</p> : null}
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}
