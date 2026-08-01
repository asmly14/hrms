/**
 * Contracts module — Contract OF Service vs Contract FOR Service management.
 *
 * Owned by the Contracts module agent. Pure client-side: localStorage-backed
 * stores that reuse the db.ts pub/sub mechanism via a typed cast (same
 * pattern as lib/lifecycle.ts — db.ts `COLLECTIONS` is core-scaffold owned
 * and cannot be extended by this module).
 *
 * Malaysian context encoded here:
 *  - Contract OF service  → employer–employee relationship. Employment Act
 *    1955 applies (notice, hours, leave, termination benefits) and statutory
 *    contributions are due: EPF (KWSP), SOCSO (PERKESO), EIS and PCB/MTD.
 *  - Contract FOR service → independent contractor / consultant. No EA 1955
 *    coverage, no SOCSO/EIS, generally no EPF and no MTD — fees are invoiced.
 *    UI copy flags the LHDN CP500 instalment scheme and the 2% withholding
 *    under s.109B ITA 1967 that may apply to certain resident payees.
 */
import { getCollection, logAudit, setCollection, uid, useCollection, type CollectionName } from './db';
import { round2 } from './utils';

/* ────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────── */

/** 'of-service' = employee (EA 1955); 'for-service' = independent contractor. */
export type ContractKind = 'of-service' | 'for-service';

/**
 * Lifecycle status. `expiring` / `expired` are AUTO-DERIVED by
 * `contractStatus()` from `endDate` — the stored value only ever carries the
 * editorial states draft / active / renewed / terminated.
 */
export type ContractStatus =
  | 'draft'
  | 'active'
  | 'expiring'
  | 'expired'
  | 'renewed'
  | 'terminated';

export type RemunerationMode =
  | 'monthly-salary'
  | 'daily'
  | 'hourly'
  | 'fixed-fee'
  | 'per-deliverable';

export interface ContractParty {
  /** Name of the authorised company signatory. */
  companySigner: string;
  /** NRIC / passport / business reg no. of the contractor (for-service). */
  contractorIc?: string;
}

export interface ContractRemuneration {
  mode: RemunerationMode;
  /** RM (or `currency`) per mode unit — month / day / hour / contract / deliverable. */
  amount: number;
  currency: string; // e.g. 'MYR'
}

export interface ContractTerms {
  probationMonths?: number;   // of-service only, informational
  noticeWeeks?: number;       // termination notice by either party
  workingHours?: string;      // free text, e.g. 'Mon–Fri, 9am–6pm (45 hrs/week)'
  ipClause: boolean;          // IP created vests in the company
  confidentiality: boolean;   // confidentiality / NDA clause
  nonCompete?: boolean;       // non-compete restraint clause
}

export interface EmploymentContract {
  id: string;
  /** Link to the employees collection (of-service). Absent for external contractors. */
  employeeId?: string;
  /** Free-text counterparty name (for-service contractors may not be employees). */
  contractorName?: string;
  kind: ContractKind;
  /** Engagement title, e.g. 'Software Engineer' / 'IT Infrastructure Consultant'. */
  title: string;
  /** Company reference no., e.g. 'ASM-CT-2025-001'. */
  refNo: string;
  party: ContractParty;
  startDate: string;          // ISO date
  /** ISO date for fixed-term engagements; undefined = indefinite. */
  endDate?: string;
  status: ContractStatus;
  remuneration: ContractRemuneration;
  terms: ContractTerms;
  /**
   * Whether EA 1955 + EPF/SOCSO/EIS/PCB statutory treatment applies.
   * Auto-derived from `kind` (see `statutoryAppliesFor`) but overridable in
   * the editor with an explicit warning.
   */
  statutoryApplies: boolean;
  version: number;            // 1 on first issue; +1 per renewal
  /** Immediate parent in the renewal chain (v2.parentContractId = v1.id). */
  parentContractId?: string;
  signedAt?: string;          // ISO date
  signedBy?: string;          // counterparty signatory name
  /** Uploaded document placeholder — file name only (no binary storage). */
  documentName?: string;
  notes?: string;
  /** Termination metadata (status 'terminated' only). */
  terminatedAt?: string;      // ISO date
  terminationReason?: string;
  createdAt: string;          // ISO datetime
}

