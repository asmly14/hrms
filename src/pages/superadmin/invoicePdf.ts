/**
 * Printable invoice PDF for the SaaS owner → tenant billing flow.
 *
 * A4 portrait TAX INVOICE rendered with jsPDF (DYNAMICALLY imported, so the
 * ~400 kB parser only loads when the SuperAdmin actually downloads an
 * invoice — same convention as lib/payrollReportPdf.ts).
 *
 * Layout: brand header + status stamp (PAID / OVERDUE / ISSUED / DRAFT /
 * VOID), Bill-To block composed from the Company record (name, SSM reg no,
 * HQ state — Company carries no street-address field, documented gap),
 * invoice meta, line items, subtotal → discount → SST → total, and a
 * bank-transfer payment-instructions block (reference = invoice number).
 *
 * `renderInvoicePdf` returns the doc WITHOUT saving so node tests can inspect
 * it; `downloadInvoicePdf` saves `INV-2026-0001.pdf`.
 */
import type { jsPDF as JsPdfDoc } from 'jspdf';
import { getCompany } from '@/lib/db';
import { states } from '@/lib/holidays';
import { fmtDate, fmtRM } from '@/lib/utils';
import type { Company } from '@/lib/types';
import { invoiceStatusOf, PLAN_CATALOG, type Invoice, type InvoiceStatus } from '@/lib/billing';

/** SaaS owner identity printed as the invoice issuer (demo entity). */
export const BILLING_FROM = {
  name: 'MyHRMS Sdn Bhd',
  regNo: '202001234567 (SA0123456-A)',
  sstNo: 'SST Reg. No: B16-2403-32000001 (demo)',
  address: 'Level 10, Menara Demo, 50050 Kuala Lumpur, Malaysia',
  email: 'billing@myhrms.example',
} as const;

/** Demo bank-transfer rails for the payment-instructions block. */
export const PAYMENT_INSTRUCTIONS = {
  bank: 'Maybank Islamic Berhad',
  accountName: 'MyHRMS Sdn Bhd',
  accountNo: '5628 1234 5678',
  referenceNote: 'Use the invoice number as the payment reference.',
} as const;

export interface InvoicePdfModel {
  invoice: Invoice;
  companyName: string;
  companyRegNo: string;
  /** e.g. 'Kuala Lumpur, Malaysia' — Company has no street field. */
  companyLocation: string;
  planLabel: string;
  /** Derived status driving the stamp (overdue is computed, not stored). */
  status: InvoiceStatus;
}

/** Compose the render model from an invoice + the company directory. */
export function invoicePdfModel(invoice: Invoice, now: Date = new Date()): InvoicePdfModel {
  const company: Company | undefined = getCompany(invoice.companyId);
  const stateName = company
    ? (states.find((s) => s.code === company.hqState)?.name ?? company.hqState)
    : '';
  return {
    invoice,
    companyName: company?.name ?? invoice.companyId,
    companyRegNo: company?.regNo ?? '',
    companyLocation: company ? `${stateName}, Malaysia` : '',
    planLabel: PLAN_CATALOG[invoice.lines[0] ? planFromLines(invoice) : 'free']?.label ?? '',
    status: invoiceStatusOf(invoice, now),
  };
}

/** Best-effort plan detection from the line description (display label only). */
function planFromLines(invoice: Invoice): keyof typeof PLAN_CATALOG {
  const d = invoice.lines[0]?.description.toLowerCase() ?? '';
  if (d.includes('enterprise')) return 'enterprise';
  if (d.includes('pro plan')) return 'pro';
  return 'free';
}

const STATUS_STAMP: Record<InvoiceStatus, { label: string; rgb: [number, number, number] }> = {
  paid: { label: 'PAID', rgb: [101, 163, 13] }, // lime-600
  overdue: { label: 'OVERDUE', rgb: [220, 38, 38] }, // red-600
  issued: { label: 'ISSUED', rgb: [217, 119, 6] }, // amber-600
  draft: { label: 'DRAFT', rgb: [120, 113, 108] }, // stone-500
  void: { label: 'VOID', rgb: [120, 113, 108] },
};

