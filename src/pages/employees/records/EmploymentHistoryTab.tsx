/**
 * Previous employment tab — work history before joining the company (TP3 /
 * reference-check territory).
 */
import { useState } from 'react';
import { Briefcase, Pencil, Plus } from 'lucide-react';
import {
  removePreviousEmployment,
  savePreviousEmployment,
  type PreviousEmployment,
} from '@/lib/employeeRecords';
import { fmtDate } from '@/lib/utils';
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
import { Textarea } from '@/components/ui/textarea';
import { EmptyBlock, Field, RemoveButton, SectionCard, type TabProps } from './shared';

const emptyForm = { company: '', role: '', from: '', to: '', reasonForLeaving: '' };

export default function EmploymentHistoryTab({ employee, file, readOnly, actorName }: TabProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PreviousEmployment | null>(null);
  const [form, setForm] = useState(emptyForm);

  const history = [...(file?.previousEmployment ?? [])].sort((a, b) => b.to.localeCompare(a.to));

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  };
  const openEdit = (p: PreviousEmployment) => {
    setEditing(p);
    setForm({
      company: p.company,
      role: p.role,
      from: p.from,
      to: p.to,
      reasonForLeaving: p.reasonForLeaving ?? '',
    });
    setOpen(true);
  };

  const submit = () => {
    if (!form.company.trim() || !form.role.trim() || !form.from || !form.to) return;
    savePreviousEmployment(
      employee.id,
      {
        id: editing?.id,
        company: form.company.trim(),
        role: form.role.trim(),
        from: form.from,
        to: form.to,
        reasonForLeaving: form.reasonForLeaving.trim() || undefined,
      },
      actorName,
    );
    setOpen(false);
  };

  if (history.length === 0 && readOnly) {
    return (
      <EmptyBlock
        icon={Briefcase}
        title="No previous employment"
        description="Prior work history will appear here once HR records it."
      />
    );
  }

  return (
    <SectionCard
      title="Previous employment"
      icon={Briefcase}
      description="Work history before joining, most recent first."
      actions={
        !readOnly && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1.5 h-4 w-4" /> Add employment
          </Button>
        )
      }
    >
      {history.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No previous employment recorded.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {history.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {p.role} · {p.company}
                </p>
                <p className="text-xs text-muted-foreground">
                  {fmtDate(p.from)} – {fmtDate(p.to)}
                  {p.reasonForLeaving ? ` · left: ${p.reasonForLeaving}` : ''}
                </p>
              </div>
              {!readOnly && (
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    onClick={() => openEdit(p)}
                    aria-label={`Edit ${p.company}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <RemoveButton
                    label={`${p.role} @ ${p.company}`}
                    onConfirm={() =>
                      removePreviousEmployment(employee.id, p.id, `${p.role} @ ${p.company}`, actorName)
                    }
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
            <DialogTitle>{editing ? 'Edit employment' : 'Add previous employment'}</DialogTitle>
            <DialogDescription>Prior employer, role and dates.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Company *">
              <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
            </Field>
            <Field label="Role / title *">
              <Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
            </Field>
            <Field label="From *">
              <Input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
            </Field>
            <Field label="To *">
              <Input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
            </Field>
            <Field label="Reason for leaving" className="sm:col-span-2">
              <Textarea
                rows={2}
                value={form.reasonForLeaving}
                onChange={(e) => setForm({ ...form, reasonForLeaving: e.target.value })}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={!form.company.trim() || !form.role.trim() || !form.from || !form.to}
              onClick={submit}
            >
              {editing ? 'Save changes' : 'Add employment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
