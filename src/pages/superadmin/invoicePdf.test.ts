/**
 * Invoice PDF smoke test (node): renders a real jsPDF document from a seeded
 * company + generated invoice and verifies the output is a valid single-page
 * %PDF whose model carries the derived status stamp and bill-to fields.
 * Follows the payrollReportPdf.test.ts pattern (node build of jsPDF, no DOM).
 */
/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from '../../lib/__tests__/storageStub';
import { setCollection, upsertCompany } from '../../lib/db';
import { generateInvoice, recordPayment } from '../../lib/billing';
import { invoicePdfModel, renderInvoicePdf } from './invoicePdf';
import type { Company, Employee } from '../../lib/types';

const NOW = new Date('2026-03-10T09:00:00.000Z');

function seedCompany(): Company {
  const company: Company = {
    id: 'co-pdf',
    code: 'PDF',
    name: 'PDF Test Sdn Bhd',
    regNo: '202401009999 (9999999-X)',
    hqState: 'KUL',
    status: 'active',
    plan: 'pro',
    createdAt: '2026-01-01T00:00:00.000Z',
    branding: { logoText: 'PDF', accentColor: '#b45309' },
    config: {
      workingWeek: 'sat-sun',
      payrollCutoffDay: 25,
      claimPolicy: {},
      leaveTopUps: {},
      enabledModules: [],
      customFields: [],
      numberFormats: { employeeIdPrefix: 'PDF', payslipPrefix: 'PDF-PS' },
      orgChart: { showDottedLineReports: false },
    },
  };
  upsertCompany(company);
  setCollection(
    'employees',
    Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, status: 'active' }) as Employee),
    company.id,
  );
  return company;
}

beforeEach(() => {
  installLocalStorage();
});

describe('invoicePdf', () => {
  it('composes the bill-to model from the Company record with derived status', () => {
    seedCompany();
    const { invoice } = generateInvoice('co-pdf', '2026-03', { now: NOW })!;
    const model = invoicePdfModel(invoice, NOW);
    expect(model.companyName).toBe('PDF Test Sdn Bhd');
    expect(model.companyRegNo).toBe('202401009999 (9999999-X)');
    expect(model.companyLocation).toContain('Malaysia');
    expect(model.planLabel).toBe('Pro');
    expect(model.status).toBe('issued');
    // past dueAt → OVERDUE stamp is derived, not stored
    expect(invoicePdfModel(invoice, new Date('2026-04-01T00:00:00Z')).status).toBe('overdue');
    recordPayment(invoice.id, 'bank_transfer', NOW);
    expect(invoicePdfModel({ ...invoice, status: 'paid' }, NOW).status).toBe('paid');
  });

  it('renders a valid %PDF document via jsPDF (dynamic import)', async () => {
    seedCompany();
    const { invoice } = generateInvoice('co-pdf', '2026-03', { now: NOW })!;
    const doc = await renderInvoicePdf(invoicePdfModel(invoice, NOW));
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(4000); // real content, not an empty shell
  }, 30000);
});
