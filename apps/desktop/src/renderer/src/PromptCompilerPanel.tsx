import { useEffect, useState } from 'react';
import type { ProjectVariablesState } from '@a3/project-store';
import type { VariableTextResolution } from '@a3/domain';
import type { VariablesRequest } from '../../shared/variables';
import type { LocalProjectSession } from '../../shared/desktop-api';

const initialTemplate = '# {{proyecto.nombre}}\n\nDescribe el objetivo usando {{tecnologia.backend}}.';
export function PromptCompilerPanel({ project }: { project: LocalProjectSession | null }): React.JSX.Element {
  const [catalog, setCatalog] = useState<ProjectVariablesState | null>(null), [workspaceId, setWorkspaceId] = useState(''), [entityId, setEntityId] = useState('');
  const [source, setSource] = useState(initialTemplate), [required, setRequired] = useState('proyecto.nombre'), [result, setResult] = useState<VariableTextResolution | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  useEffect(() => {
    let live = true; setResult(null); setError(''); setStatus(''); setCatalog(null); setWorkspaceId(''); setEntityId('');
    if (project) void window.a3?.variables({ action: 'load', sessionId: project.sessionId, query: {} }).then((response) => {
      if (!live) return; if (!response?.ok || !('sets' in response.value)) setError(response && !response.ok ? response.error.message : 'No se cargó el contexto del proyecto.');
      else setCatalog(response.value);
    }).catch(() => { if (live) setError('No se pudo cargar el contexto del proyecto.'); });
    return () => { live = false; };
  }, [project?.sessionId]);
  async function compile(): Promise<void> {
    if (!project || busy) return; setBusy(true); setError(''); setStatus('');
    const request: VariablesRequest = { action: 'compile', sessionId: project.sessionId, source,
      requiredNames: required.split(/\r?\n/).map((name) => name.trim()).filter(Boolean), query: { ...(workspaceId ? { workspaceId } : {}), ...(entityId ? { entityId } : {}) } };
    try {
      const response = await window.a3?.variables(request); if (!response) throw new Error('El puente local no está disponible.');
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
      if ('sets' in response.value) throw new Error('La compilación no devolvió una vista compilada.'); setResult(response.value);
      setStatus(response.value.unresolved.length ? 'Vista compilada con marcadores de resolución.' : 'Todas las referencias se resolvieron en este contexto.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo compilar la plantilla.'); }
    finally { setBusy(false); }
  }
  async function copyOutput(): Promise<void> {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.markedExport); setStatus('Resultado exportable copiado.'); }
    catch { setError('El portapapeles no está disponible; selecciona el resultado para copiarlo.'); }
  }
  function downloadOutput(): void {
    if (!result) return; const url = URL.createObjectURL(new Blob([result.markedExport], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'a3-prompt-preview.md'; link.click(); URL.revokeObjectURL(url); setStatus('Vista exportada a Markdown.');
  }
  return <section className="intro prompt-compiler" aria-labelledby="prompt-compiler-title">
    <p className="eyebrow">Plantilla Markdown · vista derivada</p><h1 id="prompt-compiler-title">Compilar variables</h1>
    {!project && <p>Abre un proyecto local para compilar referencias.</p>}
    {project && <>
      <p className="lead">La compilación sustituye únicamente tokens <code>{'{{namespace.nombre}}'}</code> en esta vista. La fuente queda intacta y A3 no envía el resultado a ningún agente.</p>
      <div className="variables-context"><label>Workspace<select aria-label="Contexto workspace" disabled={!catalog} value={workspaceId} onChange={(event) => setWorkspaceId(event.currentTarget.value)}><option value="">Sin workspace</option>{catalog?.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Entidad<select aria-label="Contexto entidad" disabled={!catalog} value={entityId} onChange={(event) => setEntityId(event.currentTarget.value)}><option value="">Sin entidad</option>{catalog?.entities.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
      <label>Plantilla Markdown<textarea className="prompt-source" aria-label="Plantilla Markdown" rows={12} value={source} onChange={(event) => setSource(event.currentTarget.value)} /></label>
      <label>Variables obligatorias, una por línea<textarea aria-label="Variables obligatorias" rows={3} value={required} onChange={(event) => setRequired(event.currentTarget.value)} /></label>
      <button className="primary" disabled={busy || !catalog} onClick={() => void compile()}>{busy ? 'Compilando…' : 'Previsualizar compilación'}</button>
      {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
      {result && <section className="prompt-result" aria-label="Resultado compilado" data-auto-send-allowed={result.canSendAutomatically}>
        <h2>Resultado derivado</h2><p role="status">{result.canSendAutomatically ? 'No hay variables obligatorias sin resolver.' : 'Envío automático bloqueado: falta resolver una variable obligatoria.'}</p>
        {result.unresolved.length > 0 && <ul aria-label="Diagnósticos de variables">{result.unresolved.map((issue, index) => <li key={`${issue.name ?? 'template'}:${issue.offset ?? 'required'}:${index}`}>{issue.name ?? 'Plantilla'} · línea {issue.line ?? '—'}, columna {issue.column ?? '—'} · {issue.detail}: {issue.message}</li>)}</ul>}
        <p>Variables incluidas: {result.variables.map((item) => `${item.name} (${item.scope.kind}${item.scope.kind === 'execution' ? '' : `:${item.scope.ownerId}`})`).join(', ') || 'ninguna'}.</p>
        <label>Vista previa exportable<textarea aria-label="Vista previa exportable" rows={14} readOnly value={result.markedExport} /></label>
        <div className="prompt-actions"><button className="secondary" onClick={() => void copyOutput()}>Copiar resultado</button><button className="secondary" onClick={downloadOutput}>Exportar Markdown</button></div>
      </section>}
    </>}
  </section>;
}
