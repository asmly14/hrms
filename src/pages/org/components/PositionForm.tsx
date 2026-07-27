/**
 * PositionForm — full position + job-description editor used by both the
 * /org structure manager (inside a Dialog) and the /org/chart designer
 * (inside a side Sheet). Edits base Position fields (title, department,
 * level, salary band) plus PositionProfile extras (grade, reporting lines,
 * JD, responsibilities, qualifications, headcount budget).
 */
import { useMemo, useState } from 'react';
import { CircleAlert, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  GRADES,
  benchmarkForPosition,
  benchmarkTemplate,
  gradeForLevel,
  seniorityForLevel,
  templateBand,
} from '@/lib/orgChart';
import { listRoles } from '@/lib/salaryBenchmark';
import { fmtRM } from '@/lib/utils';
import type { Department, Position, PositionLevel, StateCode } from '@/lib/types';
import { type PositionFormValues } from './positionFormShared';

const LEVELS: { value: PositionLevel; label: string }[] = [
  { value: 'junior', label: 'Junior' },
  { value: 'senior', label: 'Senior' },
  { value: 'lead', label: 'Lead' },
  { value: 'manager', label: 'Manager' },
  { value: 'exec', label: 'Executive' },
];

const ROOT = '__root__';
const NONE = '__none__';

