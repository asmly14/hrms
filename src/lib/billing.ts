/**
 * SaaS owner billing — subscriptions, invoices, payments and revenue analytics.
 *
 * Scope & storage
 * ───────────────
 * Billing data is SYSTEM-OWNED (the SaaS owner bills tenants), so it lives in
 * GLOBAL storage keys — never under a tenant namespace — following the
 * `myhrms:system:audit` pattern in lib/db.ts:
 *
 *     myhrms:system:billing:subscriptions   → Subscription[]
 *     myhrms:system:billing:invoices        → Invoice[]
 *
 * Both survive tenant deletion on purpose (invoices are financial records);
 * `removeCompany` only purges `myhrms:t:<companyId>:*` keys. Reads/writes are
 * direct localStorage with the same try/catch demo-mode tolerance as db.ts,
 * plus a tiny pub/sub (`subscribeBilling` / `useBillingVersion`) so React
 * sections re-read after mutations.
 *
 * Money conventions
 * ─────────────────
 * - All amounts are RM, rounded half-up to sen via utils.round2.
 * - SST_RATE (8%) applies to the post-discount taxable amount. Malaysian
 *   service tax on digital services (incl. SaaS subscriptions) moved from 6%
 *   to 8% effective 1 Mar 2024; it is a single exported constant so re-rating
 *   is a one-line change, and invoice math accepts an override for tests.
 * - Annual billing = 10 × monthly rate ("2 months free"): the invoice line
 *   unit price is rate × ANNUAL_MONTHS_CHARGED; the MRR monthly-equivalent
 *   contribution is (annual charge) / 12.
 * - Invoices are due DUE_DAYS (14) after issue. `invoiceStatusOf` DERIVES
 *   'overdue' (issued & past due) — the stored status is the workflow state
 *   (draft / issued / paid / void) and is never swept by a cron.
 *
 * Seats
 * ─────
 * `Subscription.seats` auto-follows the tenant's live headcount (non-resigned
 * employees) on every sync, unless `seatsOverridden` is set (SuperAdmin can
 * contract a fixed seat count in the Company Edit dialog).
 *
 * Soft enforcement note
 * ─────────────────────
 * Plan entitlements (`planEntitlements`) are ADVISORY in this demo: the
 * Company Setup → Modules screen shows an amber "outside your plan" banner
 * but never hard-blocks toggles (see ModulesSection). Documented behaviour.
 */
import { useSyncExternalStore } from 'react';
import { getCompanies, getCompany, getCollection, trialStatusOf, uid } from './db';
import { monthKey, round2 } from './utils';
import type { Company, CompanyPlan, Employee, ModuleKey } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Storage keys + pub/sub
// ─────────────────────────────────────────────────────────────────────────────

/** GLOBAL subscription store — one record per company (system-owned). */
export const BILLING_SUBSCRIPTIONS_KEY = 'myhrms:system:billing:subscriptions';
/** GLOBAL invoice store — financial records, never tenant-purged. */
export const BILLING_INVOICES_KEY = 'myhrms:system:billing:invoices';

/** Rotation caps (append-only stores would otherwise grow without bound). */
export const MAX_SUBSCRIPTIONS = 2000;
export const MAX_INVOICES = 5000;

type BillingListener = () => void;
const billingListeners = new Set<BillingListener>();
let billingVersion = 0;

function notifyBilling(): void {
  billingVersion += 1;
  billingListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break writes */
    }
  });
}

/** Subscribe to any billing-store mutation (subscriptions or invoices). */
export function subscribeBilling(fn: BillingListener): () => void {
  billingListeners.add(fn);
  return () => billingListeners.delete(fn);
}

/** React hook: monotonic version that bumps on every billing write. */
export function useBillingVersion(): number {
  return useSyncExternalStore(subscribeBilling, () => billingVersion);
}

