import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { applyEdgeChanges, applyNodeChanges, Background, BackgroundVariant, Handle, NodeResizer, Position, ReactFlow, SelectionMode, ViewportPortal, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CanvasEntitySummary, CanvasPlacementView, CanvasRequest, CanvasVisualEdgePatch, LocalCanvasWorkspace, LocalProjectSession } from '../../shared/desktop-api';
import { CanvasEdgeEditor, edgeTypes, toFlowEdges, type CanvasEdge, type CanvasTool } from './CanvasVisualEdges';
import { GRID_SIZE, MAX_ZOOM, MIN_ZOOM, fitContent, fromVisualViewport, gridOffset, panViewport, renderOrigin, screenToWorld, toVisualViewport, wheelViewport, worldToScreen, zoomAt, type WorldViewport } from '../../shared/world-viewport';

// Navigation reference only: no Entity, Placement, drawing or React Flow node is created.
const reference = { x: 120, y: 110, width: 550, height: 220 };
type CanvasNodeData = {
  sessionId: string; workspaceId: string; entity: CanvasEntitySummary; placement: CanvasPlacementView; canWrite: boolean; tool: CanvasTool;
  onResizeEnd: (id: string, position: { x: number; y: number }, size: { width: number; height: number }) => void;
};
type CanvasNode = Node<CanvasNodeData, 'a3Entity'>;
const nodeTypes = { a3Entity: memo(function CanvasEntityNode({ data, selected }: NodeProps<CanvasNode>) {
  const [preview, setPreview] = useState<{ text: string | null; state: 'ready' | 'too-large' | 'unavailable' | 'binary' } | null>(null);
  useEffect(() => {
    let mounted = true;
    setPreview(null);
    if (data.entity.contentResourceId) void window.a3?.canvas({ action: 'content', sessionId: data.sessionId, workspaceId: data.workspaceId,
      entityId: data.entity.id, resourceId: data.entity.contentResourceId }).then((result) => {
      if (mounted && result.ok) setPreview({ text: result.value.text, state: result.value.state });
      else if (mounted && result && !result.ok) setPreview({ text: null, state: 'unavailable' });
    }).catch(() => { if (mounted) setPreview({ text: null, state: 'unavailable' }); });
    return () => { mounted = false; };
  }, [data.sessionId, data.workspaceId, data.entity.id, data.entity.contentResourceId, data.entity.revision]);
  const accent = data.placement.style['a3.ui.accent'];
  const borderColor = typeof accent === 'string' && /^#[\da-f]{6}$/i.test(accent) ? accent : undefined;
  const properties = Object.keys(data.entity.properties).length > 0 ? JSON.stringify(data.entity.properties, null, 2) : '';
  return <article className="canvas-entity-node" data-placement-id={data.placement.id} data-entity-id={data.entity.id}
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
      {data.entity.contentResourceId && <details><summary>Contenido</summary>
        {preview?.text ? <pre className="canvas-content-preview">{preview.text.slice(0, 1200)}</pre> : <p className="canvas-content-state">
          {preview?.state === 'too-large' ? 'Contenido extenso · abrir desde Archivos' : preview?.state === 'binary' ? 'Recurso binario' : preview?.state === 'unavailable' ? 'Recurso no disponible' : 'Cargando vista previa…'}</p>}
      </details>}
      {Object.keys(data.placement.style).length > 0 && <details><summary>Estilo de esta vista</summary><pre>{JSON.stringify(data.placement.style, null, 2)}</pre></details>}
    </div>
  </article>;
}) };

