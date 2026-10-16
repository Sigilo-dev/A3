import { memo } from 'react';
import { BaseEdge, MarkerType, getBezierPath, getSmoothStepPath, getStraightPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { CanvasVisualEdgePatch, CanvasVisualEdgeView, LocalCanvasWorkspace } from '../../shared/desktop-api';

export type CanvasTool = 'select' | 'connect' | 'text' | 'draw';
type EdgeData = { view: CanvasVisualEdgeView; origin: { x: number; y: number } };
export type CanvasEdge = Edge<EdgeData, 'a3Visual'>;
export function edgeAppearance(style: CanvasVisualEdgeView['style']) {
  return {
    color: typeof style['a3.ui.line.color'] === 'string' && /^#[\da-f]{6}$/i.test(style['a3.ui.line.color']) ? style['a3.ui.line.color'] : '#9bc279',
    width: typeof style['a3.ui.line.width'] === 'number' && style['a3.ui.line.width'] >= 1 && style['a3.ui.line.width'] <= 12 ? style['a3.ui.line.width'] : 2,
    pattern: style['a3.ui.line.pattern'] === 'dashed' ? 'dashed' : 'solid',
    route: ['straight', 'orthogonal'].includes(String(style['a3.ui.line.route'])) ? String(style['a3.ui.line.route']) : 'curved',
    direction: ['forward', 'backward', 'both'].includes(String(style['a3.ui.line.direction'])) ? String(style['a3.ui.line.direction']) : 'none'
  };
}
export function toFlowEdges(workspace: LocalCanvasWorkspace, origin: { x: number; y: number }, tool: CanvasTool, previous: CanvasEdge[] = []): CanvasEdge[] {
  const old = new Map(previous.map((edge) => [edge.id, edge]));
  return workspace.visualEdges.map((view) => {
    const existing = old.get(view.id);
    const reconnectable = workspace.canWrite && tool === 'connect';
    if (existing?.data?.view.revision === view.revision && existing.reconnectable === reconnectable && existing.data.origin.x === origin.x && existing.data.origin.y === origin.y) return existing;
    const style = edgeAppearance(view.style);
    const marker = { type: MarkerType.ArrowClosed, color: style.color };
    return { id: view.id, source: view.sourcePlacementId, target: view.targetPlacementId, sourceHandle: 'visual-source', targetHandle: 'visual-target',
      type: 'a3Visual', data: { view, origin }, reconnectable, selectable: true, focusable: true, selected: existing?.selected,
      ariaLabel: `Línea visual: ${view.label || 'sin etiqueta'}. Solo organización.`,
      markerStart: ['backward', 'both'].includes(style.direction) ? marker : undefined,
      markerEnd: ['forward', 'both'].includes(style.direction) ? marker : undefined };
  });
}
export const edgeTypes = { a3Visual: memo(function VisualEdgeRenderer(props: EdgeProps<CanvasEdge>) {
  if (!props.data) return null;
  const { view, origin } = props.data;
  const style = edgeAppearance(view.style);
  let [path, labelX, labelY] = style.route === 'straight' ? getStraightPath(props) : style.route === 'orthogonal' ? getSmoothStepPath(props) : getBezierPath(props);
  if (view.waypoints.length) {
    const points = [{ x: props.sourceX, y: props.sourceY }, ...view.waypoints.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y })), { x: props.targetX, y: props.targetY }];
    path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
    const middle = points[Math.floor(points.length / 2)]!; labelX = middle.x; labelY = middle.y;
  }
  return <BaseEdge id={props.id} path={path} label={view.label} labelX={labelX} labelY={labelY} markerStart={props.markerStart} markerEnd={props.markerEnd}
    interactionWidth={24} style={{ stroke: style.color, strokeWidth: style.width, strokeDasharray: style.pattern === 'dashed' ? '7 5' : undefined }}
    labelStyle={{ fill: '#e5eedc' }} labelBgStyle={{ fill: '#18231f' }} labelBgPadding={[6, 4]} />;
}) };

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
