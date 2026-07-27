import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Landmark, Receipt, ShieldCheck, User, Briefcase } from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import { useAuth } from '@/lib/authContext';
import { cn, fmtRM } from '@/lib/utils';
import type { Department, Employee, Position } from '@/lib/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  BankFields,
  CarryInFields,
  EmploymentFields,
  PersonalFields,
  StatutoryFields,
} from './EmployeeFormFields';
import type { CarryInFormState, EmployeeFormState, FormErrors } from './types';
import {
  deptName,
  emptyCarryIn,
  emptyForm,
  employeeFromForm,
  findDuplicate,
  positionTitle,
  validateCarryIn,
  validateForm,
} from './helpers';

const STEPS = [
  { key: 'personal', title: 'Personal', icon: User },
  { key: 'employment', title: 'Employment', icon: Briefcase },
  { key: 'statutory', title: 'Statutory', icon: ShieldCheck },
  { key: 'bank', title: 'Bank', icon: Landmark },
  { key: 'tp3', title: 'TP3 carry-in', icon: Receipt },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

interface NewHireWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Guided multi-step onboarding: personal → employment → statutory numbers →
 * bank → TP3-style YTD carry-in from the previous employer (stored on the
 * employee record as `ytdCarryIn`). Validates per step before advancing.
 * Admin/HR only — managers and employees cannot create records.
 */
export function NewHireWizard({ open, onOpenChange }: NewHireWizardProps) {
  const navigate = useNavigate();
  const { role, user } = useAuth();
  const canEdit = role === 'Admin' || role === 'HR';
  const actorName = user?.username ?? 'HR Admin';

  const { items: employees, add } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<EmployeeFormState>(emptyForm());
  const [carryIn, setCarryIn] = useState<CarryInFormState>(emptyCarryIn());
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (open) {
      setStep(0);
      setForm(emptyForm());
      setCarryIn(emptyCarryIn());
      setErrors({});
    }
  }, [open]);

  const patch = (p: Partial<EmployeeFormState>) => {
    setForm((f) => ({ ...f, ...p }));
    setErrors({});
  };
  const patchCarryIn = (p: Partial<CarryInFormState>) => {
    setCarryIn((c) => ({ ...c, ...p }));
    setErrors({});
  };

  const stepKey: StepKey = STEPS[step].key;

  const next = () => {
    if (stepKey !== 'tp3') {
      const errs = validateForm(form, stepKey);
      setErrors(errs);
      if (Object.keys(errs).length > 0) return;
    }
    if (step < STEPS.length - 1) setStep(step + 1);
  };

  const back = () => setStep((s) => Math.max(0, s - 1));

  const finish = () => {
    if (!canEdit) return;
    // Full main-form validation + TP3 carry-in amounts + duplicate NRIC/email.
    const errs: FormErrors = { ...validateForm(form), ...validateCarryIn(carryIn) };
    const dup = findDuplicate(employees, form);
    if (dup) {
      errs[dup.field] =
        `Already used by ${dup.name} — ${dup.field === 'ic' ? 'NRIC' : 'email'} must be unique`;
    }
    if (Object.keys(errs).length > 0) {
      // Jump back to the first step that has an error (personal holds ic/email
      // for duplicates; carry-in errors stay on the current tp3 step).
      const order: Array<'personal' | 'employment' | 'statutory' | 'bank'> = ['personal', 'employment', 'statutory', 'bank'];
      const idx = order.findIndex((k) => Object.keys(validateForm(form, k)).length > 0);
      if (idx >= 0) setStep(idx);
      else if (dup) setStep(0);
      setErrors(errs);
      return;
    }
    const record = employeeFromForm(form, carryIn);
    const saved = add(record);
    logAudit({
      actorName,
      action: 'employee.create',
      entity: 'employees',
      entityId: saved.id,
      detail: `New hire ${record.name} onboarded via wizard${carryIn.enabled ? ' (TP3 carry-in captured)' : ''}`,
    });
    onOpenChange(false);
    navigate(`/employees/${saved.id}`);
  };

  const allowanceTotal = form.fixedAllowances
    .filter((a) => a.name.trim() && Number(a.amount) > 0)
    .reduce((s, a) => s + (Number(a.amount) || 0), 0);

  if (!canEdit) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New-Hire Wizard</DialogTitle>
          <DialogDescription>
            Step {step + 1} of {STEPS.length} — {STEPS[step].title}
          </DialogDescription>
        </DialogHeader>

        {/* Stepper */}
        <ol className="flex items-center gap-1 overflow-x-auto pb-1">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const done = i < step;
            const current = i === step;
            return (
              <li key={s.key} className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => i < step && setStep(i)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                    current && 'bg-amber-100 text-amber-900',
                    done && 'bg-lime-100 text-lime-800 hover:bg-lime-200',
                    !current && !done && 'bg-stone-100 text-stone-500',
                  )}
                >
                  {done ? <Check className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
                  <span className="hidden sm:inline">{s.title}</span>
                </button>
                {i < STEPS.length - 1 && <span className="h-px w-3 bg-border" />}
              </li>
            );
          })}
        </ol>

        <div className="py-2">
          {stepKey === 'personal' && <PersonalFields form={form} patch={patch} errors={errors} />}
          {stepKey === 'employment' && (
            <EmploymentFields
              form={form}
              patch={patch}
              errors={errors}
              departments={departments}
              positions={positions}
            />
          )}
          {stepKey === 'statutory' && <StatutoryFields form={form} patch={patch} errors={errors} />}
          {stepKey === 'bank' && <BankFields form={form} patch={patch} errors={errors} />}
          {stepKey === 'tp3' && (
            <div className="space-y-6">
              <CarryInFields carryIn={carryIn} patchCarryIn={patchCarryIn} errors={errors} />
              {/* Live summary */}
              <div className="rounded-xl bg-stone-50 p-4 text-sm">
                <p className="mb-2 font-medium text-foreground">Summary</p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-muted-foreground">
                  <dt>Name</dt>
                  <dd className="text-right font-medium text-foreground">{form.name || '—'}</dd>
                  <dt>Department</dt>
                  <dd className="text-right font-medium text-foreground">{deptName(departments, form.departmentId)}</dd>
                  <dt>Position</dt>
                  <dd className="text-right font-medium text-foreground">{positionTitle(positions, form.positionId)}</dd>
                  <dt>Package</dt>
                  <dd className="text-right font-medium text-foreground">
                    {form.baseSalary
                      ? `${fmtRM(Number(form.baseSalary) || 0)}${allowanceTotal > 0 ? ` + ${fmtRM(allowanceTotal)} allow.` : ''}`
                      : '—'}
                  </dd>
                  <dt>TP3 carry-in</dt>
                  <dd className="text-right font-medium text-foreground">
                    {carryIn.enabled ? `${fmtRM(Number(carryIn.gross) || 0)} gross YTD` : 'None'}
                  </dd>
                </dl>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <Button variant="outline" onClick={back} disabled={step === 0}>
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={next}>
              Next <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={finish}>
              <Check className="mr-1.5 h-4 w-4" /> Create employee
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
