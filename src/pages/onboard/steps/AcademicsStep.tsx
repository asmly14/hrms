/**
 * Step 4 — Academic qualifications (repeatable rows: level / institution /
 * course / years / optional grade). At least one entry is required.
 */
import { Plus, Trash2 } from 'lucide-react';
import { ACADEMIC_LEVELS, type AcademicEntry } from '@/lib/onboardLinks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, StepIntro } from '../fields';
import { emptyAcademic, type FormErrors, type OnboardFormState } from '../formState';

interface Props {
  form: OnboardFormState;
  patch: (p: Partial<OnboardFormState>) => void;
  errors: FormErrors;
}

export default function AcademicsStep({ form, patch, errors }: Props) {
  const updateRow = (i: number, key: keyof AcademicEntry, value: string) => {
    patch({
      academics: form.academics.map((a, idx) => (idx === i ? { ...a, [key]: value } : a)),
    });
  };
  const addRow = () => patch({ academics: [...form.academics, emptyAcademic()] });
  const removeRow = (i: number) => patch({ academics: form.academics.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-5">
      <StepIntro title="Academic qualifications">
        List your highest qualifications first — SPM/STPM, certificates, diplomas, degrees and above.
      </StepIntro>

      {errors.academics && (
        <p className="text-xs text-red-600 dark:text-red-400">{errors.academics}</p>
      )}

      <div className="space-y-4">
        {form.academics.map((a, i) => (
          <div key={i} className="space-y-3 rounded-xl border p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Qualification {i + 1}</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeRow(i)}
                className="text-red-600 hover:text-red-700"
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Level" required>
                <Select value={a.level} onValueChange={(v) => updateRow(i, 'level', v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACADEMIC_LEVELS.map((lvl) => (
                      <SelectItem key={lvl} value={lvl}>
                        {lvl}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Institution" required error={errors[`ac-institution-${i}`]}>
                <Input
                  value={a.institution}
                  onChange={(e) => updateRow(i, 'institution', e.target.value)}
                  placeholder="e.g. Universiti Malaya"
                />
              </Field>
            </div>

            <Field label="Course / field of study" required error={errors[`ac-course-${i}`]}>
              <Input
                value={a.course}
                onChange={(e) => updateRow(i, 'course', e.target.value)}
                placeholder="e.g. BSc (Hons) Computer Science"
              />
            </Field>

            <div className="grid grid-cols-3 gap-3">
              <Field label="From year" required error={errors[`ac-from-${i}`]}>
                <Input
                  value={a.fromYear}
                  onChange={(e) => updateRow(i, 'fromYear', e.target.value)}
                  placeholder="2019"
                  inputMode="numeric"
                  maxLength={4}
                />
              </Field>
              <Field label="To year" required error={errors[`ac-to-${i}`]}>
                <Input
                  value={a.toYear}
                  onChange={(e) => updateRow(i, 'toYear', e.target.value)}
                  placeholder="2023"
                  inputMode="numeric"
                  maxLength={4}
                />
              </Field>
              <Field label="Grade / CGPA" optional>
                <Input
                  value={a.grade ?? ''}
                  onChange={(e) => updateRow(i, 'grade', e.target.value)}
                  placeholder="3.75"
                />
              </Field>
            </div>
          </div>
        ))}
      </div>

      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus className="mr-1.5 h-4 w-4" /> Add qualification
      </Button>
    </div>
  );
}
