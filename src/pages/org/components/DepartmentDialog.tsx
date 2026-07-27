/**
 * DepartmentDialog — create/edit a department: name, code, location state,
 * head (employee picker), cost centre code and colour (the last two persist
 * to the org designer's departmentProfiles collection).
 */
import { useState } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { states } from '@/lib/holidays';
import { DEPT_COLOR_PALETTE, defaultDeptColor } from '@/lib/orgChart';
import { cn } from '@/lib/utils';
import type { Department, Employee, StateCode } from '@/lib/types';

export interface DepartmentFormValues {
  name: string;
  code: string;
  state: StateCode;
  headId?: string;
  costCenter: string;
  color: string;
}

const NO_HEAD = '__none__';

export default function DepartmentDialog({
  open,
  onOpenChange,
  department,
  initialCostCenter,
  initialColor,
  employees,
  existingCodes,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined = create mode. */
  department?: Department;
  initialCostCenter?: string;
  initialColor?: string;
  employees: Employee[];
  /** Codes already taken (upper-cased), excluding the edited department. */
  existingCodes: string[];
  onSubmit: (values: DepartmentFormValues) => void;
}) {
  const isEdit = Boolean(department);
  const [name, setName] = useState(department?.name ?? '');
  const [code, setCode] = useState(department?.code ?? '');
  const [state, setState] = useState<StateCode>(department?.state ?? 'KUL');
  const [headId, setHeadId] = useState<string>(department?.headId ?? NO_HEAD);
  const [costCenter, setCostCenter] = useState(initialCostCenter ?? '');
  const [color, setColor] = useState(initialColor || defaultDeptColor((department?.id ?? name) || 'new'));
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!name.trim()) return setError('A department name is required.');
    if (!code.trim()) return setError('A short code is required (e.g. ENG).');
    if (existingCodes.includes(code.trim().toUpperCase())) {
      return setError(`Code "${code.trim().toUpperCase()}" is already used by another department.`);
    }
    setError(null);
    onSubmit({
      name: name.trim(),
      code: code.trim().toUpperCase(),
      state,
      headId: headId === NO_HEAD ? undefined : headId,
      costCenter: costCenter.trim(),
      color,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit department' : 'New department'}</DialogTitle>
          <DialogDescription>
            Departments group positions and employees; the head and colour appear on the org chart.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dd-name">Name</Label>
              <Input id="dd-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dd-code">Code</Label>
              <Input id="dd-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ENG" maxLength={8} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Location (state)</Label>
              <Select value={state} onValueChange={(s) => setState(s as StateCode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {states.map((s) => (
                    <SelectItem key={s.code} value={s.code}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dd-cc">Cost centre</Label>
              <Input
                id="dd-cc"
                value={costCenter}
                onChange={(e) => setCostCenter(e.target.value)}
                placeholder="e.g. CC-100"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Department head</Label>
            <Select value={headId} onValueChange={setHeadId}>
              <SelectTrigger>
                <SelectValue placeholder="No head assigned" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={NO_HEAD}>— None —</SelectItem>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The head's position becomes the department's lead in the derived org chart.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Colour</Label>
            <div className="flex flex-wrap items-center gap-2">
              {DEPT_COLOR_PALETTE.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  title={c.name}
                  onClick={() => setColor(c.value)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full border-2 transition',
                    color === c.value ? 'border-foreground' : 'border-transparent',
                  )}
                  style={{ backgroundColor: c.value }}
                >
                  {color === c.value && <Check className="h-4 w-4 text-white" />}
                </button>
              ))}
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-10 cursor-pointer rounded-md border bg-transparent p-0.5"
                title="Custom colour"
              />
            </div>
          </div>

          {error && (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <CircleAlert className="h-4 w-4" /> {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>{isEdit ? 'Save changes' : 'Create department'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
