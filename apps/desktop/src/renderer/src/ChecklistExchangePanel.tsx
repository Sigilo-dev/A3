import { useEffect, useState } from 'react';
import type { ChecklistImportPreview, ProjectPlanningState } from '@a3/project-store';
import type { ChecklistChoice } from '@a3/domain';
import type { PlanningRequest, PlanningValue } from '../../shared/planning';

async function request(input: PlanningRequest): Promise<PlanningValue> {
  if (!window.a3) throw new Error('Puente no disponible.');
  const result = await window.a3.planning(input);
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
  return result.value;
}

export function ChecklistExchangePanel({ state, onChanged }: { state: ProjectPlanningState; onChanged: (state: ProjectPlanningState) => void }): React.JSX.Element {
  const [source, setSource] = useState(''), [preview, setPreview] = useState<ChecklistImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ChecklistChoice['decision'] | ''>>({});
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { setSource(''); setPreview(null); setChoices({}); setSelected([]); setError(''); setStatus(''); }, [state.sessionId]);
  async function run(action: () => Promise<void>): Promise<void> { setBusy(true); setError(''); setStatus(''); try { await action(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } }
  const tasks = state.items.filter((item) => item.data.kind === 'task');
  return <details data-checklist-exchange><summary>Intercambiar checklist Markdown</summary>
    <p>Exportación puntual del proyecto actual por ID. Importar exige comparar y decidir; no sincroniza otro archivo ni modifica historias, evidencia o archivos de contenido.</p>
    <fieldset disabled={busy}><legend>Tareas para exportar (máximo 128 por lote)</legend>
      <button type="button" onClick={() => setSelected(tasks.slice(0, 128).map((task) => task.id))}>Seleccionar primeras 128</button><button type="button" onClick={() => setSelected([])}>Quitar selección</button>
      {tasks.map((task) => <label key={task.id}><input type="checkbox" aria-label={'Exportar ' + task.title} checked={selected.includes(task.id)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, task.id] : old.filter((id) => id !== task.id))} />{task.title} · {task.id}</label>)}
      <button type="button" data-checklist-export disabled={!state.canExport || !selected.length || selected.length > 128} onClick={() => void run(async () => {
        const value = await request({ action: 'export-checklist', sessionId: state.sessionId, taskIds: selected });
        if ('markdown' in value) { setSource(value.markdown); setPreview(null); setStatus('Exportado sin modificar el proyecto · SHA-256: ' + value.sourceHash); }
      })}>Exportar selección a Markdown</button>{!state.canExport && <p>La política local no permite exportar.</p>}
    </fieldset>
    <label>Importar archivo Markdown<input type="file" accept=".md,.markdown,text/markdown,text/plain" disabled={busy} onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      void run(async () => { if (file.size > 256 * 1024) throw new Error('Archivo mayor de 256 KiB: divide la checklist.'); const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); setSource(text); setPreview(null); setStatus('Archivo cargado para revisar. Aún no se ha importado.'); });
    }} /></label>
    <label>Checklist Markdown<textarea aria-label="Checklist Markdown" data-checklist-source value={source} disabled={busy} maxLength={256 * 1024} onChange={(event) => { setSource(event.target.value); setPreview(null); setStatus(''); }} /></label>
    <button type="button" data-checklist-copy disabled={busy || !state.canExport || !selected.length || selected.length > 128} onClick={() => void run(async () => {
      const value = await request({ action: 'copy-checklist', sessionId: state.sessionId, taskIds: selected }); if ('copied' in value) setStatus('Selección copiada como Markdown.');
    })}>Copiar selección como Markdown</button>
    <button type="button" data-checklist-save disabled={busy || !state.canExport || !selected.length || selected.length > 128} onClick={() => void run(async () => {
      const value = await request({ action: 'save-checklist', sessionId: state.sessionId, taskIds: selected });
      if ('cancelled' in value) setStatus(value.cancelled ? 'Exportación cancelada; no se creó un archivo.' : 'Selección exportada a ' + value.fileName + '. Sin sincronización.');
    })}>Guardar selección como archivo Markdown nuevo</button>
    <button type="button" data-checklist-preview disabled={busy || !source} onClick={() => void run(async () => {
      const value = await request({ action: 'preview-checklist', sessionId: state.sessionId, source });
      if ('rows' in value) { setPreview(value); setChoices(Object.fromEntries(value.rows.map((row) => [row.id, row.match === 'conflict' || row.match === 'create' ? '' : 'keep']))); }
    })}>Previsualizar importación</button>
    {preview && <section aria-label="Comparación de checklist" data-checklist-comparison>
      <p>Proyecto: {preview.projectId} · SHA-256: {preview.sourceHash}</p><ul>{preview.issues.map((issue, index) => <li key={index} role="alert">{issue}</li>)}</ul>
      {preview.rows.map((row, index) => <fieldset key={row.id + index} disabled={busy || row.match === 'blocked'}><legend>{row.incoming.title} · {row.match} · {row.id}</legend>
        <p>Línea {row.line} · revisión importada {row.incoming.revision} / actual {row.current?.revision ?? 'sin tarea'} · campos: {row.changes.join(', ') || 'sin cambios'}</p>
        <details><summary>Comparar datos y referencias</summary><pre>Actual: {JSON.stringify(row.current, null, 2)}{'\n'}Entrante: {JSON.stringify(row.incoming, null, 2)}</pre></details>
        {row.issues.map((issue) => <p key={issue} role="alert">{issue}</p>)}
        <label>Decisión para {row.id}<select aria-label={'Decisión ' + row.id} value={choices[row.id] ?? ''} onChange={(event) => setChoices({ ...choices, [row.id]: event.target.value as ChecklistChoice['decision'] | '' })}>
          <option value="">Elegir después de comparar</option><option value="keep">Conservar actual / excluir alta</option><option value="import">Importar datos entrantes</option>
        </select></label>
      </fieldset>)}
      <button type="button" data-checklist-apply disabled={busy || !state.canEdit || !preview.token || !!preview.issues.length || preview.rows.some((row) => !choices[row.id])} onClick={() => void run(async () => {
        if (!preview.token) return;
        const value = await request({ action: 'apply-checklist', sessionId: state.sessionId, token: preview.token, choices: preview.rows.map((row) => ({ id: row.id, decision: choices[row.id] as ChecklistChoice['decision'] })) });
        if ('items' in value) { onChanged(value); setPreview(null); setStatus('Decisiones aplicadas al modelo canónico. El Markdown no queda sincronizado.'); }
      })}>Aplicar decisiones revisadas</button>{!state.canEdit && <p>{state.readOnlyReason}</p>}
    </section>}
    {status && <p role="status" data-checklist-status>{status}</p>}{error && <p role="alert" data-checklist-error>{error}</p>}
  </details>;
}

