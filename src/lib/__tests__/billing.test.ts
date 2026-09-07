/**
 * SaaS billing tests (src/lib/billing.ts):
 *  - invoice math: seats × price, annual cycle (10×), discount %, SST 8%
 *  - invoice-no sequencing (per-year global, void-safe)
 *  - status derivation (issued & past due → overdue; paid/void sticky)
 *  - recordPayment / voidInvoice / reissueInvoice transitions
 *  - autoInvoiceRun: drafts for billable subs, skips, idempotency
 *  - analytics: mrr/arr, revenueByMonth, collectedThisMonth, outstandingAR,
 *    AR aging buckets, planDistribution, churnRisk
 *  - subscriptionFor: auto-create from Company.plan, plan-change sync, seat
 *    override, discount clamping; plan entitlements (soft-gate helpers)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { setCollection, upsertCompany } from '../db';
import {
  ANNUAL_MONTHS_CHARGED,
  DUE_DAYS,
  PLAN_CATALOG,
  SST_RATE,
  arAging,
  arr,
  autoInvoiceRun,
  billableHeadcount,
  cancelSubscription,
  churnRisk,
  collectedThisMonth,
  computeInvoiceMath,
  generateInvoice,
  getInvoices,
  getSubscriptions,
  invoiceStatusOf,
  invoicesFor,
  issueDraftsForPeriod,
  modulesOutsidePlan,
  monthlyAmountOf,
  mrr,
  nextInvoiceNo,
  outstandingAR,
  planDistribution,
  planEntitlements,
  previewInvoiceRun,
  recordPayment,
  reissueInvoice,
  revenueByMonth,
  setPlanEntitlements,
  subscriptionFor,
  subscriptionStatusOf,
  syncAllSubscriptions,
  updateSubscription,
  voidInvoice,
} from '../billing';
import type { Company, CompanyPlan, CompanyStatus, Employee } from '../types';

const NOW = new Date('2026-03-10T09:00:00.000Z');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeCompany(
  id: string,
  plan: CompanyPlan = 'pro',
  status: CompanyStatus = 'active',
  extra: Partial<Company> = {},
): Company {
  return {
    id,
    code: id.replace(/^co-/, '').toUpperCase(),
    name: `Company ${id}`,
    regNo: '202401000001 (1234567-A)',
    hqState: 'KUL',
    status,
    plan,
    createdAt: '2026-01-01T00:00:00.000Z',
    branding: { logoText: 'TST', accentColor: '#b45309' },
    config: {
      workingWeek: 'sat-sun',
      payrollCutoffDay: 25,
      claimPolicy: {},
      leaveTopUps: {},
      enabledModules: [],
      customFields: [],
      numberFormats: { employeeIdPrefix: 'EMP', payslipPrefix: 'PAY' },
      orgChart: { showDottedLineReports: false },
    },
    ...extra,
  };
}

function makeEmployee(id: string, status: Employee['status'] = 'active'): Employee {
  return {
    id,
    name: `Person ${id}`,
    ic: '900101-01-1234',
    email: `${id}@test.my`,
    phone: '012-3456789',
    departmentId: 'dept-1',
    positionId: 'pos-1',
    role: 'employee',
    joinDate: '2023-01-01',
    state: 'KUL',
    employmentType: 'full-time',
    status,
    baseSalary: 3000,
    maritalStatus: 'single',
    children: 0,
    bankName: 'Maybank',
    bankAccount: '1234567890',
    epfNo: 'EPF1',
    socsoNo: 'SOC1',
    taxNo: 'TAX1',
    isForeignWorker: false,
    dateOfBirth: '1990-01-01',
    gender: 'male',
    fixedAllowances: [],
  };
}

/** Register a company with `count` active employees (+ optional resigned). */
function seedTenant(
  id: string,
  plan: CompanyPlan,
  status: CompanyStatus,
  headcount: number,
  extra: Partial<Company> = {},
): Company {
  const company = makeCompany(id, plan, status, extra);
  upsertCompany(company);
  const employees = Array.from({ length: headcount }, (_, i) => makeEmployee(`${id}-e${i}`));
  employees.push(makeEmployee(`${id}-resigned`, 'resigned'));
  setCollection('employees', employees, id);
  return company;
}

