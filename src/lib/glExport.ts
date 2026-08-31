/**
 * GL export — maps a FINALIZED payroll run into a balanced double-entry
 * journal and serializes it for accounting import (Xero / QuickBooks Online /
 * generic CSV). This is the accounting bridge finance teams expect from a
 * payroll system (the deal-winner gap vs PayrollPanda/Talenox).
 *
 * Journal structure (per run; every figure comes straight from the stored
 * payslips — no rate is ever recomputed here):
 *
 *   DEBITS (expense)
 *     wagesBasic            basicPay (after proration/unpaid leave)
 *     wagesAllowance        fixed allowances total
 *     wagesOT               approved OT pay
 *     otherEarnings         ad-hoc earning adjustments (kakitangan editor)
 *     claimsExpense         approved claim reimbursements (non-statutory)
 *     epfEmployerExpense    employer EPF share
 *     socsoEmployerExpense  employer SOCSO share
 *     eisEmployerExpense    employer EIS share
 *     hrdExpense            HRD Corp levy
 *
 *   CREDITS (liability / bank)
 *     netPay                net salaries payable / bank clearing
 *     epfPayable            EPF ee + er (KWSP)
 *     socsoPayable          SOCSO ee + er (PERKESO)
 *     eisPayable            EIS ee + er (PERKESO)
 *     pcbPayable            PCB/MTD (LHDN)
 *     hrdPayable            HRD Corp levy payable
 *     cp38Payable           CP38 deduction orders (LHDN)   ┐
 *     zakatPayable          Zakat salary deductions        │ separate payable
 *     ptptnPayable          PTPTN loan repayments          │ lines per type
 *     otherDeductionsPayable custom deduction adjustments  ┘
 *
 * Balance identity (holds per payslip, therefore per run):
 *   basic + allowances + OT + otherEarnings = grossPay
 *   netPay = grossPay − eeStatutory − pcb − deductionAdjustments + claimsTotal
 *            (claimsExpense includes non-statutory cash reimbursement lines)
 *   ⇒ debits (gross + claims + erStatutory + hrd) ≡ credits
 * buildGLJournal asserts debitTotal === creditTotal and throws otherwise, so
 * an unbalanced journal can never reach an export file.
 *
 * Account mapping
 * ───────────────
 * Standard MY SME chart-of-accounts defaults, editable per company. The
 * mapping is persisted in the tenant-scoped 'settings' collection as doc id
 * 'ext:glMapping' (`accounts` field) — the same extension-doc convention as
 * 'ext:payroll' / 'ext:leaveTopups' (see lib/appSettings.ts). Readers merge
 * defaults ← stored doc so new line types added later always have a value.
 *
 * Export layouts
 * ──────────────
 * Journal ref = `<COMPANY_CODE>-PAY-<YYYY-MM>`; posting date = last day of
 * the wage month. Two granularities (BOTH supported by every exporter):
 *  - 'summary'  — one line per account (memo: run month + employee count)
 *  - 'detailed' — one line per employee per line type (memo: name + payslip ref)
 *
 *  glToXeroCsv   Xero manual-journal import:
 *                JournalNumber, JournalDate (DD/MM/YYYY), Description,
 *                AccountCode, Debit, Credit, Reference
 *  glToQboCsv    QuickBooks Online journal-entry import:
 *                Journal No, Journal Date (MM/DD/YYYY), Account, Debits,
 *                Credits, Memo, Name
 *  glToGenericCsv Account package agnostic:
 *                Date (ISO), Journal Ref, Account Code, Account Name,
 *                Debit, Credit, Memo
 * Zero debit/credit cells export as empty (accounting CSV convention);
 * amounts are plain 2-decimal numbers (never RM-prefixed, never localized).
 */
import { getActiveCompany, getCollection, setCollection, logAudit } from './db';
import { round2 } from './utils';
import { toCsv, type CsvValue } from './csv';
import type { Employee, PayrollRun, Payslip } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Line types + default MY SME chart of accounts
// ─────────────────────────────────────────────────────────────────────────────

