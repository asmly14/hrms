/**
 * Step 3 — Emergency contacts (repeatable rows, at least one required).
 */
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, StepIntro } from '../fields';
import type { FormErrors, OnboardFormState } from '../formState';

interface Props {
  form: OnboardFormState;
  patch: (p: Partial<OnboardFormState>) => void;
  errors: FormErrors;
}

export default function EmergencyStep({ form, patch, errors }: Props) {
  const updateRow = (i: number, key: 'name' | 'relation' | 'phone', value: string) => {
    patch({
      emergencyContacts: form.emergencyContacts.map((c, idx) =>
        idx === i ? { ...c, [key]: value } : c,
      ),
    });
  };
  const addRow = () =>
    patch({ emergencyContacts: [...form.emergencyContacts, { name: '', relation: '', phone: '' }] });
  const removeRow = (i: number) =>
    patch({ emergencyContacts: form.emergencyContacts.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-5">
      <StepIntro title="Emergency contacts">
        Who should we call if something happens to you at work? Add at least one person.
      </StepIntro>

      {errors.emergency && (
        <p className="text-xs text-red-600 dark:text-red-400">{errors.emergency}</p>
      )}

      <div className="space-y-4">
        {form.emergencyContacts.map((c, i) => (
          <div key={i} className="space-y-3 rounded-xl border p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Contact {i + 1}</p>
              {form.emergencyContacts.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(i)}
                  className="text-red-600 hover:text-red-700"
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
                </Button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Name" required error={errors[`ec-name-${i}`]}>
                <Input
                  value={c.name}
                  onChange={(e) => updateRow(i, 'name', e.target.value)}
                  placeholder="e.g. Rahman bin Ali"
                />
              </Field>
              <Field label="Relationship" required error={errors[`ec-relation-${i}`]}>
                <Input
                  value={c.relation}
                  onChange={(e) => updateRow(i, 'relation', e.target.value)}
                  placeholder="e.g. Father / Spouse"
                />
              </Field>
              <Field label="Phone" required error={errors[`ec-phone-${i}`]}>
                <Input
                  value={c.phone}
                  onChange={(e) => updateRow(i, 'phone', e.target.value)}
                  placeholder="012-345 6789"
                  inputMode="tel"
                />
              </Field>
            </div>
          </div>
        ))}
      </div>

      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus className="mr-1.5 h-4 w-4" /> Add another contact
      </Button>
    </div>
  );
}
