import { canonical, copy, isJson, isObject, sameId, UUID_PATTERN } from './data.js';
import { PLANNING_HISTORY_KEY, PLANNING_KEY, PLANNING_VERSION, planningData, planningHistory, validPlanningData, validatePlanningSnapshot, type PlanningOperation, type TaskData } from './planning.js';
import { projectPlanning } from './planning-views.js';
import type { DomainSnapshot, Entity } from './models.js';

export const CHECKLIST_EXCHANGE_VERSION = '1.0.0';
export const CHECKLIST_EXCHANGE_LIMIT = 256 * 1024;
export interface ChecklistTask { id: string; revision: number; title: string; data: TaskData; contentResourceId?: string; }
export interface ChecklistRow {
  id: string; line: number; incoming: ChecklistTask; current: ChecklistTask | null;
  match: 'unchanged' | 'update' | 'create' | 'conflict' | 'blocked'; changes: string[]; issues: string[];
}
export interface ChecklistInspection { projectId: string | null; rows: ChecklistRow[]; issues: string[]; }
export interface ChecklistChoice { id: string; decision: 'import' | 'keep'; }
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID_PATTERN.test(v);
const taskFor = (entity: Entity): ChecklistTask | null => {
  const data = planningData(entity);
  return data?.kind === 'task' && planningHistory(entity) ? { id: entity.id, revision: entity.revision, title: entity.title, data,
    ...(entity.contentResourceId ? { contentResourceId: entity.contentResourceId } : {}) } : null;
};
const escapeTitle = (value: string) => value.replace(/[\\`*_[\]<>#!|]/g, '\\$&').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
const unescapeTitle = (value: string) => value.replace(/\\([\\`*_[\]<>#!|nr])/g, (_all, c: string) => c === 'n' ? '\n' : c === 'r' ? '\r' : c);
const commentJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
function exceedsLimit(value: string): boolean {
  if (value.length > CHECKLIST_EXCHANGE_LIMIT) return true;
  let bytes = 0;
  for (const character of value) { const point = character.codePointAt(0)!; bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; if (bytes > CHECKLIST_EXCHANGE_LIMIT) return true; }
  return false;
}

/** A portable exchange, never another canonical document or an instruction to an agent. */
export function exportChecklistMarkdown(snapshot: DomainSnapshot, taskIds: string[]): string {
  const project = snapshot.records.find((r) => r.kind === 'project');
  if (project?.kind !== 'project' || !taskIds.length || taskIds.length > 128 || new Set(taskIds.map((id) => id.toLowerCase())).size !== taskIds.length) throw new Error('Selección de checklist inválida (entre 1 y 128 tareas).');
  const tasks = taskIds.map((id) => {
    const record = snapshot.records.find((r) => r.kind === 'entity' && sameId(r.value.id, id));
    const task = record?.kind === 'entity' ? taskFor(record.value) : null;
    if (!task) throw new Error('Tarea no disponible: ' + id);
    return task;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const source = '# A3 checklist\n\n<!-- a3-checklist ' + commentJson({ version: CHECKLIST_EXCHANGE_VERSION, projectId: project.value.projectId }) + ' -->\n\n' +
    tasks.map((task) => '- [' + (task.data.state === 'done' ? 'x' : ' ') + '] ' + escapeTitle(task.title) + '\n  <!-- a3-task ' + commentJson(task) + ' -->\n').join('\n');
  if (exceedsLimit(source)) throw new Error('Checklist mayor de 256 KiB UTF-8: divide la selección; no se ha truncado.');
  return source;
}

export function inspectChecklistMarkdown(snapshot: DomainSnapshot, source: string): ChecklistInspection {
  const result: ChecklistInspection = { projectId: null, rows: [], issues: [] };
  if (exceedsLimit(source)) return { ...result, issues: ['Checklist mayor de 256 KiB UTF-8; divide la selección.'] };
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/), seen = new Set<string>(); let headers = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, header = /^<!-- a3-checklist (.*) -->$/.exec(line);
    if (header) {
      headers++;
      try { const value: unknown = JSON.parse(header[1]!); if (!isObject(value) || Object.keys(value).length !== 2 || value.version !== CHECKLIST_EXCHANGE_VERSION || !uuid(value.projectId)) throw new Error(); result.projectId = value.projectId; }
      catch { result.issues.push(`Línea ${index + 1}: cabecera o versión de intercambio no admitida.`); }
      continue;
    }
    const check = /^- \[([ xX])\] (.*)$/.exec(line);
    if (!check) {
      if (line.trim() && line !== '# A3 checklist') result.issues.push(`Línea ${index + 1}: contenido no reconocido; consérvalo y corrige antes de importar.`);
      continue;
    }
    const lineNumber = index + 1, metadata = /^  <!-- a3-task (.*) -->$/.exec(lines[index + 1] ?? '');
    if (!metadata) { result.issues.push(`Línea ${lineNumber}: falta ID y metadata a3-task; no se adivina por título.`); continue; }
    index++;
    try {
      const value: unknown = JSON.parse(metadata[1]!);
      if (!isJson(value) || !isObject(value) || Object.keys(value).some((k) => !['id', 'revision', 'title', 'data', 'contentResourceId'].includes(k)) ||
          !uuid(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.title !== 'string' ||
          !validPlanningData(value.data) || value.data.kind !== 'task' || value.contentResourceId !== undefined && !uuid(value.contentResourceId)) throw new Error();
      const incoming = copy(value) as unknown as ChecklistTask;
      incoming.title = unescapeTitle(check[2]!);
      if (!incoming.title.trim() || incoming.title !== incoming.title.trim() || incoming.title.length > 200) throw new Error();
      incoming.data.state = check[1]!.toLowerCase() === 'x' ? 'done' : incoming.data.state === 'done' ? 'todo' : incoming.data.state;
      const record = snapshot.records.find((r) => r.kind === 'entity' && sameId(r.value.id, incoming.id));
      const current = record?.kind === 'entity' ? taskFor(record.value) : null;
      const issues: string[] = [];
      if (seen.has(incoming.id.toLowerCase())) result.issues.push(`Línea ${lineNumber}: ID duplicado ${incoming.id}.`);
      seen.add(incoming.id.toLowerCase());
      if (record && !current) issues.push('ID ocupado por otro tipo o una tarea no editable; no se reasigna.');
      if (incoming.contentResourceId && !snapshot.records.some((r) => r.kind === 'resource' && sameId(r.value.id, incoming.contentResourceId!))) issues.push('Recurso de contenido ausente: ' + incoming.contentResourceId);
      const changes = current ? [...(current.title === incoming.title ? [] : ['title']), ...(canonical(current.data) === canonical(incoming.data) ? [] : ['data']), ...(current.contentResourceId === incoming.contentResourceId ? [] : ['contentResourceId'])] : ['create'];
      result.rows.push({ id: incoming.id, line: lineNumber, incoming, current, changes, issues,
        match: issues.length ? 'blocked' : !current ? 'create' : !changes.length ? 'unchanged' : current.revision !== incoming.revision ? 'conflict' : 'update' });
    } catch { result.issues.push(`Línea ${lineNumber}: tarea/metadata inválida; la fuente no se modifica.`); }
  }
  const project = snapshot.records.find((r) => r.kind === 'project');
  if (headers !== 1 || !result.projectId) result.issues.push('Se requiere una única cabecera A3 versionada.');
  else if (project?.kind !== 'project' || !sameId(project.value.projectId, result.projectId)) result.issues.push('La checklist pertenece a otro proyecto: no se mezcla el contexto.');
  if (!result.rows.length || result.rows.length > 128) result.issues.push('Selecciona entre 1 y 128 tareas por intercambio.');
  const plan = planChecklistImport(snapshot, result.rows, result.rows.filter((row) => row.match !== 'blocked').map((row) => ({ id: row.id, decision: 'import' })));
  result.issues.push(...plan.issues);
  return result;
}

/** Explicit choices also resolve a stale source: the host must bind them to a fresh preview snapshot. */
export function planChecklistImport(snapshot: DomainSnapshot, rows: ChecklistRow[], choices: ChecklistChoice[]): { operations: PlanningOperation[]; issues: string[] } {
  const issues: string[] = [], operations: PlanningOperation[] = [];
  if (!choices.length || choices.length > 128 || new Set(choices.map((c) => c.id.toLowerCase())).size !== choices.length) return { operations, issues: ['Decisiones ausentes o duplicadas.'] };
  for (const choice of choices) {
    const row = rows.find((r) => sameId(r.id, choice.id));
    if (!row || !['import', 'keep'].includes(choice.decision)) { issues.push('Decisión sin correspondencia por ID.'); continue; }
    if (choice.decision === 'keep' || row.match === 'unchanged') continue;
    if (row.match === 'blocked') { issues.push(...row.issues); continue; }
    const task = row.incoming;
    operations.push(row.current ? { action: 'update', entityId: row.current.id, expectedRevision: row.current.revision, title: task.title, data: task.data,
      contentResourceId: task.contentResourceId ?? null } : { action: 'create', entityId: task.id, title: task.title, data: task.data, ...(task.contentResourceId ? { contentResourceId: task.contentResourceId } : {}) });
  }
  // Validate the proposed graph, including cross-row dependencies and existing evidence targets.
  // Synthetic history is preview-only. Real actor/time/history are always supplied by the host command.
  const next = copy(snapshot);
  for (const op of operations) {
    let record = next.records.find((r) => r.kind === 'entity' && sameId(r.value.id, op.entityId));
    if (!record) { record = { kind: 'entity', value: { schemaVersion: '1.0.0', id: op.entityId, revision: 1, type: 'a3.planning.task', typeVersion: PLANNING_VERSION,
      title: op.title, tags: [], ports: [], bindings: {}, extensions: {}, properties: { [PLANNING_HISTORY_KEY]: [{ operationId: op.entityId, actor: { kind: 'user', id: 'preview' }, at: '2000-01-01T00:00:00.000Z', action: 'create', toState: (op.data as TaskData).state }] } } }; next.records.push(record); }
    if (record.kind !== 'entity') continue;
    record.value.properties[PLANNING_KEY] = copy(op.data) as Entity['properties'][string];
    const history = planningHistory(record.value); if (history?.at(-1)) history.at(-1)!.toState = (op.data as TaskData).state;
  }
  const old = new Set(validatePlanningSnapshot(snapshot).map((d) => canonical(d)));
  for (const diagnostic of validatePlanningSnapshot(next)) if (!old.has(canonical(diagnostic))) issues.push(`${diagnostic.ref?.id}: ${diagnostic.detail}: ${diagnostic.message}`);
  return { operations, issues: [...new Set(issues)] };
}

export interface PlanningTraceLink { kind: 'entity' | 'resource' | 'relation' | 'workspace' | 'placement'; id: string; label: string; role: string; missing: boolean; workspaceId?: string; }
export interface PlanningTraceRow { id: string; kind: string; title: string; links: PlanningTraceLink[]; }
export interface PlanningTraceability { rows: PlanningTraceRow[]; criteriaWithoutEvidence: { id: string; title: string }[]; }
export function projectPlanningTraceability(snapshot: DomainSnapshot): PlanningTraceability {
  const projection = projectPlanning(snapshot);
  const rows = projection.items.map((item): PlanningTraceRow => {
    const links: PlanningTraceLink[] = [];
    const link = (kind: PlanningTraceLink['kind'], id: string, role: string, workspaceId?: string) => {
      const record = snapshot.records.find((r) => r.kind === kind && 'id' in r.value && typeof r.value.id === 'string' && sameId(r.value.id, id));
      const value = record?.value;
      links.push({ kind, id, role, missing: !record, label: String(value && ('title' in value ? value.title : 'name' in value ? value.name : 'path' in value ? value.path : id) || id), ...(workspaceId ? { workspaceId } : {}) });
    };
    const data = item.data;
    if (data.kind === 'task' || data.kind === 'criterion') { if (data.storyId) link('entity', data.storyId, 'historia'); }
    if (data.kind === 'story' || data.kind === 'task') for (const id of data.dependencyIds) link('entity', id, 'dependencia');
    if ('criterionIds' in data) for (const id of data.criterionIds as string[]) link('entity', id, 'criterio');
    if (data.kind === 'task') for (const id of data.evidenceIds) link('entity', id, 'evidencia');
    if (data.kind === 'evidence') {
      const target = data.target;
      if (target.kind === 'file' || target.kind === 'capture') link('resource', target.resourceId, 'origen de evidencia');
      else if (target.kind === 'note' || target.kind === 'result') link('entity', target.entityId, 'origen de evidencia');
      else link('resource', target.repositoryResourceId as string, 'commit ' + target.hash);
    } else for (const ref of data.references) link(ref.kind, ref.id, 'referencia');
    const entity = snapshot.records.find((r) => r.kind === 'entity' && sameId(r.value.id, item.id));
    if (entity?.kind === 'entity' && entity.value.contentResourceId) link('resource', entity.value.contentResourceId, 'documento');
    for (const placement of snapshot.records) if (placement.kind === 'placement' && sameId(placement.value.entityId, item.id)) link('placement', placement.value.id, 'nodo', placement.workspaceId);
    for (const other of projection.items) if (other.data.kind === 'task' && (other.data.storyId && sameId(other.data.storyId, item.id) || other.data.criterionIds.some((id) => sameId(id, item.id)) || other.data.evidenceIds.some((id) => sameId(id, item.id)))) link('entity', other.id, 'tarea vinculada');
    return { id: item.id, kind: data.kind, title: item.title, links };
  });
  return { rows, criteriaWithoutEvidence: projection.criteriaWithoutEvidence };
}
