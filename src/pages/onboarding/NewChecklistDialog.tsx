/**
 * New onboarding checklist dialog — pick hire, template, start date, buddy.
 * Preview of the template items is shown before creating.
 */
import { useMemo, useState } from 'react';
import type { Employee, Department } from '@/lib/types';
import { useCollection } from '@/lib/db';
import {
  ONBOARDING_TEMPLATES,
  auditLifecycle,
  buildOnboardingChecklist,
  useOnboardingChecklists,
} from '@/lib/lifecycle';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[];
  existingEmployeeIds: Set<string>;
  actorName: string;
}

export default function NewChecklistDialog({
  open,
  onOpenChange,
  employees,
  existingEmployeeIds,
  actorName,
}: Props) {
  const { add } = useOnboardingChecklists();
  const { items: departments } = useCollection<Department>('departments');

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [employeeId, setEmployeeId] = useState('');
  const [templateKey, setTemplateKey] = useState(ONBOARDING_TEMPLATES[0]!.key);
  const [startDate, setStartDate] = useState(today);
  const [buddyId, setBuddyId] = useState('none');

  const candidates = useMemo(
    () =>
      employees
        .filter((e) => e.status !== 'resigned' && !existingEmployeeIds.has(e.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employees, existingEmployeeIds],
  );

  const buddies = useMemo(
    () => employees.filter((e) => e.status === 'active' && e.id !== employeeId),
    [employees, employeeId],
  );

  const template = ONBOARDING_TEMPLATES.find((t) => t.key === templateKey)!;

  function deptName(e: Employee): string {
    return departments.find((d) => d.id === e.departmentId)?.name ?? '—';
  }

  function reset() {
    setEmployeeId('');
    setTemplateKey(ONBOARDING_TEMPLATES[0]!.key);
    setStartDate(today);
    setBuddyId('none');
  }

  function submit() {
    if (!employeeId || !startDate) return;
    const emp = employees.find((e) => e.id === employeeId);
    const payload = buildOnboardingChecklist(
      employeeId,
      templateKey,
      startDate,
      buddyId === 'none' ? undefined : buddyId,
    );
    const created = add(payload);
    auditLifecycle(
      'onboarding.create',
      created.id,
      `Onboarding checklist (${template.label}) started for ${emp?.name ?? employeeId}, start ${startDate}`,
      actorName,
    );
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start onboarding</DialogTitle>
          <DialogDescription>
            Generate a pre-boarding + first-weeks checklist for a new hire.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ob-emp">New hire</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger id="ob-emp">
                <SelectValue placeholder="Select employee…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.length === 0 && (
                  <SelectItem value="__none" disabled>
                    No eligible employees
                  </SelectItem>
                )}
                {candidates.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name} · {deptName(e)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ob-tpl">Template</Label>
              <Select value={templateKey} onValueChange={setTemplateKey}>
                <SelectTrigger id="ob-tpl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ONBOARDING_TEMPLATES.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ob-start">First working day</Label>
              <Input
                id="ob-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ob-buddy">Buddy (optional)</Label>
            <Select value={buddyId} onValueChange={setBuddyId}>
              <SelectTrigger id="ob-buddy">
                <SelectValue placeholder="Assign a buddy…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No buddy</SelectItem>
                {buddies.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 text-xs text-muted-foreground dark:border-amber-900/40 dark:bg-amber-950/20">
            <span className="font-medium text-foreground">{template.label}</span> —{' '}
            {template.description} Includes {template.items.length} items across documents, IT &amp;
            assets, access, orientation and compliance.
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!employeeId || !startDate}
            className="bg-amber-600 text-white hover:bg-amber-700"
          >
            Create checklist
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
