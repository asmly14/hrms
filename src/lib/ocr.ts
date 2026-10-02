/**
 * AI receipt scanning (OCR) for the e-Claims module — DeepSeek vision.
 *
 * What lives here
 * ───────────────
 *  1. Per-tenant DeepSeek API-key storage. The key is a COMPANY secret, so it
 *     follows the established extension-doc convention ('ext:payroll',
 *     'ext:leaveTopups', 'ext:glMapping'): one tenant-scoped settings doc with
 *     id 'ext:integrations' and kind 'integrations' in the registry 'settings'
 *     collection. Tenant scoping, JSON export/import, legacy migration and
 *     seed init therefore cover it automatically — nothing is ever written
 *     outside that doc (no code, no seeds, no other storage keys).
 *  2. Receipt image preprocessing. Photos from phone cameras are 3–12 MB —
 *     far above the docStore 700 KB/doc cap and wasteful as an API payload.
 *     The canvas pipeline downscales the longest side to ≤1600 px and
 *     re-encodes as JPEG q0.85 (≈150–400 KB), then enforces the docStore
 *     per-document cap so a putDoc right after can never trip the quota.
 *  3. Field extraction. POSTs the image to the DeepSeek chat-completions
 *     endpoint (OpenAI-compatible, model 'deepseek-flash', JSON mode) and
 *     robustly parses the reply into typed receipt fields. Failures surface
 *     as a typed OcrError ('no-key' | 'http' | 'timeout' | 'parse' |
 *     'network') whose message is already user-safe.
 *
 * Security rules (hard requirements)
 * ──────────────────────────────────
 *  - The API key is NEVER logged, NEVER audited verbatim, and NEVER included
 *    in error messages — only the masked form ('sk-…last4') may be displayed.
 *  - The key leaves the browser exactly once per operation: as the
 *    Authorization header on a direct request to api.deepseek.com.
 */
import { getCollection, setCollection } from './db';
import { estimateRawBytes, MAX_DOC_BYTES, MAX_DOC_LABEL } from './docStore';

/* ────────────────────────────────────────────────────────────
 * Constants & types
 * ──────────────────────────────────────────────────────────── */

/** Settings-doc id for per-company integration secrets (tenant-scoped). */
export const INTEGRATIONS_DOC_ID = 'ext:integrations';

export const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
/** Vision-capable chat model used for receipt extraction (verified live). */
export const DEEPSEEK_OCR_MODEL = 'deepseek-flash';

/** Longest-side pixel cap for the OCR/upload pipeline. */
export const RECEIPT_MAX_SIDE = 1600;
export const RECEIPT_JPEG_QUALITY = 0.85;

export type OcrErrorKind = 'no-key' | 'http' | 'timeout' | 'parse' | 'network';

/**
 * Typed OCR failure. `message` is always safe to show to the user and NEVER
 * contains the API key; `status` carries the HTTP code for 'http' failures.
 */
export class OcrError extends Error {
  override readonly name = 'OcrError';
  readonly kind: OcrErrorKind;
  readonly status?: number;

