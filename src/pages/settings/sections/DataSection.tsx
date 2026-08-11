/**
 * Settings → Data management: full JSON export of every collection, a real
 * JSON import (validate → preview → merge/replace into the ACTIVE tenant),
 * and the guarded "Reset & reseed demo data" action.
 */
import { useRef, useState } from 'react';
import { DatabaseBackup, Download, HardDrive, RefreshCw, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  COLLECTIONS, exportTenantData, getActiveCompany, getActiveTenantId, importTenantData,
  logAudit, setCollection, tenantSeedFlag, useCollection, type CollectionName,
} from '@/lib/db';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { DEMO_ACTOR, SectionCard } from '../shared';

function storageBytes(): number {
  // Collections are tenant-namespaced (myhrms:t:<companyId>:<name>) except
  // global ones (holidays); measure the ACTIVE tenant's footprint.
  const tenant = getActiveTenantId() ?? 'co-asm';
  return COLLECTIONS.reduce((sum, name) => {
    const k = name === 'holidays' ? `myhrms:${name}` : `myhrms:t:${tenant}:${name}`;
    return sum + (localStorage.getItem(k)?.length ?? 0);
  }, 0);
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** A validated import file, ready to preview & apply. */
interface ImportPreview {
  fileName: string;
  exportedAt?: string;
  company?: string;
  /** collection name → row count, in file order */
  entries: { name: string; count: number }[];
  data: Record<string, unknown[]>;
}

/**
 * Validate the parsed 'Export all data' JSON. Requires a `data` object whose
 * values are all arrays (the collections payload); `company` / `exportedAt`
 * are optional metadata shown in the preview. Forward-compatible: collections
 * are imported exactly as the file contains them — no hardcoded subset.
 */
function parseExportFile(fileName: string, text: string): ImportPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Not an HRMS export file — expected a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;
  const data = obj.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Not an HRMS export file — missing the "data" collections payload.');
  }
  const entries = Object.entries(data as Record<string, unknown>).map(([name, items]) => {
    if (!Array.isArray(items)) {
      throw new Error(`Collection "${name}" is not a list — the file looks corrupted.`);
    }
    return { name, count: items.length };
  });
  if (entries.length === 0) {
    throw new Error('The export contains no collections.');
  }
  const company = obj.company as { id?: unknown; name?: unknown; code?: unknown } | undefined;
  return {
    fileName,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : undefined,
    company:
      company && typeof company === 'object' && typeof company.name === 'string'
        ? company.name
        : undefined,
    entries,
    data: data as Record<string, unknown[]>,
  };
}