beforeEach(() => {
  installLocalStorage();
});

// ── Plan catalog & entitlements ──────────────────────────────────────────────

describe('plan catalog & entitlements', () => {
  it('prices plans per the catalog and caps free at 5 seats', () => {
    expect(PLAN_CATALOG.free.monthlyRate).toBe(0);
    expect(PLAN_CATALOG.pro.monthlyRate).toBe(10);
    expect(PLAN_CATALOG.enterprise.monthlyRate).toBe(18);
    expect(PLAN_CATALOG.free.maxEmployees).toBe(5);
    expect(PLAN_CATALOG.pro.maxEmployees).toBeNull();
  });

  it('entitlements: free = core, pro adds kpi/insights/reports, enterprise all', () => {
    expect(planEntitlements('free')).toEqual(['attendance', 'leave', 'claims', 'payroll']);
    expect(planEntitlements('pro')).toEqual(
      expect.arrayContaining(['attendance', 'payroll', 'kpi', 'insights', 'reports']),
    );
    expect(planEntitlements('pro')).not.toContain('onboarding');
    expect(planEntitlements('enterprise')).toHaveLength(9);
  });

  it('modulesOutsidePlan flags enabled modules not entitled by the plan', () => {
    const company = makeCompany('co-x', 'free');
    company.config.enabledModules = ['attendance', 'payroll', 'kpi', 'onboarding'];
    expect(modulesOutsidePlan(company)).toEqual(['kpi', 'onboarding']);
  });

  it('setPlanEntitlements edits the mapping at runtime', () => {
    const original = planEntitlements('pro');
    setPlanEntitlements('pro', [...original, 'onboarding']);
    expect(planEntitlements('pro')).toContain('onboarding');
    const company = makeCompany('co-x', 'pro');
    company.config.enabledModules = ['onboarding'];
    expect(modulesOutsidePlan(company)).toEqual([]);
    setPlanEntitlements('pro', original); // restore for later tests
    expect(planEntitlements('pro')).toEqual(original);
  });
});

// ── Subscriptions ────────────────────────────────────────────────────────────

describe('subscriptionFor', () => {
  it('auto-creates from Company.plan with live headcount seats', () => {
    seedTenant('co-a', 'pro', 'active', 7);
    const sub = subscriptionFor('co-a', NOW);
    expect(sub).toBeDefined();
    expect(sub!.plan).toBe('pro');
    expect(sub!.unitPrice).toBe(10);
    expect(sub!.seats).toBe(7); // resigned employee not counted
    expect(sub!.billingCycle).toBe('monthly');
    expect(sub!.status).toBe('active');
    expect(getSubscriptions()).toHaveLength(1);
  });

  it('maps company status: trial → trialing, suspended → suspended', () => {
    seedTenant('co-t', 'pro', 'trial', 3, { trialEndsAt: '2026-03-20T00:00:00.000Z' });
    seedTenant('co-s', 'pro', 'suspended', 4);
    expect(subscriptionFor('co-t', NOW)!.status).toBe('trialing');
    expect(subscriptionFor('co-s', NOW)!.status).toBe('suspended');
  });

  it('syncs plan changes from the company record (rate follows)', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    subscriptionFor('co-a', NOW);
    upsertCompany(makeCompany('co-a', 'enterprise', 'active'));
    const sub = subscriptionFor('co-a', NOW);
    expect(sub!.plan).toBe('enterprise');
    expect(sub!.unitPrice).toBe(18);
  });

  it('keeps seats in sync with headcount unless overridden', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    subscriptionFor('co-a', NOW);
    setCollection('employees', Array.from({ length: 9 }, (_, i) => makeEmployee(`e${i}`)), 'co-a');
    expect(subscriptionFor('co-a', NOW)!.seats).toBe(9);

    updateSubscription('co-a', { seatsOverridden: true, seats: 20 }, NOW);
    setCollection('employees', Array.from({ length: 3 }, (_, i) => makeEmployee(`f${i}`)), 'co-a');
    const sub = subscriptionFor('co-a', NOW);
    expect(sub!.seats).toBe(20);
    expect(sub!.seatsOverridden).toBe(true);
    expect(billableHeadcount('co-a')).toBe(3);
  });

  it('clamps discountPercent to 0–100 and supports cancellation', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    updateSubscription('co-a', { discountPercent: 140 }, NOW);
    expect(subscriptionFor('co-a', NOW)!.discountPercent).toBe(100);
    cancelSubscription('co-a');
    const sub = subscriptionFor('co-a', NOW);
    expect(sub!.status).toBe('cancelled'); // cancelled sticks
  });

  it('returns undefined for an unknown company', () => {
    expect(subscriptionFor('nope', NOW)).toBeUndefined();
  });

  it('syncAllSubscriptions ensures one record per company, idempotently', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    seedTenant('co-b', 'free', 'active', 4);
    syncAllSubscriptions(NOW);
    syncAllSubscriptions(NOW);
    expect(getSubscriptions()).toHaveLength(2);
  });
});