/** Journal line types — the keys of the per-company account mapping. */
export const GL_LINE_TYPES = [
  'wagesBasic',
  'wagesAllowance',
  'wagesOT',
  'otherEarnings',
  'claimsExpense',
  'epfEmployerExpense',
  'socsoEmployerExpense',
  'eisEmployerExpense',
  'hrdExpense',
  'netPay',
  'epfPayable',
  'socsoPayable',
  'eisPayable',
  'pcbPayable',
  'hrdPayable',
  'cp38Payable',
  'zakatPayable',
  'ptptnPayable',
  'otherDeductionsPayable',
] as const;

export type GLLineType = (typeof GL_LINE_TYPES)[number];

export interface GLAccount {
  code: string;
  name: string;
}

/** Human label per line type (mapping editor + journal memo prefixes). */
export const GL_LINE_LABELS: Record<GLLineType, string> = {
  wagesBasic: 'Wages expense — basic salary',
  wagesAllowance: 'Wages expense — fixed allowances',
  wagesOT: 'Wages expense — overtime',
  otherEarnings: 'Wages expense — other earnings',
  claimsExpense: 'Staff claims reimbursement expense',
  epfEmployerExpense: 'Employer EPF expense',
  socsoEmployerExpense: 'Employer SOCSO expense',
  eisEmployerExpense: 'Employer EIS expense',
  hrdExpense: 'HRD Corp levy expense',
  netPay: 'Net salaries payable / bank',
  epfPayable: 'EPF payable (KWSP) — ee + er',
  socsoPayable: 'SOCSO payable (PERKESO) — ee + er',
  eisPayable: 'EIS payable (PERKESO) — ee + er',
  pcbPayable: 'PCB / MTD payable (LHDN)',
  hrdPayable: 'HRD Corp levy payable',
  cp38Payable: 'CP38 payable (LHDN)',
  zakatPayable: 'Zakat payable',
  ptptnPayable: 'PTPTN payable',
  otherDeductionsPayable: 'Other payroll deductions payable',
};

/** Which side of the journal each line type posts to. */
export const GL_LINE_SIDE: Record<GLLineType, 'debit' | 'credit'> = {
  wagesBasic: 'debit',
  wagesAllowance: 'debit',
  wagesOT: 'debit',
  otherEarnings: 'debit',
  claimsExpense: 'debit',
  epfEmployerExpense: 'debit',
  socsoEmployerExpense: 'debit',
  eisEmployerExpense: 'debit',
  hrdExpense: 'debit',
  netPay: 'credit',
  epfPayable: 'credit',
  socsoPayable: 'credit',
  eisPayable: 'credit',
  pcbPayable: 'credit',
  hrdPayable: 'credit',
  cp38Payable: 'credit',
  zakatPayable: 'credit',
  ptptnPayable: 'credit',
  otherDeductionsPayable: 'credit',
};

/**
 * Standard MY SME chart-of-accounts defaults. Companies re-map every line to
 * their own chart in the GL export panel; these are only the starting point.
 */
export const DEFAULT_GL_MAPPING: Record<GLLineType, GLAccount> = {
  wagesBasic: { code: '6100', name: 'Wages & salaries — basic' },
  wagesAllowance: { code: '6110', name: 'Wages & salaries — allowances' },
  wagesOT: { code: '6120', name: 'Wages & salaries — overtime' },
  otherEarnings: { code: '6130', name: 'Wages & salaries — other earnings' },
  claimsExpense: { code: '6200', name: 'Staff claims & reimbursements' },
  epfEmployerExpense: { code: '6300', name: 'Employer EPF contribution' },
  socsoEmployerExpense: { code: '6310', name: 'Employer SOCSO contribution' },
  eisEmployerExpense: { code: '6320', name: 'Employer EIS contribution' },
  hrdExpense: { code: '6330', name: 'HRD Corp levy' },
  netPay: { code: '2100', name: 'Salaries payable (net pay)' },
  epfPayable: { code: '2200', name: 'EPF payable' },
  socsoPayable: { code: '2210', name: 'SOCSO payable' },
  eisPayable: { code: '2220', name: 'EIS payable' },
  pcbPayable: { code: '2230', name: 'PCB/MTD payable (LHDN)' },
  hrdPayable: { code: '2240', name: 'HRD Corp levy payable' },
  cp38Payable: { code: '2250', name: 'CP38 payable (LHDN)' },
  zakatPayable: { code: '2260', name: 'Zakat payable' },
  ptptnPayable: { code: '2270', name: 'PTPTN payable' },
  otherDeductionsPayable: { code: '2280', name: 'Other deductions payable' },
};

