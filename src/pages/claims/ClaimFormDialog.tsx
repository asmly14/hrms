/**
 * Submit / edit claim form (dialog). Covers all eight UI categories, a guided
 * km × rate mileage calculator, soft per-claim policy-limit warnings, and the
 * AI receipt scan flow: camera/upload → preprocess → docStore bytes → DeepSeek
 * extraction → editable prefill (see lib/ocr.ts + claims/receiptScan.ts).
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Calculator, Camera, ImagePlus, Loader2, Paperclip, Receipt, ScanLine,
  Sparkles, X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Employee } from '@/lib/types';
import { logAudit, useCollection } from '@/lib/db';
import { getDoc, putDoc, removeDoc } from '@/lib/docStore';
import {
  extractReceiptFields, getDeepSeekApiKey, hasOcrKey, OcrError, preprocessReceiptImage,
} from '@/lib/ocr';
import { fmtRM, round2 } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  CATEGORIES, categoryMetaOf, policyWarnings,
  type ClaimPolicy, type ClaimRecord, type UiCategory,
} from './claimPolicy';
import { buildReceiptDescription, hasAnyReceiptField, mapReceiptCategory } from './receiptScan';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Claimant — the employee the page is acting as. */
  employee: Employee;
  claims: ClaimRecord[];
  policy: ClaimPolicy;
  /** When set, the dialog edits this draft instead of creating a new claim. */
  editing?: ClaimRecord | null;
}