// ── Invoice math ─────────────────────────────────────────────────────────────

describe('invoice math', () => {
  it('monthly: seats × price subtotal + 8% SST on top', () => {
    seedTenant('co-a', 'pro', 'active', 30);
    const { invoice } = generateInvoice('co-a', '2026-03', { now: NOW })!;
    expect(invoice.subtotal).toBe(300); // 30 × RM10
    expect(invoice.tax).toBe(24); // 8% of 300
    expect(invoice.taxRate).toBe(SST_RATE);
    expect(invoice.total).toBe(324);
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]!.qty).toBe(30);
    expect(invoice.lines[0]!.unitPrice).toBe(10);
    expect(invoice.dueAt).toBe(new Date(NOW.getTime() + DUE_DAYS * 86_400_000).toISOString());
  });

  it('annual cycle bills 10× the monthly rate (2 months free)', () => {
    seedTenant('co-a', 'enterprise', 'active', 12);
    updateSubscription('co-a', { billingCycle: 'annual' }, NOW);
    const { invoice } = generateInvoice('co-a', '2026-03', { now: NOW })!;
    const line = invoice.lines[0]!;
    expect(line.unitPrice).toBe(18 * ANNUAL_MONTHS_CHARGED); // RM180/seat/yr
    expect(invoice.subtotal).toBe(12 * 180); // 2160
    expect(invoice.tax).toBe(172.8);
    expect(invoice.total).toBe(2332.8);
    expect(line.description).toContain('12 months for the price of 10');
  });

  it('discount applies BEFORE SST (tax on the discounted amount)', () => {
    seedTenant('co-a', 'pro', 'active', 30);
    updateSubscription('co-a', { discountPercent: 10 }, NOW);
    const { invoice } = generateInvoice('co-a', '2026-03', { now: NOW })!;
    expect(invoice.subtotal).toBe(300);
    expect(invoice.discountPercent).toBe(10);
    expect(invoice.discountAmount).toBe(30);
    expect(invoice.tax).toBe(21.6); // 8% of 270
    expect(invoice.total).toBe(291.6);
  });

  it('computeInvoiceMath rounds to sen and accepts a tax-rate override', () => {
    const math = computeInvoiceMath(
      [{ description: 'x', qty: 3, unitPrice: 33.33, amount: 99.99 }],
      15,
      0.06,
    );
    expect(math.subtotal).toBe(99.99);
    expect(math.discountAmount).toBe(15);
    expect(math.taxable).toBe(84.99);
    expect(math.tax).toBe(5.1); // 6% override
    expect(math.total).toBe(90.09);
  });

  it('adds a proration note when seats changed since the previous invoice', () => {
    seedTenant('co-a', 'pro', 'active', 10);
    generateInvoice('co-a', '2026-02', { now: new Date('2026-02-01T00:00:00.000Z') });
    setCollection('employees', Array.from({ length: 14 }, (_, i) => makeEmployee(`e${i}`)), 'co-a');
    const { invoice } = generateInvoice('co-a', '2026-03', { now: NOW })!;
    expect(invoice.lines[0]!.qty).toBe(14);
    expect(invoice.notes).toContain('Seat count changed from 10 to 14');
  });
});