export type GLMapping = Record<GLLineType, GLAccount>;

// ─────────────────────────────────────────────────────────────────────────────
// Mapping persistence (settings doc id 'ext:glMapping', per tenant)
// ─────────────────────────────────────────────────────────────────────────────

interface SettingsRow {
  id: string;
  kind?: string;
  accounts?: unknown;
  [key: string]: unknown;
}

const GL_MAPPING_DOC_ID = 'ext:glMapping';

function isGLAccount(v: unknown): v is GLAccount {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.code === 'string' && typeof r.name === 'string';
}

/**
 * Effective GL account mapping for the active company: defaults ← stored
 * 'ext:glMapping' settings doc. Unknown/invalid stored entries are ignored so
 * a hand-edited doc can never produce an account-less line type.
 */
export function getGLMapping(): GLMapping {
  const doc = getCollection<SettingsRow>('settings').find((r) => r.id === GL_MAPPING_DOC_ID);
  const stored = (doc?.accounts ?? {}) as Partial<Record<GLLineType, unknown>>;
  const out = {} as GLMapping;
  for (const t of GL_LINE_TYPES) {
    const s = stored[t];
    out[t] = isGLAccount(s) && s.code.trim() ? { code: s.code.trim(), name: s.name.trim() || DEFAULT_GL_MAPPING[t].name } : { ...DEFAULT_GL_MAPPING[t] };
  }
  return out;
}

/**
 * Persist the mapping for the active company (upserts the 'ext:glMapping'
 * settings doc; audits the change). Codes/names are trimmed; blank codes fall
 * back to the default for that line type so the mapping is always complete.
 */
