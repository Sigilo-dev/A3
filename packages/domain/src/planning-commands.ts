import { canonical, copy, isObject, UUID_PATTERN } from './data.js';
import { PLANNING_HISTORY_KEY, PLANNING_KEY, PLANNING_VERSION, planningData, planningHistory, validPlanningActor, validPlanningData, validPlanningDate,
  type PlanningActivity, type PlanningChange, type PlanningData } from './planning.js';
import type { Actor, Diagnostic, DocumentKinds, DocumentRef, DomainRecord, DomainSnapshot, JsonValue, RecordKind } from './models.js';

interface PlanningDraft {
  snapshot: DomainSnapshot; require(ref: DocumentRef): DomainRecord; add(record: DomainRecord): void;
  edit<K extends RecordKind>(ref: DocumentRef, kind: K, edit: (value: DocumentKinds[K]) => void): void;
}
type Fault = (detail: string, message: string, ref?: DocumentRef, code?: Diagnostic['code']) => never;

/** One logical batch may create a story and its criteria together. Revisions/journal remain host-owned. */
export function applyPlanningChange(draft: PlanningDraft, payload: PlanningChange, actor: Actor, operationId: string, fail: Fault): void {
  if (!validPlanningActor(actor)) fail('planning-actor-invalid', 'Solo una persona, agente o extensión autenticada puede registrar planificación.');
  if (!isObject(payload) || Object.keys(payload).some((key) => !['occurredAt', 'operations'].includes(key)) || !validPlanningDate(payload.occurredAt) ||
      !Array.isArray(payload.operations) || payload.operations.length < 1 || payload.operations.length > 128) fail('planning-command-invalid', 'El lote requiere fecha UTC y entre 1 y 128 operaciones.');
  const seen = new Set<string>();
  for (const op of payload.operations) {
    if (!isObject(op) || !['create', 'update'].includes(String(op.action)) || !UUID_PATTERN.test(String(op.entityId)) || seen.has(String(op.entityId).toLowerCase()) ||
        typeof op.title !== 'string' || !op.title.trim() || op.title.length > 200 || !validPlanningData(op.data, true) ||
        Object.keys(op).some((key) => !(op.action === 'create' ? ['action', 'entityId', 'title', 'data', 'contentResourceId'] : ['action', 'entityId', 'expectedRevision', 'title', 'data', 'contentResourceId']).includes(key)) ||
        op.contentResourceId !== undefined && !(op.action === 'update' && op.contentResourceId === null) && !UUID_PATTERN.test(String(op.contentResourceId)) ||
        op.action === 'update' && (!Number.isSafeInteger(op.expectedRevision) || Number(op.expectedRevision) < 1)) fail('planning-command-invalid', 'Operación de planificación inválida o identidad repetida.');
    seen.add(op.entityId.toLowerCase());
    const ref: DocumentRef = { kind: 'entity', id: op.entityId };
    const old = op.action === 'update' ? draft.require(ref) : undefined;
    const before = old?.kind === 'entity' ? planningData(old.value) : undefined;
    const history = old?.kind === 'entity' ? planningHistory(old.value) : undefined;
    if (op.action === 'update' && (!before || !history || old?.kind !== 'entity')) fail('planning-entity-unavailable', 'El tipo, las propiedades o el historial requieren reparación explícita.', ref);
    if (op.action === 'update' && old && old.value.revision !== op.expectedRevision) fail('planning-revision-conflict', 'La entidad cambió; recarga antes de editar.', ref, 'REVISION_CONFLICT');
    if (before && before.kind !== op.data.kind) fail('planning-kind-immutable', 'La familia de la entidad no cambia con una edición.', ref);
    if (history?.some((event) => event.operationId.toLowerCase() === operationId.toLowerCase())) fail('planning-operation-repeated', 'Este evento ya fue registrado; vuelve a leer su resultado.', ref, 'REVISION_CONFLICT');
    if (before?.kind === 'evidence' && op.data.kind === 'evidence' && canonical(before.target) !== canonical(op.data.target)) fail('planning-evidence-target-immutable', 'Crea otra evidencia para un destino diferente; conserva el origen registrado.', ref);
    const next = { ...copy(before ?? {}), ...copy(op.data) } as PlanningData;
    if (next.kind === 'task' && op.data.kind === 'task') {
      if (op.data.assignee === undefined) delete next.assignee;
      else if (before?.kind === 'task' && before.assignee?.kind === op.data.assignee.kind && before.assignee.id === op.data.assignee.id) next.assignee = { ...copy(before.assignee), ...copy(op.data.assignee) };
      if (op.data.storyId === undefined) delete next.storyId;
    }
    if (next.kind !== 'evidence' && before && before.kind !== 'evidence') {
      next.references = next.references.map((reference) => ({ ...copy(before.references.find((r) => r.kind === reference.kind && r.id.toLowerCase() === reference.id.toLowerCase()) ?? {}), ...reference }));
    }
    if (next.kind === 'evidence') {
      next.recordedBy = copy(before?.kind === 'evidence' ? before.recordedBy : actor);
      next.recordedAt = before?.kind === 'evidence' ? before.recordedAt : payload.occurredAt;
    }
    const event: PlanningActivity = { operationId, actor: copy(actor), at: payload.occurredAt, action: op.action,
      ...(before?.kind === 'task' ? { fromState: before.state } : {}), ...(next.kind === 'task' ? { toState: next.state } : {}) };
    const data = next as unknown as JsonValue, events = [...copy(history ?? []), event] as unknown as JsonValue;
    if (op.action === 'create') draft.add({ kind: 'entity', value: {
      schemaVersion: '1.0.0', id: op.entityId, revision: 1, type: 'a3.planning.' + next.kind, typeVersion: PLANNING_VERSION, title: op.title.trim(),
      ...(op.contentResourceId ? { contentResourceId: op.contentResourceId } : {}), tags: [], ports: [], bindings: {}, extensions: {},
      properties: { [PLANNING_KEY]: data, [PLANNING_HISTORY_KEY]: events }
    } });
    else draft.edit(ref, 'entity', (entity) => {
      entity.title = op.title.trim(); entity.properties[PLANNING_KEY] = data; entity.properties[PLANNING_HISTORY_KEY] = events;
      if (op.contentResourceId === null) delete entity.contentResourceId;
      else if (op.contentResourceId !== undefined) entity.contentResourceId = op.contentResourceId;
    });
  }
}
