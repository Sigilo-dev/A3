import { copy, isObject, sameId, UUID_PATTERN } from './data.js';
import { UML_VERSION, mergeUmlData, mergeUmlRelation, umlData, umlKind, umlRelationKind, validUmlOperation, validUmlRelationData, type UmlChange } from './uml.js';
import type { Diagnostic, DocumentKinds, DocumentRef, DomainRecord, DomainSnapshot, JsonValue, RecordKind } from './models.js';

interface UmlDraft {
  snapshot: DomainSnapshot; require(ref: DocumentRef): DomainRecord; add(record: DomainRecord): void;
  edit<K extends RecordKind>(ref: DocumentRef, kind: K, edit: (value: DocumentKinds[K]) => void): void;
}
type Fault = (detail: string, message: string, ref?: DocumentRef, code?: Diagnostic['code']) => never;
export function applyUmlChange(draft: UmlDraft, payload: UmlChange, fail: Fault): void {
  if (!payload || Object.keys(payload).some((key) => !['workspaceId', 'operation', 'ids'].includes(key)) || !UUID_PATTERN.test(payload.workspaceId) ||
      !validUmlOperation(payload.operation) || !isObject(payload.ids) || Object.keys(payload.ids).length !== 4 ||
      !['entityId', 'placementId', 'relationId', 'relationViewId'].every((key) => typeof payload.ids[key as keyof typeof payload.ids] === 'string' && UUID_PATTERN.test(payload.ids[key as keyof typeof payload.ids]))) {
    fail('uml-command-invalid', 'El comando UML requiere datos tipados e identidades estables.');
  }
  const { operation: op, workspaceId, ids } = payload;
  draft.require({ kind: 'workspace', id: workspaceId });
  const element = (id: string) => {
    const r = draft.require({ kind: 'entity', id });
    if (r.kind !== 'entity' || !umlKind(r.value) || !umlData(r.value)) fail('uml-element-unavailable', 'El elemento requiere un tipo y propiedades UML compatibles.');
    return r.value;
  };
  const placed = (id: string) => { const r = draft.require({ kind: 'placement', id, workspaceId }); if (r.kind !== 'placement') fail('uml-placement-missing', 'La representación UML debe ser local al workspace.'); return element(r.value.entityId); };
  const place = (entityId: string, position: { x: number; y: number }) => draft.add({ kind: 'placement', workspaceId, value: {
    schemaVersion: '1.0.0', id: ids.placementId, revision: 1, entityId, position: copy(position), size: { width: 340, height: 280 }, style: {}, extensions: {} } });
  const relationView = (relationId: string, sourcePlacementId: string, targetPlacementId: string) => {
    placed(sourcePlacementId); placed(targetPlacementId);
    draft.add({ kind: 'relation-view', workspaceId, value: { schemaVersion: '1.0.0', id: ids.relationViewId, revision: 1, relationId, sourcePlacementId, targetPlacementId, waypoints: [], style: {}, extensions: {} } });
  };
  const existingRelation = (id: string, expectedRevision: number) => {
    const ref: DocumentRef = { kind: 'relation', id }, r = draft.require(ref);
    if (r.kind !== 'relation' || !umlRelationKind(r.value) || !validUmlRelationData(r.value.properties['a3.uml']) || !draft.snapshot.records.some((v) => v.kind === 'relation-view' && sameId(v.workspaceId, workspaceId) && sameId(v.value.relationId, id))) fail('uml-relationship-unavailable', 'La relación UML debe estar representada en este workspace.');
    if (r.value.revision !== expectedRevision) fail('revision-conflict', 'La relación cambió; recarga antes de editar.', ref, 'REVISION_CONFLICT');
    return r;
  };
  switch (op.action) {
    case 'create-element': {
      draft.add({ kind: 'entity', value: { schemaVersion: '1.0.0', id: ids.entityId, revision: 1, type: `a3.uml.${op.kind}`, typeVersion: UML_VERSION, title: op.title.trim(),
        tags: [], ports: [], bindings: {}, extensions: {}, properties: { 'a3.uml': mergeUmlData(undefined, op.data) as unknown as JsonValue } } });
      place(ids.entityId, op.position); break;
    }
    case 'update-element': {
      const e = element(op.entityId), ref: DocumentRef = { kind: 'entity', id: e.id };
      if (!draft.snapshot.records.some((r) => r.kind === 'placement' && sameId(r.workspaceId, workspaceId) && sameId(r.value.entityId, e.id))) fail('uml-element-unavailable', 'El elemento no está representado en este workspace.');
      if (e.revision !== op.expectedRevision) fail('revision-conflict', 'El clasificador cambió; recarga antes de editar.', ref, 'REVISION_CONFLICT');
      draft.edit(ref, 'entity', (value) => { value.title = op.title.trim(); value.properties['a3.uml'] = mergeUmlData(umlData(value), op.data) as unknown as JsonValue; }); break;
    }
    case 'show-element': element(op.entityId); place(op.entityId, op.position); break;
    case 'create-relationship': {
      const source = placed(op.sourcePlacementId), target = placed(op.targetPlacementId);
      draft.add({ kind: 'relation', value: { schemaVersion: '1.0.0', id: ids.relationId, revision: 1, type: `a3.uml.${op.kind}`, typeVersion: UML_VERSION,
        source: { entityId: source.id }, target: { entityId: target.id }, properties: { 'a3.uml': copy(op.data) as unknown as JsonValue }, extensions: {} } });
      relationView(ids.relationId, op.sourcePlacementId, op.targetPlacementId); break;
    }
    case 'update-relationship': {
      const r = existingRelation(op.relationId, op.expectedRevision);
      draft.edit({ kind: 'relation', id: r.value.id }, 'relation', (value) => { value.properties['a3.uml'] = mergeUmlRelation(value.properties['a3.uml'] as unknown as typeof op.data, op.data) as unknown as JsonValue; }); break;
    }
    case 'show-relationship': {
      const r = draft.require({ kind: 'relation', id: op.relationId });
      if (r.kind !== 'relation' || !umlRelationKind(r.value) || !validUmlRelationData(r.value.properties['a3.uml'])) fail('uml-relationship-unavailable', 'La relación requiere semántica UML compatible.');
      relationView(op.relationId, op.sourcePlacementId, op.targetPlacementId); break;
    }
  }
}
