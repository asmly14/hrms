/**
 * Benefits tab of /loans — employer-managed BIK categories + recurring
 * benefit assignments.
 *
 * HR/Admin see:
 *  - the employer-level BIK summary strip (active benefits count + this
 *    month's injection cost split by statutory treatment),
 *  - the category cards row (seeded statutory defaults + custom categories,
 *    with treatment badges and PCB/EPF advice tooltips; add / edit /
 *    deactivate — categories are never hard-deleted),
 *  - the assignment registry with a Category column and the category-driven
 *    assign dialog (employee, category, amount, frequency, period), whose
 *    statutory advice panel follows the payItems.ts advisory pattern.
 *
 * Everyone else sees their own benefits read-only (unchanged scoping).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck, Car, CircleParking, Dumbbell, GraduationCap, HeartPulse,
  Home, Info, Layers, Pencil, Plus, Power, PowerOff, ShieldCheck, Square,
  SquarePlus, Stethoscope, Trash2, type LucideIcon,
} from 'lucide-react';
import {
  BENEFIT_CATEGORY_KIND_LABELS, BENEFIT_TREATMENT_ADVICE, BENEFIT_TREATMENT_LABELS,
  CATEGORY_PRESET_KEYS, benefitSummary, createBenefit, createBenefitCategory, deleteBenefit,
  deleteBenefitCategory, endBenefit,
  getBenefitCategories, suggestCategoryAdvice, updateBenefit, updateBenefitCategory,
  type BenefitCategory, type BenefitCategoryKind, type BenefitInput, type RecurringBenefit,
} from '@/lib/benefits';
import { useCollection } from '@/lib/db';
import { toastError, toastSuccess } from '@/lib/toast';
import { fmtRM, monthKey } from '@/lib/utils';
import { useAuthSafe } from '@/lib/useAuthSafe';
import type { BenefitTreatment, Employee } from '@/lib/types';
import { monthLabel } from '@/pages/payroll/helpers';
import { Money } from '@/pages/payroll/components';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const STATUS_VARIANTS: Record<RecurringBenefit['status'], 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  ended: 'secondary',
  cancelled: 'outline',
};

const KIND_ICONS: Record<BenefitCategoryKind, LucideIcon> = {
  medical: Stethoscope,
  parking: CircleParking,
  insurance: ShieldCheck,
  wellness: Dumbbell,
  membership: BadgeCheck,
  housing: Home,
  vehicle: Car,
  education: GraduationCap,
  other: Layers,
};

/** Short badge copy per treatment (full labels live in BENEFIT_TREATMENT_LABELS). */
const TREATMENT_BADGES: Record<BenefitTreatment, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  'nonStatutory-reimbursement': { label: 'Reimbursement', variant: 'outline' },
  'non-cash-bik': { label: 'Non-cash BIK', variant: 'secondary' },
  'taxable-allowance': { label: 'Taxable allowance', variant: 'default' },
};

interface Props {
  isHR: boolean;
  ownEmployeeId: string | null;
  employees: Employee[];
}

