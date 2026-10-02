/**
 * receiptScan.ts tests — claims-side mapping of AI-extracted receipt fields:
 * suggestedCategory → module UI category, prefill description building, and
 * the any-field-usable check. Pure functions, node environment.
 */
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../claimPolicy';
import { buildReceiptDescription, hasAnyReceiptField, mapReceiptCategory } from '../receiptScan';

describe('mapReceiptCategory', () => {
  it('passes exact category ids through (case/whitespace-insensitive)', () => {
    expect(mapReceiptCategory('meal')).toBe('meal');
    expect(mapReceiptCategory(' TRAVEL ')).toBe('travel');
    expect(mapReceiptCategory('Medical')).toBe('medical');
    expect(mapReceiptCategory('parking')).toBe('parking');
    expect(mapReceiptCategory('telephone')).toBe('telephone');
    expect(mapReceiptCategory('training')).toBe('training');
    expect(mapReceiptCategory('other')).toBe('other');
  });

  it('folds mileage into travel (km can never come off a receipt)', () => {
    expect(mapReceiptCategory('mileage')).toBe('travel');
  });

  it('maps common receipt keywords onto the claims category list', () => {
    expect(mapReceiptCategory('Food & Beverage')).toBe('meal');
    expect(mapReceiptCategory('restaurant bill')).toBe('meal');
    expect(mapReceiptCategory('Petrol station')).toBe('travel');
    expect(mapReceiptCategory('Grab ride')).toBe('travel');
    expect(mapReceiptCategory('TOLL PLAZA')).toBe('parking');
    expect(mapReceiptCategory('Klinik Sejahtera')).toBe('medical');
    expect(mapReceiptCategory('monthly phone bill')).toBe('telephone');
    expect(mapReceiptCategory('Python course fee')).toBe('training');
  });

  it('falls back to other for missing or unrecognised values', () => {
    expect(mapReceiptCategory(undefined)).toBe('other');
    expect(mapReceiptCategory('')).toBe('other');
    expect(mapReceiptCategory('   ')).toBe('other');
    expect(mapReceiptCategory('xqz miscellaneous')).toBe('other');
  });

  it('always returns a category that exists in the module list', () => {
    const ids = CATEGORIES.map((c) => c.id);
    for (const s of ['meal', 'fuel', 'toll', 'clinic', 'internet', 'seminar', 'zzz', undefined]) {
      expect(ids).toContain(mapReceiptCategory(s));
    }
  });
});

describe('buildReceiptDescription', () => {
  it('combines merchant and invoice reference', () => {
    expect(buildReceiptDescription('A&W Mid Valley', 'A-0012')).toBe('A&W Mid Valley — Inv A-0012');
  });

  it('appends a currency note for non-MYR receipts only', () => {
    expect(buildReceiptDescription('Changi Shop', 'R9', 'SGD')).toBe(
      'Changi Shop — Inv R9 (receipt currency: SGD)',
    );
    expect(buildReceiptDescription('A&W', 'A-1', 'MYR')).toBe('A&W — Inv A-1');
  });

  it('handles partial input and trims whitespace', () => {
    expect(buildReceiptDescription('  Shell  ', undefined)).toBe('Shell');
    expect(buildReceiptDescription(undefined, ' 0012 ')).toBe('Inv 0012');
    expect(buildReceiptDescription(undefined, undefined, 'usd')).toBe('(receipt currency: USD)');
    expect(buildReceiptDescription()).toBe('');
  });
});

describe('hasAnyReceiptField', () => {
  it('is false for an empty extraction and true when anything usable arrived', () => {
    expect(hasAnyReceiptField({})).toBe(false);
    expect(hasAnyReceiptField({ merchant: 'A&W' })).toBe(true);
    expect(hasAnyReceiptField({ total: 12.5 })).toBe(true);
    expect(hasAnyReceiptField({ invoiceNo: 'A-1' })).toBe(true);
  });
});