  constructor(kind: OcrErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** Structured fields extracted from a receipt photo. All optional — the form stays editable. */
export interface ReceiptFields {
  merchant?: string;
  /** ISO date 'YYYY-MM-DD' of the transaction. */
  date?: string;
  /** Grand total paid (number only, 2dp). */
  total?: number;
  /** ISO 4217 uppercase ('MYR', 'USD', …). 'RM' on receipts normalises to MYR. */
  currency?: string;
  /** Model-suggested claim category token ('meal', 'travel', …) — mapped by the claims module. */
  suggestedCategory?: string;
  invoiceNo?: string;
  /** The parsed JSON object verbatim, for debugging/audit (never the raw reply text). */
  raw?: Record<string, unknown>;
}

/* ────────────────────────────────────────────────────────────
 * API-key storage (settings doc 'ext:integrations', per tenant)
 * ──────────────────────────────────────────────────────────── */

interface IntegrationsDoc {
  id: string;
  kind?: string;
  deepseekApiKey?: unknown;
  updatedAt?: string;
  [key: string]: unknown;
}

function readIntegrationsDoc(tenantId?: string): IntegrationsDoc | undefined {
  return getCollection<IntegrationsDoc>('settings', tenantId).find(
    (r) => r.id === INTEGRATIONS_DOC_ID,
  );
}

/** The active company's DeepSeek API key, or undefined when not configured. */
export function getDeepSeekApiKey(tenantId?: string): string | undefined {
  const v = readIntegrationsDoc(tenantId)?.deepseekApiKey;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** true when the active company has a DeepSeek key saved. */
export function hasOcrKey(tenantId?: string): boolean {
  return getDeepSeekApiKey(tenantId) !== undefined;
}

/**
 * Save (or with null/blank remove) the active company's DeepSeek API key.
 * Removal drops just the `deepseekApiKey` field; the doc itself is deleted
 * when nothing else remains so no residue accumulates. Never throws on a
 * blank key — blank simply means "not configured".
 */
export function saveDeepSeekApiKey(key: string | null | undefined, tenantId?: string): void {
  const rows = getCollection<IntegrationsDoc>('settings', tenantId);
  const idx = rows.findIndex((r) => r.id === INTEGRATIONS_DOC_ID);
  const clean = (key ?? '').trim();

  if (!clean) {
    if (idx < 0) return; // nothing stored — no write, no notify
    const rest = { ...rows[idx] };
    delete rest.deepseekApiKey;
    const hasOtherData = Object.keys(rest).some((k) => !['id', 'kind', 'updatedAt'].includes(k));
    const next = hasOtherData
      ? rows.map((r, i) => (i === idx ? { ...rest, updatedAt: new Date().toISOString() } : r))
      : rows.filter((_, i) => i !== idx);
    setCollection('settings', next, tenantId);
    return;
  }

  const doc: IntegrationsDoc = {
    ...(idx >= 0 ? rows[idx] : {}),
    id: INTEGRATIONS_DOC_ID,
    kind: 'integrations',
    deepseekApiKey: clean,
    updatedAt: new Date().toISOString(),
  };
  const next = idx >= 0 ? rows.map((r, i) => (i === idx ? doc : r)) : [...rows, doc];
  setCollection('settings', next, tenantId);
}

/**
 * Display-safe masked form of a key: 'sk-…last4' (prefix 'sk-' when present).
 * Anything ≤7 chars is fully masked so a fragment can never leak.
 */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (k.length <= 7) return '••••';
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

/* ────────────────────────────────────────────────────────────
 * Image preprocessing (canvas downscale → JPEG dataUrl)
 * ──────────────────────────────────────────────────────────── */

/**
 * Pure sizing math (exported for tests): scale (w,h) so the longest side is
 * at most `maxSide`, preserving aspect ratio; never upscales. Degenerate
 * inputs fall back to a square at maxSide so the canvas call stays valid.
 */
export function receiptTargetSize(
  width: number,
  height: number,
  maxSide: number = RECEIPT_MAX_SIDE,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: maxSide, height: maxSide };
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

interface ImageSource {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

/** Decode a File/Blob into a drawable source (createImageBitmap, <img> fallback). */
async function loadImageSource(file: Blob): Promise<ImageSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode that image file.'));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => {},
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the processed image.'));
    reader.readAsDataURL(blob);
  });
}

async function renderJpegDataUrl(
  img: ImageSource,
  maxSide: number,
  quality: number,
): Promise<string> {
  const { width, height } = receiptTargetSize(img.width, img.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
  // Flatten transparency onto white — JPEG has no alpha channel.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img.source, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new Error('Could not encode the image as JPEG.');
  return blobToDataUrl(blob);
}

/**
 * Downscale + re-encode a receipt photo into a compact JPEG dataUrl ready for
 * docStore.putDoc and the DeepSeek image payload. Enforces the docStore
 * per-document cap with one harder-compression retry before failing friendly.
 * Throws a plain Error with a user-safe message (no key material involved).
 */
export async function preprocessReceiptImage(
  file: File | Blob,
  opts: { maxSide?: number; quality?: number } = {},
): Promise<string> {
  if (typeof document === 'undefined') {
    throw new Error('Receipt preprocessing needs a browser environment (canvas).');
  }
  const mime = 'type' in file ? file.type : '';
  if (mime && !mime.startsWith('image/')) {
    throw new Error('Receipts must be image files (JPG, PNG, HEIC…) — PDFs are not scannable yet.');
  }
  const maxSide = opts.maxSide ?? RECEIPT_MAX_SIDE;
  const quality = opts.quality ?? RECEIPT_JPEG_QUALITY;

  const img = await loadImageSource(file);
  try {
    let dataUrl = await renderJpegDataUrl(img, maxSide, quality);
    if (estimateRawBytes(dataUrl) > MAX_DOC_BYTES) {
      // Rare (busy 1600px photos) — one tighter pass before giving up.
      dataUrl = await renderJpegDataUrl(img, Math.min(1024, maxSide), 0.7);
    }
    if (estimateRawBytes(dataUrl) > MAX_DOC_BYTES) {
      throw new Error(
        `Even after compression the photo exceeds the ${MAX_DOC_LABEL} per-document limit — crop it tighter and try again.`,
      );
    }
    return dataUrl;
  } finally {
    img.close();
  }
}

/* ────────────────────────────────────────────────────────────
 * Reply parsing (robust JSON extraction & field coercion)
 * ──────────────────────────────────────────────────────────── */

function asCleanString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

/** Coerce a total that may arrive as number, '45.5', 'RM 45.50' or '1,234.00'. */
export function coerceReceiptTotal(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : undefined;
  }
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.replace(/(?:rm|myr|myr\.?)/gi, '').replace(/[,\s]/g, ''));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
  }
  return undefined;
}

