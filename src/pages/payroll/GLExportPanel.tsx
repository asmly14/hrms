/**
 * GL export panel — accounting journal for a FINALIZED payroll run.
 *
 *  - Account mapping editor (per company, persisted via lib/glExport.ts's
 *    'ext:glMapping' settings doc) — MY SME chart-of-accounts defaults.
 *  - Journal preview with a live balanced check (debits must equal credits;
 *    lib/glExport throws before an unbalanced journal could ever export).
 *  - Three download formats: Xero CSV / QuickBooks Online CSV / Generic CSV,
 *    each in summary (per account) or detailed (per employee) granularity.
 *
 * Rendered inside StatutoryOutputs, which RunDetail gates to finalized runs —
 * draft-run figures can never reach an accounting export.
 */
import { useMemo, useState } from 'react';
import { BookOpenCheck, CheckCircle2, Download, RotateCcw, Save, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import type { PayrollRun, Payslip } from '@/lib/types';
import { fmtRM } from '@/lib/utils';
import { downloadCsv } from '@/lib/csv';
import {
  DEFAULT_GL_MAPPING,
  GL_LINE_LABELS,
  GL_LINE_SIDE,
  GL_LINE_TYPES,
  buildGLJournal,
  getGLMapping,
  glToGenericCsv,
  glToQboCsv,
  glToXeroCsv,
  saveGLMapping,
  type GLJournalMode,
  type GLMapping,
} from '@/lib/glExport';
import { monthLabel } from './helpers';
import { FormHeader, Money } from './components';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface Props {
  run: PayrollRun;
  slips: Payslip[];
}

const cloneMapping = (m: GLMapping): GLMapping =>
  Object.fromEntries(GL_LINE_TYPES.map((t) => [t, { ...m[t] }])) as GLMapping;

export default function GLExportPanel({ run, slips }: Props) {
  const [draft, setDraft] = useState<GLMapping>(() => cloneMapping(getGLMapping()));
  const [mode, setMode] = useState<GLJournalMode>('summary');
  const [showMapping, setShowMapping] = useState(false);

  // `slips` is reactive (RunDetail re-reads the collection), so the journal
  // recomputes whenever the run's payslips change; the mapping draft drives
  // the account columns so edits preview before saving.
  const journal = useMemo(() => {
    try {
      return buildGLJournal(run.id, { mode, mapping: draft });
    } catch (err) {
      return err instanceof Error ? err : new Error('Could not build the GL journal');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, mode, draft, slips]);

  const saveMapping = () => {
    const clean = saveGLMapping(draft);
    setDraft(cloneMapping(clean));
    toast.success('GL account mapping saved', {
      description: 'Stored per company — every future export of this tenant uses it.',
    });
  };

  const resetMapping = () => {
    setDraft(cloneMapping(DEFAULT_GL_MAPPING));
    toast.info('Mapping reset to MY SME defaults', {
      description: 'Save to persist the defaults for this company.',
    });
  };

  const dl = (format: 'xero' | 'qbo' | 'generic') => {
    if (journal instanceof Error) return;
    const csv =
      format === 'xero' ? glToXeroCsv(journal) : format === 'qbo' ? glToQboCsv(journal) : glToGenericCsv(journal);
    const filename = `gl-${format}-${run.monthKey}-${mode}.csv`;
    downloadCsv(filename, csv);
    toast.success('Download started', { description: filename });
  };

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <FormHeader
          title="Accounting GL export — double-entry payroll journal"
          subtitle={`Journal ${journal instanceof Error ? '' : journal.ref} · posting date ${journal instanceof Error ? '' : journal.date} · wages, employer statutory and payables mapped to your chart of accounts.`}
          action={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => dl('xero')} disabled={journal instanceof Error}>
                <Download className="h-4 w-4" /> Xero CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => dl('qbo')} disabled={journal instanceof Error}>
                <Download className="h-4 w-4" /> QuickBooks CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => dl('generic')} disabled={journal instanceof Error}>
                <Download className="h-4 w-4" /> Generic CSV
              </Button>
            </div>
          }
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {journal instanceof Error ? (
          <Alert className="border-red-300 bg-red-50 dark:border-red-900/40 dark:bg-red-950/30">
            <AlertTitle className="text-red-800 dark:text-red-500">Journal unavailable</AlertTitle>
            <AlertDescription className="text-xs text-muted-foreground">{journal.message}</AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Balanced — {fmtRM(journal.debitTotal)} = {fmtRM(journal.creditTotal)}
                </Badge>
                <Badge variant="outline">{journal.lines.length} journal lines</Badge>
                <Badge variant="outline">{monthLabel(run.monthKey)}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex overflow-hidden rounded-md border">
                  {(['summary', 'detailed'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                        mode === m ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-400' : 'bg-background text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {m === 'summary' ? 'Per account' : 'Per employee'}
                    </button>
                  ))}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setShowMapping((s) => !s)}>
                  <Settings2 className="h-4 w-4" />
                  {showMapping ? 'Hide mapping' : 'Account mapping'}
                </Button>
              </div>
            </div>

            {showMapping && (
              <div className="space-y-3 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    Chart-of-accounts mapping <span className="text-xs font-normal text-muted-foreground">(saved per company)</span>
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={resetMapping}>
                      <RotateCcw className="h-4 w-4" /> Defaults
                    </Button>
                    <Button size="sm" onClick={saveMapping}>
                      <Save className="h-4 w-4" /> Save mapping
                    </Button>
                  </div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Journal line</TableHead>
                      <TableHead className="w-28">Side</TableHead>
                      <TableHead className="w-32">Account code</TableHead>
                      <TableHead>Account name</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {GL_LINE_TYPES.map((t) => (
                      <TableRow key={t}>
                        <TableCell className="text-sm">{GL_LINE_LABELS[t]}</TableCell>
                        <TableCell>
                          <Badge variant={GL_LINE_SIDE[t] === 'debit' ? 'secondary' : 'outline'} className="text-xs">
                            {GL_LINE_SIDE[t]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8 w-28"
                            value={draft[t].code}
                            onChange={(e) => setDraft((d) => ({ ...d, [t]: { ...d[t], code: e.target.value } }))}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8"
                            value={draft[t].name}
                            onChange={(e) => setDraft((d) => ({ ...d, [t]: { ...d[t], name: e.target.value } }))}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Code</TableHead>
                  <TableHead>Account</TableHead>
                  {mode === 'detailed' && <TableHead>Employee</TableHead>}
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead>Memo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {journal.lines.map((l, i) => (
                  <TableRow key={`${l.type}-${l.employeeId ?? 'sum'}-${i}`}>
                    <TableCell className="font-mono text-xs">{l.accountCode}</TableCell>
                    <TableCell className="text-sm">{l.accountName}</TableCell>
                    {mode === 'detailed' && (
                      <TableCell className="text-sm text-muted-foreground">{l.employeeName}</TableCell>
                    )}
                    <TableCell className="text-right">
                      {l.debit > 0 && <Money>{fmtRM(l.debit)}</Money>}
                    </TableCell>
                    <TableCell className="text-right">
                      {l.credit > 0 && <Money>{fmtRM(l.credit)}</Money>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.memo}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={mode === 'detailed' ? 3 : 2}>
                    <span className="inline-flex items-center gap-1.5">
                      <BookOpenCheck className="h-3.5 w-3.5" /> Totals
                    </span>
                  </TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(journal.debitTotal)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(journal.creditTotal)}</Money></TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
            <p className="text-xs text-muted-foreground">
              Debits: wages expense (basic / allowances / OT / other earnings), claims reimbursement and
              employer EPF · SOCSO · EIS · HRD. Credits: net salaries payable, EPF / SOCSO / EIS / PCB /
              HRD payables, and CP38 / Zakat / PTPTN / other deduction payables as separate lines.
              CSV layouts are documented in <code className="rounded bg-muted px-1 py-0.5">src/lib/glExport.ts</code>.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
