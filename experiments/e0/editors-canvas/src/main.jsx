import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/classic.css';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import {
  addEdge,
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ViewportPortal
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getStroke } from 'perfect-freehand';
import markdownFixture from '../fixtures/markdown.md?raw';
import canvasFixture from '../fixtures/canvas.json';
import { buildSvg, rasterizeSvg } from './export.mjs';
import './style.css';

const CANVAS_STORAGE_KEY = 'a3-e0-d1-canvas-fixture';
const UNKNOWN_BLOCK = ':::bloque-desconocido';

function round(value) {
  return Number(value.toFixed(2));
}

function makeStrokePath(points) {
  if (!points?.length) return '';
  const outline = getStroke(points.map(({ x, y, pressure = 0.5 }) => [x, y, pressure]), {
    size: 8,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: false
  });
  if (!outline.length) return '';
  return `M ${outline.map(([x, y]) => `${round(x)} ${round(y)}`).join(' L ')} Z`;
}

function ProbeNode({ data }) {
  return (
    <div className="probe-node" style={{ width: data.width, height: data.height }}>
      <Handle type="target" position={Position.Left} aria-label={`target-${data.label}`} />
      <span>{data.label}</span>
      <Handle type="source" position={Position.Right} aria-label={`source-${data.label}`} />
    </div>
  );
}

const nodeTypes = { probe: ProbeNode };

function StrokeLayer({ drawings, preview }) {
  return (
    <ViewportPortal>
      <svg className="stroke-world" width="10000" height="10000" aria-hidden="true">
        {drawings.map((drawing) => (
          <path key={drawing.id} d={makeStrokePath(drawing.points)} fill={drawing.color} className="world-stroke" />
        ))}
        {preview?.length > 1 && <path d={makeStrokePath(preview)} fill="#f97316" className="world-stroke preview-stroke" />}
      </svg>
    </ViewportPortal>
  );
}

function MarkdownEditors() {
  const milkdownRootRef = useRef(null);
  const codeMirrorRootRef = useRef(null);
  const milkdownRef = useRef(null);
  const codeMirrorRef = useRef(null);
  const [milkdownStatus, setMilkdownStatus] = useState('inicializando');
  const [codeMirrorStatus, setCodeMirrorStatus] = useState('inicializando');
  const [milkdownOutput, setMilkdownOutput] = useState('');

  useEffect(() => {
    let disposed = false;
    const editor = new Crepe({ root: milkdownRootRef.current, defaultValue: markdownFixture });
    milkdownRef.current = editor;
    editor.create().then(() => {
      if (!disposed) setMilkdownStatus('listo');
    }).catch((error) => {
      if (!disposed) setMilkdownStatus(`error: ${error.message}`);
    });

    const view = new EditorView({
      doc: markdownFixture,
      extensions: [basicSetup, markdown()],
      parent: codeMirrorRootRef.current
    });
    codeMirrorRef.current = view;
    setCodeMirrorStatus('listo');

    return () => {
      disposed = true;
      view.destroy();
      editor.destroy();
    };
  }, []);

  function saveMilkdownWithoutChanges() {
    if (!milkdownRef.current || milkdownStatus !== 'listo') return;
    const value = milkdownRef.current.getMarkdown();
    const checks = {
      exactBytes: value === markdownFixture,
      wikilinkTextRetained: value.includes('[[entidad-a3|Entidad vinculada]]'),
      fencedCodeRetained: value.includes("export const marcador = 'código que debe seguir intacto';"),
      unknownBlockTextRetained: value.includes(UNKNOWN_BLOCK) && value.includes('"namespace":"vendor.demo"')
    };
    setMilkdownOutput(value);
    setMilkdownStatus(`guardado sin cambio: bytes ${checks.exactBytes ? 'exactos' : 'normalizados'}; wikilink ${checks.wikilinkTextRetained ? 'presente' : 'perdido'}; código ${checks.fencedCodeRetained ? 'presente' : 'perdido'}; texto del bloque desconocido ${checks.unknownBlockTextRetained ? 'presente (estructura no preservada)' : 'alterado/perdido'}`);
  }

  function saveCodeMirrorWithoutChanges() {
    if (!codeMirrorRef.current) return;
    const value = codeMirrorRef.current.state.doc.toString();
    const checks = {
      exactBytes: value === markdownFixture,
      wikilinkTextRetained: value.includes('[[entidad-a3|Entidad vinculada]]'),
      fencedCodeRetained: value.includes("export const marcador = 'código que debe seguir intacto';"),
      unknownBlockTextRetained: value.includes(UNKNOWN_BLOCK) && value.includes('"namespace":"vendor.demo"')
    };
    setCodeMirrorStatus(`guardado sin cambio: bytes ${checks.exactBytes ? 'exactos' : 'distintos'}; wikilink ${checks.wikilinkTextRetained ? 'presente' : 'perdido'}; código ${checks.fencedCodeRetained ? 'presente' : 'perdido'}; texto del bloque desconocido ${checks.exactBytes ? 'intacto en la fuente' : (checks.unknownBlockTextRetained ? 'texto presente, estructura desconocida' : 'alterado/perdido')}`);
  }

  return (
    <section className="panel editor-panel">
      <div className="section-heading">
        <div><p className="eyebrow">12.1 / 12.3</p><h2>Markdown visual y fuente</h2></div>
        <span className="fixture-label">mismos bytes sintéticos</span>
      </div>
      <div className="editor-grid">
        <div className="editor-card">
          <div className="editor-title"><strong>Milkdown / Crepe</strong><button onClick={saveMilkdownWithoutChanges}>Guardar sin cambio</button></div>
          <div ref={milkdownRootRef} className="milkdown-root" />
          <p className="editor-status" data-testid="milkdown-status">{milkdownStatus}</p>
          {milkdownOutput && <details><summary>Markdown serializado</summary><pre>{milkdownOutput}</pre></details>}
        </div>
        <div className="editor-card">
          <div className="editor-title"><strong>CodeMirror 6</strong><button onClick={saveCodeMirrorWithoutChanges}>Guardar sin cambio</button></div>
          <div ref={codeMirrorRootRef} className="codemirror-root" />
          <p className="editor-status" data-testid="codemirror-status">{codeMirrorStatus}</p>
          <p className="small-note">CodeMirror mantiene una secuencia de texto; no aporta por sí solo wikilinks A3 ni edición visual estructurada.</p>
        </div>
      </div>
      <p className="small-note">El botón lee la serialización actual, pero no escribe el fixture del repositorio. Esta prueba no sincroniza dos copias editables.</p>
    </section>
  );
}