export default function DataSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [reseeding, setReseeding] = useState(false);
  const [exported, setExported] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Re-render on audit + settings writes so the storage readout stays fresh —
  // nearly every mutation in the app appends to the audit collection.
  useCollection('audit');
  useCollection('settings');

  const bytes = (void refreshTick, storageBytes());

  const onExport = () => {
    // Registry-driven: every COLLECTIONS entry (core + module collections) is
    // included automatically — the list can never drift out of sync again.
    const data = exportTenantData();
    const company = getActiveCompany();
    const payload = {
      app: 'my-hrms-demo',
      version: 1,
      exportedAt: new Date().toISOString(),
      company: company ? { id: company.id, code: company.code, name: company.name } : null,
      collections: COLLECTIONS.length,
      data,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hrms-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    logAudit({ actorName: DEMO_ACTOR, action: 'data.export', entity: 'settings', detail: 'Full JSON export downloaded' });
    setExported(true);
    window.setTimeout(() => setExported(false), 2500);
  };

  const onImportFile = async (file: File) => {
    try {
      const preview = parseExportFile(file.name, await file.text());
      setImportMode('merge');
      setImportPreview(preview);
    } catch (err) {
      toast.error('Import failed', {
        description: err instanceof Error ? err.message : 'Could not read that file.',
      });
    }
  };

  const applyImport = () => {
    if (!importPreview) return;
    setImporting(true);
    try {
      // Restore into the ACTIVE tenant only — never the tenant the file came
      // from. Any registry collection is accepted; unknown collection names
      // (not in the registry) are skipped and reported.
      const tenant = getActiveTenantId() ?? 'co-asm';
      const report = importTenantData(importPreview.data, tenant, importMode);
      const { touched, rows, skipped } = report;
      logAudit({
        actorName: DEMO_ACTOR,
        action: 'data.import',
        entity: 'settings',
        detail: `Imported ${touched} collection(s) from ${importPreview.fileName} (${importMode})${skipped.length ? `; skipped unknown: ${skipped.join(', ')}` : ''}`,
      });
      toast.success('Import complete', {
        description:
          `${touched} collection(s) ${importMode === 'merge' ? 'merged' : 'replaced'} ` +
          `(${rows.toLocaleString()} rows from the file) into the active company.` +
          (skipped.length ? ` Skipped unknown: ${skipped.join(', ')}.` : ''),
      });
      setImportPreview(null);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      toast.error('Import failed', {
        description: err instanceof Error ? err.message : 'Could not apply the import.',
      });
    } finally {
      setImporting(false);
    }
  };

  const onReseed = async () => {
    setReseeding(true);
    try {
      // Await the seed module load and write the collections ourselves, so
      // the audit entry is logged AFTER the wipe has actually landed (the old
      // fixed 1.2 s timeout raced a cold/slow import and could drop the
      // entry). Reseeds the ACTIVE tenant only — mirrors seedTenantIfEmpty.
      const tenant = getActiveTenantId() ?? 'co-asm';
      const { buildTenantSeedData } = await import('@/lib/seed');
      const seed = buildTenantSeedData(tenant);
      if (!seed) return;
      (Object.keys(seed.collections) as CollectionName[]).forEach((name) => {
        setCollection(name, (seed.collections as Record<string, unknown[]>)[name], tenant);
      });
      localStorage.setItem(tenantSeedFlag(tenant), new Date().toISOString());
      logAudit({ actorName: DEMO_ACTOR, action: 'data.reseed', entity: 'settings', detail: 'Demo data reset & reseeded' });
      setResetDone(true);
      window.setTimeout(() => setResetDone(false), 4000);
    } finally {
      setReseeding(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionCard
        icon={HardDrive}
        title="Backup & export"
        description={`All data lives in your browser's localStorage (≈ ${fmtBytes(bytes)} across ${COLLECTIONS.length} collections).`}
        action={
          <Button variant="ghost" size="icon" aria-label="Refresh storage size" title="Refresh storage size" onClick={() => setRefreshTick((t) => t + 1)}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onExport}>
            <Download className="mr-1.5 h-4 w-4" />
            {exported ? 'Exported ✓' : 'Export all data (JSON)'}
          </Button>
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-1.5 h-4 w-4" />
            Import data
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ''; // allow re-picking the same file
              if (file) void onImportFile(file);
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          The export contains every registry collection — core HR data (employees, attendance, leaves, claims, payroll
          runs, payslips, KPIs, reviews, holidays, settings, audit) plus module data (lifecycle checklists &amp;
          offboarding cases, org profiles, contracts &amp; fee payments, personnel files, onboarding links /
          submissions / extras, KPI cycles / objectives / check-ins / PIPs, shift rotations) — in one timestamped JSON
          file. Import validates the file, shows a preview, then restores into the <strong>active company</strong> —
          merging by record id or replacing collections outright; unknown collection names are skipped and reported.
        </p>
      </SectionCard>

      {/* Import preview & confirm */}
      <Dialog open={importPreview !== null} onOpenChange={(o) => !o && setImportPreview(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import {importPreview?.fileName}?</DialogTitle>
            <DialogDescription>
              {importPreview?.exportedAt ? `Exported ${importPreview.exportedAt}` : 'HRMS export file'}
              {importPreview?.company ? ` · from ${importPreview.company}` : ''} — restores into the
              currently active company.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-56 overflow-y-auto rounded-xl border">
            <ul className="divide-y text-sm">
              {importPreview?.entries.map((e) => (
                <li key={e.name} className="flex items-center justify-between px-3 py-1.5">
                  <span className="font-mono text-xs">{e.name}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {e.count.toLocaleString()} row{e.count === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <RadioGroup
            value={importMode}
            onValueChange={(v) => setImportMode(v as 'merge' | 'replace')}
            className="gap-3"
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem value="merge" id="import-merge" className="mt-0.5" />
              <Label htmlFor="import-merge" className="font-normal">
                <span className="font-medium">Merge</span> — update records the file contains, keep
                everything else. Existing records with the same id are overwritten.
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="replace" id="import-replace" className="mt-0.5" />
              <Label htmlFor="import-replace" className="font-normal">
                <span className="font-medium">Replace</span> — each collection in the file replaces the
                active company's collection entirely. Records not in the file are lost.
              </Label>
            </div>
          </RadioGroup>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setImportPreview(null)} disabled={importing}>
              Cancel
            </Button>
            <Button onClick={applyImport} disabled={importing}>
              <Upload className="mr-1.5 h-4 w-4" />
              {importing ? 'Importing…' : importMode === 'merge' ? 'Merge into active company' : 'Replace active company data'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SectionCard icon={DatabaseBackup} title="Demo dataset">
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-medium">Reset &amp; reseed demo data</p>
                <p className="mt-1 max-w-lg text-xs text-muted-foreground">
                  Wipes every collection — including all edits made in this session — and regenerates the original
                  demo dataset (30 employees, attendance, leaves, claims, KPIs and reviews). Settings, policies and
                  the audit log also return to their defaults. This cannot be undone.
                </p>
                {resetDone ? (
                  <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                    Demo data has been reset and reseeded.
                  </p>
                ) : null}
              </div>
            </div>
            <Button variant="destructive" className="shrink-0" disabled={reseeding} onClick={() => setConfirmOpen(true)}>
              {reseeding ? 'Reseeding…' : 'Reset & reseed'}
            </Button>
          </div>
        </div>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset all demo data?</AlertDialogTitle>
              <AlertDialogDescription>
                Every collection will be replaced with the original seed dataset. All changes you made in this
                session will be lost — including company settings, payroll &amp; claim policies, leave top-ups and
                geofence locations, which return to their defaults. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void onReseed()}>Yes, reset everything</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SectionCard>
    </div>
  );
}