export function PlanningTraceabilityPanel({ state, onShowPlacement }: { state: ProjectPlanningState; onShowPlacement: (workspaceId: string, placementId: string) => Promise<void> }): React.JSX.Element {
  const [error, setError] = useState('');
  return <details data-planning-traceability><summary>Historias, tareas, nodos, recursos y evidencia</summary>
    <p>Índice derivado de este proyecto. Una línea visual no añade relaciones ni prueba cobertura.</p>
    <ul>{state.traceability.rows.map((row) => <li key={row.id} id={'trace-' + row.id} tabIndex={-1}>
      <h3>{row.title} · {row.kind}</h3><small>{row.id}</small><ul>{row.links.map((link, index) => <li key={link.role + link.id + index}>
        {link.role}: {link.label} · {link.kind}:{link.id} {link.missing && <strong>Referencia rota</strong>}
        {link.kind === 'entity' && state.traceability.rows.some((target) => target.id === link.id) && <button type="button" onClick={() => { const target = document.getElementById('trace-' + link.id); target?.focus(); target?.scrollIntoView({ block: 'nearest' }); }}>Ver vínculo</button>}
        {link.kind === 'placement' && link.workspaceId && <button type="button" onClick={() => void onShowPlacement(link.workspaceId!, link.id).catch((cause) => setError(String(cause)))}>Mostrar ubicación en lienzo</button>}
      </li>)}</ul>
    </li>)}</ul>
    <h3>Criterios sin prueba vinculada</h3><ul data-trace-criteria>{state.traceability.criteriaWithoutEvidence.map((criterion) => <li key={criterion.id}>{criterion.title} · {criterion.id}</li>)}</ul>
    {error && <p role="alert">{error}</p>}
  </details>;
}