function CanvasWorkbench() {
  const flowHostRef = useRef(null);
  const inProgressRef = useRef(null);
  const reactFlow = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState(canvasFixture.nodes.map((node) => ({ ...node, type: 'probe', draggable: true })));
  const [edges, setEdges, onEdgesChange] = useEdgesState(canvasFixture.edges);
  const [drawings, setDrawings] = useState(canvasFixture.drawings);
  const [preview, setPreview] = useState(null);
  const [mode, setMode] = useState('select');
  const [canvasStatus, setCanvasStatus] = useState('fixture abierto; conecta los nodos, dibuja y guarda');
  const [zoom, setZoom] = useState(canvasFixture.viewport.zoom);
  const [exportSvgUrl, setExportSvgUrl] = useState('');
  const [exportPngUrl, setExportPngUrl] = useState('');
  const [exportStatus, setExportStatus] = useState('');
  const lastExportSvgRef = useRef('');

  const savedCanvas = useMemo(() => `${nodes.length} nodos · ${edges.length} aristas · ${drawings.length} dibujos · zoom ${zoom.toFixed(2)}`, [nodes.length, edges.length, drawings.length, zoom]);

  function handleConnect(connection) {
    setEdges((current) => addEdge({ ...connection, id: `visual-${Date.now()}`, type: 'smoothstep', label: 'visual' }, current));
  }

  function onPointerDownCapture(event) {
    if (mode !== 'draw' || !flowHostRef.current) return;
    if (event.target.closest('.react-flow__node, .react-flow__handle, button')) return;
    event.preventDefault();
    event.stopPropagation();
    const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    inProgressRef.current = [{ x: point.x, y: point.y, pressure: event.pressure || 0.5 }];
    setPreview(inProgressRef.current);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture can be absent in a test host */ }
  }

  function onPointerMoveCapture(event) {
    if (!inProgressRef.current) return;
    const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const previous = inProgressRef.current.at(-1);
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 1) return;
    inProgressRef.current = [...inProgressRef.current, { x: point.x, y: point.y, pressure: event.pressure || 0.5 }];
    setPreview(inProgressRef.current);
  }

  function onPointerUpCapture() {
    if (!inProgressRef.current) return;
    if (inProgressRef.current.length > 1) {
      const drawing = {
        id: `drawing-${drawings.length + 1}`,
        color: '#f97316',
        size: 8,
        points: inProgressRef.current.map(({ x, y, pressure }) => ({ x: round(x), y: round(y), pressure: round(pressure) }))
      };
      setDrawings((current) => [...current, drawing]);
      setCanvasStatus(`dibujo creado en coordenadas de flujo: ${drawing.points.length} puntos`);
    }
    inProgressRef.current = null;
    setPreview(null);
  }

  function snapshot() {
    const current = reactFlow.toObject();
    const savedNodes = current.nodes.map(({ id, type, position, data }) => ({ id, type, position, data }));
    const savedEdges = current.edges.map(({ id, source, target, sourceHandle, targetHandle, type, label }) => ({ id, source, target, sourceHandle, targetHandle, type, label }));
    return { fixtureVersion: canvasFixture.fixtureVersion, nodes: savedNodes, edges: savedEdges, viewport: current.viewport, drawings };
  }

  function saveFixture() {
    const value = snapshot();
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(value));
    setCanvasStatus(`fixture local guardado · ${value.nodes.length} nodos · ${value.edges.length} aristas · ${value.drawings.length} dibujos`);
  }

  async function reopenFixture() {
    const raw = localStorage.getItem(CANVAS_STORAGE_KEY);
    if (!raw) {
      setCanvasStatus('no hay fixture guardado; primero usa Guardar fixture');
      return;
    }
    const value = JSON.parse(raw);
    const worldPointsBefore = JSON.stringify(drawings);
    const firstPoint = value.drawings[0]?.points[0];
    const screenBefore = firstPoint ? reactFlow.flowToScreenPosition(firstPoint) : null;
    setNodes(value.nodes.map((node) => ({ ...node, draggable: true })));
    setEdges(value.edges);
    setDrawings(value.drawings);
    await reactFlow.setViewport(value.viewport);
    const screenAfter = firstPoint ? reactFlow.flowToScreenPosition(firstPoint) : null;
    const sameWorldPoints = worldPointsBefore === JSON.stringify(value.drawings);
    const screenDelta = screenBefore && screenAfter
      ? Math.hypot(screenAfter.x - screenBefore.x, screenAfter.y - screenBefore.y)
      : 0;
    setCanvasStatus(`fixture reabierto · puntos mundo iguales ${sameWorldPoints ? 'sí' : 'no'} · desplazamiento de pantalla ${screenDelta.toFixed(3)} px`);
  }

  function resetFixture() {
    localStorage.removeItem(CANVAS_STORAGE_KEY);
    setNodes(canvasFixture.nodes.map((node) => ({ ...node, type: 'probe', draggable: true })));
    setEdges(canvasFixture.edges);
    setDrawings(canvasFixture.drawings);
    reactFlow.setViewport(canvasFixture.viewport);
    setZoom(canvasFixture.viewport.zoom);
    setCanvasStatus('fixture inicial restaurado; los cambios locales se descartaron');
  }

  function checkCoordinates() {
    const before = JSON.stringify(drawings);
    const zoomBefore = reactFlow.getZoom();
    const first = drawings[0]?.points[0];
    const screenBefore = first ? reactFlow.flowToScreenPosition(first) : null;
    reactFlow.zoomIn({ duration: 0 });
    requestAnimationFrame(() => {
      const after = JSON.stringify(drawings);
      const screenAfter = first ? reactFlow.flowToScreenPosition(first) : null;
      const screenDelta = screenBefore && screenAfter
        ? Math.hypot(screenAfter.x - screenBefore.x, screenAfter.y - screenBefore.y)
        : 0;
      setCanvasStatus(`zoom ${zoomBefore.toFixed(2)} → ${reactFlow.getZoom().toFixed(2)} · puntos mundo sin cambio ${before === after ? 'sí' : 'no'} · delta pantalla ${screenDelta.toFixed(2)} px`);
    });
  }

  function createExport() {
    const svg = buildSvg(snapshot(), { width: 960, height: 560, padding: 28 });
    lastExportSvgRef.current = svg;
    if (exportSvgUrl) URL.revokeObjectURL(exportSvgUrl);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    setExportSvgUrl(url);
    const counts = {
      vectorText: (svg.match(/<text\b/g) || []).length,
      vectorPaths: (svg.match(/<path\b/g) || []).length,
      rasterImages: (svg.match(/<image\b/g) || []).length,
      foreignObjects: (svg.match(/<foreignObject\b/g) || []).length
    };
    setExportStatus(`SVG creado · ${JSON.stringify(counts)}`);
  }

  async function createPng() {
    const svg = lastExportSvgRef.current || buildSvg(snapshot(), { width: 960, height: 560, padding: 28 });
    const png = await rasterizeSvg(svg, 2);
    if (exportPngUrl) URL.revokeObjectURL(exportPngUrl);
    const url = URL.createObjectURL(png.blob);
    setExportPngUrl(url);
    setExportStatus(`PNG creado · ${png.width} × ${png.height} · ${png.mimeType}; todo el texto y la geometría están rasterizados`);
  }

  useEffect(() => () => {
    if (exportSvgUrl) URL.revokeObjectURL(exportSvgUrl);
    if (exportPngUrl) URL.revokeObjectURL(exportPngUrl);
  }, [exportSvgUrl, exportPngUrl]);

  return (
    <section className="panel canvas-panel">
      <div className="section-heading">
        <div><p className="eyebrow">10.1 / 10.4 / 14.5</p><h2>Lienzo, trazo y exportación</h2></div>
        <span className="fixture-label" data-testid="canvas-counts">{savedCanvas}</span>
      </div>
      <div className="toolbar" role="toolbar" aria-label="Herramientas del spike">
        <button className={mode === 'select' ? 'active' : ''} onClick={() => setMode('select')}>Seleccionar / conectar</button>
        <button className={mode === 'draw' ? 'active' : ''} onClick={() => setMode('draw')}>Dibujar</button>
        <button onClick={() => reactFlow.zoomOut({ duration: 0 })}>Zoom −</button>
        <button onClick={() => reactFlow.zoomIn({ duration: 0 })}>Zoom +</button>
        <button onClick={checkCoordinates}>Comprobar coordenadas</button>
        <button onClick={saveFixture}>Guardar fixture</button>
        <button onClick={reopenFixture}>Reabrir fixture</button>
        <button onClick={resetFixture}>Restablecer</button>
      </div>
      <div
        ref={flowHostRef}
        className={`flow-host ${mode === 'draw' ? 'draw-mode' : ''}`}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMoveCapture={onPointerMoveCapture}
        onPointerUpCapture={onPointerUpCapture}
        onPointerCancel={onPointerUpCapture}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          onMoveEnd={(_, viewport) => setZoom(viewport.zoom)}
          defaultViewport={canvasFixture.viewport}
          nodesDraggable={mode === 'select'}
          nodesConnectable
          elementsSelectable={mode === 'select'}
          panOnDrag={mode === 'select' ? [1, 2] : false}
          minZoom={0.05}
          maxZoom={8}
          fitView={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={20} size={1} color="#dbe3ee" />
          <StrokeLayer drawings={drawings} preview={preview} />
        </ReactFlow>
      </div>
      <p className="editor-status" data-testid="canvas-status">{canvasStatus}</p>
      <div className="export-row">
        <button onClick={createExport}>Crear SVG</button>
        <button onClick={createPng}>Crear PNG ×2</button>
        {exportSvgUrl && <a href={exportSvgUrl} download="a3-e0-d1.svg">Descargar SVG</a>}
        {exportPngUrl && <a href={exportPngUrl} download="a3-e0-d1.png">Descargar PNG</a>}
        <span className="editor-status" data-testid="export-status">{exportStatus}</span>
      </div>
      {exportPngUrl && <img className="png-preview" src={exportPngUrl} alt="Previsualización del PNG exportado" />}
    </section>
  );
}

function App() {
  return (
    <main className="app-shell">
      <header className="page-header">
        <div><p className="eyebrow">A3 · E0-D1 · spike local</p><h1>Compatibilidad de editores, lienzo y export</h1></div>
        <p>Fixtures sintéticos. Los cambios del lienzo viven solo en localStorage del origen de prueba.</p>
      </header>
      <MarkdownEditors />
      <ReactFlowProvider><CanvasWorkbench /></ReactFlowProvider>
      <footer>Sin backend, IPC, dependencias productivas ni escritura sobre fixtures del repositorio.</footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
