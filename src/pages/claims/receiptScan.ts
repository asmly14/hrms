/**
 * AI receipt-scan helpers for the claims form — the claims-side half of
 * lib/ocr.ts. Maps the model's free-text `suggestedCategory` onto the module
 * category list (CATEGORIES in claimPolicy.ts) and builds the prefill
 * description from extracted merchant / invoice / currency fields.
 *
 * Kept pure and DOM-free so the mapping is unit-testable in the node project.
 */
import type { ReceiptFields } from '@/lib/ocr';
import type { UiCategory } from './claimPolicy';

/**
 * Keyword rules tried in order — first match wins. The model is prompted with
 * the exact category tokens, so exact ids short-circuit before keywords.
 * 'mileage' is deliberately NOT a target: km can never come off a receipt, so
 * mileage-ish hints fold into the parent 'travel' category.
 */
const CATEGORY_KEYWORDS: [UiCategory, RegExp][] = [
  ['meal', /\b(meal|food|restaurant|restoran|f&b|dining|lunch|dinner|breakfast|cafe|coffee|makan)\b/i],
  ['travel', /\b(travel|fuel|petrol|gas|grab|taxi|eksi|flight|airline|hotel|transport|train|ktm|lrt|mrt|bus|fare|mileage)\b/i],
  ['parking', /\b(parking|toll|tol)\b/i],
  ['telephone', /\b(phone|telephone|telecom|telco|internet|mobile|broadband|maxis|celcom|digi|unifi)\b/i],
  ['medical', /\b(medical|clinic|klinik|pharmacy|farmasi|hospital|dental|medic|doctor)\b/i],
  ['training', /\b(training|course|seminar|workshop|book|conference|certification)\b/i],
];

const UI_CATEGORY_IDS: readonly UiCategory[] = [
  'travel', 'mileage', 'meal', 'medical', 'telephone', 'parking', 'training', 'other',
];

/**
 * Map the AI's suggested category onto a claims UI category. Exact category
 * ids win ('mileage' folds into 'travel'); then keyword rules; anything
 * unrecognised (or missing) becomes 'other' — the field stays editable.
 */
export function mapReceiptCategory(suggested?: string): UiCategory {
  const s = (suggested ?? '').trim().toLowerCase();
  if (!s) return 'other';
  if ((UI_CATEGORY_IDS as readonly string[]).includes(s)) {
    return s === 'mileage' ? 'travel' : (s as UiCategory);
  }
  for (const [cat, re] of CATEGORY_KEYWORDS) {
    if (re.test(s)) return cat;
  }
  return 'other';
}

/**
 * Build the prefill description from extracted fields:
 *   'A&W Mid Valley — Inv 001234 (receipt currency: USD)'
 * The currency note is only added for non-MYR receipts (the claim amount is
 * always entered in RM). Empty when nothing usable was extracted.
 */
export function buildReceiptDescription(
  merchant?: string,
  invoiceNo?: string,
  currency?: string,
): string {
  const parts: string[] = [];
  const m = merchant?.trim();
  if (m) parts.push(m);
  const inv = invoiceNo?.trim();
  if (inv) parts.push(`Inv ${inv}`);
  let out = parts.join(' — ');
  const cur = currency?.trim().toUpperCase();
  if (cur && cur !== 'MYR') {
    out += `${out ? ' ' : ''}(receipt currency: ${cur})`;
  }
  return out.trim();
}

/** true when the extraction returned at least one usable field. */
export function hasAnyReceiptField(f: ReceiptFields): boolean {
  return Boolean(
    f.merchant || f.date || f.total != null || f.currency || f.suggestedCategory || f.invoiceNo,
  );
}