// ── Invoice numbering ────────────────────────────────────────────────────────

describe('invoice numbering', () => {
  it('sequences INV-<year>-NNNN globally across companies', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    seedTenant('co-b', 'pro', 'active', 5);
    const a = generateInvoice('co-a', '2026-03', { now: NOW })!.invoice;
    const b = generateInvoice('co-b', '2026-03', { now: NOW })!.invoice;
    expect(a.invoiceNo).toBe('INV-2026-0001');
    expect(b.invoiceNo).toBe('INV-2026-0002');
  });

  it('never reuses a voided number; resets per calendar year', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    const first = generateInvoice('co-a', '2026-02', { now: new Date('2026-02-01T00:00:00Z') })!
      .invoice;
    voidInvoice(first.id);
    expect(nextInvoiceNo(2026)).toBe('INV-2026-0002'); // void still consumes
    expect(nextInvoiceNo(2027)).toBe('INV-2027-0001'); // new year, fresh seq
  });
});

// ── Idempotent generation & lifecycle transitions ────────────────────────────

describe('invoice lifecycle', () => {
  it('generateInvoice is idempotent per company+period (voids excluded)', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    const r1 = generateInvoice('co-a', '2026-03', { now: NOW })!;
    const r2 = generateInvoice('co-a', '2026-03', { now: NOW })!;
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.invoice.id).toBe(r1.invoice.id);
    expect(getInvoices()).toHaveLength(1);

    voidInvoice(r1.invoice.id);
    const r3 = generateInvoice('co-a', '2026-03', { now: NOW })!;
    expect(r3.created).toBe(true); // void no longer blocks regeneration
    expect(r3.invoice.invoiceNo).toBe('INV-2026-0002');
  });

  it('derives overdue when issued and past due; paid/void/draft are sticky', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    const { invoice } = generateInvoice('co-a', '2026-01', {
      now: new Date('2026-01-01T00:00:00Z'),
    })!;
    expect(invoiceStatusOf(invoice, NOW)).toBe('overdue'); // due 15 Jan
    expect(invoiceStatusOf(invoice, new Date('2026-01-10T00:00:00Z'))).toBe('issued');
    expect(invoiceStatusOf({ ...invoice, status: 'draft' }, NOW)).toBe('draft');
    expect(invoiceStatusOf({ ...invoice, status: 'paid' }, NOW)).toBe('paid');
    expect(invoiceStatusOf({ ...invoice, status: 'void' }, NOW)).toBe('void');
  });

  it('recordPayment stamps paidAt + method; idempotent; rejects void invoices', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    const { invoice } = generateInvoice('co-a', '2026-03', { now: NOW })!;
    const paid = recordPayment(invoice.id, 'bank_transfer', NOW);
    expect(paid!.status).toBe('paid');
    expect(paid!.paidAt).toBe(NOW.toISOString());
    expect(paid!.paymentMethod).toBe('bank_transfer');
    // idempotent — second call keeps the original stamp
    const again = recordPayment(invoice.id, 'card', new Date('2026-04-01T00:00:00Z'));
    expect(again!.paymentMethod).toBe('bank_transfer');
    expect(recordPayment('missing', 'card')).toBeNull();
    const voided = voidInvoice(invoice.id);
    expect(voided).toBeNull(); // paid invoices cannot be voided
  });

  it('voidInvoice: issued → void, void idempotent, paid refused', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    const { invoice } = generateInvoice('co-a', '2026-03', { now: NOW })!;
    const voided = voidInvoice(invoice.id, 'wrong seats');
    expect(voided!.status).toBe('void');
    expect(voided!.notes).toContain('Voided: wrong seats');
    expect(voidInvoice(invoice.id)!.status).toBe('void'); // no-op
    expect(voidInvoice('missing')).toBeNull();
  });

  it('reissueInvoice voids the original and issues a replacement number', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    const { invoice } = generateInvoice('co-a', '2026-03', { now: NOW })!;
    const fresh = reissueInvoice(invoice.id, NOW);
    expect(fresh).not.toBeNull();
    expect(fresh!.invoiceNo).toBe('INV-2026-0002');
    expect(fresh!.status).toBe('issued');
    expect(fresh!.period).toBe('2026-03');
    expect(getInvoices().find((i) => i.id === invoice.id)!.status).toBe('void');
    // paid invoices cannot be reissued
    recordPayment(fresh!.id, 'card', NOW);
    expect(reissueInvoice(fresh!.id, NOW)).toBeNull();
  });

  it('invoicesFor returns a company history, newest first', () => {
    seedTenant('co-a', 'pro', 'active', 5);
    seedTenant('co-b', 'pro', 'active', 5);
    generateInvoice('co-a', '2026-01', { now: new Date('2026-01-05T00:00:00Z') });
    generateInvoice('co-a', '2026-02', { now: new Date('2026-02-05T00:00:00Z') });
    generateInvoice('co-b', '2026-02', { now: new Date('2026-02-05T00:00:00Z') });
    const history = invoicesFor('co-a');
    expect(history).toHaveLength(2);
    expect(history[0]!.period).toBe('2026-02');
    expect(history.every((i) => i.companyId === 'co-a')).toBe(true);
  });
});