/** Grouped money — '12,345.67' (RM prefix is in the column header). */
function plain(n: number): string {
  return n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Wrap text to a width at the current font size; returns the lines used. */
function wrap(doc: JsPdfDoc, text: string, maxW: number): string[] {
  return doc.splitTextToSize(text, maxW) as string[];
}

/**
 * Render the invoice into a jsPDF document WITHOUT saving (node-testable).
 */
export async function renderInvoicePdf(model: InvoicePdfModel): Promise<JsPdfDoc> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const { invoice } = model;
  const W = 210;
  const M = 16; // margin
  const CW = W - M * 2; // 178 content width
  const amber: [number, number, number] = [180, 83, 9];
  let y = M;

  // ── Header band ──────────────────────────────────────────────────────────
  doc.setFillColor(amber[0], amber[1], amber[2]);
  doc.rect(0, 0, W, 3, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(amber[0], amber[1], amber[2]);
  doc.text('MyHRMS', M, y + 6);
  doc.setFontSize(20);
  doc.setTextColor(41, 37, 36);
  doc.text('TAX INVOICE', W - M, y + 6, { align: 'right' });
  y += 12;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(87, 83, 78);
  doc.text(`${BILLING_FROM.name} · ${BILLING_FROM.regNo}`, M, y);
  doc.text(invoice.invoiceNo, W - M, y, { align: 'right' });
  y += 4.5;
  doc.text(`${BILLING_FROM.address} · ${BILLING_FROM.sstNo}`, M, y);
  doc.text(`Period ${invoice.period}`, W - M, y, { align: 'right' });
  y += 7;

  // ── Status stamp ─────────────────────────────────────────────────────────
  const stamp = STATUS_STAMP[model.status];
  doc.setDrawColor(...stamp.rgb);
  doc.setTextColor(...stamp.rgb);
  doc.setLineWidth(0.7);
  const stampW = 34;
  doc.roundedRect(W - M - stampW, y - 2, stampW, 9, 1.5, 1.5);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(stamp.label, W - M - stampW / 2, y + 4, { align: 'center' });
  doc.setLineWidth(0.2);

  // ── Bill To + meta columns ───────────────────────────────────────────────
  doc.setFontSize(8);
  doc.setTextColor(120, 113, 108);
  doc.text('BILL TO', M, y);
  doc.text('DETAILS', W - M - 62, y);
  y += 4.5;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(41, 37, 36);
  doc.text(model.companyName, M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const metaRows: [string, string][] = [
    ['Issued', fmtDate(invoice.issuedAt)],
    ['Due', fmtDate(invoice.dueAt)],
    ['Plan', `${model.planLabel} (${invoice.lines[0]?.qty ?? 0} seats)`],
    [
      invoice.status === 'paid' ? 'Paid' : 'Status',
      invoice.status === 'paid' && invoice.paidAt
        ? `${fmtDate(invoice.paidAt)} · ${invoice.paymentMethod ?? ''}`
        : stamp.label,
    ],
  ];
  metaRows.forEach(([k, v], i) => {
    doc.setTextColor(120, 113, 108);
    doc.text(k, W - M - 62, y + i * 5);
    doc.setTextColor(41, 37, 36);
    doc.text(v, W - M, y + i * 5, { align: 'right' });
  });
  y += 5;
  doc.setTextColor(87, 83, 78);
  if (model.companyRegNo) {
    doc.text(model.companyRegNo, M, y);
    y += 4.5;
  }
  if (model.companyLocation) {
    doc.text(model.companyLocation, M, y);
    y += 4.5;
  }
  y += 8;

  // ── Line items table ─────────────────────────────────────────────────────
  const colQty = 14;
  const colUnit = 32;
  const colAmt = 32;
  const colDesc = CW - colQty - colUnit - colAmt;
  doc.setFillColor(245, 241, 235);
  doc.rect(M, y, CW, 7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(68, 64, 60);
  doc.text('DESCRIPTION', M + 2, y + 4.6);
  doc.text('QTY', M + colDesc + colQty - 2, y + 4.6, { align: 'right' });
  doc.text('UNIT (RM)', M + colDesc + colQty + colUnit - 2, y + 4.6, { align: 'right' });
  doc.text('AMOUNT (RM)', M + CW - 2, y + 4.6, { align: 'right' });
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(41, 37, 36);
  for (const line of invoice.lines) {
    const descLines = wrap(doc, line.description, colDesc - 4);
    const rowH = Math.max(6, descLines.length * 4.2 + 1.8);
    doc.text(descLines, M + 2, y + 4);
    doc.text(String(line.qty), M + colDesc + colQty - 2, y + 4, { align: 'right' });
    doc.text(plain(line.unitPrice), M + colDesc + colQty + colUnit - 2, y + 4, { align: 'right' });
    doc.text(plain(line.amount), M + CW - 2, y + 4, { align: 'right' });
    y += rowH;
    doc.setDrawColor(231, 229, 228);
    doc.line(M, y, M + CW, y);
  }
  y += 6;

  // ── Totals block (right aligned) ─────────────────────────────────────────
  const labelX = W - M - 70;
  const valueX = W - M;
  const totalRow = (label: string, value: string, bold = false): void => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setTextColor(bold ? 41 : 87, bold ? 37 : 83, bold ? 36 : 78);
    doc.text(label, labelX, y);
    doc.text(value, valueX, y, { align: 'right' });
    y += 5;
  };
  totalRow('Subtotal', fmtRM(invoice.subtotal));
  if (invoice.discountAmount && invoice.discountAmount > 0) {
    totalRow(`Discount (${invoice.discountPercent ?? 0}%)`, `-${fmtRM(invoice.discountAmount)}`);
  }
  totalRow(`SST (${Math.round(invoice.taxRate * 100)}% service tax)`, fmtRM(invoice.tax));
  doc.setDrawColor(amber[0], amber[1], amber[2]);
  doc.setLineWidth(0.5);
  doc.line(labelX, y - 3, valueX, y - 3);
  doc.setLineWidth(0.2);
  doc.setFontSize(11);
  totalRow('TOTAL DUE', fmtRM(invoice.total), true);
  doc.setFontSize(9);
  y += 4;

  // ── Payment instructions (unpaid invoices only) ──────────────────────────
  if (model.status !== 'paid' && model.status !== 'void') {
    doc.setFillColor(255, 251, 235); // amber-50
    const boxH = 30;
    doc.roundedRect(M, y, CW, boxH, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(146, 64, 14); // amber-800
    doc.text('PAYMENT INSTRUCTIONS — BANK TRANSFER', M + 3, y + 5.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(68, 64, 60);
    doc.text(
      [
        `Bank: ${PAYMENT_INSTRUCTIONS.bank} · Account name: ${PAYMENT_INSTRUCTIONS.accountName}`,
        `Account no: ${PAYMENT_INSTRUCTIONS.accountNo} · Reference: ${invoice.invoiceNo}`,
        `${PAYMENT_INSTRUCTIONS.referenceNote} Payment is due by ${fmtDate(invoice.dueAt)} (14-day terms).`,
      ],
      M + 3,
      y + 11,
      { lineHeightFactor: 1.55 },
    );
    y += boxH + 6;
  }

  // ── Notes + footer ───────────────────────────────────────────────────────
  if (invoice.notes) {
    doc.setFontSize(8);
    doc.setTextColor(120, 113, 108);
    doc.text(wrap(doc, `Notes: ${invoice.notes}`, CW), M, y);
    y += wrap(doc, invoice.notes, CW).length * 3.6 + 4;
  }
  doc.setFontSize(8);
  doc.setTextColor(168, 162, 158);
  doc.text(
    `${BILLING_FROM.name} · ${BILLING_FROM.email} · Generated ${fmtDate(new Date().toISOString())}. This is a computer-generated invoice; no signature is required.`,
    M,
    285,
  );
  doc.setDrawColor(231, 229, 228);
  doc.line(M, 281, W - M, 281);
  return doc;
}

/** Render + save `INV-2026-0001.pdf`. Returns the file name used. */
export async function downloadInvoicePdf(invoice: Invoice): Promise<string> {
  const doc = await renderInvoicePdf(invoicePdfModel(invoice));
  const fileName = `${invoice.invoiceNo}.pdf`;
  doc.save(fileName);
  return fileName;
}
