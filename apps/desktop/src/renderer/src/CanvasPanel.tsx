import { useEffect, useRef, useState } from 'react';
import { Background, BackgroundVariant, ReactFlow, ViewportPortal, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { LocalCanvasWorkspace, LocalProjectSession } from '../../shared/desktop-api';
import { GRID_SIZE, MAX_ZOOM, MIN_ZOOM, fitContent, fromVisualViewport, gridOffset, panViewport, renderOrigin, screenToWorld, toVisualViewport, wheelViewport, worldToScreen, zoomAt, type WorldViewport } from '../../shared/world-viewport';

const nodes: Node[] = [];
const edges: Edge[] = [];
// Navigation reference only: no Entity, Placement, drawing or React Flow node is created.
const reference = { x: 120, y: 110, width: 550, height: 220 };
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
  const [viewport, setViewport] = useState<WorldViewport>({ x: 0, y: 0, zoom: 1 });
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const [showReference, setShowReference] = useState(false);
  const [status, setStatus] = useState('Abriendo…');
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const current = useRef(viewport);
  const originRef = useRef(origin);
  const revision = useRef(0);
  const writable = useRef(false);
  const changed = useRef(false);
  const tail = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const failed = useRef(false);

  function report(cause: unknown): void {
    failed.current = true;
    if (live.current) { setError(cause instanceof Error ? cause.message : 'No se pudo guardar la vista.'); setStatus('Vista sin guardar'); }
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
      if (live.current) { setWorkspace(result.value); setStatus(changed.current ? 'Vista pendiente' : 'Vista guardada'); }
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo transformar la vista.'); }
  }
  useEffect(() => {
    live.current = true;
    void window.a3?.canvas({ action: 'load', sessionId, workspaceId }).then((result) => {
      if (!live.current) return;
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      const loaded = result.value; renderOrigin(loaded.viewport);
      current.current = loaded.viewport; revision.current = loaded.revision; writable.current = loaded.canWrite;
      changed.current = loaded.pending;
      setWorkspace(loaded); setViewport(loaded.viewport); rebase(loaded.viewport); setStatus(!loaded.canWrite ? 'Vista temporal · solo lectura' : loaded.pending ? 'Vista pendiente' : 'Vista guardada');
    }).catch(report);
    return () => { flush(); live.current = false; clearTimeout(timer.current); };
  }, [sessionId, workspaceId]);
  useEffect(() => {
    const host = hostRef.current; if (!host || !workspace) return;
    const wheel = (event: WheelEvent): void => {
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
      current.current = result.value.viewport; setViewport(result.value.viewport); rebase(result.value.viewport); setStatus('Vista guardada'); }
    else if (result && !result.ok) report(new Error(`${result.error.code}: ${result.error.message}`));
  }
  const visual = toVisualViewport(viewport, origin);
  const topLeft = screenToWorld({ x: 0, y: 0 }, viewport);
  const referenceScreen = worldToScreen(reference, viewport);
  const referenceVisible = referenceScreen.x + reference.width * viewport.zoom >= -20000 && referenceScreen.y + reference.height * viewport.zoom >= -20000 && referenceScreen.x <= 20000 && referenceScreen.y <= 20000;
  return <>
    <div className="canvas-toolbar" aria-label="Navegación del lienzo">
      <button className="secondary" data-canvas-zoom-out disabled={!workspace || viewport.zoom <= MIN_ZOOM} onClick={() => zoom(1 / 1.2)} aria-label="Alejar">−</button>
      <output data-canvas-zoom aria-label="Escala del lienzo">{(viewport.zoom * 100).toLocaleString('es', { maximumFractionDigits: 1 })} %</output>
      <button className="secondary" data-canvas-zoom-in disabled={!workspace || viewport.zoom >= MAX_ZOOM} onClick={() => zoom(1.2)} aria-label="Acercar">+</button>
      <button className="secondary" data-canvas-fit disabled={!workspace || !showReference} onClick={() => { const rect = hostRef.current?.getBoundingClientRect(); if (rect) update(fitContent(reference, rect), true); }}>Ajustar contenido</button>
      <button className="quiet" data-canvas-save disabled={!workspace?.canWrite || status === 'Vista guardada' || status === 'Guardando vista…'} onClick={() => { failed.current = false; setError(null); flush(); }}>Guardar vista</button>
      <label className="canvas-fixture"><input type="checkbox" data-canvas-fixture checked={showReference} onChange={(event) => setShowReference(event.target.checked)} />Referencia de prueba</label>
    </div>
    <p className="canvas-help">Arrastra o usa rueda/dos dedos para desplazar · Ctrl+rueda o pellizco para zoom · Flechas para desplazar. Cuadrícula: 20 · Snap: apagado · Guías: activadas.</p>
    {error && <div className="error" role="alert" data-canvas-error>{error}{workspace?.canWrite && <div className="input-row">
      <button className="quiet" onClick={() => { failed.current = false; setError(null); flush(); }}>Reintentar guardado</button>
      <button className="quiet" onClick={() => void discard()}>Descartar cambio de vista</button>
    </div>}</div>}
    <div ref={hostRef} className="canvas-host" tabIndex={0} role="region" aria-label="Lienzo del workspace" data-canvas-ready={!!workspace}
      data-viewport-x={viewport.x} data-viewport-y={viewport.y} data-viewport-zoom={viewport.zoom} onKeyDown={(event) => {
        const delta: Record<string, { x: number; y: number }> = { ArrowLeft: { x: 40, y: 0 }, ArrowRight: { x: -40, y: 0 }, ArrowUp: { x: 0, y: 40 }, ArrowDown: { x: 0, y: -40 } };
        if (delta[event.key]) { event.preventDefault(); update(panViewport(current.current, delta[event.key]!), true); }
        else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); }
        else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); }
      }}>
      {workspace && <ReactFlow nodes={nodes} edges={edges} viewport={visual} defaultViewport={visual} minZoom={Math.min(MIN_ZOOM, viewport.zoom)} maxZoom={MAX_ZOOM}
        panOnDrag={[0, 1]} zoomOnScroll={false} zoomOnPinch={false} panOnScroll={false} zoomOnDoubleClick={false} zoomActivationKeyCode={null}
        snapToGrid={false} snapGrid={[GRID_SIZE, GRID_SIZE]} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null}
        onlyRenderVisibleElements colorMode="dark" onMove={(event, next) => { if (event) update(fromVisualViewport(next, originRef.current)); }}
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
    <div className="canvas-status"><span data-canvas-status role="status">{status}</span><span>Origen visible: {topLeft.x.toLocaleString('es', { maximumFractionDigits: 2 })}, {topLeft.y.toLocaleString('es', { maximumFractionDigits: 2 })}</span></div>
    {showReference && <p className="canvas-help">La referencia es un fixture aislado y no se añade al proyecto.</p>}
  </>;
}
