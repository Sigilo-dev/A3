import { useEffect, useId, useState } from 'react';
import DOMPurify from 'dompurify';
import { MERMAID_RENDERER_VERSION, MERMAID_SOURCE_LIMIT, MERMAID_SOURCE_TYPE, renderMermaidSource, supportsMermaidSourceRenderer, type MermaidEngine, type MermaidRenderResult } from '@a3/domain/mermaid-source';
import type { CanvasEntitySummary, CanvasMermaidImportPreview, LocalCanvasWorkspace } from '../../shared/desktop-api';
import { adaptDiagramStyle, DIAGRAM_STYLE_EXTENSION, diagramStyleLayer, type DiagramStyleProfile, type ExtensionMap } from '@a3/domain';

let engineInitialized = false;
async function loadMermaidEngine(): Promise<MermaidEngine> {
  const { default: mermaid } = await import('mermaid');
  if (!engineInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: 'default',
      maxTextSize: MERMAID_SOURCE_LIMIT,
      maxEdges: 500,
      suppressErrorRendering: true,
      secure: ['securityLevel', 'startOnLoad', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'flowchart', 'maxTextSize', 'maxEdges', 'suppressErrorRendering']
    });
    engineInitialized = true;
  }
  return { configure: (configuration) => mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', htmlLabels: false, maxTextSize: MERMAID_SOURCE_LIMIT,
      maxEdges: 500, suppressErrorRendering: true,
      secure: ['securityLevel', 'startOnLoad', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'flowchart', 'maxTextSize', 'maxEdges', 'suppressErrorRendering'],
      ...configuration
    }), parse: (source) => mermaid.parse(source), render: (id, source) => mermaid.render(id, source) };
}

function sanitizeSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'object', 'embed', 'image'],
    FORBID_ATTR: ['href', 'xlink:href'],
    ALLOW_DATA_ATTR: false,
    RETURN_TRUSTED_TYPE: false
  }) as string;
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName.toLowerCase() !== 'svg') return '';
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || ['href', 'xlink:href'].includes(attribute.name.toLowerCase()) || /url\s*\(\s*(?!#)/i.test(attribute.value) || /javascript\s*:/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.localName.toLowerCase() === 'style' && /@import|url\s*\(|expression\s*\(|javascript\s*:/i.test(element.textContent ?? '')) element.remove();
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

function useDiagram(source: string | null, configuration: Record<string, unknown>): MermaidRenderResult | null {
  const reactId = useId().replace(/[^\da-z_-]/gi, ''), [result, setResult] = useState<MermaidRenderResult | null>(null);
  useEffect(() => {
    let current = true;
    setResult(null);
    if (source === null) return () => { current = false; };
    void renderMermaidSource(source, `a3-${reactId}`, loadMermaidEngine, configuration).then((value) => {
      if (!current) return;
      if (value.state === 'rendered') {
        const svg = sanitizeSvg(value.svg);
        setResult(svg ? { ...value, svg } : { state: 'invalid', message: 'El SVG producido no pasó la sanitización; la fuente original permanece intacta.' });
      } else setResult(value);
    }).catch(() => { if (current) setResult({ state: 'unavailable', message: `El motor Mermaid ${MERMAID_RENDERER_VERSION} no está disponible; la fuente original permanece intacta.` }); });
    return () => { current = false; };
  }, [source, reactId, configuration]);
  return result;
}

function ImportIssues({ title, items }: { title: string; items: readonly { line: number; source: string; reason: string }[] }): React.JSX.Element | null {
  if (!items.length) return null;
  return <section className="mermaid-import-issues" aria-label={title}><strong>{title} ({items.length})</strong><ul>{items.map((item, index) =>
    <li key={`${item.line}:${item.source}:${index}`}><span>Línea {item.line}</span> {item.source && <code>{item.source}</code>} · {item.reason}</li>)}</ul></section>;
}

export function MermaidSourceRenderer({ entity, source, profile, placementStyle, unavailableMessage, sessionId, workspaceId, canApply, onImported }: {
  profile: DiagramStyleProfile; placementStyle: ExtensionMap;
  entity: CanvasEntitySummary; source: string | null; unavailableMessage?: string; sessionId: string; workspaceId: string;
  canApply: boolean; onImported?: (workspace: LocalCanvasWorkspace) => void;
}): React.JSX.Element {
  const authoritySupported = supportsMermaidSourceRenderer(entity.type, entity.typeVersion, entity.properties);
  const adaptation = adaptDiagramStyle(profile, { entity: diagramStyleLayer(entity.properties[DIAGRAM_STYLE_EXTENSION]), view: diagramStyleLayer(placementStyle[DIAGRAM_STYLE_EXTENSION]) });
  const sourceHasInit = source !== null && /^\s*%%\{\s*init\s*:/im.test(source);
  const mermaidConfiguration = profile.engine === 'mermaid' ? adaptation.mermaidConfig ?? { theme: 'default' } : { theme: 'default' };
  const result = useDiagram(authoritySupported ? source : null, mermaidConfiguration);
  const [importPreview, setImportPreview] = useState<CanvasMermaidImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState('');
  const importAvailable = entity.type === MERMAID_SOURCE_TYPE && entity.typeVersion === '1.0.0';
  async function prepareImport(): Promise<void> {
    if (!source || !importAvailable || !window.a3 || importBusy) return;
    setImportBusy(true); setImportError(null); setImportStatus('');
    try {
      const response = await window.a3.canvas({ action: 'mermaid-import-preview', sessionId, workspaceId, sourceEntityId: entity.id });
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${response.error.recovery}`);
      setImportPreview(response.value);
      setImportStatus(response.value.message);
    } catch (error) { setImportError(error instanceof Error ? error.message : 'No se pudo preparar la conversión.'); }
    finally { setImportBusy(false); }
  }
  async function applyImport(authority: 'source' | 'a3-model'): Promise<void> {
    if (!importPreview?.canApply || !canApply || !window.a3 || importBusy) return;
    setImportBusy(true); setImportError(null); setImportStatus('');
    try {
      const response = await window.a3.canvas({ action: 'mermaid-import-apply', sessionId, workspaceId, token: importPreview.token, authority });
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${response.error.recovery}`);
      onImported?.(response.value); setImportPreview(null);
      setImportStatus(authority === 'a3-model' ? 'Modelo actualizado. La fuente Mermaid completa se conserva; la vista A3 es la autoridad.' : 'Modelo actualizado. La fuente Mermaid completa sigue siendo la autoridad.');
    } catch (error) { setImportError(error instanceof Error ? error.message : 'No se pudo aplicar la importación. Vuelve a preparar la vista previa.'); }
    finally { setImportBusy(false); }
  }
  const state = !authoritySupported ? 'fallback' : source === null ? 'unavailable' : result?.state ?? 'loading';
  const message = !authoritySupported ? 'No se reconoce la autoridad o versión de esta fuente. Se muestra el original sin renderizarlo.' :
    source === null ? unavailableMessage ?? 'No se puede leer la fuente. El recurso original se conserva y requiere localizar o revisar permisos.' :
    result?.state === 'invalid' ? `${result.line ? `Línea ${result.line}${result.column ? `, columna ${result.column}` : ''}: ` : ''}${result.message}` :
    result?.state === 'unavailable' || result?.state === 'too-large' ? result.message : '';
  const safeSvg = authoritySupported && result?.state === 'rendered' ? result.svg : '';
  return <section className="canvas-content-card mermaid-source-card" data-content-renderer="mermaid-source" data-mermaid-state={state}
    data-mermaid-line={result?.state === 'invalid' ? result.line : undefined} aria-label={`Diagrama Mermaid de fuente ${entity.title}`}>
    {safeSvg ? <div className="mermaid-source-output" role="img" aria-label={`Diagrama Mermaid: ${entity.title}`} dangerouslySetInnerHTML={{ __html: safeSvg }} /> :
      <p className="canvas-content-state" role={state === 'invalid' || state === 'unavailable' || state === 'fallback' ? 'alert' : 'status'}>{message || 'Validando y renderizando Mermaid…'}</p>}
    {profile.engine === 'mermaid' && sourceHasInit && <p className="canvas-content-state" role="status">La fuente conserva su init. El perfil del proyecto fija el tema seguro para esta vista.</p>}
    {profile.engine === 'mermaid' && adaptation.unsupported.length > 0 && <p className="canvas-content-state" role="status">El perfil omite en Mermaid: {adaptation.unsupported.join(', ')}.</p>}
    {source !== null && <details className="mermaid-source-original"><summary>Fuente Mermaid preservada</summary><pre>{source}</pre></details>}
    {importAvailable && <section className="mermaid-import" aria-label="Conversión a modelo A3">
      <p>Importación explícita y parcial. La fuente nunca se elimina; flowchart, class y ER usan solo la gramática documentada.</p>
      <button className="quiet" type="button" data-mermaid-import-preview onClick={() => void prepareImport()} disabled={!source || importBusy}>
        {importBusy && !importPreview ? 'Preparando vista previa…' : importPreview ? 'Volver a preparar vista previa' : 'Previsualizar conversión a modelo A3'}
      </button>
      {importError && <p className="canvas-content-state" role="alert">{importError}</p>}
      {importStatus && <p className="canvas-content-state" role="status">{importStatus}</p>}
      {importPreview && <div className="mermaid-import-preview" data-import-mode={importPreview.mode}>
        <h4>Vista previa · {importPreview.family ?? 'sin familia compatible'} · {importPreview.mode === 'new' ? 'crear' : 'actualizar importación existente'}</h4>
        <p>SHA-256 <code>{importPreview.sourceHash}</code> · autoridad actual <code>{importPreview.authority}</code>. Los IDs se muestran antes de escribir.</p>
        {importPreview.converted.length > 0 && <div className="mermaid-import-table" role="table" aria-label="Cambios convertidos">
          <div role="row" className="mermaid-import-row mermaid-import-head"><span>Clave de origen</span><span>Elemento</span><span>Acción</span></div>
          {importPreview.converted.map((item) => <div role="row" className="mermaid-import-row" key={`${item.key}:${item.kind}`}>
            <code>{item.key}</code><span>{item.title || item.kind}</span><span>{item.action}</span></div>)}
        </div>}
        <details><summary>Mapa de IDs ({Object.keys(importPreview.mapping).length})</summary><ul>{Object.entries(importPreview.mapping).map(([key, id]) =>
          <li key={key}><code>{key}</code> → <code>{id}</code></li>)}</ul></details>
        {importPreview.staleSourceKeys.length > 0 && <p className="canvas-content-state">Claves antiguas no presentes en la fuente actual (no se borrarán): {importPreview.staleSourceKeys.map((key) => <code key={key}>{key} </code>)}</p>}
        <ImportIssues title="Sintaxis no convertida" items={importPreview.unconverted} />
        <ImportIssues title="Recursos ausentes o sin resolver" items={importPreview.missingResources} />
        <ImportIssues title="Conflictos de identidad" items={importPreview.idConflicts} />
        <p>{importPreview.message}</p>
        <div className="mermaid-import-actions" aria-label="Aplicar y declarar autoridad">
          <button className="quiet" type="button" data-mermaid-import-apply="source" onClick={() => void applyImport('source')} disabled={!importPreview.canApply || !canApply || importBusy}>Aplicar y conservar autoridad source</button>
          <button className="quiet" type="button" data-mermaid-import-apply="a3-model" onClick={() => void applyImport('a3-model')} disabled={!importPreview.canApply || !canApply || importBusy}>Aplicar y cambiar autoridad a modelo A3</button>
        </div>
        {!canApply && <p className="canvas-content-state">El proyecto no permite escribir en este momento; la vista previa sigue disponible.</p>}
      </div>}
    </section>}
    {entity.contentResource && <small>{entity.contentResource.label} · Mermaid {MERMAID_RENDERER_VERSION} · autoridad {entity.properties['a3.diagram.authority'] === 'a3-model' ? 'modelo A3' : 'source'}</small>}
  </section>;
}
