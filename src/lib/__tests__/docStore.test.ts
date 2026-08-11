/**
 * docStore tests (P1 — deep-audit item 9): put/get/remove round-trip, the
 * gzip-when-beneficial path, per-doc + per-tenant quota guards (typed
 * DocQuotaError), raw localStorage quota-throw conversion, tenant isolation,
 * legacy inline-dataUrl migration for both onboarding submissions and
 * employee record files, and registry membership. In-memory storage stub,
 * same style as the other lib suites.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './storageStub';
import { COLLECTIONS, exportTenantData, getCollection, setActiveTenantId, setCollection, upsertCompany } from '../db';
import { companySeedRecord } from '../tenants';
import {
  DOC_BYTES_COLLECTION,
  MAX_DOC_BYTES,
  TENANT_DOC_BUDGET_BYTES,
  DocQuotaError,
  bytesToBase64,
  estimateRawBytes,
  getDoc,
  putDoc,
  removeDoc,
  usageStats,
  type StoredDoc,
} from '../docStore';
import {
  attachOnboardingExtras,
  createOnboardLink,
  getOnboardDocumentDataUrl,
  getOnboardingExtras,
  getSubmission,
  submitOnboardForm,
  type OnboardDraft,
} from '../onboardLinks';
import {
  EMPLOYEE_RECORDS_COLLECTION,
  getRecordDocumentDataUrl,
  getRecordFile,
  removeDocument,
  saveDocument,
  type EmployeeRecordFile,
} from '../employeeRecords';

const CO = 'co-asm';
const CO_B = 'co-merdeka';

beforeEach(() => {
  installLocalStorage();
  // companySeedRecord keeps the tenant directory truthful for link creation.
  upsertCompany(companySeedRecord(CO));
  setActiveTenantId(CO);
});

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

/** Canonical base64 dataUrl from plain text (Unicode-safe). */
function textDataUrl(text: string, mime = 'text/plain'): string {
  return `data:${mime};base64,${bytesToBase64(new TextEncoder().encode(text))}`;
}

/** Canonical base64 dataUrl from random (incompressible) bytes. */
function randomDataUrl(size: number): string {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i += 65_536) {
    crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65_536, bytes.length)));
  }
  return `data:application/octet-stream;base64,${bytesToBase64(bytes)}`;
}

function storedDocs(tenant: string = CO): StoredDoc[] {
  return getCollection<StoredDoc>(DOC_BYTES_COLLECTION, tenant);
}

function makeDraft(documents: OnboardDraft['documents']): OnboardDraft {
  return {
    personal: {
      name: 'Aisyah binti Rahman',
      ic: '950312-10-5566',
      dob: '1995-03-12',
      gender: 'female',
      maritalStatus: 'single',
      phone: '012-3456789',
      email: 'aisyah@example.com',
      address: 'No. 12, Jalan SS 2/1, 47300 Petaling Jaya',
      state: 'SGR',
      nationality: 'Malaysian',
      bankName: 'Maybank',
      bankAccount: '162012345678',
    },
    emergencyContacts: [{ name: 'Rahman bin Ali', relation: 'Father', phone: '019-9998887' }],
    academics: [
      { level: 'Degree', institution: 'Universiti Malaya', course: 'BSc CS', fromYear: '2014', toYear: '2018' },
    ],
    employment: { joinDate: '2026-03-02', employmentType: 'full-time' },
    documents,
    declarationAccepted: true,
  };
}

/* ── Round-trip ────────────────────────────────────────────────────────────── */

