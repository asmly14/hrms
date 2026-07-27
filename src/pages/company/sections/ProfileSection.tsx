/**
 * Company Setup → Profile: registered particulars and employer statutory
 * numbers for the ACTIVE company.
 *
 * Dual-write: the tenant directory record (`Company.name / regNo / hqState`)
 * is the canonical multi-tenant home; the tenant-scoped settings singleton
 * (doc id 'company') is mirrored so payslips, statutory forms and the legacy
 * Settings page keep working unchanged.
 */
import { useEffect, useState } from 'react';
import { Building2, Landmark } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { states } from '@/lib/holidays';
import type { StateCode } from '@/lib/types';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Field, SaveButton, SectionCard } from '../../settings/shared';
import { mirrorCompanySingleton, mirrorSettingsDoc, useCompanySetup, useUnsavedGuard, UNSAVED_HINT } from '../store';

interface SettingsRow {
  id: string;
  [key: string]: unknown;
}

interface Draft {
  name: string;
  regNo: string;
  address: string;
  hqState: StateCode;
  epfEmployerNo: string;
  socsoEmployerNo: string;
  taxEmployerNo: string;
  hrdCorpRegNo: string;
}

export default function ProfileSection() {
  const { company, save } = useCompanySetup();
  const { items: settingsRows } = useCollection<SettingsRow>('settings');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);

  const singleton = settingsRows.find((r) => r.id === 'company');
  const extras = settingsRows.find((r) => r.id === 'ext:company');

  // Initialise once BOTH the Company record and the settings singleton are
  // present; re-seed only when switching to a different company.
  const companyId = company?.id;
  useEffect(() => {
    setDraft(null);
    setDirty(false);
  }, [companyId]);
  useEffect(() => {
    if (!company || !singleton || draft) return;
    setDraft({
      name: company.name,
      regNo: company.regNo,
      address: typeof singleton.address === 'string' ? singleton.address : '',
      hqState: company.hqState,
      epfEmployerNo: typeof singleton.epfEmployerNo === 'string' ? singleton.epfEmployerNo : '',
      socsoEmployerNo: typeof singleton.socsoEmployerNo === 'string' ? singleton.socsoEmployerNo : '',
      taxEmployerNo: typeof singleton.taxEmployerNo === 'string' ? singleton.taxEmployerNo : '',
      hrdCorpRegNo: typeof extras?.hrdCorpRegNo === 'string' ? extras.hrdCorpRegNo : '',
    });
  }, [company, singleton, extras, draft]);

  if (!company || !draft) {
    return (
      <SectionCard icon={Building2} title="Company profile" description="Loading company particulars…">
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </SectionCard>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setDirty(true);
  };

  const nameMissing = draft.name.trim().length === 0;

  const onSave = () => {
    if (nameMissing) return;
    const trimmed = {
      name: draft.name.trim(),
      regNo: draft.regNo.trim(),
      address: draft.address.trim(),
      epfEmployerNo: draft.epfEmployerNo.trim(),
      socsoEmployerNo: draft.socsoEmployerNo.trim(),
      taxEmployerNo: draft.taxEmployerNo.trim(),
      hrdCorpRegNo: draft.hrdCorpRegNo.trim(),
    };
    save(
      (c) => ({ ...c, name: trimmed.name, regNo: trimmed.regNo, hqState: draft.hqState }),
      `Company profile saved (${trimmed.name})`,
    );
    // Mirror into the tenant-scoped settings docs that payslips / statutory
    // forms / the legacy Settings page read from.
    mirrorCompanySingleton({
      companyName: trimmed.name,
      companyRegNo: trimmed.regNo,
      address: trimmed.address,
      hqState: draft.hqState,
      epfEmployerNo: trimmed.epfEmployerNo,
      socsoEmployerNo: trimmed.socsoEmployerNo,
      taxEmployerNo: trimmed.taxEmployerNo,
    });
    mirrorSettingsDoc('ext:company', { kind: 'companyExtras', hrdCorpRegNo: trimmed.hrdCorpRegNo });
    setDirty(false);
  };

  return (
    <div className="space-y-6">
      <SectionCard
        icon={Building2}
        title="Company profile"
        description="Registered particulars for the active company — used across payslips, reports and statutory forms."
        action={
          <div className="flex items-center gap-2">
            {dirty ? <span className="text-xs font-medium text-amber-700">{UNSAVED_HINT}</span> : null}
            <SaveButton onSave={onSave} disabled={nameMissing} />
          </div>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name" hint="Required — shown on payslips and statutory forms.">
            <Input value={draft.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Registration no. (SSM)">
            <Input value={draft.regNo} onChange={(e) => set('regNo', e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Registered address">
              <Textarea rows={2} value={draft.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
          </div>
          <Field label="HQ state" hint="Drives public-holiday lists and the default weekend rule (see Work & payroll policy).">
            <Select value={draft.hqState} onValueChange={(v) => set('hqState', v as StateCode)}>
              <SelectTrigger>
                <SelectValue placeholder="Select state" />
              </SelectTrigger>
              <SelectContent>
                {states.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        {nameMissing ? (
          <p className="text-xs text-destructive">Company name is required — saving is disabled until it is filled in.</p>
        ) : null}
      </SectionCard>

      <SectionCard
        icon={Landmark}
        title="Employer statutory numbers"
        description="Quoted on EPF Form A, SOCSO Form 8A, EIS and e-CP39 submissions."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="EPF employer no. (KWSP)">
            <Input value={draft.epfEmployerNo} onChange={(e) => set('epfEmployerNo', e.target.value)} />
          </Field>
          <Field label="SOCSO employer no. (PERKESO)">
            <Input value={draft.socsoEmployerNo} onChange={(e) => set('socsoEmployerNo', e.target.value)} />
          </Field>
          <Field label="Tax employer no. (LHDN E no.)">
            <Input value={draft.taxEmployerNo} onChange={(e) => set('taxEmployerNo', e.target.value)} />
          </Field>
          <Field label="HRD Corp registration no.">
            <Input value={draft.hrdCorpRegNo} onChange={(e) => set('hrdCorpRegNo', e.target.value)} />
          </Field>
        </div>
      </SectionCard>
    </div>
  );
}
