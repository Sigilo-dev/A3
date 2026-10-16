import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { applyEdgeChanges, applyNodeChanges, Background, BackgroundVariant, Handle, NodeResizer, Position, ReactFlow, SelectionMode, ViewportPortal, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CanvasEntitySummary, CanvasGroupView, CanvasPlacementView, CanvasRequest, CanvasVisualEdgePatch, CanvasSelection, CanvasResourcePreview, FileDropNotice, LocalCanvasWorkspace, LocalProjectSession } from '../../shared/desktop-api';
import { CanvasEdgeEditor, edgeAppearance, edgeTypes, toFlowEdges, type CanvasEdge, type CanvasTool } from './CanvasVisualEdges';
import { CanvasDrawingLayer, type StrokePreview } from './CanvasDrawings';
import { CanvasContentBody } from './CanvasContentNodes';
import type { MarkdownEditorTarget } from './MarkdownEditor';
import { GRID_SIZE, MAX_ZOOM, MIN_ZOOM, fitContent, fromVisualViewport, gridOffset, panViewport, renderOrigin, screenToWorld, toVisualViewport, wheelViewport, worldToScreen, zoomAt, type WorldViewport } from '../../shared/world-viewport';
import { CONTENT_NODE_CATALOG, contentNodeDefinition, type ContentNodeKind } from '@a3/domain/content-nodes';
import type { Drawing, DrawingParameters, DrawingPoint, GroupMember } from '@a3/domain';

// Navigation reference only: no Entity, Placement, drawing or React Flow node is created.
const reference = { x: 120, y: 110, width: 550, height: 220 };
type CanvasNodeData = {
  sessionId: string; workspaceId: string; entity: CanvasEntitySummary; placement: CanvasPlacementView; canWrite: boolean; tool: CanvasTool;
  onOpenMarkdown: (target: MarkdownEditorTarget) => void;
  onResizeEnd: (id: string, position: { x: number; y: number }, size: { width: number; height: number }) => void;
};
type CanvasNode = Node<CanvasNodeData, 'a3Entity'>;
type CanvasGroupNodeData = { group: CanvasGroupView; canWrite: boolean; tool: CanvasTool; collapsed: boolean; memberCount: number; basePosition: { x: number; y: number }; onToggle: (groupId: string) => void };
type CanvasGroupNode = Node<CanvasGroupNodeData, 'a3Group'>;
type CanvasFlowNode = CanvasNode | CanvasGroupNode;
const nodeTypes = { a3Entity: memo(function CanvasEntityNode({ data, selected }: NodeProps<CanvasNode>) {
  const [preview, setPreview] = useState<CanvasResourcePreview | null>(null);
  const [playback, setPlayback] = useState<CanvasResourcePreview | null>(null);
  const [visible, setVisible] = useState(false);
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    if (!('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { root: node.closest('.canvas-host') });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let mounted = true;
    setPreview(null);
    if (visible && data.entity.contentResourceId && data.entity.contentResource?.kind !== 'remote-url' &&
        !['a3.content.video', 'a3.content.audio', 'a3.content.file'].includes(data.entity.type)) {
      void window.a3?.canvas({ action: 'content', sessionId: data.sessionId, workspaceId: data.workspaceId,
        entityId: data.entity.id, resourceId: data.entity.contentResourceId, purpose: 'preview' }).then((result) => {
        if (mounted && result.ok) setPreview(result.value);
        else if (mounted && result && !result.ok) setPreview({ entityId: data.entity.id, resourceId: data.entity.contentResourceId!, text: null, state: 'unavailable' });
      }).catch(() => { if (mounted) setPreview({ entityId: data.entity.id, resourceId: data.entity.contentResourceId!, text: null, state: 'unavailable' }); });
    }
    return () => { mounted = false; };
  }, [visible, data.sessionId, data.workspaceId, data.entity.id, data.entity.contentResourceId, data.entity.contentResource?.kind, data.entity.revision, data.entity.type]);
  useEffect(() => {
    if (!visible) { setPlayback(null); setPlaybackBusy(false); return; }
    const bytes = playback?.bytes ?? preview?.bytes;
    if (!bytes) { setMediaUrl(null); return; }
    const mediaType = playback?.mediaType ?? preview?.mediaType ?? 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
    setMediaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [visible, playback?.bytes, playback?.mediaType, preview?.bytes, preview?.mediaType]);
  async function activatePlayback(): Promise<void> {
    if (!visible || !data.entity.contentResourceId || !window.a3 || playbackBusy) return;
    setPlaybackBusy(true); setPlaybackError(null);
    try {
      const result = await window.a3.canvas({ action: 'content', sessionId: data.sessionId, workspaceId: data.workspaceId,
        entityId: data.entity.id, resourceId: data.entity.contentResourceId, purpose: 'playback' });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.state !== 'binary' || !result.value.bytes) throw new Error(result.value.state === 'too-large' ? 'El medio supera 32 MiB para reproducción integrada.' : 'No se pudo leer el medio local.');
      setPlayback(result.value);
    } catch (error) { setPlaybackError(error instanceof Error ? error.message : 'No se pudo activar el reproductor.'); }
    finally { setPlaybackBusy(false); }
  }
  const accent = data.placement.style['a3.ui.accent'];
  const borderColor = typeof accent === 'string' && /^#[\da-f]{6}$/i.test(accent) ? accent : undefined;
  const properties = Object.keys(data.entity.properties).length > 0 ? JSON.stringify(data.entity.properties, null, 2) : '';
  return <article ref={nodeRef} className="canvas-entity-node" data-placement-id={data.placement.id} data-entity-id={data.entity.id} data-node-type={data.entity.type}
    data-node-fallback={!data.entity.typeAvailable} style={borderColor ? { borderColor } : undefined}>
    <Handle id="visual-target" type="target" position={Position.Left} isConnectable={data.canWrite && data.tool === 'connect'} aria-label="Destino de línea visual" />
    <Handle id="visual-source" type="source" position={Position.Right} isConnectable={data.canWrite && data.tool === 'connect'} aria-label="Origen de línea visual" />
    <NodeResizer isVisible={selected && data.canWrite && data.tool === 'select' && data.placement.style['a3.ui.locked'] !== true} minWidth={180} minHeight={130} color="#c3ed82"
      onResizeEnd={(_, size) => data.onResizeEnd(data.placement.id, { x: size.x, y: size.y }, { width: size.width, height: size.height })} />
    <header className="canvas-entity-header"><strong>{data.entity.title || data.entity.type}{data.placement.style['a3.ui.locked'] === true ? ' · Bloqueado' : ''}</strong><small>{data.entity.type}@{data.entity.typeVersion}</small></header>
    {!data.entity.typeAvailable && <p className="canvas-fallback-label">Tipo o paquete no instalado · propiedades conservadas</p>}
    <div className="canvas-entity-body nodrag nopan nowheel">
      {data.entity.ports.length > 0 && <div className="canvas-ports" aria-label="Puertos">{data.entity.ports.map((port) => <span key={port.id} title={port.id}>{port.label || port.id}</span>)}</div>}
      {properties && <details><summary>Propiedades</summary><pre>{properties}</pre></details>}
      {data.entity.contentResourceId && <CanvasContentBody entity={data.entity} preview={preview} mediaUrl={mediaUrl} activatePlayback={() => void activatePlayback()}
        playbackBusy={playbackBusy} playbackError={playbackError} onOpenMarkdown={() => {
          if (data.entity.contentResourceId) data.onOpenMarkdown({ sessionId: data.sessionId, entityId: data.entity.id, resourceId: data.entity.contentResourceId, title: data.entity.title });
        }} />}
      {Object.keys(data.placement.style).length > 0 && <details><summary>Estilo de esta vista</summary><pre>{JSON.stringify(data.placement.style, null, 2)}</pre></details>}
    </div>
  </article>;
}), a3Group: memo(function CanvasGroupNodeRenderer({ data, selected }: NodeProps<CanvasGroupNode>) {
  const handles = <><Handle id="group-visual-target" type="target" position={Position.Left} isConnectable={data.canWrite && data.tool === 'connect'} aria-label="Línea visual al grupo" />
    <Handle id="group-visual-source" type="source" position={Position.Right} isConnectable={data.canWrite && data.tool === 'connect'} aria-label="Línea visual desde el grupo" /></>;
  return data.collapsed
    ? <article className={`canvas-group-card${selected ? ' selected' : ''}`} data-group-id={data.group.id} data-group-collapsed="true" aria-label={`Grupo ${data.group.name}, contraído`}>
      {handles}<header className="canvas-group-header"><strong>{data.group.name}</strong><small>Grupo · {data.memberCount} miembros</small></header>
      <p>Representaciones y trazos ocultos</p><button className="canvas-group-expand nodrag nopan" onClick={(event) => { event.stopPropagation(); data.onToggle(data.group.id); }}>Expandir grupo</button>
    </article>
    : <div className={`canvas-group-frame${selected ? ' selected' : ''}`} data-group-id={data.group.id} data-group-collapsed="false" aria-label={`Grupo ${data.group.name}`}>
      <div className="canvas-group-header"><strong>{data.group.name}</strong><small>{data.memberCount} miembros</small>
        <button className="canvas-group-expand nodrag nopan" onClick={(event) => { event.stopPropagation(); data.onToggle(data.group.id); }}>Contraer</button></div>{handles}
    </div>;
}) };
const defaultDrawingParameters: DrawingParameters = { size: 4, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true };
interface ActiveStroke { pointerId: number; pointerType: string; hasPressure: boolean; points: DrawingPoint[]; }

