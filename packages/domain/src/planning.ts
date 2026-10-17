import { canonical, diagnostic, isObject, sameId, UUID_PATTERN } from './data.js';
import type { Actor, Diagnostic, DomainSnapshot, Entity, NodeType, OpenData } from './models.js';

export const PLANNING_VERSION = '1.0.0';
export const PLANNING_KEY = 'a3.planning';
export const PLANNING_HISTORY_KEY = 'a3.planning.history';
export const TASK_STATES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export const PLANNING_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export type TaskState = typeof TASK_STATES[number];
export type PlanningPriority = typeof PLANNING_PRIORITIES[number];
export type PlanningKind = 'story' | 'task' | 'criterion' | 'evidence';
export type PlanningActor = Omit<Actor, 'kind'> & { kind: 'user' | 'agent' | 'extension' };
export type PlanningReference = OpenData & ({ kind: 'entity' | 'resource' | 'relation' | 'workspace'; id: string });
export interface StoryData extends OpenData {
  kind: 'story'; actor: string; need: string; goal: string; priority: PlanningPriority;
  criterionIds: string[]; dependencyIds: string[]; references: PlanningReference[];
}
export interface TaskData extends OpenData {
  kind: 'task'; state: TaskState; priority: PlanningPriority; assignee?: PlanningActor; storyId?: string;
  dependencyIds: string[]; criterionIds: string[]; evidenceIds: string[]; references: PlanningReference[];
}
export interface CriterionData extends OpenData { kind: 'criterion'; storyId: string; references: PlanningReference[]; }
export type EvidenceTarget = OpenData & (
  { kind: 'file' | 'capture'; resourceId: string } |
  { kind: 'result' | 'note'; entityId: string } |
  { kind: 'commit'; repositoryResourceId: string; hash: string }
);
export interface EvidenceData extends OpenData {
  kind: 'evidence'; target: EvidenceTarget; criterionIds: string[]; recordedBy: PlanningActor; recordedAt: string;
}
export type PlanningData = StoryData | TaskData | CriterionData | EvidenceData;
export interface EvidenceInput extends OpenData { kind: 'evidence'; target: EvidenceTarget; criterionIds: string[]; }
export type PlanningInput = StoryData | TaskData | CriterionData | EvidenceInput;
export interface PlanningActivity extends OpenData {
  operationId: string; actor: PlanningActor; at: string; action: 'create' | 'update'; fromState?: TaskState; toState?: TaskState;
  evidenceIds?: string[];
}
export type PlanningOperation =
  { action: 'create'; entityId: string; title: string; data: PlanningInput; contentResourceId?: string } |
  { action: 'update'; entityId: string; expectedRevision: number; title: string; data: PlanningInput; contentResourceId?: string | null };
export interface PlanningChange { occurredAt: string; operations: PlanningOperation[]; }

const uuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);
const text = (value: unknown, max = 20000): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1024 && value.every(uuid) && new Set(value.map((id) => id.toLowerCase())).size === value.length;
export const validPlanningActor = (value: unknown): value is PlanningActor => isObject(value) && ['user', 'agent', 'extension'].includes(String(value.kind)) && text(value.id, 256);
export const validPlanningDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === (value.length === 20 ? value.slice(0, -1) + '.000Z' : value);
export function planningKind(entity: Pick<Entity, 'type' | 'typeVersion'>): PlanningKind | undefined {
  if (entity.typeVersion !== PLANNING_VERSION) return undefined;
  return (['story', 'task', 'criterion', 'evidence'] as const).find((kind) => entity.type === 'a3.planning.' + kind);
}
export function planningNodeDefinition(type: string): NodeType | undefined {
  if (!planningKind({ type, typeVersion: PLANNING_VERSION })) return undefined;
  return { name: type, version: PLANNING_VERSION, packageId: 'a3.builtin.planning', fields: [], ports: [], bindingFields: [], extensions: {} };
}
export function validEvidenceTarget(value: unknown): value is EvidenceTarget {
  if (!isObject(value)) return false;
  if (value.kind === 'file' || value.kind === 'capture') return uuid(value.resourceId);
  if (value.kind === 'note' || value.kind === 'result') return uuid(value.entityId);
  return value.kind === 'commit' && uuid(value.repositoryResourceId) && typeof value.hash === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.hash);
}
export function validPlanningData(value: unknown, input?: false): value is PlanningData;
export function validPlanningData(value: unknown, input: true): value is PlanningInput;
export function validPlanningData(value: unknown, input = false): boolean {
  if (!isObject(value)) return false;
  const refs = (v: unknown) => Array.isArray(v) && v.length <= 1024 && v.every((ref) => isObject(ref) && ['entity', 'resource', 'relation', 'workspace'].includes(String(ref.kind)) && uuid(ref.id));
  switch (value.kind) {
    case 'story': return text(value.actor, 1000) && text(value.need) && text(value.goal) && PLANNING_PRIORITIES.includes(value.priority as PlanningPriority) && ids(value.criterionIds) && ids(value.dependencyIds) && refs(value.references);
    case 'task': return TASK_STATES.includes(value.state as TaskState) && PLANNING_PRIORITIES.includes(value.priority as PlanningPriority) && (value.assignee === undefined || validPlanningActor(value.assignee)) && (value.storyId === undefined || uuid(value.storyId)) && ids(value.dependencyIds) && ids(value.criterionIds) && ids(value.evidenceIds) && refs(value.references);
    case 'criterion': return uuid(value.storyId) && refs(value.references);
    case 'evidence': return validEvidenceTarget(value.target) && ids(value.criterionIds) && (input ? value.recordedBy === undefined && value.recordedAt === undefined : validPlanningActor(value.recordedBy) && validPlanningDate(value.recordedAt));
    default: return false;
  }
}
export function planningData(entity: Pick<Entity, 'type' | 'typeVersion' | 'properties'>): PlanningData | undefined {
  const data = entity.properties[PLANNING_KEY];
  return validPlanningData(data) && data.kind === planningKind(entity) ? data : undefined;
}
export function planningHistory(entity: Pick<Entity, 'properties'>): PlanningActivity[] | undefined {
  const value = entity.properties[PLANNING_HISTORY_KEY];
  return Array.isArray(value) && value.length > 0 && value.every((event) => isObject(event) && uuid(event.operationId) && validPlanningActor(event.actor) && validPlanningDate(event.at) &&
    ['create', 'update'].includes(String(event.action)) && (event.fromState === undefined || TASK_STATES.includes(event.fromState as TaskState)) &&
    (event.toState === undefined || TASK_STATES.includes(event.toState as TaskState)) && (event.evidenceIds === undefined || ids(event.evidenceIds))) ? value as unknown as PlanningActivity[] : undefined;
}

