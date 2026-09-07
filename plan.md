# SaaS Billing — implementation plan (SaaSBilling_Engineer)

Scope: `src/lib/billing.ts` (new), `src/pages/superadmin/**` extensions,
`src/pages/company/sections/ModulesSection.tsx` (banner only),
`src/lib/__tests__/billing.test.ts` (new). Off-limits: `pages/reports`, `App.tsx`.

## Stage 1 — billing core (`src/lib/billing.ts`)
- Global keys `myhrms:system:billing:subscriptions` / `:invoices` (system-audit
  global-key pattern: direct localStorage, capped reads, tiny pub/sub for React).
- `PLAN_CATALOG`: free ≤5 seats (core modules), pro RM10, enterprise RM18;
  entitlement lists editable via `setPlanEntitlements`; `PLAN_DEFAULT_MODULES`.
- Subscription: auto-create/sync from `Company.plan` in `subscriptionFor`;
  seats auto from headcount unless overridden; annual = 10× monthly.
- Invoice: `INV-<year>-<seq>` derived max+1; lines = seats × price; discount
  before tax; `SST_RATE = 0.08` (configurable); due = issued +14d; status
  derivation issued&past-due → overdue (`invoiceStatusOf`); `generateInvoice`
  (idempotent per company+period, voids excluded), `recordPayment`,
  `voidInvoice`, `reissueInvoice`, `autoInvoiceRun(month)` (drafts, idempotent).
- Analytics: `mrr` (monthly-equiv; annual ÷12 of 10×), `arr = mrr×12`,
  `revenueByMonth(12)`, `churnRisk` (past_due + trials ≤7d), `arAging`
  (current/30/60/90+), `planDistribution`, `collectedThisMonth`, `outstandingAR`.

## Stage 2 — tests (`billing.test.ts`)
Invoice math (seats×price, annual, discount, SST), no. sequencing, status
derivation, recordPayment/void, autoInvoiceRun idempotency + skips, mrr/arr,
AR aging buckets, subscription sync, churnRisk, planDistribution, revenueByMonth.

## Stage 3 — SuperAdmin UI
- `BillingSection.tsx` + 'Billing' tab: stat cards (MRR/ARR/collected/outstanding),
  recharts 12-mo bar + plan donut, AR aging strip, invoices table with
  record-payment / void / reissue, run-invoicing preview dialog, churn-risk list.
- `invoicePdf.ts`: printable invoice (bill-to from Company, SST, bank-transfer
  block, PAID/OVERDUE stamp), jspdf dynamic import → `INV-….pdf`.
- Companies: Edit dialog Subscription section; row-expand billing history.
- Overview MRR card → `billing.mrr()` with estimate fallback (labelled).

## Stage 4 — soft entitlement banner
ModulesSection: enabled modules outside `planEntitlements(plan)` → amber info
banner (no hard block, demo-friendly, documented).

## Stage 5 — gates
`npx tsc -b` clean · `npm test` ≥597 green · `npm run lint` 0 problems.