export function saveGLMapping(mapping: GLMapping, actor = 'system'): GLMapping {
  const clean = {} as GLMapping;
  for (const t of GL_LINE_TYPES) {
    const m = mapping[t];
    clean[t] = {
      code: (m?.code ?? '').trim() || DEFAULT_GL_MAPPING[t].code,
      name: (m?.name ?? '').trim() || DEFAULT_GL_MAPPING[t].name,
    };
  }
  const rows = getCollection<SettingsRow>('settings');
  const idx = rows.findIndex((r) => r.id === GL_MAPPING_DOC_ID);
  const doc: SettingsRow = {
    ...(idx >= 0 ? rows[idx] : {}),
    id: GL_MAPPING_DOC_ID,
    kind: 'glMapping',
    accounts: clean,
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) rows[idx] = doc;
  else rows.push(doc);
  setCollection('settings', rows);
  logAudit({
    actorName: actor,
    action: 'payroll.glMapping.save',
    entity: 'settings',
    entityId: GL_MAPPING_DOC_ID,
    detail: `GL account mapping saved (${GL_LINE_TYPES.length} line types)`,
  });
  return clean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Journal building
// ─────────────────────────────────────────────────────────────────────────────

export type GLJournalMode = 'summary' | 'detailed';

export interface GLEntryLine {
  /** Line type this entry posts for (mapping key). */
  type: GLLineType;
  accountCode: string;
  accountName: string;
  /** Positive amount on exactly one side; the other side is 0. */
  debit: number;
  credit: number;
  memo: string;
  /** Detailed mode only — the employee this line belongs to. */
  employeeId?: string;
  employeeName?: string;
}

export interface GLJournal {
  /** Journal reference: `<COMPANY_CODE>-PAY-<YYYY-MM>`. */
  ref: string;
  /** Posting date (ISO) — last day of the wage month. */
  date: string;
  monthKey: string;
  companyCode: string;
  runId: string;
  mode: GLJournalMode;
  lines: GLEntryLine[];
  debitTotal: number;
  creditTotal: number;
  /** Always true — buildGLJournal throws when the journal cannot balance. */
  balanced: boolean;
}

/** Per-payslip journal components (RM, all ≥ 0). Pure — exported for tests. */
export interface SlipGLAmounts {
  wagesBasic: number;
  wagesAllowance: number;
  wagesOT: number;
  otherEarnings: number;
  claimsExpense: number;
  epfEmployerExpense: number;
  socsoEmployerExpense: number;
  eisEmployerExpense: number;
  hrdExpense: number;
  netPay: number;
  epfPayable: number;
  socsoPayable: number;
  eisPayable: number;
  pcbPayable: number;
  hrdPayable: number;
  cp38Payable: number;
  zakatPayable: number;
  ptptnPayable: number;
  otherDeductionsPayable: number;
}

/**
 * Decompose one stored payslip into journal components. Deduction adjustments
 * split by preset (CP38 / Zakat / PTPTN / custom) into their own payable
 * lines; their sum always equals the slip's adjustmentDeductions.
 */
export function slipGLAmounts(p: Payslip): SlipGLAmounts {
  let cp38 = 0;
  let zakat = 0;
  let ptptn = 0;
  let other = 0;
  for (const a of p.adjustments ?? []) {
    if (a.kind !== 'deduction') continue;
    const amt = round2(a.amount);
    if (a.preset === 'cp38') cp38 = round2(cp38 + amt);
    else if (a.preset === 'zakat') zakat = round2(zakat + amt);
    else if (a.preset === 'ptptn') ptptn = round2(ptptn + amt);
    else other = round2(other + amt);
  }
  return {
    wagesBasic: p.basicPay,
    wagesAllowance: p.allowances,
    wagesOT: p.otPay,
    otherEarnings: round2(p.adjustmentEarnings ?? 0),
    // Non-statutory cash earning lines (pay-items catalog reimbursements)
    // ride the claims expense line — same GL treatment, keeps the journal
    // balancing when the editor paid a reimbursement outside gross.
    claimsExpense: round2(p.claimsTotal + (p.adjustmentReimbursements ?? 0)),
    epfEmployerExpense: p.epfEmployer,
    socsoEmployerExpense: p.socsoEmployer,
    eisEmployerExpense: p.eisEmployer,
    hrdExpense: p.hrdLevy,
    netPay: p.netPay,
    epfPayable: round2(p.epfEmployee + p.epfEmployer),
    socsoPayable: round2(p.socsoEmployee + p.socsoEmployer),
    eisPayable: round2(p.eisEmployee + p.eisEmployer),
    pcbPayable: p.pcb,
    hrdPayable: p.hrdLevy,
    cp38Payable: cp38,
    zakatPayable: zakat,
    ptptnPayable: ptptn,
    otherDeductionsPayable: other,
  };
}

function entry(
  type: GLLineType,
  amount: number,
  mapping: GLMapping,
  memo: string,
  emp?: { id: string; name: string },
): GLEntryLine {
  const side = GL_LINE_SIDE[type];
  return {
    type,
    accountCode: mapping[type].code,
    accountName: mapping[type].name,
    debit: side === 'debit' ? amount : 0,
    credit: side === 'credit' ? amount : 0,
    memo,
    ...(emp ? { employeeId: emp.id, employeeName: emp.name } : {}),
  };
}

/** Last calendar day of 'YYYY-MM' as an ISO date — the GL posting date. */
export function journalDateFor(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

/** Journal reference for a run: `<COMPANY_CODE>-PAY-<YYYY-MM>`. */
export function journalRefFor(run: Pick<PayrollRun, 'monthKey'>, companyCode?: string): string {
  const code = (companyCode ?? getActiveCompany()?.code ?? 'CO').trim().toUpperCase() || 'CO';
  return `${code}-PAY-${run.monthKey}`;
}

export interface BuildGLJournalOptions {
  mode?: GLJournalMode;
  /** Override mapping (defaults to the persisted company mapping). */
  mapping?: GLMapping;
}

/**
 * Build the balanced double-entry journal for a FINALIZED payroll run.
 * Throws when the run is missing, still a draft (GL posting must never leak
 * un-reviewed figures), or — defensively — when the entries do not balance.
 */
export function buildGLJournal(runId: string, options?: BuildGLJournalOptions): GLJournal {
  const run = getCollection<PayrollRun>('payrollRuns').find((r) => r.id === runId);
  if (!run) throw new Error(`Payroll run ${runId} not found`);
  if (run.status !== 'finalized') {
    throw new Error(`Payroll run ${run.monthKey} is not finalized — GL export is available for finalized runs only`);
  }
  const mapping = options?.mapping ?? getGLMapping();
  const mode = options?.mode ?? 'summary';
  const slips = getCollection<Payslip>('payslips').filter((p) => p.runId === runId);
  const empById = new Map(getCollection<Employee>('employees').map((e) => [e.id, e]));

  const lines: GLEntryLine[] = [];
  if (mode === 'detailed') {
    for (const p of slips) {
      const emp = empById.get(p.employeeId);
      const who = { id: p.employeeId, name: emp?.name ?? p.employeeId };
      const memo = `${who.name} · ${p.refNo ?? p.id}`;
      const a = slipGLAmounts(p);
      for (const t of GL_LINE_TYPES) {
        if (a[t] > 0) lines.push(entry(t, a[t], mapping, memo, who));
      }
    }
  } else {
    const totals = {} as Record<GLLineType, number>;
    for (const t of GL_LINE_TYPES) totals[t] = 0;
    for (const p of slips) {
      const a = slipGLAmounts(p);
      for (const t of GL_LINE_TYPES) totals[t] = round2(totals[t] + a[t]);
    }
    const memo = `Payroll ${run.monthKey} — ${slips.length} employee(s)`;
    for (const t of GL_LINE_TYPES) {
      if (totals[t] > 0) lines.push(entry(t, totals[t], mapping, memo));
    }
  }

  const debitTotal = round2(lines.reduce((s, l) => s + l.debit, 0));
  const creditTotal = round2(lines.reduce((s, l) => s + l.credit, 0));
  if (debitTotal !== creditTotal) {
    // Unreachable given the payslip identity, but a journal MUST balance —
    // fail loudly rather than exporting a broken file.
    throw new Error(
      `GL journal for ${run.monthKey} is unbalanced: debits ${debitTotal.toFixed(2)} ≠ credits ${creditTotal.toFixed(2)}`,
    );
  }

  return {
    ref: journalRefFor(run),
    date: journalDateFor(run.monthKey),
    monthKey: run.monthKey,
    companyCode: (getActiveCompany()?.code ?? 'CO').toUpperCase(),
    runId: run.id,
    mode,
    lines,
    debitTotal,
    creditTotal,
    balanced: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV serializers (layouts documented in the module header)
// ─────────────────────────────────────────────────────────────────────────────

const num = (n: number): string => n.toFixed(2);
/** Empty cell for the zero side of an entry (accounting CSV convention). */
const side = (debit: number, credit: number): [CsvValue, CsvValue] =>
  debit > 0 ? [num(debit), ''] : ['', num(credit)];

/** ISO 'YYYY-MM-DD' → DD/MM/YYYY (Xero import default). */
function xeroDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** ISO 'YYYY-MM-DD' → MM/DD/YYYY (QuickBooks US default). */
function qboDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

/** Xero manual-journal import CSV. */
export function glToXeroCsv(journal: GLJournal): string {
  const rows: CsvValue[][] = journal.lines.map((l) => {
    const [dr, cr] = side(l.debit, l.credit);
    return [journal.ref, xeroDate(journal.date), l.memo, l.accountCode, dr, cr, journal.ref];
  });
  return toCsv(
    ['JournalNumber', 'JournalDate', 'Description', 'AccountCode', 'Debit', 'Credit', 'Reference'],
    rows,
  );
}

/** QuickBooks Online journal-entry import CSV. */
export function glToQboCsv(journal: GLJournal): string {
  const rows: CsvValue[][] = journal.lines.map((l) => {
    const [dr, cr] = side(l.debit, l.credit);
    return [
      journal.ref,
      qboDate(journal.date),
      `${l.accountCode} ${l.accountName}`,
      dr,
      cr,
      l.memo,
      journal.mode === 'detailed' ? (l.employeeName ?? '') : '',
    ];
  });
  return toCsv(['Journal No', 'Journal Date', 'Account', 'Debits', 'Credits', 'Memo', 'Name'], rows);
}

/** Generic accounting import CSV (date, ref, account, debit, credit, memo). */
export function glToGenericCsv(journal: GLJournal): string {
  const rows: CsvValue[][] = journal.lines.map((l) => {
    const [dr, cr] = side(l.debit, l.credit);
    return [journal.date, journal.ref, l.accountCode, l.accountName, dr, cr, l.memo];
  });
  return toCsv(['Date', 'Journal Ref', 'Account Code', 'Account Name', 'Debit', 'Credit', 'Memo'], rows);
}