// ── autoInvoiceRun ───────────────────────────────────────────────────────────

describe('autoInvoiceRun', () => {
  it('creates DRAFTS for billable subs; skips free/trial/suspended', () => {
    seedTenant('co-pro', 'pro', 'active', 10);
    seedTenant('co-ent', 'enterprise', 'active', 8);
    seedTenant('co-free', 'free', 'active', 4);
    seedTenant('co-trial', 'pro', 'trial', 6, { trialEndsAt: '2026-03-20T00:00:00Z' });
    seedTenant('co-susp', 'pro', 'suspended', 6);

    const run = autoInvoiceRun('2026-03', NOW);
    expect(run.created).toHaveLength(2);
    expect(run.created.every((i) => i.status === 'draft')).toBe(true);
    const reasons = new Map(run.skipped.map((s) => [s.companyId, s.reason]));
    expect(reasons.get('co-free')).toBe('free-plan');
    expect(reasons.get('co-trial')).toBe('not-billable');
    expect(reasons.get('co-susp')).toBe('not-billable');

    // drafts flip to issued on demand
    expect(issueDraftsForPeriod('2026-03', NOW)).toBe(2);
    expect(getInvoices().every((i) => i.status === 'issued')).toBe(true);
  });

  it('is idempotent — a second run for the same period creates nothing', () => {
    seedTenant('co-a', 'pro', 'active', 10);
    const first = autoInvoiceRun('2026-03', NOW);
    expect(first.created).toHaveLength(1);
    const second = autoInvoiceRun('2026-03', NOW);
    expect(second.created).toHaveLength(0);
    expect(second.skipped[0]!.reason).toBe('exists');
    expect(getInvoices()).toHaveLength(1);
  });

  it('previewInvoiceRun mirrors the run WITHOUT writing anything', () => {
    seedTenant('co-pro', 'pro', 'active', 10);
    seedTenant('co-ent', 'enterprise', 'active', 8);
    updateSubscription('co-ent', { billingCycle: 'annual' }, NOW);
    seedTenant('co-free', 'free', 'active', 4);

    const preview = previewInvoiceRun('2026-03', NOW);
    expect(preview.toCreate.map((r) => r.companyId).sort()).toEqual(['co-ent', 'co-pro']);
    expect(preview.toCreate.find((r) => r.companyId === 'co-pro')).toMatchObject({
      seats: 10,
      amount: 100,
    });
    expect(preview.toCreate.find((r) => r.companyId === 'co-ent')).toMatchObject({
      billingCycle: 'annual',
      seats: 8,
      amount: 8 * 18 * 10, // annual unit
    });
    expect(preview.toSkip).toEqual([
      { companyId: 'co-free', companyName: 'Company co-free', reason: 'free-plan' },
    ]);
    expect(preview.totalAmount).toBe(100 + 1440);
    // zero writes: no invoices created, no subscriptions auto-created by preview
    expect(getInvoices()).toHaveLength(0);
    expect(getSubscriptions().filter((s) => s.companyId === 'co-pro')).toHaveLength(0);
  });

  it('still bills past_due subscriptions (dunning continues)', () => {
    seedTenant('co-a', 'pro', 'active', 10);
    // overdue invoice from January → subscription derives past_due
    generateInvoice('co-a', '2026-01', { now: new Date('2026-01-01T00:00:00Z') });
    expect(subscriptionStatusOf(subscriptionFor('co-a', NOW)!, NOW)).toBe('past_due');
    const run = autoInvoiceRun('2026-03', NOW);
    expect(run.created).toHaveLength(1);
  });
});