describe('put/get/remove round-trip', () => {
  it('stores and returns an identical dataUrl (small payload stays verbatim)', async () => {
    const dataUrl = 'data:image/jpeg;base64,QUJD';
    const docId = await putDoc({ bytes: dataUrl }, CO);

    expect(await getDoc(docId, CO)).toBe(dataUrl);
    const rec = storedDocs()[0]!;
    expect(rec.id).toBe(docId);
    expect(rec.gzip).toBe(false); // tiny payloads don't benefit from gzip
    expect(rec.mime).toBe('image/jpeg');
    expect(rec.storedBytes).toBe(rec.data.length);
    expect(rec.rawBytes).toBe(3);
  });

  it('gzips compressible payloads when smaller and round-trips exactly', async () => {
    const dataUrl = textDataUrl('A'.repeat(300_000));
    const docId = await putDoc({ bytes: dataUrl, fileName: 'scan.txt' }, CO);

    const rec = storedDocs()[0]!;
    expect(rec.gzip).toBe(true);
    // gzip crushes repetitive text: stored payload is a tiny fraction.
    expect(rec.storedBytes).toBeLessThan(dataUrl.length / 10);
    expect(await getDoc(docId, CO)).toBe(dataUrl); // byte-identical rebuild
    expect(usageStats(CO).bytes).toBe(rec.storedBytes);
  });

  it('keeps incompressible payloads verbatim (gzip never expands storage)', async () => {
    const dataUrl = randomDataUrl(50_000);
    const docId = await putDoc({ bytes: dataUrl }, CO);

    const rec = storedDocs()[0]!;
    expect(rec.gzip).toBe(false);
    expect(rec.data).toBe(dataUrl);
    expect(await getDoc(docId, CO)).toBe(dataUrl);
  });

  it('removeDoc deletes the payload; unknown ids are a silent no-op', async () => {
    const docId = await putDoc({ bytes: textDataUrl('hello world') }, CO);
    expect(usageStats(CO).count).toBe(1);

    await removeDoc(docId, CO);
    expect(await getDoc(docId, CO)).toBeUndefined();
    expect(usageStats(CO)).toEqual({ count: 0, bytes: 0 });

    const before = localStorage.getItem(`myhrms:t:${CO}:${DOC_BYTES_COLLECTION}`);
    await removeDoc('no-such-doc', CO);
    expect(localStorage.getItem(`myhrms:t:${CO}:${DOC_BYTES_COLLECTION}`)).toBe(before);
  });

  it('getDoc returns undefined for unknown ids', async () => {
    expect(await getDoc('nope', CO)).toBeUndefined();
  });
});

/* ── Quota guards ──────────────────────────────────────────────────────────── */

describe('quota guards', () => {
  it('rejects documents over the per-doc cap with a typed friendly error', async () => {
    // 750 KB of raw bytes (guard runs pre-compression on the raw estimate).
    const big = textDataUrl('B'.repeat(750 * 1024));
    await expect(putDoc({ bytes: big, fileName: 'big.txt' }, CO)).rejects.toMatchObject({
      name: 'DocQuotaError',
      kind: 'per-doc',
      limitBytes: MAX_DOC_BYTES,
    });
    expect(storedDocs()).toHaveLength(0);

    // Explicit sizeBytes is trusted the same way.
    await expect(
      putDoc({ bytes: textDataUrl('tiny'), sizeBytes: MAX_DOC_BYTES + 1 }, CO),
    ).rejects.toBeInstanceOf(DocQuotaError);
    try {
      await putDoc({ bytes: textDataUrl('tiny'), sizeBytes: MAX_DOC_BYTES + 1, fileName: 'x.pdf' }, CO);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DocQuotaError);
      expect((err as Error).message).toContain('700 KB');
      expect((err as Error).message).toContain('x.pdf');
    }
  });

  it('enforces the per-tenant budget with usage info on the error', async () => {
    // Seed the tenant just 50 KB under the ~3 MB budget.
    const seeded: StoredDoc = {
      id: 'seed-1',
      mime: 'text/plain',
      gzip: false,
      data: 'x',
      rawBytes: 1,
      storedBytes: TENANT_DOC_BUDGET_BYTES - 50_000,
      createdAt: new Date().toISOString(),
    };
    setCollection(DOC_BYTES_COLLECTION, [seeded], CO);

    // ~100 KB random → ~133 KB stored → over the remaining 50 KB.
    await expect(putDoc({ bytes: randomDataUrl(100_000), fileName: 'photo.jpg' }, CO)).rejects.toMatchObject({
      name: 'DocQuotaError',
      kind: 'tenant-budget',
      usage: { count: 1, bytes: TENANT_DOC_BUDGET_BYTES - 50_000 },
      limitBytes: TENANT_DOC_BUDGET_BYTES,
    });
    // Nothing was written.
    expect(storedDocs()).toHaveLength(1);
    try {
      await putDoc({ bytes: randomDataUrl(100_000) }, CO);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('Document storage is full');
      expect((err as Error).message).toContain('3.0 MB');
    }
  });

  it('accepts a document that fits the remaining budget exactly', async () => {
    const docId = await putDoc({ bytes: textDataUrl('fits fine') }, CO);
    expect(docId).toBeTruthy();
    expect(usageStats(CO).count).toBe(1);
  });

  it('converts a raw localStorage quota throw into DocQuotaError', async () => {
    const stub = installLocalStorage(); // fresh stub we can break
    setActiveTenantId(CO);
    stub.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    await expect(putDoc({ bytes: textDataUrl('doomed') }, CO)).rejects.toMatchObject({
      name: 'DocQuotaError',
      kind: 'tenant-budget',
    });
  });
});

