import { useState } from 'react';
import type { CanvasEntitySummary, CanvasStructurizrImportPreview, LocalCanvasWorkspace } from '../../shared/desktop-api';
import { STRUCTURIZR_DSL_SOURCE_TYPE, STRUCTURIZR_JSON_SOURCE_TYPE } from '@a3/domain/structurizr-source';

export function StructurizrSourceRenderer({ entity, source, sessionId, workspaceId, onImported, onProjectsChanged, canApply, unavailableMessage }: {
  entity: CanvasEntitySummary; source: string | null; sessionId: string; workspaceId: string;
  onImported?: (workspace: LocalCanvasWorkspace) => void; onProjectsChanged?: () => void; canApply: boolean; unavailableMessage?: string;
}): React.JSX.Element {
  const [preview, setPreview] = useState<CanvasStructurizrImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const format = entity.type === STRUCTURIZR_DSL_SOURCE_TYPE ? 'structurizr-dsl' : entity.type === STRUCTURIZR_JSON_SOURCE_TYPE ? 'structurizr-json' : null;
  const compatible = !!format && entity.typeVersion === '1.0.0' && entity.properties['a3.diagram.format'] === format;

  async function prepare(): Promise<void> {
    if (!window.a3 || busy || !compatible) return;
    setBusy(true); setError(null); setStatus('');
    try {
      const response = await window.a3.canvas({ action: 'structurizr-import-preview', sessionId, workspaceId, sourceEntityId: entity.id });
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${response.error.recovery}`);
      setPreview(response.value); setStatus(response.value.message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo analizar el workspace Structurizr.'); }
    finally { setBusy(false); }
  }

  async function applyView(viewKey: string): Promise<void> {
    if (!window.a3 || !preview?.canApply || !canApply || busy) return;
    setBusy(true); setError(null); setStatus('');
    try {
      const response = await window.a3.canvas({ action: 'structurizr-import-apply', sessionId, workspaceId, token: preview.token, authority: preview.authority, viewKey });
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${response.error.recovery}`);
      onImported?.(response.value); onProjectsChanged?.();
      setStatus('Vista C4 importada. Abre su workspace desde el selector del lienzo; la fuente Structurizr permanece intacta. Actualizando el informe…');
      const refreshed = await window.a3.canvas({ action: 'structurizr-import-preview', sessionId, workspaceId, sourceEntityId: entity.id });
      if (!refreshed.ok) throw new Error(`${refreshed.error.code}: ${refreshed.error.message} ${refreshed.error.recovery}`);
      setPreview(refreshed.value); setStatus('Vista C4 importada. Puedes revisar e importar otra vista; la fuente Structurizr permanece intacta.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo aplicar la vista. Prepara de nuevo el diff.'); }
    finally { setBusy(false); }
  }

  const formatLabel = format === 'structurizr-dsl' ? 'Structurizr DSL' : 'Structurizr workspace JSON';
  return <section className="canvas-content-card structurizr-source-card" data-content-renderer="structurizr-source" aria-label={`${formatLabel} ${entity.title}`}>
    {!compatible ? <p className="canvas-content-state" role="status">No se reconoce el formato o versión; la fuente original permanece disponible.</p> :
      source === null ? <p className="canvas-content-state" role="status">{unavailableMessage ?? 'No se puede leer la fuente. El archivo y sus bytes permanecen intactos.'}</p> : <>
        <p className="canvas-content-state">Vista local A3 de vistas C4 estáticas. No se conecta a Structurizr Cloud ni ejecuta DSL, scripts o plugins.</p>
        <details className="plantuml-source-original"><summary>Fuente original preservada · {formatLabel}</summary><pre>{source}</pre></details>
        <button className="quiet" type="button" data-structurizr-import-preview onClick={() => void prepare()} disabled={busy}>
          {busy && !preview ? 'Analizando fuente…' : preview ? 'Actualizar vista previa' : 'Previsualizar workspace Structurizr'}
        </button>
        {preview && <section className="mermaid-import" aria-label="Importación de vistas Structurizr a C4 A3">
          <p>SHA-256 <code>{preview.sourceHash}</code> · autoridad <code>{preview.authority}</code>. Cada vista se aplica por separado para conservar su historial de canvas; el mismo elemento mantiene ID entre vistas.</p>
          <div className="structurizr-view-list" aria-label="Vistas estáticas">
            {preview.views.map((view) => <article className="structurizr-view-item" key={view.key} data-import-action={view.action} data-view-key={view.key} data-workspace-id={view.workspaceId}>
              <h4>{view.title}</h4><small>{view.kind} · {view.elements} elementos · {view.relations} relaciones · {view.action}</small>
              <button className="quiet" type="button" data-structurizr-import-view={view.key} onClick={() => void applyView(view.key)}
                disabled={!preview.canApply || !canApply || busy || view.action === 'unchanged'}>
                {view.action === 'unchanged' ? 'Vista sin cambios' : view.action === 'update' ? `Actualizar vista ${view.kind}` : `Crear vista ${view.kind}`}
              </button>
            </article>)}
          </div>
          {preview.converted.length > 0 && <details><summary>Elementos y relaciones convertibles ({preview.converted.length})</summary>
            <ul>{preview.converted.map((item) => <li key={`${item.key}:${item.kind}`}><code>{item.key}</code> · {item.title || item.kind} · {item.action}</li>)}</ul>
          </details>}
          <details><summary>Mapa estable de IDs ({Object.keys(preview.mapping).length})</summary><ul>{Object.entries(preview.mapping).map(([key, id]) =>
            <li key={key}><code>{key}</code> → <code>{id}</code></li>)}</ul></details>
          {preview.staleSourceKeys.length > 0 && <p>Claves antiguas no presentes (no se borran): {preview.staleSourceKeys.map((key) => <code key={key}>{key} </code>)}</p>}
          {preview.unconverted.length > 0 && <section className="mermaid-import-issues" aria-label="Construcciones sin convertir"><strong>Fuente preservada sin conversión</strong><ul>
            {preview.unconverted.map((item, index) => <li key={`${item.line}:${index}`}><span>Línea {item.line}</span> <code>{item.source}</code> · {item.reason}</li>)}</ul></section>}
          {preview.missingResources.length > 0 && <section className="mermaid-import-issues" aria-label="Includes y recursos sin resolver"><strong>Includes/recursos sin resolver</strong><ul>
            {preview.missingResources.map((item, index) => <li key={`${item.line}:${index}`}><span>Línea {item.line}</span> <code>{item.source}</code> · {item.reason}</li>)}</ul></section>}
          {preview.idConflicts.length > 0 && <section role="alert" aria-label="Conflictos de identidad"><strong>Conflictos</strong><ul>{preview.idConflicts.map((item, index) =>
            <li key={`${item.line}:${index}`}><code>{item.source}</code> · {item.reason}</li>)}</ul></section>}
          {!canApply && <p className="canvas-content-state">El broker o el estado del proyecto no permite escribir ahora; puedes revisar el informe sin aplicarlo.</p>}
        </section>}
      </>}
    {error && <p className="canvas-content-state" role="alert">{error}</p>}
    {status && <p className="canvas-content-state" role="status">{status}</p>}
    <small>{entity.contentResource?.label ?? formatLabel} · Adaptador local A3 · C4 estático</small>
  </section>;
}
