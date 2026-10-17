import { memo } from 'react';
import { BaseEdge, MarkerType, getBezierPath, getSmoothStepPath, getStraightPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { CanvasC4RelationView, CanvasConceptualRelationView, CanvasErRelationView, CanvasUmlRelationView, CanvasVisualEdgePatch, CanvasVisualEdgeView, LocalCanvasWorkspace } from '../../shared/desktop-api';
import { umlMultiplicityText } from '@a3/domain/uml';
import type { ErCardinality } from '@a3/domain/er';
import type { C4Step } from '@a3/domain/c4';
import { adaptDiagramStyle } from '@a3/domain/diagram-style';

export type CanvasTool = 'select' | 'connect' | 'text' | 'draw';
type EdgeData = { view: CanvasVisualEdgeView; origin: { x: number; y: number }; defaultLineColor?: string };
type SemanticEdgeData = { view: CanvasConceptualRelationView; origin: { x: number; y: number } };
type C4EdgeData = { view: CanvasC4RelationView; origin: { x: number; y: number }; step?: C4Step };
type UmlEdgeData = { view: CanvasUmlRelationView; origin: { x: number; y: number } };
type ErEdgeData = { view: CanvasErRelationView; origin: { x: number; y: number } };
export type CanvasEdge = Edge<EdgeData | SemanticEdgeData | C4EdgeData | UmlEdgeData | ErEdgeData, 'a3Visual' | 'a3Semantic' | 'a3C4' | 'a3Uml' | 'a3Er'>;
export function edgeAppearance(style: CanvasVisualEdgeView['style'], defaultColor?: string) {
  return {
    color: typeof style['a3.ui.line.color'] === 'string' && /^#[\da-f]{6}$/i.test(style['a3.ui.line.color']) ? style['a3.ui.line.color'] : defaultColor ?? '#9bc279',
    width: typeof style['a3.ui.line.width'] === 'number' && style['a3.ui.line.width'] >= 1 && style['a3.ui.line.width'] <= 12 ? style['a3.ui.line.width'] : 2,
    pattern: style['a3.ui.line.pattern'] === 'dashed' ? 'dashed' : 'solid',
    route: ['straight', 'orthogonal'].includes(String(style['a3.ui.line.route'])) ? String(style['a3.ui.line.route']) : 'curved',
    direction: ['forward', 'backward', 'both'].includes(String(style['a3.ui.line.direction'])) ? String(style['a3.ui.line.direction']) : 'none'
  };
}
export function toFlowEdges(workspace: LocalCanvasWorkspace, origin: { x: number; y: number }, tool: CanvasTool, previous: CanvasEdge[] = [], endpointMap: ReadonlyMap<string, string> = new Map()): CanvasEdge[] {
  const old = new Map(previous.map((edge) => [edge.id, edge]));
  const defaultLineColor = adaptDiagramStyle(workspace.diagramStyle).applied.colors?.line;
  const visualEdges = workspace.visualEdges.map((view) => {
    const existing = old.get(view.id);
    const existingDefaultLineColor = existing?.data && 'defaultLineColor' in existing.data ? existing.data.defaultLineColor : undefined;
    const reconnectable = workspace.canWrite && tool === 'connect';
    const source = endpointMap.get(view.sourcePlacementId.toLowerCase()) ?? view.sourcePlacementId;
    const target = endpointMap.get(view.targetPlacementId.toLowerCase()) ?? view.targetPlacementId;
    const sourceHandle = endpointMap.has(view.sourcePlacementId.toLowerCase()) ? 'group-visual-source' : 'visual-source';
    const targetHandle = endpointMap.has(view.targetPlacementId.toLowerCase()) ? 'group-visual-target' : 'visual-target';
    if (existing?.type === 'a3Visual' && existing.data?.view.revision === view.revision && existing.source === source && existing.target === target && existing.reconnectable === reconnectable && existing.data.origin.x === origin.x && existing.data.origin.y === origin.y && existingDefaultLineColor === defaultLineColor) return existing;
    const style = edgeAppearance(view.style);
    const marker = { type: MarkerType.ArrowClosed, color: style.color };
    return { id: view.id, source, target, sourceHandle, targetHandle,
      type: 'a3Visual' as const, data: { view, origin, ...(defaultLineColor ? { defaultLineColor } : {}) }, reconnectable, selectable: true, focusable: true, selected: existing?.selected,
      ariaLabel: `Línea visual: ${view.label || 'sin etiqueta'}. Solo organización.`,
      markerStart: ['backward', 'both'].includes(style.direction) ? marker : undefined,
      markerEnd: ['forward', 'both'].includes(style.direction) ? marker : undefined };
  });
  const semanticEdges = workspace.conceptualRelations.map((view) => {
    const existing = old.get(view.id);
    const source = endpointMap.get(view.sourcePlacementId.toLowerCase()) ?? view.sourcePlacementId;
    const target = endpointMap.get(view.targetPlacementId.toLowerCase()) ?? view.targetPlacementId;
    if (existing?.type === 'a3Semantic' && existing.data?.view.revision === view.revision && 'relationRevision' in existing.data.view && existing.data.view.relationRevision === view.relationRevision && existing.source === source &&
        existing.target === target && existing.data.origin.x === origin.x && existing.data.origin.y === origin.y) return existing;
    return { id: view.id, source, target, sourceHandle: endpointMap.has(view.sourcePlacementId.toLowerCase()) ? 'group-visual-source' : 'visual-source',
      targetHandle: endpointMap.has(view.targetPlacementId.toLowerCase()) ? 'group-visual-target' : 'visual-target',
      type: 'a3Semantic' as const, data: { view, origin }, reconnectable: false, selectable: true, focusable: true, selected: existing?.selected,
      ariaLabel: `Relación semántica conceptual: ${view.kind ?? 'sin tipo'}, ${view.label}.` };
  });
  const entries: { view: CanvasC4RelationView; step?: C4Step }[] = workspace.c4.current?.data.kind === 'dynamic'
    ? [...workspace.c4.current.data.steps].sort((a, b) => a.order - b.order).flatMap((step) => { const view = workspace.c4.relationViews.find((r) => r.id === step.relationViewId); return view ? [{ view, step }] : []; })
    : workspace.c4.relationViews.map((view) => ({ view }));
  const c4Edges = entries.map(({ view, step }) => ({ id: step ? `c4-step-${step.id}` : view.id,
    source: endpointMap.get(view.sourcePlacementId.toLowerCase()) ?? view.sourcePlacementId, target: endpointMap.get(view.targetPlacementId.toLowerCase()) ?? view.targetPlacementId,
    sourceHandle: endpointMap.has(view.sourcePlacementId.toLowerCase()) ? 'group-visual-source' : 'visual-source',
    targetHandle: endpointMap.has(view.targetPlacementId.toLowerCase()) ? 'group-visual-target' : 'visual-target',
    type: 'a3C4' as const, data: { view, origin, ...(step ? { step } : {}) }, reconnectable: false, selectable: true, focusable: true,
    ariaLabel: `Relación C4: ${step ? `${step.order}. ${step.description || view.description}` : view.description}. ${view.protocol}` }));
  const umlEdges = workspace.uml.relationViews.map((view) => ({ id: view.id,
    source: endpointMap.get(view.sourcePlacementId.toLowerCase()) ?? view.sourcePlacementId, target: endpointMap.get(view.targetPlacementId.toLowerCase()) ?? view.targetPlacementId,
    sourceHandle: endpointMap.has(view.sourcePlacementId.toLowerCase()) ? 'group-visual-source' : 'visual-source',
    targetHandle: endpointMap.has(view.targetPlacementId.toLowerCase()) ? 'group-visual-target' : 'visual-target',
    type: 'a3Uml' as const, data: { view, origin }, reconnectable: false, selectable: true, focusable: true,
    ariaLabel: `Relación UML ${view.kind}: ${view.data.label}. Origen ${view.data.source.role} ${umlMultiplicityText(view.data.source.multiplicity)}; destino ${view.data.target.role} ${umlMultiplicityText(view.data.target.multiplicity)}.` }));
  const erEdges = workspace.er.relationViews.map((view) => ({ id: view.id,
    source: endpointMap.get(view.sourcePlacementId.toLowerCase()) ?? view.sourcePlacementId, target: endpointMap.get(view.targetPlacementId.toLowerCase()) ?? view.targetPlacementId,
    sourceHandle: endpointMap.has(view.sourcePlacementId.toLowerCase()) ? 'group-visual-source' : 'visual-source',
    targetHandle: endpointMap.has(view.targetPlacementId.toLowerCase()) ? 'group-visual-target' : 'visual-target',
    type: 'a3Er' as const, data: { view, origin }, reconnectable: false, selectable: true, focusable: true,
    ariaLabel: `Relación ER ${view.data.label || 'sin etiqueta'}: cardinalidad origen ${view.data.sourceCardinality}; destino ${view.data.targetCardinality}.` }));
  return [...visualEdges, ...semanticEdges, ...c4Edges, ...umlEdges, ...erEdges];
}
const VisualEdgeRenderer = memo(function VisualEdgeRenderer(props: EdgeProps<CanvasEdge>) {
  if (!props.data) return null;
  const { view, origin } = props.data;
  if (!('waypoints' in view)) return null;
  const style = edgeAppearance(view.style, 'defaultLineColor' in props.data ? props.data.defaultLineColor : undefined);
  let [path, labelX, labelY] = style.route === 'straight' ? getStraightPath(props) : style.route === 'orthogonal' ? getSmoothStepPath(props) : getBezierPath(props);
  if (view.waypoints.length) {
    const points = [{ x: props.sourceX, y: props.sourceY }, ...view.waypoints.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y })), { x: props.targetX, y: props.targetY }];
    path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
    const middle = points[Math.floor(points.length / 2)]!; labelX = middle.x; labelY = middle.y;
  }
  return <g data-canvas-edge-source={props.source} data-canvas-edge-target={props.target}>
    <BaseEdge id={props.id} path={path} label={view.label} labelX={labelX} labelY={labelY} markerStart={props.markerStart} markerEnd={props.markerEnd}
      interactionWidth={24} style={{ stroke: style.color, strokeWidth: style.width, strokeDasharray: style.pattern === 'dashed' ? '7 5' : undefined }}
      labelStyle={{ fill: '#e5eedc' }} labelBgStyle={{ fill: '#18231f' }} labelBgPadding={[6, 4]} />
  </g>;
});
const SemanticEdgeRenderer = memo(function SemanticEdgeRenderer(props: EdgeProps<CanvasEdge>) {
  if (!props.data || 'waypoints' in props.data.view || !('label' in props.data.view)) return null;
  const { view } = props.data;
  const [path, labelX, labelY] = getBezierPath(props);
  const palette: Record<string, string> = { composition: '#e8b47a', dependency: '#82b8dc', cause: '#ed8d83', association: '#a9d395' };
  const color = palette[view.kind ?? 'association'] ?? '#c4d6f2';
  const markerId = `a3-semantic-arrow-${props.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return <g data-semantic-relation-id={view.relationId} data-semantic-kind={view.kind ?? 'untyped'}>
    <defs><marker id={markerId} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L10,5 L0,10 z" fill={color} />
    </marker></defs>
    <BaseEdge id={props.id} path={path} label={view.kind ? `${view.kind} · ${view.label}` : view.label} labelX={labelX} labelY={labelY}
      markerEnd={`url(#${markerId})`} interactionWidth={22}
      style={{ stroke: color, strokeWidth: 2.5, strokeDasharray: view.kind === 'dependency' ? '8 5' : undefined }}
      labelStyle={{ fill: '#f4eadf' }} labelBgStyle={{ fill: '#201d22' }} labelBgPadding={[6, 4]} />
  </g>;
});
const C4EdgeRenderer = memo(function C4EdgeRenderer(props: EdgeProps<CanvasEdge>) {
  if (!props.data || !('description' in props.data.view)) return null;
  const view = props.data.view, step = 'step' in props.data ? props.data.step : undefined;
  const [path, labelX, labelY] = getBezierPath(props), markerId = `a3-c4-arrow-${props.id}`;
  const title = `${step ? `${step.order}. ` : ''}${step?.description || view.description}${view.protocol ? ` [${view.protocol}]` : ''}`;
  return <g data-c4-relation-id={view.relationId} data-c4-step-order={step?.order}>
    <defs><marker id={markerId} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L10,5 L0,10 z" fill="#a9ceff" /></marker></defs>
    <BaseEdge id={props.id} path={path} label={title} labelX={labelX} labelY={labelY} markerEnd={`url(#${markerId})`} interactionWidth={22}
      style={{ stroke: '#a9ceff', strokeWidth: 2 }} labelStyle={{ fill: '#edf5ff' }} labelBgStyle={{ fill: '#172536' }} labelBgPadding={[6, 4]} />
  </g>;
});
const UmlEdgeRenderer = memo(function UmlEdgeRenderer(props: EdgeProps<CanvasEdge>) {
  if (!props.data) return null;
  const view = props.data.view as CanvasUmlRelationView, { kind, data } = view;
  if (!data || !Array.isArray(data.stereotypes) || !data.source || !data.target) return null;
  const [path, labelX, labelY] = getBezierPath(props), id = `a3-uml-${props.id}`, color = '#e2d3ff';
  const triangle = kind === 'generalization' || kind === 'realization', diamond = kind === 'aggregation' || kind === 'composition';
  const arrow = (markerId: string) => <marker id={markerId} markerWidth="12" markerHeight="12" refX="11" refY="6" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1,1 L11,6 L1,11" fill="none" stroke={color} strokeWidth="1.5" /></marker>;
  const label = [data.stereotypes.map((s) => `«${s}»`).join(' '), data.label || kind, ...data.constraints.map((c) => `{${c}}`)].filter(Boolean).join(' · ');
  return <g data-uml-relation-id={view.relationId} data-uml-relation-kind={kind}>
    <defs>{arrow(`${id}-arrow`)}
      <marker id={`${id}-triangle`} markerWidth="18" markerHeight="16" refX="17" refY="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M1,1 L17,8 L1,15 z" fill="#171f24" stroke={color} strokeWidth="1.5" /></marker>
      <marker id={`${id}-diamond`} markerWidth="22" markerHeight="14" refX="1" refY="7" orient="auto" markerUnits="userSpaceOnUse"><path d="M1,7 L11,1 L21,7 L11,13 z" fill={kind === 'composition' ? color : '#171f24'} stroke={color} strokeWidth="1.5" /></marker>
    </defs>
    <BaseEdge id={props.id} path={path} label={label} labelX={labelX} labelY={labelY} interactionWidth={22}
      markerStart={diamond ? `url(#${id}-diamond)` : kind === 'association' && data.source.navigable ? `url(#${id}-arrow)` : undefined}
      markerEnd={triangle ? `url(#${id}-triangle)` : kind === 'dependency' || data.target.navigable ? `url(#${id}-arrow)` : undefined}
      style={{ stroke: color, strokeWidth: 2, strokeDasharray: ['dependency', 'realization'].includes(kind) ? '8 5' : undefined }}
      labelStyle={{ fill: '#f0e6ff' }} labelBgStyle={{ fill: '#292235' }} labelBgPadding={[6, 4]} />
    <text x={props.sourceX + 26} y={props.sourceY - 12} className="uml-end-label">{data.source.role} {umlMultiplicityText(data.source.multiplicity)}</text>
    <text x={props.targetX - 26} y={props.targetY - 12} textAnchor="end" className="uml-end-label">{data.target.role} {umlMultiplicityText(data.target.multiplicity)}</text>
  </g>;
});
function erCardinality(value: ErCardinality, end: 'source' | 'target'): string {
  if (value === 'one') return '||';
  if (value === 'zero-or-one') return end === 'source' ? 'o|' : '|o';
  if (value === 'many') return end === 'source' ? '}|' : '|{';
  return end === 'source' ? '}o' : 'o{';
}
const ErEdgeRenderer = memo(function ErEdgeRenderer(props: EdgeProps<CanvasEdge>) {
  if (!props.data) return null;
  const view = props.data.view as CanvasErRelationView;
  if (!view.data || !['one', 'zero-or-one', 'many', 'zero-or-many'].includes(view.data.sourceCardinality)) return null;
  const [path, labelX, labelY] = getBezierPath(props), color = '#86d8c5';
  const label = `${view.data.identifying ? 'identifying' : 'non-identifying'} · ${view.data.label || 'relationship'}`;
  return <g data-er-relation-id={view.relationId} data-er-identifying={String(view.data.identifying)}>
    <BaseEdge id={props.id} path={path} label={label} labelX={labelX} labelY={labelY} interactionWidth={22}
      style={{ stroke: color, strokeWidth: 2.5, strokeDasharray: view.data.identifying ? undefined : '7 5' }}
      labelStyle={{ fill: '#e2fff8' }} labelBgStyle={{ fill: '#172c29' }} labelBgPadding={[6, 4]} />
    <text x={props.sourceX + 22} y={props.sourceY - 12} className="er-end-label">{erCardinality(view.data.sourceCardinality, 'source')}</text>
    <text x={props.targetX - 22} y={props.targetY - 12} textAnchor="end" className="er-end-label">{erCardinality(view.data.targetCardinality, 'target')}</text>
  </g>;
});
export const edgeTypes = { a3Visual: VisualEdgeRenderer, a3Semantic: SemanticEdgeRenderer, a3C4: C4EdgeRenderer, a3Uml: UmlEdgeRenderer, a3Er: ErEdgeRenderer };

export function CanvasEdgeEditor({ workspace, edge, tool, onCreate, onUpdate, onDelete, onRequestDeletePermission }: {
  workspace: LocalCanvasWorkspace; edge?: CanvasVisualEdgeView; tool: CanvasTool;
  onCreate: (source: string, target: string) => void; onUpdate: (id: string, patch: CanvasVisualEdgePatch) => void; onDelete: (id: string) => void;
  onRequestDeletePermission: () => void;
}): React.JSX.Element | null {
  if (!edge && tool !== 'connect') return null;
  const appearance = edgeAppearance(edge?.style ?? {});
  const titles = new Map(workspace.entities.map((entity) => [entity.id, entity.title]));
  const options = workspace.placements.map((placement) => <option key={placement.id} value={placement.id}>{titles.get(placement.entityId) || placement.entityId} · {placement.id.slice(-6)}</option>);
  return <form className="canvas-edge-editor" data-canvas-edge-editor key={edge ? `${edge.id}:${edge.revision}` : 'create'} onSubmit={(event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const sourcePlacementId = String(data.get('source')), targetPlacementId = String(data.get('target'));
    if (!edge) { onCreate(sourcePlacementId, targetPlacementId); return; }
    const proposedStyle = {
      'a3.ui.line.color': String(data.get('color')), 'a3.ui.line.width': Number(data.get('width')), 'a3.ui.line.pattern': String(data.get('pattern')),
      'a3.ui.line.route': String(data.get('route')), 'a3.ui.line.direction': String(data.get('direction'))
    };
    const originalDisplay = { 'a3.ui.line.color': appearance.color, 'a3.ui.line.width': appearance.width, 'a3.ui.line.pattern': appearance.pattern,
      'a3.ui.line.route': appearance.route, 'a3.ui.line.direction': appearance.direction };
    const style = Object.fromEntries(Object.entries(proposedStyle).filter(([key, value]) => value !== originalDisplay[key as keyof typeof originalDisplay]));
    const patch: CanvasVisualEdgePatch = {};
    if (sourcePlacementId !== edge.sourcePlacementId) patch.sourcePlacementId = sourcePlacementId;
    if (targetPlacementId !== edge.targetPlacementId) patch.targetPlacementId = targetPlacementId;
    if (String(data.get('label')) !== edge.label) patch.label = String(data.get('label'));
    if (Object.keys(style).length) patch.style = style;
    if (Object.keys(patch).length) onUpdate(edge.id, patch);
  }}>
    <p>Línea de organización visual · sus flechas no tienen significado técnico.</p>
    <label>Origen <select name="source" data-edge-source defaultValue={edge?.sourcePlacementId ?? workspace.placements[0]?.id} disabled={!workspace.canWrite}>{options}</select></label>
    <label>Destino <select name="target" data-edge-target defaultValue={edge?.targetPlacementId ?? workspace.placements[1]?.id ?? workspace.placements[0]?.id} disabled={!workspace.canWrite}>{options}</select></label>
    {edge && <>
      <label>Etiqueta <input name="label" data-edge-label defaultValue={edge.label} autoFocus={tool === 'text'} disabled={!workspace.canWrite} /></label>
      <label>Color <input name="color" type="color" defaultValue={appearance.color} disabled={!workspace.canWrite} /></label>
      <label>Grosor <input name="width" type="number" min="1" max="12" step="1" defaultValue={appearance.width} disabled={!workspace.canWrite} /></label>
      <label>Patrón <select name="pattern" defaultValue={appearance.pattern} disabled={!workspace.canWrite}><option value="solid">Continuo</option><option value="dashed">Discontinuo</option></select></label>
      <label>Recorrido <select name="route" defaultValue={appearance.route} disabled={!workspace.canWrite}><option value="curved">Curvo</option><option value="straight">Recto</option><option value="orthogonal">Ortogonal</option></select></label>
      <label>Flechas <select name="direction" defaultValue={appearance.direction} disabled={!workspace.canWrite}><option value="none">Sin flecha</option><option value="forward">Hacia destino</option><option value="backward">Hacia origen</option><option value="both">Ambos extremos</option></select></label>
    </>}
    <button type="submit" className="secondary" data-edge-save disabled={!workspace.canWrite || workspace.placements.length === 0}>{edge ? 'Guardar línea' : 'Crear línea visual'}</button>
    {edge && <button type="button" className="quiet" data-edge-delete disabled={!workspace.canDeleteEdges} title={!workspace.canDeleteEdges ? 'Requiere el permiso local de eliminación del proyecto.' : undefined} onClick={() => onDelete(edge.id)}>Eliminar línea</button>}
    {edge && workspace.canWrite && !workspace.canDeleteEdges && <button type="button" className="quiet" data-edge-request-delete onClick={onRequestDeletePermission}
      title="Solicita a la persona habilitar el permiso de eliminación del proyecto con confirmación en cada operación.">Solicitar permiso de eliminación…</button>}
  </form>;
}
