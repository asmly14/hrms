/**
 * Reusable field sections for the Add/Edit dialog and the New-Hire wizard.
 * Each section is controlled via `form` + `patch` and shows inline errors.
 */
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { states } from '@/lib/holidays';
import type { Department, Position } from '@/lib/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CarryInFormState, EmployeeFormState, FormErrors } from './types';
import { MY_BANKS, minimumWageWarning } from './helpers';

export type Patch = (patch: Partial<EmployeeFormState>) => void;

interface SectionProps {
  form: EmployeeFormState;
  patch: Patch;
  errors: FormErrors;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-red-600">{message}</p>;
}

const inputCls = 'rounded-lg';

export function PersonalFields({ form, patch, errors }: SectionProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="f-name">Full name *</Label>
        <Input
          id="f-name"
          className={inputCls}
          value={form.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="e.g. Aisha binti Rahman"
        />
        <FieldError message={errors.name} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-ic">NRIC / Passport no. *</Label>
        <Input
          id="f-ic"
          className={inputCls}
          value={form.ic}
          onChange={(e) => patch({ ic: e.target.value })}
          placeholder="900101-14-5566"
        />
        <FieldError message={errors.ic} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-dob">Date of birth *</Label>
        <Input
          id="f-dob"
          type="date"
          className={inputCls}
          value={form.dateOfBirth}
          onChange={(e) => patch({ dateOfBirth: e.target.value })}
        />
        <FieldError message={errors.dateOfBirth} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-email">Email *</Label>
        <Input
          id="f-email"
          type="email"
          className={inputCls}
          value={form.email}
          onChange={(e) => patch({ email: e.target.value })}
          placeholder="name@asmtech.my"
        />
        <FieldError message={errors.email} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-phone">Phone *</Label>
        <Input
          id="f-phone"
          className={inputCls}
          value={form.phone}
          onChange={(e) => patch({ phone: e.target.value })}
          placeholder="+6012-3456789"
        />
        <FieldError message={errors.phone} />
      </div>
      <div className="space-y-1.5">
        <Label>Gender</Label>
        <Select value={form.gender} onValueChange={(v) => patch({ gender: v as EmployeeFormState['gender'] })}>
          <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="male">Male</SelectItem>
            <SelectItem value="female">Female</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Marital status</Label>
        <Select
          value={form.maritalStatus}
          onValueChange={(v) => patch({ maritalStatus: v as EmployeeFormState['maritalStatus'] })}
        >
          <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="single">Single</SelectItem>
            <SelectItem value="married">Married</SelectItem>
            <SelectItem value="divorced">Divorced</SelectItem>
            <SelectItem value="widowed">Widowed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-children">Children (PCB relief)</Label>
        <Input
          id="f-children"
          inputMode="numeric"
          className={inputCls}
          value={form.children}
          onChange={(e) => patch({ children: e.target.value })}
        />
        <FieldError message={errors.children} />
      </div>
    </div>
  );
}

interface EmploymentFieldsProps extends SectionProps {
  departments: Department[];
  positions: Position[];
}

