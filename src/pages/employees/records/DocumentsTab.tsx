/**
 * Documents repository tab — uploads (≤700 KB; bytes land in the per-tenant
 * docStore, the record keeps metadata + docId), lazy image previews and
 * downloads (spinner while bytes load), expiry tracking (Passport / Work
 * Permit / Medical: amber ≤ 90 days, red expired), kind filter, a tenant
 * "storage used" indicator, and removal (which also frees the docStore bytes).
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileText,
  FolderOpen,
  HardDrive,
  Loader2,
  Plus,
  Upload,
} from 'lucide-react';
import {
  DOCUMENT_KINDS,
  MAX_DOCUMENT_BYTES,
  documentExpiryStatus,
  fmtFileSize,
  getRecordDocumentDataUrl,
  removeDocument,
  saveDocument,
  type DocumentKind,
  type RecordDocument,
} from '@/lib/employeeRecords';
import { DocQuotaError, putDoc, useDocUsage } from '@/lib/docStore';
import { toastError } from '@/lib/toast';
import { cn, fmtDate } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyBlock, Field, RemoveButton, SectionCard, type TabProps } from './shared';

const KIND_BADGE: Record<DocumentKind, string> = {
  IC: 'bg-stone-200 text-stone-700',
  Passport: 'bg-amber-100 text-amber-800',
  'Work Permit': 'bg-orange-100 text-orange-800',
  'Academic Certificate': 'bg-lime-100 text-lime-800',
  CV: 'bg-stone-100 text-stone-700',
  'Bank Statement': 'bg-yellow-100 text-yellow-800',
  Medical: 'bg-red-100 text-red-800',
  Contract: 'bg-amber-100 text-amber-800',
  Other: 'bg-stone-100 text-stone-600',
};

function ExpiryBadge({ doc }: { doc: RecordDocument }) {
  const ex = documentExpiryStatus(doc);
  if (ex.status === 'none') return null;
  if (ex.status === 'expired') {
    return (
      <Badge variant="outline" className="border-transparent bg-red-100 text-red-800">
        Expired {fmtDate(doc.expiryDate!)}
      </Badge>
    );
  }
  if (ex.status === 'expiring') {
    return (
      <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800">
        Expires in {ex.daysToExpiry}d
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-transparent bg-lime-100 text-lime-800">
      Valid until {fmtDate(doc.expiryDate!)}
    </Badge>
  );
}

/**
 * Lazily resolve a document's bytes (docStore by docId; legacy inline dataUrl
 * migrates on this first read). Legacy inline bytes seed the initial state so
 * they render instantly while the migration runs in the background.
 */