/** Fee payment record against a for-service contract (consultant invoices). */
export interface FeePayment {
  id: string;
  contractId: string;
  date: string;               // ISO date
  /** Deliverable / invoice reference, e.g. 'INV-2025-014 · Phase 2 handover'. */
  reference: string;
  amount: number;             // RM gross — NO statutory deductions applied
  status: 'paid' | 'pending';
  createdAt: string;          // ISO datetime
}

/* ────────────────────────────────────────────────────────────
 * Constants & labels
 * ──────────────────────────────────────────────────────────── */

/** Days before `endDate` at which a fixed-term contract becomes 'expiring'. */
export const EXPIRING_WINDOW_DAYS = 60;

export const CONTRACT_KIND_LABELS: Record<ContractKind, string> = {
  'of-service': 'Contract of Service',
  'for-service': 'Contract for Service',
};

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  expiring: 'Expiring soon',
  expired: 'Expired',
  renewed: 'Renewed',
  terminated: 'Terminated',
};

export const REMUNERATION_MODE_LABELS: Record<RemunerationMode, string> = {
  'monthly-salary': 'Monthly salary',
  daily: 'Daily rate',
  hourly: 'Hourly rate',
  'fixed-fee': 'Fixed fee (lump sum)',
  'per-deliverable': 'Per deliverable',
};

/** Legal-implication copy shown on the kind selector cards in the editor. */
export const CONTRACT_KIND_INFO: Record<
  ContractKind,
  { tagline: string; implications: string[] }
> = {
  'of-service': {
    tagline: 'Employer–employee relationship (EA 1955)',
    implications: [
      'Employment Act 1955 applies — notice, hours of work, rest days, leave and termination benefits.',
      'Statutory contributions due: EPF (KWSP), SOCSO (PERKESO), EIS and monthly PCB/MTD tax deduction.',
      'Employee is on the payroll and headcount; subject to company policies and direction.',
    ],
  },
  'for-service': {
    tagline: 'Independent contractor / consultant',
    implications: [
      'No EA 1955 coverage — contractor is NOT an employee; no leave, notice or termination benefits.',
      'No SOCSO / EIS, generally no EPF, and no MTD — fees are paid against invoices, gross.',
      'Tax notes: payee may fall under LHDN CP500 instalments; 2% withholding (s.109B ITA 1967) can apply to certain resident payees.',
    ],
  },
};

/* ────────────────────────────────────────────────────────────
 * Date helpers (local, ISO-date based)
 * ──────────────────────────────────────────────────────────── */

