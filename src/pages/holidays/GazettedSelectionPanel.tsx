/**
 * GazettedSelectionPanel — the employer's EA 1955 s.60D pick of the 6 chosen
 * gazetted paid public holidays (per company, per year), with live compliance
 * advice and a Publish step (the "conspicuous notice" act, s.60D(1)).
 *
 * Data flows through lib/gazetted.ts (settings-doc `ext:gazetted:<year>` in
 * the tenant-scoped 'settings' collection); this panel is remounted per
 * year+state (`key` from the parent) so the working draft always initializes
 * from the stored record. Read-only for non-Admin/HR — employees see the
 * published notice only.
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Info, Lock, Megaphone, RotateCcw, Save,
} from 'lucide-react';
import { toast } from 'sonner';
import { logAudit, useCollection } from '@/lib/db';
import { stateInfo } from '@/lib/holidays';
import {
  CHOSEN_COUNT,
  COMPULSORY_COUNT,
  STATUTORY_TOTAL,
  choosablePool,
  compulsoryHolidays,
  effectiveGazettedDays,
  getGazettedSelection,
  publishGazettedSelection,
  resetGazettedSelection,
  saveGazettedSelection,
  validateSelection,
} from '@/lib/gazetted';
import { cn, fmtDate } from '@/lib/utils';
import type { Holiday, StateCode } from '@/lib/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';

interface DocRow {
  id: string;
  kind?: string;
}

interface Props {
  year: number;
  state: StateCode;
  /** Audit actor label, e.g. "HR (demo)". */
  actor: string;
  /** Admin/HR may edit + publish; everyone else gets the read-only notice. */
  canManage: boolean;
}

function weekday(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-MY', { weekday: 'short' });
}

function Meta({ h }: { h: Holiday }) {
  return (
    <p className="text-xs text-muted-foreground">
      {fmtDate(h.date)} · {weekday(h.date)}
    </p>
  );
}

function CompulsoryCard({ h }: { h: Holiday }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border bg-muted/40 p-3">
      <Checkbox checked disabled aria-label={`${h.name} (compulsory, locked)`} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Lock className="h-3 w-3 text-amber-600" /> {h.name}
        </p>
        <Meta h={h} />
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200">
            Compulsory
          </Badge>
          {h.tentative && <Badge variant="outline" className="border-dashed">Tentative</Badge>}
        </div>
      </div>
    </div>
  );
}

function PoolCard({
  h,
  checked,
  onToggle,
}: {
  h: Holiday;
  checked: boolean;
  onToggle: (date: string, checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-xl border p-3 transition-colors',
        checked
          ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/30'
          : 'hover:bg-muted/40',
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(c) => onToggle(h.date, c === true)}
        aria-label={`Choose ${h.name}`}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{h.name}</p>
        <Meta h={h} />
        {(h.tentative || h.isOverride) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {h.tentative && <Badge variant="outline" className="border-dashed">Tentative</Badge>}
            {h.isOverride && <Badge variant="outline">Custom</Badge>}
          </div>
        )}
      </div>
    </label>
  );
}

