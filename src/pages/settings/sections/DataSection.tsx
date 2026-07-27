/**
 * Settings → Data management: full JSON export of every collection, an
 * import placeholder, and the guarded "Reset & reseed demo data" action.
 */
import { useState } from 'react';
import { DatabaseBackup, Download, HardDrive, RefreshCw, TriangleAlert, Upload } from 'lucide-react';
import {
  COLLECTIONS, getActiveTenantId, getCollection, logAudit, setCollection,
  tenantSeedFlag, useCollection, type CollectionName,
} from '@/lib/db';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
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

export default function DataSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [reseeding, setReseeding] = useState(false);
  const [exported, setExported] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // Re-render on audit + settings writes so the storage readout stays fresh —
  // nearly every mutation in the app appends to the audit collection.
  useCollection('audit');
  useCollection('settings');

  const bytes = (void refreshTick, storageBytes());

  const onExport = () => {
    const data: Record<string, unknown[]> = {};
    for (const name of COLLECTIONS) data[name] = getCollection(name);
    const payload = {
      app: 'my-hrms-demo',
      version: 1,
      exportedAt: new Date().toISOString(),
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
          <Button variant="outline" disabled title="Import validation tooling is planned for a later release">
            <Upload className="mr-1.5 h-4 w-4" />
            Import data
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The export contains every collection (employees, attendance, leaves, claims, payroll runs, payslips, KPIs,
          reviews, holidays, settings and audit) in one timestamped JSON file. Import is a placeholder for now.
        </p>
      </SectionCard>

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
