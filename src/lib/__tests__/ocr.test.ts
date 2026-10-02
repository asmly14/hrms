/**
 * ocr.ts tests (AI receipt scanning):
 *  - per-tenant DeepSeek key storage in the 'ext:integrations' settings doc
 *    (isolation between companies, removal leaves no residue);
 *  - key masking (never more than prefix + last4);
 *  - receipt image sizing math (longest-side cap, no upscaling);
 *  - reply parsing — code fences, embedded prose, coercions, malformed input;
 *  - extractReceiptFields: success / no-key / http / timeout / network /
 *    parse paths with a mocked fetch, asserting the key reaches ONLY the
 *    Authorization header and never leaks into error messages;
 *  - testDeepSeekConnection: success + rejection paths.
 *
 * The FAKE_KEY constants are obviously-not-real placeholders so a repo-wide
 * grep proves no genuine credential is committed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorage } from './storageStub';
import { getCollection, setActiveTenantId, upsertCompany } from '../db';
import { companySeedRecord } from '../tenants';
import {
  coerceReceiptCurrency,
  coerceReceiptTotal,
  DEEPSEEK_OCR_MODEL,
  extractReceiptFields,
  getDeepSeekApiKey,
  hasOcrKey,
  INTEGRATIONS_DOC_ID,
  maskApiKey,
  normalizeReceiptDate,
  OcrError,
  parseReceiptJson,
  preprocessReceiptImage,
  receiptTargetSize,
  saveDeepSeekApiKey,
  testDeepSeekConnection,
} from '../ocr';

const CO_A = 'co-asm';
const CO_B = 'co-merdeka';

/** Obviously-fake placeholders — never genuine credentials. */
const FAKE_KEY = 'sk-FAKE-TEST-KEY-NOT-REAL';
const FAKE_KEY_B = 'sk-FAKE-TEST-KEY-B-NOT-REAL';

const DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==';

interface SettingsDocRow {
  id: string;
  kind?: string;
  deepseekApiKey?: string;
  [key: string]: unknown;
}

