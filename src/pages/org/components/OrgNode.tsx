/**
 * OrgNode — custom React Flow node for the org chart designer.
 * Position mode: job title + grade chip + department colour + occupant and
 * headcount budget badge (+ "Vacant" chip with dashed amber border).
 * People mode: employee name + position title.
 * A collapse toggle appears under nodes that have children.
 */
import { memo } from 'react';
import { Handle, Position as RFPosition, type Node, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronUp, Users } from 'lucide-react';
import { cn, initialsOf } from '@/lib/utils';

export interface OrgNodeData extends Record<string, unknown> {
  /** 'position' | 'employee' */
  kind: string;
  /** Position title (position mode) or employee name (people mode). */
  title: string;
  /** Department name (position mode) or position title (people mode). */
  subtitle: string;
  /** Department colour (hex) for the accent bar + dot. */
  deptColor: string;
  deptName: string;
  /** Small chip: grade (L1–L8) in position mode, employeeNo in people mode. */
  chip?: string;
  /** First holder of the position (position mode only). */
  occupant?: string;
  /** Active holders of the position. */
  count: number;
  /** Headcount budget when set. */
  budget?: number;
  vacant: boolean;
  vacancy: number;
  hasChildren: boolean;
  collapsed: boolean;
  onToggleCollapse?: (id: string) => void;
}

export type OrgFlowNode = Node<OrgNodeData, 'orgNode'>;

export const ORG_NODE_WIDTH = 250;
export const ORG_NODE_HEIGHT = 112;

function OrgNode({ id, data, selected }: NodeProps<OrgFlowNode>) {
  const {
    kind, title, subtitle, deptColor, deptName, chip, occupant,
    count, budget, vacant, vacancy, hasChildren, collapsed, onToggleCollapse,
  } = data;
  const isPosition = kind === 'position';

  return (
    <div className="relative">
      <Handle type="target" position={RFPosition.Top} className="!h-2 !w-2 !border-0 !bg-stone-400" />
      <div
        className={cn(
          'w-[250px] overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow',
          selected && 'ring-2 ring-amber-600/70',
          vacant
            ? 'border-2 border-dashed border-amber-500'
            : 'border-stone-200 dark:border-stone-700',
        )}
      >
        <div className="h-1.5 w-full" style={{ backgroundColor: deptColor }} />
        <div className="space-y-1.5 px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold leading-snug">{title}</p>
            {chip && (
              <span className="shrink-0 rounded-md bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                {chip}
              </span>
            )}
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: deptColor }} />
            <span className="truncate">{subtitle}</span>
          </p>
          {isPosition && (
            <div className="flex items-center justify-between gap-2 pt-0.5">
              {occupant ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[9px] font-bold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                    {initialsOf(occupant)}
                  </span>
                  <span className="truncate text-xs">{occupant}</span>
                  {count > 1 && <span className="text-[10px] text-muted-foreground">+{count - 1}</span>}
                </span>
              ) : (
                <span className="text-xs italic text-muted-foreground">No holder</span>
              )}
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                <Users className="h-3 w-3" />
                {count}
                {typeof budget === 'number' ? `/${budget}` : ''}
              </span>
            </div>
          )}
          {vacant && (
            <span className="inline-flex items-center rounded-md border border-dashed border-amber-500 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              Vacant{vacancy > 1 ? ` ×${vacancy}` : ''}
            </span>
          )}
        </div>
      </div>

      {hasChildren && (
        <button
          type="button"
          className="nodrag absolute -bottom-3 left-1/2 z-10 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse?.(id);
          }}
          aria-label={collapsed ? 'Expand reports' : 'Collapse reports'}
          title={collapsed ? 'Expand reports' : 'Collapse reports'}
        >
          {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      )}

      <Handle type="source" position={RFPosition.Bottom} className="!h-2 !w-2 !border-0 !bg-stone-400" />
      {/* deptName kept in data for minimap/tooltips */}
      <span className="hidden">{deptName}</span>
    </div>
  );
}

export default memo(OrgNode);
