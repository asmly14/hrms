/**
 * Company Setup → Modules: per-company feature toggles stored in
 * `config.enabledModules`. Toggles apply immediately (each flip persists via
 * upsertCompany); nav/route gating reads `isModuleEnabled()` from
 * pages/company/modules.ts (integration agent wires that into the shell).
 */
import { AlertTriangle, AppWindow } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { modulesOutsidePlan, PLAN_CATALOG } from '@/lib/billing';
import { cn } from '@/lib/utils';
import type { ModuleKey } from '@/lib/types';
import { SectionCard } from '../../settings/shared';
import { MODULE_DEFS, type PlanHint } from '../modules';
import { useCompanySetup } from '../store';

const PLAN_BADGE_CLS: Record<PlanHint, string> = {
  'All plans': 'border-transparent bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
  Pro: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  Enterprise: 'border-transparent bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
};

export default function ModulesSection() {
  const { company, save } = useCompanySetup();

  if (!company) {
    return (
      <SectionCard icon={AppWindow} title="Modules" description="Loading modules…">
        <Skeleton className="h-40 w-full rounded-lg" />
      </SectionCard>
    );
  }

  const enabled = new Set<ModuleKey>(
    Array.isArray(company.config.enabledModules) ? company.config.enabledModules : [],
  );

  // SOFT plan enforcement (documented demo behaviour): modules enabled beyond
  // the plan's entitlements get an amber upgrade nudge — never a hard block.
  const outside = modulesOutsidePlan(company);
  const labelOf = new Map(MODULE_DEFS.map((m) => [m.key, m.label]));

  const toggle = (key: ModuleKey, on: boolean) => {
    save(
      (c) => {
        const current = new Set<ModuleKey>(
          Array.isArray(c.config.enabledModules) ? c.config.enabledModules : [],
        );
        if (on) current.add(key);
        else current.delete(key);
        // Persist in registry order so the stored array is stable/diff-friendly.
        const next = MODULE_DEFS.map((m) => m.key).filter((k) => current.has(k));
        return { ...c, config: { ...c.config, enabledModules: next } };
      },
      `Module ${key} ${on ? 'enabled' : 'disabled'}`,
    );
  };

  return (
    <div className="space-y-6">
      <SectionCard
        icon={AppWindow}
        title="Modules & features"
        description={`${enabled.size} of ${MODULE_DEFS.length} modules enabled for ${company.name}. Disabled modules are hidden from navigation and their routes are gated (via isModuleEnabled). Data is never deleted — re-enabling restores full access.`}
      >
        {outside.length > 0 ? (
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900 dark:bg-amber-950/30">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="space-y-1 text-sm">
              {outside.map((key) => (
                <p key={key}>
                  <span className="font-medium">{labelOf.get(key) ?? key}</span> is outside your{' '}
                  {PLAN_CATALOG[company.plan].label} plan — contact us to upgrade.
                </p>
              ))}
              <p className="text-xs text-muted-foreground">
                Nothing is blocked: these modules keep working in this demo, but they are billed
                at the next plan tier.
              </p>
            </div>
          </div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          {MODULE_DEFS.map((m) => {
            const on = enabled.has(m.key);
            return (
              <div
                key={m.key}
                className={cn(
                  'flex items-start justify-between gap-3 rounded-xl border p-4 transition-colors',
                  on ? 'bg-card' : 'bg-muted/40',
                )}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className={cn('text-sm font-medium', !on && 'text-muted-foreground')}>{m.label}</p>
                    <Badge variant="outline" className={PLAN_BADGE_CLS[m.planHint]}>
                      {m.planHint === 'All plans' ? 'All plans' : `${m.planHint} plan`}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{m.description}</p>
                </div>
                <Switch
                  checked={on}
                  onCheckedChange={(v) => toggle(m.key, v)}
                  aria-label={`Toggle ${m.label}`}
                />
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Plan badges and the amber banner above are advisory (soft enforcement) — toggles are never
          hard-blocked in this demo. Changes take effect on the next navigation; in-flight pages keep
          working until reload.
        </p>
      </SectionCard>
    </div>
  );
}
