import { copy, isObject, sameId, UUID_PATTERN } from './data.js';
import { ER_VERSION, erData, erRelationship, erTable, mergeErData, mergeErRelation, validErOperation, validErRelationData, type ErChange } from './er.js';
import type { Diagnostic, DocumentRef, DomainRecord, DomainSnapshot, JsonValue, RecordKind } from './models.js';

interface ErDraft {
  snapshot: DomainSnapshot; require(ref: DocumentRef): DomainRecord; add(record: DomainRecord): void;
  edit<K extends RecordKind>(ref: DocumentRef, kind: K, edit: (value: import('./models.js').DocumentKinds[K]) => void): void;
}
type Fault = (detail: string, message: string, ref?: DocumentRef, code?: Diagnostic['code']) => never;
export function applyErChange(draft: ErDraft, payload: ErChange, fail: Fault): void {
  if (!payload || Object.keys(payload).some((key) => !['workspaceId', 'operation', 'ids'].includes(key)) || !UUID_PATTERN.test(payload.workspaceId) || !validErOperation(payload.operation) ||
      !isObject(payload.ids) || Object.keys(payload.ids).length !== 4 || !['entityId', 'placementId', 'relationId', 'relationViewId'].every((key) => typeof payload.ids[key as keyof typeof payload.ids] === 'string' && UUID_PATTERN.test(payload.ids[key as keyof typeof payload.ids]))) {
    fail('er-command-invalid', 'El comando ER requiere datos tipados e identidades estables.');
  }
  const { operation: op, workspaceId, ids } = payload; draft.require({ kind: 'workspace', id: workspaceId });
  const table = (id: string) => {
    const record = draft.require({ kind: 'entity', id });
    if (record.kind !== 'entity' || !erTable(record.value) || !erData(record.value)) fail('er-table-unavailable', 'La tabla requiere el tipo y las propiedades ER compatibles.');
    return record.value;
  };
  const placed = (id: string) => { const record = draft.require({ kind: 'placement', id, workspaceId }); if (record.kind !== 'placement') fail('er-placement-missing', 'La representación debe pertenecer al workspace activo.'); return table(record.value.entityId); };
  const place = (entityId: string, position: { x: number; y: number }) => draft.add({ kind: 'placement', workspaceId, value: {
    schemaVersion: '1.0.0', id: ids.placementId, revision: 1, entityId, position: copy(position), size: { width: 360, height: 300 }, style: {}, extensions: {} } });
  const view = (relationId: string, sourcePlacementId: string, targetPlacementId: string) => {
    placed(sourcePlacementId); placed(targetPlacementId);
    draft.add({ kind: 'relation-view', workspaceId, value: { schemaVersion: '1.0.0', id: ids.relationViewId, revision: 1, relationId, sourcePlacementId, targetPlacementId, waypoints: [], style: {}, extensions: {} } });
  };
  switch (op.action) {
    case 'create-table':
      draft.add({ kind: 'entity', value: { schemaVersion: '1.0.0', id: ids.entityId, revision: 1, type: 'a3.er.table', typeVersion: ER_VERSION, title: op.title.trim(), tags: [], ports: [], bindings: {}, extensions: {},
        properties: { 'a3.er': mergeErData(undefined, { fields: [], description: '', ...op.data }) as unknown as JsonValue } } });
      place(ids.entityId, op.position); break;
    case 'update-table': {
      const value = table(op.entityId), ref: DocumentRef = { kind: 'entity', id: value.id };
      if (!draft.snapshot.records.some((r) => r.kind === 'placement' && sameId(r.workspaceId, workspaceId) && sameId(r.value.entityId, value.id))) fail('er-table-unavailable', 'La tabla no está representada en este workspace.');
      if (value.revision !== op.expectedRevision) fail('revision-conflict', 'La tabla cambió; recarga antes de editar.', ref, 'REVISION_CONFLICT');
      draft.edit(ref, 'entity', (entity) => { entity.title = op.title.trim(); entity.properties['a3.er'] = mergeErData(erData(entity), op.data) as unknown as JsonValue; }); break;
    }
    case 'show-table': table(op.entityId); place(op.entityId, op.position); break;
    case 'create-relationship': {
      const source = placed(op.sourcePlacementId), target = placed(op.targetPlacementId);
      draft.add({ kind: 'relation', value: { schemaVersion: '1.0.0', id: ids.relationId, revision: 1, type: 'a3.er.relationship', typeVersion: ER_VERSION,
        source: { entityId: source.id }, target: { entityId: target.id }, properties: { 'a3.er': copy(op.data) as unknown as JsonValue }, extensions: {} } });
      view(ids.relationId, op.sourcePlacementId, op.targetPlacementId); break;
    }
    case 'update-relationship': {
      const ref: DocumentRef = { kind: 'relation', id: op.relationId }, record = draft.require(ref);
      if (record.kind !== 'relation' || !erRelationship(record.value) || !validErRelationData(record.value.properties['a3.er']) ||
          !draft.snapshot.records.some((r) => r.kind === 'relation-view' && sameId(r.workspaceId, workspaceId) && sameId(r.value.relationId, op.relationId))) fail('er-relationship-unavailable', 'La relación ER debe tener una vista en este workspace.');
      if (record.value.revision !== op.expectedRevision) fail('revision-conflict', 'La relación ER cambió; recarga antes de editar.', ref, 'REVISION_CONFLICT');
      draft.edit(ref, 'relation', (relation) => { relation.properties['a3.er'] = mergeErRelation(relation.properties['a3.er'] as unknown as typeof op.data, op.data) as unknown as JsonValue; }); break;
    }
    case 'show-relationship': {
      const record = draft.require({ kind: 'relation', id: op.relationId });
      if (record.kind !== 'relation' || !erRelationship(record.value) || !validErRelationData(record.value.properties['a3.er'])) fail('er-relationship-unavailable', 'La relación ER requiere metadatos compatibles.');
      view(op.relationId, op.sourcePlacementId, op.targetPlacementId); break;
    }
  }
}