export default function GazettedSelectionPanel({ year, state, actor, canManage }: Props) {
  // Subscriptions keep the panel live: settings holds the selection doc,
  // holidays holds custom-company-day overrides that join the pool.
  const { items: settingsItems } = useCollection<DocRow>('settings');
  const holidaysApi = useCollection<Holiday>('holidays');

  const selection = useMemo(
    () => getGazettedSelection(year),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsItems, year],
  );
  const compulsory = useMemo(
    () => compulsoryHolidays(year, state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holidaysApi.items, year, state],
  );
  const pool = useMemo(
    () => choosablePool(year, state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holidaysApi.items, year, state],
  );

  // Working draft — initialized from the stored record when it belongs to
  // this state; a record saved for another state starts an empty draft.
  const [draft, setDraft] = useState<Set<string>>(
    () => new Set(selection && selection.state === state ? selection.chosenDates : []),
  );
  const [resetArmed, setResetArmed] = useState(false);

  const poolDates = useMemo(() => new Set(pool.map((h) => h.date)), [pool]);
  const chosenCount = useMemo(
    () => [...draft].filter((d) => poolDates.has(d)).length,
    [draft, poolDates],
  );
  const total = COMPULSORY_COUNT + chosenCount;

  const validation = useMemo(
    () => validateSelection(year, state, [...draft]),
    [year, state, draft],
  );

  const published = selection?.publishedAt ? selection : null;
  const hasUnpublishedChanges = Boolean(
    published && [...draft].sort().join(',') !== (published.publishedDates ?? []).join(','),
  );
  const stateMismatch = selection && selection.state !== state ? selection : null;

  const toggle = (date: string, checked: boolean) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (checked) next.add(date);
      else next.delete(date);
      return next;
    });
  };

  const onSaveDraft = () => {
    saveGazettedSelection(year, state, [...draft]);
    logAudit({
      actorName: actor,
      action: 'gazetted.selection.save',
      entity: 'settings',
      entityId: `ext:gazetted:${year}`,
      detail: `${year} ${state}: ${draft.size} chosen date(s) saved as draft`,
    });
    toast.success(`Draft saved for ${year} (${stateInfo(state).name}) — not published yet.`);
  };

  const onPublish = () => {
    const r = publishGazettedSelection(year, state, [...draft]);
    if (!r.ok) {
      toast.error(r.issues[0] ?? 'Selection is incomplete — see the advice panel.');
      return;
    }
    logAudit({
      actorName: actor,
      action: 'gazetted.selection.publish',
      entity: 'settings',
      entityId: `ext:gazetted:${year}`,
      detail: `${year} ${state}: published ${r.selection.publishedDates?.length ?? 0} chosen + ${COMPULSORY_COUNT} compulsory gazetted days`,
    });
    toast.success(
      `Published the ${year} gazetted selection for ${stateInfo(state).name} — ` +
        'display it conspicuously before the year starts (EA 1955 s.60D(1)).',
    );
  };

  const onReset = () => {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setResetArmed(false);
    setDraft(new Set());
    if (resetGazettedSelection(year)) {
      logAudit({
        actorName: actor,
        action: 'gazetted.selection.reset',
        entity: 'settings',
        entityId: `ext:gazetted:${year}`,
        detail: `${year}: gazetted selection removed`,
      });
      toast.success(`${year} gazetted selection reset.`);
    } else {
      toast.info(`No saved selection for ${year}.`);
    }
  };

  // ── Read-only notice for non-Admin/HR ────────────────────────────────────
  if (!canManage) {
    const publishedDays = published ? effectiveGazettedDays(year, state) : [];
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Gazetted paid holidays — {year}</CardTitle>
          <CardDescription>
            The statutory {STATUTORY_TOTAL} paid public holidays for {stateInfo(state).name} under
            EA 1955 s.60D ({COMPULSORY_COUNT} compulsory + {CHOSEN_COUNT} chosen by the employer).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!published ? (
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
              HR has not published the {year} gazetted selection for {stateInfo(state).name} yet.
              The {COMPULSORY_COUNT} compulsory holidays always apply.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Published {fmtDate(published.publishedAt!)} · displayed per EA 1955 s.60D(1).
              </p>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {publishedDays.map((h) => (
                  <li key={`${h.date}-${h.name}`} className="rounded-xl border p-3">
                    <p className="text-sm font-medium">{h.name}</p>
                    <Meta h={h} />
                    <div className="mt-1">
                      {h.isCompulsoryEA ? (
                        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200">
                          Compulsory
                        </Badge>
                      ) : (
                        <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-200">
                          Chosen
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── Admin/HR picker ──────────────────────────────────────────────────────
  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="text-base">
          Gazetted selection — {stateInfo(state).name} {year}
        </CardTitle>
        <CardDescription>
          Pick the {CHOSEN_COUNT} employer-chosen gazetted paid public holidays for {year}. The{' '}
          {COMPULSORY_COUNT} compulsory days are fixed by law. Every holiday on the calendar is
          still observed for leave &amp; attendance — this selection only designates which days are
          the statutory {STATUTORY_TOTAL} paid public holidays (EA 1955 s.60D).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Status row */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={cn(
              total >= STATUTORY_TOTAL
                ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-200'
                : 'bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200',
            )}
          >
            {total} / {STATUTORY_TOTAL} gazetted days
          </Badge>
          {published ? (
            <Badge variant="secondary">Published {fmtDate(published.publishedAt!)}</Badge>
          ) : (
            <Badge variant="outline" className="border-dashed">Not published</Badge>
          )}
          {hasUnpublishedChanges && (
            <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200">
              Unpublished changes
            </Badge>
          )}
        </div>

        {stateMismatch && (
          <Alert className="rounded-xl border-sky-200 bg-sky-50/60 dark:border-sky-900/40 dark:bg-sky-950/30">
            <Info className="h-4 w-4 text-sky-700 dark:text-sky-400" />
            <AlertTitle>One selection per year</AlertTitle>
            <AlertDescription className="text-sm">
              The saved {year} selection is for {stateInfo(stateMismatch.state).name}. Switch the
              state picker to edit it — saving or publishing here replaces it for{' '}
              {stateInfo(state).name}.
            </AlertDescription>
          </Alert>
        )}

        {/* Live advice panel */}
        {validation.valid ? (
          <Alert className="rounded-xl border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/30">
            <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
            <AlertTitle>Complete</AlertTitle>
            <AlertDescription className="text-sm">
              {STATUTORY_TOTAL} gazetted paid holidays selected ({COMPULSORY_COUNT} compulsory +{' '}
              {chosenCount} chosen). Publish and display the notice conspicuously before the year
              starts (EA 1955 s.60D(1)).
            </AlertDescription>
          </Alert>
        ) : (
          <Alert className="rounded-xl border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/30">
            <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400" />
            <AlertTitle>Compliance advice</AlertTitle>
            <AlertDescription className="text-sm">
              <ul className="list-disc space-y-1 pl-4">
                {validation.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {validation.warnings.length > 0 && (
          <Alert className="rounded-xl border-amber-200/70 bg-amber-50/40 dark:border-amber-900/30 dark:bg-amber-950/20">
            <Info className="h-4 w-4 text-amber-700 dark:text-amber-400" />
            <AlertTitle>Notes</AlertTitle>
            <AlertDescription className="text-sm">
              <ul className="list-disc space-y-1 pl-4">
                {validation.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Compulsory — locked */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            Compulsory by law <span className="text-muted-foreground">(locked — always paid)</span>
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {compulsory.map((h) => (
              <CompulsoryCard key={`${h.date}-${h.name}`} h={h} />
            ))}
          </div>
        </div>

        <Separator />

        {/* Choosable pool */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            Choose {CHOSEN_COUNT} from the gazetted pool{' '}
            <span className="text-muted-foreground">({chosenCount} selected)</span>
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {pool.map((h) => (
              <PoolCard key={`${h.date}-${h.name}`} h={h} checked={draft.has(h.date)} onToggle={toggle} />
            ))}
          </div>
        </div>

        <Separator />

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onSaveDraft} className="gap-1.5">
            <Save className="h-4 w-4" /> Save draft
          </Button>
          <Button onClick={onPublish} disabled={!validation.valid} className="gap-1.5">
            <Megaphone className="h-4 w-4" /> Publish
          </Button>
          <Button
            variant="ghost"
            onClick={onReset}
            className={cn('ml-auto gap-1.5', resetArmed && 'text-rose-600 hover:text-rose-600')}
          >
            <RotateCcw className="h-4 w-4" />
            {resetArmed ? 'Click again to confirm reset' : `Reset ${year}`}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Publishing is the compliance act: it freezes the notice of the {CHOSEN_COUNT} chosen days
          to display conspicuously before the year starts (EA 1955 s.60D(1)). Later edits are kept
          as unpublished changes until re-published; a chosen day may still be substituted by
          agreement with the employee (s.60D(1A)).
        </p>
      </CardContent>
    </Card>
  );
}