function integrationDocs(tenant: string): SettingsDocRow[] {
  return getCollection<SettingsDocRow>('settings', tenant).filter(
    (r) => r.id === INTEGRATIONS_DOC_ID,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function completionResponse(content: string, status = 200): Response {
  return jsonResponse({ choices: [{ message: { content } }] }, status);
}

beforeEach(() => {
  installLocalStorage();
  upsertCompany(companySeedRecord(CO_A));
  upsertCompany(companySeedRecord(CO_B));
  setActiveTenantId(CO_A);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ── Key storage ─────────────────────────────────────────────────────────── */

describe('DeepSeek key storage (ext:integrations settings doc)', () => {
  it('is empty by default', () => {
    expect(getDeepSeekApiKey()).toBeUndefined();
    expect(hasOcrKey()).toBe(false);
  });

  it('saves and reads back, with the canonical doc shape', () => {
    saveDeepSeekApiKey(FAKE_KEY);
    expect(getDeepSeekApiKey()).toBe(FAKE_KEY);
    expect(hasOcrKey()).toBe(true);
    const doc = integrationDocs(CO_A)[0];
    expect(doc).toMatchObject({ id: 'ext:integrations', kind: 'integrations' });
  });

  it('isolates keys per tenant', () => {
    saveDeepSeekApiKey(FAKE_KEY); // active tenant A
    setActiveTenantId(CO_B);
    expect(getDeepSeekApiKey()).toBeUndefined();
    expect(hasOcrKey()).toBe(false);
    // Explicit cross-tenant read still finds A's key.
    expect(getDeepSeekApiKey(CO_A)).toBe(FAKE_KEY);

    saveDeepSeekApiKey(FAKE_KEY_B); // now tenant B
    expect(getDeepSeekApiKey()).toBe(FAKE_KEY_B);
    expect(getDeepSeekApiKey(CO_A)).toBe(FAKE_KEY);
    expect(integrationDocs(CO_A)[0]!.deepseekApiKey).toBe(FAKE_KEY);
    expect(integrationDocs(CO_B)[0]!.deepseekApiKey).toBe(FAKE_KEY_B);
  });

  it('rotates an existing key in place (single doc, latest wins)', () => {
    saveDeepSeekApiKey(FAKE_KEY);
    saveDeepSeekApiKey(FAKE_KEY_B);
    expect(getDeepSeekApiKey()).toBe(FAKE_KEY_B);
    expect(integrationDocs(CO_A)).toHaveLength(1);
  });

  it('removes the key on null/blank, dropping the now-empty doc', () => {
    saveDeepSeekApiKey(FAKE_KEY);
    saveDeepSeekApiKey(null);
    expect(getDeepSeekApiKey()).toBeUndefined();
    expect(hasOcrKey()).toBe(false);
    // No residue: the empty integrations doc is deleted entirely.
    expect(integrationDocs(CO_A)).toHaveLength(0);
  });

  it('treats a whitespace-only key as removal and is a no-op when unset', () => {
    saveDeepSeekApiKey(FAKE_KEY);
    saveDeepSeekApiKey('   ');
    expect(hasOcrKey()).toBe(false);
    expect(() => saveDeepSeekApiKey(null)).not.toThrow();
    expect(() => saveDeepSeekApiKey(undefined)).not.toThrow();
  });

  it('trims surrounding whitespace on save', () => {
    saveDeepSeekApiKey(`  ${FAKE_KEY}\n`);
    expect(getDeepSeekApiKey()).toBe(FAKE_KEY);
  });
});

describe('maskApiKey', () => {
  it('shows prefix + last4 only', () => {
    expect(maskApiKey('sk-abcdef1234567890')).toBe('sk-…7890');
    expect(maskApiKey('abcdefghij')).toBe('abc…ghij');
  });

  it('fully masks short keys so no fragment leaks', () => {
    expect(maskApiKey('sk-abc')).toBe('••••');
    expect(maskApiKey('')).toBe('••••');
  });
});

/* ── Preprocess sizing math (DOM-free parts) ─────────────────────────────── */

describe('receiptTargetSize', () => {
  it('caps the longest side at maxSide, preserving aspect ratio', () => {
    expect(receiptTargetSize(3200, 2400)).toEqual({ width: 1600, height: 1200 });
    expect(receiptTargetSize(1200, 3200)).toEqual({ width: 600, height: 1600 });
  });

  it('never upscales small images', () => {
    expect(receiptTargetSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(receiptTargetSize(1600, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it('honours a custom maxSide and survives degenerate input', () => {
    expect(receiptTargetSize(4000, 2000, 1000)).toEqual({ width: 1000, height: 500 });
    expect(receiptTargetSize(0, Number.NaN)).toEqual({ width: 1600, height: 1600 });
  });
});

describe('preprocessReceiptImage (environment guard)', () => {
  it('rejects cleanly outside a browser (no canvas/DOM)', async () => {
    await expect(
      preprocessReceiptImage(new Blob(['x'], { type: 'image/png' })),
    ).rejects.toThrow(/browser/i);
  });
});

/* ── Field coercions & reply parsing ─────────────────────────────────────── */

describe('normalizeReceiptDate', () => {
  it('passes ISO through and strips a time part', () => {
    expect(normalizeReceiptDate('2025-03-05')).toBe('2025-03-05');
    expect(normalizeReceiptDate('2025-03-05T14:22:00')).toBe('2025-03-05');
  });

  it('reads Malaysian day-first numeric dates', () => {
    expect(normalizeReceiptDate('5/3/2025')).toBe('2025-03-05');
    expect(normalizeReceiptDate('05-03-2025')).toBe('2025-03-05');
    expect(normalizeReceiptDate('5.3.25')).toBe('2025-03-05');
  });

  it('reads year-first numeric dates and rejects garbage', () => {
    expect(normalizeReceiptDate('2025/3/5')).toBe('2025-03-05');
    expect(normalizeReceiptDate('2025-13-01')).toBeUndefined();
    expect(normalizeReceiptDate('not a date')).toBeUndefined();
    expect(normalizeReceiptDate(12345)).toBeUndefined();
    expect(normalizeReceiptDate(undefined)).toBeUndefined();
  });
});

describe('coerceReceiptTotal / coerceReceiptCurrency', () => {
  it('coerces totals from numbers and formatted strings', () => {
    expect(coerceReceiptTotal(45.5)).toBe(45.5);
    expect(coerceReceiptTotal('RM 45.50')).toBe(45.5);
    expect(coerceReceiptTotal('1,234.00')).toBe(1234);
    expect(coerceReceiptTotal('myr 88')).toBe(88);
    expect(coerceReceiptTotal(-3)).toBeUndefined();
    expect(coerceReceiptTotal('abc')).toBeUndefined();
    expect(coerceReceiptTotal(undefined)).toBeUndefined();
  });

  it('coerces currencies to ISO 4217 with RM → MYR', () => {
    expect(coerceReceiptCurrency('RM')).toBe('MYR');
    expect(coerceReceiptCurrency('myr')).toBe('MYR');
    expect(coerceReceiptCurrency('usd')).toBe('USD');
    expect(coerceReceiptCurrency('SGD$')).toBe('SGD');
    expect(coerceReceiptCurrency('$$')).toBeUndefined();
    expect(coerceReceiptCurrency(42)).toBeUndefined();
  });
});

describe('parseReceiptJson', () => {
  it('parses a clean JSON object', () => {
    const f = parseReceiptJson(
      '{"merchant":"A&W","date":"2025-03-05","total":12.9,"currency":"MYR","suggestedCategory":"meal","invoiceNo":"0012"}',
    );
    expect(f).toMatchObject({
      merchant: 'A&W',
      date: '2025-03-05',
      total: 12.9,
      currency: 'MYR',
      suggestedCategory: 'meal',
      invoiceNo: '0012',
    });
    expect(f?.raw).toMatchObject({ merchant: 'A&W' });
  });

  it('strips markdown code fences', () => {
    const f = parseReceiptJson('```json\n{"merchant":"Shell","total":50}\n```');
    expect(f?.merchant).toBe('Shell');
    expect(f?.total).toBe(50);
  });

  it('recovers the object when the model adds prose around it', () => {
    const f = parseReceiptJson('Here you go:\n{"merchant":"Grab","total":"RM 18.00"}\nHope that helps!');
    expect(f?.merchant).toBe('Grab');
    expect(f?.total).toBe(18);
  });

  it('returns null for malformed or non-object payloads', () => {
    expect(parseReceiptJson('not json at all')).toBeNull();
    expect(parseReceiptJson('{broken')).toBeNull();
    expect(parseReceiptJson('[1,2,3]')).toBeNull();
    expect(parseReceiptJson('"just a string"')).toBeNull();
  });

  it('accepts invoice aliases and omits unusable fields', () => {
    const f = parseReceiptJson('{"receiptNo":"R-99","total":"garbage","date":"32/13/2025"}');
    expect(f?.invoiceNo).toBe('R-99');
    expect(f?.total).toBeUndefined();
    expect(f?.date).toBeUndefined();
  });
});

/* ── extractReceiptFields (mocked fetch) ─────────────────────────────────── */

describe('extractReceiptFields', () => {
  it('fails with a typed no-key error before any network call', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(extractReceiptFields(DATA_URL, '  ')).rejects.toMatchObject({
      name: 'OcrError',
      kind: 'no-key',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('posts the image to DeepSeek chat-completions in JSON mode and parses fields', async () => {
    const spy = vi.fn().mockResolvedValue(
      completionResponse(
        '{"merchant":"A&W Mid Valley","date":"5/3/2025","total":"RM 23.90","currency":"RM","suggestedCategory":"meal","invoiceNo":"A-0012"}',
      ),
    );
    vi.stubGlobal('fetch', spy);

    const f = await extractReceiptFields(DATA_URL, FAKE_KEY);
    expect(f).toMatchObject({
      merchant: 'A&W Mid Valley',
      date: '2025-03-05',
      total: 23.9,
      currency: 'MYR',
      suggestedCategory: 'meal',
      invoiceNo: 'A-0012',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(String(init.body)) as {
      model: string;
      response_format: { type: string };
      messages: { role: string; content: unknown }[];
    };
    expect(body.model).toBe(DEEPSEEK_OCR_MODEL);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const userParts = body.messages[1]!.content as { type: string; image_url?: { url: string } }[];
    expect(userParts.some((p) => p.type === 'text')).toBe(true);
    expect(userParts.some((p) => p.type === 'image_url' && p.image_url?.url === DATA_URL)).toBe(true);
  });

  it('parses a fenced reply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(completionResponse('```json\n{"merchant":"Shell","total":80}\n```')),
    );
    const f = await extractReceiptFields(DATA_URL, FAKE_KEY);
    expect(f.merchant).toBe('Shell');
  });

  it('maps HTTP errors to a typed http error that never echoes the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'Invalid API key' } }, 401)),
    );
    const err = await extractReceiptFields(DATA_URL, FAKE_KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OcrError);
    expect((err as OcrError).kind).toBe('http');
    expect((err as OcrError).status).toBe(401);
    expect((err as OcrError).message).not.toContain(FAKE_KEY);
  });

  it('handles non-JSON HTTP error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502, statusText: 'Bad Gateway' })),
    );
    await expect(extractReceiptFields(DATA_URL, FAKE_KEY)).rejects.toMatchObject({
      kind: 'http',
      status: 502,
    });
  });

  it('times out via AbortController with a typed timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );
    const err = await extractReceiptFields(DATA_URL, FAKE_KEY, { timeoutMs: 10 }).catch(
      (e: unknown) => e,
    );
    expect((err as OcrError).kind).toBe('timeout');
    expect((err as OcrError).message).not.toContain(FAKE_KEY);
  });

  it('maps network failures to a typed network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(extractReceiptFields(DATA_URL, FAKE_KEY)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('fails with a typed parse error on non-JSON model output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completionResponse('I cannot read this.')));
    await expect(extractReceiptFields(DATA_URL, FAKE_KEY)).rejects.toMatchObject({
      kind: 'parse',
    });
  });

  it('fails with a typed parse error on an empty completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [] })));
    await expect(extractReceiptFields(DATA_URL, FAKE_KEY)).rejects.toMatchObject({
      kind: 'parse',
    });
  });
});

/* ── testDeepSeekConnection (mocked fetch) ───────────────────────────────── */

describe('testDeepSeekConnection', () => {
  it('GETs /v1/models with the key and returns model ids', async () => {
    const spy = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-flash' }] }),
    );
    vi.stubGlobal('fetch', spy);

    const res = await testDeepSeekConnection(FAKE_KEY);
    expect(res.ok).toBe(true);
    expect(res.models).toContain('deepseek-flash');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/models');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('throws a typed http error on rejection, without leaking the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'unauthorized' } }, 401)),
    );
    const err = await testDeepSeekConnection(FAKE_KEY).catch((e: unknown) => e);
    expect((err as OcrError).kind).toBe('http');
    expect((err as OcrError).message).not.toContain(FAKE_KEY);
  });

  it('requires a key', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(testDeepSeekConnection('')).rejects.toMatchObject({ kind: 'no-key' });
    expect(spy).not.toHaveBeenCalled();
  });
});
