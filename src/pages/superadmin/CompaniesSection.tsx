/**
 * SuperAdmin → Companies directory: every tenant with live headcount, plus
 * row actions — Enter company (impersonation via tenantContext), Edit profile
 * (upsertCompany), Suspend / Reactivate (status flag with confirm), and the
 * entry point to the create-company wizard.
 */
import { Fragment, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Ban, Building2, ChevronDown, ChevronRight, Download, LogIn, Pencil,
  Plus, RotateCcw, Search, Trash2,
} from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { toast } from 'sonner';
import { useTenant } from '@/lib/useTenant';
import { logAudit, removeCompany, trialStatusOf, upsertCompany } from '@/lib/db';
import { states } from '@/lib/holidays';
import { fmtDate, fmtRM } from '@/lib/utils';
import type { Company, CompanyPlan, CompanyStatus, StateCode } from '@/lib/types';
import {
  PLAN_CATALOG, invoiceStatusOf, invoicesFor, subscriptionFor, updateSubscription,
  useBillingVersion, type BillingCycle,
} from '@/lib/billing';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { headcountOf } from './lib';
import { AccentDot, EmptyState, PlanBadge, SectionCard, StatusBadge } from './shared';
import { InvoiceStatusBadge } from './BillingSection';
import { downloadInvoicePdf } from './invoicePdf';
import CreateCompanyWizard from './CreateCompanyWizard';

// ── Edit dialog ──────────────────────────────────────────────────────────────