function toFlowNodes(workspace: LocalCanvasWorkspace, origin: { x: number; y: number }, onResizeEnd: CanvasNodeData['onResizeEnd'], tool: CanvasTool, previous: CanvasNode[] = [], force = false): CanvasNode[] {
  const entities = new Map(workspace.entities.map((entity) => [entity.id.toLowerCase(), entity]));
  const old = new Map(previous.map((node) => [node.id, node]));
  return workspace.placements.flatMap((placement) => {
    const entity = entities.get(placement.entityId.toLowerCase());
    if (!entity) return [];
    const existing = old.get(placement.id);
    if (!force && existing && existing.data.placement.revision === placement.revision && existing.data.entity.revision === entity.revision &&
        existing.data.canWrite === workspace.canWrite && existing.data.tool === tool) return [existing];
    return [{ id: placement.id, type: 'a3Entity', position: { x: placement.position.x - origin.x, y: placement.position.y - origin.y },
      style: { width: placement.size.width, height: placement.size.height }, draggable: workspace.canWrite && tool === 'select' && placement.style['a3.ui.locked'] !== true,
      dragHandle: '.canvas-entity-header', selectable: true, focusable: true, selected: existing?.selected,
      ariaLabel: `${entity.title || entity.type}${placement.style['a3.ui.locked'] === true ? ', bloqueado' : ''}`,
      data: { sessionId: workspace.sessionId, workspaceId: workspace.workspaceId, entity, placement, canWrite: workspace.canWrite, tool, onResizeEnd } }];
  });
}
export function CanvasPanel({ active }: { active: LocalProjectSession | null | undefined }): React.JSX.Element {
  const [selected, setSelected] = useState('');
  const workspaceId = active?.workspaces.some((workspace) => workspace.id === selected) ? selected : active?.workspaces[0]?.id;
  if (!active || !workspaceId) return <section className="canvas-panel"><h1>Lienzo</h1><p>Abre un proyecto con un workspace disponible para empezar.</p></section>;
  return <section className="canvas-panel">
    <div className="canvas-heading"><h1>Lienzo</h1><label>Workspace <select aria-label="Workspace del lienzo" value={workspaceId} onChange={(event) => setSelected(event.target.value)}>
      {active.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    </select></label></div>
    <CanvasWorkspace key={`${active.sessionId}:${workspaceId}`} sessionId={active.sessionId} workspaceId={workspaceId} />
  </section>;
}

function CanvasWorkspace({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<LocalCanvasWorkspace | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [tool, setTool] = useState<CanvasTool>('select');
  const toolRef = useRef(tool); toolRef.current = tool;
  const [selection, setSelection] = useState<{ nodeIds: string[]; edgeIds: string[] }>({ nodeIds: [], edgeIds: [] });
  const [selectedEntityId, setSelectedEntityId] = useState('');
  const [viewport, setViewport] = useState<WorldViewport>({ x: 0, y: 0, zoom: 1 });
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const [showReference, setShowReference] = useState(false);
  const [status, setStatus] = useState('Abriendo…');
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'viewport' | 'placement' | null>(null);
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

  function installWorkspace(next: LocalCanvasWorkspace, _changedPlacementId?: string, force = false): void {
    workspaceRef.current = next;
    setWorkspace(next);
    revision.current = next.revision; writable.current = next.canWrite;
    placementRevisions.current = new Map(next.placements.map((placement) => [placement.id, placement.revision]));
    setNodes((previous) => toFlowNodes(next, originRef.current, handleResizeEnd, toolRef.current, previous, force));
    setEdges((previous) => toFlowEdges(next, originRef.current, toolRef.current, previous));
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

  const handleNodeChanges = useCallback((changes: NodeChange<CanvasNode>[]): void => {
    setNodes((currentNodes) => applyNodeChanges(changes.filter((change) => change.type !== 'remove'), currentNodes) as CanvasNode[]);
  }, []);
  const handleSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: { nodes: CanvasNode[]; edges: CanvasEdge[] }): void => {
    const nodeIds = selectedNodes.map((node) => node.id), edgeIds = selectedEdges.map((edge) => edge.id);
    setSelection((previous) => previous.nodeIds.join() === nodeIds.join() && previous.edgeIds.join() === edgeIds.join() ? previous : { nodeIds, edgeIds });
  }, []);
  useEffect(() => {
    if (tool === 'text') hostRef.current?.parentElement?.querySelector<HTMLInputElement>('[data-edge-label]')?.focus();
  }, [tool, selection.edgeIds[0]]);

  useEffect(() => {
    const latest = workspaceRef.current;
    if (latest) {
      setNodes((previous) => toFlowNodes(latest, origin, handleResizeEnd, tool, previous, true));
      setEdges((previous) => toFlowEdges(latest, origin, tool, previous));
    }
  }, [origin.x, origin.y, handleResizeEnd, tool]);
  useEffect(() => {
    if (workspace && !workspace.entityChoices.some((entity) => entity.id === selectedEntityId)) setSelectedEntityId(workspace.entityChoices[0]?.id ?? '');
  }, [workspace?.entityChoices, selectedEntityId]);

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
  function mutateCanvas(request: (latest: LocalCanvasWorkspace) => CanvasRequest): Promise<boolean> {
    const operation = mutationTail.current.then(async () => {
      const latest = workspaceRef.current; if (!latest || !window.a3) return false;
      try {
        const result = await window.a3.canvas(request(latest));
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        workspaceRef.current = result.value;
        if (live.current) { installWorkspace(result.value); setError(null); setErrorKind(null); setStatus('Organización guardada'); }
        return true;
      } catch (cause) {
        if (!live.current) return false;
        setErrorKind('placement'); setError(cause instanceof Error ? cause.message : 'No se pudo guardar la organización.'); setStatus('Cambio sin guardar');
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
  function createVisualEdge(sourcePlacementId: string, targetPlacementId: string): void {
    const before = new Set(workspaceRef.current?.visualEdges.map((edge) => edge.id));
    void mutateCanvas((latest) => ({ action: 'create-visual-edge', sessionId, workspaceId, expectedWorkspaceRevision: latest.revision, sourcePlacementId, targetPlacementId })).then((ok) => {
      if (!ok || !live.current) return;
      setNodes((previous) => previous.map((node) => node.selected ? { ...node, selected: false } : node));
      setEdges((previous) => previous.map((edge) => ({ ...edge, selected: !before.has(edge.id) })));
    });
  }
  function updateVisualEdge(edgeId: string, patch: CanvasVisualEdgePatch): void {
    void mutateCanvas((latest) => ({ action: 'update-visual-edge', sessionId, workspaceId, edgeId,
      expectedRevision: latest.visualEdges.find((edge) => edge.id === edgeId)?.revision ?? 0, patch }));
  }
  function deleteVisualEdge(edgeId: string): Promise<boolean> {
    return mutateCanvas((latest) => ({ action: 'delete-visual-edge', sessionId, workspaceId, edgeId,
      expectedRevision: latest.visualEdges.find((edge) => edge.id === edgeId)?.revision ?? 0 }));
  }
  function moveNodes(moved: CanvasNode[]): void {
    const origin = originRef.current;
    const positions = moved.filter((node) => node.draggable).map((node) => ({ id: node.id, position: { x: node.position.x + origin.x, y: node.position.y + origin.y } }));
    if (!positions.length) return;
    void mutateCanvas((latest) => ({ action: 'move-placements', sessionId, workspaceId, placements: positions.map((item) => ({ ...item,
      expectedRevision: latest.placements.find((placement) => placement.id === item.id)?.revision ?? 0 })) }));
  }
  const selectedPlacement = selection.nodeIds.length === 1 ? workspace?.placements.find((item) => item.id === selection.nodeIds[0]) : undefined;
  const selectedEdge = selection.edgeIds.length === 1 && selection.nodeIds.length === 0 ? workspace?.visualEdges.find((item) => item.id === selection.edgeIds[0]) : undefined;
  const visual = toVisualViewport(viewport, origin);
  const topLeft = screenToWorld({ x: 0, y: 0 }, viewport);
  const referenceScreen = worldToScreen(reference, viewport);
  const referenceVisible = referenceScreen.x + reference.width * viewport.zoom >= -20000 && referenceScreen.y + reference.height * viewport.zoom >= -20000 && referenceScreen.x <= 20000 && referenceScreen.y <= 20000;
  return <>
    <div className="canvas-tools" role="toolbar" aria-label="Herramienta del lienzo">
      <button data-canvas-tool="select" aria-pressed={tool === 'select'} onClick={() => setTool('select')}>Seleccionar (V)</button>
      <button data-canvas-tool="connect" aria-pressed={tool === 'connect'} onClick={() => setTool('connect')}>Dibujar conexión (C)</button>
      <button data-canvas-tool="text" aria-pressed={tool === 'text'} onClick={() => setTool('text')}>Editar etiqueta (T)</button>
      <span data-canvas-selection role="status">{selection.nodeIds.length} nodos y {selection.edgeIds.length} líneas seleccionados</span>
    </div>
    <div className="canvas-toolbar" aria-label="Navegación del lienzo">
      <button className="secondary" data-canvas-zoom-out disabled={!workspace || viewport.zoom <= MIN_ZOOM} onClick={() => zoom(1 / 1.2)} aria-label="Alejar">−</button>
      <output data-canvas-zoom aria-label="Escala del lienzo">{(viewport.zoom * 100).toLocaleString('es', { maximumFractionDigits: 1 })} %</output>
      <button className="secondary" data-canvas-zoom-in disabled={!workspace || viewport.zoom >= MAX_ZOOM} onClick={() => zoom(1.2)} aria-label="Acercar">+</button>
      <button className="secondary" data-canvas-fit disabled={!workspace || !showReference} onClick={() => { const rect = hostRef.current?.getBoundingClientRect(); if (rect) update(fitContent(reference, rect), true); }}>Ajustar contenido</button>
      <button className="quiet" data-canvas-save disabled={!workspace?.canWrite || status === 'Vista guardada' || status === 'Guardando vista…'} onClick={() => { failed.current = false; setError(null); flush(); }}>Guardar vista</button>
      <label>Entidad <select aria-label="Entidad para nueva representación" data-canvas-entity value={selectedEntityId || workspace?.entityChoices[0]?.id || ''} disabled={!workspace?.canWrite || !workspace.entityChoices.length}
        onChange={(event) => setSelectedEntityId(event.target.value)}>{workspace?.entityChoices.map((entity) => <option key={entity.id} value={entity.id}>{entity.title} · {entity.type}</option>)}</select></label>
      <button className="secondary" data-canvas-create-placement disabled={!workspace?.canWrite || !workspace.entityChoices.length} onClick={() => void createPlacement()}>Crear representación</button>
      <label className="canvas-fixture"><input type="checkbox" data-canvas-fixture checked={showReference} onChange={(event) => setShowReference(event.target.checked)} />Referencia de prueba</label>
    </div>
    <div className="canvas-selection-properties" aria-label="Propiedades de la selección">
      {selectedPlacement && <label>Color de vista <select aria-label="Color de esta representación" data-canvas-style value={['#9bc279', '#78a9d1', '#d19b78', '#bb91d3'].includes(String(selectedPlacement.style['a3.ui.accent'])) ? String(selectedPlacement.style['a3.ui.accent']) : '#9bc279'}
        disabled={!workspace?.canWrite} onChange={(event) => void persistPlacement(selectedPlacement.id, { style: { 'a3.ui.accent': event.target.value } })}>
        <option value="#9bc279">Verde</option><option value="#78a9d1">Azul</option><option value="#d19b78">Naranja</option><option value="#bb91d3">Violeta</option>
      </select></label>}
      {selectedPlacement && <button className="quiet" data-canvas-lock disabled={!workspace?.canWrite} aria-pressed={selectedPlacement.style['a3.ui.locked'] === true}
        onClick={() => void persistPlacement(selectedPlacement.id, { style: { 'a3.ui.locked': selectedPlacement.style['a3.ui.locked'] !== true } })}>
        {selectedPlacement.style['a3.ui.locked'] === true ? 'Desbloquear nodo' : 'Bloquear nodo'}</button>}
    </div>
    <p className="canvas-help">Seleccionar: clic, Shift/Ctrl+clic o rectángulo · Desplazar: botón central, Espacio+arrastrar o rueda · Flechas: mover selección; sin selección, desplazar vista · Tab/Enter: navegar y seleccionar · Supr: quitar líneas · Esc: cancelar. Cuadrícula: 20 · Snap: apagado.</p>
    {tool === 'text' && !selectedEdge && <p className="canvas-help">Selecciona una línea visual para editar su etiqueta. Las entidades conservan su contenido compartido.</p>}
    {error && <div className="error" role="alert" data-canvas-error>{error}{workspace?.canWrite && <div className="input-row">
      {errorKind === 'viewport' && <><button className="quiet" onClick={() => { failed.current = false; setError(null); setErrorKind(null); flush(); }}>Reintentar guardar vista</button>
        <button className="quiet" onClick={() => void discard()}>Descartar cambio de vista</button></>}
      {errorKind === 'placement' && <button className="quiet" onClick={() => { void window.a3?.canvas({ action: 'load', sessionId, workspaceId }).then((result) => {
        if (result.ok) { installWorkspace(result.value, undefined, true); setError(null); setErrorKind(null); setStatus('Vista recargada'); }
      }); }}>Recargar workspace</button>}
    </div>}</div>}
    <div ref={hostRef} className="canvas-host" tabIndex={0} role="region" aria-label="Lienzo del workspace" data-canvas-ready={!!workspace} data-canvas-mode={tool}
      data-viewport-x={viewport.x} data-viewport-y={viewport.y} data-viewport-zoom={viewport.zoom} onKeyDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], summary')) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); setTool('select');
          setNodes((previous) => previous.map((node) => node.selected ? { ...node, selected: false } : node));
          setEdges((previous) => previous.map((edge) => edge.selected ? { ...edge, selected: false } : edge)); return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && tool === 'select') {
          event.preventDefault(); event.stopPropagation(); setNodes((previous) => previous.map((node) => ({ ...node, selected: true })));
          setEdges((previous) => previous.map((edge) => ({ ...edge, selected: true }))); return;
        }
        if (!event.ctrlKey && !event.metaKey && ['v', 'c', 't'].includes(event.key.toLowerCase())) {
          event.preventDefault(); setTool(({ v: 'select', c: 'connect', t: 'text' } as const)[event.key.toLowerCase() as 'v' | 'c' | 't']); return;
        }
        if (event.key === 'Delete') {
          event.preventDefault(); event.stopPropagation();
          if (workspace?.canDeleteEdges) void (async () => { for (const edge of edges.filter((edge) => edge.selected)) await deleteVisualEdge(edge.id); })();
          return;
        }
        const delta: Record<string, { x: number; y: number }> = { ArrowLeft: { x: 40, y: 0 }, ArrowRight: { x: -40, y: 0 }, ArrowUp: { x: 0, y: 40 }, ArrowDown: { x: 0, y: -40 } };
        if (delta[event.key]) {
          event.preventDefault(); event.stopPropagation();
          if (selection.nodeIds.length && tool === 'select') {
            const step = event.shiftKey ? 20 : 1, movement = delta[event.key]!;
            const selected = new Set(nodes.filter((node) => node.selected && node.draggable).map((node) => node.id));
            if (selected.size) void mutateCanvas((latest) => ({ action: 'move-placements', sessionId, workspaceId,
              placements: latest.placements.filter((placement) => selected.has(placement.id)).map((placement) => ({ id: placement.id, expectedRevision: placement.revision,
                position: { x: placement.position.x - movement.x / 40 * step, y: placement.position.y - movement.y / 40 * step } })) }));
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
        </ViewportPortal>
      </ReactFlow>}
    </div>
    <div className="canvas-status"><span data-canvas-status role="status">{status}</span><span data-canvas-node-count>{nodes.length} representaciones · Origen visible: {topLeft.x.toLocaleString('es', { maximumFractionDigits: 2 })}, {topLeft.y.toLocaleString('es', { maximumFractionDigits: 2 })}</span></div>
    {workspace && <CanvasEdgeEditor workspace={workspace} edge={selectedEdge} tool={tool} onCreate={createVisualEdge} onUpdate={updateVisualEdge} onDelete={(id) => void deleteVisualEdge(id)}
      onRequestDeletePermission={() => void mutateCanvas(() => ({ action: 'approve-edge-delete', sessionId, workspaceId }))} />}
    {showReference && <p className="canvas-help">La referencia es un fixture aislado y no se añade al proyecto.</p>}
  </>;
}
