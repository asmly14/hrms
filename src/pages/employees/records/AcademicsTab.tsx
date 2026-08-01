/**
 * Academic qualifications tab — education history CRUD (SPM → PhD). At least
 * one entry is required for the completeness meter.
 */
import { useState } from 'react';
import { GraduationCap, Pencil, Plus } from 'lucide-react';
import { removeAcademic, saveAcademic, type AcademicRecord } from '@/lib/employeeRecords';
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
import { EmptyBlock, Field, RemoveButton, SectionCard, type TabProps } from './shared';

const LEVELS = ['SPM', 'STPM', 'Certificate', 'Diploma', 'Degree', 'Masters', 'PhD', 'Professional'];

const emptyForm = { level: 'Degree', institution: '', course: '', fromYear: '', toYear: '', grade: '' };

export default function AcademicsTab({ employee, file, readOnly, actorName }: TabProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AcademicRecord | null>(null);
  const [form, setForm] = useState(emptyForm);

  const academics = [...(file?.academics ?? [])].sort((a, b) => b.toYear - a.toYear);

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  };
  const openEdit = (a: AcademicRecord) => {
    setEditing(a);
    setForm({
      level: a.level,
      institution: a.institution,
      course: a.course,
      fromYear: String(a.fromYear),
      toYear: String(a.toYear),
      grade: a.grade ?? '',
    });
    setOpen(true);
  };

  const submit = () => {
    const fromYear = Number(form.fromYear);
    const toYear = Number(form.toYear);
    if (!form.institution.trim() || !form.course.trim()) return;
    if (!Number.isFinite(fromYear) || !Number.isFinite(toYear) || fromYear <= 0 || toYear < fromYear) return;
    saveAcademic(
      employee.id,
      {
        id: editing?.id,
        level: form.level,
        institution: form.institution.trim(),
        course: form.course.trim(),
        fromYear,
        toYear,
        grade: form.grade.trim() || undefined,
      },
      actorName,
    );
    setOpen(false);
  };

  if (academics.length === 0 && readOnly) {
    return (
      <EmptyBlock
        icon={GraduationCap}
        title="No academic records"
        description="Education history will appear here once HR records it."
      />
    );
  }

  return (
    <SectionCard
      title="Academic qualifications"
      icon={GraduationCap}
      description="Education history, highest first."
      actions={
        !readOnly && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1.5 h-4 w-4" /> Add qualification
          </Button>
        )
      }
    >
      {academics.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No academic records yet — add the highest qualification first.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {academics.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {a.course}
                  <Badge variant="outline" className="border-transparent bg-stone-100 text-stone-700">
                    {a.level}
                  </Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  {a.institution} · {a.fromYear} – {a.toYear}
                  {a.grade ? ` · ${a.grade}` : ''}
                </p>
              </div>
              {!readOnly && (
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    onClick={() => openEdit(a)}
                    aria-label={`Edit ${a.course}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <RemoveButton
                    label={`${a.level} — ${a.institution}`}
                    onConfirm={() => removeAcademic(employee.id, a.id, `${a.level} — ${a.institution}`, actorName)}
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
            <DialogTitle>{editing ? 'Edit qualification' : 'Add qualification'}</DialogTitle>
            <DialogDescription>Formal education and professional certifications.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Level">
              <Select value={form.level} onValueChange={(v) => setForm({ ...form, level: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Institution *">
              <Input
                value={form.institution}
                onChange={(e) => setForm({ ...form, institution: e.target.value })}
              />
            </Field>
            <Field label="Course / field *" className="sm:col-span-2">
              <Input value={form.course} onChange={(e) => setForm({ ...form, course: e.target.value })} />
            </Field>
            <Field label="From year *">
              <Input
                inputMode="numeric"
                placeholder="2008"
                value={form.fromYear}
                onChange={(e) => setForm({ ...form, fromYear: e.target.value })}
              />
            </Field>
            <Field label="To year *">
              <Input
                inputMode="numeric"
                placeholder="2012"
                value={form.toYear}
                onChange={(e) => setForm({ ...form, toYear: e.target.value })}
              />
            </Field>
            <Field label="Grade / CGPA" className="sm:col-span-2">
              <Input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={
                !form.institution.trim() ||
                !form.course.trim() ||
                !Number(form.fromYear) ||
                !Number(form.toYear) ||
                Number(form.toYear) < Number(form.fromYear)
              }
              onClick={submit}
            >
              {editing ? 'Save changes' : 'Add qualification'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