/* ── Tenant isolation ──────────────────────────────────────────────────────── */

describe('tenant isolation of docBytes', () => {
  it('scopes payloads and usage per tenant; no cross-tenant reads', async () => {
    const urlA = textDataUrl('tenant A bytes');
    const urlB = textDataUrl('tenant B bytes — a bit longer');
    const a = await putDoc({ bytes: urlA }, CO);
    const b = await putDoc({ bytes: urlB }, CO_B);

    expect(await getDoc(a, CO)).toBe(urlA);
    expect(await getDoc(b, CO_B)).toBe(urlB);
    expect(await getDoc(a, CO_B)).toBeUndefined(); // sideways read denied
    expect(await getDoc(b, CO)).toBeUndefined();

    expect(usageStats(CO).count).toBe(1);
    expect(usageStats(CO_B).count).toBe(1);
    expect(usageStats(CO).bytes).not.toBe(usageStats(CO_B).bytes);

    // Physical keys are the standard tenant namespaces.
    expect(localStorage.getItem(`myhrms:t:${CO}:${DOC_BYTES_COLLECTION}`)).not.toBeNull();
    expect(localStorage.getItem(`myhrms:t:${CO_B}:${DOC_BYTES_COLLECTION}`)).not.toBeNull();

    // Default tenant resolution follows the active tenant.
    setActiveTenantId(CO_B);
    expect(usageStats().count).toBe(1);
    expect(await getDoc(b)).toBe(urlB);
    expect(await getDoc(a)).toBeUndefined();
  });
});

/* ── Onboarding submissions: docId drafts + legacy migration ─────────────── */

