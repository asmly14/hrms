/**
 * Step 1 — Personal details + employment context (position/department may be
 * preset by the invite link; join date & employment type are always asked).
 */
import type { OnboardLink } from '@/lib/onboardLinks';
import { normalizeIc } from '@/lib/onboardLinks';
import type { Department, Position } from '@/lib/types';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, StepIntro } from '../fields';
import type { FormErrors, OnboardFormState } from '../formState';

interface Props {
  form: OnboardFormState;
  patch: (p: Partial<OnboardFormState>) => void;
  errors: FormErrors;
  link: OnboardLink;
  positions: Position[];
  departments: Department[];
}

export default function PersonalStep({
  form,
  patch,
  errors,
  link,
  positions,
  departments,
}: Props) {
  const presetPosition = link.positionId
    ? positions.find((p) => p.id === link.positionId)
    : undefined;
  const presetDepartment = link.departmentId
    ? departments.find((d) => d.id === link.departmentId)
    : undefined;

  return (
    <div className="space-y-5">
      <StepIntro title="Personal details">Tell us who you are, exactly as per your NRIC.</StepIntro>

      <Field id="ob-name" label="Full name (as per NRIC)" required error={errors.name}>
        <Input
          id="ob-name"
          value={form.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="e.g. Aisyah binti Rahman"
          autoComplete="name"
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="ob-ic" label="NRIC number" required error={errors.ic}>
          <Input
            id="ob-ic"
            value={form.ic}
            onChange={(e) => patch({ ic: e.target.value })}
            onBlur={() => patch({ ic: normalizeIc(form.ic) })}
            placeholder="900101-14-5566"
            inputMode="numeric"
          />
        </Field>
        <Field id="ob-dob" label="Date of birth" required error={errors.dob}>
          <Input
            id="ob-dob"
            type="date"
            value={form.dob}
            onChange={(e) => patch({ dob: e.target.value })}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Gender" required error={errors.gender}>
          <Select
            value={form.gender}
            onValueChange={(v) => patch({ gender: v as OnboardFormState['gender'] })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="male">Male</SelectItem>
              <SelectItem value="female">Female</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Marital status" required error={errors.maritalStatus}>
          <Select
            value={form.maritalStatus}
            onValueChange={(v) => patch({ maritalStatus: v as OnboardFormState['maritalStatus'] })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">Single</SelectItem>
              <SelectItem value="married">Married</SelectItem>
              <SelectItem value="divorced">Divorced</SelectItem>
              <SelectItem value="widowed">Widowed</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="ob-nationality" label="Nationality" required error={errors.nationality}>
          <Input
            id="ob-nationality"
            value={form.nationality}
            onChange={(e) => patch({ nationality: e.target.value })}
            placeholder="Malaysian"
          />
        </Field>
        <Field id="ob-phone" label="Mobile phone" required error={errors.phone}>
          <Input
            id="ob-phone"
            value={form.phone}
            onChange={(e) => patch({ phone: e.target.value })}
            placeholder="012-345 6789"
            inputMode="tel"
            autoComplete="tel"
          />
        </Field>
      </div>

      <Field id="ob-email" label="Email address" required error={errors.email}>
        <Input
          id="ob-email"
          type="email"
          value={form.email}
          onChange={(e) => patch({ email: e.target.value })}
          placeholder="you@example.com"
          autoComplete="email"
        />
      </Field>

      <div className="space-y-4 rounded-xl border bg-stone-50/60 p-4 dark:bg-stone-900/30">
        <p className="text-sm font-medium">Employment</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {presetPosition ? (
            <Field label="Position">
              <Input value={presetPosition.title} disabled readOnly />
            </Field>
          ) : (
            <Field label="Position" optional>
              <Select value={form.positionId} onValueChange={(v) => patch({ positionId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select position…" />
                </SelectTrigger>
                <SelectContent>
                  {positions.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {presetDepartment ? (
            <Field label="Department">
              <Input value={presetDepartment.name} disabled readOnly />
            </Field>
          ) : (
            <Field label="Department" optional>
              <Select value={form.departmentId} onValueChange={(v) => patch({ departmentId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select department…" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="ob-join" label="Expected start date" required error={errors.joinDate}>
            <Input
              id="ob-join"
              type="date"
              value={form.joinDate}
              onChange={(e) => patch({ joinDate: e.target.value })}
            />
          </Field>
          <Field label="Employment type" required error={errors.employmentType}>
            <Select
              value={form.employmentType}
              onValueChange={(v) =>
                patch({ employmentType: v as OnboardFormState['employmentType'] })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full-time">Full-time</SelectItem>
                <SelectItem value="part-time">Part-time</SelectItem>
                <SelectItem value="contract">Contract</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </div>
    </div>
  );
}
