/**
 * Discipline & warnings tab — issue records (verbal / written / show-cause /
 * suspension) with an acknowledgement flow: HR stamps the record once the
 * employee has seen and acknowledged it.
 */
import { useState } from 'react';
import { BadgeCheck, Gavel, Pencil, Plus } from 'lucide-react';
import {
  DISCIPLINE_TYPE_LABELS,
  acknowledgeDiscipline,
  removeDiscipline,
  saveDiscipline,
  todayISO,
  type DisciplineRecord,
  type DisciplineType,
} from '@/lib/employeeRecords';
import { cn, fmtDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { EmptyBlock, Field, RemoveButton, SectionCard, type TabProps } from './shared';

const TYPE_BADGE: Record<DisciplineType, string> = {
  'verbal-warning': 'bg-stone-100 text-stone-700',
  'written-warning': 'bg-amber-100 text-amber-800',
  'show-cause': 'bg-orange-100 text-orange-800',
  suspension: 'bg-red-100 text-red-800',
  other: 'bg-stone-100 text-stone-600',
};

export default function DisciplineTab({ employee, file, readOnly, actorName }: TabProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DisciplineRecord | null>(null);
  const [form, setForm] = useState({
    date: todayISO(),
    type: 'verbal-warning' as DisciplineType,
    subject: '',
    detail: '',
  });

  const records = [...(file?.discipline ?? [])].sort((a, b) => b.date.localeCompare(a.date));

  const openAdd = () => {
    setEditing(null);
    setForm({ date: todayISO(), type: 'verbal-warning', subject: '', detail: '' });
    setOpen(true);
  };
  const openEdit = (d: DisciplineRecord) => {
    setEditing(d);
    setForm({ date: d.date, type: d.type, subject: d.subject, detail: d.detail });
    setOpen(true);
  };

  const submit = () => {
    if (!form.subject.trim() || !form.detail.trim() || !form.date) return;
    saveDiscipline(
      employee.id,
      {
        id: editing?.id,
        date: form.date,
        type: form.type,
        subject: form.subject.trim(),
        detail: form.detail.trim(),
        issuedBy: editing?.issuedBy ?? actorName,
        acknowledgedAt: editing?.acknowledgedAt,
      },
      actorName,
    );
    setOpen(false);
  };

  if (records.length === 0 && readOnly) {
    return (
      <EmptyBlock
        icon={Gavel}
        title="Clean disciplinary record"
        description="No warnings or show-cause letters on file."
      />
    );
  }

  return (
    <SectionCard
      title="Discipline & warnings"
      icon={Gavel}
      description="Warnings, show-cause letters and suspensions — with employee acknowledgement."
      actions={
        !readOnly && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1.5 h-4 w-4" /> Issue record
          </Button>
        )
      }
    >
      {records.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Clean record — nothing issued so far.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {records.map((d) => (
            <li key={d.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {d.subject}
                  <Badge variant="outline" className={cn('border-transparent', TYPE_BADGE[d.type])}>
                    {DISCIPLINE_TYPE_LABELS[d.type]}
                  </Badge>
                  {d.acknowledgedAt ? (
                    <Badge variant="outline" className="border-transparent bg-lime-100 text-lime-800">
                      <BadgeCheck className="mr-1 h-3.5 w-3.5" />
                      Acknowledged {fmtDate(d.acknowledgedAt)}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-transparent bg-stone-100 text-stone-600">
                      Awaiting acknowledgement
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {fmtDate(d.date)} · issued by {d.issuedBy}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{d.detail}</p>
              </div>
              {!readOnly && (
                <div className="flex shrink-0 items-center">
                  {!d.acknowledgedAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mr-1 h-8 text-xs"
                      onClick={() => acknowledgeDiscipline(employee.id, d.id, actorName)}
                    >
                      Mark acknowledged
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    onClick={() => openEdit(d)}
                    aria-label={`Edit ${d.subject}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <RemoveButton
                    label={d.subject}
                    onConfirm={() => removeDiscipline(employee.id, d.id, d.subject, actorName)}
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
            <DialogTitle>{editing ? 'Edit record' : 'Issue disciplinary record'}</DialogTitle>
            <DialogDescription>
              Document the incident formally — the employee acknowledges receipt afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Date *">
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </Field>
            <Field label="Type">
              <Select
                value={form.type}
                onValueChange={(v) => setForm({ ...form, type: v as DisciplineType })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(DISCIPLINE_TYPE_LABELS) as DisciplineType[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {DISCIPLINE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Subject *" className="sm:col-span-2">
              <Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
            </Field>
            <Field label="Details *" className="sm:col-span-2">
              <Textarea rows={3} value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={!form.subject.trim() || !form.detail.trim() || !form.date}
              onClick={submit}
            >
              {editing ? 'Save changes' : 'Issue record'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