export default function BenefitsTab({ isHR, ownEmployeeId, employees }: Props) {
  const auth = useAuthSafe();
  const actor = auth?.user?.username ?? 'HR';
  const { items: benefits } = useCollection<RecurringBenefit>('benefits');
  const { items: categories } = useCollection<BenefitCategory>('benefitCategories');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringBenefit | null>(null);
  const [catDialogOpen, setCatDialogOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<BenefitCategory | null>(null);
  const [deleting, setDeleting] = useState<RecurringBenefit | null>(null);
  const [deletingCat, setDeletingCat] = useState<BenefitCategory | null>(null);

  function confirmDeleteBenefit(): void {
    if (!deleting) return;
    deleteBenefit(deleting.id, actor);
    toastSuccess(`${deleting.name} deleted`, 'Past payslips keep their history; only future injections stop.');
    setDeleting(null);
  }

  function confirmDeleteCategory(): void {
    if (!deletingCat) return;
    try {
      deleteBenefitCategory(deletingCat.id, actor);
      toastSuccess(`${deletingCat.name} deleted`);
      setDeletingCat(null);
    } catch (err) {
      // Guard: seeded defaults or referenced categories cannot be deleted —
      // the card's deactivate button is the offered alternative.
      toastError('Could not delete category — deactivate it instead', err);
      setDeletingCat(null);
    }
  }

  // Seed the statutory-default category catalog on first access (per tenant,
  // idempotent). The write notifies this same subscription, so the cards
  // populate on the next render.
  useEffect(() => {
    getBenefitCategories();
  }, []);

  const thisMonth = monthKey();
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const summary = useMemo(
    () => benefitSummary(thisMonth),
    [thisMonth, benefits], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Active-assignment count per category (for the category cards). */
  const assignmentsPerCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of benefits) {
      if (b.status !== 'active' || !b.categoryId) continue;
      counts.set(b.categoryId, (counts.get(b.categoryId) ?? 0) + 1);
    }
    return counts;
  }, [benefits]);

  const visible = useMemo(
    () =>
      (isHR ? benefits : benefits.filter((b) => b.employeeId === ownEmployeeId))
        .slice()
        .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt)),
    [benefits, isHR, ownEmployeeId],
  );

  const sortedCategories = useMemo(
    () =>
      categories
        .slice()
        .sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1) || a.name.localeCompare(b.name)),
    [categories],
  );

  return (
    <div className="space-y-4">
      {isHR && (
        <>
          {/* ── Employer-level BIK summary strip ── */}
          <div className="grid gap-4 sm:grid-cols-4">
            <Card className="rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <HeartPulse className="h-4 w-4" /> Active benefits
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums">{summary.activeCount}</p>
                <p className="text-xs text-muted-foreground">
                  {summary.injectableCount} injecting in {monthLabel(thisMonth)}
                </p>
              </CardContent>
            </Card>
            <Card className="rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Reimbursements — {monthLabel(thisMonth)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums">
                  {fmtRM(summary.byTreatment['nonStatutory-reimbursement'])}
                </p>
                <p className="text-xs text-muted-foreground">net only · no statutory</p>
              </CardContent>
            </Card>
            <Card className="rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Non-cash BIK — {monthLabel(thisMonth)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums">
                  {fmtRM(summary.byTreatment['non-cash-bik'])}
                </p>
                <p className="text-xs text-muted-foreground">PCB via TP2 · EA s.13(1)(b)</p>
              </CardContent>
            </Card>
            <Card className="rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Taxable allowances — {monthLabel(thisMonth)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums">
                  {fmtRM(summary.byTreatment['taxable-allowance'])}
                </p>
                <p className="text-xs text-muted-foreground">EPF + SOCSO + EIS + PCB</p>
              </CardContent>
            </Card>
          </div>

          {/* ── Category cards row ── */}
          <Card className="rounded-xl">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Benefit categories</CardTitle>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditingCat(null);
                  setCatDialogOpen(true);
                }}
              >
                <SquarePlus className="mr-2 h-4 w-4" /> New category
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sortedCategories.map((c) => {
                  const Icon = KIND_ICONS[c.kind] ?? Layers;
                  const badge = TREATMENT_BADGES[c.defaultTreatment];
                  const count = assignmentsPerCategory.get(c.id) ?? 0;
                  return (
                    <div
                      key={c.id}
                      className={`rounded-lg border p-3 ${c.active ? '' : 'opacity-60'}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-100 text-amber-700 dark:bg-amber-950/50">
                            <Icon className="h-4 w-4" />
                          </span>
                          <div>
                            <p className="text-sm font-medium leading-tight">
                              {c.name}
                              {c.custom && (
                                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                  custom
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {BENEFIT_CATEGORY_KIND_LABELS[c.kind]} · {count} active
                            </p>
                          </div>
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={`Statutory advice for ${c.name}`}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <Info className="h-4 w-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p className="text-xs font-semibold">PCB / income tax</p>
                            <p className="text-xs">{c.pcbNote}</p>
                            <p className="mt-2 text-xs font-semibold">EPF / SOCSO / EIS</p>
                            <p className="text-xs">{c.epfNote}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                          {!c.active && <Badge variant="outline">inactive</Badge>}
                        </div>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost" size="icon" aria-label={`Edit category ${c.name}`}
                            onClick={() => {
                              setEditingCat(c);
                              setCatDialogOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost" size="icon"
                            aria-label={`${c.active ? 'Deactivate' : 'Reactivate'} category ${c.name}`}
                            onClick={() => {
                              updateBenefitCategory(c.id, { active: !c.active }, actor);
                              toastSuccess(
                                c.active ? `${c.name} deactivated` : `${c.name} reactivated`,
                                c.active
                                  ? 'Existing assignments keep running; new assignments cannot pick it.'
                                  : 'It can be picked in the assign dialog again.',
                              );
                            }}
                          >
                            {c.active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                          </Button>
                          {c.custom && (
                            <Button
                              variant="ghost" size="icon" aria-label={`Delete category ${c.name}`}
                              className="text-destructive hover:text-destructive"
                              onClick={() => setDeletingCat(c)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* ── Assignment registry ── */}
      <Card className="rounded-xl">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {isHR ? 'Recurring benefits' : 'My benefits'}
          </CardTitle>
          {isHR && (
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" /> New benefit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50">
                <HeartPulse className="h-6 w-6" />
              </span>
              <p className="font-medium">{isHR ? 'No recurring benefits yet' : 'No benefits'}</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {isHR
                  ? 'Assign a benefit from a category — it injects into payroll automatically each run.'
                  : 'Recurring benefits granted by the company will appear here.'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {isHR && <TableHead>Employee</TableHead>}
                  <TableHead>Benefit</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Treatment</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  {isHR && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((b) => (
                  <TableRow key={b.id}>
                    {isHR && <TableCell>{empById.get(b.employeeId)?.name ?? b.employeeId}</TableCell>}
                    <TableCell className="font-medium">
                      {b.name}
                      {b.notes && <span className="block text-xs font-normal text-muted-foreground">{b.notes}</span>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.categoryId ? catById.get(b.categoryId)?.name ?? '—' : '—'}
                    </TableCell>
                    <TableCell className="text-right"><Money>{fmtRM(b.amount)}</Money></TableCell>
                    <TableCell>
                      {b.frequency === 'monthly' ? 'Monthly' : `Annual — ${MONTH_NAMES[(b.annualMonth ?? 1) - 1]}`}
                    </TableCell>
                    <TableCell>
                      <span className="text-xs">{BENEFIT_TREATMENT_LABELS[b.treatment]}</span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {monthLabel(b.startMonth)} → {b.endMonth ? monthLabel(b.endMonth) : 'open'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[b.status]}>{b.status}</Badge>
                    </TableCell>
                    {isHR && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost" size="icon" aria-label={`Edit ${b.name}`}
                            onClick={() => {
                              setEditing(b);
                              setDialogOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {b.status === 'active' && (
                            <Button
                              variant="ghost" size="icon" aria-label={`End ${b.name}`}
                              onClick={() => {
                                endBenefit(b.id, actor, monthKey());
                                toastSuccess(`${b.name} ended`, 'It will not inject into future payroll runs.');
                              }}
                            >
                              <Square className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost" size="icon" aria-label={`Delete ${b.name}`}
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleting(b)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>

        {isHR && (
          <AssignBenefitDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            employees={employees}
            categories={categories}
            editing={editing}
            actor={actor}
          />
        )}
      </Card>

      {isHR && (
        <CategoryFormDialog
          open={catDialogOpen}
          onOpenChange={setCatDialogOpen}
          editing={editingCat}
          actor={actor}
        />
      )}

      {/* Destructive confirms (HR only) */}
      {isHR && (
        <AlertDialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete benefit — {deleting?.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the assignment. Past payslips keep their history
                (they are snapshots); only future payroll injections stop. To keep a history
                row here instead, use End or Cancel.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep benefit</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={confirmDeleteBenefit}
              >
                Delete permanently
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {isHR && (
        <AlertDialog open={deletingCat !== null} onOpenChange={(o) => { if (!o) setDeletingCat(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete category — {deletingCat?.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Only possible while no benefit assignment uses this category; otherwise it is
                deactivated instead. Seeded statutory defaults can only be deactivated.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep category</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={confirmDeleteCategory}
              >
                Delete category
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
 * Assign benefit dialog (category-driven)
 * ──────────────────────────────────────────────────────────── */

interface AssignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[];
  categories: BenefitCategory[];
  editing: RecurringBenefit | null;
  actor: string;
}

function AssignBenefitDialog({ open, onOpenChange, employees, categories, editing, actor }: AssignDialogProps) {
  const [employeeId, setEmployeeId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<'monthly' | 'annual'>('monthly');
  const [annualMonth, setAnnualMonth] = useState('1');
  const [treatment, setTreatment] = useState<BenefitTreatment>('non-cash-bik');
  const [startMonth, setStartMonth] = useState(monthKey());
  const [endMonth, setEndMonth] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Picker: active categories; when editing, keep the current one selectable
  // even if it has since been deactivated.
  const pickable = useMemo(() => {
    const active = categories.filter((c) => c.active);
    if (editing?.categoryId && !active.some((c) => c.id === editing.categoryId)) {
      const current = categories.find((c) => c.id === editing.categoryId);
      if (current) return [...active, current];
    }
    return active;
  }, [categories, editing]);

  const category = pickable.find((c) => c.id === categoryId);

  function resetFrom(b: RecurringBenefit | null): void {
    setEmployeeId(b?.employeeId ?? '');
    setCategoryId(b?.categoryId ?? '');
    setName(b?.name ?? '');
    setAmount(b ? String(b.amount) : '');
    setFrequency(b?.frequency ?? 'monthly');
    setAnnualMonth(String(b?.annualMonth ?? 1));
    setTreatment(b?.treatment ?? 'non-cash-bik');
    setStartMonth(b?.startMonth ?? monthKey());
    setEndMonth(b?.endMonth ?? '');
    setNotes(b?.notes ?? '');
    setError(null);
  }

  function pickCategory(id: string): void {
    setCategoryId(id);
    const c = pickable.find((x) => x.id === id);
    if (c) {
      setTreatment(c.defaultTreatment);
      // Clear a name that just mirrors another category's name.
      if (!name || pickable.some((x) => x.name === name)) setName('');
    }
  }

  function submit(): void {
    try {
      const benefitKey = (category && CATEGORY_PRESET_KEYS[category.id]) || 'custom';
      // Explicit clear semantics (edit path): empty name reverts to the
      // preset/category default, empty endMonth removes the end date, empty
      // notes clears them, and switching to monthly drops annualMonth — the
      // lib treats '' as a CLEAR signal while omitted keys stay untouched.
      const input: BenefitInput = {
        employeeId,
        benefitKey,
        categoryId,
        name: name.trim(),
        amount: Number(amount),
        frequency,
        annualMonth: Number(annualMonth),
        treatment,
        startMonth,
        endMonth,
        notes: notes.trim(),
      };
      if (editing) {
        updateBenefit(editing.id, input, actor);
        toastSuccess('Benefit updated');
      } else {
        createBenefit(input, actor);
        toastSuccess('Benefit assigned', 'It will inject into payroll runs automatically.');
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      toastError('Could not save benefit', err);
    }
  }

  const eligible = employees
    .filter((e) => e.status !== 'resigned')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const valid =
    employeeId !== '' &&
    categoryId !== '' &&
    Number(amount) > 0 &&
    /^\d{4}-\d{2}$/.test(startMonth) &&
    (endMonth === '' || /^\d{4}-\d{2}$/.test(endMonth));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) resetFrom(editing);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit benefit' : 'Assign benefit'}</DialogTitle>
          <DialogDescription>
            Injected into every payroll run automatically (annual benefits only in their month).
            Draft payslips can skip a benefit for one run without deleting it here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Employee</Label>
              <Select value={employeeId} onValueChange={setEmployeeId} disabled={editing !== null}>
                <SelectTrigger><SelectValue placeholder="Pick an employee…" /></SelectTrigger>
                <SelectContent>
                  {eligible.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}{e.employeeNo ? ` (${e.employeeNo})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={categoryId} onValueChange={pickCategory}>
                <SelectTrigger><SelectValue placeholder="Pick a category…" /></SelectTrigger>
                <SelectContent>
                  {pickable.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}{c.active ? '' : ' (inactive)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bf-name">Name</Label>
              <Input
                id="bf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={category?.name ?? 'Benefit name'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bf-amount">Amount (RM)</Label>
              <Input
                id="bf-amount" type="number" min="0" step="0.01"
                value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="150.00"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Frequency</Label>
            <RadioGroup
              value={frequency}
              onValueChange={(v) => setFrequency(v as 'monthly' | 'annual')}
              className="flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="monthly" id="bf-monthly" />
                <Label htmlFor="bf-monthly" className="font-normal">Monthly</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="annual" id="bf-annual" />
                <Label htmlFor="bf-annual" className="font-normal">Annual</Label>
              </div>
            </RadioGroup>
            {frequency === 'annual' && (
              <div className="pt-1">
                <Label htmlFor="bf-annual-month">Inject in month</Label>
                <Select value={annualMonth} onValueChange={setAnnualMonth}>
                  <SelectTrigger id="bf-annual-month" className="mt-1 w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Statutory treatment</Label>
            <Select value={treatment} onValueChange={(v) => setTreatment(v as BenefitTreatment)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(BENEFIT_TREATMENT_LABELS) as BenefitTreatment[]).map((t) => (
                  <SelectItem key={t} value={t}>{BENEFIT_TREATMENT_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Statutory advice panel — per treatment (payItems advice style). */}
            <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
              <p className="flex items-start gap-1.5">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{BENEFIT_TREATMENT_ADVICE[treatment]}</span>
              </p>
              {category && (
                <div className="mt-2 space-y-1 border-t pt-2">
                  <p><span className="font-medium text-foreground">{category.name} — PCB:</span> {category.pcbNote}</p>
                  <p><span className="font-medium text-foreground">{category.name} — EPF/SOCSO/EIS:</span> {category.epfNote}</p>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bf-start">Start month</Label>
              <Input id="bf-start" type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bf-end">End month (optional)</Label>
              <Input id="bf-end" type="month" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bf-notes">Notes (optional)</Label>
            <Textarea id="bf-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!valid}>{editing ? 'Save changes' : 'Assign benefit'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────
 * Category form dialog (add custom / edit + advice)
 * ──────────────────────────────────────────────────────────── */

interface CategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: BenefitCategory | null;
  actor: string;
}

function CategoryFormDialog({ open, onOpenChange, editing, actor }: CategoryDialogProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BenefitCategoryKind>('other');
  const [defaultTreatment, setDefaultTreatment] = useState<BenefitTreatment>('non-cash-bik');
  const [pcbNote, setPcbNote] = useState('');
  const [epfNote, setEpfNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  function resetFrom(c: BenefitCategory | null): void {
    setName(c?.name ?? '');
    setKind(c?.kind ?? 'other');
    setDefaultTreatment(c?.defaultTreatment ?? suggestCategoryAdvice('other').defaultTreatment);
    setPcbNote(c?.pcbNote ?? suggestCategoryAdvice('other').pcbNote);
    setEpfNote(c?.epfNote ?? suggestCategoryAdvice('other').epfNote);
    setError(null);
  }

  /** Kind change auto-suggests the treatment + advice text (editable after). */
  function pickKind(k: BenefitCategoryKind): void {
    setKind(k);
    const suggested = suggestCategoryAdvice(k);
    setDefaultTreatment(suggested.defaultTreatment);
    setPcbNote(suggested.pcbNote);
    setEpfNote(suggested.epfNote);
  }

  function submit(): void {
    try {
      if (editing) {
        updateBenefitCategory(
          editing.id,
          { name, kind, defaultTreatment, pcbNote, epfNote },
          actor,
        );
        toastSuccess('Category updated');
      } else {
        createBenefitCategory({ name, kind, defaultTreatment, pcbNote, epfNote }, actor);
        toastSuccess('Category created', 'It is now available in the assign dialog.');
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      toastError('Could not save category', err);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) resetFrom(editing);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit category — ${editing.name}` : 'New benefit category'}</DialogTitle>
          <DialogDescription>
            Categories group benefits and carry the default statutory treatment plus the PCB/EPF
            advice shown in the assign dialog. Deactivate from the card when a category is retired.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bc-name">Name</Label>
              <Input
                id="bc-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Mobile Phone Subsidy"
              />
            </div>
            <div className="space-y-2">
              <Label>Kind</Label>
              <Select value={kind} onValueChange={(v) => pickKind(v as BenefitCategoryKind)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(BENEFIT_CATEGORY_KIND_LABELS) as BenefitCategoryKind[]).map((k) => (
                    <SelectItem key={k} value={k}>{BENEFIT_CATEGORY_KIND_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Default statutory treatment</Label>
            <Select value={defaultTreatment} onValueChange={(v) => setDefaultTreatment(v as BenefitTreatment)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(BENEFIT_TREATMENT_LABELS) as BenefitTreatment[]).map((t) => (
                  <SelectItem key={t} value={t}>{BENEFIT_TREATMENT_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{BENEFIT_TREATMENT_ADVICE[defaultTreatment]}</span>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bc-pcb">PCB / income-tax advice</Label>
            <Textarea id="bc-pcb" value={pcbNote} onChange={(e) => setPcbNote(e.target.value)} rows={2} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bc-epf">EPF / SOCSO / EIS advice</Label>
            <Textarea id="bc-epf" value={epfNote} onChange={(e) => setEpfNote(e.target.value)} rows={2} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name.trim()}>{editing ? 'Save changes' : 'Create category'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
