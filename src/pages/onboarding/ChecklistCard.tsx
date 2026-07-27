/**
 * One onboarding checklist card — progress bar, grouped items with
 * mark-done checkboxes, buddy chip. Mobile-first: stacked layout.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, UserRound } from 'lucide-react';
import type { Employee } from '@/lib/types';
import {
  ONBOARDING_CATEGORIES,
  ONBOARDING_STATUS_LABELS,
  ONBOARDING_TEMPLATES,
  auditLifecycle,
  deriveOnboardingStatus,
  useOnboardingChecklists,
  type ChecklistItem,
  type OnboardingChecklist,
} from '@/lib/lifecycle';
import { avatarTone, cn, fmtDate, initialsOf } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';

const STATUS_STYLES: Record<OnboardingChecklist['status'], string> = {
  'not-started': 'border-stone-300 text-stone-600',
  'in-progress': 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/40',
  completed: 'border-lime-600 bg-lime-50 text-lime-700 dark:bg-lime-950/40',
};

interface Props {
  checklist: OnboardingChecklist;
  employee?: Employee;
  buddy?: Employee;
  actorName: string;
}

export default function ChecklistCard({ checklist, employee, buddy, actorName }: Props) {
  const { update } = useOnboardingChecklists();
  const [expanded, setExpanded] = useState(false);

  const done = checklist.items.filter((i) => i.done).length;
  const total = checklist.items.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const template = ONBOARDING_TEMPLATES.find((t) => t.key === checklist.template);

  const grouped = useMemo(() => {
    const map = new Map<string, ChecklistItem[]>();
    ONBOARDING_CATEGORIES.forEach((c) => map.set(c, []));
    checklist.items.forEach((i) => {
      map.get(i.category)?.push(i);
    });
    return [...map.entries()].filter(([, items]) => items.length > 0);
  }, [checklist.items]);

  function toggle(itemId: string, checked: boolean) {
    const items = checklist.items.map((i) =>
      i.id === itemId
        ? {
            ...i,
            done: checked,
            doneBy: checked ? actorName : undefined,
            doneAt: checked ? new Date().toISOString() : undefined,
          }
        : i,
    );
    update(checklist.id, { items, status: deriveOnboardingStatus(items) });
    const item = checklist.items.find((i) => i.id === itemId);
    auditLifecycle(
      checked ? 'onboarding.item-done' : 'onboarding.item-reopen',
      checklist.id,
      `${checked ? 'Done' : 'Reopened'}: ${item?.label ?? itemId} (${employee?.name ?? checklist.employeeId})`,
      actorName,
    );
  }

  return (
    <Card className="rounded-xl">
      <CardContent className="p-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-start gap-3 text-left"
        >
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
              avatarTone(employee?.name ?? '?'),
            )}
          >
            {initialsOf(employee?.name ?? '?')}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium">{employee?.name ?? 'Unknown employee'}</span>
              <Badge variant="outline" className={cn('text-xs', STATUS_STYLES[checklist.status])}>
                {ONBOARDING_STATUS_LABELS[checklist.status]}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {template?.label ?? checklist.template} · starts {fmtDate(checklist.startDate)}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Progress value={pct} className="h-2 flex-1" />
              <span className="text-xs font-medium text-muted-foreground">
                {done}/{total}
              </span>
            </div>
            {buddy && (
              <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                <UserRound className="h-3 w-3" /> Buddy: {buddy.name}
              </p>
            )}
          </div>
          <ChevronDown
            className={cn(
              'mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </button>

        {expanded && (
          <div className="mt-4 space-y-4 border-t pt-4">
            {grouped.map(([category, items]) => (
              <div key={category}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-500">
                  {category}
                </p>
                <ul className="space-y-2">
                  {items.map((item) => (
                    <li key={item.id} className="flex items-start gap-2.5">
                      <Checkbox
                        id={`ob-${item.id}`}
                        checked={item.done}
                        onCheckedChange={(v) => toggle(item.id, v === true)}
                        className="mt-0.5"
                      />
                      <label
                        htmlFor={`ob-${item.id}`}
                        className={cn(
                          'flex-1 cursor-pointer text-sm leading-snug',
                          item.done && 'text-muted-foreground line-through',
                        )}
                      >
                        {item.label}
                        {item.done && item.doneAt && (
                          <span className="ml-2 text-xs text-muted-foreground no-underline">
                            {item.doneBy} · {fmtDate(item.doneAt)}
                          </span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
