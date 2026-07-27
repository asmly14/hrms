/**
 * Company Setup → Branding studio: logoText + accentColor picker with a LIVE
 * preview (mini dashboard mock), plus document number formats.
 *
 * The accent color is applied to the running app the moment it changes
 * (preview + Save) via `applyCompanyBranding()` — see branding.ts for the
 * CSS variables written and the app-wide mounting note for the integration
 * agent.
 */
import { useEffect, useState } from 'react';
import { Check, Palette, Hash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, SaveButton, SectionCard } from '../../settings/shared';
import { ACCENT_PRESETS, applyCompanyBranding } from '../branding';
import { useCompanySetup, useUnsavedGuard, UNSAVED_HINT } from '../store';

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

interface Draft {
  logoText: string;
  accentColor: string;
  employeeIdPrefix: string;
  payslipPrefix: string;
}

/** Mini dashboard mock that re-themes itself with the draft accent color. */
function BrandingPreview({ logoText, accentColor }: { logoText: string; accentColor: string }) {
  const valid = HEX_RE.test(accentColor.trim());
  const accent = valid ? accentColor.trim() : '#b45309';
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* mock app header */}
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[11px] font-bold text-white"
          style={{ backgroundColor: accent }}
        >
          {(logoText.trim() || '?').slice(0, 3).toUpperCase()}
        </span>
        <span className="text-sm font-semibold">{logoText.trim() || 'Company'}</span>
        <span className="ml-auto flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-stone-200" />
          <span className="h-2 w-2 rounded-full bg-stone-200" />
        </span>
      </div>
      {/* mock body */}
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-3 gap-2">
          {['Headcount', 'Payroll', 'Leave'].map((label, i) => (
            <div key={label} className="rounded-lg border p-2.5">
              <p className="text-[10px] text-muted-foreground">{label}</p>
              <p className="mt-0.5 text-sm font-semibold" style={i === 0 ? { color: accent } : undefined}>
                {[30, 'RM 84k', 4][i]}
              </p>
            </div>
          ))}
        </div>
        {/* mock progress bars */}
        <div className="space-y-1.5">
          {[80, 55, 30].map((w, i) => (
            <div key={i} className="h-1.5 overflow-hidden rounded-full bg-stone-100">
              <div className="h-full rounded-full" style={{ width: `${w}%`, backgroundColor: accent, opacity: 1 - i * 0.25 }} />
            </div>
          ))}
        </div>
        {/* mock primary action */}
        <div className="flex items-center gap-2">
          <span className="rounded-md px-3 py-1.5 text-xs font-medium text-white" style={{ backgroundColor: accent }}>
            Run payroll
          </span>
          <span className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground">Export</span>
        </div>
      </div>
    </div>
  );
}

