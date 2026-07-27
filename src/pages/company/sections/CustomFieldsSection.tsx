/**
 * Company Setup → Custom fields builder: CRUD for `config.customFields`
 * (employee-scoped). Fields defined here are rendered by the Employees
 * module — an "Additional information" section in the add/edit dialog and a
 * card on the employee detail profile tab. Values live on the employee
 * record under `custom` (keyed by field id).
 */
import { useState, type FormEvent } from 'react';
import { ListPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { uid } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, SectionCard } from '../../settings/shared';
import { getEmployeeCustomFields, type EmployeeCustomField } from '../customFields';
import { useCompanySetup } from '../store';

type FieldType = EmployeeCustomField['type'];

const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Dropdown (select)',
};

interface FieldDraft {
  label: string;
  type: FieldType;
  options: string; // comma-separated, only for select
  required: boolean;
}

const EMPTY_DRAFT: FieldDraft = { label: '', type: 'text', options: '', required: false };

export default function CustomFieldsSection() {
  const { company, save } = useCompanySetup();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EmployeeCustomField | null>(null);
  const [deleting, setDeleting] = useState<EmployeeCustomField | null>(null);
  const [draft, setDraft] = useState<FieldDraft>(EMPTY_DRAFT);

  const fields = getEmployeeCustomFields(company);

  const openAdd = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setDialogOpen(true);
  };
  const openEdit = (f: EmployeeCustomField) => {
    setEditing(f);
    setDraft({
      label: f.label,
      type: f.type,
      options: (f.options ?? []).join(', '),
      required: Boolean(f.required),
    });
    setDialogOpen(true);
  };

  const optionList = draft.options
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  const labelValid = draft.label.trim().length > 0;
  const optionsValid = draft.type !== 'select' || optionList.length >= 2;
  const valid = labelValid && optionsValid;

  const persist = (next: EmployeeCustomField[], detail: string) => {
    save((c) => ({ ...c, config: { ...c.config, customFields: next } }), detail);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const base: EmployeeCustomField = {
      id: editing?.id ?? uid(),
      label: draft.label.trim(),
      type: draft.type,
      appliesTo: 'employee',
      ...(draft.type === 'select' ? { options: optionList } : {}),
      ...(draft.required ? { required: true } : {}),
    };
    if (editing) {
      persist(
        fields.map((f) => (f.id === editing.id ? base : f)),
        `Custom field updated (${base.label})`,
      );
    } else {
      persist([...fields, base], `Custom field added (${base.label})`);
    }
    setDialogOpen(false);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    persist(
      fields.filter((f) => f.id !== deleting.id),
      `Custom field removed (${deleting.label})`,
    );
    setDeleting(null);
  };

  if (!company) {
    return (
      <SectionCard icon={ListPlus} title="Custom fields" description="Loading custom fields…">
        <Skeleton className="h-32 w-full rounded-lg" />
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      <SectionCard
        icon={ListPlus}
        title="Custom employee fields"
        description={`${fields.length} custom field${fields.length === 1 ? '' : 's'} defined for ${company.name}. Rendered as “Additional information” in the employee form and on the profile tab; values are stored on each employee record.`}
        action={
          <Button size="sm" onClick={openAdd}>
            <Plus className="mr-1.5 h-4 w-4" /> Add field
          </Button>
        }
      >
        {fields.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No custom fields yet — add one to capture company-specific data (e.g. uniform size, parking bay,
            emergency contact) on every employee record.
          </p>
        ) : (
          <div className="space-y-2">
            {fields.map((f) => (
              <div key={f.id} className="flex items-center gap-3 rounded-xl border p-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{f.label}</p>
                    <Badge variant="secondary">{TYPE_LABEL[f.type]}</Badge>
                    {f.required ? (
                      <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800">
                        Required
                      </Badge>
                    ) : null}
                  </div>
                  {f.type === 'select' && f.options ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      Options: {f.options.join(' · ')}
                    </p>
                  ) : null}
                </div>
                <Button variant="ghost" size="icon" aria-label={`Edit ${f.label}`} onClick={() => openEdit(f)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Delete ${f.label}`} onClick={() => setDeleting(f)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{editing ? 'Edit field' : 'Add field'}</DialogTitle>
                <DialogDescription>
                  Applies to employee records of {company.name}. Renaming a label keeps stored values (keyed by field
                  id); changing the type may make old values display oddly.
                </DialogDescription>
              </DialogHeader>
              <Field label="Field label">
                <Input
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  placeholder="e.g. Emergency contact"
                />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Type">
                  <Select value={draft.type} onValueChange={(v) => setDraft({ ...draft, type: v as FieldType })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => (
                        <SelectItem key={t} value={t}>
                          {TYPE_LABEL[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex items-end pb-1">
                  <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
                    <Checkbox
                      checked={draft.required}
                      onCheckedChange={(v) => setDraft({ ...draft, required: v === true })}
                    />
                    Required on the employee form
                  </Label>
                </div>
              </div>
              {draft.type === 'select' ? (
                <Field label="Options" hint="Comma-separated, at least two — e.g. Small, Medium, Large.">
                  <Input
                    value={draft.options}
                    onChange={(e) => setDraft({ ...draft, options: e.target.value })}
                    placeholder="Small, Medium, Large"
                  />
                </Field>
              ) : null}
              {!labelValid ? <p className="text-xs text-destructive">A label is required.</p> : null}
              {!optionsValid ? (
                <p className="text-xs text-destructive">Dropdown fields need at least two options.</p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!valid}>
                  {editing ? 'Save changes' : 'Add field'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {deleting?.label}?</AlertDialogTitle>
              <AlertDialogDescription>
                The field disappears from employee forms. Values already stored on employee records are kept but no
                longer shown.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SectionCard>
    </div>
  );
}