/** Cross-document planning semantics. Visual edges and presentation never enter this graph. */
export function validatePlanningSnapshot(snapshot: DomainSnapshot): Diagnostic[] {
  const entities = new Map(snapshot.records.flatMap((r) => r.kind === 'entity' ? [[r.value.id.toLowerCase(), r.value] as const] : []));
  const diagnostics: Diagnostic[] = [];
  const report = (entity: Entity, detail: string, message: string) => diagnostics.push(diagnostic(detail, message, { kind: 'entity', id: entity.id }));
  const dataFor = (id: string) => { const e = entities.get(id.toLowerCase()); return e ? planningData(e) : undefined; };
  const has = (kind: string, id: string) => snapshot.records.some((r) => r.kind === kind && 'id' in r.value && typeof r.value.id === 'string' && sameId(r.value.id, id));
  for (const entity of entities.values()) {
    if (!planningKind(entity)) continue;
    const data = planningData(entity), history = planningHistory(entity);
    if (!data || !history) { report(entity, 'planning-data-invalid', 'Propiedades o historial de planificación inválidos; conserva la fuente.'); continue; }
    if (new Set(history.map((entry) => entry.operationId.toLowerCase())).size !== history.length || history[0]?.action !== 'create' || history.slice(1).some((event) => event.action !== 'update')) report(entity, 'planning-history-invalid', 'El historial requiere creación inicial e IDs de operación únicos.');
    if (data.kind === 'task' && (history.at(-1)?.toState !== data.state || history[0]?.fromState !== undefined || history.some((event, index) =>
        event.toState === undefined || index > 0 && event.fromState !== history[index - 1]?.toState))) report(entity, 'planning-state-history-mismatch', 'El historial debe conservar la secuencia de estados y terminar en el estado actual.');
    if (data.kind === 'story' || data.kind === 'task') {
      for (const id of data.dependencyIds) if (sameId(id, entity.id) || dataFor(id)?.kind !== data.kind) report(entity, 'planning-dependency-invalid', 'La dependencia debe apuntar a otra entidad de la misma familia.');
      for (const id of data.criterionIds) {
        const criterion = dataFor(id);
        if (criterion?.kind !== 'criterion' || data.kind === 'story' && !sameId(criterion.storyId, entity.id) || data.kind === 'task' && data.storyId && criterion?.kind === 'criterion' && !sameId(criterion.storyId, data.storyId)) report(entity, 'planning-criterion-invalid', 'El criterio debe existir y pertenecer a la historia indicada.');
      }
    }
    if (data.kind === 'criterion') {
      const story = dataFor(data.storyId);
      if (story?.kind !== 'story' || !story.criterionIds.some((id) => sameId(id, entity.id))) report(entity, 'planning-story-criterion-mismatch', 'Historia y criterio deben referenciarse mutuamente en el mismo lote.');
    }
    if (data.kind === 'task') {
      if (data.storyId && dataFor(data.storyId)?.kind !== 'story') report(entity, 'planning-story-missing', 'La historia vinculada no existe.');
      for (const id of data.evidenceIds) {
        const evidence = dataFor(id);
        if (evidence?.kind !== 'evidence') report(entity, 'planning-evidence-missing', 'La evidencia vinculada no existe.');
        else if (evidence.criterionIds.some((criterionId) => !data.criterionIds.some((id) => sameId(id, criterionId)))) report(entity, 'planning-evidence-criterion-mismatch', 'La evidencia debe corresponder a criterios vinculados a la tarea.');
      }
    }
    if (data.kind === 'evidence') {
      for (const id of data.criterionIds) if (dataFor(id)?.kind !== 'criterion') report(entity, 'planning-evidence-criterion-missing', 'El criterio de la evidencia no existe.');
      const target = data.target;
      const valid = target.kind === 'file' || target.kind === 'capture' ? has('resource', target.resourceId) : target.kind === 'note' || target.kind === 'result' ? !sameId(target.entityId, entity.id) && has('entity', target.entityId) : typeof target.repositoryResourceId === 'string' && has('resource', target.repositoryResourceId);
      if (!valid) report(entity, 'planning-evidence-target-missing', 'El destino de evidencia debe existir por ID; no es una ruta libre.');
      if (canonical(data.recordedBy) !== canonical(history[0]!.actor) || data.recordedAt !== history[0]!.at) report(entity, 'planning-evidence-actor-mismatch', 'El origen de evidencia debe coincidir con su evento de creación.');
    } else for (const reference of data.references) if (!has(reference.kind, reference.id)) report(entity, 'planning-reference-missing', 'La referencia elegida no existe en este proyecto.');
  }
  // Iterative DFS avoids recursion limits on large imported projects. Unknown versions stay opaque.
  const color = new Map<string, number>();
  for (const root of entities.keys()) {
    if (color.has(root)) continue;
    const stack: { id: string; exit: boolean }[] = [{ id: root, exit: false }];
    while (stack.length) {
      const current = stack.pop()!, data = dataFor(current.id);
      if (current.exit) { color.set(current.id, 2); continue; }
      if (!data || data.kind !== 'story' && data.kind !== 'task' || color.get(current.id) === 2) continue;
      if (color.get(current.id) === 1) { report(entities.get(current.id)!, 'planning-dependency-cycle', 'Las dependencias de historias/tareas forman un ciclo.'); continue; }
      color.set(current.id, 1); stack.push({ id: current.id, exit: true });
      for (const id of data.dependencyIds) if (dataFor(id)?.kind === data.kind) stack.push({ id: id.toLowerCase(), exit: false });
    }
  }
  return diagnostics;
}
