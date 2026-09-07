/**
 * SuperAdmin → Billing: the SaaS owner cockpit.
 *
 *   Revenue stat cards — MRR / ARR / collected-this-month / outstanding AR
 *   Charts             — 12-month invoiced-vs-collected bars + plan donut
 *   AR aging strip     — current / 1–30 / 31–60 / 61–90 / 90+ buckets
 *   Churn risk         — past-due subscriptions + trials ending within 7 days
 *   Invoices table     — record payment / void / reissue / PDF download,
 *                        plus the "Run monthly invoicing" flow (dry-run
 *                        preview → create drafts → issue all)
 *
 * All figures come from src/lib/billing.ts (GLOBAL billing stores); tenant
 * context only supplies the company directory for display names. A mount
 * effect runs syncAllSubscriptions() so every tenant has a subscription
 * record before analytics are read (idempotent).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Banknote, CalendarClock, CircleDollarSign, Download, FileText,
  FileCheck, Play, Receipt, RefreshCcw, TrendingUp, Wallet, type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis,
} from 'recharts';
import { useTenant } from '@/lib/useTenant';
import { fmtDate, fmtRM, monthKey } from '@/lib/utils';
import {
  ANNUAL_MONTHS_CHARGED, DUE_DAYS, PLAN_CATALOG, SST_RATE,
  arAging, arr, autoInvoiceRun, churnRisk, collectedThisMonth, getInvoices,
  invoiceStatusOf, issueDraftsForPeriod, issueInvoice, mrr, outstandingAR,
  planDistribution, previewInvoiceRun, recordPayment, reissueInvoice,
  revenueByMonth, syncAllSubscriptions, useBillingVersion,
  voidInvoice, type Invoice, type InvoiceStatus,
} from '@/lib/billing';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip,
  ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, SectionCard, StatCard } from './shared';
import { downloadInvoicePdf } from './invoicePdf';

// ── Badges ───────────────────────────────────────────────────────────────────

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const styles: Record<InvoiceStatus, string> = {
    draft: 'border-transparent bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
    issued: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    paid: 'border-transparent bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-300',
    overdue: 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    void: 'border-transparent bg-stone-200 text-stone-500 line-through dark:bg-stone-800 dark:text-stone-400',
  };
  const labels: Record<InvoiceStatus, string> = {
    draft: 'Draft',
    issued: 'Issued',
    paid: 'Paid',
    overdue: 'Overdue',
    void: 'Void',
  };
  return (
    <Badge variant="outline" className={styles[status]}>
      {labels[status]}
    </Badge>
  );
}

// ── Charts config ────────────────────────────────────────────────────────────

const revenueConfig = {
  invoiced: { label: 'Invoiced', color: '#d97706' },
  collected: { label: 'Collected', color: '#65a30d' },
} satisfies ChartConfig;

const planChartConfig = {
  free: { label: PLAN_CATALOG.free.label, color: '#a8a29e' },
  pro: { label: PLAN_CATALOG.pro.label, color: '#d97706' },
  enterprise: { label: PLAN_CATALOG.enterprise.label, color: '#92400e' },
} satisfies ChartConfig;

function ChartCard(props: {
  title: string;
  description: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  const { title, description, icon: Icon, children } = props;
  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-amber-600" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ── Record-payment dialog ────────────────────────────────────────────────────

function RecordPaymentDialog(props: { invoice: Invoice; onClose: () => void }) {
  const { invoice, onClose } = props;
  const [method, setMethod] = useState('bank_transfer');
  const confirm = () => {
    const paid = recordPayment(invoice.id, method);
    if (paid) {
      toast.success(`${invoice.invoiceNo} marked as paid`, {
        description: `${fmtRM(paid.total)} via ${method.replace('_', ' ')}.`,
      });
    } else {
      toast.error('Payment not recorded', { description: 'Void or missing invoice.' });
    }
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record payment — {invoice.invoiceNo}</DialogTitle>
          <DialogDescription>
            Mark {fmtRM(invoice.total)} as received. The invoice is stamped paid now; the
            company's subscription returns to active once no overdue invoices remain.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Payment method</Label>
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bank_transfer">Bank transfer (FPX / GIRO)</SelectItem>
              <SelectItem value="card">Card</SelectItem>
              <SelectItem value="cheque">Cheque</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={confirm}>
            <Banknote className="mr-1.5 h-4 w-4" />
            Mark as paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Run-invoicing dialog (dry-run preview → create drafts → issue) ───────────

function RunInvoicingDialog(props: { onClose: () => void }) {
  const { onClose } = props;
  const [period, setPeriod] = useState(monthKey());
  const [created, setCreated] = useState<number | null>(null);
  const validPeriod = /^\d{4}-\d{2}$/.test(period);

  const preview = useMemo(
    () => (validPeriod ? previewInvoiceRun(period) : null),
    [period, validPeriod],
  );

  const run = () => {
    const result = autoInvoiceRun(period);
    setCreated(result.created.length);
    toast.success(`Invoicing run for ${period} complete`, {
      description: `${result.created.length} draft invoice${result.created.length === 1 ? '' : 's'} created · ${result.skipped.length} skipped.`,
    });
  };

  const issueAll = () => {
    const n = issueDraftsForPeriod(period);
    toast.success(`${n} invoice${n === 1 ? '' : 's'} issued`, {
      description: `All drafts for ${period} are now issued with ${DUE_DAYS}-day payment terms.`,
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Run monthly invoicing</DialogTitle>
          <DialogDescription>
            Dry-run preview, then create DRAFT invoices for every billable subscription
            (active or past-due, paid plans only). Trial, suspended, cancelled and free
            tenants are skipped. Re-running a period is idempotent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="sa-run-period">Billing period (YYYY-MM)</Label>
          <Input
            id="sa-run-period"
            type="month"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setCreated(null);
            }}
          />
        </div>

        {preview ? (
          <div className="space-y-3">
            <div className="max-h-56 overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Seats</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.toCreate.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                        Nothing to bill for {period}.
                      </TableCell>
                    </TableRow>
                  ) : (
                    preview.toCreate.map((r) => (
                      <TableRow key={r.companyId}>
                        <TableCell className="font-medium">{r.companyName}</TableCell>
                        <TableCell>
                          {PLAN_CATALOG[r.plan].label}
                          {r.billingCycle === 'annual' ? ' · annual' : ''}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.seats}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRM(r.amount)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p className="text-muted-foreground">
                {preview.toSkip.length} tenant{preview.toSkip.length === 1 ? '' : 's'} skipped
                {preview.toSkip.length > 0
                  ? ` (${[...new Set(preview.toSkip.map((s) => s.reason))].join(', ')})`
                  : ''}
              </p>
              <p className="font-medium">
                {preview.toCreate.length} to bill · {fmtRM(preview.totalAmount)} + SST{' '}
                {Math.round(SST_RATE * 100)}%
              </p>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {created === null ? (
            <Button
              onClick={run}
              disabled={!preview || preview.toCreate.length === 0}
            >
              <Play className="mr-1.5 h-4 w-4" />
              Create {preview?.toCreate.length ?? 0} draft{preview?.toCreate.length === 1 ? '' : 's'}
            </Button>
          ) : (
            <Button onClick={issueAll} disabled={created === 0}>
              <FileCheck className="mr-1.5 h-4 w-4" />
              Issue {created} draft{created === 1 ? '' : 's'} now
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main section ─────────────────────────────────────────────────────────────

export default function BillingSection() {
  const { companies } = useTenant();
  const version = useBillingVersion();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | InvoiceStatus>('all');
  const [payTarget, setPayTarget] = useState<Invoice | null>(null);
  const [runOpen, setRunOpen] = useState(false);

  // Ensure every tenant has a synced subscription record (idempotent) so the
  // analytics below read real contracts instead of an empty store.
  useEffect(() => {
    syncAllSubscriptions();
  }, []);

  const companyNames = useMemo(
    () => new Map(companies.map((c) => [c.id, c.name])),
    [companies],
  );

  // `version` re-ties every memo to billing-store writes.
  const analytics = useMemo(
    () => ({
      mrr: mrr(),
      arr: arr(),
      collected: collectedThisMonth(),
      ar: outstandingAR(),
      aging: arAging(),
      revenue: revenueByMonth(12),
      plans: planDistribution(),
      risk: churnRisk(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, companies],
  );

  const invoices = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return getInvoices()
      .map((inv) => ({ inv, status: invoiceStatusOf(inv) }))
      .filter(({ status }) => statusFilter === 'all' || status === statusFilter)
      .filter(({ inv }) => {
        if (!needle) return true;
        const name = (companyNames.get(inv.companyId) ?? inv.companyId).toLowerCase();
        return (
          inv.invoiceNo.toLowerCase().includes(needle) ||
          name.includes(needle) ||
          inv.period.includes(needle)
        );
      })
      .sort((a, b) => b.inv.invoiceNo.localeCompare(a.inv.invoiceNo));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, q, statusFilter, companyNames]);

  const revenueData = useMemo(
    () =>
      analytics.revenue.map((m) => ({
        ...m,
        label: new Date(`${m.month}-02T00:00:00`).toLocaleString('en-MY', { month: 'short' }),
      })),
    [analytics],
  );

  const planData = useMemo(
    () =>
      analytics.plans
        .filter((p) => p.count > 0)
        .map((p) => ({ plan: p.plan, count: p.count, fill: `var(--color-${p.plan})` })),
    [analytics],
  );

  const downloadPdf = async (inv: Invoice) => {
    try {
      const fileName = await downloadInvoicePdf(inv);
      toast.success(`Downloaded ${fileName}`);
    } catch {
      toast.error('PDF generation failed', { description: 'jsPDF could not render this invoice.' });
    }
  };

  const onVoid = (inv: Invoice) => {
    if (voidInvoice(inv.id, 'Voided from Billing console')) {
      toast.success(`${inv.invoiceNo} voided`, { description: 'The number is retired, not reused.' });
    } else {
      toast.error('Cannot void a paid invoice', { description: 'Issue a credit note instead.' });
    }
  };

  const onReissue = (inv: Invoice) => {
    const fresh = reissueInvoice(inv.id);
    if (fresh) {
      toast.success(`${fresh.invoiceNo} reissued`, {
        description: `${inv.invoiceNo} was voided and replaced for period ${fresh.period}.`,
      });
    } else {
      toast.error('Cannot reissue', { description: 'Paid invoices cannot be reissued.' });
    }
  };

  const agingLabels = {
    current: 'Current',
    days30: '1–30 days',
    days60: '31–60 days',
    days90: '61–90 days',
    over90: '90+ days',
  } as const;
  const agingBuckets = (Object.keys(agingLabels) as (keyof typeof agingLabels)[]).map((key) => ({
    key,
    bucket: analytics.aging[key],
  }));

  return (
    <div className="space-y-6">
      {/* Revenue stat cards */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          icon={CircleDollarSign}
          label="MRR"
          value={fmtRM(analytics.mrr)}
          sub="active + past-due subs, monthly-equivalent"
        />
        <StatCard
          icon={TrendingUp}
          label="ARR"
          value={fmtRM(analytics.arr)}
          sub="run-rate — MRR × 12"
          tone="bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300"
        />
        <StatCard
          icon={Wallet}
          label={`Collected ${monthKey()}`}
          value={fmtRM(analytics.collected)}
          sub="paid invoices, this calendar month"
          tone="bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-300"
        />
        <StatCard
          icon={Receipt}
          label="Outstanding AR"
          value={fmtRM(analytics.ar)}
          sub="issued + overdue, unpaid"
          tone="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="Revenue trend"
          description="Invoiced (accrual) vs collected (cash), last 12 months"
          icon={TrendingUp}
        >
          <ChartContainer config={revenueConfig} className="h-[240px] w-full">
            <BarChart data={revenueData} margin={{ left: -8, right: 8, top: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} />
              <YAxis tickLine={false} axisLine={false} width={44} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="invoiced" fill="var(--color-invoiced)" radius={[4, 4, 0, 0]} maxBarSize={20} />
              <Bar dataKey="collected" fill="var(--color-collected)" radius={[4, 4, 0, 0]} maxBarSize={20} />
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="Plan distribution"
          description="Live subscriptions per tier (donut) — MRR share in the legend tooltip"
          icon={CircleDollarSign}
        >
          <div className="relative">
            <ChartContainer config={planChartConfig} className="mx-auto h-[240px] w-full">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey="plan" hideLabel />} />
                <Pie
                  data={planData}
                  dataKey="count"
                  nameKey="plan"
                  innerRadius="58%"
                  outerRadius="85%"
                  strokeWidth={2}
                >
                  {planData.map((d) => (
                    <Cell key={d.plan} fill={d.fill} />
                  ))}
                </Pie>
                <ChartLegend content={<ChartLegendContent nameKey="plan" />} />
              </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-8">
              <span className="text-xs text-muted-foreground">Subscriptions</span>
              <span className="text-lg font-semibold">
                {analytics.plans.reduce((s, p) => s + p.count, 0)}
              </span>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs text-muted-foreground">
            {analytics.plans.map((p) => (
              <p key={p.plan}>
                {p.label}: <span className="font-medium text-foreground">{fmtRM(p.mrr)}</span> MRR
              </p>
            ))}
          </div>
        </ChartCard>
      </div>

      {/* AR aging strip */}
      <SectionCard
        icon={CalendarClock}
        title="AR aging"
        description={`Unpaid invoices bucketed by days past due (${DUE_DAYS}-day terms). Total outstanding ${fmtRM(analytics.aging.totalAmount)} across ${analytics.aging.totalCount} invoice${analytics.aging.totalCount === 1 ? '' : 's'}.`}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {agingBuckets.map(({ key, bucket }) => (
            <div key={key} className="rounded-lg border p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {agingLabels[key]}
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{fmtRM(bucket.amount)}</p>
              <p className="text-xs text-muted-foreground">
                {bucket.count} invoice{bucket.count === 1 ? '' : 's'}
              </p>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Churn risk */}
      <SectionCard
        icon={AlertTriangle}
        title="Churn risk"
        description="Past-due subscriptions and trials ending within 7 days."
      >
        {analytics.risk.pastDue.length === 0 && analytics.risk.trialsEnding.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No churn signals right now — nothing past due, no trials expiring this week.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Past due
              </p>
              {analytics.risk.pastDue.length === 0 ? (
                <p className="text-sm text-muted-foreground">No past-due subscriptions.</p>
              ) : (
                analytics.risk.pastDue.map(({ subscription, company }) => (
                  <div
                    key={subscription.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50/60 p-3 dark:border-red-900 dark:bg-red-950/20"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{company.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {PLAN_CATALOG[subscription.plan].label} · {subscription.seats} seats ·{' '}
                        {fmtRM(subscription.seats * subscription.unitPrice)}/mo list
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                    >
                      Past due
                    </Badge>
                  </div>
                ))
              )}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Trials ending ≤ 7 days
              </p>
              {analytics.risk.trialsEnding.length === 0 ? (
                <p className="text-sm text-muted-foreground">No trials expiring this week.</p>
              ) : (
                analytics.risk.trialsEnding.map(({ company, daysLeft }) => (
                  <div
                    key={company.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{company.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Trial ends {company.trialEndsAt ? fmtDate(company.trialEndsAt) : '—'}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                    >
                      {daysLeft}d left
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </SectionCard>

      {/* Invoices */}
      <SectionCard
        icon={FileText}
        title="Invoices"
        description={`Global invoice register (INV-#### sequencing, SST ${Math.round(SST_RATE * 100)}%, ${DUE_DAYS}-day terms; annual = ${ANNUAL_MONTHS_CHARGED}× monthly).`}
        action={
          <Button size="sm" onClick={() => setRunOpen(true)}>
            <Play className="mr-1.5 h-4 w-4" />
            Run monthly invoicing
          </Button>
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Input
            placeholder="Search invoice no, company or period…"
            className="w-full sm:w-72"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as 'all' | InvoiceStatus)}
          >
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="issued">Issued</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
              <SelectItem value="void">Void</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No invoices yet"
            note="Use “Run monthly invoicing” to draft this period's invoices for all billable subscriptions."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Due</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map(({ inv, status }) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.invoiceNo}</TableCell>
                    <TableCell>{companyNames.get(inv.companyId) ?? inv.companyId}</TableCell>
                    <TableCell>{inv.period}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtRM(inv.total)}</TableCell>
                    <TableCell>
                      <InvoiceStatusBadge status={status} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{fmtDate(inv.dueAt)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Download PDF"
                          onClick={() => void downloadPdf(inv)}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        {status === 'draft' ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Issue invoice"
                            className="text-amber-700 hover:text-amber-800 dark:text-amber-400"
                            onClick={() => {
                              issueInvoice(inv.id);
                              toast.success(`${inv.invoiceNo} issued`, {
                                description: `Due ${fmtDate(new Date(Date.now() + DUE_DAYS * 86_400_000).toISOString())}.`,
                              });
                            }}
                          >
                            <FileCheck className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {status === 'issued' || status === 'overdue' ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Record payment"
                            className="text-lime-700 hover:text-lime-800 dark:text-lime-400"
                            onClick={() => setPayTarget(inv)}
                          >
                            <Banknote className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {status !== 'paid' ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Reissue (void + regenerate)"
                              onClick={() => onReissue(inv)}
                            >
                              <RefreshCcw className="h-4 w-4" />
                            </Button>
                            {status !== 'void' ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Void invoice"
                                className="text-red-600 hover:text-red-700 dark:text-red-400"
                                onClick={() => onVoid(inv)}
                              >
                                <AlertTriangle className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          MRR counts active + past-due subscriptions (trialing/suspended/cancelled contribute RM
          0.00); annual contracts contribute seats × rate × {ANNUAL_MONTHS_CHARGED} ÷ 12 per
          month. SST {Math.round(SST_RATE * 100)}% applies to the post-discount amount.
        </p>
      </SectionCard>

      {payTarget ? (
        <RecordPaymentDialog invoice={payTarget} onClose={() => setPayTarget(null)} />
      ) : null}
      {runOpen ? <RunInvoicingDialog onClose={() => setRunOpen(false)} /> : null}
    </div>
  );
}
