/**
 * Step 5 — Document uploads. Five required kinds (IC copy, academic
 * certificates, CV, bank statement, photo) plus optional extras. Files are
 * capped at ~700 KB each (localStorage budget), stored as base64 dataUrls,
 * and shown as removable chips (images get a thumbnail).
 */
import { useRef, useState } from 'react';
import { FileText, ImageIcon, Upload, X } from 'lucide-react';
import {
  MAX_FILE_LABEL,
  REQUIRED_DOC_KINDS,
  validateDocumentFile,
  type OnboardDocKind,
  type OnboardDocument,
} from '@/lib/onboardLinks';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { StepIntro } from '../fields';
import type { FormErrors, OnboardFormState } from '../formState';

const KIND_HINTS: Record<OnboardDocKind, string> = {
  IC: 'NRIC front & back (photo / scan / PDF)',
  'Academic Certificate': 'Scrolls & transcripts (photo / PDF)',
  CV: 'Latest resume (PDF preferred)',
  'Bank Statement': 'First page showing name & account no.',
  Photo: 'Passport-style headshot',
  Other: 'Any supporting document',
};

const KIND_LABELS: Record<OnboardDocKind, string> = {
  IC: 'IC copy',
  'Academic Certificate': 'Academic certificates',
  CV: 'CV / resume',
  'Bank Statement': 'Bank statement',
  Photo: 'Passport photo',
  Other: 'Other documents',
};

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

interface Props {
  form: OnboardFormState;
  patch: (p: Partial<OnboardFormState>) => void;
  errors: FormErrors;
}

export default function DocumentsStep({ form, patch, errors }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingKind = useRef<OnboardDocKind>('IC');
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (kind: OnboardDocKind) => {
    pendingKind.current = kind;
    setFileError(null);
    inputRef.current?.click();
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const problem = validateDocumentFile(file.name, file.size);
    if (problem) {
      setFileError(problem);
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      const doc: OnboardDocument = {
        kind: pendingKind.current,
        fileName: file.name,
        dataUrl,
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString(),
      };
      // Replace same-kind uploads for the single-slot required kinds;
      // 'Other' accumulates.
      const next =
        doc.kind === 'Other'
          ? [...form.documents, doc]
          : [...form.documents.filter((d) => d.kind !== doc.kind), doc];
      patch({ documents: next });
      setFileError(null);
    } catch {
      setFileError('Could not read that file — please try another one.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = (target: OnboardDocument) =>
    patch({ documents: form.documents.filter((d) => d !== target) });

  const docsFor = (kind: OnboardDocKind) => form.documents.filter((d) => d.kind === kind);

  return (
    <div className="space-y-5">
      <StepIntro title="Document uploads">
        Upload clear copies of each required document. Images or PDFs, max {MAX_FILE_LABEL} per
        file — they stay in your company&apos;s HR system only.
      </StepIntro>

      {/* Single hidden input reused by every kind button */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.pdf"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />

      {fileError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          {fileError}
        </div>
      )}

      <div className="space-y-3">
        {[...REQUIRED_DOC_KINDS, 'Other' as const].map((kind) => {
          const docs = docsFor(kind);
          const required = REQUIRED_DOC_KINDS.includes(kind);
          const missing = required && docs.length === 0;
          return (
            <div
              key={kind}
              className={cn(
                'rounded-xl border p-4',
                missing && errors[`doc-${kind}`] && 'border-red-300 dark:border-red-900/60',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {KIND_LABELS[kind]}
                    {required && <span className="ml-0.5 text-red-500">*</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">{KIND_HINTS[kind]}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => pick(kind)}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  {docs.length > 0 && kind !== 'Other' ? 'Replace' : 'Upload'}
                </Button>
              </div>

              {docs.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {docs.map((d, i) => (
                    <li
                      key={`${d.fileName}-${i}`}
                      className="flex items-center gap-2 rounded-full border bg-stone-50 py-1 pl-1.5 pr-1 text-xs dark:bg-stone-900/40"
                    >
                      {d.dataUrl?.startsWith('data:image') ? (
                        <img
                          src={d.dataUrl}
                          alt=""
                          className="h-7 w-7 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-stone-200 dark:bg-stone-800">
                          {d.fileName.toLowerCase().endsWith('.pdf') ? (
                            <FileText className="h-3.5 w-3.5" />
                          ) : (
                            <ImageIcon className="h-3.5 w-3.5" />
                          )}
                        </span>
                      )}
                      <span className="max-w-[140px] truncate font-medium">{d.fileName}</span>
                      <span className="text-muted-foreground">{fmtSize(d.sizeBytes)}</span>
                      <button
                        type="button"
                        onClick={() => remove(d)}
                        aria-label={`Remove ${d.fileName}`}
                        className="rounded-full p-1 text-muted-foreground hover:bg-stone-200 hover:text-foreground dark:hover:bg-stone-800"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {missing && errors[`doc-${kind}`] && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                  {KIND_LABELS[kind]} is required
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
