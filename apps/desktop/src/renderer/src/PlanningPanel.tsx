import { useEffect, useMemo, useState } from 'react';
import { PLANNING_PRIORITIES, TASK_STATES } from '@a3/domain/planning';
import { groupPlanningTasks, type PlanningFilter } from '@a3/domain/planning-views';
import type { LocalProjectSession, ProjectPlanningState, PlanningProposalPreview } from '@a3/project-store';
import type { PlanningRequest } from '../../shared/planning';
import { requestPlanningState, TaskControls } from './TaskControls';

export function PlanningPanel({ project, onChanged, onShowPlacement }: { project: LocalProjectSession | null; onChanged: () => void; onShowPlacement: (workspaceId: string, placementId: string) => Promise<void> }): React.JSX.Element {
  const [state, setState] = useState<ProjectPlanningState | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<PlanningFilter>({ groupBy: 'none' }), [workspaceId, setWorkspaceId] = useState('');
  const [title, setTitle] = useState(''), [storyId, setStoryId] = useState('');
  const [story, setStory] = useState({ title: '', actor: '', need: '', goal: '', criteria: '' });
  const [source, setSource] = useState(''), [preview, setPreview] = useState<PlanningProposalPreview | null>(null), [selected, setSelected] = useState<string[]>([]);
  const sessionId = project?.sessionId;
  function accept(next: ProjectPlanningState): void { setState(next); onChanged(); }
  async function load(): Promise<void> { if (!sessionId) return; try { setState(await requestPlanningState({ action: 'load', sessionId })); setError(''); } catch (cause) { setError(String(cause)); } }
  useEffect(() => { let live = true; if (sessionId) void requestPlanningState({ action: 'load', sessionId }).then((value) => { if (live) setState(value); }).catch((cause) => { if (live) setError(String(cause)); }); return () => { live = false; }; }, [sessionId]);
  async function mutate(request: PlanningRequest): Promise<boolean> { setBusy(true); setError(''); try { accept(await requestPlanningState(request)); return true; } catch (cause) { setError(String(cause)); return false; } finally { setBusy(false); } }
  const groups = useMemo(() => state ? groupPlanningTasks(state, filter) : [], [state, filter]);
  if (!sessionId || !project) return <section><h1>Tareas</h1><p>Abre un proyecto para consultar su planificación.</p></section>;
  if (!state) return <section><h1>Tareas</h1>{error ? <p role="alert">{error}</p> : <p>Cargando planificación…</p>}</section>;
  const stories = state.items.filter((item) => item.data.kind === 'story');
  const placementWorkspace = workspaceId || state.workspaces[0]?.id;
  async function showTask(entityId: string): Promise<void> {
    if (!placementWorkspace) return; setError('');
    try { if (!window.a3) throw new Error('Puente no disponible.'); const result = await window.a3.planning({ action: 'show-task', sessionId: sessionId!, entityId, workspaceId: placementWorkspace });
      if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
      if ('placementId' in result.value) await onShowPlacement(result.value.workspaceId, result.value.placementId);
    } catch (cause) { setError(String(cause)); }
  }
  async function inspect(): Promise<void> {
    setBusy(true); setError(''); setPreview(null);
    try { if (!window.a3) throw new Error('Puente no disponible.'); const result = await window.a3.planning({ action: 'preview-proposal', sessionId: sessionId!, source });
      if (!result.ok) throw new Error(result.error.message);
      if ('coverageClaim' in result.value) { setPreview(result.value); setSelected(result.value.proposal?.items.map((item) => item.key) ?? []); }
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  function example(): void {
    const requirement = state!.requirements[0]; if (!requirement) { setError('Crea una historia o marca un requisito explícito antes de preparar un borrador referenciado.'); return; }
    setSource(JSON.stringify({ schemaVersion: '1.0.0', projectId: state!.projectId, sourceRefs: [{ kind: 'entity', id: requirement.id }], items: [{ key: 'revisar-requisito', title: 'Revisar ' + requirement.title, requirementIds: [requirement.id], criterionIds: [], dependencyKeys: [] }] }, null, 2)); setPreview(null);
  }
  return <section className="planning-panel" aria-labelledby="planning-title">
    <h1 id="planning-title">Tareas y checklist</h1><p>Las filas y los nodos representan las mismas tareas por ID. Las evidencias son referencias revisables.</p>
    <button type="button" onClick={() => void load()}>Recargar planificación</button>{state.readOnlyReason && <p>{state.readOnlyReason}</p>}
    <label><input type="checkbox" data-evidence-policy checked={state.policy?.requireEvidenceForDone ?? false} disabled={busy || !state.canSetPolicy} onChange={(event) => void mutate({ action: 'set-policy', sessionId, expectedRevision: state.projectRevision, requireEvidenceForDone: event.target.checked })} /> Exigir evidencia vinculada antes de completar</label>
    {!state.policy && <p role="alert">Política no interpretable: completar tareas queda bloqueado hasta repararla.</p>}
    <details><summary>Nueva historia y criterios</summary><form onSubmit={(event) => { event.preventDefault(); void mutate({ action: 'create-story', sessionId, input: { ...story, criteria: story.criteria.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) } }); }}>
      <fieldset disabled={busy || !state.canEdit}><legend>Historia</legend>{(['title', 'actor', 'need', 'goal'] as const).map((key) => <label key={key}>{({ title: 'Título de historia', actor: 'Actor de la historia', need: 'Necesidad', goal: 'Objetivo' })[key]}<input required maxLength={key === 'title' ? 200 : key === 'actor' ? 1000 : 20000} aria-label={key === 'title' ? 'Título de historia' : key} value={story[key]} onChange={(event) => setStory({ ...story, [key]: event.target.value })} /></label>)}
      <label>Criterios, uno por línea<textarea aria-label="Criterios de la historia" value={story.criteria} onChange={(event) => setStory({ ...story, criteria: event.target.value })} /></label><button type="submit">Crear historia y criterios</button></fieldset></form></details>
    <form onSubmit={(event) => { event.preventDefault(); void mutate({ action: 'create-task', sessionId, title, ...(storyId ? { storyId } : {}) }); }}>
      <fieldset disabled={busy || !state.canEdit}><legend>Nueva tarea</legend><label>Título<input required maxLength={200} aria-label="Título de tarea" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Historia<select aria-label="Historia de nueva tarea" value={storyId} onChange={(event) => setStoryId(event.target.value)}><option value="">Sin historia</option>{stories.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button type="submit" data-create-task>Crear tarea</button></fieldset>
    </form>
    <div className="planning-filters"><label>Buscar<input type="search" aria-label="Buscar tareas" value={filter.search ?? ''} onChange={(event) => setFilter({ ...filter, search: event.target.value })} /></label>
      <label>Estado<select aria-label="Filtrar estado" value={filter.state ?? ''} onChange={(event) => setFilter({ ...filter, state: event.target.value })}><option value="">Todos</option>{TASK_STATES.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Prioridad<select aria-label="Filtrar prioridad" value={filter.priority ?? ''} onChange={(event) => setFilter({ ...filter, priority: event.target.value })}><option value="">Todas</option>{PLANNING_PRIORITIES.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Historia<select aria-label="Filtrar historia" value={filter.storyId ?? ''} onChange={(event) => setFilter({ ...filter, storyId: event.target.value })}><option value="">Todas</option>{stories.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label>Workspace<select aria-label="Filtrar workspace" value={filter.workspaceId ?? ''} onChange={(event) => setFilter({ ...filter, workspaceId: event.target.value })}><option value="">Todos</option>{state.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Agrupar<select aria-label="Agrupar tareas" value={filter.groupBy} onChange={(event) => setFilter({ ...filter, groupBy: event.target.value as PlanningFilter['groupBy'] })}><option value="none">Lista</option><option value="story">Historia</option><option value="workspace">Workspace</option></select></label>
    </div>
    <label>Workspace para mostrar nodo<select aria-label="Destino de nodo tarea" value={placementWorkspace ?? ''} onChange={(event) => setWorkspaceId(event.target.value)}>{state.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <div aria-label="Checklist del proyecto">{groups.map((group) => <section key={group.id}><h2>{group.label}</h2>{!group.tasks.length && <p>No hay tareas para este filtro.</p>}<ul className="planning-list">{group.tasks.map((item) => <li key={item.id} data-task-row={item.id}>
      <h3>{item.title}</h3><small>{item.id} · prioridad {String(item.data.priority)}</small><TaskControls item={item} planning={state} onChanged={accept} />
      <button type="button" disabled={!placementWorkspace || !state.canPlace} onClick={() => void showTask(item.id)}>Mostrar nodo en lienzo</button>
    </li>)}</ul></section>)}</div>
    <section aria-label="Trazabilidad pendiente"><h2>Referencias pendientes</h2><h3>Historias/requisitos sin tarea</h3><ul data-requirements-without-task>{state.requirementsWithoutTask.map((item) => <li key={item.id}>{item.title} · {item.id}</li>)}</ul>
      <h3>Criterios sin evidencia vinculada</h3><ul data-criteria-without-evidence>{state.criteriaWithoutEvidence.map((item) => <li key={item.id}>{item.title} · {item.id}</li>)}</ul><p>Estos indicadores no demuestran cobertura total ni corrección de una checklist.</p></section>
    <details><summary>Revisar borrador de tareas de IA</summary><p>Pega una propuesta JSON con referencias de este proyecto. La vista previa no crea tareas. No se contacta a ningún proveedor.</p>
      <button type="button" onClick={example}>Preparar ejemplo de formato</button><label>Propuesta JSON<textarea aria-label="Propuesta de tareas JSON" value={source} maxLength={256 * 1024} onChange={(event) => { setSource(event.target.value); setPreview(null); }} /></label>
      <button type="button" disabled={busy} data-proposal-preview onClick={() => void inspect()}>Previsualizar borrador</button>
      {preview && <section aria-label="Vista previa de tareas propuestas"><p>Borrador sin garantía de cobertura · SHA-256: {preview.sourceHash}</p><ul>{preview.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul><ul>{preview.proposal?.sourceRefs.map((ref) => <li key={ref.kind + ref.id}>Fuente: {ref.kind}:{ref.id}</li>)}</ul>
        {preview.proposal?.items.map((item) => <label key={item.key}><input type="checkbox" checked={selected.includes(item.key)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, item.key] : old.filter((key) => key !== item.key))} />{item.title} · requisitos {item.requirementIds.join(', ')} · dependencias {item.dependencyKeys.join(', ') || 'ninguna'}</label>)}
        <button type="button" data-proposal-apply disabled={busy || !state.canEdit || !preview.token || !!preview.issues.length || !selected.length} onClick={() => { if (preview.token) void mutate({ action: 'apply-proposal', sessionId, token: preview.token, selectedKeys: selected }).then((saved) => { if (saved) setPreview(null); }); }}>Aceptar tareas seleccionadas</button>
      </section>}
    </details>
    {state.diagnostics.length > 0 && <details><summary>Diagnósticos del modelo</summary><pre>{state.diagnostics.join('\n')}</pre></details>}{error && <p role="alert" data-planning-error>{error}</p>}
  </section>;
}