/** Small list editor for responsibilities / qualifications. */
export function StringListEditor({
  items,
  onChange,
  placeholder,
  addLabel,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
}) {
  const update = (idx: number, value: string) => {
    const next = [...items];
    next[idx] = value;
    onChange(next);
  };
  const removeAt = (idx: number) => onChange(items.filter((_, i) => i !== idx));
  return (
    <div className="space-y-2">
      {items.map((item, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{idx + 1}.</span>
          <Input value={item} onChange={(e) => update(idx, e.target.value)} placeholder={placeholder} />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => removeAt(idx)}
            aria-label="Remove item"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, ''])}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

export interface PositionFormProps {
  initial: PositionFormValues;
  positions: Position[];
  departments: Department[];
  /** Position ids that may NOT be chosen as parent (self + its descendants). */
  excludedParentIds: Set<string>;
  /** Tenant HQ state — drives the wage-market factor in suggestions. */
  hqState: StateCode;
  /** Whether dotted-line (matrix) reporting is enabled in company config. */
  showDottedLine: boolean;
  onSubmit: (values: PositionFormValues) => void;
  onCancel: () => void;
  submitLabel?: string;
}

export default function PositionForm({
  initial,
  positions,
  departments,
  excludedParentIds,
  hqState,
  showDottedLine,
  onSubmit,
  onCancel,
  submitLabel = 'Save position',
}: PositionFormProps) {
  const [v, setV] = useState<PositionFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<PositionFormValues>) => setV((prev) => ({ ...prev, ...p }));

  const roles = useMemo(() => listRoles(), []);
  const deptName = departments.find((d) => d.id === v.departmentId)?.name;

  const suggestion = useMemo(
    () => (v.title.trim() ? benchmarkForPosition(v.title, v.level, hqState, deptName) : null),
    [v.title, v.level, hqState, deptName],
  );

  const parentOptions = positions.filter((p) => !excludedParentIds.has(p.id));
  const positionTitle = (id: string | null | undefined) =>
    positions.find((p) => p.id === id)?.title ?? '—';

  const applyTemplate = (role: string) => {
    const row = benchmarkTemplate(role);
    if (!row) return;
    const band = templateBand(role, v.level);
    patch({
      jobDescription: row.jobDescription,
      qualifications: row.qualifications
        .split(/;\s*/)
        .map((q) => q.trim().replace(/\.$/, ''))
        .filter(Boolean),
      ...(band ? { minSalary: band.min, maxSalary: band.max } : {}),
    });
  };

  const submit = () => {
    if (!v.title.trim()) return setError('A job title is required.');
    if (!v.departmentId) return setError('Choose a department.');
    if (v.minSalary < 0 || v.maxSalary < 0) return setError('Salary band cannot be negative.');
    if (v.maxSalary > 0 && v.minSalary > v.maxSalary) {
      return setError('Minimum salary cannot exceed maximum salary.');
    }
    setError(null);
    onSubmit({
      ...v,
      title: v.title.trim(),
      responsibilities: v.responsibilities.map((r) => r.trim()).filter(Boolean),
      qualifications: v.qualifications.map((q) => q.trim()).filter(Boolean),
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="jd">Job description</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="pf-title">Job title</Label>
            <Input
              id="pf-title"
              value={v.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="e.g. Senior Software Engineer"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Market template (optional)</Label>
            <Select onValueChange={applyTemplate}>
              <SelectTrigger>
                <SelectValue placeholder="Prefill JD & band from market data…" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {roles.map((r) => (
                  <SelectItem key={r.role} value={r.role}>
                    {r.role} <span className="text-muted-foreground">· {r.industry}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Fills the job description, qualifications and salary band from the Malaysian
              2025–26 benchmark dataset.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Department</Label>
              <Select value={v.departmentId} onValueChange={(id) => patch({ departmentId: id })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Level</Label>
              <Select
                value={v.level}
                onValueChange={(lvl) => {
                  const level = lvl as PositionLevel;
                  patch({ level, grade: gradeForLevel(level) });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Grade</Label>
              <Select value={v.grade} onValueChange={(g) => patch({ grade: g })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GRADES.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Reports to</Label>
              <Select
                value={v.reportsToPositionId ?? ROOT}
                onValueChange={(id) => patch({ reportsToPositionId: id === ROOT ? null : id })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT}>— Organisation root —</SelectItem>
                  {parentOptions.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {showDottedLine && (
            <div className="space-y-1.5">
              <Label>Secondary (dotted-line) manager</Label>
              <Select
                value={v.dottedLineReportsToPositionId ?? NONE}
                onValueChange={(id) =>
                  patch({ dottedLineReportsToPositionId: id === NONE ? null : id })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {parentOptions
                    .filter((p) => p.id !== v.reportsToPositionId)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.title}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Matrix / co-report drawn as a dashed line on the org chart.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Salary band (RM / month)</Label>
            <div className="grid grid-cols-2 gap-3">
              <Input
                type="number"
                min={0}
                value={Number.isNaN(v.minSalary) ? '' : v.minSalary}
                onChange={(e) => patch({ minSalary: e.target.value === '' ? 0 : Number(e.target.value) })}
                placeholder="Min"
              />
              <Input
                type="number"
                min={0}
                value={Number.isNaN(v.maxSalary) ? '' : v.maxSalary}
                onChange={(e) => patch({ maxSalary: e.target.value === '' ? 0 : Number(e.target.value) })}
                placeholder="Max"
              />
            </div>
            {suggestion && (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <Sparkles className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Market ({suggestion.matchedRole}, {seniorityForLevel(v.level)}+ yrs):{' '}
                  <strong>{fmtRM(suggestion.min)} – {fmtRM(suggestion.max)}</strong>, median{' '}
                  <strong>{fmtRM(suggestion.median)}</strong>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7 px-2 text-xs"
                  onClick={() => patch({ minSalary: suggestion.min, maxSalary: suggestion.max })}
                >
                  Apply band
                </Button>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="jd" className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="pf-jd">Role summary</Label>
            <Textarea
              id="pf-jd"
              rows={4}
              value={v.jobDescription}
              onChange={(e) => patch({ jobDescription: e.target.value })}
              placeholder="What this role owns and how it contributes…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Key responsibilities</Label>
            <StringListEditor
              items={v.responsibilities}
              onChange={(responsibilities) => patch({ responsibilities })}
              placeholder="e.g. Own month-end close and statutory reporting"
              addLabel="Add responsibility"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Requirements & qualifications</Label>
            <StringListEditor
              items={v.qualifications}
              onChange={(qualifications) => patch({ qualifications })}
              placeholder="e.g. ACCA / CPA / MIA part-qualified"
              addLabel="Add requirement"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-hc">Headcount budget</Label>
            <Input
              id="pf-hc"
              type="number"
              min={0}
              className="w-32"
              value={v.headcountBudget ?? ''}
              onChange={(e) =>
                patch({ headcountBudget: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })
              }
              placeholder="—"
            />
            <p className="text-xs text-muted-foreground">
              When the budget exceeds actual holders, the chart flags this position as vacant.
            </p>
          </div>
        </TabsContent>
      </Tabs>

      {error && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
          <CircleAlert className="h-4 w-4" /> {error}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between gap-2 border-t pt-4">
        <span className="text-xs text-muted-foreground">
          Reports to: <strong>{v.reportsToPositionId ? positionTitle(v.reportsToPositionId) : 'Root'}</strong>
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
