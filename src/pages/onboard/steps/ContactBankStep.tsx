/**
 * Step 2 — Home address, bank account (salary, EA 1955 s.25) and statutory
 * numbers. Statutory numbers are OPTIONAL — many fresh grads have none yet;
 * HR completes them during EPF/SOCSO/LHDN registration.
 */
import { states } from '@/lib/holidays';
import type { StateCode } from '@/lib/types';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, StepIntro } from '../fields';
import type { FormErrors, OnboardFormState } from '../formState';

/** Common Malaysian banks for the datalist (free text still allowed). */
export const MY_BANKS = [
  'Maybank',
  'CIMB Bank',
  'Public Bank',
  'RHB Bank',
  'Hong Leong Bank',
  'AmBank',
  'Bank Islam',
  'Bank Rakyat',
  'OCBC Bank',
  'HSBC Bank',
  'Standard Chartered',
  'UOB Malaysia',
  'Alliance Bank',
  'Affin Bank',
  'GXBank',
];

interface Props {
  form: OnboardFormState;
  patch: (p: Partial<OnboardFormState>) => void;
  errors: FormErrors;
}

export default function ContactBankStep({ form, patch, errors }: Props) {
  return (
    <div className="space-y-5">
      <StepIntro title="Contact, bank & statutory">
        Your salary is paid directly into your bank account, so double-check the account number.
      </StepIntro>

      <Field id="ob-address" label="Home address" required error={errors.address}>
        <Textarea
          id="ob-address"
          value={form.address}
          onChange={(e) => patch({ address: e.target.value })}
          placeholder="No. 12, Jalan SS 2/1, 47300 Petaling Jaya"
          rows={3}
        />
      </Field>

      <Field label="State" required error={errors.state}>
        <Select value={form.state} onValueChange={(v) => patch({ state: v as StateCode })}>
          <SelectTrigger>
            <SelectValue placeholder="Select state…" />
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="ob-bank" label="Bank name" required error={errors.bankName}>
          <Input
            id="ob-bank"
            list="ob-bank-list"
            value={form.bankName}
            onChange={(e) => patch({ bankName: e.target.value })}
            placeholder="e.g. Maybank"
          />
          <datalist id="ob-bank-list">
            {MY_BANKS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </Field>
        <Field id="ob-account" label="Bank account number" required error={errors.bankAccount}>
          <Input
            id="ob-account"
            value={form.bankAccount}
            onChange={(e) => patch({ bankAccount: e.target.value })}
            placeholder="e.g. 1620 1234 5678"
            inputMode="numeric"
          />
        </Field>
      </div>

      <div className="space-y-4 rounded-xl border bg-stone-50/60 p-4 dark:bg-stone-900/30">
        <p className="text-sm font-medium">
          Statutory numbers{' '}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            optional — leave blank if you don&apos;t have them yet
          </span>
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field id="ob-epf" label="EPF / KWSP no." optional>
            <Input
              id="ob-epf"
              value={form.epfNo}
              onChange={(e) => patch({ epfNo: e.target.value })}
              placeholder="e.g. 12345678"
              inputMode="numeric"
            />
          </Field>
          <Field id="ob-socso" label="SOCSO no." optional>
            <Input
              id="ob-socso"
              value={form.socsoNo}
              onChange={(e) => patch({ socsoNo: e.target.value })}
              placeholder="Usually your NRIC"
            />
          </Field>
          <Field id="ob-tax" label="Income tax no. (LHDN)" optional>
            <Input
              id="ob-tax"
              value={form.taxNo}
              onChange={(e) => patch({ taxNo: e.target.value })}
              placeholder="e.g. SG 1234567890"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
