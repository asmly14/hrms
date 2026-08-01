/**
 * Read-only review of an applicant submission — every captured field,
 * academics table, emergency contacts and the uploaded documents (image
 * previews inline, other files downloadable). Approve hands off to the
 * ApproveSubmissionDialog; Reject asks for a reason inline and re-opens the
 * link for the applicant to resubmit.
 */
import { useEffect, useState } from 'react';
import { Download, FileText, ThumbsDown, ThumbsUp } from 'lucide-react';
import {
  rejectSubmission,
  type OnboardSubmission,
} from '@/lib/onboardLinks';
import { stateInfo } from '@/lib/holidays';
import type { Department, Position, StateCode } from '@/lib/types';
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
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="break-words text-right font-medium">{value?.trim() ? value : '—'}</dd>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

interface Props {
  submission: OnboardSubmission | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actorName: string;
  positions: Position[];
  departments: Department[];
  /** Open the approve dialog for this submission. */
  onApproveRequest: (submission: OnboardSubmission) => void;
}

export default function SubmissionReviewDialog({
  submission,
  open,
  onOpenChange,
  actorName,
  positions,
  departments,
  onApproveRequest,
}: Props) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) {
      setRejecting(false);
      setReason('');
    }
  }, [open]);

  if (!submission) return null;

  const p = submission.personal;
  const positionTitle =
    positions.find((x) => x.id === submission.employment.positionId)?.title ?? '—';
  const departmentName =
    departments.find((x) => x.id === submission.employment.departmentId)?.name ?? '—';
  const pending = submission.reviewStatus !== 'approved' && submission.reviewStatus !== 'rejected';

  const confirmReject = () => {
    if (!reason.trim()) return;
    rejectSubmission(submission, reason, actorName);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {p.name}
            {submission.reviewStatus === 'approved' && <Badge>Approved</Badge>}
            {submission.reviewStatus === 'rejected' && (
              <Badge variant="destructive">Returned</Badge>
            )}
            {pending && <Badge variant="secondary">Pending review</Badge>}
          </DialogTitle>
          <DialogDescription>
            Submitted {submission.submittedAt.slice(0, 10)} · {submission.documents.length}{' '}
            document(s)
            {submission.reviewedBy
              ? ` · reviewed by ${submission.reviewedBy} on ${submission.reviewedAt?.slice(0, 10)}`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <SectionTitle>Personal</SectionTitle>
          <dl className="divide-y divide-border/60">
            <Row label="NRIC" value={p.ic} />
            <Row label="Date of birth" value={p.dob} />
            <Row label="Gender" value={p.gender} />
            <Row label="Marital status" value={p.maritalStatus} />
            <Row label="Nationality" value={p.nationality} />
            <Row label="Phone" value={p.phone} />
            <Row label="Email" value={p.email} />
            <Row label="Address" value={p.address} />
            <Row label="State" value={p.state ? stateInfo(p.state as StateCode).name : '—'} />
          </dl>

          <SectionTitle>Bank & statutory</SectionTitle>
          <dl className="divide-y divide-border/60">
            <Row label="Bank" value={p.bankName} />
            <Row label="Account no." value={p.bankAccount} />
            <Row label="EPF no." value={p.epfNo} />
            <Row label="SOCSO no." value={p.socsoNo} />
            <Row label="Tax no." value={p.taxNo} />
          </dl>

          <SectionTitle>Employment</SectionTitle>
          <dl className="divide-y divide-border/60">
            <Row label="Position" value={positionTitle} />
            <Row label="Department" value={departmentName} />
            <Row label="Expected start" value={submission.employment.joinDate} />
            <Row label="Type" value={submission.employment.employmentType} />
          </dl>

          <SectionTitle>Emergency contacts</SectionTitle>
          {submission.emergencyContacts.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">None provided.</p>
          ) : (
            <ul className="space-y-1 py-1 text-sm">
              {submission.emergencyContacts.map((c, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-muted-foreground">
                    {c.relation} · {c.phone}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <SectionTitle>Academic qualifications</SectionTitle>
          {submission.academics.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">None provided.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Level</TableHead>
                  <TableHead>Institution</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>Years</TableHead>
                  <TableHead>Grade</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {submission.academics.map((a, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{a.level}</TableCell>
                    <TableCell>{a.institution}</TableCell>
                    <TableCell>{a.course}</TableCell>
                    <TableCell>
                      {a.fromYear}–{a.toYear}
                    </TableCell>
                    <TableCell>{a.grade || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <SectionTitle>Documents</SectionTitle>
          {submission.documents.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">No documents uploaded.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 py-1 sm:grid-cols-2">
              {submission.documents.map((d, i) => (
                <li key={i} className="flex items-center gap-3 rounded-xl border p-2.5">
                  {d.dataUrl?.startsWith('data:image') ? (
                    <a href={d.dataUrl} target="_blank" rel="noopener noreferrer">
                      <img
                        src={d.dataUrl}
                        alt={d.fileName}
                        className="h-12 w-12 rounded-lg object-cover"
                      />
                    </a>
                  ) : (
                    <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-stone-100 dark:bg-stone-800">
                      <FileText className="h-5 w-5 text-muted-foreground" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{d.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.kind} · {fmtSize(d.sizeBytes)}
                    </p>
                  </div>
                  {d.dataUrl && (
                    <Button asChild variant="ghost" size="sm">
                      <a href={d.dataUrl} download={d.fileName} title="Download">
                        <Download className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <SectionTitle>Declaration</SectionTitle>
          <p className="py-1 text-sm">
            {submission.declarationAccepted
              ? 'Accepted — applicant declared the information true and consented to PDPA processing.'
              : 'Not accepted.'}
          </p>
          {submission.reviewNotes && (
            <p className="rounded-lg bg-stone-100 p-3 text-xs text-muted-foreground dark:bg-stone-900/60">
              Review note: {submission.reviewNotes}
            </p>
          )}
        </div>

        {rejecting && (
          <div className="grid gap-2 rounded-xl border border-red-200 bg-red-50/60 p-3 dark:border-red-900/50 dark:bg-red-950/20">
            <Label htmlFor="rj-reason" className="text-sm">
              Reason for returning this submission
            </Label>
            <Textarea
              id="rj-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. IC copy is blurry — please re-upload a clearer scan"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              The link re-opens so the applicant can correct and resubmit.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          {!pending ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : rejecting ? (
            <>
              <Button variant="outline" onClick={() => setRejecting(false)}>
                Back
              </Button>
              <Button variant="destructive" onClick={confirmReject} disabled={!reason.trim()}>
                Confirm rejection
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setRejecting(true)}>
                <ThumbsDown className="mr-1.5 h-4 w-4" /> Reject
              </Button>
              <Button
                onClick={() => onApproveRequest(submission)}
                className="bg-amber-600 text-white hover:bg-amber-700"
              >
                <ThumbsUp className="mr-1.5 h-4 w-4" /> Approve &amp; create employee
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