function readStore<T>(key: string): T[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function writeStore<T>(key: string, items: T[], cap: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const trimmed = items.length > cap ? items.slice(items.length - cap) : items;
    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    /* storage unavailable / full — non-fatal in demo mode */
  }
  notifyBilling();
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants + plan catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Malaysian Service Tax (SST) rate on digital services. Raised 6% → 8% from
 * 1 Mar 2024 (RMCD Service Tax (Rate of Tax) (Amendment) Order 2024); SaaS
 * subscriptions fall under taxable digital/IT services. THE single knob —
 * change here to re-rate; `computeInvoiceMath` also accepts an override.
 */
export const SST_RATE = 0.08;

/** Days from issue to due date. */
export const DUE_DAYS = 14;

/** Annual billing charges 10 × monthly rate — "2 months free". */
export const ANNUAL_MONTHS_CHARGED = 10;

/** Core modules every plan gets (maps to the 'All plans' hint in modules.ts). */
const CORE_MODULES: ModuleKey[] = ['attendance', 'leave', 'claims', 'payroll'];

export interface PlanTier {
  plan: CompanyPlan;
  label: string;
  /** RM per employee (seat) per month. */
  monthlyRate: number;
  /** Seat cap; null = unlimited. */
  maxEmployees: number | null;
  /**
   * Modules this plan entitles the tenant to. EDITABLE at runtime via
   * `setPlanEntitlements` (SuperAdmin marketing changes) — drives the soft
   * banner in Company Setup → Modules and the default module set for new
   * tenants (`PLAN_DEFAULT_MODULES` mirrors this).
   */
  entitlements: ModuleKey[];
  highlights: string[];
}

/** The plan catalog — single source of truth for pricing + entitlements. */
export const PLAN_CATALOG: Record<CompanyPlan, PlanTier> = {
  free: {
    plan: 'free',
    label: 'Free',
    monthlyRate: 0,
    maxEmployees: 5,
    entitlements: [...CORE_MODULES],
    highlights: ['Up to 5 employees', 'Core HR modules', 'Community support'],
  },
  pro: {
    plan: 'pro',
    label: 'Pro',
    monthlyRate: 10,
    maxEmployees: null,
    entitlements: [...CORE_MODULES, 'kpi', 'insights', 'reports'],
    highlights: ['Unlimited employees', 'KPI & performance', 'Insights & reports', 'Email support'],
  },
  enterprise: {
    plan: 'enterprise',
    label: 'Enterprise',
    monthlyRate: 18,
    maxEmployees: null,
    entitlements: [...CORE_MODULES, 'kpi', 'insights', 'reports', 'onboarding', 'offboarding'],
    highlights: ['Everything in Pro', 'Onboarding & offboarding', 'Priority support'],
  },
};

/** Entitled modules for a plan (copy — safe to diff against enabledModules). */
export function planEntitlements(plan: CompanyPlan): ModuleKey[] {
  return [...PLAN_CATALOG[plan].entitlements];
}

/** Edit a plan's entitlement list (demo marketing knob; persists in-memory). */
export function setPlanEntitlements(plan: CompanyPlan, modules: ModuleKey[]): void {
  PLAN_CATALOG[plan].entitlements = [...modules];
  PLAN_DEFAULT_MODULES[plan] = [...modules];
}

/**
 * Default `config.enabledModules` for a new tenant on each plan — editable
 * mapping (kept in sync with entitlements by setPlanEntitlements).
 */
export const PLAN_DEFAULT_MODULES: Record<CompanyPlan, ModuleKey[]> = {
  free: [...CORE_MODULES],
  pro: [...CORE_MODULES, 'kpi', 'insights', 'reports'],
  enterprise: [...CORE_MODULES, 'kpi', 'insights', 'reports', 'onboarding', 'offboarding'],
};

/** Enabled modules that exceed the plan's entitlements (soft-gate driver). */
export function modulesOutsidePlan(company: Pick<Company, 'plan' | 'config'>): ModuleKey[] {
  const enabled = Array.isArray(company.config?.enabledModules) ? company.config.enabledModules : [];
  const entitled = new Set(planEntitlements(company.plan));
  return enabled.filter((m) => !entitled.has(m));
}

/** Billable seats = live headcount (non-resigned employees) of a tenant. */
export function billableHeadcount(companyId: string): number {
  return getCollection<Employee>('employees', companyId).filter((e) => e.status !== 'resigned')
    .length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions
// ─────────────────────────────────────────────────────────────────────────────

export type BillingCycle = 'monthly' | 'annual';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'suspended' | 'cancelled';

export interface Subscription {
  id: string;
  companyId: string;
  plan: CompanyPlan;
  /** annual = 10 × monthly rate, billed once a year (2 months free). */
  billingCycle: BillingCycle;
  /** Billable seats — auto-follows headcount unless `seatsOverridden`. */
  seats: number;
  /** True when the SuperAdmin contracted a fixed seat count. */
  seatsOverridden: boolean;
  /** RM per seat per month (snapshot of the catalog rate). */
  unitPrice: number;
  /** ISO datetime the subscription started. */
  startedAt: string;
  /** ISO date the current paid-through period ends. */
  currentPeriodEnd: string;
  status: SubscriptionStatus;
  /** Contract discount, 0–100 (applied before SST). */
  discountPercent?: number;
}

/** All subscriptions (global store; oldest first). */
export function getSubscriptions(): Subscription[] {
  return readStore<Subscription>(BILLING_SUBSCRIPTIONS_KEY);
}

function saveSubscriptions(list: Subscription[]): void {
  writeStore(BILLING_SUBSCRIPTIONS_KEY, list, MAX_SUBSCRIPTIONS);
}

function addMonthsISO(iso: string, months: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

/** Base status a company implies for its subscription (pre-payment-state). */
function statusFromCompany(company: Company): SubscriptionStatus {
  if (company.status === 'suspended') return 'suspended';
  if (company.status === 'trial') return 'trialing';
  return 'active';
}

/**
 * Effective subscription status: the stored value, with two derivations —
 *  1. company-driven (suspended company ⇒ suspended sub; trial ⇒ trialing),
 *     except a stored 'cancelled' which always wins;
 *  2. payment-driven: an active sub with any overdue unpaid invoice reads as
 *     'past_due'.
 */
export function subscriptionStatusOf(sub: Subscription, now: Date = new Date()): SubscriptionStatus {
  if (sub.status === 'cancelled') return 'cancelled';
  const company = getCompany(sub.companyId);
  let base: SubscriptionStatus = sub.status;
  if (company) {
    const fromCompany = statusFromCompany(company);
    if (fromCompany === 'suspended' || fromCompany === 'trialing') base = fromCompany;
    else if (base === 'suspended' || base === 'trialing') base = 'active';
  }
  if (base === 'active' || base === 'past_due') {
    const hasOverdue = getInvoices().some(
      (inv) => inv.companyId === sub.companyId && invoiceStatusOf(inv, now) === 'overdue',
    );
    return hasOverdue ? 'past_due' : base === 'past_due' ? 'active' : base;
  }
  return base;
}

/**
 * The subscription for a company — AUTO-CREATED from `Company.plan` on first
 * access and KEPT IN SYNC on every read: plan + unit price follow the company
 * record, seats follow live headcount (unless overridden), status follows the
 * company lifecycle. Writes back only when something actually changed (safe to
 * call during render). Returns undefined for an unknown company id.
 */
export function subscriptionFor(companyId: string, now: Date = new Date()): Subscription | undefined {
  const company = getCompany(companyId);
  if (!company) return undefined;
  const all = getSubscriptions();
  const idx = all.findIndex((s) => s.companyId === companyId);
  if (idx === -1) {
    const sub: Subscription = {
      id: uid(),
      companyId,
      plan: company.plan,
      billingCycle: 'monthly',
      seats: billableHeadcount(companyId),
      seatsOverridden: false,
      unitPrice: PLAN_CATALOG[company.plan].monthlyRate,
      startedAt: now.toISOString(),
      currentPeriodEnd: addMonthsISO(now.toISOString(), 1),
      status: statusFromCompany(company),
    };
    saveSubscriptions([...all, sub]);
    return sub;
  }

  const stored = all[idx]!;
  const synced: Subscription = {
    ...stored,
    plan: company.plan,
    unitPrice: PLAN_CATALOG[company.plan].monthlyRate,
    seats: stored.seatsOverridden ? stored.seats : billableHeadcount(companyId),
    status: subscriptionStatusOf(stored, now),
  };
  const changed =
    synced.plan !== stored.plan ||
    synced.unitPrice !== stored.unitPrice ||
    synced.seats !== stored.seats ||
    synced.status !== stored.status;
  if (changed) {
    const next = [...all];
    next[idx] = synced;
    saveSubscriptions(next);
  }
  return synced;
}

/**
 * Ensure + sync subscriptions for EVERY company in the directory. Idempotent;
 * called by autoInvoiceRun and on Billing-tab mount so analytics always have
 * records to work with.
 */
export function syncAllSubscriptions(now: Date = new Date()): Subscription[] {
  return getCompanies()
    .map((c) => subscriptionFor(c.id, now))
    .filter((s): s is Subscription => s !== undefined);
}

/** Patch a subscription (Edit dialog: cycle, seat override, discount, status). */
export function updateSubscription(
  companyId: string,
  patch: Partial<Pick<Subscription, 'billingCycle' | 'seats' | 'seatsOverridden' | 'discountPercent' | 'status'>>,
  now: Date = new Date(),
): Subscription | undefined {
  const current = subscriptionFor(companyId, now);
  if (!current) return undefined;
  const next: Subscription = {
    ...current,
    ...patch,
    seats: patch.seatsOverridden === false ? billableHeadcount(companyId) : (patch.seats ?? current.seats),
    discountPercent:
      patch.discountPercent === undefined
        ? current.discountPercent
        : Math.min(100, Math.max(0, patch.discountPercent)),
  };
  saveSubscriptions(getSubscriptions().map((s) => (s.companyId === companyId ? next : s)));
  return next;
}

/** Cancel a company's subscription (kept for history; invoices stay). */
export function cancelSubscription(companyId: string): Subscription | undefined {
  return updateSubscription(companyId, { status: 'cancelled' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoices
// ─────────────────────────────────────────────────────────────────────────────

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'overdue' | 'void';

export interface InvoiceLine {
  description: string;
  qty: number;
  unitPrice: number;
  amount: number;
}

export interface Invoice {
  id: string;
  /** Human number — 'INV-2026-0001' (per-year global sequence). */
  invoiceNo: string;
  companyId: string;
  /** Billing period key 'YYYY-MM' (annual invoices key the run month). */
  period: string;
  lines: InvoiceLine[];
  /** Pre-tax total (sum of line amounts). */
  subtotal: number;
  discountPercent?: number;
  discountAmount?: number;
  /** SST amount (taxRate × post-discount taxable). */
  tax: number;
  /** Rate actually applied (snapshot of SST_RATE at issue time). */
  taxRate: number;
  total: number;
  /** ISO datetime issued (drafts carry the creation timestamp). */
  issuedAt: string;
  /** ISO datetime due (issuedAt + DUE_DAYS). */
  dueAt: string;
  status: InvoiceStatus;
  paidAt?: string;
  /** e.g. 'bank_transfer' | 'card' | 'cheque' | 'other'. */
  paymentMethod?: string;
  notes?: string;
}

/** All invoices (global store; oldest first). */
export function getInvoices(): Invoice[] {
  return readStore<Invoice>(BILLING_INVOICES_KEY);
}

function saveInvoices(list: Invoice[]): void {
  writeStore(BILLING_INVOICES_KEY, list, MAX_INVOICES);
}

/** Invoices for one company, newest first — the per-company billing history. */
export function invoicesFor(companyId: string): Invoice[] {
  return getInvoices()
    .filter((inv) => inv.companyId === companyId)
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || b.invoiceNo.localeCompare(a.invoiceNo));
}

/**
 * Derived invoice status — the ONLY place 'overdue' comes from:
 * issued & past dueAt ⇒ overdue. Stored status is the workflow state
 * (draft/issued/paid/void); a stored 'overdue' (legacy/imports) reads as-is.
 */
export function invoiceStatusOf(inv: Invoice, now: Date = new Date()): InvoiceStatus {
  if (inv.status === 'paid' || inv.status === 'void' || inv.status === 'draft') return inv.status;
  const due = new Date(inv.dueAt).getTime();
  if (!Number.isNaN(due) && due < now.getTime()) return 'overdue';
  return inv.status === 'overdue' && due >= now.getTime() ? 'issued' : inv.status;
}

/**
 * Next invoice number for a year: `INV-<year>-<seq>` where seq is max+1 over
 * ALL existing invoices for that year (voids included — numbers are never
 * reused). Derived from the store, so it survives restarts and needs no
 * separate counter key.
 */
export function nextInvoiceNo(year: number, invoices: Invoice[] = getInvoices()): string {
  const re = new RegExp(`^INV-${year}-(\\d+)$`);
  let max = 0;
  for (const inv of invoices) {
    const m = re.exec(inv.invoiceNo);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `INV-${year}-${String(max + 1).padStart(4, '0')}`;
}

export interface InvoiceMath {
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxable: number;
  tax: number;
  taxRate: number;
  total: number;
}

/**
 * Invoice totals: subtotal = Σ lines → discount % (clamped 0–100) → SST on the
 * post-discount taxable amount. Every step rounds to sen (half-up).
 */
export function computeInvoiceMath(
  lines: InvoiceLine[],
  discountPercent = 0,
  taxRate: number = SST_RATE,
): InvoiceMath {
  const subtotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const pct = Math.min(100, Math.max(0, discountPercent));
  const discountAmount = round2((subtotal * pct) / 100);
  const taxable = round2(subtotal - discountAmount);
  const tax = round2(taxable * taxRate);
  const total = round2(taxable + tax);
  return { subtotal, discountPercent: pct, discountAmount, taxable, tax, taxRate, total };
}

function lineAmount(qty: number, unitPrice: number): number {
  return round2(qty * unitPrice);
}

/** Build the subscription line(s) for an invoice from a subscription. */
function subscriptionLines(sub: Subscription, period: string): InvoiceLine[] {
  const tier = PLAN_CATALOG[sub.plan];
  if (sub.billingCycle === 'annual') {
    const annualUnit = round2(sub.unitPrice * ANNUAL_MONTHS_CHARGED);
    return [
      {
        description: `${tier.label} plan — annual billing, period starting ${period} (${sub.seats} seat${sub.seats === 1 ? '' : 's'} × ${fmtRate(annualUnit)}; 12 months for the price of ${ANNUAL_MONTHS_CHARGED})`,
        qty: sub.seats,
        unitPrice: annualUnit,
        amount: lineAmount(sub.seats, annualUnit),
      },
    ];
  }
  return [
    {
      description: `${tier.label} plan — monthly subscription ${period} (${sub.seats} seat${sub.seats === 1 ? '' : 's'} × ${fmtRate(sub.unitPrice)}/seat/mo)`,
      qty: sub.seats,
      unitPrice: sub.unitPrice,
      amount: lineAmount(sub.seats, sub.unitPrice),
    },
  ];
}

function fmtRate(n: number): string {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Seat-change note: compares against the company's most recent non-void
 * invoice; a different seat count gets a proration remark on the new invoice.
 */
function prorationNote(companyId: string, seats: number, period: string): string | undefined {
  const prev = getInvoices()
    .filter((inv) => inv.companyId === companyId && inv.status !== 'void' && inv.period < period)
    .sort((a, b) => b.period.localeCompare(a.period))[0];
  const prevSeats = prev?.lines[0]?.qty;
  if (prevSeats === undefined || prevSeats === seats) return undefined;
  return `Seat count changed from ${prevSeats} to ${seats} since invoice ${prev!.invoiceNo} (${prev!.period}); the change is applied from this period (no mid-cycle proration in demo billing).`;
}

export interface GenerateInvoiceResult {
  invoice: Invoice;
  /** False when a non-void invoice already existed for company+period. */
  created: boolean;
}

/**
 * Generate (idempotently) the invoice for a company + period ('YYYY-MM').
 * Lines are auto-built from the synced subscription (seats × price; annual
 * cycle = 10× monthly unit). An existing NON-VOID invoice for the same
 * company+period is returned unchanged — safe to call repeatedly.
 * Status defaults to 'issued'; autoInvoiceRun passes 'draft'.
 */
export function generateInvoice(
  companyId: string,
  period: string,
  opts: { now?: Date; status?: 'draft' | 'issued' } = {},
): GenerateInvoiceResult | null {
  const now = opts.now ?? new Date();
  const company = getCompany(companyId);
  if (!company) return null;

  const existing = getInvoices().find(
    (inv) => inv.companyId === companyId && inv.period === period && inv.status !== 'void',
  );
  if (existing) return { invoice: existing, created: false };

  const sub = subscriptionFor(companyId, now);
  if (!sub) return null;

  const lines = subscriptionLines(sub, period);
  const math = computeInvoiceMath(lines, sub.discountPercent ?? 0);
  const issuedAt = now.toISOString();
  const dueAt = new Date(now.getTime() + DUE_DAYS * 86_400_000).toISOString();
  const invoice: Invoice = {
    id: uid(),
    invoiceNo: nextInvoiceNo(now.getFullYear()),
    companyId,
    period,
    lines,
    subtotal: math.subtotal,
    discountPercent: math.discountPercent > 0 ? math.discountPercent : undefined,
    discountAmount: math.discountAmount > 0 ? math.discountAmount : undefined,
    tax: math.tax,
    taxRate: math.taxRate,
    total: math.total,
    issuedAt,
    dueAt,
    status: opts.status ?? 'issued',
    notes: prorationNote(companyId, sub.seats, period),
  };
  saveInvoices([...getInvoices(), invoice]);

  // Roll the paid-through horizon forward with the billed period.
  const periodStart = `${period}-01T00:00:00.000Z`;
  const months = sub.billingCycle === 'annual' ? 12 : 1;
  const rolled = addMonthsISO(periodStart, months);
  if (rolled > sub.currentPeriodEnd) {
    saveSubscriptions(
      getSubscriptions().map((s) =>
        s.companyId === companyId ? { ...s, currentPeriodEnd: rolled } : s,
      ),
    );
  }
  return { invoice, created: true };
}

/**
 * Record a payment against an invoice. Idempotent for already-paid invoices;
 * returns null for unknown/void invoices. When the paying company has no
 * remaining overdue invoices its subscription drops 'past_due' back to
 * 'active' (derived on next read regardless — see subscriptionStatusOf).
 */
export function recordPayment(
  invoiceId: string,
  method: string,
  now: Date = new Date(),
): Invoice | null {
  const all = getInvoices();
  const inv = all.find((i) => i.id === invoiceId);
  if (!inv || inv.status === 'void') return null;
  if (inv.status === 'paid') return inv;
  const paid: Invoice = {
    ...inv,
    status: 'paid',
    paidAt: now.toISOString(),
    paymentMethod: method,
  };
  saveInvoices(all.map((i) => (i.id === invoiceId ? paid : i)));
  return paid;
}

/**
 * Void an invoice (correction path). Paid invoices cannot be voided (payment
 * already happened — issue a credit note instead); voiding a void invoice is
 * an idempotent no-op. Returns the (un)changed invoice, or null when the
 * operation is not allowed / the invoice is unknown.
 */
export function voidInvoice(invoiceId: string, reason?: string): Invoice | null {
  const all = getInvoices();
  const inv = all.find((i) => i.id === invoiceId);
  if (!inv || inv.status === 'paid') return null;
  if (inv.status === 'void') return inv;
  const voided: Invoice = {
    ...inv,
    status: 'void',
    notes: reason ? [inv.notes, `Voided: ${reason}`].filter(Boolean).join(' · ') : inv.notes,
  };
  saveInvoices(all.map((i) => (i.id === invoiceId ? voided : i)));
  return voided;
}

/**
 * Reissue: void the original (unless already void) and generate a fresh
 * ISSUED invoice for the same company+period with a new number. Paid invoices
 * cannot be reissued. Returns the new invoice, or null when not allowed.
 */
export function reissueInvoice(invoiceId: string, now: Date = new Date()): Invoice | null {
  const inv = getInvoices().find((i) => i.id === invoiceId);
  if (!inv || inv.status === 'paid') return null;
  if (inv.status !== 'void') voidInvoice(invoiceId, `Superseded by reissue`);
  const result = generateInvoice(inv.companyId, inv.period, { now, status: 'issued' });
  return result?.invoice ?? null;
}

export interface AutoInvoiceSkip {
  companyId: string;
  companyName: string;
  reason: 'exists' | 'free-plan' | 'not-billable' | 'unknown-company';
}

type RunClassification = 'create' | AutoInvoiceSkip['reason'];

/**
 * Shared billability decision for a company in a run period. Works off a
 * subscription SNAPSHOT so the preview path can classify without writing
 * (auto-creates missing subs virtually from the company record).
 */
function classifyCompanyForRun(
  company: Company,
  period: string,
  now: Date,
  subs: Subscription[],
): RunClassification {
  const sub = subs.find((s) => s.companyId === company.id);
  const status = sub ? subscriptionStatusOf(sub, now) : statusFromCompany(company);
  if (status !== 'active' && status !== 'past_due') return 'not-billable';
  const rate = sub ? PLAN_CATALOG[sub.plan].monthlyRate : PLAN_CATALOG[company.plan].monthlyRate;
  if (rate <= 0) return 'free-plan';
  const exists = getInvoices().some(
    (inv) => inv.companyId === company.id && inv.period === period && inv.status !== 'void',
  );
  return exists ? 'exists' : 'create';
}

export interface InvoiceRunPreviewRow {
  companyId: string;
  companyName: string;
  plan: CompanyPlan;
  billingCycle: BillingCycle;
  seats: number;
  /** Expected invoice subtotal (pre-SST, after contract discount). */
  amount: number;
}

export interface InvoiceRunPreview {
  period: string;
  toCreate: InvoiceRunPreviewRow[];
  toSkip: AutoInvoiceSkip[];
  totalAmount: number;
}

/**
 * DRY-RUN of autoInvoiceRun — same classification, zero writes. Missing
 * subscriptions are simulated from the company record (plan rate + live
 * headcount), so the preview matches what the real run would create.
 */
export function previewInvoiceRun(period: string, now: Date = new Date()): InvoiceRunPreview {
  const subs = getSubscriptions();
  const toCreate: InvoiceRunPreviewRow[] = [];
  const toSkip: AutoInvoiceSkip[] = [];
  for (const company of getCompanies()) {
    if (classifyCompanyForRun(company, period, now, subs) !== 'create') {
      toSkip.push({
        companyId: company.id,
        companyName: company.name,
        reason: classifyCompanyForRun(company, period, now, subs) as AutoInvoiceSkip['reason'],
      });
      continue;
    }
    const sub = subs.find((s) => s.companyId === company.id);
    const plan = sub?.plan ?? company.plan;
    const cycle = sub?.billingCycle ?? 'monthly';
    const seats = sub
      ? sub.seatsOverridden
        ? sub.seats
        : billableHeadcount(company.id)
      : billableHeadcount(company.id);
    const discount = 1 - Math.min(100, Math.max(0, sub?.discountPercent ?? 0)) / 100;
    const gross = seats * PLAN_CATALOG[plan].monthlyRate * (cycle === 'annual' ? ANNUAL_MONTHS_CHARGED : 1);
    toCreate.push({
      companyId: company.id,
      companyName: company.name,
      plan,
      billingCycle: cycle,
      seats,
      amount: round2(gross * discount),
    });
  }
  return {
    period,
    toCreate,
    toSkip,
    totalAmount: round2(toCreate.reduce((s, r) => s + r.amount, 0)),
  };
}

export interface AutoInvoiceRunResult {
  period: string;
  /** DRAFT invoices created by this run. */
  created: Invoice[];
  skipped: AutoInvoiceSkip[];
}

/**
 * Monthly invoicing run for a period ('YYYY-MM'): syncs all subscriptions,
 * then creates DRAFT invoices for every billable subscription. Billable =
 * company known, subscription effective-status 'active' or 'past_due', and a
 * paid plan (free-plan tenants are skipped — RM0 invoices are noise; trial,
 * suspended and cancelled subscriptions are not billed). Idempotent: a second
 * run for the same period creates nothing (existing drafts/issued count).
 */
export function autoInvoiceRun(period: string, now: Date = new Date()): AutoInvoiceRunResult {
  syncAllSubscriptions(now);
  const subs = getSubscriptions();
  const created: Invoice[] = [];
  const skipped: AutoInvoiceSkip[] = [];
  for (const company of getCompanies()) {
    const verdict = classifyCompanyForRun(company, period, now, subs);
    if (verdict !== 'create') {
      skipped.push({ companyId: company.id, companyName: company.name, reason: verdict });
      continue;
    }
    const result = generateInvoice(company.id, period, { now, status: 'draft' });
    if (!result) {
      skipped.push({ companyId: company.id, companyName: company.name, reason: 'unknown-company' });
    } else if (!result.created) {
      skipped.push({ companyId: company.id, companyName: company.name, reason: 'exists' });
    } else {
      created.push(result.invoice);
    }
  }
  return { period, created, skipped };
}

/** Issue a draft invoice (draft → issued; re-stamps issuedAt/dueAt). */
export function issueInvoice(invoiceId: string, now: Date = new Date()): Invoice | null {
  const all = getInvoices();
  const inv = all.find((i) => i.id === invoiceId);
  if (!inv || inv.status !== 'draft') return inv ?? null;
  const issued: Invoice = {
    ...inv,
    status: 'issued',
    issuedAt: now.toISOString(),
    dueAt: new Date(now.getTime() + DUE_DAYS * 86_400_000).toISOString(),
  };
  saveInvoices(all.map((i) => (i.id === invoiceId ? issued : i)));
  return issued;
}

/** Issue every draft for a period (the "send invoices" half of a run). */
export function issueDraftsForPeriod(period: string, now: Date = new Date()): number {
  const drafts = getInvoices().filter((i) => i.period === period && i.status === 'draft');
  drafts.forEach((d) => issueInvoice(d.id, now));
  return drafts.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Revenue analytics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Monthly-equivalent recurring amount of a subscription (pre-SST, after
 * discount): monthly cycle = seats × price × (1 − discount); annual cycle
 * spreads the 10× annual charge over 12 months.
 */
export function monthlyAmountOf(sub: Subscription): number {
  const discount = 1 - Math.min(100, Math.max(0, sub.discountPercent ?? 0)) / 100;
  const monthly =
    sub.billingCycle === 'annual'
      ? (sub.seats * sub.unitPrice * ANNUAL_MONTHS_CHARGED) / 12
      : sub.seats * sub.unitPrice;
  return round2(monthly * discount);
}

/**
 * MRR — sum of monthly-equivalent amounts over subscriptions whose effective
 * status is 'active' or 'past_due'. Trialing, suspended and cancelled
 * subscriptions contribute RM0. Reads ONLY stored subscriptions (no
 * auto-creation): when no subscription records exist yet, callers should fall
 * back to the seat×rate estimate (Overview tab labels this clearly).
 */
export function mrr(now: Date = new Date()): number {
  return round2(
    getSubscriptions()
      .filter((s) => {
        const st = subscriptionStatusOf(s, now);
        return st === 'active' || st === 'past_due';
      })
      .reduce((sum, s) => sum + monthlyAmountOf(s), 0),
  );
}

/** ARR — run-rate annualisation of MRR (×12), not a trailing sum. */
export function arr(now: Date = new Date()): number {
  return round2(mrr(now) * 12);
}

export interface RevenueMonth {
  /** 'YYYY-MM'. */
  month: string;
  /** Σ totals of non-void invoices issued in the month. */
  invoiced: number;
  /** Σ totals of invoices paid in the month (by paidAt). */
  collected: number;
  /** Issued that month and still unpaid (subset of invoiced). */
  outstanding: number;
}

/**
 * Monthly revenue series for the last `months` months (ascending, oldest
 * first). `invoiced` is accrual (issue month), `collected` is cash (paidAt
 * month) — they differ when payment lands in a later month.
 */
export function revenueByMonth(months = 12, now: Date = new Date()): RevenueMonth[] {
  const keys: string[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    keys.push(monthKey(d));
  }
  const invoices = getInvoices();
  return keys.map((month) => {
    const issued = invoices.filter(
      (inv) => inv.status !== 'void' && monthKey(new Date(inv.issuedAt)) === month,
    );
    const collected = invoices.filter(
      (inv) => inv.status === 'paid' && inv.paidAt && monthKey(new Date(inv.paidAt)) === month,
    );
    return {
      month,
      invoiced: round2(issued.reduce((s, i) => s + i.total, 0)),
      collected: round2(collected.reduce((s, i) => s + i.total, 0)),
      outstanding: round2(
        issued.filter((i) => i.status !== 'paid').reduce((s, i) => s + i.total, 0),
      ),
    };
  });
}

/** Cash collected (paid invoices) in the current calendar month. */
export function collectedThisMonth(now: Date = new Date()): number {
  const key = monthKey(now);
  return round2(
    getInvoices()
      .filter((inv) => inv.status === 'paid' && inv.paidAt && monthKey(new Date(inv.paidAt)) === key)
      .reduce((s, i) => s + i.total, 0),
  );
}

/**
 * Outstanding accounts receivable: Σ totals of unpaid customer-facing
 * invoices (derived status 'issued' or 'overdue'). Drafts are not AR yet;
 * void and paid invoices contribute nothing.
 */
export function outstandingAR(now: Date = new Date()): number {
  return round2(
    getInvoices()
      .filter((inv) => {
        const st = invoiceStatusOf(inv, now);
        return st === 'issued' || st === 'overdue';
      })
      .reduce((s, i) => s + i.total, 0),
  );
}

export interface ArAgingBucket {
  amount: number;
  count: number;
  invoiceIds: string[];
}

export interface ArAging {
  /** Issued but not yet due. */
  current: ArAgingBucket;
  /** 1–30 days past due. */
  days30: ArAgingBucket;
  /** 31–60 days past due. */
  days60: ArAgingBucket;
  /** 61–90 days past due. */
  days90: ArAgingBucket;
  /** >90 days past due. */
  over90: ArAgingBucket;
  totalAmount: number;
  totalCount: number;
}

const emptyBucket = (): ArAgingBucket => ({ amount: 0, count: 0, invoiceIds: [] });

/** AR aging over unpaid invoices, bucketed by whole days past dueAt. */
export function arAging(now: Date = new Date()): ArAging {
  const aging: ArAging = {
    current: emptyBucket(),
    days30: emptyBucket(),
    days60: emptyBucket(),
    days90: emptyBucket(),
    over90: emptyBucket(),
    totalAmount: 0,
    totalCount: 0,
  };
  for (const inv of getInvoices()) {
    const st = invoiceStatusOf(inv, now);
    if (st !== 'issued' && st !== 'overdue') continue;
    const daysPast = Math.floor((now.getTime() - new Date(inv.dueAt).getTime()) / 86_400_000);
    const bucket =
      daysPast <= 0
        ? aging.current
        : daysPast <= 30
          ? aging.days30
          : daysPast <= 60
            ? aging.days60
            : daysPast <= 90
              ? aging.days90
              : aging.over90;
    bucket.amount = round2(bucket.amount + inv.total);
    bucket.count += 1;
    bucket.invoiceIds.push(inv.id);
    aging.totalAmount = round2(aging.totalAmount + inv.total);
    aging.totalCount += 1;
  }
  return aging;
}

export interface PlanDistributionRow {
  plan: CompanyPlan;
  label: string;
  /** Non-cancelled subscriptions on this plan. */
  count: number;
  /** Σ monthly-equivalent amounts of active/past_due subs on this plan. */
  mrr: number;
}

/** Subscription count + MRR per plan tier (stored subscriptions only). */
export function planDistribution(now: Date = new Date()): PlanDistributionRow[] {
  const subs = getSubscriptions();
  return (Object.keys(PLAN_CATALOG) as CompanyPlan[]).map((plan) => {
    const onPlan = subs.filter((s) => s.plan === plan && s.status !== 'cancelled');
    return {
      plan,
      label: PLAN_CATALOG[plan].label,
      count: onPlan.length,
      mrr: round2(
        onPlan
          .filter((s) => {
            const st = subscriptionStatusOf(s, now);
            return st === 'active' || st === 'past_due';
          })
          .reduce((sum, s) => sum + monthlyAmountOf(s), 0),
      ),
    };
  });
}

export interface ChurnRisk {
  /** Subscriptions currently past due (overdue unpaid invoice). */
  pastDue: { subscription: Subscription; company: Company }[];
  /** Live trials ending within 7 days (not yet expired). */
  trialsEnding: { company: Company; daysLeft: number }[];
}

/** Churn-risk radar: past-due subscriptions + trials ending within 7 days. */
export function churnRisk(now: Date = new Date()): ChurnRisk {
  const companies = new Map(getCompanies().map((c) => [c.id, c]));
  const pastDue = getSubscriptions()
    .filter((s) => subscriptionStatusOf(s, now) === 'past_due')
    .map((subscription) => ({ subscription, company: companies.get(subscription.companyId) }))
    .filter((r): r is { subscription: Subscription; company: Company } => r.company !== undefined);
  const trialsEnding = getCompanies()
    .map((company) => ({ company, ts: trialStatusOf(company, now) }))
    .filter(
      (r) => r.ts.isTrial && !r.ts.expired && r.ts.daysLeft !== null && r.ts.daysLeft <= 7,
    )
    .map((r) => ({ company: r.company, daysLeft: r.ts.daysLeft! }));
  return { pastDue, trialsEnding };
}