interface GroupLayout { x: number; y: number; width: number; height: number; placementIds: Set<string>; drawingIds: Set<string>; groupIds: Set<string>; }
function groupLayouts(workspace: LocalCanvasWorkspace): { layouts: Map<string, GroupLayout>; hiddenPlacements: Set<string>; hiddenDrawings: Set<string>; hiddenGroups: Set<string>; edgeEndpoints: Map<string, string> } {
  const groups = new Map(workspace.groups.map((group) => [group.id.toLowerCase(), group]));
  const placements = new Map(workspace.placements.map((placement) => [placement.id.toLowerCase(), placement]));
  const drawings = new Map(workspace.drawings.map((drawing) => [drawing.id.toLowerCase(), drawing]));
  const memoized = new Map<string, { placementIds: Set<string>; drawingIds: Set<string>; groupIds: Set<string> }>();
  const collect = (id: string, visiting = new Set<string>()): { placementIds: Set<string>; drawingIds: Set<string>; groupIds: Set<string> } => {
    const key = id.toLowerCase(), prior = memoized.get(key); if (prior) return prior;
    const group = groups.get(key); if (!group || visiting.has(key)) return { placementIds: new Set(), drawingIds: new Set(), groupIds: new Set() };
    const path = new Set(visiting); path.add(key);
    const result = { placementIds: new Set<string>(), drawingIds: new Set<string>(), groupIds: new Set<string>() };
    for (const member of group.members) {
      if (member.kind === 'placement' && placements.has(member.id.toLowerCase())) result.placementIds.add(placements.get(member.id.toLowerCase())!.id);
      else if (member.kind === 'drawing' && drawings.has(member.id.toLowerCase())) result.drawingIds.add(drawings.get(member.id.toLowerCase())!.id);
      else if (member.kind === 'group' && groups.has(member.id.toLowerCase())) {
        const child = groups.get(member.id.toLowerCase())!, descendants = collect(child.id, path);
        result.groupIds.add(child.id); descendants.groupIds.forEach((value) => result.groupIds.add(value));
        descendants.placementIds.forEach((value) => result.placementIds.add(value)); descendants.drawingIds.forEach((value) => result.drawingIds.add(value));
      }
    }
    memoized.set(key, result); return result;
  };
  const layouts = new Map<string, GroupLayout>();
  for (const group of workspace.groups) {
    const descendants = collect(group.id); let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of descendants.placementIds) { const value = placements.get(id.toLowerCase())!; minX = Math.min(minX, value.position.x); minY = Math.min(minY, value.position.y); maxX = Math.max(maxX, value.position.x + value.size.width); maxY = Math.max(maxY, value.position.y + value.size.height); }
    for (const id of descendants.drawingIds) for (const point of drawings.get(id.toLowerCase())?.points ?? []) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); }
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 200; maxY = 100; }
    layouts.set(group.id.toLowerCase(), { x: minX - 24, y: minY - 24, width: Math.max(200, maxX - minX + 48), height: Math.max(100, maxY - minY + 48), ...descendants });
  }
  const depth = new Map<string, number>();
  const walk = (id: string, level: number, seen: Set<string>): void => { const key = id.toLowerCase(); if (seen.has(key)) return; seen.add(key);
    depth.set(key, Math.min(depth.get(key) ?? Infinity, level)); const group = groups.get(key); if (!group) return;
    for (const member of group.members) if (member.kind === 'group') walk(member.id, level + 1, new Set(seen)); };
  const childIds = new Set(workspace.groups.flatMap((group) => group.members.filter((member) => member.kind === 'group').map((member) => member.id.toLowerCase())));
  for (const group of workspace.groups.filter((item) => !childIds.has(item.id.toLowerCase()))) walk(group.id, 0, new Set());
  for (const group of workspace.groups) if (!depth.has(group.id.toLowerCase())) walk(group.id, 0, new Set());
  const collapsed = workspace.groups.filter((group) => group.collapsed).sort((a, b) => (depth.get(a.id.toLowerCase()) ?? 0) - (depth.get(b.id.toLowerCase()) ?? 0));
  const hiddenPlacements = new Set<string>(), hiddenDrawings = new Set<string>(), hiddenGroups = new Set<string>(), edgeEndpoints = new Map<string, string>();
  for (const group of collapsed) {
    const descendants = layouts.get(group.id.toLowerCase())!;
    for (const id of descendants.placementIds) { if (!edgeEndpoints.has(id.toLowerCase())) edgeEndpoints.set(id.toLowerCase(), `a3-group:${group.id}`); hiddenPlacements.add(id.toLowerCase()); }
    descendants.drawingIds.forEach((id) => hiddenDrawings.add(id.toLowerCase()));
    descendants.groupIds.forEach((id) => hiddenGroups.add(id.toLowerCase()));
  }
  return { layouts, hiddenPlacements, hiddenDrawings, hiddenGroups, edgeEndpoints };
}
function collapsedEdgePoint(box: { x: number; y: number; width: number; height: number }, toward: { x: number; y: number }): { x: number; y: number } {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (Math.abs(toward.y - center.y) > Math.abs(toward.x - center.x)) return { x: center.x, y: box.y + (toward.y >= center.y ? box.height : 0) };
  const right = toward.x >= center.x;
  return { x: box.x + (right ? box.width : 0), y: center.y };
}
function CanvasCollapsedEdges({ workspace, origin, endpointMap, layouts }: { workspace: LocalCanvasWorkspace; origin: { x: number; y: number }; endpointMap: ReadonlyMap<string, string>; layouts: ReadonlyMap<string, GroupLayout> }): React.JSX.Element | null {
  const groups = new Map(workspace.groups.map((group) => [group.id.toLowerCase(), group]));
  const placements = new Map(workspace.placements.map((placement) => [placement.id.toLowerCase(), placement]));
  const routes = workspace.visualEdges.flatMap((edge) => {
    const sourceGroup = endpointMap.get(edge.sourcePlacementId.toLowerCase()), targetGroup = endpointMap.get(edge.targetPlacementId.toLowerCase());
    if (!sourceGroup && !targetGroup) return [];
    if (sourceGroup && targetGroup && sourceGroup === targetGroup) return [];
    const bounds = (placementId: string, groupEndpoint: string | undefined) => {
      if (groupEndpoint) {
        const groupId = groupEndpoint.slice('a3-group:'.length), group = groups.get(groupId.toLowerCase()), layout = layouts.get(groupId.toLowerCase());
        return group && layout ? { id: groupEndpoint, x: layout.x, y: layout.y, width: 250, height: 126 } : undefined;
      }
      const placement = placements.get(placementId.toLowerCase());
      return placement ? { id: placement.id, x: placement.position.x, y: placement.position.y, width: placement.size.width, height: placement.size.height } : undefined;
    };
    const sourceBox = bounds(edge.sourcePlacementId, sourceGroup), targetBox = bounds(edge.targetPlacementId, targetGroup);
    if (!sourceBox || !targetBox) return [];
    const sourceCenter = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
    const targetCenter = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
    const startWorld = collapsedEdgePoint(sourceBox, targetCenter), endWorld = collapsedEdgePoint(targetBox, sourceCenter);
    const start = { x: startWorld.x - origin.x, y: startWorld.y - origin.y }, end = { x: endWorld.x - origin.x, y: endWorld.y - origin.y };
    const waypoints = edge.waypoints.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y }));
    const points = [start, ...waypoints, end];
    const style = edgeAppearance(edge.style), markerId = `a3-group-arrow-${edge.id}`;
    let path: string;
    if (waypoints.length || style.route === 'straight') path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
    else if (style.route === 'orthogonal') {
      const middle = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y) ? { x: (start.x + end.x) / 2, y: start.y } : { x: start.x, y: (start.y + end.y) / 2 };
      const last = { x: end.x, y: middle.y };
      path = `M ${start.x} ${start.y} L ${middle.x} ${middle.y} L ${last.x} ${last.y} L ${end.x} ${end.y}`;
    } else if (Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)) {
      const bend = Math.max(40, Math.abs(end.x - start.x) / 2), direction = end.x >= start.x ? 1 : -1;
      path = `M ${start.x} ${start.y} C ${start.x + direction * bend} ${start.y}, ${end.x - direction * bend} ${end.y}, ${end.x} ${end.y}`;
    } else {
      const bend = Math.max(40, Math.abs(end.y - start.y) / 2), direction = end.y >= start.y ? 1 : -1;
      path = `M ${start.x} ${start.y} C ${start.x} ${start.y + direction * bend}, ${end.x} ${end.y - direction * bend}, ${end.x} ${end.y}`;
    }
    return [{ edge, sourceBox, targetBox, sourceId: sourceBox.id, targetId: targetBox.id, path, labelPoint: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, style, markerId }];
  });
  if (!routes.length) return null;
  return <svg className="canvas-group-edge-layer" width="1" height="1" overflow="visible" aria-label="Conexiones visuales externas de grupos contraídos">
    <defs>{routes.map(({ markerId, style }) => <marker key={markerId} id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M 0 0 L 8 4 L 0 8 z" fill={style.color} />
    </marker>)}</defs>
    {routes.map(({ edge, sourceId, targetId, path, labelPoint, style, markerId }) => <g key={edge.id} data-canvas-edge-source={sourceId} data-canvas-edge-target={targetId}
      data-visual-edge-id={edge.id} role="img" aria-label={`Línea visual externa: ${edge.label || 'sin etiqueta'}`}>
      <path className="canvas-group-edge-path" d={path} fill="none" stroke={style.color} strokeWidth={style.width} strokeDasharray={style.pattern === 'dashed' ? '7 5' : undefined}
        markerStart={['backward', 'both'].includes(style.direction) ? `url(#${markerId})` : undefined} markerEnd={['forward', 'both'].includes(style.direction) ? `url(#${markerId})` : undefined} />
      {edge.label && <text x={labelPoint.x} y={labelPoint.y - 7} textAnchor="middle" className="canvas-group-edge-label">{edge.label}</text>}
    </g>)}
  </svg>;
}
function toFlowNodes(workspace: LocalCanvasWorkspace, origin: { x: number; y: number }, onResizeEnd: CanvasNodeData['onResizeEnd'], tool: CanvasTool, previous: CanvasFlowNode[] = [], force = false, onToggle: (id: string) => void = () => undefined, onOpenMarkdown: (target: MarkdownEditorTarget) => void = () => undefined): CanvasFlowNode[] {
  const entities = new Map(workspace.entities.map((entity) => [entity.id.toLowerCase(), entity]));
  const groups = groupLayouts(workspace);
  const old = new Map(previous.map((node) => [node.id, node]));
  const placementNodes: CanvasNode[] = workspace.placements.flatMap((placement) => {
    if (groups.hiddenPlacements.has(placement.id.toLowerCase())) return [];
    const entity = entities.get(placement.entityId.toLowerCase());
    if (!entity) return [];
    const existing = old.get(placement.id) as CanvasNode | undefined;
    if (!force && existing && existing.data.placement.revision === placement.revision && existing.data.entity.revision === entity.revision &&
        existing.data.canWrite === workspace.canWrite && existing.data.tool === tool && existing.data.onOpenMarkdown === onOpenMarkdown) return [existing];
    return [{ id: placement.id, type: 'a3Entity', position: { x: placement.position.x - origin.x, y: placement.position.y - origin.y },
      style: { width: placement.size.width, height: placement.size.height }, draggable: workspace.canWrite && tool === 'select' && placement.style['a3.ui.locked'] !== true,
      zIndex: typeof placement.style['a3.ui.z-index'] === 'number' ? placement.style['a3.ui.z-index'] : 1,
      dragHandle: '.canvas-entity-header', selectable: true, focusable: true, selected: existing?.selected,
      ariaLabel: `${entity.title || entity.type}${placement.style['a3.ui.locked'] === true ? ', bloqueado' : ''}`,
      data: { sessionId: workspace.sessionId, workspaceId: workspace.workspaceId, entity, placement, canWrite: workspace.canWrite, tool, onResizeEnd, onOpenMarkdown } }];
  });
  const groupNodes: CanvasGroupNode[] = workspace.groups.filter((group) => !groups.hiddenGroups.has(group.id.toLowerCase())).map((group) => {
    const key = group.id.toLowerCase(), layout = groups.layouts.get(key)!, collapsed = group.collapsed;
    const position = { x: layout.x - origin.x, y: layout.y - origin.y };
    const existing = old.get(`a3-group:${group.id}`) as CanvasGroupNode | undefined;
    const memberCount = layout.placementIds.size + layout.drawingIds.size + layout.groupIds.size;
    if (!force && existing?.data.group.revision === group.revision && existing.data.tool === tool && existing.data.canWrite === workspace.canWrite && existing.data.collapsed === collapsed && existing.data.basePosition.x === position.x && existing.data.basePosition.y === position.y) return existing;
    const width = collapsed ? 250 : layout.width, height = collapsed ? 126 : layout.height;
    return { id: `a3-group:${group.id}`, type: 'a3Group', position, style: { width, height }, zIndex: collapsed ? 2 : 0,
      draggable: workspace.canWrite && tool === 'select', dragHandle: '.canvas-group-header', selectable: true, focusable: true, selected: existing?.selected,
      ariaLabel: `Grupo ${group.name}${collapsed ? ', contraído' : ''}`, data: { group, canWrite: workspace.canWrite, tool, collapsed, memberCount, basePosition: position, onToggle } };
  });
  return [...groupNodes, ...placementNodes];
}
export function CanvasPanel({ active, onOpenMarkdown }: { active: LocalProjectSession | null | undefined; onOpenMarkdown: (target: MarkdownEditorTarget) => void }): React.JSX.Element {
  const [selected, setSelected] = useState('');
  const workspaceId = active?.workspaces.some((workspace) => workspace.id === selected) ? selected : active?.workspaces[0]?.id;
  if (!active || !workspaceId) return <section className="canvas-panel"><h1>Lienzo</h1><p>Abre un proyecto con un workspace disponible para empezar.</p></section>;
  return <section className="canvas-panel">
    <div className="canvas-heading"><h1>Lienzo</h1><label>Workspace <select aria-label="Workspace del lienzo" value={workspaceId} onChange={(event) => setSelected(event.target.value)}>
      {active.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    </select></label></div>
    <CanvasWorkspace key={`${active.sessionId}:${workspaceId}`} sessionId={active.sessionId} workspaceId={workspaceId} onOpenMarkdown={onOpenMarkdown} />
  </section>;
}

function initialContentValue(kind: ContentNodeKind): string {
  if (kind === 'page') return '# Nueva página\n\n';
  if (kind === 'short-text') return 'Escribe una idea breve.';
  if (kind === 'code') return '// Nuevo fragmento\n';
  if (kind === 'drawing') return '{"schemaVersion":"1.0.0","strokes":[]}\n';
  return '';
}

function CanvasWorkspace({ sessionId, workspaceId, onOpenMarkdown }: { sessionId: string; workspaceId: string; onOpenMarkdown: (target: MarkdownEditorTarget) => void }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<LocalCanvasWorkspace | null>(null);
  const [nodes, setNodes] = useState<CanvasFlowNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [tool, setTool] = useState<CanvasTool>('select');
  const toolRef = useRef(tool); toolRef.current = tool;
  const [selection, setSelection] = useState<{ nodeIds: string[]; groupIds: string[]; edgeIds: string[]; drawingIds: string[] }>({ nodeIds: [], groupIds: [], edgeIds: [], drawingIds: [] });
  const [groupName, setGroupName] = useState('Grupo nuevo');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [strokePreview, setStrokePreview] = useState<StrokePreview | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState('');
  const [contentKind, setContentKind] = useState<ContentNodeKind>('page');
  const [contentTitle, setContentTitle] = useState('Nueva página');
  const [contentValue, setContentValue] = useState('# Nueva página\n\n');
  const [contentUrl, setContentUrl] = useState('');
  const [contentImageSource, setContentImageSource] = useState<'resource' | 'url'>('resource');
  const [contentResourceId, setContentResourceId] = useState('');
  const [contentDescription, setContentDescription] = useState('');
  const [contentAltText, setContentAltText] = useState('');
  const [contentLanguage, setContentLanguage] = useState('');
  const [dropNotice, setDropNotice] = useState<FileDropNotice | null>(null);
  const [dropMode, setDropMode] = useState<'copy' | 'reference' | null>('copy');
  const [viewport, setViewport] = useState<WorldViewport>({ x: 0, y: 0, zoom: 1 });
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const [showReference, setShowReference] = useState(false);
  const [status, setStatus] = useState('Abriendo…');
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'viewport' | 'placement' | 'drawing' | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const current = useRef(viewport);
  const originRef = useRef(origin);
  const revision = useRef(0);
  const placementRevisions = useRef(new Map<string, number>());
  const placementWrites = useRef(new Map<string, Promise<void>>());
  const mutationTail = useRef<Promise<unknown>>(Promise.resolve());
  const workspaceRef = useRef<LocalCanvasWorkspace | null>(null);
  const writable = useRef(false);
  const changed = useRef(false);
  const tail = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const failed = useRef(false);
  const activeStroke = useRef<ActiveStroke | null>(null);

  function installWorkspace(next: LocalCanvasWorkspace, _changedPlacementId?: string, force = false): void {
    workspaceRef.current = next;
    setWorkspace(next);
    revision.current = next.revision; writable.current = next.canWrite;
    placementRevisions.current = new Map(next.placements.map((placement) => [placement.id, placement.revision]));
    const visibility = groupLayouts(next);
    setSelection((previous) => ({ ...previous,
      nodeIds: previous.nodeIds.filter((id) => !visibility.hiddenPlacements.has(id.toLowerCase())),
      drawingIds: previous.drawingIds.filter((id) => !visibility.hiddenDrawings.has(id.toLowerCase())),
      groupIds: previous.groupIds.filter((id) => !visibility.hiddenGroups.has(id.toLowerCase())) }));
    setNodes((previous) => toFlowNodes(next, originRef.current, handleResizeEnd, toolRef.current, previous, force, toggleGroup, onOpenMarkdown));
    setEdges((previous) => toFlowEdges(next, originRef.current, toolRef.current, previous, groupLayouts(next).edgeEndpoints));
  }

  const persistPlacement = useCallback((placementId: string, patch: { position?: { x: number; y: number }; size?: { width: number; height: number }; style?: Record<string, unknown> }): Promise<void> => {
    const previous = placementWrites.current.get(placementId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const expectedRevision = placementRevisions.current.get(placementId);
      if (expectedRevision === undefined || !window.a3) throw new Error('La representación ya no está disponible; recarga el workspace.');
      const result = await window.a3.canvas({ action: 'update-placement', sessionId, workspaceId, placementId, expectedRevision, patch });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message} ${result.error.recovery}`);
      if (live.current) { installWorkspace(result.value, placementId); setError(null); setErrorKind(null); setStatus('Representación guardada'); }
    }).catch((cause: unknown) => {
      if (live.current) {
        setErrorKind('placement'); setError(cause instanceof Error ? cause.message : 'No se pudo guardar la representación.'); setStatus('Representación sin guardar');
        void window.a3?.canvas({ action: 'load', sessionId, workspaceId }).then((result) => {
          if (live.current && result.ok) installWorkspace(result.value, placementId, true);
        }).catch(() => undefined);
      }
    });
    placementWrites.current.set(placementId, next);
    void next.finally(() => { if (placementWrites.current.get(placementId) === next) placementWrites.current.delete(placementId); });
    return next;
  }, [sessionId, workspaceId]);

  const handleResizeEnd = useCallback((placementId: string, localPosition: { x: number; y: number }, size: { width: number; height: number }): void => {
    void persistPlacement(placementId, { position: { x: localPosition.x + originRef.current.x, y: localPosition.y + originRef.current.y }, size });
  }, [persistPlacement]);

  const handleNodeChanges = useCallback((changes: NodeChange<CanvasFlowNode>[]): void => {
    setNodes((currentNodes) => applyNodeChanges(changes.filter((change) => change.type !== 'remove'), currentNodes) as CanvasFlowNode[]);
  }, []);
  const handleSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: { nodes: CanvasFlowNode[]; edges: CanvasEdge[] }): void => {
    const nodeIds = selectedNodes.filter((node): node is CanvasNode => node.type === 'a3Entity').map((node) => node.id);
    const groupIds = selectedNodes.filter((node): node is CanvasGroupNode => node.type === 'a3Group').map((node) => node.data.group.id);
    const edgeIds = selectedEdges.map((edge) => edge.id);
    setSelection((previous) => previous.nodeIds.join() === nodeIds.join() && previous.groupIds.join() === groupIds.join() && previous.edgeIds.join() === edgeIds.join()
      ? previous : { ...previous, nodeIds, groupIds, edgeIds });
  }, []);
  useEffect(() => {
    if (tool === 'text') hostRef.current?.parentElement?.querySelector<HTMLInputElement>('[data-edge-label]')?.focus();
  }, [tool, selection.edgeIds[0]]);

  useEffect(() => {
    const latest = workspaceRef.current;
    if (latest) {
      setNodes((previous) => toFlowNodes(latest, origin, handleResizeEnd, tool, previous, true, toggleGroup, onOpenMarkdown));
      setEdges((previous) => toFlowEdges(latest, origin, tool, previous, groupLayouts(latest).edgeEndpoints));
    }
  }, [origin.x, origin.y, handleResizeEnd, onOpenMarkdown, tool]);
  useEffect(() => {
    if (workspace && !workspace.entityChoices.some((entity) => entity.id === selectedEntityId)) setSelectedEntityId(workspace.entityChoices[0]?.id ?? '');
  }, [workspace?.entityChoices, selectedEntityId]);
  useEffect(() => {
    if (workspace && !workspace.resourceChoices.some((resource) => resource.id === contentResourceId)) setContentResourceId(workspace.resourceChoices[0]?.id ?? '');
  }, [workspace?.resourceChoices, contentResourceId]);

  function report(cause: unknown): void {
    failed.current = true;
    if (live.current) { setErrorKind('viewport'); setError(cause instanceof Error ? cause.message : 'No se pudo guardar la vista.'); setStatus('Vista sin guardar'); }
  }
  function stageLatest(): void {
    if (!writable.current || !changed.current || !window.a3 || failed.current) return;
    const next = { ...current.current };
    tail.current = tail.current.then(async () => {
      if (failed.current) return;
      const result = await window.a3!.canvas({ action: 'stage', sessionId, workspaceId, expectedRevision: revision.current, viewport: next });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message} ${result.error.recovery}`);
    }).catch(report);
  }
  function flush(): void {
    clearTimeout(timer.current);
    if (frame.current !== undefined) { cancelAnimationFrame(frame.current); frame.current = undefined; }
    stageLatest();
    if (!writable.current || !changed.current || !window.a3 || failed.current) return;
    const atSave = current.current;
    tail.current = tail.current.then(async () => {
      if (failed.current) return;
      if (live.current) setStatus('Guardando vista…');
      const result = await window.a3!.canvas({ action: 'flush', sessionId, workspaceId });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message} ${result.error.recovery}`);
      revision.current = result.value.revision;
      if (current.current === atSave) changed.current = false;
      if (live.current) { installWorkspace(result.value); setStatus(changed.current ? 'Vista pendiente' : 'Vista guardada'); }
    }).catch(report);
  }
  function rebase(next: WorldViewport): void {
    const nearby = renderOrigin(next); originRef.current = nearby; setOrigin(nearby);
  }
  function update(next: WorldViewport, rebaseNow = false): void {
    try {
      renderOrigin(next);
      const prior = current.current;
      if (prior.x === next.x && prior.y === next.y && prior.zoom === next.zoom) return;
      current.current = next; setViewport(next); changed.current = true;
      if (rebaseNow) rebase(next);
      if (!writable.current) { setStatus('Vista temporal · solo lectura'); return; }
      setStatus('Vista pendiente');
      if (frame.current === undefined) frame.current = requestAnimationFrame(() => { frame.current = undefined; stageLatest(); });
      clearTimeout(timer.current); timer.current = setTimeout(flush, 500);
    } catch (cause) { setErrorKind('viewport'); setError(cause instanceof Error ? cause.message : 'No se pudo transformar la vista.'); }
  }
  useEffect(() => {
    live.current = true;
    void window.a3?.canvas({ action: 'load', sessionId, workspaceId }).then((result) => {
      if (!live.current) return;
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      const loaded = result.value; renderOrigin(loaded.viewport);
      current.current = loaded.viewport; revision.current = loaded.revision; writable.current = loaded.canWrite;
      changed.current = loaded.pending;
      installWorkspace(loaded); setViewport(loaded.viewport); rebase(loaded.viewport); setStatus(!loaded.canWrite ? 'Vista temporal · solo lectura' : loaded.pending ? 'Vista pendiente' : 'Vista guardada');
    }).catch(report);
    return () => { flush(); live.current = false; clearTimeout(timer.current); };
  }, [sessionId, workspaceId]);
  useEffect(() => window.a3?.onFileDrop((notice) => {
    if (notice.error) { setError(notice.error); setStatus('Drop cancelado'); setDropNotice(null); return; }
    setDropMode(notice.kind === 'folder' ? null : 'copy'); setDropNotice(notice);
    setError(null); setStatus(notice.kind === 'folder' ? 'Elige qué hacer con la carpeta' : 'Archivo listo para copiar');
  }), []);
  useEffect(() => {
    const host = hostRef.current; if (!host || !workspace) return;
    const wheel = (event: WheelEvent): void => {
      if (event.target instanceof Element && event.target.closest('.nowheel, input, textarea, select')) return;
      event.preventDefault(); event.stopPropagation();
      const rect = host.getBoundingClientRect();
      try { update(wheelViewport(current.current, event, { x: event.clientX - rect.left, y: event.clientY - rect.top }, rect), true); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Gesto inválido.'); }
    };
    host.addEventListener('wheel', wheel, { passive: false, capture: true });
    return () => host.removeEventListener('wheel', wheel, { capture: true });
  }, [!!workspace]);

  function zoom(factor: number): void {
    const rect = hostRef.current?.getBoundingClientRect(); if (rect) update(zoomAt(current.current, { x: rect.width / 2, y: rect.height / 2 }, current.current.zoom * factor), true);
  }
  async function discard(): Promise<void> {
    clearTimeout(timer.current); if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined;
    await tail.current;
    const result = await window.a3?.canvas({ action: 'discard', sessionId, workspaceId });
    if (result?.ok) { failed.current = false; changed.current = false; setError(null); revision.current = result.value.revision;
      current.current = result.value.viewport; setViewport(result.value.viewport); rebase(result.value.viewport); installWorkspace(result.value); setStatus('Vista guardada'); }
    else if (result && !result.ok) report(new Error(`${result.error.code}: ${result.error.message}`));
  }
  async function createPlacement(): Promise<void> {
    if (!workspace || !selectedEntityId || !window.a3) return;
    const rect = hostRef.current?.getBoundingClientRect(); if (!rect) return;
    const position = screenToWorld({ x: rect.width / 2, y: rect.height / 2 }, current.current);
    const result = await window.a3.canvas({ action: 'create-placement', sessionId, workspaceId,
      expectedWorkspaceRevision: workspace.revision, entityId: selectedEntityId, position });
    if (!result.ok) { setErrorKind('placement'); setError(`${result.error.code}: ${result.error.message} ${result.error.recovery}`); setStatus('Representación sin guardar'); return; }
    const id = result.value.placements.find((item) => !workspace.placements.some((old) => old.id === item.id))?.id;
    installWorkspace(result.value, id);
    if (id) setNodes((previous) => previous.map((node) => ({ ...node, selected: node.id === id })));
    setError(null); setErrorKind(null); setStatus('Representación creada');
  }
  async function createContentNode(): Promise<void> {
    if (!workspace || !window.a3) return;
    const rect = hostRef.current?.getBoundingClientRect(); if (!rect) return;
    const definition = contentNodeDefinition(contentKind);
    const node = { kind: contentKind, title: contentTitle, position: screenToWorld({ x: rect.width / 2, y: rect.height / 2 }, current.current),
      description: contentDescription, altText: contentAltText, language: contentLanguage,
      ...(definition.source === 'inline' ? { value: contentValue } : definition.source === 'url' || contentKind === 'image' && contentImageSource === 'url'
        ? { url: contentUrl } : { resourceId: contentResourceId }) };
    const result = await window.a3.canvas({ action: 'create-content-node', sessionId, workspaceId, expectedWorkspaceRevision: workspace.revision, node });
    if (!result.ok) { setErrorKind('placement'); setError(`${result.error.code}: ${result.error.message} ${result.error.recovery}`); setStatus('Nodo sin guardar'); return; }
    const placement = result.value.placements.find((item) => !workspace.placements.some((old) => old.id === item.id));
    installWorkspace(result.value, placement?.id);
    if (placement) setNodes((previous) => previous.map((item) => ({ ...item, selected: item.id === placement.id })));
    setError(null); setErrorKind(null); setStatus('Nodo de contenido creado');
  }
  async function smartPaste(mode: 'smart' | 'text'): Promise<void> {
    const latest = workspaceRef.current, rect = hostRef.current?.getBoundingClientRect();
    if (!latest || !rect || !window.a3) return;
    const position = screenToWorld({ x: rect.width / 2, y: rect.height / 2 }, current.current);
    const result = await window.a3.canvas({ action: 'smart-paste', sessionId, workspaceId, expectedWorkspaceRevision: latest.revision, position, mode });
    if (!result.ok) { setError(result.error.message); setStatus('Pegado cancelado'); return; }
    const added = result.value.placements.find((placement) => !latest.placements.some((previous) => previous.id === placement.id));
    installWorkspace(result.value, added?.id); setError(null); setErrorKind(null); setStatus(mode === 'text' ? 'Texto pegado como nodo' : 'Contenido pegado en el lienzo');
    if (added) setNodes((previous) => previous.map((node) => ({ ...node, selected: node.id === added.id })));
  }
  async function commitDrop(): Promise<void> {
    const notice = dropNotice, latest = workspaceRef.current, rect = hostRef.current?.getBoundingClientRect();
    if (!notice?.token || !notice.files?.length || !latest || !rect || !window.a3 || !dropMode) return;
    const position = screenToWorld({ x: notice.clientX - rect.left, y: notice.clientY - rect.top }, current.current);
    const result = await window.a3.canvas({ action: 'drop-file', sessionId, workspaceId, expectedWorkspaceRevision: latest.revision,
      position, token: notice.token, mode: dropMode });
    if (!result.ok) {
      setError(result.error.message); setStatus('Importación detenida');
      const refreshed = await window.a3.canvas({ action: 'load', sessionId, workspaceId });
      if (refreshed.ok) installWorkspace(refreshed.value, undefined, true);
      return;
    }
    const added = result.value.placements.find((placement) => !latest.placements.some((previous) => previous.id === placement.id));
    installWorkspace(result.value, added?.id); setError(null); setErrorKind(null); setStatus(dropMode === 'copy' ? 'Archivos copiados al proyecto' : 'Archivos referenciados');
    if (added) setNodes((previous) => previous.map((node) => ({ ...node, selected: node.id === added.id })));
    setDropNotice(null); setDropMode('copy');
  }
  async function cancelDrop(): Promise<void> {
    const notice = dropNotice;
    if (!notice?.token || !window.a3) { setDropNotice(null); return; }
    const result = await window.a3.canvas({ action: 'cancel-drop', sessionId, workspaceId, token: notice.token });
    if (result.ok) { installWorkspace(result.value); setDropNotice(null); setDropMode('copy'); setStatus('Drop cancelado · sin cambios'); }
  }
  function mutateCanvas(request: (latest: LocalCanvasWorkspace) => CanvasRequest, savedLabel = 'Organización guardada', errorCategory: 'placement' | 'drawing' = 'placement'): Promise<boolean> {
    const operation = mutationTail.current.then(async () => {
      const latest = workspaceRef.current; if (!latest || !window.a3) return false;
      try {
        const result = await window.a3.canvas(request(latest));
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        workspaceRef.current = result.value;
        if (live.current) { installWorkspace(result.value); setError(null); setErrorKind(null); setStatus(savedLabel); }
        return true;
      } catch (cause) {
        if (!live.current) return false;
        setErrorKind(errorCategory); setError(cause instanceof Error ? cause.message : 'No se pudo guardar el cambio.'); setStatus('Cambio sin guardar');
        try {
          const result = await window.a3.canvas({ action: 'load', sessionId, workspaceId });
          if (live.current && result.ok) installWorkspace(result.value, undefined, true);
        } catch { /* Keep the original conflict visible if reload also fails. */ }
        return false;
      }
    });
    mutationTail.current = operation;
    return operation;
  }
  function toggleGroup(groupId: string): void {
    void mutateCanvas((latest) => {
      const group = latest.groups.find((item) => item.id === groupId);
      if (!group) throw new Error('El grupo ya no está disponible.');
      return { action: 'set-group-collapsed', sessionId, workspaceId, groupId, expectedRevision: group.revision, collapsed: !group.collapsed };
    }, 'Vista del grupo guardada');
  }
  function selectedMembers(): GroupMember[] {
    return [...selection.nodeIds.map((id) => ({ kind: 'placement' as const, id })),
      ...selection.drawingIds.map((id) => ({ kind: 'drawing' as const, id })), ...selection.groupIds.map((id) => ({ kind: 'group' as const, id }))];
  }
  async function createGroup(): Promise<void> {
    const members = selectedMembers(), before = new Set(workspaceRef.current?.groups.map((group) => group.id) ?? []);
    if (!members.length || !workspace?.canWrite) return;
    const ok = await mutateCanvas((latest) => ({ action: 'create-group', sessionId, workspaceId, expectedWorkspaceRevision: latest.revision, name: groupName, members }), 'Grupo creado');
    if (ok) { const created = workspaceRef.current?.groups.find((group) => !before.has(group.id)); if (created) setSelectedGroupId(created.id); }
  }
  function currentGroupId(latest: LocalCanvasWorkspace): string | undefined {
    const fromSelection = selection.groupIds.length === 1 ? selection.groupIds[0] : '';
    const requested = fromSelection || selectedGroupId;
    return latest.groups.find((group) => group.id === requested)?.id;
  }
  function includeSelection(): void {
    void mutateCanvas((latest) => {
      const groupId = currentGroupId(latest), group = latest.groups.find((item) => item.id === groupId);
      if (!group) throw new Error('Selecciona un grupo para incluir miembros.');
      const members = [...group.members];
      for (const member of selectedMembers()) if (member.id !== group.id && !members.some((item) => item.kind === member.kind && item.id.toLowerCase() === member.id.toLowerCase())) members.push(member);
      return { action: 'set-group-members', sessionId, workspaceId, groupId: group.id, expectedRevision: group.revision, members };
    }, 'Miembros añadidos al grupo');
  }
  function removeSelectionFromGroup(): void {
    void mutateCanvas((latest) => {
      const groupId = currentGroupId(latest), group = latest.groups.find((item) => item.id === groupId);
      if (!group) throw new Error('Selecciona un grupo para sacar miembros.');
      const selected = selectedMembers();
      const members = group.members.filter((member) => !selected.some((item) => item.kind === member.kind && item.id.toLowerCase() === member.id.toLowerCase()));
      return { action: 'set-group-members', sessionId, workspaceId, groupId: group.id, expectedRevision: group.revision, members };
    }, 'Miembros retirados del grupo');
  }
  function renameGroup(): void {
    void mutateCanvas((latest) => {
      const groupId = currentGroupId(latest), group = latest.groups.find((item) => item.id === groupId);
      if (!group) throw new Error('Selecciona un grupo para renombrarlo.');
      return { action: 'rename-group', sessionId, workspaceId, groupId: group.id, expectedRevision: group.revision, name: groupName };
    }, 'Grupo renombrado');
  }
  function selectDrawing(id: string, event: React.MouseEvent<SVGElement> | React.KeyboardEvent<SVGElement>): void {
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    setSelection((previous) => {
      const next = additive ? previous.drawingIds.includes(id) ? previous.drawingIds.filter((item) => item !== id) : [...previous.drawingIds, id] : [id];
      return additive ? { ...previous, drawingIds: next } : { nodeIds: [], groupIds: [], edgeIds: [], drawingIds: next };
    });
    if (!additive) {
      setNodes((previous) => previous.map((node) => node.selected ? { ...node, selected: false } : node));
      setEdges((previous) => previous.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
    }
  }
  function appendStroke(event: React.PointerEvent<HTMLDivElement>): void {
    const stroke = activeStroke.current, host = hostRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId || !host) return;
    const native = event.nativeEvent;
    const samples = native.getCoalescedEvents?.() ?? [];
    const points = samples.length ? [...samples] : [native];
    const last = points.at(-1);
    if (!last || last.clientX !== native.clientX || last.clientY !== native.clientY) points.push(native);
    const rect = host.getBoundingClientRect();
    for (const sample of points) {
      const world = screenToWorld({ x: sample.clientX - rect.left, y: sample.clientY - rect.top }, current.current);
      const hasPressure = stroke.pointerType !== 'mouse' && Number.isFinite(sample.pressure) && sample.pressure > 0;
      if (hasPressure) stroke.hasPressure = true;
      const point: DrawingPoint = { ...world, ...(hasPressure ? { pressure: sample.pressure } : {}) };
      const previous = stroke.points.at(-1);
      if (!previous || previous.x !== point.x || previous.y !== point.y || previous.pressure !== point.pressure) stroke.points.push(point);
    }
    setStrokePreview({ points: [...stroke.points], parameters: { ...defaultDrawingParameters, simulatePressure: !stroke.hasPressure }, color: '#c3ed82' });
  }
  function beginStroke(event: React.PointerEvent<HTMLDivElement>): void {
    if (toolRef.current !== 'draw' || !writable.current || !workspaceRef.current || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    activeStroke.current = { pointerId: event.pointerId, pointerType: event.pointerType, hasPressure: false, points: [] };
    setSelection({ nodeIds: [], groupIds: [], edgeIds: [], drawingIds: [] });
    setNodes((previous) => previous.map((node) => node.selected ? { ...node, selected: false } : node));
    setEdges((previous) => previous.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic test input and older touch drivers may not expose capture. */ }
    appendStroke(event);
  }
  function continueStroke(event: React.PointerEvent<HTMLDivElement>): void {
    if (!activeStroke.current) return;
    event.preventDefault(); event.stopPropagation(); appendStroke(event);
  }
  function finishStroke(event: React.PointerEvent<HTMLDivElement>): void {
    const stroke = activeStroke.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); appendStroke(event); activeStroke.current = null; setStrokePreview(null);
    const parameters = { ...defaultDrawingParameters, simulatePressure: !stroke.hasPressure };
    const existing = new Set(workspaceRef.current?.drawings.map((drawing) => drawing.id) ?? []);
    void mutateCanvas((latest) => ({ action: 'create-drawing', sessionId, workspaceId, expectedWorkspaceRevision: latest.revision,
      points: stroke.points, parameters, style: { 'a3.ui.stroke.color': '#c3ed82' } }), 'Trazo guardado', 'drawing').then((ok) => {
      if (!ok || !live.current) return;
      const created = workspaceRef.current?.drawings.find((drawing) => !existing.has(drawing.id));
      if (created) { setSelection({ nodeIds: [], groupIds: [], edgeIds: [], drawingIds: [created.id] }); setStatus('Trazo guardado'); }
    });
  }
  function cancelStroke(event: React.PointerEvent<HTMLDivElement>): void {
    if (!activeStroke.current || activeStroke.current.pointerId !== event.pointerId) return;
    activeStroke.current = null; setStrokePreview(null);
  }
  function createVisualEdge(sourcePlacementId: string, targetPlacementId: string): void {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(sourcePlacementId) || !uuid.test(targetPlacementId)) return;
    const before = new Set(workspaceRef.current?.visualEdges.map((edge) => edge.id));
    void mutateCanvas((latest) => ({ action: 'create-visual-edge', sessionId, workspaceId, expectedWorkspaceRevision: latest.revision, sourcePlacementId, targetPlacementId })).then((ok) => {
      if (!ok || !live.current) return;
      setNodes((previous) => previous.map((node) => node.selected ? { ...node, selected: false } : node));
      setEdges((previous) => previous.map((edge) => ({ ...edge, selected: !before.has(edge.id) })));
    });
  }
  function updateVisualEdge(edgeId: string, patch: CanvasVisualEdgePatch): void {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (patch.sourcePlacementId && !uuid.test(patch.sourcePlacementId) || patch.targetPlacementId && !uuid.test(patch.targetPlacementId)) return;
    void mutateCanvas((latest) => ({ action: 'update-visual-edge', sessionId, workspaceId, edgeId,
      expectedRevision: latest.visualEdges.find((edge) => edge.id === edgeId)?.revision ?? 0, patch }));
  }
  function deleteVisualEdge(edgeId: string): Promise<boolean> {
    return mutateCanvas((latest) => ({ action: 'delete-visual-edge', sessionId, workspaceId, edgeId,
      expectedRevision: latest.visualEdges.find((edge) => edge.id === edgeId)?.revision ?? 0 }));
  }
  function deleteDrawing(drawingId: string): Promise<boolean> {
    return mutateCanvas((latest) => ({ action: 'delete-drawing', sessionId, workspaceId, drawingId,
      expectedRevision: latest.drawings.find((drawing) => drawing.id === drawingId)?.revision ?? 0 }), 'Trazo eliminado', 'drawing').then((ok) => {
        if (ok && live.current) setSelection((previous) => ({ ...previous, drawingIds: previous.drawingIds.filter((id) => id !== drawingId) }));
        return ok;
      });
  }
  function updateDrawing(drawingId: string, patch: { parameters?: Partial<DrawingParameters>; style?: Drawing['style'] }): void {
    void mutateCanvas((latest) => ({ action: 'update-drawing', sessionId, workspaceId, drawingId,
      expectedRevision: latest.drawings.find((drawing) => drawing.id === drawingId)?.revision ?? 0, patch }), 'Parámetros del trazo guardados', 'drawing');
  }
  function convertDrawingsToNode(): void {
    const existingPlacements = new Set(workspaceRef.current?.placements.map((placement) => placement.id) ?? []);
    void mutateCanvas((latest) => ({ action: 'convert-drawings-to-node', sessionId, workspaceId, expectedWorkspaceRevision: latest.revision,
      drawings: selection.drawingIds.flatMap((id) => {
        const drawing = latest.drawings.find((item) => item.id === id);
        return drawing ? [{ id, expectedRevision: drawing.revision }] : [];
      }) }), 'Nodo Dibujo creado', 'drawing').then((ok) => {
        if (!ok || !live.current) return;
        const placement = workspaceRef.current?.placements.find((item) => !existingPlacements.has(item.id));
        setSelection({ nodeIds: placement ? [placement.id] : [], groupIds: [], edgeIds: [], drawingIds: [] });
        if (placement) setNodes((previous) => previous.map((node) => ({ ...node, selected: node.id === placement.id })));
      });
  }
  function moveNodes(moved: CanvasFlowNode[]): void {
    const origin = originRef.current;
    const movedGroups = moved.filter((item): item is CanvasGroupNode => item.type === 'a3Group' && !!item.draggable);
    const groupedPlacements = new Set<string>(movedGroups.flatMap((node) => [...(groupLayouts(workspaceRef.current!).layouts.get(node.data.group.id.toLowerCase())?.placementIds ?? [])]));
    for (const node of movedGroups) {
      const offset = { x: node.position.x - node.data.basePosition.x, y: node.position.y - node.data.basePosition.y };
      if (offset.x || offset.y) void mutateCanvas((latest) => ({ action: 'move-group', sessionId, workspaceId, groupId: node.data.group.id,
        expectedRevision: latest.groups.find((group) => group.id === node.data.group.id)?.revision ?? 0, offset }), 'Grupo movido');
    }
    const positions = moved.filter((node): node is CanvasNode => node.type === 'a3Entity' && !!node.draggable && !groupedPlacements.has(node.id))
      .map((node) => ({ id: node.id, position: { x: node.position.x + origin.x, y: node.position.y + origin.y } }));
    if (!positions.length) return;
    void mutateCanvas((latest) => ({ action: 'move-placements', sessionId, workspaceId, placements: positions.map((item) => ({ ...item,
      expectedRevision: latest.placements.find((placement) => placement.id === item.id)?.revision ?? 0 })) }));
  }
  const activeGroup = selection.groupIds.length === 1 ? workspace?.groups.find((group) => group.id === selection.groupIds[0]) : workspace?.groups.find((group) => group.id === selectedGroupId);
  const selectedPlacement = selection.nodeIds.length === 1 ? workspace?.placements.find((item) => item.id === selection.nodeIds[0]) : undefined;
  const selectedEdge = selection.edgeIds.length === 1 && selection.nodeIds.length === 0 && selection.drawingIds.length === 0 ? workspace?.visualEdges.find((item) => item.id === selection.edgeIds[0]) : undefined;
  const selectedDrawing = selection.drawingIds.length === 1 && selection.nodeIds.length === 0 && selection.edgeIds.length === 0
    ? workspace?.drawings.find((item) => item.id === selection.drawingIds[0]) : undefined;
  const canvasGroupLayout = workspace ? groupLayouts(workspace) : null;
  const hiddenDrawingIds = canvasGroupLayout?.hiddenDrawings ?? new Set<string>();
  const visibleDrawings = workspace?.drawings.filter((drawing) => !hiddenDrawingIds.has(drawing.id.toLowerCase())) ?? [];
  const visiblePlacementCount = workspace?.placements.filter((placement) => !canvasGroupLayout?.hiddenPlacements.has(placement.id.toLowerCase())).length ?? 0;
  function duplicateSelectionSnapshot(latest: LocalCanvasWorkspace): CanvasSelection {
    const placementIds = new Set(selection.nodeIds.map((id) => id.toLowerCase()));
    const drawingIds = new Set(selection.drawingIds.map((id) => id.toLowerCase()));
    const groupIds = new Set(selection.groupIds.map((id) => id.toLowerCase()));
    const groups = new Map(latest.groups.map((group) => [group.id.toLowerCase(), group]));
    const visitedGroups = new Set<string>();
    const visit = (id: string, path = new Set<string>()): void => {
      const key = id.toLowerCase(); if (path.has(key) || visitedGroups.has(key)) return;
      const group = groups.get(key); if (!group) return;
      visitedGroups.add(key); groupIds.add(key); const nextPath = new Set(path); nextPath.add(key);
      for (const member of group.members) {
        if (member.kind === 'placement') placementIds.add(member.id.toLowerCase());
        else if (member.kind === 'drawing') drawingIds.add(member.id.toLowerCase());
        else visit(member.id, nextPath);
      }
    };
    for (const id of selection.groupIds) visit(id);
    return {
      placements: [...placementIds].flatMap((id) => { const item = latest.placements.find((placement) => placement.id.toLowerCase() === id); return item ? [{ id: item.id, expectedRevision: item.revision }] : []; }),
      drawings: [...drawingIds].flatMap((id) => { const item = latest.drawings.find((drawing) => drawing.id.toLowerCase() === id); return item ? [{ id: item.id, expectedRevision: item.revision }] : []; }),
      groups: [...groupIds].flatMap((id) => { const item = latest.groups.find((group) => group.id.toLowerCase() === id); return item ? [{ id: item.id, expectedRevision: item.revision }] : []; })
    };
  }
  function duplicateSelection(mode: 'representation' | 'content'): void {
    const before = workspaceRef.current; if (!before) return;
    const existing = { placements: new Set(before.placements.map((item) => item.id.toLowerCase())), drawings: new Set(before.drawings.map((item) => item.id.toLowerCase())), groups: new Set(before.groups.map((item) => item.id.toLowerCase())) };
    const selected = duplicateSelectionSnapshot(before);
    if (!selected.placements.length && !selected.drawings.length && !selected.groups.length) return;
    void mutateCanvas((latest) => ({ action: 'duplicate-selection', sessionId, workspaceId, expectedWorkspaceRevision: latest.revision, selection: selected, mode }),
      mode === 'content' ? 'Contenido duplicado' : 'Representación duplicada').then((ok) => {
      if (!ok || !live.current) return;
      const latest = workspaceRef.current; if (!latest) return;
      const nodeIds = latest.placements.filter((item) => !existing.placements.has(item.id.toLowerCase())).map((item) => item.id);
      const drawingIds = latest.drawings.filter((item) => !existing.drawings.has(item.id.toLowerCase())).map((item) => item.id);
      const groupIds = latest.groups.filter((item) => !existing.groups.has(item.id.toLowerCase())).map((item) => item.id);
      setSelection({ nodeIds, groupIds, drawingIds, edgeIds: [] }); setSelectedGroupId(groupIds[0] ?? '');
      setNodes((previous) => previous.map((node) => ({ ...node, selected: node.type === 'a3Entity' ? nodeIds.includes(node.id) : groupIds.includes(node.data.group.id) })));
      setEdges((previous) => previous.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
    });
  }
  function alignSelection(kind: 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom' | 'distribute-x' | 'distribute-y'): void {
    void mutateCanvas((latest) => {
      const selected = selection.nodeIds.flatMap((id) => { const item = latest.placements.find((placement) => placement.id === id); return item ? [item] : []; });
      const items = selected.filter((item) => item.style['a3.ui.locked'] !== true);
      const distribute = kind.startsWith('distribute');
      if (items.length < (distribute ? 3 : 2)) throw new Error(distribute ? 'Distribuir requiere tres representaciones desbloqueadas.' : 'Alinear requiere dos representaciones desbloqueadas.');
      const positions = new Map(items.map((item) => [item.id, { ...item.position }]));
      if (!distribute) {
        const horizontal = ['left', 'center-x', 'right'].includes(kind);
        if (horizontal) {
          const target = kind === 'left' ? Math.min(...items.map((item) => item.position.x)) : kind === 'right'
            ? Math.max(...items.map((item) => item.position.x + item.size.width))
            : items.reduce((sum, item) => sum + item.position.x + item.size.width / 2, 0) / items.length;
          for (const item of items) positions.get(item.id)!.x = kind === 'left' ? target : kind === 'right' ? target - item.size.width : target - item.size.width / 2;
        } else {
          const target = kind === 'top' ? Math.min(...items.map((item) => item.position.y)) : kind === 'bottom'
            ? Math.max(...items.map((item) => item.position.y + item.size.height))
            : items.reduce((sum, item) => sum + item.position.y + item.size.height / 2, 0) / items.length;
          for (const item of items) positions.get(item.id)!.y = kind === 'top' ? target : kind === 'bottom' ? target - item.size.height : target - item.size.height / 2;
        }
      } else {
        const horizontal = kind === 'distribute-x';
        const sorted = [...items].sort((a, b) => horizontal ? a.position.x - b.position.x : a.position.y - b.position.y);
        const first = sorted[0]!, last = sorted.at(-1)!;
        const span = horizontal ? last.position.x + last.size.width - first.position.x : last.position.y + last.size.height - first.position.y;
        const total = sorted.reduce((sum, item) => sum + (horizontal ? item.size.width : item.size.height), 0);
        const gap = (span - total) / (sorted.length - 1);
        let cursor = horizontal ? first.position.x : first.position.y;
        for (const item of sorted) {
          if (horizontal) positions.get(item.id)!.x = cursor; else positions.get(item.id)!.y = cursor;
          cursor += (horizontal ? item.size.width : item.size.height) + gap;
        }
      }
      return { action: 'move-placements', sessionId, workspaceId, placements: items.map((item) => ({ id: item.id, expectedRevision: item.revision, position: positions.get(item.id)! })) };
    }, 'Disposición guardada');
  }
  function updateSelectedPlacementStyles(patches: (items: CanvasPlacementView[]) => { id: string; style: CanvasPlacementView['style'] }[]): void {
    void mutateCanvas((latest) => {
      const items = selection.nodeIds.flatMap((id) => { const item = latest.placements.find((placement) => placement.id === id); return item ? [item] : []; });
      const changes = patches(items);
      if (!changes.length) throw new Error('Selecciona al menos una representación.');
      return { action: 'update-placement-views', sessionId, workspaceId, placements: changes.map((patch) => ({ ...patch,
        expectedRevision: items.find((item) => item.id === patch.id)!.revision })) };
    }, 'Orden y bloqueo guardados');
  }
  function lockSelection(locked: boolean): void {
    updateSelectedPlacementStyles((items) => items.filter((item) => (item.style['a3.ui.locked'] === true) !== locked)
      .map((item) => ({ id: item.id, style: { 'a3.ui.locked': locked } })));
  }
  function reorderSelection(direction: 'front' | 'back'): void {
    updateSelectedPlacementStyles((items) => {
      const all = workspaceRef.current?.placements ?? [];
      const selectedIds = new Set(items.map((item) => item.id));
      const layer = (item: CanvasPlacementView): number => typeof item.style['a3.ui.z-index'] === 'number' && Number.isFinite(item.style['a3.ui.z-index']) ? item.style['a3.ui.z-index'] : 1;
      const ordered = [...all].sort((a, b) => layer(a) - layer(b) || all.indexOf(a) - all.indexOf(b));
      const selected = ordered.filter((item) => selectedIds.has(item.id));
      if (!selected.length) return [];
      const min = Math.min(...ordered.map(layer)), max = Math.max(...ordered.map(layer));
      return selected.map((item, index) => ({ id: item.id, style: { 'a3.ui.z-index': direction === 'front' ? max + index + 1 : min - selected.length + index } }));
    });
  }
  const hasGroupSelection = selection.nodeIds.length + selection.groupIds.length + selection.drawingIds.length > 0;
  function changeHistory(action: 'undo' | 'redo'): void { void mutateCanvas(() => ({ action, sessionId, workspaceId }), action === 'undo' ? 'Cambio deshecho' : 'Cambio rehecho'); }
  const visual = toVisualViewport(viewport, origin);
  const topLeft = screenToWorld({ x: 0, y: 0 }, viewport);
  const referenceScreen = worldToScreen(reference, viewport);
  const referenceVisible = referenceScreen.x + reference.width * viewport.zoom >= -20000 && referenceScreen.y + reference.height * viewport.zoom >= -20000 && referenceScreen.x <= 20000 && referenceScreen.y <= 20000;
  return <>
    <div className="canvas-tools" role="toolbar" aria-label="Herramienta del lienzo">
      <button data-canvas-tool="select" aria-pressed={tool === 'select'} onClick={() => setTool('select')}>Seleccionar (V)</button>
      <button data-canvas-tool="draw" aria-pressed={tool === 'draw'} disabled={!workspace?.canWrite} onClick={() => { setSelection({ nodeIds: [], groupIds: [], edgeIds: [], drawingIds: [] }); setTool('draw'); }}>Dibujar a mano (D)</button>
      <button data-canvas-tool="connect" aria-pressed={tool === 'connect'} onClick={() => setTool('connect')}>Dibujar conexión (C)</button>
      <button data-canvas-tool="text" aria-pressed={tool === 'text'} onClick={() => setTool('text')}>Editar etiqueta (T)</button>
      <span data-canvas-selection role="status">{selection.nodeIds.length} nodos, {selection.groupIds.length} grupos, {selection.edgeIds.length} líneas y {selection.drawingIds.length} trazos seleccionados</span>
    </div>
    <div className="canvas-toolbar" aria-label="Navegación del lienzo">
      <button className="secondary" data-canvas-zoom-out disabled={!workspace || viewport.zoom <= MIN_ZOOM} onClick={() => zoom(1 / 1.2)} aria-label="Alejar">−</button>
      <output data-canvas-zoom aria-label="Escala del lienzo">{(viewport.zoom * 100).toLocaleString('es', { maximumFractionDigits: 1 })} %</output>
      <button className="secondary" data-canvas-zoom-in disabled={!workspace || viewport.zoom >= MAX_ZOOM} onClick={() => zoom(1.2)} aria-label="Acercar">+</button>
      <button className="secondary" data-canvas-fit disabled={!workspace || !showReference} onClick={() => { const rect = hostRef.current?.getBoundingClientRect(); if (rect) update(fitContent(reference, rect), true); }}>Ajustar contenido</button>
      <button className="quiet" data-canvas-paste-text disabled={!workspace?.canWrite} onClick={() => void smartPaste('text')}>Pegar como texto</button>
      <button className="quiet" data-canvas-save disabled={!workspace?.canWrite || status === 'Vista guardada' || status === 'Guardando vista…'} onClick={() => { failed.current = false; setError(null); flush(); }}>Guardar vista</button>
      <label>Entidad <select aria-label="Entidad para nueva representación" data-canvas-entity value={selectedEntityId || workspace?.entityChoices[0]?.id || ''} disabled={!workspace?.canWrite || !workspace.entityChoices.length}
        onChange={(event) => setSelectedEntityId(event.target.value)}>{workspace?.entityChoices.map((entity) => <option key={entity.id} value={entity.id}>{entity.title} · {entity.type}</option>)}</select></label>
      <button className="secondary" data-canvas-create-placement disabled={!workspace?.canWrite || !workspace.entityChoices.length} onClick={() => void createPlacement()}>Crear representación</button>
      <details className="canvas-insert-node" data-canvas-insert-node>
        <summary>Insertar nodo de contenido</summary>
        <div className="canvas-insert-node-form">
          <label>Tipo <select data-content-kind value={contentKind} disabled={!workspace?.canWrite} onChange={(event) => {
            const kind = event.target.value as ContentNodeKind; setContentKind(kind); setContentTitle(`Nuevo ${contentNodeDefinition(kind).label.toLowerCase()}`); setContentValue(initialContentValue(kind)); setContentImageSource('resource');
          }}>{CONTENT_NODE_CATALOG.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label>
          <label>Título <input data-content-title value={contentTitle} maxLength={200} disabled={!workspace?.canWrite} onChange={(event) => setContentTitle(event.target.value)} /></label>
          {contentKind === 'page' || contentKind === 'short-text' || contentKind === 'code' || contentKind === 'drawing'
            ? <label className="canvas-content-source">Fuente <textarea data-content-value value={contentValue} maxLength={1_000_000} disabled={!workspace?.canWrite} onChange={(event) => setContentValue(event.target.value)} /></label>
            : contentKind === 'youtube' || contentKind === 'web-link'
              ? <label>URL <input data-content-url type="url" value={contentUrl} maxLength={2048} placeholder="https://…" disabled={!workspace?.canWrite} onChange={(event) => setContentUrl(event.target.value)} /></label>
              : contentKind === 'image' ? <>
                <label>Origen <select data-content-image-source value={contentImageSource} disabled={!workspace?.canWrite} onChange={(event) => setContentImageSource(event.target.value as 'resource' | 'url')}>
                  <option value="resource">Recurso local o montado</option><option value="url">Referencia URL</option></select></label>
                {contentImageSource === 'url' ? <label>URL de imagen <input data-content-url type="url" value={contentUrl} maxLength={2048} placeholder="https://…" disabled={!workspace?.canWrite} onChange={(event) => setContentUrl(event.target.value)} /></label> :
                  <label>Recurso existente <select data-content-resource value={contentResourceId} disabled={!workspace?.canWrite || !workspace.resourceChoices.length}
                    onChange={(event) => setContentResourceId(event.target.value)}><option value="">Selecciona un recurso</option>{workspace?.resourceChoices.map((resource) => <option key={resource.id} value={resource.id}>{resource.label} · {resource.mediaType ?? resource.kind}</option>)}</select></label>}
              </>
              : <label>Recurso existente <select data-content-resource value={contentResourceId} disabled={!workspace?.canWrite || !workspace.resourceChoices.length}
                onChange={(event) => setContentResourceId(event.target.value)}><option value="">Selecciona un recurso</option>{workspace?.resourceChoices.map((resource) => <option key={resource.id} value={resource.id}>{resource.label} · {resource.mediaType ?? resource.kind}</option>)}</select></label>}
          {(contentKind === 'image' || contentKind === 'video' || contentKind === 'audio') && <label>Descripción <input data-content-description value={contentDescription} maxLength={16000} disabled={!workspace?.canWrite} onChange={(event) => setContentDescription(event.target.value)} /></label>}
          {contentKind === 'image' && <label>Texto alternativo <input data-content-alt-text value={contentAltText} maxLength={16000} disabled={!workspace?.canWrite} onChange={(event) => setContentAltText(event.target.value)} /></label>}
          {contentKind === 'code' && <label>Lenguaje <input data-content-language value={contentLanguage} maxLength={80} disabled={!workspace?.canWrite} onChange={(event) => setContentLanguage(event.target.value)} /></label>}
          <button className="secondary" data-canvas-create-content disabled={!workspace?.canWrite || !contentTitle.trim() ||
            (['youtube', 'web-link'].includes(contentKind) && !contentUrl.trim()) || contentKind === 'image' && (contentImageSource === 'url' ? !contentUrl.trim() : !contentResourceId) ||
            (['video', 'audio', 'file'].includes(contentKind) && !contentResourceId)}
            onClick={() => void createContentNode()}>Insertar</button>
          {['youtube', 'web-link'].includes(contentKind) && <small>Se guarda una referencia; A3 no consulta ni descarga la URL.</small>}
          {['image', 'video', 'audio', 'file'].includes(contentKind) && !workspace?.resourceChoices.length && <small>Crea o incorpora un recurso desde Archivos y vuelve a abrir este catálogo.</small>}
        </div>
      </details>
      <label className="canvas-fixture"><input type="checkbox" data-canvas-fixture checked={showReference} onChange={(event) => setShowReference(event.target.checked)} />Referencia de prueba</label>
    </div>
    <div className="canvas-arrange-toolbar" role="toolbar" aria-label="Duplicación, disposición e historial">
      <button data-canvas-undo disabled={!workspace?.canWrite || !workspace.history.canUndo || workspace.history.undoRequiresDelete && !workspace.history.deleteAvailable} onClick={() => changeHistory('undo')}>Deshacer</button>
      <button data-canvas-redo disabled={!workspace?.canWrite || !workspace.history.canRedo || workspace.history.redoRequiresDelete && !workspace.history.deleteAvailable} onClick={() => changeHistory('redo')}>Rehacer</button>
      {workspace?.canWrite && (workspace.history.undoRequiresDelete && !workspace.history.deleteAvailable || workspace.history.redoRequiresDelete && !workspace.history.deleteAvailable) &&
        <button data-canvas-request-history-delete onClick={() => void mutateCanvas(() => ({ action: 'approve-history-delete', sessionId, workspaceId }), 'Permiso para historial aprobado')}>Habilitar eliminaciones para el historial</button>}
      <button data-canvas-duplicate-representation disabled={!workspace?.canWrite || !hasGroupSelection} onClick={() => duplicateSelection('representation')}>Duplicar representación</button>
      <button data-canvas-duplicate-content disabled={!workspace?.canWrite || selection.nodeIds.length === 0} onClick={() => duplicateSelection('content')}>Duplicar contenido</button>
      <button data-canvas-align-left disabled={!workspace?.canWrite || selection.nodeIds.length < 2} onClick={() => alignSelection('left')}>Alinear izquierda</button>
      <button data-canvas-align-center disabled={!workspace?.canWrite || selection.nodeIds.length < 2} onClick={() => alignSelection('center-x')}>Alinear centros</button>
      <button data-canvas-align-top disabled={!workspace?.canWrite || selection.nodeIds.length < 2} onClick={() => alignSelection('top')}>Alinear arriba</button>
      <button data-canvas-distribute-x disabled={!workspace?.canWrite || selection.nodeIds.length < 3} onClick={() => alignSelection('distribute-x')}>Distribuir horizontal</button>
      <button data-canvas-distribute-y disabled={!workspace?.canWrite || selection.nodeIds.length < 3} onClick={() => alignSelection('distribute-y')}>Distribuir vertical</button>
      <button data-canvas-order-front disabled={!workspace?.canWrite || selection.nodeIds.length === 0} onClick={() => reorderSelection('front')}>Traer al frente</button>
      <button data-canvas-order-back disabled={!workspace?.canWrite || selection.nodeIds.length === 0} onClick={() => reorderSelection('back')}>Enviar atrás</button>
      <button data-canvas-lock-selection disabled={!workspace?.canWrite || selection.nodeIds.length === 0} onClick={() => lockSelection(true)}>Bloquear selección</button>
      <button data-canvas-unlock-selection disabled={!workspace?.canWrite || selection.nodeIds.length === 0} onClick={() => lockSelection(false)}>Desbloquear selección</button>
    </div>
    <div className="canvas-group-toolbar" role="group" aria-label="Grupos espaciales">
      <label>Nombre <input aria-label="Nombre del grupo" data-canvas-group-name value={groupName} onChange={(event) => setGroupName(event.target.value)} maxLength={120} /></label>
      <button className="secondary" data-canvas-create-group disabled={!workspace?.canWrite || !hasGroupSelection} onClick={() => void createGroup()}>Agrupar selección</button>
      <label>Grupo <select aria-label="Grupo espacial" data-canvas-group value={activeGroup?.id ?? ''} onChange={(event) => {
        const next = workspace?.groups.find((group) => group.id === event.target.value); setSelectedGroupId(next?.id ?? ''); if (next) setGroupName(next.name);
      }} disabled={!workspace?.groups.length}>
        <option value="">Selecciona un grupo</option>{workspace?.groups.map((group) => <option key={group.id} value={group.id}>{group.name}{group.collapsed ? ' · contraído' : ''}</option>)}
      </select></label>
      <button className="quiet" data-canvas-group-include disabled={!workspace?.canWrite || !activeGroup || !hasGroupSelection} onClick={includeSelection}>Incluir selección</button>
      <button className="quiet" data-canvas-group-remove disabled={!workspace?.canWrite || !activeGroup || !hasGroupSelection} onClick={removeSelectionFromGroup}>Sacar selección</button>
      <button className="quiet" data-canvas-group-rename disabled={!workspace?.canWrite || !activeGroup} onClick={renameGroup}>Renombrar</button>
      <button className="quiet" data-canvas-group-collapse disabled={!workspace?.canWrite || !activeGroup} aria-pressed={activeGroup?.collapsed === true}
        onClick={() => activeGroup && toggleGroup(activeGroup.id)}>{activeGroup?.collapsed ? 'Expandir grupo' : 'Contraer grupo'}</button>
      {activeGroup && <span data-canvas-group-member-count>{activeGroup.members.length} miembros directos</span>}
    </div>
    <div className="canvas-selection-properties" aria-label="Propiedades de la selección">
      {selectedPlacement && <label>Color de vista <select aria-label="Color de esta representación" data-canvas-style value={['#9bc279', '#78a9d1', '#d19b78', '#bb91d3'].includes(String(selectedPlacement.style['a3.ui.accent'])) ? String(selectedPlacement.style['a3.ui.accent']) : '#9bc279'}
        disabled={!workspace?.canWrite} onChange={(event) => void persistPlacement(selectedPlacement.id, { style: { 'a3.ui.accent': event.target.value } })}>
        <option value="#9bc279">Verde</option><option value="#78a9d1">Azul</option><option value="#d19b78">Naranja</option><option value="#bb91d3">Violeta</option>
      </select></label>}
      {selectedPlacement && <button className="quiet" data-canvas-lock disabled={!workspace?.canWrite} aria-pressed={selectedPlacement.style['a3.ui.locked'] === true}
        onClick={() => void persistPlacement(selectedPlacement.id, { style: { 'a3.ui.locked': selectedPlacement.style['a3.ui.locked'] !== true } })}>
        {selectedPlacement.style['a3.ui.locked'] === true ? 'Desbloquear nodo' : 'Bloquear nodo'}</button>}
      {selection.drawingIds.length > 0 && <><span>{selection.drawingIds.length} trazo(s)</span>
        <button className="quiet" data-canvas-convert-drawing disabled={!workspace?.canConvertDrawings} onClick={convertDrawingsToNode}>Convertir selección a nodo Dibujo</button>
        <button className="quiet" data-canvas-delete-drawings disabled={!workspace?.canDeleteDrawings} onClick={() => { for (const id of selection.drawingIds) void deleteDrawing(id); }}>Borrar trazos seleccionados</button>
        {!workspace?.canDeleteDrawings && <button className="quiet" data-canvas-request-drawing-delete onClick={() => void mutateCanvas(() => ({ action: 'approve-drawing-delete', sessionId, workspaceId }))}>Solicitar permiso para borrar</button>}
      </>}
    </div>
    {selectedDrawing && <div className="canvas-drawing-properties" aria-label="Parámetros del trazo" key={`${selectedDrawing.id}:${selectedDrawing.revision}`}>
      <label>Grosor <input data-drawing-size type="number" min="0.1" max="512" step="0.5" defaultValue={selectedDrawing.parameters.size} disabled={!workspace?.canWrite}
        onBlur={(event) => { const size = Number(event.currentTarget.value); if (Number.isFinite(size) && size > 0 && size <= 512 && size !== selectedDrawing.parameters.size) updateDrawing(selectedDrawing.id, { parameters: { size } }); }} /></label>
      <label>Variación <input type="number" min="-1" max="1" step="0.1" defaultValue={selectedDrawing.parameters.thinning} disabled={!workspace?.canWrite}
        onBlur={(event) => { const thinning = Number(event.currentTarget.value); if (Number.isFinite(thinning) && thinning >= -1 && thinning <= 1 && thinning !== selectedDrawing.parameters.thinning) updateDrawing(selectedDrawing.id, { parameters: { thinning } }); }} /></label>
      <label>Suavizado <input type="number" min="0" max="1" step="0.1" defaultValue={selectedDrawing.parameters.smoothing} disabled={!workspace?.canWrite}
        onBlur={(event) => { const smoothing = Number(event.currentTarget.value); if (Number.isFinite(smoothing) && smoothing >= 0 && smoothing <= 1 && smoothing !== selectedDrawing.parameters.smoothing) updateDrawing(selectedDrawing.id, { parameters: { smoothing } }); }} /></label>
      <label>Flujo <input type="number" min="0" max="1" step="0.1" defaultValue={selectedDrawing.parameters.streamline} disabled={!workspace?.canWrite}
        onBlur={(event) => { const streamline = Number(event.currentTarget.value); if (Number.isFinite(streamline) && streamline >= 0 && streamline <= 1 && streamline !== selectedDrawing.parameters.streamline) updateDrawing(selectedDrawing.id, { parameters: { streamline } }); }} /></label>
      <label>Color <input data-drawing-color type="color" value={typeof selectedDrawing.style['a3.ui.stroke.color'] === 'string' ? String(selectedDrawing.style['a3.ui.stroke.color']) : '#c3ed82'} disabled={!workspace?.canWrite}
        onChange={(event) => updateDrawing(selectedDrawing.id, { style: { 'a3.ui.stroke.color': event.target.value } })} /></label>
      <label>Apariencia <select data-drawing-rendering value={selectedDrawing.style['a3.ui.stroke.rendering'] === 'rough' ? 'rough' : 'clean'} disabled={!workspace?.canWrite}
        onChange={(event) => updateDrawing(selectedDrawing.id, { style: { 'a3.ui.stroke.rendering': event.target.value } })}>
        <option value="clean">Limpia</option><option value="rough">Boceto · Rough.js</option>
      </select></label>
      {selectedDrawing.style['a3.ui.stroke.rendering'] === 'rough' && <label>Intensidad de boceto <input data-drawing-roughness type="number" min="0.1" max="4" step="0.1"
        defaultValue={Number(selectedDrawing.style['a3.ui.stroke.roughness'] ?? 1.25)} disabled={!workspace?.canWrite}
        onBlur={(event) => { const roughness = Number(event.currentTarget.value); if (Number.isFinite(roughness) && roughness >= 0.1 && roughness <= 4 && roughness !== Number(selectedDrawing.style['a3.ui.stroke.roughness'] ?? 1.25)) updateDrawing(selectedDrawing.id, { style: { 'a3.ui.stroke.roughness': roughness } }); }} /></label>}
      <label><input type="checkbox" checked={selectedDrawing.parameters.simulatePressure} disabled={!workspace?.canWrite}
        onChange={(event) => updateDrawing(selectedDrawing.id, { parameters: { simulatePressure: event.target.checked } })} /> Simular presión</label>
    </div>}
    <p className="canvas-help">Seleccionar: clic, Shift/Ctrl+clic o rectángulo · Dibujar: clic y arrastrar (D) · Desplazar: botón central, Espacio+arrastrar o rueda · Flechas: mover selección; sin selección, desplazar vista · Tab/Enter: navegar y seleccionar · Supr: borrar trazos o líneas con permiso · Esc: cancelar. Cuadrícula: 20 · Snap: apagado.</p>
    {tool === 'text' && !selectedEdge && <p className="canvas-help">Selecciona una línea visual para editar su etiqueta. Las entidades conservan su contenido compartido.</p>}
    {error && <div className="error" role="alert" data-canvas-error>{error}{workspace?.canWrite && <div className="input-row">
      {errorKind === 'viewport' && <><button className="quiet" onClick={() => { failed.current = false; setError(null); setErrorKind(null); flush(); }}>Reintentar guardar vista</button>
        <button className="quiet" onClick={() => void discard()}>Descartar cambio de vista</button></>}
      {(errorKind === 'placement' || errorKind === 'drawing') && <button className="quiet" onClick={() => { void window.a3?.canvas({ action: 'load', sessionId, workspaceId }).then((result) => {
        if (result.ok) { installWorkspace(result.value, undefined, true); setError(null); setErrorKind(null); setStatus('Vista recargada'); }
      }); }}>Recargar workspace</button>}
    </div>}</div>}
    {dropNotice && <div className="canvas-drop-preview" role="dialog" aria-modal="true" aria-label="Vista previa de importación" data-canvas-drop-preview>
      <strong>{dropNotice.kind === 'folder' ? 'Elige qué hacer con esta carpeta' : 'Archivo externo · vista previa'}</strong>
      <p>{dropNotice.files?.length ?? 0} elemento(s) · {(dropNotice.files ?? []).reduce((size, item) => size + item.size, 0).toLocaleString('es')} bytes</p>
      <ul>{dropNotice.files?.slice(0, 20).map((file) => { const destination = dropMode === 'reference' ? file.referenceDestination : dropMode === 'copy' ? file.copyDestination : `${file.copyDestination} (copiar) · ${file.referenceDestination} (referenciar)`; return <li key={file.copyDestination}><code>{file.name}</code><small>{file.size.toLocaleString('es')} bytes → <code>{destination}</code></small></li>; })}</ul>
      <p>Acceso: A3 solicitará lectura de solo lectura para el origen. Conflicto: el destino usa un ID nuevo; el store valida que siga libre antes de escribir. Referenciar conserva los bytes originales; copiar crea recursos locales.</p>
      <div className="canvas-drop-actions" role="group" aria-label="Acción para el drop">
        <button type="button" data-drop-mode="copy" aria-pressed={dropMode === 'copy'} onClick={() => setDropMode('copy')}>Copiar</button>
        <button type="button" data-drop-mode="reference" aria-pressed={dropMode === 'reference'} onClick={() => setDropMode('reference')}>Referenciar</button>
        <button type="button" data-drop-mode="move" disabled title="El borrado externo por handle no está disponible en E1">Mover</button>
        <button type="button" className="secondary" data-drop-confirm disabled={!dropMode || !workspace?.canWrite} onClick={() => void commitDrop()}>{dropMode === 'reference' ? 'Crear referencias' : 'Copiar al proyecto'}</button>
        <button type="button" className="quiet" data-drop-cancel onClick={() => void cancelDrop()}>Cancelar</button>
      </div>
      <small>El movimiento permanece deshabilitado porque Windows no ofrece borrado seguro del origen por handle en el servicio E1.</small>
    </div>}
    <div ref={hostRef} className="canvas-host" tabIndex={0} role="region" aria-label="Lienzo del workspace" data-canvas-drop-target data-canvas-ready={!!workspace} data-canvas-mode={tool}
      data-viewport-x={viewport.x} data-viewport-y={viewport.y} data-viewport-zoom={viewport.zoom}
      onPointerDownCapture={beginStroke} onPointerMove={continueStroke} onPointerUpCapture={finishStroke} onPointerCancelCapture={cancelStroke}
      onPasteCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], .react-flow__node, .react-flow__edge')) return;
        event.preventDefault(); event.stopPropagation(); void smartPaste('smart');
      }}
      onKeyDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], summary')) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') {
          if (event.target instanceof Element && event.target.closest('.react-flow__node, .react-flow__edge')) return;
          event.preventDefault(); event.stopPropagation(); void smartPaste('smart'); return;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
          event.preventDefault(); event.stopPropagation(); changeHistory(event.shiftKey ? 'redo' : 'undo'); return;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'y') {
          event.preventDefault(); event.stopPropagation(); changeHistory('redo'); return;
        }
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); setTool('select');
          setNodes((previous) => previous.map((node) => node.selected ? { ...node, selected: false } : node));
          setEdges((previous) => previous.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
          setSelection({ nodeIds: [], groupIds: [], edgeIds: [], drawingIds: [] }); activeStroke.current = null; setStrokePreview(null); return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && tool === 'select') {
          event.preventDefault(); event.stopPropagation(); setNodes((previous) => previous.map((node) => ({ ...node, selected: true })));
          setEdges((previous) => previous.map((edge) => ({ ...edge, selected: true })));
          setSelection({ nodeIds: nodes.filter((node) => node.type === 'a3Entity').map((node) => node.id), groupIds: nodes.filter((node): node is CanvasGroupNode => node.type === 'a3Group').map((node) => node.data.group.id),
            edgeIds: edges.map((edge) => edge.id), drawingIds: workspace?.drawings.map((drawing) => drawing.id) ?? [] }); return;
        }
        if (!event.ctrlKey && !event.metaKey && ['v', 'c', 't', 'd'].includes(event.key.toLowerCase())) {
          event.preventDefault(); setTool(({ v: 'select', c: 'connect', t: 'text', d: 'draw' } as const)[event.key.toLowerCase() as 'v' | 'c' | 't' | 'd']); return;
        }
        if (event.key === 'Delete') {
          event.preventDefault(); event.stopPropagation();
          void (async () => {
            if (workspace?.canDeleteDrawings) for (const id of selection.drawingIds) await deleteDrawing(id);
            if (workspace?.canDeleteEdges) for (const edge of edges.filter((edge) => edge.selected)) await deleteVisualEdge(edge.id);
          })();
          return;
        }
        const delta: Record<string, { x: number; y: number }> = { ArrowLeft: { x: 40, y: 0 }, ArrowRight: { x: -40, y: 0 }, ArrowUp: { x: 0, y: 40 }, ArrowDown: { x: 0, y: -40 } };
        if (delta[event.key]) {
          event.preventDefault(); event.stopPropagation();
          if ((selection.nodeIds.length || selection.groupIds.length) && tool === 'select') {
            const step = event.shiftKey ? 20 : 1, movement = delta[event.key]!;
            const selected = new Set(nodes.filter((node): node is CanvasNode => node.type === 'a3Entity' && !!node.selected && !!node.draggable).map((node) => node.id));
            if (selected.size) void mutateCanvas((latest) => ({ action: 'move-placements', sessionId, workspaceId,
              placements: latest.placements.filter((placement) => selected.has(placement.id)).map((placement) => ({ id: placement.id, expectedRevision: placement.revision,
                position: { x: placement.position.x - movement.x / 40 * step, y: placement.position.y - movement.y / 40 * step } })) }));
            for (const groupId of selection.groupIds) void mutateCanvas((latest) => ({ action: 'move-group', sessionId, workspaceId, groupId,
              expectedRevision: latest.groups.find((group) => group.id === groupId)?.revision ?? 0,
              offset: { x: -movement.x / 40 * step, y: -movement.y / 40 * step } }), 'Grupo movido');
          } else if (!(event.target instanceof Element && event.target.closest('.react-flow__node'))) update(panViewport(current.current, delta[event.key]!), true);
        }
        else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); }
        else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); }
      }}>
      {workspace && <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} viewport={visual} defaultViewport={visual} minZoom={Math.min(MIN_ZOOM, viewport.zoom)} maxZoom={MAX_ZOOM}
        edgeTypes={edgeTypes} panOnDrag={[1]} panActivationKeyCode="Space" zoomOnScroll={false} zoomOnPinch={false} panOnScroll={false} zoomOnDoubleClick={false} zoomActivationKeyCode={null}
        selectionOnDrag={tool === 'select'} selectionKeyCode="Shift" multiSelectionKeyCode={['Shift', 'Control', 'Meta']} selectionMode={SelectionMode.Partial}
        snapToGrid={false} snapGrid={[GRID_SIZE, GRID_SIZE]} nodesDraggable={workspace.canWrite && tool === 'select'} nodesConnectable={workspace.canWrite && tool === 'connect'}
        elementsSelectable nodesFocusable edgesFocusable edgesReconnectable={workspace.canWrite && tool === 'connect'} deleteKeyCode={null}
        onlyRenderVisibleElements colorMode="dark" onMove={(event, next) => { if (event) update(fromVisualViewport(next, originRef.current)); }}
        onNodesChange={handleNodeChanges} onEdgesChange={(changes) => setEdges((previous) => applyEdgeChanges(changes.filter((change) => change.type !== 'remove'), previous))}
        onSelectionChange={handleSelectionChange} onNodeDragStop={(_, _node, moved) => moveNodes(moved)}
        onConnect={(connection) => createVisualEdge(connection.source, connection.target)}
        onReconnect={(edge, connection) => updateVisualEdge(edge.id, { sourcePlacementId: connection.source, targetPlacementId: connection.target })}
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Pulsa Enter para seleccionar. Usa Tab para navegar y flechas para mover la selección.',
          'edge.a11yDescription.default': 'Línea visual. Pulsa Enter para seleccionar y Supr para eliminar si tienes permiso.' }}
        onMoveEnd={(event) => { if (event) rebase(current.current); }}>
        <Background variant={BackgroundVariant.Lines} gap={GRID_SIZE} offset={gridOffset(origin)} color="#283532" />
        <ViewportPortal>
          <svg className="canvas-guides" width="1" height="1" aria-hidden="true">
            {Math.abs(viewport.x) < 20000 && <line x1={-origin.x} y1={topLeft.y - origin.y - 20000} x2={-origin.x} y2={topLeft.y - origin.y + 20000} />}
            {Math.abs(viewport.y) < 20000 && <line x1={topLeft.x - origin.x - 20000} y1={-origin.y} x2={topLeft.x - origin.x + 20000} y2={-origin.y} />}
          </svg>
          {showReference && referenceVisible && <svg className="canvas-reference" data-canvas-reference width="550" height="220" style={{ transform: `translate(${reference.x - origin.x}px, ${reference.y - origin.y}px)` }} aria-label="Geometría de prueba sin datos de proyecto">
            <rect x="0" y="0" width="170" height="72" rx="8" /><rect x="380" y="130" width="170" height="72" rx="8" />
            <text x="14" y="32">Referencia A</text><text x="394" y="162">Referencia B</text>
          </svg>}
          {canvasGroupLayout && <CanvasCollapsedEdges workspace={workspace} origin={origin} endpointMap={canvasGroupLayout.edgeEndpoints} layouts={canvasGroupLayout.layouts} />}
          <CanvasDrawingLayer drawings={visibleDrawings} origin={origin} tool={tool} selectedIds={selection.drawingIds} preview={strokePreview} onSelect={selectDrawing} />
        </ViewportPortal>
      </ReactFlow>}
    </div>
    <div className="canvas-status"><span data-canvas-status role="status">{status}</span><span data-canvas-node-count>{visiblePlacementCount} representaciones · Origen visible: {topLeft.x.toLocaleString('es', { maximumFractionDigits: 2 })}, {topLeft.y.toLocaleString('es', { maximumFractionDigits: 2 })}</span></div>
    {workspace && <CanvasEdgeEditor workspace={workspace} edge={selectedEdge} tool={tool} onCreate={createVisualEdge} onUpdate={updateVisualEdge} onDelete={(id) => void deleteVisualEdge(id)}
      onRequestDeletePermission={() => void mutateCanvas(() => ({ action: 'approve-edge-delete', sessionId, workspaceId }))} />}
    {showReference && <p className="canvas-help">La referencia es un fixture aislado y no se añade al proyecto.</p>}
  </>;
}