function useRecordDocUrl(employeeId: string, doc: RecordDocument) {
  const [url, setUrl] = useState<string | undefined>(doc.dataUrl);
  const [loading, setLoading] = useState(!doc.dataUrl && !!doc.docId);
  useEffect(() => {
    let live = true;
    getRecordDocumentDataUrl(employeeId, doc)
      .then((u) => {
        if (live) {
          setUrl(u);
          setLoading(false);
        }
      })
      .catch(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [employeeId, doc]);
  return { url, loading };
}

function DocumentRow({
  employeeId,
  doc: d,
  readOnly,
  actorName,
}: {
  employeeId: string;
  doc: RecordDocument;
  readOnly: boolean;
  actorName: string;
}) {
  const { url, loading } = useRecordDocUrl(employeeId, d);
  const isImage = url?.startsWith('data:image/');
  const hasBytes = !!(d.docId || d.dataUrl);

  const download = async () => {
    const target = url ?? (await getRecordDocumentDataUrl(employeeId, d).catch(() => undefined));
    if (!target) {
      toastError('Could not load document', 'The stored bytes are unavailable.');
      return;
    }
    const a = document.createElement('a');
    a.href = target;
    a.download = d.fileName;
    a.click();
  };

  return (
    <li className="flex items-center gap-3 py-3">
      {loading ? (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading document" />
        </div>
      ) : isImage ? (
        <img
          src={url}
          alt={d.fileName}
          className="h-12 w-12 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-500">
          <FileText className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="truncate">{d.fileName}</span>
          <Badge variant="outline" className={cn('border-transparent', KIND_BADGE[d.kind])}>
            {d.kind}
          </Badge>
          <ExpiryBadge doc={d} />
        </p>
        <p className="text-xs text-muted-foreground">
          {fmtFileSize(d.sizeBytes)} · uploaded {fmtDate(d.uploadedAt)}
          {d.issueDate ? ` · issued ${fmtDate(d.issueDate)}` : ''}
          {d.expiryDate ? ` · expires ${fmtDate(d.expiryDate)}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center">
        {hasBytes && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={() => void download()}
            aria-label={`Download ${d.fileName}`}
          >
            <Download className="h-4 w-4" />
          </Button>
        )}
        {!readOnly && (
          <RemoveButton
            label={d.fileName}
            onConfirm={() => removeDocument(employeeId, d.id, d.fileName, actorName)}
          />
        )}
      </div>
    </li>
  );
}

export default function DocumentsTab({ employee, file, readOnly, actorName }: TabProps) {
  const [open, setOpen] = useState(false);
  const [kindFilter, setKindFilter] = useState<'all' | DocumentKind>('all');
  const [kind, setKind] = useState<DocumentKind>('IC');
  const [issueDate, setIssueDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [picked, setPicked] = useState<{ fileName: string; dataUrl: string; sizeBytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const usage = useDocUsage();

  const documents = [...(file?.documents ?? [])].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const visible = kindFilter === 'all' ? documents : documents.filter((d) => d.kind === kindFilter);

  const resetDialog = () => {
    setKind('IC');
    setIssueDate('');
    setExpiryDate('');
    setPicked(null);
    setError(null);
  };

  const pickFile = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > MAX_DOCUMENT_BYTES) {
      setPicked(null);
      setError(
        `“${f.name}” is ${fmtFileSize(f.size)} — over the ${Math.round(MAX_DOCUMENT_BYTES / 1024)} KB limit. Compress or split the file first.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPicked({ fileName: f.name, dataUrl: String(reader.result), sizeBytes: f.size });
    };
    reader.onerror = () => setError('Could not read that file — please try again.');
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      // Bytes → docStore (quota guards live here); the record keeps metadata only.
      const docId = await putDoc({
        bytes: picked.dataUrl,
        sizeBytes: picked.sizeBytes,
        fileName: picked.fileName,
      });
      saveDocument(
        employee.id,
        {
          kind,
          fileName: picked.fileName,
          docId,
          sizeBytes: picked.sizeBytes,
          issueDate: issueDate || undefined,
          expiryDate: expiryDate || undefined,
        },
        actorName,
      );
      setOpen(false);
      resetDialog();
    } catch (err) {
      if (err instanceof DocQuotaError) {
        toastError(err.kind === 'per-doc' ? 'File too large' : 'Document storage is full', err);
      }
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setSaving(false);
    }
  };

  if (documents.length === 0 && readOnly) {
    return (
      <EmptyBlock
        icon={FolderOpen}
        title="No documents on file"
        description="IC copies, passports, permits and certificates will appear here once HR uploads them."
      />
    );
  }

  return (
    <SectionCard
      title="Documents repository"
      icon={FolderOpen}
      description={`IC, passport, permits and certificates — up to ${Math.round(MAX_DOCUMENT_BYTES / 1024)} KB per file.`}
      actions={
        !readOnly && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              resetDialog();
              setOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" /> Upload document
          </Button>
        )
      }
    >
      {/* Tenant document-storage usage */}
      <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-border/60 bg-stone-50 px-3 py-2 text-xs text-muted-foreground dark:bg-stone-900/40">
        <HardDrive className="h-3.5 w-3.5 shrink-0" />
        <Progress
          value={usage.percent}
          className={cn(
            'h-1.5 w-28 bg-stone-200 dark:bg-stone-800 [&>div]:bg-amber-600',
            usage.percent >= 80 && '[&>div]:bg-red-500',
          )}
        />
        <span>
          Document storage: {fmtFileSize(usage.bytes)} of {fmtFileSize(usage.limitBytes)} used ·{' '}
          {usage.count} file{usage.count === 1 ? '' : 's'}
        </span>
      </div>

      {/* Kind filter */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(['all', ...DOCUMENT_KINDS] as const).map((k) => (
          <Button
            key={k}
            size="sm"
            variant={kindFilter === k ? 'default' : 'outline'}
            className={cn(
              'h-7 px-2.5 text-xs',
              kindFilter === k && 'bg-amber-600 text-white hover:bg-amber-700',
            )}
            onClick={() => setKindFilter(k)}
          >
            {k === 'all' ? `All (${documents.length})` : k}
          </Button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {documents.length === 0
            ? 'No documents yet — upload the IC copy first to complete the file.'
            : `No documents under “${kindFilter}”.`}
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {visible.map((d) => (
            <DocumentRow
              key={d.id}
              employeeId={employee.id}
              doc={d}
              readOnly={readOnly}
              actorName={actorName}
            />
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload document</DialogTitle>
            <DialogDescription>
              Stored in the personnel file (max {Math.round(MAX_DOCUMENT_BYTES / 1024)} KB). Set an
              expiry date for passports, permits and medicals to get alerts.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Document kind">
              <Select value={kind} onValueChange={(v) => setKind(v as DocumentKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="File *">
              <div className="flex items-center gap-2">
                <Input
                  ref={fileInput}
                  type="file"
                  className="text-xs"
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />
              </div>
            </Field>
            <Field label="Issue date">
              <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
            </Field>
            <Field label="Expiry date">
              <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
            </Field>
          </div>

          {picked && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-stone-50 p-3">
              {picked.dataUrl.startsWith('data:image/') ? (
                <img
                  src={picked.dataUrl}
                  alt="preview"
                  className="h-12 w-12 rounded-lg border border-border object-cover"
                />
              ) : (
                <FileText className="h-5 w-5 text-stone-500" />
              )}
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium">{picked.fileName}</p>
                <p className="text-xs text-muted-foreground">{fmtFileSize(picked.sizeBytes)}</p>
              </div>
              <Upload className="ml-auto h-4 w-4 text-amber-600" />
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={!picked || saving}
              onClick={() => void submit()}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Storing…
                </>
              ) : (
                'Upload'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
