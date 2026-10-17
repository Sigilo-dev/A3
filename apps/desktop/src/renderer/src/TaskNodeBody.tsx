import { useEffect, useState } from 'react';
import { planningData, type TaskData } from '@a3/domain/planning';
import type { ProjectPlanningState } from '@a3/project-store';
import type { CanvasEntitySummary, LocalCanvasWorkspace } from '../../shared/desktop-api';
import { requestPlanningState, TaskControls } from './TaskControls';

export function TaskNodeBody({ entity, sessionId, workspaceId, onChanged }: { entity: CanvasEntitySummary; sessionId: string; workspaceId: string; onChanged?: (workspace: LocalCanvasWorkspace) => void }): React.JSX.Element {
  const [planning, setPlanning] = useState<ProjectPlanningState | null>(null), [error, setError] = useState('');
  const task = planningData(entity) as TaskData;
  async function load(): Promise<void> { try { setPlanning(await requestPlanningState({ action: 'load', sessionId })); setError(''); } catch (cause) { setError(String(cause)); } }
  function changed(next: ProjectPlanningState): void {
    setPlanning(next); void window.a3?.canvas({ action: 'load', sessionId, workspaceId }).then((result) => { if (result.ok) onChanged?.(result.value); else setError(result.error.message); }).catch((cause) => setError(String(cause)));
  }
  const item = planning?.items.find((entry) => entry.id === entity.id);
  useEffect(() => { if (planning && item?.revision !== entity.revision) void load(); }, [entity.revision]);
  return <section className="canvas-content-card nodrag nowheel task-node" data-content-renderer="task" data-task-node={entity.id}>
    <strong>{entity.title}</strong><p data-task-node-state>Estado: {task.state} · prioridad {task.priority} · {task.evidenceIds.length} evidencias</p>
    <button type="button" onClick={() => void load()}>{planning ? 'Recargar tarea' : 'Editar estado y evidencias'}</button>
    {planning && item && <TaskControls item={item} planning={planning} onChanged={changed} />}{error && <p role="alert">{error}</p>}
  </section>;
}