function parseDate(iso: string): Date {
  return new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysUntil(from: string, to: string): number {
  const ms = parseDate(to).getTime() - parseDate(from).getTime();
  return Math.round(ms / 86_400_000);
}

export function addDaysISO(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function addYearsISO(iso: string, years: number): string {
  const d = parseDate(iso);
  d.setFullYear(d.getFullYear() + years);
  return toISODate(d);
}

/**
 * Roll a fixed-term end date forward to match a new start date, preserving
 * the original duration. Whole-year spans (the common 1-/2-year contract)
 * roll by calendar year so leap years don't drift the anniversary date;
 * other spans roll by exact day count.
 */
export function rollEndDateForward(oldStart: string, oldEnd: string, newStart: string): string {
  const duration = daysUntil(oldStart, oldEnd);
  const years = Math.round(duration / 365);
  if (years >= 1 && Math.abs(duration - years * 365) <= 1) {
    // e.g. 2024-01-01 → 2024-12-31 renews as 2025-01-01 → 2025-12-31.
    return addDaysISO(addYearsISO(newStart, years), -1);
  }
  return addDaysISO(newStart, duration);
}

/* ────────────────────────────────────────────────────────────
 * Core derivations
 * ──────────────────────────────────────────────────────────── */

/** Statutory treatment auto-mapping: of-service → true, for-service → false. */
export function statutoryAppliesFor(kind: ContractKind): boolean {
  return kind === 'of-service';
}

/**
 * Display status for a contract as of `today` (ISO date, default now).
 * Editorial states pass through; 'active' fixed-term contracts auto-derive to
 * 'expiring' (endDate within EXPIRING_WINDOW_DAYS) or 'expired' (past end).
 */
export function contractStatus(c: EmploymentContract, today: string = todayISO()): ContractStatus {
  if (c.status === 'draft' || c.status === 'renewed' || c.status === 'terminated') {
    return c.status;
  }
  if (!c.endDate) return 'active'; // indefinite engagement
  if (c.endDate < today) return 'expired';
  if (daysUntil(today, c.endDate) <= EXPIRING_WINDOW_DAYS) return 'expiring';
  return 'active';
}

/** Counterparty display name — employee link resolution is left to the UI. */
export function counterpartyName(c: EmploymentContract): string {
  return c.contractorName?.trim() || c.employeeId || '—';
}

/* ────────────────────────────────────────────────────────────
 * Renewal & termination
 * ──────────────────────────────────────────────────────────── */

/**
 * Build the next-version draft for a renewal (pure — does not persist).
 * Copies commercial terms, bumps version, links the chain, clears sign-off,
 * and rolls the period forward: new start = day after the old end (or today
 * for indefinite contracts); a fixed-term contract renews for the same
 * duration.
 */
export function buildRenewalDraft(
  c: EmploymentContract,
  today: string = todayISO(),
): Omit<EmploymentContract, 'id'> {
  const startDate = c.endDate ? addDaysISO(c.endDate, 1) : today;
  const endDate = c.endDate ? rollEndDateForward(c.startDate, c.endDate, startDate) : undefined;
  const refBase = c.refNo.replace(/-V\d+$/, '');
  return {
    employeeId: c.employeeId,
    contractorName: c.contractorName,
    kind: c.kind,
    title: c.title,
    refNo: `${refBase}-V${c.version + 1}`,
    party: { ...c.party },
    startDate,
    endDate,
    status: 'draft',
    remuneration: { ...c.remuneration },
    terms: { ...c.terms },
    statutoryApplies: c.statutoryApplies,
    version: c.version + 1,
    parentContractId: c.id,
    documentName: undefined,
    notes: c.notes,
    createdAt: new Date().toISOString(),
  };
}

/** Walk the renewal chain from the root down to `id` (v1 → … → current). */
export function contractChain(
  contracts: EmploymentContract[],
  id: string,
): EmploymentContract[] {
  const byId = new Map(contracts.map((c) => [c.id, c]));
  // Walk up to the root, then reverse for chronological order.
  const up: EmploymentContract[] = [];
  let cur = byId.get(id);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    up.unshift(cur);
    cur = cur.parentContractId ? byId.get(cur.parentContractId) : undefined;
  }
  // Append any descendants (in case `id` is not the tip of the chain).
  let tip = up[up.length - 1];
  while (tip) {
    const next = contracts.find((c) => c.parentContractId === tip!.id);
    if (!next || guard.has(next.id)) break;
    guard.add(next.id);
    up.push(next);
    tip = next;
  }
  return up;
}

/* ────────────────────────────────────────────────────────────
 * Queries & dashboard stats
 * ──────────────────────────────────────────────────────────── */

/** All contracts linked to an employee (any status), latest version first. */
export function contractsFor(
  employeeId: string,
  contracts?: EmploymentContract[],
): EmploymentContract[] {
  const list = contracts ?? getCollection<EmploymentContract>(CONTRACTS_COLLECTION);
  return list
    .filter((c) => c.employeeId === employeeId)
    .sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt));
}

/**
 * Active fixed-term contracts whose end date falls within `days` of `today`
 * (default EXPIRING_WINDOW_DAYS), sorted soonest-first.
 */
export function expiringContracts(
  days: number = EXPIRING_WINDOW_DAYS,
  today: string = todayISO(),
  contracts?: EmploymentContract[],
): EmploymentContract[] {
  const list = contracts ?? getCollection<EmploymentContract>(CONTRACTS_COLLECTION);
  return list
    .filter((c) => {
      if (c.status !== 'active' || !c.endDate) return false;
      const d = daysUntil(today, c.endDate);
      return d >= 0 && d <= days;
    })
    .sort((a, b) => a.endDate!.localeCompare(b.endDate!));
}

export interface ContractStats {
  activeOfService: number;
  activeForService: number;
  /** Fixed-term contracts expiring within EXPIRING_WINDOW_DAYS. */
  expiringSoon: number;
  /** Past end date with no renewal in place. */
  expiredUnrenewed: number;
  drafts: number;
  terminated: number;
  total: number;
}

