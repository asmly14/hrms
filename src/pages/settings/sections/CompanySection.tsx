/**
 * Settings → Company profile: editable company particulars and employer
 * statutory numbers (EPF / SOCSO / tax from the core Settings singleton;
 * HRD Corp reg no from the extended settings record).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Landmark } from 'lucide-react';
import { logAudit } from '@/lib/db';
import { states } from '@/lib/holidays';
import type { Settings, StateCode } from '@/lib/types';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { DEMO_ACTOR, Field, SaveButton, SectionCard } from '../shared';
import { useSettingsData } from '../store';

interface Draft {
  companyName: string;
  companyRegNo: string;
  address: string;
  hqState: StateCode;
  epfEmployerNo: string;
  socsoEmployerNo: string;
  taxEmployerNo: string;
  hrdCorpRegNo: string;
}

export default function CompanySection() {
  const { company, companyExtras, saveCompany, saveCompanyExtras } = useSettingsData();
  const [draft, setDraft] = useState<Draft | null>(null);

  // Initialise once BOTH source records are present so the draft never
  // clobbers an in-flight edit and never seeds from a partial load.
  useEffect(() => {
    if (company && companyExtras) {
      setDraft((prev) =>
        prev ?? {
          companyName: company.companyName,
          companyRegNo: company.companyRegNo,
          address: company.address,
          hqState: company.hqState,
          epfEmployerNo: company.epfEmployerNo,
          socsoEmployerNo: company.socsoEmployerNo,
          taxEmployerNo: company.taxEmployerNo,
          hrdCorpRegNo: companyExtras.hrdCorpRegNo,
        },
      );
    }
  }, [company, companyExtras]);

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

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const nameMissing = draft.companyName.trim().length === 0;

  const onSave = () => {
    if (nameMissing) return;
    const core: Partial<Settings> = {
      companyName: draft.companyName.trim(),
      companyRegNo: draft.companyRegNo.trim(),
      address: draft.address.trim(),
      hqState: draft.hqState,
      epfEmployerNo: draft.epfEmployerNo.trim(),
      socsoEmployerNo: draft.socsoEmployerNo.trim(),
      taxEmployerNo: draft.taxEmployerNo.trim(),
    };
    saveCompany(core);
    saveCompanyExtras({ hrdCorpRegNo: draft.hrdCorpRegNo.trim() });
    logAudit({
      actorName: DEMO_ACTOR,
      action: 'settings.update',
      entity: 'settings',
      entityId: 'company',
      detail: `Company profile saved (${draft.companyName.trim() || 'unnamed'})`,
    });
  };

  return (
    <div className="space-y-6">
      <p className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
        These particulars are scoped to the active company and are also editable in{' '}
        <Link to="/company" className="font-medium text-amber-700 hover:underline underline-offset-4">
          Company Setup → Profile
        </Link>{' '}
        — both editors write the same records. Branding, number formats, modules and custom fields live in Company
        Setup only.
      </p>

      <SectionCard
        icon={Building2}
        title="Company profile"
        description="Registered particulars used across payslips, reports and statutory forms."
        action={<SaveButton onSave={onSave} disabled={nameMissing} />}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name" hint="Required — shown on payslips and statutory forms.">
            <Input value={draft.companyName} onChange={(e) => set('companyName', e.target.value)} />
          </Field>
          <Field label="Registration no. (SSM)">
            <Input value={draft.companyRegNo} onChange={(e) => set('companyRegNo', e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Registered address">
              <Textarea rows={2} value={draft.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
          </div>
          <Field label="HQ state" hint="Drives public holidays and the weekend rule for HQ-based staff.">
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
        {nameMissing ? <p className="text-xs text-destructive">Company name is required — saving is disabled until it is filled in.</p> : null}
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
