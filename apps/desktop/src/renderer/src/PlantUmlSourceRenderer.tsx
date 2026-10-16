import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { PLANTUML_RENDERER_VERSION, PLANTUML_SOURCE_LIMIT, PLANTUML_SOURCE_TYPE, supportsPlantUmlSourceRenderer } from '@a3/domain/plantuml-source';
import type { CanvasEntitySummary, CanvasPlantUmlImportPreview, CanvasPlantUmlRenderOutcome, LocalCanvasWorkspace } from '../../shared/desktop-api';

function sanitizeSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'object', 'embed', 'image'],
    FORBID_ATTR: ['href', 'xlink:href'], ALLOW_DATA_ATTR: false, RETURN_TRUSTED_TYPE: false
  }) as string;
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName.toLowerCase() !== 'svg') return '';
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || ['href', 'xlink:href'].includes(attribute.name.toLowerCase()) ||
          /url\s*\(\s*(?!#)/i.test(attribute.value) || /javascript\s*:/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.localName.toLowerCase() === 'style' && /@import|url\s*\(\s*(?!#)|expression\s*\(|javascript\s*:/i.test(element.textContent ?? '')) element.remove();
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

async function sha256Text(source: string): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function PlantUmlSourceRenderer({ entity, source, unavailableMessage, sessionId, workspaceId, onImported, canApply }: {
  entity: CanvasEntitySummary; source: string | null; unavailableMessage?: string; sessionId: string; workspaceId: string;
  onImported?: (workspace: LocalCanvasWorkspace) => void; canApply: boolean;
}): React.JSX.Element {
  const container = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<CanvasPlantUmlRenderOutcome | null>(null);
  const [importPreview, setImportPreview] = useState<CanvasPlantUmlImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState('');
  const authoritySupported = supportsPlantUmlSourceRenderer(entity.type, entity.typeVersion, entity.properties);
  const importCompatible = entity.type === PLANTUML_SOURCE_TYPE && entity.typeVersion === '1.0.0' && entity.properties['a3.diagram.format'] === 'plantuml';
  const authorityLabel = entity.properties['a3.diagram.authority'] === 'a3-model' ? 'authority A3 model' : 'authority source';

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let current = true;
    setResult(null);
    if (!authoritySupported || source === null || !visible || !window.a3) return () => { current = false; };
    const api = window.a3;
    if (new TextEncoder().encode(source).byteLength > PLANTUML_SOURCE_LIMIT) {
      setResult({ state: 'too-large', message: `La fuente supera el límite de ${PLANTUML_SOURCE_LIMIT} bytes; el original permanece intacto.` });
      return () => { current = false; };
    }
    void (async () => {
      try {
        const response = await api.canvas({ action: 'plantuml-render', sessionId, workspaceId, sourceEntityId: entity.id });
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
        const value = response.value;
        if (value.sourceHash && value.sourceHash !== await sha256Text(source)) {
          if (current) setResult({ state: 'invalid', message: 'El archivo cambió durante el render; recarga el nodo antes de mostrarlo.', sourceHash: value.sourceHash });
          return;
        }
        if (value.state === 'rendered') {
          const safeSvg = sanitizeSvg(value.svg);
          if (current) setResult(safeSvg ? { ...value, svg: safeSvg } : { state: 'invalid', message: 'La salida SVG no pasó la sanitización; la fuente permanece intacta.', sourceHash: value.sourceHash });
        } else if (current) setResult(value);
      } catch (error) {
        if (current) setResult({ state: 'unavailable', message: error instanceof Error ? error.message.slice(0, 500) : 'No se pudo iniciar el renderer local.' });
      }
    })();
    return () => { current = false; };
  }, [authoritySupported, entity.id, sessionId, source, visible, workspaceId]);

  async function prepareImport(): Promise<void> {
    if (!window.a3 || importBusy) return;
    setImportBusy(true); setImportError(null); setImportStatus('');
    try {
      const response = await window.a3.canvas({ action: 'plantuml-import-preview', sessionId, workspaceId, sourceEntityId: entity.id });
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${response.error.recovery}`);
      setImportPreview(response.value); setImportStatus(response.value.message);
    } catch (error) { setImportError(error instanceof Error ? error.message : 'No se pudo preparar la vista previa.'); }
    finally { setImportBusy(false); }
  }

  async function applyImport(authority: 'source' | 'a3-model'): Promise<void> {
    if (!window.a3 || !importPreview?.canApply || !canApply || importBusy) return;
    setImportBusy(true); setImportError(null); setImportStatus('');
    try {
      const response = await window.a3.canvas({ action: 'plantuml-import-apply', sessionId, workspaceId, token: importPreview.token, authority });
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${response.error.recovery}`);
      onImported?.(response.value); setImportPreview(null);
      setImportStatus(authority === 'source' ? 'Modelo actualizado; la fuente PlantUML sigue siendo la autoridad y no se reescribe.' :
        'Modelo actualizado y autoridad cambiada explícitamente a A3; la fuente se conserva sin regeneración automática.');
    } catch (error) { setImportError(error instanceof Error ? error.message : 'No se pudo aplicar la importación. Prepara otra vista previa.'); }
    finally { setImportBusy(false); }
  }

  const state = !authoritySupported ? 'fallback' : source === null ? 'unavailable' : result?.state ?? (visible ? 'loading' : 'deferred');
  const message = !authoritySupported ? 'No se reconoce la autoridad o versión de esta fuente; solo se muestra el original.' :
    source === null ? unavailableMessage ?? 'No se puede leer la fuente. Se conserva para localizar o revisar permisos.' :
    result?.state === 'rendered' ? '' : result?.state === 'invalid' && result.line ? `Línea ${result.line}: ${result.message}` :
    state === 'deferred' ? 'El render comienza al acercar este nodo al lienzo.' : result?.message ?? 'Renderizando con PlantUML local…';
  return <section ref={container} className="canvas-content-card plantuml-source-card" data-content-renderer="plantuml-source" data-plantuml-state={state}
    aria-label={`Diagrama PlantUML de fuente ${entity.title}`}>
    {result?.state === 'rendered' ? <div className="plantuml-source-output" role="img" aria-label={`Diagrama PlantUML: ${entity.title}`} dangerouslySetInnerHTML={{ __html: result.svg }} /> :
      <p className="canvas-content-state" role={['invalid', 'unavailable', 'timeout', 'too-large', 'fallback'].includes(state) ? 'alert' : 'status'}>{message}</p>}
    {source !== null && <details className="plantuml-source-original"><summary>Fuente PlantUML preservada</summary><pre>{source}</pre></details>}
    {importCompatible && <section className="mermaid-import" aria-label="Conversión PlantUML a UML A3">
      <p>Conversión parcial explícita: class/interface, firmas simples y relaciones básicas. La fuente completa se conserva; A3 no la regenera al editar el modelo.</p>
      <button className="quiet" type="button" data-plantuml-import-preview onClick={() => void prepareImport()} disabled={importBusy}>
        {importBusy && !importPreview ? 'Preparando vista previa…' : importPreview ? 'Volver a preparar vista previa' : 'Previsualizar conversión a UML A3'}
      </button>
      {importError && <p role="alert" className="canvas-content-state">{importError}</p>}
      {importStatus && <p role="status" className="canvas-content-state">{importStatus}</p>}
      {importPreview && <div className="mermaid-import-preview" data-import-mode={importPreview.mode}>
        <h4>Vista previa · {importPreview.mode === 'new' ? 'crear modelo' : 'actualizar importación existente'}</h4>
        <p>SHA-256 <code>{importPreview.sourceHash}</code> · autoridad actual <code>{importPreview.authority}</code>. Los IDs se muestran antes de escribir.</p>
        {importPreview.converted.length > 0 && <div className="mermaid-import-table" role="table" aria-label="Elementos UML convertidos">
          <div role="row" className="mermaid-import-row mermaid-import-head"><span>Clave de origen</span><span>Elemento</span><span>Acción</span></div>
          {importPreview.converted.map((item) => <div role="row" className="mermaid-import-row" key={`${item.key}:${item.kind}`}>
            <code>{item.key}</code><span>{item.title || item.kind}</span><span>{item.action}</span></div>)}
        </div>}
        <details><summary>Mapa estable de IDs ({Object.keys(importPreview.mapping).length})</summary><ul>{Object.entries(importPreview.mapping).map(([key, id]) =>
          <li key={key}><code>{key}</code> → <code>{id}</code></li>)}</ul></details>
        {importPreview.staleSourceKeys.length > 0 && <p>Claves antiguas no presentes en la fuente (no se borran automáticamente): {importPreview.staleSourceKeys.map((key) => <code key={key}>{key} </code>)}</p>}
        {importPreview.unconverted.length > 0 && <section className="mermaid-import-issues" aria-label="Construcciones conservadas en la fuente"><strong>Sintaxis no convertida</strong><ul>{importPreview.unconverted.map((item, index) =>
          <li key={`${item.line}:${index}`}><span>Línea {item.line}</span> <code>{item.source}</code> · {item.reason}</li>)}</ul></section>}
        {importPreview.idConflicts.length > 0 && <section role="alert" aria-label="Conflictos de identidad"><strong>Conflictos</strong><ul>{importPreview.idConflicts.map((item, index) =>
          <li key={`${item.line}:${index}`}><span>Línea {item.line}</span> <code>{item.source}</code> · {item.reason}</li>)}</ul></section>}
        {importPreview.missingResources.length > 0 && <section aria-label="Recursos ausentes"><strong>Recursos sin resolver</strong><ul>{importPreview.missingResources.map((item, index) => <li key={index}>{item.reason}</li>)}</ul></section>}
        <div className="mermaid-import-actions" aria-label="Aplicar importación y declarar autoridad">
          <button className="quiet" type="button" data-plantuml-import-apply="source" onClick={() => void applyImport('source')} disabled={!importPreview.canApply || !canApply || importBusy}>Aplicar y conservar autoridad source</button>
          <button className="quiet" type="button" data-plantuml-import-apply="a3-model" onClick={() => void applyImport('a3-model')} disabled={!importPreview.canApply || !canApply || importBusy}>Aplicar y cambiar autoridad a modelo A3</button>
        </div>
        {!canApply && <p className="canvas-content-state">El proyecto no permite escribir ahora; puedes revisar el informe sin aplicarlo.</p>}
      </div>}
    </section>}
    <small>{entity.contentResource?.label ?? 'Fuente PlantUML'} · PlantUML {PLANTUML_RENDERER_VERSION}{result?.state === 'rendered' ? ` · Java ${result.javaVersion}` : ''} · {authorityLabel}</small>
  </section>;
}