export default function ClaimFormDialog({ open, onOpenChange, employee, claims, policy, editing }: Props) {
  const { add, update } = useCollection<ClaimRecord>('claims');

  const [category, setCategory] = useState<UiCategory>('travel');
  const [claimDate, setClaimDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [kmStr, setKmStr] = useState('');
  const [rateStr, setRateStr] = useState(String(policy.mileageRatePerKm));
  const [receiptName, setReceiptName] = useState<string | undefined>(undefined);
  // Remount key for the uncontrolled file inputs so "remove receipt" also resets them.
  const [receiptKey, setReceiptKey] = useState(0);
  // ── AI receipt scan state ────────────────────────────────────────────────
  /** docStore id of the stored receipt bytes (goes onto the claim record). */
  const [receiptDocId, setReceiptDocId] = useState<string | undefined>(undefined);
  /** dataUrl preview of the stored receipt (hydrated async when editing). */
  const [receiptPreview, setReceiptPreview] = useState<string | undefined>(undefined);
  const [receiptBusy, setReceiptBusy] = useState(false); // preprocessing / storing
  const [scanning, setScanning] = useState(false); // DeepSeek extraction in flight
  /** Set once an AI extraction prefilled this form — persisted as aiExtracted. */
  const [aiUsed, setAiUsed] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);

  // Reset (or hydrate, when editing a draft) every time the dialog opens.
  // Render-phase adjust keyed on (open, editing) — no cascading effect.
  const formKey = open ? (editing?.id ?? 'new') : 'closed';
  const [prevFormKey, setPrevFormKey] = useState(formKey);
  if (formKey !== prevFormKey) {
    setPrevFormKey(formKey);
    if (open) {
      setTouched(false);
      setAiUsed(false);
      setScanning(false);
      setReceiptBusy(false);
      if (editing) {
        setCategory(categoryMetaOf(editing).id);
        setClaimDate(editing.claimDate);
        setDescription(editing.title);
        setAmountStr(String(editing.amount));
        setKmStr(editing.mileageKm != null ? String(editing.mileageKm) : '');
        setRateStr(editing.mileageRate != null ? String(editing.mileageRate) : String(policy.mileageRatePerKm));
        setReceiptName(editing.receiptName);
        setReceiptDocId(editing.receiptDocId);
        setReceiptPreview(undefined); // hydrated async by the effect below
      } else {
        setCategory('travel');
        setClaimDate(todayIso());
        setDescription('');
        setAmountStr('');
        setKmStr('');
        setRateStr(String(policy.mileageRatePerKm));
        setReceiptName(undefined);
        setReceiptDocId(undefined);
        setReceiptPreview(undefined);
      }
    }
  }

  // Load stored receipt bytes for the preview when editing a claim that has a
  // docStore receipt. The label (receiptName) renders even if bytes are gone.
  const editingDocId = open ? editing?.receiptDocId : undefined;
  useEffect(() => {
    if (!editingDocId) return;
    let cancelled = false;
    getDoc(editingDocId)
      .then((url) => {
        if (!cancelled && url) setReceiptPreview(url);
      })
      .catch(() => {
        /* preview stays hidden — the file label still shows */
      });
    return () => {
      cancelled = true;
    };
  }, [editingDocId]);

  const isMileage = category === 'mileage';
  const meta = CATEGORIES.find((c) => c.id === category)!;

  const km = Number.parseFloat(kmStr);
  const rate = Number.parseFloat(rateStr);
  const mileageAmount = Number.isFinite(km) && Number.isFinite(rate) && km > 0 && rate > 0
    ? round2(km * rate)
    : 0;
  const amount = isMileage ? mileageAmount : round2(Number.parseFloat(amountStr) || 0);

  const warnings = policyWarnings(
    {
      employeeId: employee.id,
      category: meta.claimCategory,
      amount,
      claimDate,
      mileageRate: isMileage && Number.isFinite(rate) ? round2(rate) : undefined,
    },
    claims,
    policy,
    editing?.id,
  );

  const errors: string[] = [];
  if (!claimDate) errors.push('Pick the expense date.');
  if (description.trim().length < 3) errors.push('Add a short description (min 3 characters).');
  if (isMileage) {
    if (!(km > 0)) errors.push('Enter the distance travelled in km.');
    if (!(rate > 0)) errors.push('Enter a mileage rate above RM 0/km.');
    // B6: km × rate can round down to RM 0.00 (e.g. 0.01 km × RM 0.01) — block it.
    if (km > 0 && rate > 0 && !(mileageAmount > 0)) {
      errors.push('Mileage amount rounds to RM 0.00 — check the distance and rate.');
    }
  } else if (!(amount > 0)) {
    errors.push('Enter an amount above RM 0.');
  }
  const valid = errors.length === 0;

  // ── Receipt scan / upload / AI extraction ────────────────────────────────
  const ocrReady = hasOcrKey();

  /** Preprocess a picked photo, store its bytes in docStore, show the preview. */
  async function onReceiptFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file (JPG, PNG, HEIC).');
      return;
    }
    setReceiptBusy(true);
    try {
      const dataUrl = await preprocessReceiptImage(file);
      // Replacing an existing receipt — free the old bytes so the per-tenant
      // document budget isn't leaked.
      if (receiptDocId) await removeDoc(receiptDocId).catch(() => {});
      const docId = await putDoc({ bytes: dataUrl, fileName: file.name });
      setReceiptDocId(docId);
      setReceiptPreview(dataUrl);
      setReceiptName(file.name);
    } catch (err) {
      // DocQuotaError and preprocess errors both carry user-safe messages.
      toast.error(err instanceof Error ? err.message : 'Could not read that image.');
    } finally {
      setReceiptBusy(false);
    }
  }

  /** Detach the receipt: drop the stored bytes immediately and reset inputs. */
  async function clearReceipt() {
    if (receiptDocId) await removeDoc(receiptDocId).catch(() => {});
    setReceiptDocId(undefined);
    setReceiptPreview(undefined);
    setReceiptName(undefined);
    setReceiptKey((k) => k + 1); // reset the uncontrolled file inputs too
  }

  /** DeepSeek extraction → editable prefill. Never blocks manual editing. */
  async function extractWithAi() {
    const key = getDeepSeekApiKey();
    if (!key) {
      toast.error("Add your company's DeepSeek API key in Settings → Integrations.");
      return;
    }
    if (!receiptDocId) return;
    setScanning(true);
    try {
      const dataUrl = receiptPreview ?? (await getDoc(receiptDocId));
      if (!dataUrl) {
        throw new OcrError('parse', 'Receipt bytes are missing — attach the photo again.');
      }
      const f = await extractReceiptFields(dataUrl, key);
      if (!hasAnyReceiptField(f)) {
        toast('The AI could not read any fields on this receipt — please fill the form manually.');
        return;
      }
      // Category first so the amount lands in the right input (mileage uses km × rate).
      const nextCategory = f.suggestedCategory ? mapReceiptCategory(f.suggestedCategory) : category;
      if (f.suggestedCategory) setCategory(nextCategory);
      // Receipts can be future-dated by misread — clamp to today (the input max).
      if (f.date) setClaimDate(f.date > todayIso() ? todayIso() : f.date);
      if (f.total != null && f.total > 0 && nextCategory !== 'mileage') {
        setAmountStr(f.total.toFixed(2));
      }
      const desc = buildReceiptDescription(f.merchant, f.invoiceNo, f.currency);
      if (desc) setDescription(desc);
      setAiUsed(true);
      toast.success('Fields extracted — please verify.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI extraction failed — please try again.');
    } finally {
      setScanning(false);
    }
  }

  function persist(status: 'draft' | 'submitted') {
    if (!valid) {
      setTouched(true);
      toast.error('Please fix the highlighted fields before saving.');
      return;
    }
    const base = {
      employeeId: employee.id,
      category: meta.claimCategory,
      title: description.trim(),
      amount,
      claimDate,
      receiptName,
      receiptDocId,
      // Sticky: once AI-extracted the draft keeps the marker until submitted.
      aiExtracted: aiUsed || Boolean(editing?.aiExtracted),
      ...(isMileage ? { mileageKm: round2(km), mileageRate: round2(rate) } : {}),
    };
    if (editing) {
      update(editing.id, {
        ...base,
        status,
        ...(status === 'submitted' ? { submittedAt: new Date().toISOString() } : {}),
        // Any save transitions to draft/submitted — stale decision data must not survive (B8).
        decidedBy: undefined,
        decidedAt: undefined,
        decisionRemarks: undefined,
      });
      logAudit({
        actorId: employee.id,
        actorName: employee.name,
        action: status === 'submitted' ? 'claim.submit' : 'claim.update',
        entity: 'claims',
        entityId: editing.id,
        detail: `${meta.label} — ${fmtRM(amount)} (${base.title.slice(0, 60)})`,
      });
      toast.success(
        status === 'submitted'
          ? `Claim submitted for approval — ${meta.label} ${fmtRM(amount)}`
          : `Draft claim updated — ${meta.label} ${fmtRM(amount)}`,
      );
    } else {
      const saved = add({
        ...base,
        status,
        ...(status === 'submitted' ? { submittedAt: new Date().toISOString() } : {}),
      });
      logAudit({
        actorId: employee.id,
        actorName: employee.name,
        action: status === 'submitted' ? 'claim.submit' : 'claim.draft',
        entity: 'claims',
        entityId: saved.id,
        detail: `${meta.label} — ${fmtRM(amount)} (${base.title.slice(0, 60)})`,
      });
      toast.success(
        status === 'submitted'
          ? `Claim submitted for approval — ${meta.label} ${fmtRM(amount)}`
          : `Draft saved — ${meta.label} ${fmtRM(amount)}`,
      );
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-amber-600" />
            {editing ? 'Edit draft claim' : 'New claim'}
          </DialogTitle>
          <DialogDescription>
            Claiming as <span className="font-medium text-foreground">{employee.name}</span>. Approved
            claims are reimbursed in the next payroll run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="claim-category">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as UiCategory)}>
                <SelectTrigger id="claim-category" className="w-full">
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="claim-date">Expense date</Label>
              <Input
                id="claim-date"
                type="date"
                value={claimDate}
                max={todayIso()}
                onChange={(e) => setClaimDate(e.target.value)}
              />
            </div>
          </div>

          {isMileage ? (
            <div className="space-y-3 rounded-xl border border-dashed bg-muted/40 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Calculator className="h-3.5 w-3.5" /> Mileage calculator — distance × rate
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="claim-km">Distance (km)</Label>
                  <Input
                    id="claim-km"
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="e.g. 120"
                    value={kmStr}
                    onChange={(e) => setKmStr(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="claim-rate">Rate (RM/km)</Label>
                  <Input
                    id="claim-rate"
                    type="number"
                    min="0"
                    step="0.01"
                    value={rateStr}
                    onChange={(e) => setRateStr(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-sm">
                Claim amount:{' '}
                <span className="font-semibold tabular-nums">{fmtRM(mileageAmount)}</span>
                {Number.isFinite(km) && km > 0 && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({kmStr} km × {fmtRM(Number.isFinite(rate) ? rate : 0)}/km)
                  </span>
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="claim-amount">Amount (RM)</Label>
              <Input
                id="claim-amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="claim-desc">Description</Label>
            <Textarea
              id="claim-desc"
              rows={3}
              placeholder={
                isMileage
                  ? 'e.g. Site visit to Kuantan — return trip'
                  : 'e.g. Team lunch with distributor'
              }
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <ScanLine className="h-3.5 w-3.5 text-amber-600" /> Receipt &amp; AI scan
            </Label>
            {/* Hidden pickers: gallery upload + mobile camera capture. */}
            <input
              key={`upload-${receiptKey}`}
              ref={uploadInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              aria-label="Upload receipt photo"
              onChange={(e) => {
                void onReceiptFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <input
              key={`camera-${receiptKey}`}
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              aria-label="Capture receipt with camera"
              onChange={(e) => {
                void onReceiptFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={receiptBusy || scanning}
                onClick={() => uploadInputRef.current?.click()}
              >
                {receiptBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ImagePlus className="h-3.5 w-3.5" />
                )}
                Upload photo
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={receiptBusy || scanning}
                onClick={() => cameraInputRef.current?.click()}
              >
                <Camera className="h-3.5 w-3.5" /> Use camera
              </Button>
            </div>

            {receiptPreview ? (
              <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-2.5">
                <img
                  src={receiptPreview}
                  alt="Receipt preview"
                  className="h-20 w-20 shrink-0 rounded-lg border object-cover"
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Paperclip className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{receiptName ?? 'receipt.jpg'}</span>
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!ocrReady || scanning || receiptBusy}
                    onClick={() => void extractWithAi()}
                  >
                    {scanning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {scanning ? 'Extracting…' : 'Extract with AI'}
                  </Button>
                </div>
                <button
                  type="button"
                  onClick={() => void clearReceipt()}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40"
                  aria-label="Remove receipt"
                >
                  <X className="h-3 w-3" /> Remove
                </button>
              </div>
            ) : receiptName ? (
              // Legacy / bytes-missing case: label-only attachment.
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{receiptName}</span>
                <button
                  type="button"
                  onClick={() => void clearReceipt()}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40"
                  aria-label="Remove receipt"
                >
                  <X className="h-3 w-3" /> Remove
                </button>
              </p>
            ) : null}

            {!ocrReady && (
              <p className="text-xs text-muted-foreground">
                Add your company&apos;s DeepSeek API key in Settings → Integrations to enable AI
                extraction.
              </p>
            )}
          </div>

          {warnings.length > 0 && (
            <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Policy limit warning</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs opacity-80">
                  You can still submit — the approver will see these flags.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {touched && !valid && (
            <Alert className="border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Please fix before saving</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => persist('draft')}>
            Save as draft
          </Button>
          <Button onClick={() => persist('submitted')}>
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