describe('onboarding submissions', () => {
  it('stores wizard drafts as metadata + docId only (no inline bytes)', async () => {
    // Simulate the wizard: bytes were putDoc'd at pick time.
    const dataUrl = 'data:image/jpeg;base64,QUJD';
    const docId = await putDoc({ bytes: dataUrl, sizeBytes: 3 }, CO);
    const link = createOnboardLink({ label: 'Aisyah', companyId: CO, createdBy: 'HR Admin' });
    const res = submitOnboardForm(
      link,
      makeDraft([
        { kind: 'IC', fileName: 'ic.jpg', docId, sizeBytes: 3, uploadedAt: '2026-02-20T01:00:00.000Z' },
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const stored = getSubmission(res.submission.id, CO)!;
    expect(stored.documents[0]!.docId).toBe(docId);
    expect('dataUrl' in stored.documents[0]!).toBe(false);
    // The operational record stays tiny — bytes are reachable via the store.
    expect(JSON.stringify(stored).length).toBeLessThan(4_000);
    expect(await getDoc(docId, CO)).toBe(dataUrl);
    // …and the extras manifest propagates the docId reference on approval.
    const extras = attachOnboardingExtras('emp-9', stored, CO);
    expect(extras.documents[0]!.docId).toBe(docId);
    expect('dataUrl' in extras.documents[0]!).toBe(false);
    expect(getOnboardingExtras('emp-9', CO)?.documents[0]!.docId).toBe(docId);
  });

  it('migrates legacy inline dataUrls to the docStore on first byte access', async () => {
    const dataUrl = 'data:image/jpeg;base64,QUJD';
    const link = createOnboardLink({ label: 'Aisyah', companyId: CO, createdBy: 'HR Admin' });
    const res = submitOnboardForm(
      link,
      makeDraft([
        { kind: 'IC', fileName: 'ic.jpg', dataUrl, sizeBytes: 3, uploadedAt: '2026-02-20T01:00:00.000Z' },
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Legacy shape on disk: inline bytes, no docId.
    const legacy = getSubmission(res.submission.id, CO)!;
    expect(legacy.documents[0]!.dataUrl).toBe(dataUrl);
    expect(legacy.documents[0]!.docId).toBeUndefined();
    expect(storedDocs()).toHaveLength(0);

    // First byte access: transparent read + migration.
    const back = await getOnboardDocumentDataUrl(CO, res.submission.id, legacy.documents[0]!);
    expect(back).toBe(dataUrl);

    const migrated = getSubmission(res.submission.id, CO)!;
    expect(migrated.documents[0]!.docId).toBeTruthy();
    expect('dataUrl' in migrated.documents[0]!).toBe(false);
    expect(storedDocs()).toHaveLength(1);

    // Second access reads the store; still exactly one stored payload.
    const again = await getOnboardDocumentDataUrl(CO, res.submission.id, migrated.documents[0]!);
    expect(again).toBe(dataUrl);
    expect(storedDocs()).toHaveLength(1);
  });
});

/* ── Employee records: docId saves + legacy migration ────────────────────── */

describe('employee record files', () => {
  it('saveDocument strips any inline copy when a docId is provided', async () => {
    const dataUrl = 'data:application/pdf;base64,QUJDRA==';
    const docId = await putDoc({ bytes: dataUrl, sizeBytes: 3 }, CO);
    saveDocument(
      'emp-1',
      { kind: 'IC', fileName: 'ic.pdf', docId, dataUrl, sizeBytes: 3 },
      'hr',
    );
    const doc = getRecordFile('emp-1')!.documents[0]!;
    expect(doc.docId).toBe(docId);
    expect('dataUrl' in doc).toBe(false);
    expect(await getRecordDocumentDataUrl('emp-1', doc)).toBe(dataUrl);
  });

  it('migrates legacy inline record documents on first byte access', async () => {
    const dataUrl = 'data:application/pdf;base64,QUJDRA==';
    saveDocument('emp-1', { kind: 'IC', fileName: 'ic.pdf', dataUrl, sizeBytes: 3 }, 'hr');
    const legacy = getRecordFile('emp-1')!.documents[0]!;
    expect(legacy.dataUrl).toBe(dataUrl);
    expect(storedDocs()).toHaveLength(0);

    const back = await getRecordDocumentDataUrl('emp-1', legacy);
    expect(back).toBe(dataUrl);

    const migrated = getRecordFile('emp-1')!.documents[0]!;
    expect(migrated.docId).toBeTruthy();
    expect('dataUrl' in migrated).toBe(false);
    expect(storedDocs()).toHaveLength(1);

    // Idempotent: repeat access keeps a single stored payload.
    expect(await getRecordDocumentDataUrl('emp-1', migrated)).toBe(dataUrl);
    expect(storedDocs()).toHaveLength(1);

    // Migration is a silent storage move — no document audit spam.
    const files = getCollection<EmployeeRecordFile>(EMPLOYEE_RECORDS_COLLECTION, CO);
    expect(files[0]!.documents[0]!.docId).toBe(migrated.docId);
  });

  it('removeDocument also frees the docStore bytes', async () => {
    const docId = await putDoc({ bytes: textDataUrl('contract v1'), sizeBytes: 11 }, CO);
    saveDocument('emp-1', { kind: 'Contract', fileName: 'c.pdf', docId, sizeBytes: 11 }, 'hr');
    expect(usageStats(CO).count).toBe(1);

    removeDocument('emp-1', getRecordFile('emp-1')!.documents[0]!.id, 'c.pdf', 'hr');
    expect(getRecordFile('emp-1')!.documents).toHaveLength(0);
    expect(usageStats(CO)).toEqual({ count: 0, bytes: 0 });
    expect(await getDoc(docId, CO)).toBeUndefined();
  });
});

/* ── Registry membership ─────────────────────────────────────────────────── */

describe('registry integration', () => {
  it('docBytes is a first-class COLLECTIONS member and exports per tenant', async () => {
    expect(COLLECTIONS).toContain(DOC_BYTES_COLLECTION);
    await putDoc({ bytes: textDataUrl('export me') }, CO);
    const data = exportTenantData(CO);
    expect(Object.keys(data)).toContain(DOC_BYTES_COLLECTION);
    expect(data[DOC_BYTES_COLLECTION]).toHaveLength(1);
    expect(estimateRawBytes('data:text/plain;base64,QUJD')).toBe(3);
  });
});