export function EmploymentFields({ form, patch, errors, departments, positions }: EmploymentFieldsProps) {
  const deptPositions = positions.filter((p) => p.departmentId === form.departmentId);
  const wageWarning = minimumWageWarning(form);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label>Department *</Label>
        <Select
          value={form.departmentId}
          onValueChange={(v) => patch({ departmentId: v, positionId: '' })}
        >
          <SelectTrigger className={inputCls}><SelectValue placeholder="Select department" /></SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError message={errors.departmentId} />
      </div>
      <div className="space-y-1.5">
        <Label>Position *</Label>
        <Select
          value={form.positionId}
          onValueChange={(v) => patch({ positionId: v })}
          disabled={!form.departmentId}
        >
          <SelectTrigger className={inputCls}>
            <SelectValue placeholder={form.departmentId ? 'Select position' : 'Pick a department first'} />
          </SelectTrigger>
          <SelectContent>
            {deptPositions.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError message={errors.positionId} />
      </div>
      <div className="space-y-1.5">
        <Label>Work location (state)</Label>
        <Select value={form.state} onValueChange={(v) => patch({ state: v as EmployeeFormState['state'] })}>
          <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
          <SelectContent>
            {states.map((s) => (
              <SelectItem key={s.code} value={s.code}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Employment type</Label>
        <Select
          value={form.employmentType}
          onValueChange={(v) => patch({ employmentType: v as EmployeeFormState['employmentType'] })}
        >
          <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="full-time">Full-time</SelectItem>
            <SelectItem value="part-time">Part-time</SelectItem>
            <SelectItem value="contract">Contract</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Status</Label>
        <Select value={form.status} onValueChange={(v) => patch({ status: v as EmployeeFormState['status'] })}>
          <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="probation">Probation</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="resigned">Resigned</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-join">Join date *</Label>
        <Input
          id="f-join"
          type="date"
          className={inputCls}
          value={form.joinDate}
          onChange={(e) => patch({ joinDate: e.target.value })}
        />
        <FieldError message={errors.joinDate} />
      </div>
      {form.status === 'resigned' && (
        <div className="space-y-1.5">
          <Label htmlFor="f-resign">Resignation date *</Label>
          <Input
            id="f-resign"
            type="date"
            className={inputCls}
            value={form.resignDate}
            onChange={(e) => patch({ resignDate: e.target.value })}
          />
          <FieldError message={errors.resignDate} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label>System role</Label>
        <Select value={form.role} onValueChange={(v) => patch({ role: v as EmployeeFormState['role'] })}>
          <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="employee">Employee</SelectItem>
            <SelectItem value="manager">Manager</SelectItem>
            <SelectItem value="hr">HR</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-salary">Base salary (RM / month) *</Label>
        <Input
          id="f-salary"
          inputMode="decimal"
          className={inputCls}
          value={form.baseSalary}
          onChange={(e) => patch({ baseSalary: e.target.value })}
          placeholder="3500.00"
        />
        <FieldError message={errors.baseSalary} />
        {wageWarning && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {wageWarning}
          </p>
        )}
      </div>
      <div className="space-y-2 sm:col-span-2">
        <div className="flex items-center justify-between">
          <Label>Fixed monthly allowances</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              patch({ fixedAllowances: [...form.fixedAllowances, { name: '', amount: '' }] })
            }
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Add
          </Button>
        </div>
        {form.fixedAllowances.length === 0 && (
          <p className="text-xs text-muted-foreground">None — e.g. Transport RM 500, Mobile RM 100.</p>
        )}
        {form.fixedAllowances.map((a, i) => (
          <div key={i} className="flex items-start gap-2">
            <Input
              className={inputCls}
              placeholder="Allowance name"
              value={a.name}
              onChange={(e) =>
                patch({
                  fixedAllowances: form.fixedAllowances.map((x, j) =>
                    j === i ? { ...x, name: e.target.value } : x,
                  ),
                })
              }
            />
            <Input
              className={`${inputCls} w-32`}
              placeholder="RM"
              inputMode="decimal"
              value={a.amount}
              onChange={(e) =>
                patch({
                  fixedAllowances: form.fixedAllowances.map((x, j) =>
                    j === i ? { ...x, amount: e.target.value } : x,
                  ),
                })
              }
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Remove allowance"
              onClick={() =>
                patch({ fixedAllowances: form.fixedAllowances.filter((_, j) => j !== i) })
              }
            >
              <Trash2 className="h-4 w-4 text-stone-500" />
            </Button>
          </div>
        ))}
        {form.fixedAllowances.map((_, i) =>
          errors[`allowance-${i}`] ? (
            <FieldError key={`err-${i}`} message={errors[`allowance-${i}`]} />
          ) : null,
        )}
      </div>
    </div>
  );
}

export function StatutoryFields({ form, patch, errors }: SectionProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="f-epf">EPF / KWSP member no.</Label>
        <Input
          id="f-epf"
          className={inputCls}
          value={form.epfNo}
          onChange={(e) => patch({ epfNo: e.target.value })}
          placeholder="12345678"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-socso">SOCSO / PERKESO no.</Label>
        <Input
          id="f-socso"
          className={inputCls}
          value={form.socsoNo}
          onChange={(e) => patch({ socsoNo: e.target.value })}
          placeholder="A1234567"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-tax">Income tax no.</Label>
        <Input
          id="f-tax"
          className={inputCls}
          value={form.taxNo}
          onChange={(e) => patch({ taxNo: e.target.value })}
          placeholder="SG 12345678"
        />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <Label htmlFor="f-foreign" className="cursor-pointer">Foreign worker</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            EPF 2% employee + 2% employer, mandatory from 1 Oct 2025.
          </p>
        </div>
        <Switch
          id="f-foreign"
          checked={form.isForeignWorker}
          onCheckedChange={(v) => patch({ isForeignWorker: v })}
        />
      </div>
      {errors.statutory && <FieldError message={errors.statutory} />}
    </div>
  );
}

export function BankFields({ form, patch, errors }: SectionProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="f-bank">Bank *</Label>
        <Input
          id="f-bank"
          className={inputCls}
          list="my-banks"
          value={form.bankName}
          onChange={(e) => patch({ bankName: e.target.value })}
          placeholder="Maybank"
        />
        <datalist id="my-banks">
          {MY_BANKS.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        <FieldError message={errors.bankName} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-acct">Account number *</Label>
        <Input
          id="f-acct"
          inputMode="numeric"
          className={inputCls}
          value={form.bankAccount}
          onChange={(e) => patch({ bankAccount: e.target.value })}
          placeholder="162010987654"
        />
        <FieldError message={errors.bankAccount} />
      </div>
    </div>
  );
}

interface CarryInFieldsProps {
  carryIn: CarryInFormState;
  patchCarryIn: (patch: Partial<CarryInFormState>) => void;
  /** Inline validation errors keyed `carryIn-gross` etc. (optional). */
  errors?: FormErrors;
}

/** TP3-style YTD carry-in from previous employment (same tax year). */
export function CarryInFields({ carryIn, patchCarryIn, errors }: CarryInFieldsProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <Label htmlFor="f-carryin" className="cursor-pointer">
            Prior-employer income this year (TP3)
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Capture year-to-date figures from the employee's previous employer so
            PCB/MTD is computed on the full-year picture from day one — no more
            under-deduction surprises. (SQL Payroll lacks guided TP3 capture.)
          </p>
        </div>
        <Switch
          id="f-carryin"
          checked={carryIn.enabled}
          onCheckedChange={(v) => patchCarryIn({ enabled: v })}
        />
      </div>
      {carryIn.enabled && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(
            [
              ['gross', 'YTD gross remuneration (RM)'],
              ['epf', 'YTD employee EPF (RM)'],
              ['socso', 'YTD employee SOCSO + EIS (RM)'],
              ['pcb', 'YTD PCB / MTD deducted (RM)'],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1.5">
              <Label>{label}</Label>
              <Input
                inputMode="decimal"
                className={inputCls}
                value={carryIn[key]}
                onChange={(e) => patchCarryIn({ [key]: e.target.value })}
                placeholder="0.00"
              />
              <FieldError message={errors?.[`carryIn-${key}`]} />
            </div>
          ))}
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Previous employer (optional note)</Label>
            <Input
              className={inputCls}
              value={carryIn.note}
              onChange={(e) => patchCarryIn({ note: e.target.value })}
              placeholder="e.g. ABC Sdn Bhd, Jan–Mar"
            />
          </div>
        </div>
      )}
    </div>
  );
}