function EditCompanyDialog(props: {
  company: Company;
  actor: string;
  onClose: () => void;
  onSaved: () => void;
  /** Danger-zone delete: parent performs removeCompany + navigation. */
  onDelete: () => void;
}) {
  const { company, actor, onClose, onSaved, onDelete } = props;
  const [name, setName] = useState(company.name);
  const [regNo, setRegNo] = useState(company.regNo);
  const [hqState, setHqState] = useState<StateCode>(company.hqState);
  const [plan, setPlan] = useState<CompanyPlan>(company.plan);
  const [status, setStatus] = useState<CompanyStatus>(company.status);
  // Trial clock as a date input value ('' = open trial, no expiry).
  const [trialEnds, setTrialEnds] = useState(company.trialEndsAt?.slice(0, 10) ?? '');
  const [logoText, setLogoText] = useState(company.branding.logoText);
  const [accentColor, setAccentColor] = useState(company.branding.accentColor);
  const [error, setError] = useState<string | null>(null);
  // Danger zone: armed → type-the-company-name confirm before purging.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // ── Subscription section (billing.ts; auto-created/synced from the company) ─
  const sub = subscriptionFor(company.id);
  const [cycle, setCycle] = useState<BillingCycle>(sub?.billingCycle ?? 'monthly');
  const [seatsOverride, setSeatsOverride] = useState(sub?.seatsOverridden ?? false);
  const [seatsInput, setSeatsInput] = useState(String(sub?.seats ?? 0));
  const [discountInput, setDiscountInput] = useState(String(sub?.discountPercent ?? 0));

  const save = () => {
    if (name.trim().length < 2) {
      setError('Company name is required (min 2 characters).');
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(accentColor.trim())) {
      setError('Accent color must be a hex value like #b45309.');
      return;
    }
    if (status === 'trial' && trialEnds && Number.isNaN(new Date(`${trialEnds}T00:00:00`).getTime())) {
      setError('Trial end date is not a valid date.');
      return;
    }
    if (seatsOverride && !/^\d{1,6}$/.test(seatsInput.trim())) {
      setError('Seat override must be a whole number (0 or more).');
      return;
    }
    if (discountInput.trim() !== '' && !/^\d{1,3}(\.\d{1,2})?$/.test(discountInput.trim())) {
      setError('Discount must be a percentage like 10 or 12.5.');
      return;
    }
    // Trial clock is only meaningful for trial tenants; clearing the input
    // removes the clock (open trial). Non-trial statuses keep any stored value.
    const nextTrialEndsAt =
      status === 'trial'
        ? trialEnds
          ? new Date(`${trialEnds}T23:59:59.999Z`).toISOString()
          : undefined
        : company.trialEndsAt;
    const next: Company = {
      ...company,
      name: name.trim(),
      regNo: regNo.trim(),
      hqState,
      plan,
      status,
      trialEndsAt: nextTrialEndsAt,
      branding: {
        logoText: logoText.trim() || company.code,
        accentColor: accentColor.trim(),
      },
    };
    const changes: string[] = [];
    if (next.name !== company.name) changes.push('name');
    if (next.regNo !== company.regNo) changes.push('regNo');
    if (next.hqState !== company.hqState) changes.push('hqState');
    if (next.plan !== company.plan) changes.push('plan');
    if (next.status !== company.status) changes.push('status');
    if (next.trialEndsAt !== company.trialEndsAt) changes.push('trialEndsAt');
    if (next.branding.logoText !== company.branding.logoText) changes.push('logoText');
    if (next.branding.accentColor !== company.branding.accentColor) changes.push('accentColor');
    upsertCompany(next);
    // Subscription sync: upsertCompany already landed, so updateSubscription
    // re-reads the (possibly new) plan and applies the contract knobs.
    updateSubscription(next.id, {
      billingCycle: cycle,
      seatsOverridden: seatsOverride,
      seats: seatsOverride ? Math.max(0, parseInt(seatsInput.trim(), 10) || 0) : undefined,
      discountPercent: discountInput.trim() === '' ? 0 : Number(discountInput.trim()),
    });
    logAudit(
      {
        actorName: actor,
        action: 'company.update',
        entity: 'companies',
        entityId: next.id,
        detail: changes.length > 0 ? `Updated ${changes.join(', ')}` : 'Saved (no changes)',
      },
      next.id,
    );
    toast.success(`Company “${next.name}” saved`, {
      description: changes.length > 0 ? `Updated: ${changes.join(', ')}` : 'No field changes',
    });
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit company — {company.code}</DialogTitle>
          <DialogDescription>
            Profile, plan, subscription and branding for {company.name}. Module config (working
            week, payroll cutoff, numbering) is managed inside the tenant's own Settings.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="sa-edit-name">Company name</Label>
            <Input id="sa-edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sa-edit-regno">SSM registration no.</Label>
            <Input id="sa-edit-regno" value={regNo} onChange={(e) => setRegNo(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>HQ state</Label>
            <Select value={hqState} onValueChange={(v) => setHqState(v as StateCode)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {states.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Plan</Label>
            <Select value={plan} onValueChange={(v) => setPlan(v as CompanyPlan)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">Free — RM0</SelectItem>
                <SelectItem value="pro">Pro — RM10/emp/mo</SelectItem>
                <SelectItem value="enterprise">Enterprise — RM18/emp/mo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as CompanyStatus)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {status === 'trial' ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="sa-edit-trialends">Trial ends on</Label>
              <Input
                id="sa-edit-trialends"
                type="date"
                value={trialEnds}
                onChange={(e) => setTrialEnds(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Company users are blocked at login after this date (SuperAdmin access is never
                blocked). Leave empty for an open, non-expiring trial.
              </p>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="sa-edit-logo">Logo text</Label>
            <Input
              id="sa-edit-logo"
              value={logoText}
              maxLength={8}
              onChange={(e) => setLogoText(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sa-edit-color">Accent color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Pick accent color"
                className="h-9 w-10 shrink-0 cursor-pointer rounded-md border bg-background p-1"
                value={/^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : '#b45309'}
                onChange={(e) => setAccentColor(e.target.value)}
              />
              <Input
                id="sa-edit-color"
                value={accentColor}
                placeholder="#b45309"
                onChange={(e) => setAccentColor(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Subscription — plan changes above flow into the subscription via
            subscriptionFor(); the knobs below are the contract overrides. */}
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Subscription</p>
            {sub ? (
              <p className="text-xs text-muted-foreground">
                {PLAN_CATALOG[sub.plan].label} · {sub.status} · paid through{' '}
                {fmtDate(sub.currentPeriodEnd)}
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Billing cycle</Label>
              <Select value={cycle} onValueChange={(v) => setCycle(v as BillingCycle)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="annual">Annual — 12 months for the price of 10</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sa-edit-discount">Discount %</Label>
              <Input
                id="sa-edit-discount"
                inputMode="decimal"
                placeholder="0"
                value={discountInput}
                onChange={(e) => setDiscountInput(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="sa-edit-seatoverride">Seat override</Label>
                  <p className="text-xs text-muted-foreground">
                    Off: seats follow live headcount ({headcountOf(company.id)} now). On: bill a
                    fixed contracted seat count.
                  </p>
                </div>
                <Switch
                  id="sa-edit-seatoverride"
                  checked={seatsOverride}
                  onCheckedChange={setSeatsOverride}
                />
              </div>
              {seatsOverride ? (
                <Input
                  aria-label="Contracted seats"
                  inputMode="numeric"
                  value={seatsInput}
                  onChange={(e) => setSeatsInput(e.target.value)}
                />
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Rate: {fmtRM(PLAN_CATALOG[plan].monthlyRate)}/seat/mo list
            {cycle === 'annual'
              ? ` · annual invoices bill ${fmtRM(PLAN_CATALOG[plan].monthlyRate * 10)}/seat/yr`
              : ''}
            . Changing the plan above re-prices the subscription on save.
          </p>
        </div>

        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

        {/* Danger zone — PDPA erasure (tenant deletion). Type-the-name confirm
            before db.removeCompany purges every tenant key, the directory
            record and the company's user accounts. */}
        <div className="space-y-3 rounded-lg border border-red-200 bg-red-50/60 p-4 dark:border-red-900 dark:bg-red-950/20">
          <p className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400">
            <AlertTriangle className="h-4 w-4" />
            Danger zone
          </p>
          {!deleteArmed ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Permanently delete this company and ALL of its data (PDPA erasure). This cannot be
                undone.
              </p>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setDeleteArmed(true);
                  setDeleteConfirmText('');
                }}
              >
                <Trash2 className="mr-1.5 h-4 w-4" />
                Delete company…
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-red-700 dark:text-red-400">
                This purges every storage key under <code>myhrms:t:{company.id}:</code>, removes the
                company from the directory and deletes its user accounts. A tombstone is written to
                the global system audit. Type <strong>{company.name}</strong> to confirm.
              </p>
              <Input
                aria-label="Type the company name to confirm deletion"
                placeholder={company.name}
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setDeleteArmed(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleteConfirmText.trim() !== company.name}
                  onClick={onDelete}
                >
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  Delete permanently
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Per-company billing history (row expansion) ──────────────────────────────

function CompanyBillingHistory({ company }: { company: Company }) {
  const sub = subscriptionFor(company.id);
  const history = invoicesFor(company.id);
  return (
    <div className="space-y-3 px-2 py-1">
      {sub ? (
        <p className="text-xs text-muted-foreground">
          Subscription: <span className="font-medium text-foreground">{PLAN_CATALOG[sub.plan].label}</span>
          {' · '}{sub.billingCycle}
          {' · '}{sub.seats} seat{sub.seats === 1 ? '' : 's'}
          {sub.seatsOverridden ? ' (contracted)' : ' (auto headcount)'}
          {sub.discountPercent ? ` · ${sub.discountPercent}% discount` : ''}
          {' · status '}<span className="font-medium text-foreground">{sub.status}</span>
          {' · paid through '}{fmtDate(sub.currentPeriodEnd)}
        </p>
      ) : null}
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No invoices yet — run monthly invoicing from the Billing tab to draft the first one.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="hidden lg:table-cell">Paid</TableHead>
                <TableHead className="text-right">PDF</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-medium">{inv.invoiceNo}</TableCell>
                  <TableCell>{inv.period}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtRM(inv.total)}</TableCell>
                  <TableCell>
                    <InvoiceStatusBadge status={invoiceStatusOf(inv)} />
                  </TableCell>
                  <TableCell>{fmtDate(inv.dueAt)}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {inv.paidAt ? `${fmtDate(inv.paidAt)} · ${inv.paymentMethod ?? ''}` : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      title={`Download ${inv.invoiceNo}.pdf`}
                      onClick={() =>
                        void downloadInvoicePdf(inv)
                          .then((file) => toast.success(`Downloaded ${file}`))
                          .catch(() => toast.error('PDF generation failed'))
                      }
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Directory ────────────────────────────────────────────────────────────────

export default function CompaniesSection() {
  const { companies, activeCompanyId, setActiveCompany, leaveCompany, refreshCompanies } = useTenant();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CompanyStatus>('all');
  const [planFilter, setPlanFilter] = useState<'all' | CompanyPlan>('all');
  const [editTarget, setEditTarget] = useState<Company | null>(null);
  const [confirm, setConfirm] = useState<{ company: Company; action: 'suspend' | 'reactivate' } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Row expansion: per-company billing history under the directory row.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const billingVersion = useBillingVersion();

  const actor = user?.username ? `${user.username} (SuperAdmin)` : 'SuperAdmin';

  // Live headcount per tenant (explicit-tenant reads).
  const headcounts = useMemo(
    () => new Map(companies.map((c) => [c.id, headcountOf(c.id)])),
    [companies],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return companies
      .filter((c) => statusFilter === 'all' || c.status === statusFilter)
      .filter((c) => planFilter === 'all' || c.plan === planFilter)
      .filter(
        (c) =>
          !needle ||
          c.name.toLowerCase().includes(needle) ||
          c.code.toLowerCase().includes(needle) ||
          c.regNo.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [companies, q, statusFilter, planFilter]);

  const enterCompany = (c: Company) => {
    setActiveCompany(c.id);
    toast.success(`Entered ${c.name}`, {
      description: `Now working inside tenant ${c.code} — all pages are scoped to it.`,
    });
    navigate('/');
  };

  const applyStatusChange = () => {
    if (!confirm) return;
    const { company, action } = confirm;
    const next: Company = { ...company, status: action === 'suspend' ? 'suspended' : 'active' };
    upsertCompany(next);
    logAudit(
      {
        actorName: actor,
        action: action === 'suspend' ? 'company.suspend' : 'company.reactivate',
        entity: 'companies',
        entityId: next.id,
        detail: `${next.name} (${next.code})`,
      },
      next.id,
    );
    refreshCompanies();
    if (action === 'suspend') {
      toast.success(`${next.name} suspended`, {
        description: 'Data stays intact; the tenant is flagged across the console.',
      });
    } else {
      toast.success(`${next.name} reactivated`, {
        description: 'The tenant is active again.',
      });
    }
    setConfirm(null);
  };

  /**
   * Danger-zone delete (PDPA erasure). SuperAdmin may delete from anywhere —
   * when the purged company was the ACTIVE tenant, leave it first (logs the
   * impersonation exit while the record still exists) and drop to the system
   * view so no page write can resurrect keys under the purged namespace.
   */
  const deleteCompany = (company: Company) => {
    const wasActive = activeCompanyId === company.id;
    if (wasActive) leaveCompany();
    const report = removeCompany(company.id, actor);
    refreshCompanies();
    setEditTarget(null);
    if (!report) {
      toast.error(`Could not delete ${company.name}`, {
        description: 'The company record was not found — nothing was purged.',
      });
      return;
    }
    toast.success(`Company “${report.companyName}” deleted`, {
      description: `Purged ${report.removedKeys} storage key${report.removedKeys === 1 ? '' : 's'} and ${report.removedUsers} user account${report.removedUsers === 1 ? '' : 's'}. Tombstone written to the system audit.`,
    });
    if (wasActive) navigate('/superadmin');
  };

  return (
    <div className="space-y-4">
      <SectionCard
        icon={Building2}
        title="Companies directory"
        description={`${companies.length} tenant${companies.length === 1 ? '' : 's'} registered · enter any company to work inside it.`}
        action={
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New company
          </Button>
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search name, code or reg no…"
              className="pl-8"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | CompanyStatus)}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="trial">Trial</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
            </SelectContent>
          </Select>
          <Select value={planFilter} onValueChange={(v) => setPlanFilter(v as 'all' | CompanyPlan)}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="Plan" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All plans</SelectItem>
              <SelectItem value="free">Free</SelectItem>
              <SelectItem value="pro">Pro</SelectItem>
              <SelectItem value="enterprise">Enterprise</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={companies.length === 0 ? 'No companies yet' : 'No companies match'}
            note={
              companies.length === 0
                ? 'Use “New company” to onboard the first tenant.'
                : 'Try a different search term or clear the filters.'
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead className="hidden lg:table-cell">Reg no.</TableHead>
                  <TableHead className="hidden md:table-cell">HQ</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Employees</TableHead>
                  <TableHead className="hidden xl:table-cell">Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((c) => (
                  <Fragment key={c.id}>
                  <TableRow>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <AccentDot color={c.branding.accentColor} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{c.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {c.code}
                            <span className="lg:hidden"> · {c.regNo}</span>
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{c.regNo}</TableCell>
                    <TableCell className="hidden md:table-cell">{c.hqState}</TableCell>
                    <TableCell>
                      <PlanBadge plan={c.plan} />
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const ts = trialStatusOf(c);
                        return (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusBadge status={c.status} />
                            {ts.expired ? (
                              <Badge
                                variant="outline"
                                className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                                title={`Trial ended ${fmtDate(ts.trialEndsAt!)} — company users are blocked at login`}
                              >
                                Trial expired
                              </Badge>
                            ) : ts.isTrial && ts.daysLeft !== null ? (
                              <span className="text-xs text-muted-foreground">
                                {ts.daysLeft}d left
                              </span>
                            ) : null}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {headcounts.get(c.id) ?? 0}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">{fmtDate(c.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={expandedId === c.id ? 'Hide billing history' : 'Show billing history'}
                          onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                        >
                          {expandedId === c.id ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={`Enter ${c.name}`}
                          onClick={() => enterCompany(c)}
                        >
                          <LogIn className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Edit company"
                          onClick={() => setEditTarget(c)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {c.status === 'suspended' ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Reactivate company"
                            className="text-lime-700 hover:text-lime-800 dark:text-lime-400"
                            onClick={() => setConfirm({ company: c, action: 'reactivate' })}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Suspend company"
                            className="text-red-600 hover:text-red-700 dark:text-red-400"
                            onClick={() => setConfirm({ company: c, action: 'suspend' })}
                          >
                            <Ban className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedId === c.id ? (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell colSpan={8}>
                        {/* key on billingVersion: re-read the global stores after
                            any billing write (payment recorded in Billing tab, …). */}
                        <CompanyBillingHistory key={billingVersion} company={c} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {editTarget && (
        <EditCompanyDialog
          key={editTarget.id}
          company={editTarget}
          actor={actor}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            refreshCompanies();
            setEditTarget(null);
          }}
          onDelete={() => deleteCompany(editTarget)}
        />
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === 'suspend' ? 'Suspend' : 'Reactivate'}{' '}
              {confirm?.company.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === 'suspend'
                ? 'The company stays in the directory with all data intact, but is flagged suspended — demo billing stops and it is marked across the console. Demo note: the mock login does not block suspended tenants.'
                : 'The company returns to active status and resumes demo billing at its plan rate.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={applyStatusChange}>
              {confirm?.action === 'suspend' ? 'Suspend company' : 'Reactivate company'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateCompanyWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </div>
  );
}