/**
 * Normalise a receipt date to 'YYYY-MM-DD'. Accepts ISO ('2025-03-05'),
 * Malaysian numeric dates ('5/3/2025', '05-03-25' → day-first), and
 * year-first numeric ('2025/3/5'). Returns undefined when unparseable.
 */
export function normalizeReceiptDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;

  const pad = (n: number) => String(n).padStart(2, '0');
  const valid = (y: number, m: number, d: number) =>
    y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31
      ? `${y}-${pad(m)}-${pad(d)}`
      : undefined;

  // ISO (possibly with a time part).
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  // Year-first with / or .
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  // Day-first (MY convention) with / - or .
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);
  if (m) {
    const y = Number(m[3]);
    return valid(y < 100 ? 2000 + y : y, Number(m[2]), Number(m[1]));
  }
  return undefined;
}

/** Coerce a currency to ISO 4217 uppercase; 'RM'/'MYR RM' → 'MYR'. */
export function coerceReceiptCurrency(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toUpperCase();
  if (!s) return undefined;
  if (s === 'RM' || s === 'MYR') return 'MYR';
  const m = /\b([A-Z]{3})\b/.exec(s);
  return m ? m[1] : undefined;
}

/**
 * Parse the model reply into ReceiptFields. Tolerates markdown code fences
 * and prose around the JSON object. Returns null when no JSON object can be
 * recovered (the caller wraps that as an OcrError 'parse').
 */
export function parseReceiptJson(content: string): ReceiptFields | null {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const r = obj as Record<string, unknown>;

  return {
    merchant: asCleanString(r.merchant),
    date: normalizeReceiptDate(r.date),
    total: coerceReceiptTotal(r.total),
    currency: coerceReceiptCurrency(r.currency),
    suggestedCategory: asCleanString(r.suggestedCategory),
    invoiceNo: asCleanString(r.invoiceNo ?? r.invoice ?? r.receiptNo),
    raw: r,
  };
}

/* ────────────────────────────────────────────────────────────
 * DeepSeek API calls
 * ──────────────────────────────────────────────────────────── */

const RECEIPT_SYSTEM_PROMPT =
  'You extract structured data from receipt photos for a Malaysian expense-claims system. ' +
  'Always reply with a single JSON object and nothing else.';

const RECEIPT_USER_PROMPT = [
  'Read this receipt image and return ONLY a JSON object with exactly these keys:',
  '{',
  '  "merchant": string | null,          // store / restaurant / company name',
  '  "date": "YYYY-MM-DD" | null,        // transaction date',
  '  "total": number | null,             // FINAL grand total paid, after tax (number only)',
  '  "currency": "MYR" | string | null,  // ISO 4217; Malaysian ringgit receipts = "MYR"',
  '  "suggestedCategory": "travel" | "meal" | "medical" | "parking" | "telephone" | "training" | "other" | null,',
  '  "invoiceNo": string | null          // receipt / invoice / order number',
  '}',
  'Category guide: meal = food/restaurant/drinks; travel = fuel/Grab/taxi/flights/hotel;',
  'parking = parking/toll; telephone = phone/internet bill; medical = clinic/pharmacy/hospital;',
  'training = course/seminar/books; otherwise "other". Use null for anything unreadable.',
].join('\n');

