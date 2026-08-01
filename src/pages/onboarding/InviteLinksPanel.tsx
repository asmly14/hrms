/**
 * Invite links tab — generate shareable onboarding links, track their
 * lifecycle (active → submitted → approved / expired / revoked), review
 * submissions and approve them into employee records.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Eye, Link2, Mail, MessageCircle, Plus, XCircle } from 'lucide-react';
import { useCollection, getActiveTenantId } from '@/lib/db';
import {
  ONBOARD_LINK_STATUS_LABELS,
  buildOnboardUrl,
  effectiveLinkStatus,
  revokeOnboardLink,
  sweepExpiredLinks,
  useOnboardLinks,
  useOnboardSubmissions,
  type OnboardLink,
  type OnboardSubmission,
} from '@/lib/onboardLinks';
import type { Department, Position } from '@/lib/types';
import { fmtDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import GenerateLinkDialog from './GenerateLinkDialog';
import SubmissionReviewDialog from './SubmissionReviewDialog';
import ApproveSubmissionDialog from './ApproveSubmissionDialog';
import { copyText, mailtoShareUrl, whatsAppShareUrl } from './linkShare';

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'active') return 'secondary';
  if (status === 'submitted') return 'default';
  if (status === 'approved') return 'outline';
  return 'destructive'; // expired / revoked
}

interface Props {
  actorName: string;
}

export default function InviteLinksPanel({ actorName }: Props) {
  const { items: links } = useOnboardLinks();
  const { items: submissions } = useOnboardSubmissions();
  const { items: positions } = useCollection<Position>('positions');
  const { items: departments } = useCollection<Department>('departments');

  const [generateOpen, setGenerateOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<OnboardSubmission | null>(null);
  const [approveTarget, setApproveTarget] = useState<OnboardSubmission | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<OnboardLink | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Persist time-based expiry transitions once per mount.
  useEffect(() => {
    sweepExpiredLinks();
  }, []);

  const sorted = useMemo(
    () => [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [links],
  );

  const latestFor = (link: OnboardLink): OnboardSubmission | undefined =>
    submissions
      .filter((s) => s.linkId === link.id)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];

  const copy = async (link: OnboardLink) => {
    if (await copyText(buildOnboardUrl(link.token))) {
      setCopiedId(link.id);
      setTimeout(() => setCopiedId((id) => (id === link.id ? null : id)), 1600);
    }
  };

  // Links are tenant-scoped; the active tenant owns every link in this view.
  const companyId = getActiveTenantId() ?? links[0]?.companyId ?? '';

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Send new hires a self-service link — their details, documents and declaration land here
          for one-click approval into an employee record.
        </p>
        <Button
          onClick={() => setGenerateOpen(true)}
          disabled={!companyId}
          title={companyId ? undefined : 'Select a company first'}
          className="shrink-0 bg-amber-600 text-white hover:bg-amber-700"
        >
          <Plus className="mr-1.5 h-4 w-4" /> Generate invite link
        </Button>
      </div>

      {sorted.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="py-12 text-center">
            <Link2 className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              No invite links yet — generate one and share it with your next hire.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-xl">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>New hire</TableHead>
                <TableHead className="hidden md:table-cell">Position</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Created</TableHead>
                <TableHead className="hidden sm:table-cell">Expires</TableHead>
                <TableHead>Submission</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((link) => {
                const status = effectiveLinkStatus(link);
                const sub = latestFor(link);
                const url = buildOnboardUrl(link.token);
                const shareable = status === 'active';
                return (
                  <TableRow key={link.id}>
                    <TableCell className="font-medium">{link.label}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      {positions.find((p) => p.id === link.positionId)?.title ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(status)}>
                        {ONBOARD_LINK_STATUS_LABELS[status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{fmtDate(link.createdAt)}</TableCell>
                    <TableCell className="hidden sm:table-cell">{fmtDate(link.expiresAt)}</TableCell>
                    <TableCell>
                      {sub ? (
                        sub.reviewStatus === 'approved' ? (
                          <Badge variant="outline">Approved</Badge>
                        ) : sub.reviewStatus === 'rejected' ? (
                          <Badge variant="destructive">Returned</Badge>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-amber-500/60 text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30"
                            onClick={() => setReviewTarget(sub)}
                          >
                            <Eye className="mr-1 h-3.5 w-3.5" /> Review
                          </Button>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {sub && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="View submission"
                            onClick={() => setReviewTarget(sub)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                        {shareable && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Copy link"
                              onClick={() => void copy(link)}
                            >
                              {copiedId === link.id ? (
                                <Check className="h-4 w-4 text-lime-600" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                            <Button asChild size="sm" variant="ghost" title="Share via WhatsApp">
                              <a
                                href={whatsAppShareUrl(link.label, url)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <MessageCircle className="h-4 w-4" />
                              </a>
                            </Button>
                            <Button asChild size="sm" variant="ghost" title="Share via email">
                              <a href={mailtoShareUrl(link.label, url)}>
                                <Mail className="h-4 w-4" />
                              </a>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Revoke link"
                              className="text-red-600 hover:text-red-700"
                              onClick={() => setRevokeTarget(link)}
                            >
                              <XCircle className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <GenerateLinkDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        actorName={actorName}
        companyId={companyId}
      />

      <SubmissionReviewDialog
        submission={reviewTarget}
        open={reviewTarget !== null}
        onOpenChange={(o) => !o && setReviewTarget(null)}
        actorName={actorName}
        positions={positions}
        departments={departments}
        onApproveRequest={(sub) => {
          setReviewTarget(null);
          setApproveTarget(sub);
        }}
      />

      <ApproveSubmissionDialog
        submission={approveTarget}
        open={approveTarget !== null}
        onOpenChange={(o) => !o && setApproveTarget(null)}
        actorName={actorName}
      />

      <AlertDialog open={revokeTarget !== null} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this invite link?</AlertDialogTitle>
            <AlertDialogDescription>
              The link for <span className="font-medium">{revokeTarget?.label}</span> will stop
              working immediately. You can always generate a fresh one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokeTarget) revokeOnboardLink(revokeTarget, actorName);
                setRevokeTarget(null);
              }}
            >
              Revoke link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
