import { useEffect, useState } from 'react';
import { logAudit, useCollection } from '@/lib/db';
import { useAuth } from '@/lib/authContext';
import { useTenant } from '@/lib/tenantContext';
import type { Department, Employee, Position } from '@/lib/types';
import { coerceCustomValue, getEmployeeCustomFields } from '@/pages/company/customFields';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  BankFields,
  CarryInFields,
  EmploymentFields,
  PersonalFields,
  StatutoryFields,
} from './EmployeeFormFields';
import type { CarryInFormState, EmployeeFormState, FormErrors } from './types';
import { customOf } from './types';
import {
  carryInFromEmployee,
  emptyCarryIn,
  emptyForm,
  employeeFromForm,
  findDuplicate,
  formFromEmployee,
  validateCarryIn,
  validateForm,
} from './helpers';

interface EmployeeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided the dialog edits that employee; otherwise it creates one. */
  employee?: Employee;
  onSaved?: (emp: Employee) => void;
}

export function EmployeeFormDialog({ open, onOpenChange, employee, onSaved }: EmployeeFormDialogProps) {
  const { role, user } = useAuth();
  /** Add/edit are Admin/HR-only mutations (managers get read-only access). */
  const canEdit = role === 'Admin' || role === 'HR';
  const actorName = user?.username ?? 'HR Admin';

  const { items: employees, add, update } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');

  // Company-defined custom fields (built in /company → Custom Fields).
  const { activeCompany } = useTenant();
  const customFields = getEmployeeCustomFields(activeCompany);

  const [form, setForm] = useState<EmployeeFormState>(emptyForm());
  const [carryIn, setCarryIn] = useState<CarryInFormState>(emptyCarryIn());
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(employee ? formFromEmployee(employee) : emptyForm());
      setCarryIn(employee ? carryInFromEmployee(employee) : emptyCarryIn());
      const stored = employee ? customOf(employee) : {};
      const init: Record<string, string> = {};
      for (const f of customFields) {
        const v = stored[f.id];
        init[f.id] = v === undefined || v === null ? '' : String(v);
      }
      setCustomValues(init);
      setErrors({});
      setSubmitted(false);
    }
    // customFields identity changes on tenant switch; employee/open are the
    // real triggers — field definitions only seed blank keys for new fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee]);

  /** Field validation + TP3 amounts + duplicate NRIC/email (excluding self on edit). */
  const validateAll = (
    f: EmployeeFormState,
    c: CarryInFormState,
    cv: Record<string, string> = customValues,
  ): FormErrors => {
    const errs: FormErrors = { ...validateForm(f), ...validateCarryIn(c) };
    const dup = findDuplicate(employees, f, employee?.id);
    if (dup) {
      errs[dup.field] =
        `Already used by ${dup.name} — ${dup.field === 'ic' ? 'NRIC' : 'email'} must be unique`;
    }
    for (const field of customFields) {
      if (field.required && !(cv[field.id] ?? '').trim()) {
        errs[`custom-${field.id}`] = `${field.label} is required`;
      }
    }
    return errs;
  };

  const patch = (p: Partial<EmployeeFormState>) => {
    setForm((f) => {
      const next = { ...f, ...p };
      if (submitted) setErrors(validateAll(next, carryIn));
      return next;
    });
  };
  const patchCarryIn = (p: Partial<CarryInFormState>) => {
    setCarryIn((c) => {
      const next = { ...c, ...p };
      if (submitted) setErrors(validateAll(form, next));
      return next;
    });
  };
  const patchCustom = (id: string, value: string) => {
    setCustomValues((cv) => {
      const next = { ...cv, [id]: value };
      if (submitted) setErrors(validateAll(form, carryIn, next));
      return next;
    });
  };

  const save = () => {
    if (!canEdit) return;
    const errs = validateAll(form, carryIn);
    setErrors(errs);
    setSubmitted(true);
    if (Object.keys(errs).length > 0) return;

    const record = employeeFromForm(form, carryIn, employee);
    // Additive custom-field values (undefined entries dropped so cleared
    // values don't linger as empty strings). Cast: `custom` is a
    // storage-level additive property tracked in employees/types.ts.
    let recordWithCustom = record as Omit<Employee, 'id'> & { custom?: Record<string, unknown> };
    if (customFields.length > 0) {
      const custom: Record<string, unknown> = {};
      for (const f of customFields) {
        const v = coerceCustomValue(f, customValues[f.id] ?? '');
        if (v !== undefined) custom[f.id] = v;
      }
      recordWithCustom = { ...recordWithCustom, custom };
    }
    let saved: Employee;
    if (employee) {
      update(employee.id, recordWithCustom as Partial<Employee>);
      saved = { ...recordWithCustom, id: employee.id } as Employee;
      logAudit({
        actorName,
        action: 'employee.update',
        entity: 'employees',
        entityId: employee.id,
        detail: `Updated ${record.name}`,
      });
    } else {
      saved = add(recordWithCustom as Omit<Employee, 'id'>);
      logAudit({
        actorName,
        action: 'employee.create',
        entity: 'employees',
        entityId: saved.id,
        detail: `Added ${record.name} (${record.employmentType})`,
      });
    }
    onSaved?.(saved);
    onOpenChange(false);
  };

  if (!canEdit) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{employee ? 'Edit employee' : 'Add employee'}</DialogTitle>
          <DialogDescription>
            {employee
              ? `Update ${employee.name}'s record. Changes sync to payroll, leave and statutory calculations.`
              : 'Fill in the essentials below — or use the guided New-Hire Wizard for step-by-step onboarding with TP3 carry-in.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Personal</h3>
            <PersonalFields form={form} patch={patch} errors={errors} />
          </section>
          <Separator />
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Employment &amp; compensation</h3>
            <EmploymentFields
              form={form}
              patch={patch}
              errors={errors}
              departments={departments}
              positions={positions}
            />
          </section>
          <Separator />
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Statutory numbers</h3>
            <StatutoryFields form={form} patch={patch} errors={errors} />
          </section>
          <Separator />
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Bank</h3>
            <BankFields form={form} patch={patch} errors={errors} />
          </section>
          <Separator />
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">TP3 carry-in</h3>
            <CarryInFields carryIn={carryIn} patchCarryIn={patchCarryIn} errors={errors} />
          </section>
          {customFields.length > 0 && (
            <>
              <Separator />
              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">Additional information</h3>
                <p className="text-xs text-muted-foreground">
                  Company-specific fields defined in Company Setup → Custom Fields.
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {customFields.map((f) => {
                    const errKey = `custom-${f.id}`;
                    const value = customValues[f.id] ?? '';
                    return (
                      <div key={f.id} className="space-y-1.5">
                        <Label htmlFor={`cf-${f.id}`}>
                          {f.label}
                          {f.required ? ' *' : ''}
                        </Label>
                        {f.type === 'select' ? (
                          <Select value={value} onValueChange={(v) => patchCustom(f.id, v)}>
                            <SelectTrigger id={`cf-${f.id}`} className="rounded-lg">
                              <SelectValue placeholder="Select…" />
                            </SelectTrigger>
                            <SelectContent>
                              {(f.options ?? []).map((o) => (
                                <SelectItem key={o} value={o}>
                                  {o}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            id={`cf-${f.id}`}
                            className="rounded-lg"
                            type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
                            value={value}
                            onChange={(e) => patchCustom(f.id, e.target.value)}
                          />
                        )}
                        {errors[errKey] ? <p className="text-xs text-red-600">{errors[errKey]}</p> : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save}>{employee ? 'Save changes' : 'Add employee'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
