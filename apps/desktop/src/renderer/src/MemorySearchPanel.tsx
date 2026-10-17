import { useEffect, useState } from 'react';
import type { LocalProjectSession, ProjectMemoryState, ProjectSearchState } from '@a3/project-store';
import type { CodeEditorTarget } from './CodeEditor';
import type { MarkdownEditorTarget } from './MarkdownEditor';
export function MemorySearchPanel({ project, mode, onOpenCode, onOpenPage, onShowPlacement, contentVersion, onChanged }: {
  project: LocalProjectSession | null; mode: 'memory' | 'search'; contentVersion: number; onChanged: () => void;
  onOpenCode: (target: CodeEditorTarget) => void; onOpenPage: (target: MarkdownEditorTarget) => Promise<void>; onShowPlacement: (workspaceId: string, placementId: string) => Promise<void>;
}): React.JSX.Element {
  const [memory, setMemory] = useState<ProjectMemoryState | null>(null), [search, setSearch] = useState<ProjectSearchState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [patterns, setPatterns] = useState('');
  const [title, setTitle] = useState(''), [content, setContent] = useState(''), [sourceIds, setSourceIds] = useState<string[]>([]);
  const sessionId = project?.sessionId;
  async function load(): Promise<void> {
    if (!window.a3 || !sessionId) return;
    const result = await window.a3.memorySearch({ action: 'memory', sessionId });
    if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
    if ('documents' in result.value) setMemory(result.value);
  }
  useEffect(() => { let live = true; if (mode === 'memory' && sessionId && window.a3) void window.a3.memorySearch({ action: 'memory', sessionId }).then((result) => { if (!live) return; if (result.ok && 'documents' in result.value) setMemory(result.value); else if (!result.ok) setError(result.error.message); }); return () => { live = false; }; }, [sessionId, mode, contentVersion]);
  useEffect(() => {
    let live = true;
    if (mode === 'search' && sessionId && window.a3) { setBusy(true); void window.a3.memorySearch({ action: 'search', sessionId, query: '', rebuild: false }).then((result) => {
      if (!live) return;
      if (result.ok && 'results' in result.value) { setSearch(result.value); setPatterns(result.value.exclusions.join('\n')); } else if (!result.ok) setError(result.error.message);
    }).catch((cause) => { if (live) setError(String(cause)); }).finally(() => { if (live) setBusy(false); }); }
    return () => { live = false; };
  }, [sessionId, mode]);
  async function index(rebuild: boolean): Promise<void> {
    if (!sessionId || !window.a3) return; setBusy(true); setError('');
    try { const result = await window.a3.memorySearch({ action: 'search', sessionId, query, rebuild, exclusions: patterns.split(/\r?\n/).map((v) => v.trim()).filter(Boolean) });
      if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); if ('results' in result.value) setSearch(result.value);
    } catch (cause) { setSearch(null); setError(String(cause)); } finally { setBusy(false); }
  }
  async function initialize(): Promise<void> { if (!sessionId || !window.a3) return; setBusy(true); setError(''); try {
    const result = await window.a3.memorySearch({ action: 'initialize', sessionId }); if (!result.ok) throw new Error(result.error.message); if ('documents' in result.value) setMemory(result.value); onChanged();
  } catch (cause) { setError(String(cause)); await load().catch(() => undefined); } finally { setBusy(false); } }
  async function summary(event: React.FormEvent): Promise<void> { event.preventDefault(); if (!sessionId || !window.a3) return; setBusy(true); setError(''); try {
    const result = await window.a3.memorySearch({ action: 'summary', sessionId, input: { title, content, sourceIds } }); if (!result.ok) throw new Error(result.error.message); if ('documents' in result.value) setMemory(result.value); setContent(''); setTitle(''); onChanged();
  } catch (cause) { setError(String(cause)); } finally { setBusy(false); } }
  if (!project || !sessionId) return <section><h1>{mode === 'memory' ? 'Memoria' : 'Buscar'}</h1><p>Abre un proyecto local.</p></section>;
  return <section className="memory-search-panel"><h1>{mode === 'memory' ? 'Memoria del proyecto' : 'Buscar en el proyecto'}</h1>
    {mode === 'memory' ? <><p>Documentación explícita y editable. Las conversaciones no se convierten automáticamente en memoria.</p>
      {memory?.missingRoles.length ? <button type="button" data-memory-initialize disabled={busy || !memory.canWrite} onClick={() => void initialize()}>Crear documentos iniciales de memoria</button> : null}
      {memory && !memory.canWrite && <p>{memory.reason}</p>}
      <ul className="memory-documents">{memory?.documents.map((doc) => <li key={doc.entityId} data-memory-document={doc.role}><h2>{doc.title}</h2><code>{doc.path}</code>
        <button type="button" data-memory-edit onClick={() => void onOpenPage({ sessionId, entityId: doc.entityId, resourceId: doc.resourceId, title: doc.title }).catch((cause) => setError(String(cause)))}>Abrir Markdown</button>
        {doc.summary && <div aria-label="Procedencia del resumen"><p>Registrado: {doc.summary.recordedAt} · {doc.summary.actor.kind}:{doc.summary.actor.id}</p><ul>{doc.summary.sources.map((source) => <li key={source.id}>Fuente: {source.label} · {source.kind}:{source.id} · SHA-256 {source.hash}</li>)}</ul><p>Comprueba las fuentes: la fecha y las referencias no garantizan la exactitud del resumen.</p></div>}
        {doc.diagnostic && <p role="alert">{doc.diagnostic}</p>}
      </li>)}</ul>
      <details><summary>Guardar resumen explícito</summary><p>Pega un resumen manual o generado externamente y selecciona sus fuentes. Guardarlo requiere esta acción explícita.</p><form onSubmit={(event) => void summary(event)}><fieldset disabled={busy || !memory?.canWrite}><legend>Resumen y procedencia</legend>
        <label>Título<input required maxLength={200} aria-label="Título del resumen" value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Markdown del resumen<textarea required maxLength={2 * 1024 * 1024} aria-label="Markdown del resumen" value={content} onChange={(event) => setContent(event.target.value)} /></label>
        {memory?.documents.map((doc) => <label key={doc.resourceId}><input type="checkbox" aria-label={'Fuente ' + doc.title} checked={sourceIds.includes(doc.resourceId)} onChange={(event) => setSourceIds((old) => event.target.checked ? [...old, doc.resourceId] : old.filter((id) => id !== doc.resourceId))} />{doc.title} · {doc.path}</label>)}
        <button type="submit" data-memory-summary disabled={!sourceIds.length}>Guardar resumen con fuentes y fecha</button></fieldset></form></details>
    </> : <><p>Texto, títulos, etiquetas y código autorizado. Índice local sin embeddings ni API.</p><form onSubmit={(event) => { event.preventDefault(); void index(false); }}><fieldset disabled={busy}><legend>Búsqueda</legend><label>Consulta<input type="search" maxLength={500} aria-label="Consulta de búsqueda" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="submit" data-search-submit>Buscar / actualizar índice</button><button type="button" data-search-rebuild onClick={() => void index(true)}>Reconstruir índice</button>
      <details><summary>Exclusiones adicionales de esta sesión</summary><label>Patrones, uno por línea<textarea aria-label="Exclusiones de búsqueda" value={patterns} onChange={(event) => setPatterns(event.target.value)} /></label><p>Se mantienen las exclusiones de Git, datos locales, dependencias, entornos, compilados, secretos y binarios. Los montajes requieren permiso de indexar y leer.</p></details></fieldset></form>
      {busy && <p role="status">Comprobando fuentes autorizadas…</p>}{search && <><p role="status" data-search-stats>{search.total} coincidencias · {search.stats.documents} documentos · {search.stats.updated} actualizados · {search.stats.removed} retirados · {search.stats.unchanged} sin cambios</p>
        {search.total > search.results.length && <p>Se muestran los primeros {search.results.length}; precisa la consulta para ver otras coincidencias.</p>}{search.partial && <p role="alert">Índice parcial; revisa los archivos omitidos en los diagnósticos.</p>}
        <ul className="search-results">{search.results.map((hit) => <li key={hit.key} data-search-hit={hit.key}><h2>{hit.title}</h2><code>{hit.origin}</code><p>{hit.snippet}</p><small>Etiquetas: {hit.tags.join(', ') || 'ninguna'} · SHA-256 {hit.hash}</small>
          {(hit.resourceId || hit.itemId) && <button type="button" onClick={() => onOpenCode({ sessionId, title: hit.title, target: hit.resourceId ? { resourceId: hit.resourceId } : { itemId: hit.itemId! } })}>Abrir fuente</button>}
          {hit.placements.map((placement) => <button type="button" key={placement.placementId} onClick={() => void onShowPlacement(placement.workspaceId, placement.placementId).catch((cause) => setError(String(cause)))}>Mostrar en workspace {placement.workspaceName}</button>)}
        </li>)}</ul>{search.diagnostics.length > 0 && <details><summary>Diagnósticos del índice ({search.diagnostics.length})</summary><pre>{search.diagnostics.join('\n')}</pre></details>}</>}
    </>}{error && <p role="alert" data-memory-search-error>{error}</p>}</section>;
}
