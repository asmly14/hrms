/**
 * Dependents tab — family members CRUD with the PCB child-relief hint:
 * the number of isChild dependents is compared against Employee.children
 * (the count used for PCB RM2,000-per-child relief) and a badge nudges HR
 * to sync when they disagree.
 */
import { useState } from 'react';
import { Baby, Pencil, Plus, Users } from 'lucide-react';
import {
  childReliefHint,
  removeDependent,
  saveDependent,
  type Dependent,
} from '@/lib/employeeRecords';
import { fmtDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyBlock, Field, RemoveButton, SectionCard, type TabProps } from './shared';

const emptyForm = {
  name: '',
  relation: '',
  dob: '',
  ic: '',
  isChild: false,
  occupation: '',
};

export default function DependentsTab({ employee, file, readOnly, actorName }: TabProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Dependent | null>(null);
  const [form, setForm] = useState(emptyForm);

  const dependents = file?.dependents ?? [];
  const hint = childReliefHint(employee, file);

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  };
  const openEdit = (d: Dependent) => {
    setEditing(d);
    setForm({
      name: d.name,
      relation: d.relation,
      dob: d.dob ?? '',
      ic: d.ic ?? '',
      isChild: d.isChild,
      occupation: d.occupation ?? '',
    });
    setOpen(true);
  };

  const submit = () => {
    if (!form.name.trim() || !form.relation.trim()) return;
    saveDependent(
      employee.id,
      {
        id: editing?.id,
        name: form.name.trim(),
        relation: form.relation.trim(),
        dob: form.dob || undefined,
        ic: form.ic.trim() || undefined,
        isChild: form.isChild,
        occupation: form.occupation.trim() || undefined,
      },
      actorName,
    );
    setOpen(false);
  };

  if (dependents.length === 0 && readOnly) {
    return (
      <EmptyBlock
        icon={Users}
        title="No dependents recorded"
        description="Family members and dependents will appear here once HR records them."
      />
    );
  }

  return (
    <SectionCard
      title="Dependents"
      icon={Users}
      description="Spouse, children and other dependents — children drive the PCB relief hint."
      actions={
        !readOnly && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1.5 h-4 w-4" /> Add dependent
          </Button>
        )
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={
            hint.mismatch
              ? 'border-transparent bg-amber-100 text-amber-800'
              : 'border-transparent bg-lime-100 text-lime-800'
          }
        >
          <Baby className="mr-1 h-3.5 w-3.5" />
          {hint.fileChildren} child{hint.fileChildren === 1 ? '' : 'ren'} on file · PCB relief count:{' '}
          {hint.employeeChildren}
        </Badge>
        {hint.mismatch && (
          <span className="text-xs text-amber-700">
            Child count differs from the Employee record (PCB relief) — ask HR to sync.
          </span>
        )}
      </div>

      {dependents.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No dependents yet — add spouse, children or parents for the personnel file.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {dependents.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {d.name}
                  {d.isChild && (
                    <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800">
                      Child · PCB relief
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {d.relation}
                  {d.dob ? ` · born ${fmtDate(d.dob)}` : ''}
                  {d.occupation ? ` · ${d.occupation}` : ''}
                  {d.ic ? ` · ${d.ic}` : ''}
                </p>
              </div>
              {!readOnly && (
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    onClick={() => openEdit(d)}
                    aria-label={`Edit ${d.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <RemoveButton label={d.name} onConfirm={() => removeDependent(employee.id, d.id, d.name, actorName)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit dependent' : 'Add dependent'}</DialogTitle>
            <DialogDescription>
              Tick “Child” for children claimed under the PCB RM2,000-per-child relief.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Full name *">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Relation *">
              <Input
                placeholder="Spouse / Daughter / Mother…"
                value={form.relation}
                onChange={(e) => setForm({ ...form, relation: e.target.value })}
              />
            </Field>
            <Field label="Date of birth">
              <Input type="date" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} />
            </Field>
            <Field label="NRIC / birth cert no.">
              <Input value={form.ic} onChange={(e) => setForm({ ...form, ic: e.target.value })} />
            </Field>
            <Field label="Occupation">
              <Input value={form.occupation} onChange={(e) => setForm({ ...form, occupation: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <Checkbox
                checked={form.isChild}
                onCheckedChange={(v) => setForm({ ...form, isChild: v === true })}
              />
              Child (PCB relief)
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={!form.name.trim() || !form.relation.trim()}
              onClick={submit}
            >
              {editing ? 'Save changes' : 'Add dependent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