// ── Revenue analytics ────────────────────────────────────────────────────────

describe('mrr / arr / planDistribution', () => {
  it('mrr sums monthly-equivalents of paying subs (annual spread over 12)', () => {
    seedTenant('co-pro', 'pro', 'active', 30); // 30 × 10 = 300
    seedTenant('co-ent', 'enterprise', 'active', 12);
    seedTenant('co-free', 'free', 'active', 4); // RM0
    seedTenant('co-trial', 'pro', 'trial', 50); // trialing → RM0
    updateSubscription('co-ent', { billingCycle: 'annual' }, NOW); // 12×18×10/12 = 180
    updateSubscription('co-pro', { discountPercent: 10 }, NOW); // 300 × 0.9 = 270
    syncAllSubscriptions(NOW);

    expect(monthlyAmountOf(subscriptionFor('co-pro', NOW)!)).toBe(270);
    expect(monthlyAmountOf(subscriptionFor('co-ent', NOW)!)).toBe(180);
    expect(mrr(NOW)).toBe(450);
    expect(arr(NOW)).toBe(5400);
  });

  it('mrr excludes cancelled/suspended subscriptions', () => {
    seedTenant('co-a', 'pro', 'active', 10);
    seedTenant('co-b', 'pro', 'suspended', 10);
    syncAllSubscriptions(NOW);
    cancelSubscription('co-a');
    expect(mrr(NOW)).toBe(0);
  });

  it('planDistribution reports count + mrr per tier', () => {
    seedTenant('co-a', 'pro', 'active', 10);
    seedTenant('co-b', 'pro', 'active', 5);
    seedTenant('co-c', 'enterprise', 'active', 10);
    seedTenant('co-d', 'free', 'active', 3);
    syncAllSubscriptions(NOW);
    const dist = planDistribution(NOW);
    const byPlan = new Map(dist.map((d) => [d.plan, d]));
    expect(byPlan.get('pro')).toMatchObject({ count: 2, mrr: 150 });
    expect(byPlan.get('enterprise')).toMatchObject({ count: 1, mrr: 180 });
    expect(byPlan.get('free')).toMatchObject({ count: 1, mrr: 0 });
  });
});

describe('cash analytics', () => {
  it('revenueByMonth: accrual by issue month, cash by paidAt month', () => {
    seedTenant('co-a', 'pro', 'active', 10); // RM100 + 8 = RM108
    const issued = generateInvoice('co-a', '2026-01', { now: new Date('2026-01-31T10:00:00Z') })!
      .invoice;
    recordPayment(issued.id, 'bank_transfer', new Date('2026-02-03T10:00:00Z'));
    const series = revenueByMonth(3, NOW); // Jan, Feb, Mar 2026
    const jan = series.find((m) => m.month === '2026-01')!;
    const feb = series.find((m) => m.month === '2026-02')!;
    expect(jan.invoiced).toBe(108);
    expect(jan.collected).toBe(0);
    expect(feb.invoiced).toBe(0);
    expect(feb.collected).toBe(108); // cash landed in Feb
    expect(jan.outstanding).toBe(0); // paid by now
    expect(series).toHaveLength(3);
  });

  it('collectedThisMonth + outstandingAR track payment state', () => {
    seedTenant('co-a', 'pro', 'active', 10);
    const a = generateInvoice('co-a', '2026-03', { now: NOW })!.invoice; // 108
    const b = generateInvoice('co-a', '2026-02', { now: new Date('2026-02-01T00:00:00Z') })!.invoice;
    expect(outstandingAR(NOW)).toBe(216);
    recordPayment(a.id, 'card', NOW);
    expect(collectedThisMonth(NOW)).toBe(108);
    expect(outstandingAR(NOW)).toBe(108); // only the Feb invoice left
    voidInvoice(b.id);
    expect(outstandingAR(NOW)).toBe(0); // voids drop out of AR
  });
});

