/**
 * Emergency contacts tab — CRUD for next-of-kin contacts. At least one is
 * required for the completeness meter.
 */
import { useState } from 'react';
import { Pencil, PhoneCall, Plus } from 'lucide-react';
import {
  removeEmergencyContact,
  saveEmergencyContact,
  type EmergencyContact,
} from '@/lib/employeeRecords';
import { Button } from '@/components/ui/button';
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

const emptyForm = { name: '', relation: '', phone: '' };

export default function EmergencyContactsTab({ employee, file, readOnly, actorName }: TabProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EmergencyContact | null>(null);
  const [form, setForm] = useState(emptyForm);

  const contacts = file?.emergencyContacts ?? [];

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  };
  const openEdit = (c: EmergencyContact) => {
    setEditing(c);
    setForm({ name: c.name, relation: c.relation, phone: c.phone });
    setOpen(true);
  };

  const submit = () => {
    if (!form.name.trim() || !form.phone.trim()) return;
    saveEmergencyContact(
      employee.id,
      {
        id: editing?.id,
        name: form.name.trim(),
        relation: form.relation.trim(),
        phone: form.phone.trim(),
      },
      actorName,
    );
    setOpen(false);
  };

  if (contacts.length === 0 && readOnly) {
    return (
      <EmptyBlock
        icon={PhoneCall}
        title="No emergency contacts"
        description="Next-of-kin contact details will appear here once HR records them."
      />
    );
  }

  return (
    <SectionCard
      title="Emergency contacts"
      icon={PhoneCall}
      description="Who to call — at least one contact is needed for a complete file."
      actions={
        !readOnly && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1.5 h-4 w-4" /> Add contact
          </Button>
        )
      }
    >
      {contacts.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No emergency contacts yet — record at least one next-of-kin.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {contacts.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{c.name}</p>
                <p className="text-xs text-muted-foreground">
                  {c.relation || 'Contact'} ·{' '}
                  <a className="text-amber-700 hover:underline underline-offset-4" href={`tel:${c.phone}`}>
                    {c.phone}
                  </a>
                </p>
              </div>
              {!readOnly && (
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    onClick={() => openEdit(c)}
                    aria-label={`Edit ${c.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <RemoveButton
                    label={c.name}
                    onConfirm={() => removeEmergencyContact(employee.id, c.id, c.name, actorName)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit contact' : 'Add emergency contact'}</DialogTitle>
            <DialogDescription>Next-of-kin details for emergencies at work.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Full name *">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Relation">
              <Input
                placeholder="Spouse / Parent / Sibling…"
                value={form.relation}
                onChange={(e) => setForm({ ...form, relation: e.target.value })}
              />
            </Field>
            <Field label="Phone *" className="sm:col-span-2">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={!form.name.trim() || !form.phone.trim()}
              onClick={submit}
            >
              {editing ? 'Save changes' : 'Add contact'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
