/**
 * Per-tenant document byte store (P1 — deep-audit item 9).
 *
 * Why this exists
 * ───────────────
 * Document bytes used to be inlined as base64 dataUrls inside
 * `onboardSubmissions` and `employeeRecords` records. Base64 inflates bytes by
 * ~4/3, so one 700 KB file ≈ 934 KB of stored text and a single 5-document
 * onboarding ≈ 4.7 MB — effectively the entire ~5 MB localStorage origin
 * budget for ONE employee, with quota failures surfacing only as a bare
 * setItem exception (and only submitOnboardForm caught it).
 *
 * Bytes now live in a dedicated registry collection — physically
 * `myhrms:t:<companyId>:docBytes` — and operational records carry metadata +
 * a `docId` reference only. The store:
 *
 *   • gzips the DECODED bytes via CompressionStream when that actually shrinks
 *     the payload (great for scans/PDF text, skipped for already-compressed
 *     images — the smaller of the two encodings is kept, flagged `gzip`);
 *   • enforces two hard quota guards with a friendly typed DocQuotaError:
 *     per-document (700 KB raw, mirroring the upload caps) and a per-tenant
 *     document budget (~3 MB of stored payload across all docs);
 *   • exposes usageStats for the "storage used" UI indicator;
 *   • stays tenant-isolated through the standard db.ts key machinery, so
 *     export/import, legacy migration and seed init cover it automatically.
 *
 * Operational records (submissions, personnel files) keep a `docId` and load
 * bytes lazily through getDoc; legacy inline `dataUrl` entries migrate here
 * on first byte access (see getOnboardDocumentDataUrl /
 * getRecordDocumentDataUrl in the owning modules — migration persistence is
 * module-owned so this store never imports its consumers).
 */
import { getCollection, setCollection, uid, useCollection } from './db';

/* ────────────────────────────────────────────────────────────
 * Constants & types
 * ──────────────────────────────────────────────────────────── */

/** Registry collection name (member of db.ts COLLECTIONS). */
export const DOC_BYTES_COLLECTION = 'docBytes' as const;

/** Per-document raw-byte cap — mirrors the upload UIs' 700 KB file limit. */
export const MAX_DOC_BYTES = 700 * 1024;
export const MAX_DOC_LABEL = '700 KB';

/**
 * Per-tenant budget across ALL stored document payloads (~3 MB). Leaves
 * headroom inside the ~5 MB origin budget for the operational collections.
 */
export const TENANT_DOC_BUDGET_BYTES = 3 * 1024 * 1024;
export const TENANT_DOC_BUDGET_LABEL = '3 MB';

/** One stored document payload. `id` is the docId records reference. */
export interface StoredDoc {
  id: string;
  /** MIME type parsed from the dataUrl (used to rebuild it on read). */
  mime: string;
  /** true → data is base64(gzip(rawBytes)); false → data is the dataUrl verbatim. */
  gzip: boolean;
  data: string;
  /** Estimated original file size in bytes. */
  rawBytes: number;
  /** Persisted payload size (data.length) — what the tenant budget accounts. */
  storedBytes: number;
  createdAt: string; // ISO datetime
}

export interface DocUsage {
  count: number;
  bytes: number;
}

export type DocQuotaKind = 'per-doc' | 'tenant-budget';

/**
 * Friendly typed quota failure. `usage`/`limitBytes` let the UI render "x of
 * y used" without re-reading storage; `message` is already user-safe.
 */
export class DocQuotaError extends Error {
  override readonly name = 'DocQuotaError';
  readonly kind: DocQuotaKind;
  readonly usage: DocUsage;
  readonly limitBytes: number;

  constructor(
    kind: DocQuotaKind,
    opts: { usage: DocUsage; limitBytes: number; fileName?: string; rawBytes?: number },
  ) {
    super(
      kind === 'per-doc'
        ? `"${opts.fileName ?? 'This file'}" is about ${Math.round(
            (opts.rawBytes ?? 0) / 1024,
          ).toLocaleString()} KB — the per-document limit is ${MAX_DOC_LABEL}. Compress it or choose a smaller file.`
        : `Document storage is full — ${fmtDocBytes(opts.usage.bytes)} of ${fmtDocBytes(
            opts.limitBytes,
          )} used across ${opts.usage.count} document(s). Remove old documents first, then try again.`,
    );
    this.kind = kind;
    this.usage = opts.usage;
    this.limitBytes = opts.limitBytes;
  }
}

/** Compact KB/MB label used in quota messages. */
export function fmtDocBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/* ────────────────────────────────────────────────────────────
 * Codec helpers (base64 ↔ bytes, gzip via CompressionStream)
 * ──────────────────────────────────────────────────────────── */

/** Parse a base64 dataUrl into its MIME type and payload. */
export function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m || !m[2]) return null;
  return { mime: m[1] || 'application/octet-stream', base64: m[3] ?? '' };
}

