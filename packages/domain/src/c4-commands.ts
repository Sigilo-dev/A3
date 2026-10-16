import { copy, isObject, sameId, UUID_PATTERN } from './data.js';
import { C4_VERSION, c4Category, c4Data, c4View, isC4Relationship, validC4Operation, type C4Change, type C4ElementData, type C4ElementPatch, type C4ViewData } from './c4.js';
import type { Diagnostic, DocumentKinds, DocumentRef, DomainRecord, DomainSnapshot, Entity, JsonValue, RecordKind, TypeRegistry } from './models.js';

interface C4Draft {
  snapshot: DomainSnapshot; registry: TypeRegistry;
  require(ref: DocumentRef): DomainRecord; add(record: DomainRecord): void;
  edit<K extends RecordKind>(ref: DocumentRef, kind: K, edit: (value: DocumentKinds[K]) => void): void;
}
type Fault = (detail: string, message: string, ref?: DocumentRef, code?: Diagnostic['code']) => never;
function mergeData(old: C4ElementData | undefined, patch: C4ElementPatch): C4ElementData {
  const data: C4ElementData = { description: '', technology: '', url: '', external: false, ...copy(old ?? {}) };
  for (const [key, value] of Object.entries(patch)) { if (value === null) delete data[key]; else data[key] = value; }
  return data;
}
export function applyC4Change(draft: C4Draft, payload: C4Change, fail: Fault): void {
  if (!payload || Object.keys(payload).some((key) => !['workspaceId', 'operation', 'ids'].includes(key)) || !UUID_PATTERN.test(payload.workspaceId) ||
      !validC4Operation(payload.operation) || !isObject(payload.ids) || Object.keys(payload.ids).length !== 5 ||
      !['entityId', 'placementId', 'relationId', 'relationViewId', 'diagramId'].every((key) => typeof payload.ids[key as keyof typeof payload.ids] === 'string' && UUID_PATTERN.test(payload.ids[key as keyof typeof payload.ids]))) {
    fail('c4-command-invalid', 'El comando C4 requiere una operación tipada e identidades estables.');
  }
  const { operation: op, workspaceId, ids } = payload;
  const workspaceRef: DocumentRef = { kind: 'workspace', id: workspaceId };
  if (op.action === 'configure-view' && op.newWorkspace) {
    draft.add({ kind: 'workspace', value: { schemaVersion: '1.0.0', id: workspaceId, revision: 1, name: op.title.trim(), viewport: { x: 0, y: 0, zoom: 1 }, properties: { 'a3.c4.diagram-id': ids.diagramId }, extensions: {} } });
  } else draft.require(workspaceRef);
  const entity = (id: string): Entity => {
    const r = draft.require({ kind: 'entity', id });
    if (r.kind !== 'entity' || !c4Category(r.value, draft.registry)) fail('c4-type-mapping-missing', 'El elemento requiere una categoría C4 explícita y disponible.');
    return r.value;
  };
  const placed = (id: string): Entity => {
    const r = draft.require({ kind: 'placement', id, workspaceId });
    if (r.kind !== 'placement') fail('c4-placement-missing', 'La representación debe existir en el workspace.');
    return entity(r.value.entityId);
  };
  const placement = (entityId: string, position: { x: number; y: number }): void => {
    draft.add({ kind: 'placement', workspaceId, value: { schemaVersion: '1.0.0', id: ids.placementId, revision: 1, entityId,
      position: copy(position), size: { width: 300, height: 210 }, style: {}, extensions: {} } });
  };
  const relationshipView = (relationId: string, sourcePlacementId: string, targetPlacementId: string): void => {
    placed(sourcePlacementId); placed(targetPlacementId);
    draft.add({ kind: 'relation-view', workspaceId, value: { schemaVersion: '1.0.0', id: ids.relationViewId, revision: 1, relationId,
      sourcePlacementId, targetPlacementId, waypoints: [], style: {}, extensions: {} } });
  };
  switch (op.action) {
    case 'create-element': {
      const value: Entity = { schemaVersion: '1.0.0', id: ids.entityId, revision: 1, type: op.typeName, typeVersion: op.typeVersion, title: op.title.trim(),
        tags: [], properties: { 'a3.c4': mergeData(undefined, op.data) as unknown as JsonValue }, ports: [], bindings: {}, extensions: {} };
      if (!c4Category(value, draft.registry)) fail('c4-type-mapping-missing', 'El tipo debe declarar su categoría C4; el nombre no se interpreta.');
      draft.add({ kind: 'entity', value }); placement(value.id, op.position); break;
    }
    case 'update-element': {
      const value = entity(op.entityId);
      if (value.revision !== op.expectedRevision) fail('revision-conflict', 'El elemento cambió; recarga el inspector.', { kind: 'entity', id: value.id }, 'REVISION_CONFLICT');
      draft.edit({ kind: 'entity', id: value.id }, 'entity', (next) => {
        next.title = op.title.trim(); next.tags = copy(op.tags); next.properties['a3.c4'] = mergeData(c4Data(next), op.data) as unknown as JsonValue;
      }); break;
    }
    case 'show-element': entity(op.entityId); placement(op.entityId, op.position); break;
    case 'create-relationship': {
      const source = placed(op.sourcePlacementId), target = placed(op.targetPlacementId);
      draft.add({ kind: 'relation', value: { schemaVersion: '1.0.0', id: ids.relationId, revision: 1, type: 'a3.c4.relationship', typeVersion: C4_VERSION,
        source: { entityId: source.id }, target: { entityId: target.id }, properties: { 'a3.c4': { description: op.description.trim(), protocol: op.protocol } }, extensions: {} } });
      relationshipView(ids.relationId, op.sourcePlacementId, op.targetPlacementId); break;
    }
    case 'update-relationship': {
      const ref: DocumentRef = { kind: 'relation', id: op.relationId }, r = draft.require(ref);
      if (r.kind !== 'relation' || !isC4Relationship(r.value) || !draft.snapshot.records.some((v) => v.kind === 'relation-view' && sameId(v.workspaceId, workspaceId) && sameId(v.value.relationId, op.relationId))) fail('c4-relationship-missing', 'La relación C4 no está representada aquí.');
      if (r.value.revision !== op.expectedRevision) fail('revision-conflict', 'La relación cambió; recarga antes de editar.', ref, 'REVISION_CONFLICT');
      draft.edit(ref, 'relation', (next) => { next.properties['a3.c4'] = { ...(next.properties['a3.c4'] as Record<string, JsonValue>), description: op.description.trim(), protocol: op.protocol }; }); break;
    }
    case 'show-relationship': {
      const r = draft.require({ kind: 'relation', id: op.relationId });
      if (r.kind !== 'relation' || !isC4Relationship(r.value)) fail('c4-relationship-missing', 'La relación requiere reglas C4 soportadas.');
      relationshipView(op.relationId, op.sourcePlacementId, op.targetPlacementId); break;
    }
    case 'configure-view': {
      const workspace = draft.require(workspaceRef);
      if (workspace.kind !== 'workspace') fail('c4-workspace-missing', 'El workspace no está disponible.');
      const boundId = workspace.value.properties['a3.c4.diagram-id'];
      if (boundId && boundId !== ids.diagramId) fail('c4-view-binding', 'El workspace ya referencia otro documento C4.');
      const existing = draft.snapshot.records.find((r) => r.kind === 'entity' && sameId(r.value.id, ids.diagramId));
      if (existing && existing.value.revision !== op.expectedDiagramRevision) fail('revision-conflict', 'El documento de vista cambió; recarga su configuración.', { kind: 'entity', id: ids.diagramId }, 'REVISION_CONFLICT');
      const old = existing?.kind === 'entity' ? c4View(existing.value) : undefined;
      if (existing && !old) fail('c4-view-authority-required', 'Esta operación requiere una vista nativa compatible con autoridad a3-model; conserva la fuente original.');
      if (old && old.kind !== op.kind && old.steps.length) fail('c4-view-has-steps', 'Vacía explícitamente la secuencia antes de cambiar de familia de vista.');
      const view: C4ViewData = { ...copy(old ?? {}), version: C4_VERSION, workspaceId, kind: op.kind, steps: old?.steps ?? [] };
      delete view.scopeEntityId; delete view.environment;
      if (op.scopeEntityId) view.scopeEntityId = op.scopeEntityId;
      if (op.environment) view.environment = op.environment;
      if (existing) draft.edit({ kind: 'entity', id: ids.diagramId }, 'entity', (next) => { next.title = op.title.trim(); next.properties['a3.c4.view'] = view as unknown as JsonValue; });
      else draft.add({ kind: 'entity', value: { schemaVersion: '1.0.0', id: ids.diagramId, revision: 1, type: 'a3.c4.diagram', typeVersion: C4_VERSION,
        title: op.title.trim(), tags: [], ports: [], bindings: {}, properties: { 'a3.diagram.authority': 'a3-model', 'a3.c4.view': view as unknown as JsonValue }, extensions: {} } });
      if (!op.newWorkspace && !boundId) draft.edit(workspaceRef, 'workspace', (next) => { next.properties['a3.c4.diagram-id'] = ids.diagramId; });
      break;
    }
    case 'set-steps': {
      const ref: DocumentRef = { kind: 'entity', id: op.diagramId }, record = draft.require(ref);
      const view = record.kind === 'entity' ? c4View(record.value) : undefined;
      if (!view || view.kind !== 'dynamic' || !sameId(view.workspaceId, workspaceId)) fail('c4-dynamic-view-required', 'La secuencia pertenece a un documento de vista dinámica del workspace.');
      if (record.value.revision !== op.expectedRevision) fail('revision-conflict', 'La secuencia cambió; recarga antes de ordenarla.', ref, 'REVISION_CONFLICT');
      draft.edit(ref, 'entity', (next) => { next.properties['a3.c4.view'] = { ...view, steps: [...op.steps].sort((a, b) => a.order - b.order)
        .map((step) => ({ ...view.steps.find((old) => sameId(old.id, step.id)), ...copy(step) })) } as unknown as JsonValue; }); break;
    }
  }
}
