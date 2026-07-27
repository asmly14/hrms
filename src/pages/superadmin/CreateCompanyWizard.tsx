/**
 * SuperAdmin → Create company wizard (4 steps):
 *   1 Basics        — name, unique code, SSM reg no, HQ state, plan
 *   2 Configuration — working week (auto from HQ state), payroll cutoff,
 *                     employee/payslip prefixes (auto from code), modules
 *   3 Admin account — username/password for the company's first Admin
 *   4 Review        — confirm and create
 *
 * Creation writes the Company record (upsertCompany) and appends the Admin
 * account to the mock-auth directory. The new tenant starts EMPTY — no demo
 * seed is run (seedTenantIfEmpty is deliberately NOT called here; entering
 * the company later initialises empty collections only).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Building2, Check, CheckCircle2, KeyRound, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { useTenant } from '@/lib/tenantContext';
import { logAudit, uid, upsertCompany } from '@/lib/db';
import { states } from '@/lib/holidays';
import { defaultWorkingWeek } from '@/lib/tenants';
import { cn } from '@/lib/utils';
import type {
  Company, CompanyPlan, ModuleKey, StateCode, WorkingWeek,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  addUserAccount, ALL_MODULES, generateCompanyId, MODULE_LABELS, PLAN_RATES,
  usernameAvailable,
} from './lib';
import { PlanBadge } from './shared';

interface WizardData {
  name: string;
  code: string;
  regNo: string;
  hqState: StateCode;
  plan: CompanyPlan;
  workingWeek: WorkingWeek;
  payrollCutoffDay: string; // string while editing; parsed/validated on Next
  employeeIdPrefix: string;
  payslipPrefix: string;
  modules: ModuleKey[];
  username: string;
  password: string;
  confirmPassword: string;
}

function initialData(): WizardData {
  return {
    name: '',
    code: '',
    regNo: '',
    hqState: 'KUL',
    plan: 'free',
    workingWeek: defaultWorkingWeek('KUL'),
    payrollCutoffDay: '25',
    employeeIdPrefix: '',
    payslipPrefix: '',
    modules: [...ALL_MODULES],
    username: '',
    password: '',
    confirmPassword: '',
  };
}

const STEP_LABELS = ['Basics', 'Configuration', 'Admin account', 'Review'];

const autoEmpPrefix = (code: string) =>
  code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'EMP';
const autoPayslipPrefix = (code: string) => `${autoEmpPrefix(code)}-PS`;

export default function CreateCompanyWizard(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { open, onOpenChange } = props;
  const { companies, refreshCompanies, setActiveCompany } = useTenant();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [data, setData] = useState<WizardData>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    company: Company;
    username: string;
    password: string;
    accountCreated: boolean;
  } | null>(null);

  const patch = (p: Partial<WizardData>) => setData((d) => ({ ...d, ...p }));

  const setCode = (v: string) => {
    setData((d) => ({
      ...d,
      code: v,
      // Keep auto-derived prefixes in sync until the user overrides them.
      employeeIdPrefix:
        d.employeeIdPrefix === '' || d.employeeIdPrefix === autoEmpPrefix(d.code)
          ? autoEmpPrefix(v)
          : d.employeeIdPrefix,
      payslipPrefix:
        d.payslipPrefix === '' || d.payslipPrefix === autoPayslipPrefix(d.code)
          ? autoPayslipPrefix(v)
          : d.payslipPrefix,
    }));
  };

  const setHqState = (v: StateCode) => {
    // Weekend default follows the HQ state (fri-sat for JHR/KDH/KTN/TRG);
    // the user may override it afterwards in this step.
    patch({ hqState: v, workingWeek: defaultWorkingWeek(v) });
  };

  const toggleModule = (key: ModuleKey, checked: boolean) => {
    setData((d) => ({
      ...d,
      modules: checked ? [...d.modules, key] : d.modules.filter((m) => m !== key),
    }));
  };

  const validateStep = (): string | null => {
    if (step === 0) {
      if (data.name.trim().length < 2) return 'Company name is required (min 2 characters).';
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,11}$/.test(data.code.trim())) {
        return 'Company code must be 2–12 letters, digits or dashes (e.g. ACME).';
      }
      if (companies.some((c) => c.code.toLowerCase() === data.code.trim().toLowerCase())) {
        return `Code “${data.code.trim().toUpperCase()}” is already used by another company.`;
      }
      if (data.regNo.trim().length < 4) return 'SSM registration number is required.';
    }
    if (step === 1) {
      const cutoff = Number(data.payrollCutoffDay);
      if (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > 28) {
        return 'Payroll cutoff day must be a whole number between 1 and 28.';
      }
      if (data.employeeIdPrefix.trim() === '') return 'Employee ID prefix is required.';
      if (data.payslipPrefix.trim() === '') return 'Payslip prefix is required.';
      if (data.modules.length === 0) return 'Enable at least one module.';
    }
    if (step === 2) {
      if (!/^[a-z0-9._-]{3,32}$/i.test(data.username.trim())) {
        return 'Username must be 3–32 characters (letters, digits, dot, dash, underscore).';
      }
      if (!usernameAvailable(data.username.trim())) {
        return `Username “${data.username.trim()}” is already taken.`;
      }
      if (data.password.length < 6) return 'Password must be at least 6 characters.';
      if (data.confirmPassword !== data.password) return 'Passwords do not match.';
    }
    return null;
  };

  const next = () => {
    const err = validateStep();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setStep((s) => Math.min(s + 1, 3));
  };

  const back = () => {
    setError(null);
    setStep((s) => Math.max(s - 1, 0));
  };

  const create = () => {
    const err = validateStep();
    if (err) {
      setError(err);
      return;
    }
    const actor = user?.username ? `${user.username} (SuperAdmin)` : 'SuperAdmin';
    const code = data.code.trim().toUpperCase();
    const id = generateCompanyId(code, companies);
    const company: Company = {
      id,
      code,
      name: data.name.trim(),
      regNo: data.regNo.trim(),
      hqState: data.hqState,
      status: 'trial', // new tenants start on trial
      plan: data.plan,
      createdAt: new Date().toISOString(),
      branding: { logoText: code, accentColor: '#b45309' },
      config: {
        workingWeek: data.workingWeek,
        payrollCutoffDay: Number(data.payrollCutoffDay),
        claimPolicy: {},
        leaveTopUps: {},
        enabledModules: data.modules,
        customFields: [],
        numberFormats: {
          employeeIdPrefix: data.employeeIdPrefix.trim().toUpperCase(),
          payslipPrefix: data.payslipPrefix.trim(),
        },
        orgChart: { showDottedLineReports: false },
      },
    };
    upsertCompany(company);
    const accountCreated = addUserAccount({
      id: uid(),
      username: data.username.trim(),
      password: data.password,
      companyId: id,
      role: 'Admin',
    });
    logAudit(
      {
        actorName: actor,
        action: 'company.create',
        entity: 'companies',
        entityId: id,
        detail: `${company.name} (${code}) · plan=${company.plan} · admin=${data.username.trim()}`,
      },
      id,
    );
    refreshCompanies();
    setError(null);
    setCreated({
      company,
      username: data.username.trim(),
      password: data.password,
      accountCreated,
    });
  };

  const enterNewCompany = () => {
    if (!created) return;
    setActiveCompany(created.company.id);
    handleOpenChange(false);
    navigate('/');
  };

  const handleOpenChange = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setStep(0);
      setData(initialData());
      setError(null);
      setCreated(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-lime-600" />
                Company created
              </DialogTitle>
              <DialogDescription>
                {created.company.name} ({created.company.code}) is registered as a trial tenant.
                It starts EMPTY — no demo data was seeded. The first entry via “Enter company”
                initialises blank collections.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 rounded-lg border bg-stone-50 p-4 dark:bg-stone-900/40">
              <p className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4 text-amber-600" />
                First Admin account
              </p>
              {created.accountCreated ? (
                <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Username</dt>
                    <dd className="rounded bg-muted px-2 py-1 font-mono">{created.username}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Password</dt>
                    <dd className="rounded bg-muted px-2 py-1 font-mono">{created.password}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-red-600 dark:text-red-400">
                  The company was created, but the admin account could not be added (username
                  conflict or storage unavailable). Add it from the auth directory.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Demo only — credentials are stored in plaintext in localStorage. Hand them to the
                company's HR administrator; they can sign in at /login.
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Back to directory
              </Button>
              <Button onClick={enterNewCompany}>
                <ShieldCheck className="mr-1.5 h-4 w-4" />
                Enter company
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-amber-600" />
                New company
              </DialogTitle>
              <DialogDescription>
                Onboard a new tenant. Step {step + 1} of 4 — {STEP_LABELS[step]}.
              </DialogDescription>
            </DialogHeader>

            {/* Step indicator */}
            <div className="flex flex-wrap items-center gap-2">
              {STEP_LABELS.map((label, i) => (
                <div
                  key={label}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                    i === step
                      ? 'border-amber-600 bg-amber-50 font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                      : i < step
                        ? 'border-transparent bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-300'
                        : 'text-muted-foreground',
                  )}
                >
                  {i < step ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
                  <span>{label}</span>
                </div>
              ))}
            </div>

            {step === 0 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="sa-w-name">Company name</Label>
                  <Input
                    id="sa-w-name"
                    placeholder="e.g. Merdeka Manufacturing Sdn Bhd"
                    value={data.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-w-code">Company code</Label>
                  <Input
                    id="sa-w-code"
                    placeholder="e.g. MRD"
                    value={data.code}
                    maxLength={12}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Short unique code — drives the tenant id and default ID prefixes.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-w-regno">SSM registration no.</Label>
                  <Input
                    id="sa-w-regno"
                    placeholder="e.g. 202401012345 (1543210-X)"
                    value={data.regNo}
                    onChange={(e) => patch({ regNo: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>HQ state</Label>
                  <Select value={data.hqState} onValueChange={(v) => setHqState(v as StateCode)}>
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
                  <Select value={data.plan} onValueChange={(v) => patch({ plan: v as CompanyPlan })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="free">Free — RM0</SelectItem>
                      <SelectItem value="pro">Pro — RM{PLAN_RATES.pro}/emp/mo</SelectItem>
                      <SelectItem value="enterprise">
                        Enterprise — RM{PLAN_RATES.enterprise}/emp/mo
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    New companies always start with trial status.
                  </p>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Working week</Label>
                  <Select
                    value={data.workingWeek}
                    onValueChange={(v) => patch({ workingWeek: v as WorkingWeek })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sat-sun">Sat–Sun weekend</SelectItem>
                      <SelectItem value="fri-sat">Fri–Sat weekend (JHR/KDH/KTN/TRG)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Defaulted from HQ state — override if the company differs.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-w-cutoff">Payroll cutoff day</Label>
                  <Input
                    id="sa-w-cutoff"
                    type="number"
                    min={1}
                    max={28}
                    value={data.payrollCutoffDay}
                    onChange={(e) => patch({ payrollCutoffDay: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Day of month (1–28) when attendance/OT/claims close for payroll.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-w-empprefix">Employee ID prefix</Label>
                  <Input
                    id="sa-w-empprefix"
                    value={data.employeeIdPrefix}
                    maxLength={8}
                    onChange={(e) => patch({ employeeIdPrefix: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    e.g. {autoEmpPrefix(data.code) || 'ACME'}0001
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-w-psprefix">Payslip prefix</Label>
                  <Input
                    id="sa-w-psprefix"
                    value={data.payslipPrefix}
                    maxLength={12}
                    onChange={(e) => patch({ payslipPrefix: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    e.g. {autoPayslipPrefix(data.code) || 'ACME-PS'}-2026-01
                  </p>
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Enabled modules</Label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {ALL_MODULES.map((m) => (
                      <label
                        key={m}
                        className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                      >
                        <Checkbox
                          checked={data.modules.includes(m)}
                          onCheckedChange={(c) => toggleModule(m, c === true)}
                        />
                        {MODULE_LABELS[m]}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="sa-w-username">Admin username</Label>
                  <Input
                    id="sa-w-username"
                    placeholder="e.g. hr.admin"
                    autoComplete="off"
                    value={data.username}
                    onChange={(e) => patch({ username: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    The company's first Admin sign-in. Must be unique across all tenants.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-w-password">Password</Label>
                  <Input
                    id="sa-w-password"
                    type="password"
                    autoComplete="new-password"
                    value={data.password}
                    onChange={(e) => patch({ password: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-w-confirm">Confirm password</Label>
                  <Input
                    id="sa-w-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={data.confirmPassword}
                    onChange={(e) => patch({ confirmPassword: e.target.value })}
                  />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Demo only — mock auth stores passwords in plaintext in localStorage. Never use a
                  real password here.
                </p>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Company</dt>
                    <dd className="font-medium">
                      {data.name.trim() || '—'} ({data.code.trim().toUpperCase() || '—'})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">SSM reg no.</dt>
                    <dd className="font-medium">{data.regNo.trim() || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">HQ state</dt>
                    <dd className="font-medium">
                      {states.find((s) => s.code === data.hqState)?.name ?? data.hqState}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Plan / status</dt>
                    <dd className="flex items-center gap-2 font-medium">
                      <PlanBadge plan={data.plan} />
                      <Badge variant="outline" className="border-transparent bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300">
                        Trial
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Working week</dt>
                    <dd className="font-medium">
                      {data.workingWeek === 'fri-sat' ? 'Fri–Sat weekend' : 'Sat–Sun weekend'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Payroll cutoff</dt>
                    <dd className="font-medium">Day {data.payrollCutoffDay || '—'} of month</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Employee IDs</dt>
                    <dd className="font-medium">
                      {(data.employeeIdPrefix.trim().toUpperCase() || 'EMP') + '0001…'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Admin account</dt>
                    <dd className="font-medium">{data.username.trim() || '—'}</dd>
                  </div>
                </dl>
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Enabled modules ({data.modules.length})
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.modules.map((m) => (
                      <Badge key={m} variant="secondary">
                        {MODULE_LABELS[m]}
                      </Badge>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  The tenant is created EMPTY — employees, departments and settings are added by
                  the company's own Admin/HR after first sign-in.
                </p>
              </div>
            )}

            {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="outline" onClick={back} disabled={step === 0}>
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                Back
              </Button>
              {step < 3 ? (
                <Button onClick={next}>
                  Next
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              ) : (
                <Button onClick={create}>
                  <Check className="mr-1.5 h-4 w-4" />
                  Create company
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