/** Estimated decoded byte size of a dataUrl payload. */
export function estimateRawBytes(dataUrl: string): number {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return dataUrl.length;
  const b64 = parsed.base64.replace(/\s/g, '');
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // spread-arg safe chunk size
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Copy into a fresh ArrayBuffer (BlobPart typing is strict about buffers). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

function supportsGzip(): boolean {
  return (
    typeof CompressionStream === 'function' &&
    typeof DecompressionStream === 'function' &&
    typeof Blob === 'function' &&
    typeof Response === 'function'
  );
}

async function gzipBytes(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(raw)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(gz)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ────────────────────────────────────────────────────────────
 * Store API
 * ──────────────────────────────────────────────────────────── */

function readDocs(tenantId?: string): StoredDoc[] {
  return getCollection<StoredDoc>(DOC_BYTES_COLLECTION, tenantId);
}

/** Stored-payload usage for a tenant (default: active). Synchronous. */
export function usageStats(tenantId?: string): DocUsage {
  const docs = readDocs(tenantId);
  return {
    count: docs.length,
    bytes: docs.reduce((sum, d) => sum + (d.storedBytes ?? 0), 0),
  };
}

/**
 * Store a document's bytes and return its docId.
 *
 * `bytes` is a base64 dataUrl (FileReader.readAsDataURL output). The decoded
 * bytes are gzipped when that produces a smaller payload; otherwise the
 * dataUrl is stored verbatim. Throws DocQuotaError on the per-doc cap or the
 * per-tenant budget (and converts a raw localStorage quota throw into the
 * same friendly type).
 */
export async function putDoc(
  input: { bytes: string; mime?: string; sizeBytes?: number; fileName?: string },
  tenantId?: string,
): Promise<string> {
  const { bytes } = input;
  if (typeof bytes !== 'string' || bytes.length === 0) {
    throw new Error('putDoc: bytes must be a non-empty data URL string');
  }
  const parsed = parseDataUrl(bytes);
  const mime = input.mime ?? parsed?.mime ?? 'application/octet-stream';
  const rawBytes = input.sizeBytes ?? estimateRawBytes(bytes);

  // Guard 1 — per-document cap (raw, pre-compression bytes).
  if (rawBytes > MAX_DOC_BYTES) {
    throw new DocQuotaError('per-doc', {
      usage: usageStats(tenantId),
      limitBytes: MAX_DOC_BYTES,
      fileName: input.fileName,
      rawBytes,
    });
  }

  // Choose the smaller encoding: gzip(decoded) re-base64'd vs the verbatim
  // dataUrl. Gzip failures (or no stream support) fall back to verbatim.
  let gzip = false;
  let data = bytes;
  if (parsed && supportsGzip()) {
    try {
      const gz = await gzipBytes(base64ToBytes(parsed.base64));
      const gzB64 = bytesToBase64(gz);
      if (gzB64.length < bytes.length) {
        gzip = true;
        data = gzB64;
      }
    } catch {
      /* keep the verbatim payload */
    }
  }

  const record: StoredDoc = {
    id: uid(),
    mime,
    gzip,
    data,
    rawBytes,
    storedBytes: data.length,
    createdAt: new Date().toISOString(),
  };

  // Guard 2 — per-tenant budget across all stored payloads.
  const all = readDocs(tenantId);
  const usage: DocUsage = {
    count: all.length,
    bytes: all.reduce((sum, d) => sum + (d.storedBytes ?? 0), 0),
  };
  if (usage.bytes + record.storedBytes > TENANT_DOC_BUDGET_BYTES) {
    throw new DocQuotaError('tenant-budget', {
      usage,
      limitBytes: TENANT_DOC_BUDGET_BYTES,
      fileName: input.fileName,
    });
  }

  try {
    setCollection(DOC_BYTES_COLLECTION, [...all, record], tenantId);
  } catch {
    // Raw localStorage quota throw → same friendly type, fresh usage numbers.
    throw new DocQuotaError('tenant-budget', {
      usage: usageStats(tenantId),
      limitBytes: TENANT_DOC_BUDGET_BYTES,
      fileName: input.fileName,
    });
  }
  return record.id;
}

/**
 * Read a document back as a dataUrl (identical to what was putDoc'd).
 * Undefined when the docId is unknown in this tenant.
 */
export async function getDoc(docId: string, tenantId?: string): Promise<string | undefined> {
  const record = readDocs(tenantId).find((d) => d.id === docId);
  if (!record) return undefined;
  if (!record.gzip) return record.data;
  const raw = await gunzipBytes(base64ToBytes(record.data));
  return `data:${record.mime};base64,${bytesToBase64(raw)}`;
}

/** Remove a document. Unknown docIds are a silent no-op (no write, no notify). */
export async function removeDoc(docId: string, tenantId?: string): Promise<void> {
  const all = readDocs(tenantId);
  if (!all.some((d) => d.id === docId)) return;
  setCollection(
    DOC_BYTES_COLLECTION,
    all.filter((d) => d.id !== docId),
    tenantId,
  );
}

/* ────────────────────────────────────────────────────────────
 * Reactive usage (the "storage used" indicator)
 * ──────────────────────────────────────────────────────────── */

export interface DocUsageWithLimit extends DocUsage {
  limitBytes: number;
  /** 0–100, for progress bars. */
  percent: number;
}

/** Reactive tenant doc usage — re-reads on every docBytes write (active tenant). */
export function useDocUsage(): DocUsageWithLimit {
  const { items } = useCollection<StoredDoc>(DOC_BYTES_COLLECTION);
  const bytes = items.reduce((sum, d) => sum + (d.storedBytes ?? 0), 0);
  return {
    count: items.length,
    bytes,
    limitBytes: TENANT_DOC_BUDGET_BYTES,
    percent: Math.min(100, Math.round((bytes / TENANT_DOC_BUDGET_BYTES) * 100)),
  };
}
