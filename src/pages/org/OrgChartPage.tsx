/**
 * /org/chart — interactive org chart designer (Admin / HR).
 *
 * React Flow (@xyflow/react v12) + dagre auto-layout. Nodes are positions
 * (default) or employees (People toggle); edges are reporting lines resolved
 * by lib/orgChart (seed-derived tree + persisted overrides). Drag a node onto
 * another to re-parent (confirm → persists to positionProfiles). The side
 * sheet edits the full position incl. job description; deletion guards block
 * on occupied positions and re-parent children. Vacant positions (budget >
 * actual) render with a dashed amber border. Toolbar: People/Positions mode,
 * dotted-line toggle (Company.config.orgChart.showDottedLineReports),
 * expand/collapse, re-layout, fit, PNG export (html-to-image) and print.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import dagre from 'dagre';
import { toPng } from 'html-to-image';
import {
  Background, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  applyNodeChanges, getNodesBounds, getViewportForBounds, useReactFlow,
  type Edge, type Node, type OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  CircleAlert, Expand, FileText, GitBranch, ImageDown, LayoutGrid, Maximize,
  Minimize, Pencil, Plus, Printer, Trash2, Users, UserRound,
} from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import { useTenant } from '@/lib/tenantContext';
import { useAuthScope } from '@/pages/leave/useAuthScope';
import {
  activeEmployees,
  collectDescendants,
  deptColor,
  directReports,
  effectiveGrade,
  headcountByPosition,
  isVacant,
  removePositionProfile,
  resolveReportsTo,
  buildEmployeeTree,
  useDepartmentProfiles,
  usePositionProfiles,
  vacancyCount,
  wouldCreateCycle,
} from '@/lib/orgChart';
import { cn, fmtDate } from '@/lib/utils';
import type { Department, Employee, Position } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import OrgNode, { ORG_NODE_HEIGHT, ORG_NODE_WIDTH, type OrgFlowNode } from './components/OrgNode';
import PositionDialog from './components/PositionDialog';
import PositionForm from './components/PositionForm';
import { EMPTY_POSITION_FORM, valuesFromPosition } from './components/positionFormShared';
import JdSheet from './components/JdSheet';

const nodeTypes = { orgNode: OrgNode };

/** dagre top-to-bottom layout over the visible graph. */
function layoutGraph(ids: string[], edges: { source: string; target: string }[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 96, marginx: 24, marginy: 24 });
  ids.forEach((id) => g.setNode(id, { width: ORG_NODE_WIDTH, height: ORG_NODE_HEIGHT + 28 }));
  edges.forEach((e) => {
    if (e.source !== e.target && ids.includes(e.source) && ids.includes(e.target)) {
      g.setEdge(e.source, e.target);
    }
  });
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  ids.forEach((id) => {
    const n = g.node(id);
    out.set(id, { x: n.x - ORG_NODE_WIDTH / 2, y: n.y - (ORG_NODE_HEIGHT + 28) / 2 });
  });
  return out;
}

type Mode = 'positions' | 'people';

