/**
 * SuperAdmin → Companies directory: every tenant with live headcount, plus
 * row actions — Enter company (impersonation via tenantContext), Edit profile
 * (upsertCompany), Suspend / Reactivate (status flag with confirm), and the
 * entry point to the create-company wizard.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Ban, Building2, LogIn, Pencil, Plus, RotateCcw, Search,
} from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { useTenant } from '@/lib/tenantContext';
import { logAudit, upsertCompany } from '@/lib/db';
import { states } from '@/lib/holidays';
import { fmtDate } from '@/lib/utils';
import type { Company, CompanyPlan, CompanyStatus, StateCode } from '@/lib/types';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
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
import { headcountOf } from './lib';
import { AccentDot, EmptyState, PlanBadge, SectionCard, StatusBadge } from './shared';
import CreateCompanyWizard from './CreateCompanyWizard';

// ── Edit dialog ──────────────────────────────────────────────────────────────

function EditCompanyDialog(props: {
  company: Company;
  actor: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { company, actor, onClose, onSaved } = props;
  const [name, setName] = useState(company.name);
  const [regNo, setRegNo] = useState(company.regNo);
  const [hqState, setHqState] = useState<StateCode>(company.hqState);
  const [plan, setPlan] = useState<CompanyPlan>(company.plan);
  const [status, setStatus] = useState<CompanyStatus>(company.status);
  const [logoText, setLogoText] = useState(company.branding.logoText);
  const [accentColor, setAccentColor] = useState(company.branding.accentColor);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (name.trim().length < 2) {
      setError('Company name is required (min 2 characters).');
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(accentColor.trim())) {
      setError('Accent color must be a hex value like #b45309.');
      return;
    }
    const next: Company = {
      ...company,
      name: name.trim(),
      regNo: regNo.trim(),
      hqState,
      plan,
      status,
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
    if (next.branding.logoText !== company.branding.logoText) changes.push('logoText');
    if (next.branding.accentColor !== company.branding.accentColor) changes.push('accentColor');
    upsertCompany(next);
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
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit company — {company.code}</DialogTitle>
          <DialogDescription>
            Profile, plan and branding for {company.name}. Module config (working week,
            payroll cutoff, numbering) is managed inside the tenant's own Settings.
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

        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

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

// ── Directory ────────────────────────────────────────────────────────────────

export default function CompaniesSection() {
  const { companies, setActiveCompany, refreshCompanies } = useTenant();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CompanyStatus>('all');
  const [planFilter, setPlanFilter] = useState<'all' | CompanyPlan>('all');
  const [editTarget, setEditTarget] = useState<Company | null>(null);
  const [confirm, setConfirm] = useState<{ company: Company; action: 'suspend' | 'reactivate' } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

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
    setConfirm(null);
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
                  <TableRow key={c.id}>
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
                      <StatusBadge status={c.status} />
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