interface ChatCompletionPayload {
  choices?: { message?: { content?: unknown } }[];
  error?: { message?: unknown };
}

/** Read a fetch Response's error detail without ever exposing headers. */
async function httpErrorDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: unknown } };
    const msg = j?.error?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 140);
  } catch {
    /* body wasn't JSON — fall back to statusText */
  }
  return res.statusText || '';
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new OcrError('timeout', timeoutMessage);
    }
    throw new OcrError(
      'network',
      'Could not reach api.deepseek.com — check the internet connection and try again.',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract receipt fields from a preprocessed image dataUrl via DeepSeek
 * vision (JSON mode). `apiKey` must be the company's saved key — a blank key
 * is a typed 'no-key' OcrError (the button is normally disabled instead).
 */
export async function extractReceiptFields(
  dataUrl: string,
  apiKey: string,
  opts: { timeoutMs?: number } = {},
): Promise<ReceiptFields> {
  const key = apiKey.trim();
  if (!key) {
    throw new OcrError(
      'no-key',
      "No DeepSeek API key configured — add your company's key in Settings → Integrations.",
    );
  }
  const timeoutMs = opts.timeoutMs ?? 45_000;

  const res = await fetchWithTimeout(
    `${DEEPSEEK_API_BASE}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_OCR_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: RECEIPT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: RECEIPT_USER_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    },
    timeoutMs,
    `DeepSeek took longer than ${Math.round(timeoutMs / 1000)}s — try a sharper, tighter photo.`,
  );

  if (!res.ok) {
    const detail = await httpErrorDetail(res);
    const friendly =
      res.status === 401 || res.status === 403
        ? `DeepSeek rejected the API key (HTTP ${res.status}) — check it in Settings → Integrations.`
        : `DeepSeek request failed (HTTP ${res.status})${detail ? ` — ${detail}` : ''}`;
    throw new OcrError('http', friendly, res.status);
  }

  let content: unknown;
  try {
    const payload = (await res.json()) as ChatCompletionPayload;
    content = payload.choices?.[0]?.message?.content;
  } catch {
    throw new OcrError('parse', 'DeepSeek returned an unreadable response — please try again.');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new OcrError('parse', 'DeepSeek returned an empty response — please try again.');
  }
  const fields = parseReceiptJson(content);
  if (!fields) {
    throw new OcrError(
      'parse',
      'The AI reply was not valid JSON — please try again with a sharper photo.',
    );
  }
  return fields;
}

export interface DeepSeekTestResult {
  ok: true;
  /** Model ids the key can access (e.g. ['deepseek-chat', 'deepseek-flash']). */
  models: string[];
}

/**
 * Test-connection probe for Settings → Integrations: GET /v1/models with the
 * key. Resolves with the accessible model ids; throws a typed OcrError
 * ('no-key' | 'http' | 'timeout' | 'network') on failure.
 */
export async function testDeepSeekConnection(
  apiKey: string,
  opts: { timeoutMs?: number } = {},
): Promise<DeepSeekTestResult> {
  const key = apiKey.trim();
  if (!key) {
    throw new OcrError('no-key', 'Save or paste a DeepSeek API key first.');
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const res = await fetchWithTimeout(
    `${DEEPSEEK_API_BASE}/models`,
    { method: 'GET', headers: { Authorization: `Bearer ${key}` } },
    timeoutMs,
    'DeepSeek did not answer within 15s — check the connection and try again.',
  );

  if (!res.ok) {
    const detail = await httpErrorDetail(res);
    const friendly =
      res.status === 401 || res.status === 403
        ? `Key rejected by DeepSeek (HTTP ${res.status}) — double-check it and try again.`
        : `DeepSeek test failed (HTTP ${res.status})${detail ? ` — ${detail}` : ''}`;
    throw new OcrError('http', friendly, res.status);
  }

  let ids: string[] = [];
  try {
    const payload = (await res.json()) as { data?: { id?: unknown }[] };
    ids = (payload.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id));
  } catch {
    /* a 200 with a non-JSON body still proves the key works */
  }
  return { ok: true, models: ids };
}
