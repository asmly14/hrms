/**
 * Step 6 — PDPA-style declaration + a read-back summary of what will be sent.
 */
import type { Company } from '@/lib/types';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, StepIntro } from '../fields';
import { STEP_TITLES, type FormErrors, type OnboardFormState } from '../formState';

interface Props {
  form: OnboardFormState;
  patch: (p: Partial<OnboardFormState>) => void;
  errors: FormErrors;
  company?: Company;
}

export default function DeclarationStep({ form, patch, errors, company }: Props) {
  const companyName = company?.name ?? 'the Company';
  return (
    <div className="space-y-5">
      <StepIntro title="Declaration">Almost done — please review and confirm.</StepIntro>

      {/* Summary read-back */}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl border bg-stone-50/60 p-4 text-sm dark:bg-stone-900/30 sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="text-right font-medium">{form.name || '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">NRIC</dt>
          <dd className="text-right font-medium">{form.ic || '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Email</dt>
          <dd className="max-w-[60%] truncate text-right font-medium">{form.email || '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Phone</dt>
          <dd className="text-right font-medium">{form.phone || '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Start date</dt>
          <dd className="text-right font-medium">{form.joinDate || '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Documents</dt>
          <dd className="text-right font-medium">{form.documents.length} file(s)</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{STEP_TITLES.emergency}</dt>
          <dd className="text-right font-medium">{form.emergencyContacts.length}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Qualifications</dt>
          <dd className="text-right font-medium">{form.academics.length}</dd>
        </div>
      </dl>

      <Field error={errors.declaration}>
        <label
          htmlFor="ob-declare"
          className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 text-sm leading-relaxed hover:bg-stone-50 dark:hover:bg-stone-900/40"
        >
          <Checkbox
            id="ob-declare"
            className="mt-0.5"
            checked={form.declarationAccepted}
            onCheckedChange={(v) => patch({ declarationAccepted: v === true })}
          />
          <span>
            I declare that the information and documents provided are true, complete and correct.
            I consent to <span className="font-medium">{companyName}</span> collecting, using and
            processing my personal data for employment, payroll and statutory purposes in
            accordance with the Personal Data Protection Act 2010 (PDPA). I understand that false
            information may result in the withdrawal of any employment offer or dismissal.
          </span>
        </label>
      </Field>
    </div>
  );
}