describe('arAging buckets', () => {
  it('buckets unpaid invoices by whole days past due', () => {
    seedTenant('co-a', 'pro', 'active', 10); // each invoice RM108
    const mk = (isoIssued: string) =>
      generateInvoice('co-a', isoIssued.slice(0, 7), { now: new Date(isoIssued) })!.invoice;
    // void-blocking: distinct periods per invoice
    const current = mk('2026-03-10T00:00:00Z'); // due 24 Mar — not yet
    voidInvoice(mk('2026-02-01T00:00:00Z').id); // noise: voids never age
    // craft exact ages by rewriting dueAt through direct invoices is not
    // exposed — instead issue with known dates relative to NOW (10 Mar):
    const d10 = mk('2026-02-10T00:00:00Z'); // due 24 Feb → 14 days past
    const d45 = mk('2026-01-10T00:00:00Z'); // due 24 Jan → 45 days past
    const d75 = mk('2025-12-10T00:00:00Z'); // due 24 Dec → 76 days past
    const d120 = mk('2025-11-01T00:00:00Z'); // due 15 Nov → 115 days past
    expect(d10.id).not.toBe(d45.id);

    const aging = arAging(NOW);
    expect(aging.current).toMatchObject({ amount: 108, count: 1 });
    expect(aging.days30).toMatchObject({ amount: 108, count: 1 });
    expect(aging.days60).toMatchObject({ amount: 108, count: 1 });
    expect(aging.days90).toMatchObject({ amount: 108, count: 1 });
    expect(aging.over90).toMatchObject({ amount: 108, count: 1 });
    expect(aging.totalAmount).toBe(540);
    expect(aging.totalCount).toBe(5);
    expect(aging.current.invoiceIds).toEqual([current.id]);
    expect(aging.over90.invoiceIds).toEqual([d120.id]);
    expect(aging.days90.invoiceIds).toEqual([d75.id]);
  });

  it('paid invoices leave the aging entirely', () => {
    seedTenant('co-a', 'pro', 'active', 10);
    const inv = generateInvoice('co-a', '2026-01', { now: new Date('2026-01-01T00:00:00Z') })!
      .invoice;
    recordPayment(inv.id, 'card', NOW);
    expect(arAging(NOW).totalAmount).toBe(0);
  });
});

describe('churnRisk', () => {
  it('lists trials ending within 7 days and past-due subscriptions', () => {
    seedTenant('co-risk', 'pro', 'trial', 5, {
      trialEndsAt: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
    });
    seedTenant('co-safe', 'pro', 'trial', 5, {
      trialEndsAt: new Date(NOW.getTime() + 20 * 86_400_000).toISOString(),
    });
    seedTenant('co-expired', 'pro', 'trial', 5, {
      trialEndsAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
    });
    seedTenant('co-owe', 'pro', 'active', 5);
    generateInvoice('co-owe', '2026-01', { now: new Date('2026-01-01T00:00:00Z') }); // overdue
    syncAllSubscriptions(NOW);

    const risk = churnRisk(NOW);
    expect(risk.trialsEnding.map((t) => t.company.id)).toEqual(['co-risk']);
    expect(risk.trialsEnding[0]!.daysLeft).toBe(5);
    expect(risk.pastDue.map((p) => p.company.id)).toEqual(['co-owe']);
  });
});