export default function BrandingSection() {
  const { company, save } = useCompanySetup();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);

  const companyId = company?.id;
  useEffect(() => {
    setDraft(null);
    setDirty(false);
  }, [companyId]);
  useEffect(() => {
    if (!company || draft) return;
    setDraft({
      logoText: company.branding.logoText,
      accentColor: company.branding.accentColor,
      employeeIdPrefix: company.config.numberFormats.employeeIdPrefix,
      payslipPrefix: company.config.numberFormats.payslipPrefix,
    });
  }, [company, draft]);

  // Live-apply the draft accent so the admin sees the REAL app re-theme
  // (sidebar, buttons) while choosing — not just the mock below.
  const draftAccent = draft?.accentColor ?? '';
  const draftLogo = draft?.logoText ?? '';
  useEffect(() => {
    if (draft && HEX_RE.test(draftAccent.trim())) {
      applyCompanyBranding({ logoText: draftLogo, accentColor: draftAccent.trim() });
    }
  }, [draft, draftAccent, draftLogo]);

  if (!company || !draft) {
    return (
      <SectionCard icon={Palette} title="Branding studio" description="Loading branding…">
        <Skeleton className="h-48 w-full rounded-lg" />
      </SectionCard>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setDirty(true);
  };

  const hexValid = HEX_RE.test(draft.accentColor.trim());
  const logoValid = draft.logoText.trim().length > 0;
  const prefixesValid =
    draft.employeeIdPrefix.trim().length > 0 && draft.payslipPrefix.trim().length > 0;
  const valid = hexValid && logoValid && prefixesValid;

  const year = new Date().getFullYear();
  const empExample = `${(draft.employeeIdPrefix.trim() || company.code).toUpperCase()}0031`;
  const psExample = `${draft.payslipPrefix.trim() || 'PS'}-${year}-001`;

  const onSave = () => {
    if (!valid) return;
    const accent = draft.accentColor.trim();
    save(
      (c) => ({
        ...c,
        branding: { logoText: draft.logoText.trim(), accentColor: accent },
        config: {
          ...c.config,
          numberFormats: {
            employeeIdPrefix: draft.employeeIdPrefix.trim().toUpperCase(),
            payslipPrefix: draft.payslipPrefix.trim(),
          },
        },
      }),
      `Branding saved (${draft.logoText.trim()}, ${accent}) and number formats updated`,
    );
    applyCompanyBranding({ logoText: draft.logoText.trim(), accentColor: accent });
    setDirty(false);
  };

  return (
    <div className="space-y-6">
      <SectionCard
        icon={Palette}
        title="Branding studio"
        description="Identity shown in the app shell and on payslips. The accent color re-themes the live app for this company."
        action={
          <div className="flex items-center gap-2">
            {dirty ? <span className="text-xs font-medium text-amber-700">{UNSAVED_HINT}</span> : null}
            <SaveButton onSave={onSave} disabled={!valid} />
          </div>
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Field label="Logo text" hint="Short mark shown in the sidebar and app header (2–4 letters works best).">
              <Input
                value={draft.logoText}
                maxLength={8}
                onChange={(e) => set('logoText', e.target.value)}
                placeholder={company.code}
              />
            </Field>

            <Field label="Accent color" hint="Pick a swatch or enter any hex value — the app re-themes live as you choose.">
              <div className="flex flex-wrap items-center gap-2">
                {ACCENT_PRESETS.map((p) => (
                  <button
                    key={p.hex}
                    type="button"
                    title={`${p.name} (${p.hex})`}
                    onClick={() => set('accentColor', p.hex)}
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-full border-2 transition-transform hover:scale-110',
                      draft.accentColor.trim().toLowerCase() === p.hex.toLowerCase()
                        ? 'border-foreground'
                        : 'border-transparent',
                    )}
                    style={{ backgroundColor: p.hex }}
                  >
                    {draft.accentColor.trim().toLowerCase() === p.hex.toLowerCase() ? (
                      <Check className="h-4 w-4 text-white" />
                    ) : null}
                  </button>
                ))}
                <div className="relative">
                  <span
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border"
                    style={{ backgroundColor: hexValid ? draft.accentColor.trim() : 'transparent' }}
                  />
                  <Input
                    className="w-32 pl-10 font-mono"
                    value={draft.accentColor}
                    onChange={(e) => set('accentColor', e.target.value)}
                    placeholder="#b45309"
                  />
                </div>
              </div>
            </Field>
            {!hexValid ? <p className="text-xs text-destructive">Enter a valid hex color, e.g. #b45309.</p> : null}
            <p className="text-xs text-muted-foreground">
              Saved on <code className="rounded bg-muted px-1 py-0.5">Company.branding</code> and applied via CSS
              variables on <code className="rounded bg-muted px-1 py-0.5">:root</code> (
              <code className="rounded bg-muted px-1 py-0.5">--primary</code>,{' '}
              <code className="rounded bg-muted px-1 py-0.5">--accent</code>,{' '}
              <code className="rounded bg-muted px-1 py-0.5">--company-accent</code>). The{' '}
              <code className="rounded bg-muted px-1 py-0.5">useCompanyBranding()</code> hook re-applies it on every
              visit / tenant switch.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Live preview</p>
            <BrandingPreview logoText={draft.logoText} accentColor={draft.accentColor} />
          </div>
        </div>
      </SectionCard>

      <SectionCard
        icon={Hash}
        title="Number formats"
        description="Document numbering conventions for this company. Employee numbers are generated from the prefix (nextEmployeeNo in the tenant layer)."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Employee ID prefix" hint="Uppercased on save; new hires are numbered sequentially per company.">
            <Input
              value={draft.employeeIdPrefix}
              maxLength={8}
              onChange={(e) => set('employeeIdPrefix', e.target.value)}
            />
          </Field>
          <Field label="Payslip prefix" hint="Used on payslip document numbers and payroll exports.">
            <Input value={draft.payslipPrefix} maxLength={12} onChange={(e) => set('payslipPrefix', e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="font-mono">
            Next employee: {empExample}
          </Badge>
          <Badge variant="secondary" className="font-mono">
            Payslip: {psExample}
          </Badge>
        </div>
        {!prefixesValid ? <p className="text-xs text-destructive">Both prefixes are required.</p> : null}
      </SectionCard>
    </div>
  );
}
