/**
 * Approve submission → create employee. The portal does not collect salary,
 * so HR confirms the package + org placement here (prefilled from the
 * submission / invite link) before the record is materialized.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useCollection } from '@/lib/db';
import {
  approveSubmission,
  type OnboardSubmission,
} from '@/lib/onboardLinks';
import type { Department, EmploymentType, Position } from '@/lib/types';
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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  submission: OnboardSubmission | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actorName: string;
  /** Called with the created employee id after a successful approval. */
  onApproved?: (employeeId: string) => void;
}

export default function ApproveSubmissionDialog({
  submission,
  open,
  onOpenChange,
  actorName,
  onApproved,
}: Props) {
  const { items: positions } = useCollection<Position>('positions');
  const { items: departments } = useCollection<Department>('departments');

  const [baseSalary, setBaseSalary] = useState('');
  const [positionId, setPositionId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [joinDate, setJoinDate] = useState('');
  const [employmentType, setEmploymentType] = useState<EmploymentType>('full-time');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdInfo, setCreatedInfo] = useState<{ id: string; employeeNo?: string } | null>(null);

  useEffect(() => {
    if (open && submission) {
      setBaseSalary('');
      setPositionId(submission.employment.positionId ?? '');
      setDepartmentId(submission.employment.departmentId ?? '');
      setJoinDate(submission.employment.joinDate);
      setEmploymentType(submission.employment.employmentType);
      setNotes('');
      setError(null);
      setCreatedInfo(null);
    }
  }, [open, submission]);

  if (!submission) return null;

  const confirm = () => {
    const result = approveSubmission(submission, {
      baseSalary: Number(baseSalary),
      positionId,
      departmentId,
      joinDate,
      employmentType,
      reviewer: actorName,
      notes: notes.trim() || undefined,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreatedInfo({ id: result.employee.id, employeeNo: result.employee.employeeNo });
    onApproved?.(result.employee.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {createdInfo ? 'Employee created' : `Approve — ${submission.personal.name}`}
          </DialogTitle>
          <DialogDescription>
            {createdInfo
              ? 'The employee record, onboarding extras and checklist have been created.'
              : 'Confirm the package and org placement. The employee is created with Probation status.'}
          </DialogDescription>
        </DialogHeader>

        {createdInfo ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-lime-100 text-lime-700 dark:bg-lime-950/60 dark:text-lime-400">
              <CheckCircle2 className="h-6 w-6" />
            </span>
            <p className="text-sm">
              <span className="font-medium">{submission.personal.name}</span> is now an employee
              {createdInfo.employeeNo ? (
                <>
                  {' '}
                  with staff no. <span className="font-medium">{createdInfo.employeeNo}</span>
                </>
              ) : null}
              .
            </p>
            <p className="text-xs text-muted-foreground">
              An onboarding checklist was started — track it from the Checklists tab.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ap-salary">Base salary (RM / month)</Label>
                <Input
                  id="ap-salary"
                  type="number"
                  min={0}
                  step="0.01"
                  value={baseSalary}
                  onChange={(e) => setBaseSalary(e.target.value)}
                  placeholder="e.g. 3500"
                  autoFocus
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ap-join">Join date</Label>
                <Input
                  id="ap-join"
                  type="date"
                  value={joinDate}
                  onChange={(e) => setJoinDate(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Department</Label>
                <Select
                  value={departmentId}
                  onValueChange={(v) => {
                    setDepartmentId(v);
                    // Clear the position when it belongs to another department.
                    const pos = positions.find((p) => p.id === positionId);
                    if (pos && pos.departmentId !== v) setPositionId('');
                  }}
                >
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
              </div>
              <div className="grid gap-1.5">
                <Label>Position</Label>
                <Select value={positionId} onValueChange={setPositionId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select position…" />
                  </SelectTrigger>
                  <SelectContent>
                    {positions
                      .filter((p) => !departmentId || p.departmentId === departmentId)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.title}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Employment type</Label>
              <Select
                value={employmentType}
                onValueChange={(v) => setEmploymentType(v as EmploymentType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full-time">Full-time</SelectItem>
                  <SelectItem value="part-time">Part-time</SelectItem>
                  <SelectItem value="contract">Contract</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ap-notes">Review notes (optional)</Label>
              <Textarea
                id="ap-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Verified IC against original"
              />
            </div>
            {error && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {createdInfo ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={confirm}
                disabled={!baseSalary || !joinDate || !departmentId || !positionId}
                className="bg-amber-600 text-white hover:bg-amber-700"
              >
                Approve &amp; create employee
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
