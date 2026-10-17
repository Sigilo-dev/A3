import { useEffect, useState } from 'react';
import { TASK_STATES, type EvidenceTarget, type TaskData, type TaskState } from '@a3/domain/planning';
import type { PlanningItem } from '@a3/domain/planning-views';
import type { ProjectPlanningState } from '@a3/project-store';
import type { PlanningRequest } from '../../shared/planning';

export async function requestPlanningState(request: PlanningRequest): Promise<ProjectPlanningState> {
  if (!window.a3) throw new Error('El puente de escritorio no está disponible.');
  const result = await window.a3.planning(request);
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message + ' ' + result.error.recovery);
  if (!('items' in result.value)) throw new Error('Respuesta de planificación no compatible.');
  return result.value;
}
const labels: Record<TaskState, string> = { todo: 'Por hacer', in_progress: 'En curso', blocked: 'Bloqueada', done: 'Completada', cancelled: 'Cancelada' };
export function TaskControls({ item, planning, onChanged }: { item: PlanningItem; planning: ProjectPlanningState; onChanged: (next: ProjectPlanningState) => void }): React.JSX.Element {
  const task = item.data as TaskData;
  const [base, setBase] = useState({ revision: item.revision, state: task.state, evidence: task.evidenceIds });
  const [state, setState] = useState(task.state), [evidence, setEvidence] = useState([...task.evidenceIds]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dirty = state !== base.state || JSON.stringify(evidence) !== JSON.stringify(base.evidence);
  function reset(): void { setBase({ revision: item.revision, state: task.state, evidence: task.evidenceIds }); setState(task.state); setEvidence([...task.evidenceIds]); setError(''); }
  useEffect(() => { if (!dirty && item.revision !== base.revision) reset(); }, [item.revision]);
  async function save(nextState = state): Promise<void> {
    setState(nextState); setBusy(true); setError('');
    try {
      const next = await requestPlanningState({ action: 'update-task', sessionId: planning.sessionId, input: { entityId: item.id, expectedRevision: base.revision, state: nextState, evidenceIds: evidence } });
      const updated = next.items.find((entry) => entry.id === item.id)!; const data = updated.data as TaskData;
      setBase({ revision: updated.revision, state: data.state, evidence: data.evidenceIds }); setState(data.state); setEvidence([...data.evidenceIds]); onChanged(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se guardó.'); } finally { setBusy(false); }
  }
  const compatibleEvidence = planning.items.filter((entry) => entry.data.kind === 'evidence' && entry.data.criterionIds.every((id) => task.criterionIds.includes(id)));
  return <section className="task-controls nodrag nowheel" data-task-controls={item.id}>
    <p data-task-canonical>Guardado: {labels[task.state]} · revisión {item.revision}</p>
    <fieldset disabled={busy || !planning.canEdit}><legend>Estado y evidencias</legend>
      <label><input type="checkbox" aria-label={'Completar ' + item.title} data-task-check checked={state === 'done'} onChange={(event) => void save(event.target.checked ? 'done' : 'todo')} /> Completada</label>
      <label>Estado <select aria-label={'Estado de ' + item.title} value={state} onChange={(event) => setState(event.target.value as TaskState)}>{TASK_STATES.map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
      <details><summary>Elegir evidencias ({evidence.length})</summary><div className="planning-options">{compatibleEvidence.map((entry) => <label key={entry.id}><input type="checkbox" checked={evidence.includes(entry.id)} aria-label={'Vincular evidencia ' + entry.title} onChange={(event) => setEvidence((old) => event.target.checked ? [...old, entry.id] : old.filter((id) => id !== entry.id))} />{entry.title} · {entry.data.kind === 'evidence' ? entry.data.target.kind : ''}</label>)}</div>{!compatibleEvidence.length && <p>No hay evidencias compatibles; registra una referencia abajo.</p>}</details>
      <button type="button" data-task-save onClick={() => void save()} disabled={!dirty}>Guardar estado y evidencias</button>
    </fieldset>
    {dirty && <p role="status">Borrador sin confirmar · revisión base {base.revision}</p>}
    {base.revision !== item.revision && <p role="alert">La tarea tiene otra revisión. Compara el estado guardado con tu borrador.</p>}
    {(dirty || error) && <button type="button" onClick={reset}>Descartar borrador y usar revisión actual</button>}
    {error && <p role="alert" data-task-error>{error}</p>}
    {!planning.canEdit && <p>{planning.readOnlyReason}</p>}
    <details><summary>Registrar evidencia</summary><EvidenceForm item={item} planning={planning} disabled={busy || dirty || !planning.canEdit} onChanged={onChanged} />{dirty && <p>Guarda o descarta el borrador antes de registrar otra evidencia.</p>}</details>
    <details><summary>Actividad y referencias</summary><p>Criterios: {task.criterionIds.join(', ') || 'ninguno'}</p><p>Dependencias: {task.dependencyIds.map((id) => planning.items.find((entry) => entry.id === id)?.title ?? id).join(', ') || 'ninguna'}</p>
      <ul>{item.history.map((event) => <li key={event.operationId}>{event.actor.kind}:{event.actor.id} · {event.at} · {event.toState ?? event.action} · evidencias: {event.evidenceIds?.join(', ') || 'ninguna registrada en este evento'}</li>)}</ul></details>
  </section>;
}
function EvidenceForm({ item, planning, disabled, onChanged }: { item: PlanningItem; planning: ProjectPlanningState; disabled: boolean; onChanged: (next: ProjectPlanningState) => void }): React.JSX.Element {
  const task = item.data as TaskData;
  const [kind, setKind] = useState<EvidenceTarget['kind']>('file'), [title, setTitle] = useState(''), [target, setTarget] = useState(''), [hash, setHash] = useState('');
  const [criteria, setCriteria] = useState([...task.criterionIds]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const options = kind === 'note' || kind === 'result' ? planning.entities.map((entry) => ({ id: entry.id, label: entry.title })) : planning.resources;
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const reference: EvidenceTarget = kind === 'file' || kind === 'capture' ? { kind, resourceId: target } : kind === 'note' || kind === 'result' ? { kind, entityId: target } : { kind: 'commit', repositoryResourceId: target, hash };
      onChanged(await requestPlanningState({ action: 'add-evidence', sessionId: planning.sessionId, input: { taskId: item.id, expectedRevision: item.revision, title, target: reference, criterionIds: criteria } })); setTitle('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se registró la evidencia.'); } finally { setBusy(false); }
  }
  return <form onSubmit={(event) => void submit(event)}><fieldset disabled={disabled || busy}><legend>Nueva referencia de evidencia</legend>
    <label>Título <input aria-label={'Título de evidencia para ' + item.title} required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Tipo <select aria-label="Tipo de evidencia" value={kind} onChange={(event) => { setKind(event.target.value as EvidenceTarget['kind']); setTarget(''); }}>{['file', 'result', 'note', 'capture', 'commit'].map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>Origen <select required aria-label="Origen de evidencia" value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Elegir origen por ID</option>{options.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label>
    {kind === 'commit' && <label>Hash completo del commit <input required pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}" value={hash} onChange={(event) => setHash(event.target.value)} /></label>}
    {task.criterionIds.map((id) => <label key={id}><input type="checkbox" checked={criteria.includes(id)} onChange={(event) => setCriteria((old) => event.target.checked ? [...old, id] : old.filter((value) => value !== id))} />{planning.items.find((entry) => entry.id === id)?.title ?? id}</label>)}
    <p>Se registra una referencia con tu actor. A3 no certifica su contenido ni ejecuta pruebas.</p><button type="submit" data-evidence-save>Registrar y vincular evidencia</button>
  </fieldset>{error && <p role="alert">{error}</p>}</form>;
}
