/**
 * Generate onboarding invite link — label (new-hire name), optional
 * position/department, expiry (default 14 days). After creation the dialog
 * shows the shareable URL with copy + WhatsApp + email share actions.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Link2, Mail, MessageCircle } from 'lucide-react';
import { useCollection } from '@/lib/db';
import {
  DEFAULT_EXPIRY_DAYS,
  buildOnboardUrl,
  createOnboardLink,
  type OnboardLink,
} from '@/lib/onboardLinks';
import type { Department, Position } from '@/lib/types';
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
import { copyText, mailtoShareUrl, whatsAppShareUrl } from './linkShare';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actorName: string;
  /** Active company id — links are stored under this tenant. */
  companyId: string;
}

export default function GenerateLinkDialog({ open, onOpenChange, actorName, companyId }: Props) {
  const { items: positions } = useCollection<Position>('positions');
  const { items: departments } = useCollection<Department>('departments');

  const [label, setLabel] = useState('');
  const [positionId, setPositionId] = useState('none');
  const [departmentId, setDepartmentId] = useState('none');
  const [expiryDays, setExpiryDays] = useState(String(DEFAULT_EXPIRY_DAYS));
  const [created, setCreated] = useState<OnboardLink | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setLabel('');
      setPositionId('none');
      setDepartmentId('none');
      setExpiryDays(String(DEFAULT_EXPIRY_DAYS));
      setCreated(null);
      setCopied(false);
    }
  }, [open]);

  const url = useMemo(() => (created ? buildOnboardUrl(created.token) : ''), [created]);

  const days = Math.max(1, parseInt(expiryDays, 10) || DEFAULT_EXPIRY_DAYS);

  const submit = () => {
    const link = createOnboardLink({
      label,
      companyId,
      createdBy: actorName,
      positionId: positionId === 'none' ? undefined : positionId,
      departmentId: departmentId === 'none' ? undefined : departmentId,
      expiryDays: days,
    });
    setCreated(link);
  };

  const copy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{created ? 'Invite link ready' : 'Generate invite link'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'Share this link with the new hire — it opens a self-service onboarding form.'
              : 'The new hire receives a link to fill in their own details, documents and declarations.'}
          </DialogDescription>
        </DialogHeader>

        {!created ? (
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="gl-label">New-hire name / label</Label>
              <Input
                id="gl-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Aisyah binti Rahman"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Position (optional)</Label>
                <Select value={positionId} onValueChange={setPositionId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Any position" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Any position</SelectItem>
                    {positions.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Department (optional)</Label>
                <Select value={departmentId} onValueChange={setDepartmentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Any department" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Any department</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="gl-expiry">Link expires after (days)</Label>
              <Input
                id="gl-expiry"
                type="number"
                min={1}
                max={90}
                value={expiryDays}
                onChange={(e) => setExpiryDays(e.target.value)}
                className="w-28"
              />
              <p className="text-xs text-muted-foreground">
                Default {DEFAULT_EXPIRY_DAYS} days. Expired links show a friendly notice and can be
                regenerated anytime.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            <div className="flex items-center gap-2 rounded-xl border bg-stone-50 p-3 dark:bg-stone-900/40">
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <code className="flex-1 break-all text-xs">{url}</code>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={copy} variant="outline" size="sm">
                {copied ? (
                  <Check className="mr-1.5 h-4 w-4 text-lime-600" />
                ) : (
                  <Copy className="mr-1.5 h-4 w-4" />
                )}
                {copied ? 'Copied!' : 'Copy link'}
              </Button>
              <Button asChild variant="outline" size="sm">
                <a
                  href={whatsAppShareUrl(created.label, url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MessageCircle className="mr-1.5 h-4 w-4" /> WhatsApp
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={mailtoShareUrl(created.label, url)}>
                  <Mail className="mr-1.5 h-4 w-4" /> Email
                </a>
              </Button>
            </div>
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              Expires {created.expiresAt.slice(0, 10)} · Anyone with this link can submit the form
              once — share it privately with {created.label}.
            </p>
          </div>
        )}

        <DialogFooter>
          {!created ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={!label.trim()}
                className="bg-amber-600 text-white hover:bg-amber-700"
              >
                Generate link
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