export function contractStats(
  contracts: EmploymentContract[],
  today: string = todayISO(),
): ContractStats {
  const stats: ContractStats = {
    activeOfService: 0,
    activeForService: 0,
    expiringSoon: 0,
    expiredUnrenewed: 0,
    drafts: 0,
    terminated: 0,
    total: contracts.length,
  };
  // A contract counts as "expired-unrenewed" only when no active/draft
  // successor exists in its chain.
  const renewedRoots = new Set(
    contracts.filter((c) => c.parentContractId).map((c) => c.parentContractId as string),
  );
  for (const c of contracts) {
    const s = contractStatus(c, today);
    if (s === 'active') {
      if (c.kind === 'of-service') stats.activeOfService += 1;
      else stats.activeForService += 1;
    } else if (s === 'expiring') {
      stats.expiringSoon += 1;
      if (c.kind === 'of-service') stats.activeOfService += 1;
      else stats.activeForService += 1;
    } else if (s === 'expired') {
      if (!renewedRoots.has(c.id)) stats.expiredUnrenewed += 1;
    } else if (s === 'draft') {
      stats.drafts += 1;
    } else if (s === 'terminated') {
      stats.terminated += 1;
    }
  }
  return stats;
}

/* ────────────────────────────────────────────────────────────
 * Fee payment queries (for-service)
 * ──────────────────────────────────────────────────────────── */

export function feePaymentsFor(contractId: string, payments?: FeePayment[]): FeePayment[] {
  const list = payments ?? getCollection<FeePayment>(FEE_PAYMENTS_COLLECTION);
  return list
    .filter((p) => p.contractId === contractId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface FeeTotals {
  paid: number;
  pending: number;
  total: number;
}

/** Gross fee totals — no EPF/SOCSO/EIS/PCB deductions are ever applied. */
export function feePaymentTotals(payments: FeePayment[]): FeeTotals {
  const paid = round2(
    payments.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount, 0),
  );
  const pending = round2(
    payments.filter((p) => p.status === 'pending').reduce((s, p) => s + p.amount, 0),
  );
  return { paid, pending, total: round2(paid + pending) };
}

/* ────────────────────────────────────────────────────────────
 * Reactive stores — reuse db.ts pub/sub on module-owned keys.
 * ──────────────────────────────────────────────────────────── */

const asCollection = (name: string) => name as CollectionName;

export const CONTRACTS_COLLECTION = asCollection('contracts');
export const FEE_PAYMENTS_COLLECTION = asCollection('contractFeePayments');

export function useContracts() {
  return useCollection<EmploymentContract>(CONTRACTS_COLLECTION);
}

export function useFeePayments() {
  return useCollection<FeePayment>(FEE_PAYMENTS_COLLECTION);
}

/* ────────────────────────────────────────────────────────────
 * Mutations with audit trail
 * ──────────────────────────────────────────────────────────── */

export function auditContracts(
  action: string,
  entityId: string | undefined,
  detail: string,
  actorName = 'HR Admin',
): void {
  logAudit({ actorName, action, entity: 'contracts', entityId, detail });
}

/**
 * Renew a contract: the current record is marked 'renewed' and a linked
 * next-version DRAFT is persisted (see buildRenewalDraft). Returns the new
 * draft, or undefined when the id is unknown.
 */
export function renewContract(
  id: string,
  actorName = 'HR Admin',
  today: string = todayISO(),
): EmploymentContract | undefined {
  const contracts = getCollection<EmploymentContract>(CONTRACTS_COLLECTION);
  const current = contracts.find((c) => c.id === id);
  if (!current) return undefined;
  const draft: EmploymentContract = { ...buildRenewalDraft(current, today), id: uid() };
  setCollection(CONTRACTS_COLLECTION, [
    ...contracts.map((c) => (c.id === id ? { ...c, status: 'renewed' as ContractStatus } : c)),
    draft,
  ]);
  auditContracts(
    'contract.renew',
    draft.id,
    `${current.refNo} renewed as ${draft.refNo} (v${draft.version}, draft)`,
    actorName,
  );
  return draft;
}

/** Terminate a contract with an effective date and reason. */
export function terminateContract(
  id: string,
  terminatedAt: string,
  reason: string,
  actorName = 'HR Admin',
): void {
  const contracts = getCollection<EmploymentContract>(CONTRACTS_COLLECTION);
  const current = contracts.find((c) => c.id === id);
  setCollection(
    CONTRACTS_COLLECTION,
    contracts.map((c) =>
      c.id === id
        ? { ...c, status: 'terminated' as ContractStatus, terminatedAt, terminationReason: reason }
        : c,
    ),
  );
  if (current) {
    auditContracts(
      'contract.terminate',
      id,
      `${current.refNo} terminated effective ${terminatedAt} — ${reason}`,
      actorName,
    );
  }
}