function OrgChartInner() {
  const auth = useAuthScope();
  const { activeCompany } = useTenant();
  const departments = useCollection<Department>('departments');
  const positions = useCollection<Position>('positions');
  const employees = useCollection<Employee>('employees');
  const profiles = usePositionProfiles();
  const deptProfiles = useDepartmentProfiles();

  const hqState = activeCompany?.hqState ?? 'KUL';
  const companyName = activeCompany?.name ?? 'Company';
  const dottedConfigured = activeCompany?.config?.orgChart?.showDottedLineReports ?? true;

  const [mode, setMode] = useState<Mode>('positions');
  const [showDotted, setShowDotted] = useState(dottedConfigured);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [empSheet, setEmpSheet] = useState<Employee | null>(null);
  const [pendingMove, setPendingMove] = useState<{ childId: string; parentId: string } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [posDelete, setPosDelete] = useState<Position | null>(null);
  const [jdPosition, setJdPosition] = useState<Position | null>(null);
  const [exporting, setExporting] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const { fitView, getIntersectingNodes, getNodes } = useReactFlow();

  // Keep the dotted toggle in sync when the company config changes (tenant switch).
  useEffect(() => setShowDotted(dottedConfigured), [dottedConfigured]);

  // ── Derived graph data ────────────────────────────────────────────────────
  const active = useMemo(() => activeEmployees(employees.items), [employees.items]);
  const headcounts = useMemo(() => headcountByPosition(employees.items), [employees.items]);
  const parentMap = useMemo(
    () => resolveReportsTo(positions.items, profiles.items, employees.items, departments.items),
    [positions.items, profiles.items, employees.items, departments.items],
  );
  const employeeTree = useMemo(() => buildEmployeeTree(employees.items, parentMap), [employees.items, parentMap]);
  const profileOf = useMemo(() => new Map(profiles.items.map((p) => [p.positionId, p])), [profiles.items]);
  const deptOf = useMemo(() => new Map(departments.items.map((d) => [d.id, d])), [departments.items]);
  const posOf = useMemo(() => new Map(positions.items.map((p) => [p.id, p])), [positions.items]);
  const holdersByPosition = useMemo(() => {
    const map = new Map<string, Employee[]>();
    [...active]
      .sort((a, b) => a.joinDate.localeCompare(b.joinDate))
      .forEach((e) => {
        if (!map.has(e.positionId)) map.set(e.positionId, []);
        map.get(e.positionId)!.push(e);
      });
    return map;
  }, [active]);

  const onToggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Structure → positioned nodes/edges ────────────────────────────────────
  const structure = useMemo((): { nodes: OrgFlowNode[]; edges: Edge[] } => {
    const tree = mode === 'positions' ? parentMap : employeeTree;
    const hidden = new Set<string>();
    collapsed.forEach((id) => collectDescendants(tree, id).forEach((d) => hidden.add(d)));

    if (mode === 'positions') {
      const visible = positions.items.filter((p) => !hidden.has(p.id));
      const ids = visible.map((p) => p.id);
      const primary = visible
        .filter((p) => tree[p.id])
        .map((p) => ({ source: tree[p.id] as string, target: p.id }));
      const coords = layoutGraph(ids, primary);

      const nodes: OrgFlowNode[] = visible.map((p) => {
        const profile = profileOf.get(p.id);
        const dept = deptOf.get(p.departmentId);
        const holders = holdersByPosition.get(p.id) ?? [];
        const actual = headcounts.get(p.id) ?? 0;
        const vacant = isVacant(profile, actual);
        return {
          id: p.id,
          type: 'orgNode',
          position: coords.get(p.id) ?? { x: 0, y: 0 },
          selected: p.id === selectedId,
          data: {
            kind: 'position',
            title: p.title,
            subtitle: dept?.name ?? 'Unassigned',
            deptName: dept?.name ?? 'Unassigned',
            deptColor: dept ? deptColor(dept.id, deptProfiles.items) : '#a8a29e',
            chip: String(effectiveGrade(p, profile)),
            occupant: holders[0]?.name,
            count: actual,
            budget: profile?.headcountBudget,
            vacant,
            vacancy: vacancyCount(profile, actual),
            hasChildren: directReports(tree, p.id).length > 0,
            collapsed: collapsed.has(p.id),
            onToggleCollapse,
          },
        };
      });

      const edges: Edge[] = primary.map((e) => ({
        id: `e-${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        style: { stroke: '#a8a29e', strokeWidth: 1.6 },
      }));
      if (showDotted) {
        const visibleIds = new Set(ids);
        visible.forEach((p) => {
          const dotted = profileOf.get(p.id)?.dottedLineReportsToPositionId;
          if (dotted && visibleIds.has(dotted) && dotted !== tree[p.id]) {
            edges.push({
              id: `d-${dotted}-${p.id}`,
              source: dotted,
              target: p.id,
              type: 'smoothstep',
              style: { stroke: '#d97706', strokeWidth: 1.4, strokeDasharray: '6 5' },
            });
          }
        });
      }
      return { nodes, edges };
    }

    // People mode — one node per active employee.
    const visibleEmp = active.filter((e) => !hidden.has(e.id));
    const ids = visibleEmp.map((e) => e.id);
    const primary = visibleEmp
      .filter((e) => tree[e.id])
      .map((e) => ({ source: tree[e.id] as string, target: e.id }));
    const coords = layoutGraph(ids, primary);
    const nodes: OrgFlowNode[] = visibleEmp.map((e) => {
      const dept = deptOf.get(e.departmentId);
      const pos = posOf.get(e.positionId);
      return {
        id: e.id,
        type: 'orgNode',
        position: coords.get(e.id) ?? { x: 0, y: 0 },
        selected: e.id === selectedId,
        data: {
          kind: 'employee',
          title: e.name,
          subtitle: pos?.title ?? 'No position',
          deptName: dept?.name ?? 'Unassigned',
          deptColor: dept ? deptColor(dept.id, deptProfiles.items) : '#a8a29e',
          chip: e.employeeNo,
          count: 0,
          vacant: false,
          vacancy: 0,
          hasChildren: directReports(tree, e.id).length > 0,
          collapsed: collapsed.has(e.id),
          onToggleCollapse,
        },
      };
    });
    const edges: Edge[] = primary.map((e) => ({
      id: `e-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      style: { stroke: '#a8a29e', strokeWidth: 1.6 },
    }));
    return { nodes, edges };
  }, [
    mode, parentMap, employeeTree, collapsed, positions.items, profileOf, deptOf, holdersByPosition,
    headcounts, deptProfiles.items, selectedId, onToggleCollapse, showDotted, active, posOf,
  ]);

  // ── React Flow state synced from structure ────────────────────────────────
  const [nodes, setNodes] = useState<OrgFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  // Content signature of the derived structure. Compared before syncing so
  // the effect can NEVER close a setState loop, even if an upstream input
  // regains an unstable reference: unchanged content → no setState.
  const structureSig = useMemo(
    () => JSON.stringify({ n: structure.nodes, e: structure.edges }),
    [structure],
  );
  const lastSyncedSig = useRef<string | null>(null);
  useEffect(() => {
    if (lastSyncedSig.current === structureSig) return;
    lastSyncedSig.current = structureSig;
    setNodes(structure.nodes);
    setEdges(structure.edges);
  }, [structureSig, structure]);

  const onNodesChange: OnNodesChange<OrgFlowNode> = useCallback(
    (changes) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );

  const layoutKey = useMemo(
    () =>
      JSON.stringify({
        ids: structure.nodes.map((n) => n.id).sort(),
        e: structure.edges.map((e) => e.id).sort(),
      }),
    [structure],
  );
  useEffect(() => {
    const t = setTimeout(() => void fitView({ padding: 0.15, duration: 250 }), 80);
    return () => clearTimeout(t);
  }, [layoutKey, fitView]);

  // ── Interactions ──────────────────────────────────────────────────────────
  const snapBack = useCallback(() => {
    setNodes(structure.nodes);
  }, [structure]);

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      if (mode !== 'positions') return;
      const target = getIntersectingNodes(node).find((n) => n.id !== node.id);
      if (!target) return snapBack();
      if (parentMap[node.id] === target.id) return snapBack();
      if (wouldCreateCycle(parentMap, node.id, target.id)) {
        setMoveError(
          `"${posOf.get(target.id)?.title ?? 'That position'}" reports up to "${posOf.get(node.id)?.title ?? 'this position'}" — the move would create a loop.`,
        );
        return snapBack();
      }
      setPendingMove({ childId: node.id, parentId: target.id });
    },
    [mode, getIntersectingNodes, parentMap, posOf, snapBack],
  );

  const confirmMove = () => {
    if (!pendingMove) return;
    profiles.upsert(pendingMove.childId, { reportsToPositionId: pendingMove.parentId });
    logAudit({
      actorName: auth.actor,
      action: 'org.position.reparent',
      entity: 'positions',
      entityId: pendingMove.childId,
      detail: `${posOf.get(pendingMove.childId)?.title} → ${posOf.get(pendingMove.parentId)?.title}`,
    });
    setPendingMove(null);
  };

  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      setSelectedId(node.id);
      if (mode === 'positions') {
        setSheetOpen(true);
      } else {
        const emp = active.find((e) => e.id === node.id) ?? null;
        setEmpSheet(emp);
      }
    },
    [mode, active],
  );

  // ── Add / edit / delete positions ─────────────────────────────────────────
  const selectedPosition = mode === 'positions' && selectedId ? posOf.get(selectedId) : undefined;

  const profilePatchOf = (values: typeof EMPTY_POSITION_FORM) => ({
    grade: values.grade,
    reportsToPositionId: values.reportsToPositionId,
    dottedLineReportsToPositionId: values.dottedLineReportsToPositionId,
    jobDescription: values.jobDescription,
    responsibilities: values.responsibilities,
    qualifications: values.qualifications,
    headcountBudget: values.headcountBudget,
  });

  /** Side-sheet save — always updates the selected position. */
  const saveEditedPosition = (values: typeof EMPTY_POSITION_FORM) => {
    const editing = selectedPosition;
    if (!editing) return;
    positions.update(editing.id, {
      title: values.title, departmentId: values.departmentId, level: values.level,
      minSalary: values.minSalary, maxSalary: values.maxSalary,
    });
    profiles.upsert(editing.id, profilePatchOf(values));
    logAudit({ actorName: auth.actor, action: 'org.position.update', entity: 'positions', entityId: editing.id, detail: values.title });
    setSheetOpen(false);
  };

  /** Add-dialog save — always creates a new position. */
  const saveNewPosition = (values: typeof EMPTY_POSITION_FORM) => {
    const created = positions.add({
      title: values.title, departmentId: values.departmentId, level: values.level,
      minSalary: values.minSalary, maxSalary: values.maxSalary,
    });
    profiles.upsert(created.id, profilePatchOf(values));
    logAudit({ actorName: auth.actor, action: 'org.position.create', entity: 'positions', entityId: created.id, detail: values.title });
    setAddOpen(false);
  };

  const deleteHolders = posDelete ? active.filter((e) => e.positionId === posDelete.id) : [];
  const deleteChildren = posDelete ? directReports(parentMap, posDelete.id) : [];
  const confirmDeletePosition = () => {
    const pos = posDelete;
    if (!pos || deleteHolders.length > 0) return;
    const parent = parentMap[pos.id] ?? null;
    deleteChildren.forEach((childId) => profiles.upsert(childId, { reportsToPositionId: parent }));
    positions.remove(pos.id);
    removePositionProfile(pos.id);
    logAudit({
      actorName: auth.actor, action: 'org.position.delete', entity: 'positions', entityId: pos.id,
      detail: deleteChildren.length > 0 ? `${pos.title} — ${deleteChildren.length} report(s) re-parented` : pos.title,
    });
    setPosDelete(null);
    setSheetOpen(false);
    setSelectedId(null);
  };

  const editExcluded = useMemo(() => {
    if (!selectedPosition) return new Set<string>();
    return new Set([selectedPosition.id, ...collectDescendants(parentMap, selectedPosition.id)]);
  }, [selectedPosition, parentMap]);

  // ── Export / print ────────────────────────────────────────────────────────
  const renderPng = async (pixelRatio: number): Promise<string | null> => {
    const viewportEl = wrapperRef.current?.querySelector('.react-flow__viewport') as HTMLElement | null;
    const current = getNodes();
    if (!viewportEl || current.length === 0) return null;
    const bounds = getNodesBounds(current);
    const width = Math.min(4200, Math.ceil(bounds.width + 200));
    const height = Math.min(4200, Math.ceil(bounds.height + 200));
    const viewport = getViewportForBounds(bounds, width, height, 0.2, 2, 0.08);
    const dark = document.documentElement.classList.contains('dark');
    return toPng(viewportEl, {
      backgroundColor: dark ? '#171412' : '#faf9f7',
      width,
      height,
      pixelRatio,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    });
  };

  const exportPng = async () => {
    setExporting(true);
    try {
      const url = await renderPng(2);
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${companyName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-org-chart.png`;
      a.click();
      logAudit({ actorName: auth.actor, action: 'org.chart.export', entity: 'positions', detail: 'PNG export' });
    } finally {
      setExporting(false);
    }
  };

  const printChart = async () => {
    setExporting(true);
    try {
      const url = await renderPng(2);
      if (!url) return;
      const win = window.open('', '_blank');
      if (!win) return;
      win.document.write(
        `<!doctype html><html><head><title>Org chart — ${companyName}</title>` +
          '<style>@page{margin:10mm}body{margin:0}img{width:100%;height:auto}</style></head><body>' +
          `<img src="${url}" alt="Org chart" onload="setTimeout(function(){window.print()},150)"/>` +
          '</body></html>',
      );
      win.document.close();
    } finally {
      setExporting(false);
    }
  };

  const allParents = useMemo(() => {
    const tree = mode === 'positions' ? parentMap : employeeTree;
    const ids = mode === 'positions' ? positions.items.map((p) => p.id) : active.map((e) => e.id);
    return ids.filter((id) => directReports(tree, id).length > 0);
  }, [mode, parentMap, employeeTree, positions.items, active]);

  const empty = mode === 'positions' ? positions.items.length === 0 : active.length === 0;

  return (
    <div className="space-y-4">
      {/* Header + toolbar */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Org Chart</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {companyName} — drag a card onto another to change its reporting line, or click a card to edit.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/org">
            <LayoutGrid className="mr-1.5 h-4 w-4" /> Manage structure
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-3 py-2">
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(v) => {
            if (v) {
              setMode(v as Mode);
              setSelectedId(null);
              setSheetOpen(false);
              setEmpSheet(null);
              setCollapsed(new Set());
            }
          }}
          size="sm"
        >
          <ToggleGroupItem value="positions" aria-label="Position nodes">
            <GitBranch className="mr-1.5 h-4 w-4" /> Positions
          </ToggleGroupItem>
          <ToggleGroupItem value="people" aria-label="People nodes">
            <UserRound className="mr-1.5 h-4 w-4" /> People
          </ToggleGroupItem>
        </ToggleGroup>

        <Separator orientation="vertical" className="hidden h-6 sm:block" />

        <div className={cn('flex items-center gap-2', !dottedConfigured && 'opacity-60')}>
          <Switch
            id="dotted-toggle"
            checked={showDotted}
            onCheckedChange={setShowDotted}
            disabled={!dottedConfigured}
          />
          <Label htmlFor="dotted-toggle" className="text-xs">
            Dotted-line reports{!dottedConfigured && ' (off in company config)'}
          </Label>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {mode === 'positions' && (
            <Button
              size="sm"
              onClick={() => setAddOpen(true)}
              disabled={departments.items.length === 0}
            >
              <Plus className="mr-1.5 h-4 w-4" /> Add position
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => { snapBack(); void fitView({ padding: 0.15, duration: 250 }); }}>
            <LayoutGrid className="mr-1.5 h-4 w-4" /> Re-layout
          </Button>
          <Button size="sm" variant="outline" onClick={() => void fitView({ padding: 0.15, duration: 250 })}>
            <Maximize className="mr-1.5 h-4 w-4" /> Fit
          </Button>
          <Button
            size="sm" variant="outline"
            onClick={() => setCollapsed((prev) => (prev.size === allParents.length ? new Set() : new Set(allParents)))}
          >
            {collapsed.size === allParents.length ? (
              <><Expand className="mr-1.5 h-4 w-4" /> Expand all</>
            ) : (
              <><Minimize className="mr-1.5 h-4 w-4" /> Collapse all</>
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={exportPng} disabled={exporting || empty}>
            <ImageDown className="mr-1.5 h-4 w-4" /> PNG
          </Button>
          <Button size="sm" variant="outline" onClick={printChart} disabled={exporting || empty}>
            <Printer className="mr-1.5 h-4 w-4" /> Print
          </Button>
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={wrapperRef}
        className="relative w-full overflow-hidden rounded-xl border bg-stone-50 dark:bg-stone-950"
        style={{ height: 'max(60vh, 480px)' }}
      >
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <GitBranch className="h-10 w-10 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">
              {mode === 'positions'
                ? 'No positions yet. Create positions in the structure manager to draw the chart.'
                : 'No active employees in this company yet.'}
            </p>
            {mode === 'positions' && (
              <Button asChild>
                <Link to="/org">Open structure manager</Link>
              </Button>
            )}
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            nodesDraggable={mode === 'positions'}
            nodesConnectable={false}
            fitView
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={20} size={1} className="!stroke-stone-300 dark:!stroke-stone-700" />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              className="!bg-card"
              nodeColor={(n) => (n as OrgFlowNode).data?.deptColor ?? '#d6d3d1'}
              maskColor="rgba(120, 113, 108, 0.25)"
            />
            <Panel position="bottom-left">
              <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card/90 px-2.5 py-1.5 text-[11px] text-muted-foreground backdrop-blur">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-0 w-6 border-t-2 border-stone-400" /> reports to
                </span>
                {showDotted && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-0 w-6 border-t-2 border-dashed border-amber-600" /> secondary (dotted)
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-6 rounded-sm border-2 border-dashed border-amber-500" /> vacancy
                </span>
                <span className="hidden items-center gap-1.5 sm:flex">
                  <Users className="h-3 w-3" /> actual / budget
                </span>
              </div>
            </Panel>
          </ReactFlow>
        )}
      </div>

      {/* ── Position side sheet (edit incl. JD) ─────────────────────────── */}
      <Sheet open={sheetOpen && Boolean(selectedPosition)} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="flex w-full flex-col overflow-y-auto sm:max-w-xl">
          {selectedPosition && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Pencil className="h-4 w-4" /> {selectedPosition.title}
                </SheetTitle>
                <SheetDescription>
                  {deptOf.get(selectedPosition.departmentId)?.name ?? 'Unassigned'} · grade{' '}
                  {effectiveGrade(selectedPosition, profileOf.get(selectedPosition.id))}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setJdPosition(selectedPosition)}>
                  <FileText className="mr-1.5 h-4 w-4" /> Printable JD
                </Button>
                <Button
                  size="sm" variant="outline"
                  onClick={() => { setSheetOpen(false); setAddOpen(true); }}
                >
                  <Plus className="mr-1.5 h-4 w-4" /> Add report
                </Button>
                <Button
                  size="sm" variant="outline"
                  className="text-destructive hover:bg-destructive/10"
                  onClick={() => setPosDelete(selectedPosition)}
                >
                  <Trash2 className="mr-1.5 h-4 w-4" /> Delete
                </Button>
              </div>
              <div className="mt-4 flex min-h-0 flex-1 flex-col">
                <PositionForm
                  key={selectedPosition.id}
                  initial={valuesFromPosition(selectedPosition, profileOf.get(selectedPosition.id))}
                  positions={positions.items}
                  departments={departments.items}
                  excludedParentIds={editExcluded}
                  hqState={hqState}
                  showDottedLine={dottedConfigured}
                  onSubmit={saveEditedPosition}
                  onCancel={() => setSheetOpen(false)}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Employee side sheet (people mode) ───────────────────────────── */}
      <Sheet open={Boolean(empSheet)} onOpenChange={(open) => { if (!open) setEmpSheet(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          {empSheet && (
            <>
              <SheetHeader>
                <SheetTitle>{empSheet.name}</SheetTitle>
                <SheetDescription>{posOf.get(empSheet.positionId)?.title ?? 'No position'}</SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between border-b pb-2">
                  <span className="text-muted-foreground">Employee no.</span>
                  <span className="font-medium">{empSheet.employeeNo ?? '—'}</span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-muted-foreground">Department</span>
                  <span className="font-medium">{deptOf.get(empSheet.departmentId)?.name ?? '—'}</span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-muted-foreground">Reports to</span>
                  <span className="font-medium">
                    {employeeTree[empSheet.id]
                      ? active.find((e) => e.id === employeeTree[empSheet.id])?.name ?? '—'
                      : '— (top of chart)'}
                  </span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-muted-foreground">Direct reports</span>
                  <span className="font-medium">{directReports(employeeTree, empSheet.id).length}</span>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={empSheet.status === 'probation' ? 'secondary' : 'outline'}>{empSheet.status}</Badge>
                </div>
                <div className="flex justify-between border-b pb-2">
                  <span className="text-muted-foreground">Joined</span>
                  <span className="font-medium">{fmtDate(empSheet.joinDate)}</span>
                </div>
                <Button
                  className="mt-2 w-full" variant="outline"
                  onClick={() => {
                    const pos = posOf.get(empSheet.positionId);
                    if (pos) setJdPosition(pos);
                  }}
                  disabled={!posOf.get(empSheet.positionId)}
                >
                  <FileText className="mr-1.5 h-4 w-4" /> View job description
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Drag-to-reparent confirm ────────────────────────────────────── */}
      <AlertDialog open={Boolean(pendingMove)} onOpenChange={(open) => { if (!open) { setPendingMove(null); snapBack(); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change reporting line?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{pendingMove ? posOf.get(pendingMove.childId)?.title : ''}</strong> will report to{' '}
              <strong>{pendingMove ? posOf.get(pendingMove.parentId)?.title : ''}</strong>
              {pendingMove && parentMap[pendingMove.childId]
                ? ` (previously ${posOf.get(parentMap[pendingMove.childId] as string)?.title ?? '—'})`
                : ' (previously the organisation root)'}
              . Its direct reports move with it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmMove}>Confirm move</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Cycle rejection ─────────────────────────────────────────────── */}
      <AlertDialog open={Boolean(moveError)} onOpenChange={(open) => { if (!open) setMoveError(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CircleAlert className="h-5 w-5 text-destructive" /> Move not allowed
            </AlertDialogTitle>
            <AlertDialogDescription>{moveError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setMoveError(null)}>Got it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Add position dialog ─────────────────────────────────────────── */}
      {addOpen && (
        <PositionDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          title="New position"
          description={
            selectedPosition && mode === 'positions'
              ? `Reports to ${selectedPosition.title} by default — change below if needed.`
              : 'Choose its place in the reporting tree.'
          }
          initial={{
            ...EMPTY_POSITION_FORM,
            departmentId: selectedPosition?.departmentId ?? departments.items[0]?.id ?? '',
            reportsToPositionId: mode === 'positions' && selectedPosition ? selectedPosition.id : null,
          }}
          positions={positions.items}
          departments={departments.items}
          excludedParentIds={new Set()}
          hqState={hqState}
          showDottedLine={dottedConfigured}
          onSubmit={saveNewPosition}
          submitLabel="Create position"
        />
      )}

      {/* ── Delete position (guard + re-parent) ─────────────────────────── */}
      <AlertDialog open={Boolean(posDelete)} onOpenChange={(open) => { if (!open) setPosDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteHolders.length > 0 ? `${posDelete?.title} is occupied` : `Delete ${posDelete?.title}?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {deleteHolders.length > 0 ? (
                  <p>
                    {deleteHolders.length} active employee(s) hold this position
                    ({deleteHolders.slice(0, 4).map((e) => e.name).join(', ')}
                    {deleteHolders.length > 4 ? ', …' : ''}). Reassign them first — deletion is blocked.
                  </p>
                ) : deleteChildren.length > 0 ? (
                  <p>
                    {deleteChildren.length} position(s) report to {posDelete?.title}. They will move under{' '}
                    <strong>
                      {posDelete && parentMap[posDelete.id]
                        ? posOf.get(parentMap[posDelete.id] as string)?.title
                        : 'the organisation root'}
                    </strong>{' '}
                    before deletion.
                  </p>
                ) : (
                  <p>This position is vacant and has no reports. This action cannot be undone.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{deleteHolders.length > 0 ? 'Got it' : 'Cancel'}</AlertDialogCancel>
            {deleteHolders.length === 0 && (
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={confirmDeletePosition}
              >
                Delete position
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Printable JD sheet ──────────────────────────────────────────── */}
      {jdPosition && (
        <JdSheet
          open={Boolean(jdPosition)}
          onOpenChange={(open) => { if (!open) setJdPosition(null); }}
          position={jdPosition}
          profile={profileOf.get(jdPosition.id)}
          department={deptOf.get(jdPosition.departmentId)}
          reportsToTitle={parentMap[jdPosition.id] ? posOf.get(parentMap[jdPosition.id] as string)?.title : undefined}
          companyName={companyName}
          actual={headcounts.get(jdPosition.id) ?? 0}
        />
      )}
    </div>
  );
}

export default function OrgChartPage() {
  return (
    <ReactFlowProvider>
      <OrgChartInner />
    </ReactFlowProvider>
  );
}
