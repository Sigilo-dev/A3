import { canonical, copy, diagnostic, freeze, getRecord, isJson, isObject, refKey, refOf, revisionsOf, sameId, UUID_PATTERN } from './data.js';
import { findRelationType, validateDefinition, validateRecord, validateRegistry, validateSnapshot } from './validation.js';
import type { CommandContext, ContentEffect, Diagnostic, DocumentKinds, DocumentRef, DomainCommand, DomainRecord, DomainSnapshot, DuplicateSelection, ExpectedRevision, NodeTypeChange, Outcome, Payloads, PreparedPlan, RecordChange, RecordKind, ReversibleCanvasCommand, Resource, ResourceLocation, TypeRegistry } from './models.js';

class DomainFault extends Error {
  constructor(readonly diagnostic: Diagnostic) { super(diagnostic.message); }
}
function fail(detail: string, message: string, ref?: DocumentRef, code: Diagnostic['code'] = 'VALIDATION_FAILED'): never {
  throw new DomainFault(diagnostic(detail, message, ref, code));
}
const commands = new Set(['a3.core.create-project', 'a3.core.create-document', 'a3.core.rename', 'a3.core.update-entity',
  'a3.core.move-placement', 'a3.core.move-placements', 'a3.core.update-placement-view', 'a3.core.update-visual-edge', 'a3.core.update-drawing', 'a3.core.convert-drawings-to-node', 'a3.core.move-resource', 'a3.core.move-group', 'a3.core.set-group-members', 'a3.core.set-group-collapsed', 'a3.core.set-collection-members',
  'a3.core.set-variables', 'a3.core.set-workspace-viewport', 'a3.core.delete', 'a3.core.duplicate-selection', 'a3.core.register-node-type', 'a3.core.unregister-node-type']);
const kinds = new Set(['project', 'workspace', 'entity', 'resource', 'relation', 'placement', 'visual-edge', 'relation-view', 'group', 'collection', 'variable-set', 'drawing']);
const scoped = new Set(['placement', 'visual-edge', 'relation-view', 'group', 'drawing']);

function validRef(value: unknown): value is DocumentRef {
  return isObject(value) && typeof value.kind === 'string' && kinds.has(value.kind) &&
    typeof value.id === 'string' && UUID_PATTERN.test(value.id) &&
    (scoped.has(value.kind) ? typeof value.workspaceId === 'string' && UUID_PATTERN.test(value.workspaceId) : value.workspaceId === undefined) &&
    (value.kind === 'variable-set' ? ['project', 'workspace', 'entity'].includes(String(value.variableScope)) : value.variableScope === undefined);
}
function parseCommand(value: unknown): DomainCommand {
  if (!isJson(value) || !isObject(value) || !UUID_PATTERN.test(String(value.operationId)) || !UUID_PATTERN.test(String(value.projectId)) ||
      !isObject(value.actor) || !['user', 'agent', 'extension', 'importer'].includes(String(value.actor.kind)) ||
      typeof value.actor.id !== 'string' || !value.actor.id || typeof value.command !== 'string' || !commands.has(value.command) ||
      !isObject(value.scope) || !Array.isArray(value.scope.entityIds) || !value.scope.entityIds.every((id) => typeof id === 'string' && UUID_PATTERN.test(id)) ||
      !Array.isArray(value.expectedRevisions) || !isObject(value.payload)) fail('invalid-command', 'El envelope del comando no es válido.');
  const seen = new Set<string>();
  for (const expected of value.expectedRevisions) {
    if (!validRef(expected) || !isObject(expected) || expected.revision !== null && (!Number.isSafeInteger(expected.revision) || Number(expected.revision) < 1)) {
      fail('invalid-precondition', 'Una precondición de revisión no es válida.');
    }
    const key = refKey(expected);
    if (seen.has(key)) fail('duplicate-precondition', 'Precondición repetida.');
    seen.add(key);
  }
  const hashes = value.expectedContentHashes ?? [];
  if (!Array.isArray(hashes)) fail('invalid-content-precondition', 'Las precondiciones de contenido no son válidas.');
  const hashIds = new Set<string>();
  for (const item of hashes) {
    if (!isObject(item) || typeof item.resourceId !== 'string' || !UUID_PATTERN.test(item.resourceId) ||
        typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) fail('invalid-content-precondition', 'Las precondiciones de contenido no son válidas.');
    const key = item.resourceId.toLowerCase();
    if (hashIds.has(key)) fail('invalid-content-precondition', 'Precondición de contenido repetida.');
    hashIds.add(key);
  }
  return { ...copy(value), expectedContentHashes: copy(hashes) } as unknown as DomainCommand;
}

function baseFingerprint(snapshot: DomainSnapshot, context: CommandContext): string {
  return canonical({ records: [...snapshot.records].sort((a, b) => {
    const left = refKey(refOf(a)); const right = refKey(refOf(b));
    return left < right ? -1 : left > right ? 1 : 0;
  }),
    registry: context.registry, contentHashes: context.contentHashes });
}
function location(resource: Resource): ResourceLocation {
  switch (resource.kind) {
    case 'project-file': return { kind: resource.kind, path: resource.path };
    case 'mounted-file': return { kind: resource.kind, path: resource.path, mountId: resource.mountId };
    case 'remote-url': return { kind: resource.kind, url: resource.url };
  }
}
function relocate(resource: Resource, target: ResourceLocation): Resource {
  const keys = target.kind === 'project-file' ? ['kind', 'path'] : target.kind === 'mounted-file' ? ['kind', 'path', 'mountId'] : ['kind', 'url'];
  if (Object.keys(target).some((key) => !keys.includes(key))) fail('unsafe-resource-location', 'La ubicación no puede reemplazar identidad, revisión ni metadatos.');
  const result = copy(resource) as Record<string, unknown>;
  delete result.path; delete result.mountId; delete result.url;
  return { ...result, ...copy(target) } as Resource;
}

class Draft {
  readonly snapshot: DomainSnapshot;
  readonly registry: TypeRegistry;
  readonly effects: ContentEffect[] = [];
  readonly currentIndex = new Map<string, DomainRecord>();
  readonly originalIndex = new Map<string, DomainRecord>();
  constructor(readonly original: DomainSnapshot, readonly request: DomainCommand, readonly context: CommandContext) {
    this.snapshot = copy(original); this.registry = copy(context.registry);
    for (const record of original.records) this.originalIndex.set(refKey(refOf(record)), record);
    for (const record of this.snapshot.records) this.currentIndex.set(refKey(refOf(record)), record);
  }
  require(ref: DocumentRef): DomainRecord {
    if (!validRef(ref)) fail('invalid-reference', 'Referencia no válida.');
    const record = this.currentIndex.get(refKey(ref));
    if (!record) fail('record-missing', 'El documento no existe.', ref, 'RESOURCE_MISSING');
    return record;
  }
  edit<K extends RecordKind>(ref: DocumentRef, kind: K, edit: (value: DocumentKinds[K]) => void): void {
    const record = this.require(ref);
    if (record.kind !== kind) fail('wrong-document-kind', 'La operación no admite este documento.', ref);
    const original = this.originalIndex.get(refKey(ref));
    if (!original) fail('edit-new-document', 'No se puede editar un documento nuevo en el mismo comando.', ref);
    if (original.value.revision >= Number.MAX_SAFE_INTEGER) fail('revision-overflow', 'La revisión alcanzó el límite seguro.', ref);
    edit(record.value as DocumentKinds[K]);
    record.value.revision = original.value.revision + 1;
  }
  add(record: DomainRecord): void {
    const errors = validateRecord(record);
    if (errors.length) throw new DomainFault(errors[0]!);
    if (record.value.revision !== 1) fail('initial-revision', 'Un documento nuevo comienza en revisión 1.');
    const key = refKey(refOf(record));
    if (this.currentIndex.has(key)) fail('record-exists', 'La identidad ya existe.', refOf(record), 'REVISION_CONFLICT');
    const created = copy(record);
    this.snapshot.records.push(created); this.currentIndex.set(key, created);
  }
  remove(ref: DocumentRef): void {
    this.require(ref);
    this.snapshot.records = this.snapshot.records.filter((record) => refKey(refOf(record)) !== refKey(ref));
    this.currentIndex.delete(refKey(ref));
  }
  requireHash(resourceId: string): string {
    const expected = this.request.expectedContentHashes.find((h) => sameId(h.resourceId, resourceId));
    const actual = Object.entries(this.context.contentHashes).find(([id]) => sameId(id, resourceId))?.[1];
    if (!expected || !actual || expected.hash !== actual) fail('content-conflict', 'Falta la precondición de contenido o sus bytes cambiaron.', { kind: 'resource', id: resourceId }, 'REVISION_CONFLICT');
    return actual;
  }
}

function changesBetween(before: DomainSnapshot, after: DomainSnapshot) {
  const beforeMap = new Map(before.records.map((r) => [refKey(refOf(r)), r]));
  const afterMap = new Map(after.records.map((r) => [refKey(refOf(r)), r]));
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort().flatMap((key) => {
    const old = beforeMap.get(key) ?? null;
    const next = afterMap.get(key) ?? null;
    if (canonical(old) === canonical(next)) return [];
    return [{ ref: refOf((next ?? old)!), before: copy(old), after: copy(next) }];
  });
}

function deleteRecord(draft: Draft, payload: Payloads['a3.core.delete']): void {
  const selected = draft.require(payload.ref);
  if (selected.kind === 'project') fail('unsupported-delete', 'La eliminación del proyecto corresponde al host.', payload.ref);
  if (selected.kind === 'resource' && draft.snapshot.records.some((r) => r.kind === 'entity' && r.value.contentResourceId && sameId(r.value.contentResourceId, selected.value.id))) {
    fail('resource-in-use', 'El recurso tiene entidades que lo usan; conserva la fuente.', payload.ref);
  }
  const removed = new Set([refKey(payload.ref)]);
  if (selected.kind === 'workspace') {
    const project = draft.snapshot.records.find((r) => r.kind === 'project')!;
    if (project.kind === 'project' && sameId(project.value.defaultWorkspaceId, selected.value.id)) {
      const replacement = payload.replacementDefaultWorkspaceId;
      if (!replacement || sameId(replacement, selected.value.id) || draft.require({ kind: 'workspace', id: replacement }).kind !== 'workspace') {
        fail('default-workspace-required', 'Elige otro workspace principal antes de borrar.', payload.ref);
      }
      draft.edit(refOf(project), 'project', (value) => { value.defaultWorkspaceId = replacement; });
    }
  }
  for (const record of draft.snapshot.records) {
    if (selected.kind === 'entity' && (record.kind === 'placement' && sameId(record.value.entityId, selected.value.id) ||
      record.kind === 'relation' && [record.value.source.entityId, record.value.target.entityId].some((id) => sameId(id, selected.value.id)) ||
      record.kind === 'variable-set' && record.value.scope.kind === 'entity' && sameId(record.value.scope.ownerId, selected.value.id))) removed.add(refKey(refOf(record)));
    if (selected.kind === 'workspace' && ('workspaceId' in record && sameId(record.workspaceId, selected.value.id) ||
      record.kind === 'variable-set' && record.value.scope.kind === 'workspace' && sameId(record.value.scope.ownerId, selected.value.id))) removed.add(refKey(refOf(record)));
  }
  const removedRecords = draft.snapshot.records.filter((r) => removed.has(refKey(refOf(r))));
  for (const record of draft.snapshot.records) {
    if (record.kind === 'visual-edge' || record.kind === 'relation-view') {
      if (removedRecords.some((r) => r.kind === 'placement' && 'workspaceId' in record && sameId(r.workspaceId, record.workspaceId) &&
          [record.value.sourcePlacementId, record.value.targetPlacementId].some((id) => sameId(id, r.value.id)) ||
          r.kind === 'relation' && record.kind === 'relation-view' && sameId(record.value.relationId, r.value.id))) removed.add(refKey(refOf(record)));
    }
    if (record.kind === 'collection' && selected.kind === 'entity' && record.value.entityIds.some((id) => sameId(id, selected.value.id))) {
      draft.edit(refOf(record), 'collection', (value) => { value.entityIds = value.entityIds.filter((id) => !sameId(id, selected.value.id)); });
    }
    if (record.kind === 'group' && !removed.has(refKey(refOf(record)))) {
      const members = record.value.members.filter((member) => !removedRecords.some((r) => r.kind === member.kind && 'workspaceId' in r && sameId(r.workspaceId, record.workspaceId) && sameId(r.value.id, member.id)));
      if (members.length !== record.value.members.length) draft.edit(refOf(record), 'group', (value) => { value.members = members; });
    }
  }
  draft.snapshot.records = draft.snapshot.records.filter((r) => !removed.has(refKey(refOf(r))));
}

function convertDrawingsToNode(draft: Draft, payload: Payloads['a3.core.convert-drawings-to-node']): void {
  if (Object.keys(payload).some((key) => !['workspaceId', 'drawingIds', 'entityId', 'resourceId', 'placementId', 'title'].includes(key)) ||
      !UUID_PATTERN.test(payload.workspaceId) || !Array.isArray(payload.drawingIds) || !payload.drawingIds.length || payload.drawingIds.length > 256 ||
      new Set(payload.drawingIds.map((id) => id.toLowerCase())).size !== payload.drawingIds.length ||
      ![payload.entityId, payload.resourceId, payload.placementId].every((id) => UUID_PATTERN.test(id)) ||
      typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 120) {
    fail('invalid-drawing-conversion', 'La conversión requiere trazos, título e identidades válidas.');
  }
  const selected = payload.drawingIds.map((id) => {
    const record = draft.require({ kind: 'drawing', id, workspaceId: payload.workspaceId });
    if (record.kind !== 'drawing') fail('wrong-document-kind', 'La selección debe contener trazos del mismo workspace.');
    return record;
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, pointCount = 0;
  for (const record of selected) for (const point of record.value.points) {
    if (++pointCount > 100000) fail('drawing-conversion-size-limit', 'La conversión admite hasta 100000 puntos totales por nodo.');
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  const asset = { schemaVersion: '1.0.0', strokes: selected.map((record) => ({ ...copy(record.value), sourceDrawingId: record.value.id })) };
  const path = `assets/drawings/${payload.resourceId}.json`;
  const resource: DomainRecord = { kind: 'resource', value: { schemaVersion: '1.0.0', id: payload.resourceId, revision: 1,
    kind: 'project-file', path, mediaType: 'application/vnd.a3.drawing+json', extensions: {} } };
  const entity: DomainRecord = { kind: 'entity', value: { schemaVersion: '1.0.0', id: payload.entityId, revision: 1, type: 'a3.core.drawing', typeVersion: '1.0.0',
    title: payload.title.trim(), contentResourceId: payload.resourceId, tags: [],
    properties: { 'a3.drawing.stroke-count': selected.length }, ports: [], bindings: {}, extensions: {} } };
  const placement: DomainRecord = { kind: 'placement', workspaceId: payload.workspaceId, value: { schemaVersion: '1.0.0', id: payload.placementId, revision: 1,
    entityId: payload.entityId, position: { x: minX, y: minY }, size: { width: Math.max(180, Math.min(720, maxX - minX + 24)), height: Math.max(130, Math.min(560, maxY - minY + 24)) }, style: {}, extensions: {} } };
  draft.add(resource); draft.add(entity); draft.add(placement);
  draft.effects.push({ kind: 'create', resourceId: payload.resourceId, path, content: canonical(asset) + '\n' });
  for (const record of selected) deleteRecord(draft, { ref: refOf(record) });
}

function moveGroup(draft: Draft, ref: DocumentRef, offset: { x: number; y: number }): void {
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) fail('invalid-group-offset', 'El desplazamiento del grupo debe ser finito.', ref);
  const visited = new Set<string>();
  const placements = new Set<string>();
  const drawings = new Set<string>();
  function visit(current: DocumentRef): void {
    if (visited.has(refKey(current))) return;
    visited.add(refKey(current));
    const record = draft.require(current);
    if (record.kind !== 'group') fail('wrong-document-kind', 'Solo se puede mover un grupo.', current);
    for (const member of record.value.members) {
      const child = { kind: member.kind, id: member.id, workspaceId: record.workspaceId };
      if (member.kind === 'group') visit(child);
      else if (member.kind === 'drawing') drawings.add(refKey(child));
      else placements.add(refKey(child));
    }
  }
  visit(ref);
  for (const record of draft.snapshot.records.filter((r) => r.kind === 'placement' && placements.has(refKey(refOf(r))))) {
    if (record.kind === 'placement' && record.value.style['a3.ui.locked'] === true) continue;
    draft.edit(refOf(record), 'placement', (value) => {
      const x = value.position.x + offset.x, y = value.position.y + offset.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) fail('invalid-group-offset', 'El desplazamiento excede las coordenadas válidas.', refOf(record));
      value.position = { ...value.position, x, y };
    });
  }
  for (const record of draft.snapshot.records.filter((r) => r.kind === 'drawing' && drawings.has(refKey(refOf(r))))) {
    draft.edit(refOf(record), 'drawing', (value) => {
      value.points = value.points.map((point) => {
        const x = point.x + offset.x, y = point.y + offset.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) fail('invalid-group-offset', 'El desplazamiento excede las coordenadas del trazo.', refOf(record));
        return { ...point, x, y };
      });
    });
  }
}

function mapped(table: Record<string, string>, id: string): string {
  if (!isObject(table)) fail('invalid-id-map', 'El mapa de IDs no es válido.');
  const keys = Object.keys(table);
  if (new Set(keys.map((key) => key.toLowerCase())).size !== keys.length || Object.entries(table).some(([key, value]) =>
      !UUID_PATTERN.test(key) || typeof value !== 'string' || !UUID_PATTERN.test(value))) fail('invalid-id-map', 'El mapa de IDs contiene una identidad inválida o ambigua.');
  const entry = Object.entries(table).find(([key]) => sameId(key, id));
  if (!entry || !UUID_PATTERN.test(entry[1]) || sameId(entry[1], id)) fail('new-id-required', `Falta un ID nuevo para ${id}.`);
  return entry[1];
}

function duplicate(draft: Draft, payload: DuplicateSelection): void {
  if (!Array.isArray(payload.placementIds) || !payload.placementIds.length ||
      new Set(payload.placementIds.map((id) => id.toLowerCase())).size !== payload.placementIds.length ||
      !['content', 'representation'].includes(payload.mode) || !isObject(payload.ids) || !Array.isArray(payload.resourceCopies) ||
      typeof payload.includeExternalRelations !== 'boolean') fail('invalid-selection', 'La selección no es válida.');
  const originals = copy(draft.original.records);
  const placements = payload.placementIds.map((id) => {
    const record = draft.require({ kind: 'placement', id, workspaceId: payload.workspaceId });
    if (record.kind !== 'placement') fail('wrong-document-kind', 'La selección debe contener placements.');
    return record;
  });
  const entityIds = new Set(placements.map((r) => r.value.entityId.toLowerCase()));
  const entityMap = new Map<string, string>();
  const resourceMap = new Map<string, string>();
  const relationMap = new Map<string, string>();
  const placementMap = new Map<string, string>();
  const entityId = (id: string): string => entityMap.get(id.toLowerCase()) ?? id;
  if (payload.mode === 'content') {
    for (const id of entityIds) {
      const entity = draft.require({ kind: 'entity', id });
      if (entity.kind !== 'entity') fail('wrong-document-kind', 'Entidad ausente.');
      const newId = mapped(payload.ids.entities, entity.value.id);
      entityMap.set(id, newId);
      const value = copy(entity.value); value.id = newId; value.revision = 1;
      if (value.contentResourceId) {
        const resourceId = value.contentResourceId;
        let cloneId = resourceMap.get(resourceId.toLowerCase());
        if (!cloneId) {
          const resource = draft.require({ kind: 'resource', id: resourceId });
          if (resource.kind !== 'resource') fail('wrong-document-kind', 'Recurso ausente.');
          const target = payload.resourceCopies.filter((r) => sameId(r.sourceId, resourceId));
          if (target.length !== 1 || sameId(target[0]!.id, resourceId)) fail('resource-copy-required', 'Declara la nueva identidad y ubicación del recurso.');
          const dest = target[0]!;
          if (resource.value.kind === 'remote-url' && dest.location.kind !== 'remote-url') fail('remote-download-not-supported', 'Duplicar una URL no autoriza descargarla.');
          if (resource.value.kind !== 'remote-url' && (dest.location.kind === 'remote-url' || canonical(dest.location) === canonical(location(resource.value)))) fail('independent-resource-required', 'El contenido duplicado requiere una ubicación local independiente.');
          const next = relocate(resource.value, dest.location); next.id = dest.id; next.revision = 1;
          draft.add({ kind: 'resource', value: next });
          if (resource.value.kind !== 'remote-url') draft.effects.push({ kind: 'copy', sourceId: resourceId, targetId: dest.id, expectedHash: draft.requireHash(resourceId) });
          cloneId = dest.id; resourceMap.set(resourceId.toLowerCase(), cloneId);
        }
        value.contentResourceId = cloneId;
      }
      draft.add({ kind: 'entity', value });
      const variables = originals.find((r) => r.kind === 'variable-set' && r.value.scope.kind === 'entity' && sameId(r.value.scope.ownerId, id));
      if (variables?.kind === 'variable-set') draft.add({ kind: 'variable-set', value: {
        ...copy(variables.value), revision: 1, scope: { ...variables.value.scope, ownerId: newId }
      } });
    }
    for (const record of originals.filter((r) => r.kind === 'relation')) {
      const sourceInside = entityIds.has(record.value.source.entityId.toLowerCase());
      const targetInside = entityIds.has(record.value.target.entityId.toLowerCase());
      if (!(sourceInside && targetInside || payload.includeExternalRelations && (sourceInside || targetInside))) continue;
      const value = copy(record.value); value.id = mapped(payload.ids.relations, value.id); value.revision = 1;
      relationMap.set(record.value.id.toLowerCase(), value.id);
      value.source = { ...value.source, entityId: entityId(value.source.entityId) };
      value.target = { ...value.target, entityId: entityId(value.target.entityId) };
      draft.add({ kind: 'relation', value });
    }
  }
  for (const record of placements) {
    const value = copy(record.value); value.id = mapped(payload.ids.placements, value.id); value.revision = 1;
    placementMap.set(record.value.id.toLowerCase(), value.id);
    value.entityId = entityId(value.entityId);
    value.position = { ...value.position, x: value.position.x + payload.offset.x, y: value.position.y + payload.offset.y };
    draft.add({ kind: 'placement', workspaceId: record.workspaceId, value });
  }
  for (const record of originals.filter((r) => r.kind === 'visual-edge' || r.kind === 'relation-view')) {
    if (!sameId(record.workspaceId, payload.workspaceId)) continue;
    const source = placementMap.get(record.value.sourcePlacementId.toLowerCase());
    const target = placementMap.get(record.value.targetPlacementId.toLowerCase());
    if (!source || !target) continue;
    const value = copy(record.value);
    value.id = mapped(record.kind === 'visual-edge' ? payload.ids.visualEdges : payload.ids.relationViews, value.id);
    value.revision = 1; value.sourcePlacementId = source; value.targetPlacementId = target;
    value.waypoints = value.waypoints.map((p) => ({ ...p, x: p.x + payload.offset.x, y: p.y + payload.offset.y }));
    if (record.kind === 'visual-edge') draft.add({ kind: 'visual-edge', workspaceId: record.workspaceId, value: value as DocumentKinds['visual-edge'] });
    else {
      const relationId = payload.mode === 'representation' ? record.value.relationId : relationMap.get(record.value.relationId.toLowerCase());
      if (!relationId) fail('relation-copy-missing', 'La selección no puede conservar su RelationView sin relación.');
      draft.add({ kind: 'relation-view', workspaceId: record.workspaceId, value: { ...value, relationId } as DocumentKinds['relation-view'] });
    }
  }
}

function apply(draft: Draft): void {
  const request = draft.request;
  switch (request.command) {
    case 'a3.core.create-project':
      if (draft.snapshot.records.length) fail('project-exists', 'El snapshot ya contiene un proyecto.');
      draft.add({ kind: 'project', value: request.payload.project });
      draft.add({ kind: 'workspace', value: request.payload.workspace });
      break;
    case 'a3.core.create-document':
      if (request.payload.record.kind === 'project') fail('unsupported-create', 'Usa el constructor de proyecto.');
      draft.add(request.payload.record);
      break;
    case 'a3.core.set-workspace-viewport': {
      const { viewport, workspaceId } = request.payload;
      if (!isObject(viewport) || Object.keys(viewport).some((key) => !['x', 'y', 'zoom'].includes(key)) ||
          !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0) {
        fail('invalid-viewport', 'La cámara requiere coordenadas finitas y una escala positiva.');
      }
      draft.edit({ kind: 'workspace', id: workspaceId }, 'workspace', (value) => {
        // Only camera values are editable; opaque viewport fields and extensions survive.
        value.viewport = { ...value.viewport, ...copy(viewport) };
      });
      break;
    }
    case 'a3.core.rename': {
      const record = draft.require(request.payload.ref);
      if (record.kind === 'entity') draft.edit(request.payload.ref, 'entity', (value) => { value.title = request.payload.name; });
      else if (record.kind === 'project' || record.kind === 'workspace' || record.kind === 'group' || record.kind === 'collection') {
        draft.edit(request.payload.ref, record.kind, (value) => { value.name = request.payload.name; });
      } else fail('unsupported-rename', 'Este documento no tiene un nombre editable.');
      break;
    }
    case 'a3.core.update-entity': {
      if (request.scope.entityIds.length !== 1) fail('single-entity-required', 'El comando requiere una sola entidad en scope.');
      const keys = Object.keys(request.payload);
      if (keys.some((key) => !['title', 'tags', 'properties', 'ports', 'bindings'].includes(key))) fail('unsafe-entity-patch', 'El patch no puede cambiar identidad, fuente ni campos desconocidos.');
      draft.edit({ kind: 'entity', id: request.scope.entityIds[0]! }, 'entity', (value) => {
        if (request.payload.title !== undefined) value.title = request.payload.title;
        if (request.payload.tags !== undefined) value.tags = copy(request.payload.tags);
        if (request.payload.properties !== undefined) value.properties = { ...value.properties, ...copy(request.payload.properties) };
        if (request.payload.bindings !== undefined) value.bindings = { ...value.bindings, ...copy(request.payload.bindings) };
        if (request.payload.ports !== undefined) value.ports = request.payload.ports.map((port) => ({ ...value.ports.find((old) => old.id === port.id), ...copy(port) }));
      });
      break;
    }
    case 'a3.core.move-placement':
      draft.edit(request.payload.ref, 'placement', (value) => {
        if (value.style['a3.ui.locked'] === true) fail('placement-locked', 'Desbloquea la representación antes de moverla.', request.payload.ref);
        value.position = { ...value.position, ...copy(request.payload.position) };
      }); break;
    case 'a3.core.move-placements': {
      const { workspaceId, placements } = request.payload;
      if (Object.keys(request.payload).some((key) => !['workspaceId', 'placements'].includes(key)) || !Array.isArray(placements) || !placements.length ||
          placements.some((item) => !isObject(item) || Object.keys(item).some((key) => !['id', 'position'].includes(key)) || typeof item.id !== 'string' ||
            !UUID_PATTERN.test(item.id) || !isObject(item.position) || Object.keys(item.position).some((key) => !['x', 'y'].includes(key)) ||
            !Number.isFinite(item.position.x) || !Number.isFinite(item.position.y)) || new Set(placements.map((item) => item.id.toLowerCase())).size !== placements.length) {
        fail('invalid-placement-moves', 'El movimiento requiere representaciones únicas y coordenadas finitas.');
      }
      for (const item of placements) {
        const ref: DocumentRef = { kind: 'placement', id: item.id, workspaceId };
        draft.edit(ref, 'placement', (value) => {
          if (value.style['a3.ui.locked'] === true) fail('placement-locked', 'Desbloquea la representación antes de moverla.', ref);
          value.position = { ...value.position, ...copy(item.position) };
        });
      }
      break;
    }
    case 'a3.core.update-placement-view': {
      const { position, size, style } = request.payload;
      if (Object.keys(request.payload).some((key) => !['ref', 'position', 'size', 'style'].includes(key)) ||
          (!position && !size && !style)) fail('invalid-placement-view-patch', 'La propuesta debe cambiar posición, tamaño o estilo de vista.', request.payload.ref);
      if (position && (!isObject(position) || Object.keys(position).some((key) => !['x', 'y'].includes(key)) ||
          !Number.isFinite(position.x) || !Number.isFinite(position.y))) {
        fail('invalid-placement-position', 'La posición debe contener coordenadas finitas.', request.payload.ref);
      }
      if (size && (!isObject(size) || Object.keys(size).some((key) => !['width', 'height'].includes(key)) ||
          !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0)) {
        fail('invalid-placement-size', 'El tamaño debe tener ancho y alto finitos mayores que cero.', request.payload.ref);
      }
      if (style && !isObject(style)) fail('invalid-placement-style', 'El estilo de vista debe ser un mapa JSON namespaced.', request.payload.ref);
      draft.edit(request.payload.ref, 'placement', (value) => {
        if ((position || size) && value.style['a3.ui.locked'] === true) fail('placement-locked', 'Desbloquea la representación antes de cambiar su geometría.', request.payload.ref);
        if (position) value.position = { ...value.position, ...copy(position) };
        if (size) value.size = { ...value.size, ...copy(size) };
        if (style) value.style = { ...value.style, ...copy(style) };
      });
      break;
    }
    case 'a3.core.update-visual-edge': {
      const { ref, ...patch } = request.payload;
      if (!Object.keys(patch).length || Object.keys(patch).some((key) => !['sourcePlacementId', 'targetPlacementId', 'label', 'waypoints', 'style'].includes(key)) ||
          (patch.style !== undefined && !isObject(patch.style))) fail('invalid-visual-edge-patch', 'Solo se pueden editar extremos, etiqueta, recorrido y estilo de la línea visual.', ref);
      draft.edit(ref, 'visual-edge', (value) => {
        if (patch.sourcePlacementId !== undefined) value.sourcePlacementId = patch.sourcePlacementId;
        if (patch.targetPlacementId !== undefined) value.targetPlacementId = patch.targetPlacementId;
        if (patch.label !== undefined) value.label = patch.label;
        if (patch.waypoints !== undefined) value.waypoints = copy(patch.waypoints);
        if (patch.style !== undefined) value.style = { ...value.style, ...copy(patch.style) };
      });
      break;
    }
    case 'a3.core.update-drawing': {
      const { points, parameters, style, ref } = request.payload;
      if (ref.kind !== 'drawing' || Object.keys(request.payload).some((key) => !['ref', 'points', 'parameters', 'style'].includes(key)) ||
          (!points && !parameters && !style)) fail('invalid-drawing-patch', 'El patch debe editar geometría, parámetros o estilo del trazo.', ref);
      if (points !== undefined && (!Array.isArray(points) || points.length < 1 || points.length > 100000)) {
        fail('invalid-drawing-points', 'El trazo requiere entre 1 y 100000 puntos.', ref);
      }
      if (parameters !== undefined && (!isObject(parameters) || Object.keys(parameters).some((key) => !['size', 'thinning', 'smoothing', 'streamline', 'simulatePressure'].includes(key)))) {
        fail('invalid-drawing-parameters', 'Los parámetros del trazo contienen campos no editables.', ref);
      }
      if (style !== undefined && !isObject(style)) fail('invalid-drawing-style', 'El estilo debe ser un mapa namespaced.', ref);
      draft.edit(ref, 'drawing', (value) => {
        if (points) value.points = copy(points);
        if (parameters) value.parameters = { ...value.parameters, ...copy(parameters) };
        if (style) value.style = { ...value.style, ...copy(style) };
      });
      break;
    }
    case 'a3.core.convert-drawings-to-node': convertDrawingsToNode(draft, request.payload); break;
    case 'a3.core.move-resource': {
      const ref: DocumentRef = { kind: 'resource', id: request.payload.resourceId };
      const record = draft.require(ref);
      if (record.kind !== 'resource') fail('wrong-document-kind', 'No es un recurso.');
      if (record.value.kind === 'remote-url' || request.payload.location.kind !== record.value.kind) fail('unsupported-resource-move', 'Mover requiere conservar la clase de ubicación local.');
      const before = location(record.value);
      const after = copy(request.payload.location);
      const expectedHash = draft.requireHash(record.value.id);
      draft.edit(ref, 'resource', (value) => { const next = relocate(value, after); Object.assign(value, next); });
      draft.effects.push({ kind: 'move', resourceId: record.value.id, before, after, expectedHash });
      break;
    }
    case 'a3.core.move-group': moveGroup(draft, request.payload.ref, request.payload.offset); break;
    case 'a3.core.set-group-members': draft.edit(request.payload.ref, 'group', (value) => {
      value.members = request.payload.members.map((member) => ({ ...value.members.find((old) => old.kind === member.kind && sameId(old.id, member.id)), ...copy(member) }));
    }); break;
    case 'a3.core.set-group-collapsed': draft.edit(request.payload.ref, 'group', (value) => { value.collapsed = request.payload.collapsed; }); break;
    case 'a3.core.set-collection-members': draft.edit({ kind: 'collection', id: request.payload.collectionId }, 'collection', (value) => { value.entityIds = copy(request.payload.entityIds); }); break;
    case 'a3.core.set-variables': {
      const scope = request.payload.scope;
      const ref: DocumentRef = { kind: 'variable-set', id: scope.ownerId, variableScope: scope.kind };
      if (getRecord(draft.snapshot, ref)) draft.edit(ref, 'variable-set', (value) => {
        value.variables = request.payload.variables.map((variable) => {
          const old = value.variables.find((v) => v.name === variable.name);
          const source: Record<string, unknown> = { ...old?.source };
          delete source.value; delete source.name;
          return { ...old, ...copy(variable), source: { ...source, ...copy(variable.source) } };
        });
      });
      else draft.add({ kind: 'variable-set', value: { schemaVersion: '1.0.0', revision: 1, extensions: {}, scope: copy(scope), variables: copy(request.payload.variables) } });
      break;
    }
    case 'a3.core.delete': deleteRecord(draft, request.payload); break;
    case 'a3.core.duplicate-selection': duplicate(draft, request.payload); break;
    case 'a3.core.register-node-type': {
      const errors = validateDefinition('node-type', request.payload.definition);
      if (errors.length) throw new DomainFault(errors[0]!);
      const value = request.payload.definition;
      if (draft.registry.nodeTypes.some((d) => d.name === value.name && d.version === value.version)) fail('type-version-exists', 'Una definición versionada es inmutable; crea otra versión.', undefined, 'REVISION_CONFLICT');
      draft.registry.nodeTypes.push(copy(value)); break;
    }
    case 'a3.core.unregister-node-type': {
      const { name, version } = request.payload;
      if (!draft.registry.nodeTypes.some((d) => d.name === name && d.version === version)) fail('node-type-missing', 'La definición no está registrada.', undefined, 'RESOURCE_MISSING');
      draft.registry.nodeTypes = draft.registry.nodeTypes.filter((d) => d.name !== name || d.version !== version); break;
    }
  }
}

function affectedEntities(records: DomainRecord[], snapshot: DomainSnapshot): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.kind === 'entity') ids.add(record.value.id);
    if (record.kind === 'placement') ids.add(record.value.entityId);
    if (record.kind === 'relation') { ids.add(record.value.source.entityId); ids.add(record.value.target.entityId); }
    if (record.kind === 'collection') record.value.entityIds.forEach((id) => ids.add(id));
    if (record.kind === 'variable-set' && record.value.scope.kind === 'entity') ids.add(record.value.scope.ownerId);
    if (record.kind === 'group') {
      const visited = new Set<string>();
      const visit = (group: Extract<DomainRecord, { kind: 'group' }>): void => {
        const key = refKey(refOf(group));
        if (visited.has(key)) return;
        visited.add(key);
        for (const member of group.value.members) {
          const child = getRecord(snapshot, { kind: member.kind, id: member.id, workspaceId: group.workspaceId });
          if (child?.kind === 'placement') ids.add(child.value.entityId);
          if (child?.kind === 'group') visit(child);
        }
      };
      visit(record);
    }
    if (record.kind === 'resource') for (const item of snapshot.records) {
      if (item.kind === 'entity' && item.value.contentResourceId && sameId(item.value.contentResourceId, record.value.id)) ids.add(item.value.id);
    }
    if (record.kind === 'visual-edge' || record.kind === 'relation-view') for (const id of [record.value.sourcePlacementId, record.value.targetPlacementId]) {
      const placement = getRecord(snapshot, { kind: 'placement', id, workspaceId: record.workspaceId });
      if (placement?.kind === 'placement') ids.add(placement.value.entityId);
    }
  }
  return [...ids].sort();
}

export function prepareCommand(snapshot: DomainSnapshot, input: unknown, context: CommandContext): Outcome<PreparedPlan> {
  try {
    const request = parseCommand(input);
    if (!context || !isJson(context.authenticatedActor) || canonical(request.actor) !== canonical(context.authenticatedActor)) fail('actor-mismatch', 'El actor no coincide con la identidad autenticada.', undefined, 'PERMISSION_DENIED');
    const registryWrite = request.command === 'a3.core.register-node-type' || request.command === 'a3.core.unregister-node-type';
    const authorize = (refs: DocumentRef[], entities: string[], effects: ContentEffect[], changes: RecordChange[] = [], nodeTypeChanges: NodeTypeChange[] = []): void => {
      const authorizationRequest = freeze(copy({ actor: context.authenticatedActor, projectId: request.projectId,
        operationId: request.operationId, command: request.command, entityIds: entities, refs, contentEffects: effects, registryWrite, changes, nodeTypeChanges }));
      try {
        const detailed = context.authorization.authorizeDetailed?.(authorizationRequest);
        if (detailed) {
          if (detailed.allowed) return;
          const denied = diagnostic('permission-denied', `La operación requiere ${detailed.missingCapability ?? 'una capacidad no disponible'} (${detailed.reason ?? 'denegada'}).`, undefined, 'PERMISSION_DENIED');
          if (detailed.missingCapability) denied.missingCapability = detailed.missingCapability;
          throw new DomainFault(denied);
        }
        if (context.authorization.authorize(authorizationRequest) === true) return;
      } catch (error) { if (error instanceof DomainFault) throw error; /* An unavailable authorization adapter fails closed. */ }
      fail('permission-denied', 'La política del host no autoriza esta operación.', undefined, 'PERMISSION_DENIED');
    };
    if (!isJson(snapshot) || !Array.isArray(snapshot.records)) fail('invalid-snapshot', 'El snapshot no es válido.');
    const structural = [...snapshot.records.flatMap(validateRecord), ...validateRegistry(context.registry)];
    if (structural.length) return { ok: false, diagnostics: structural };
    if (!isJson(context.contentHashes) || !isObject(context.contentHashes) || Object.entries(context.contentHashes).some(([id, hash]) => !UUID_PATTERN.test(id) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) fail('invalid-content-observations', 'Las observaciones de contenido no son válidas.');
    const project = snapshot.records.find((r) => r.kind === 'project');
    if (request.command !== 'a3.core.create-project' && (project?.kind !== 'project' || !sameId(project.value.projectId, request.projectId))) fail('project-mismatch', 'El comando no pertenece a este proyecto.');
    if (request.command === 'a3.core.create-project' && !sameId(request.projectId, request.payload.project.projectId)) fail('project-mismatch', 'La identidad de creación no coincide.');
    for (const expected of request.expectedRevisions) {
      const actual = getRecord(snapshot, expected)?.value.revision ?? null;
      if (actual !== expected.revision) fail('revision-conflict', `Revisión esperada ${expected.revision}; actual ${actual}.`, expected, 'REVISION_CONFLICT');
    }
    for (const expected of request.expectedContentHashes) {
      const actual = Object.entries(context.contentHashes).find(([id]) => sameId(id, expected.resourceId))?.[1];
      if (actual !== expected.hash) fail('content-conflict', 'Los bytes cambiaron respecto a la observación.', { kind: 'resource', id: expected.resourceId }, 'REVISION_CONFLICT');
    }
    const baseline = request.command === 'a3.core.create-project' ? [] : validateSnapshot(snapshot, context.registry);
    const ambiguous = baseline.filter((d) => d.detail === 'duplicate-id' || d.detail === 'project-count');
    if (ambiguous.length) return { ok: false, diagnostics: ambiguous };
    const draft = new Draft(snapshot, request, context);
    apply(draft);
    const diagnostics = validateSnapshot(draft.snapshot, draft.registry);
    const baselineIssues = new Set(baseline.filter((d) => d.severity === 'error').map(canonical));
    const newErrors = diagnostics.filter((d) => d.severity === 'error' && !baselineIssues.has(canonical(d)));
    if (newErrors.length) return { ok: false, diagnostics: newErrors };
    const changes = changesBetween(snapshot, draft.snapshot);
    const nodeTypeChanges: NodeTypeChange[] = [
      ...context.registry.nodeTypes.filter((d) => !draft.registry.nodeTypes.some((v) => v.name === d.name && v.version === d.version)).map((before) => ({ before: copy(before), after: null })),
      ...draft.registry.nodeTypes.filter((d) => !context.registry.nodeTypes.some((v) => v.name === d.name && v.version === d.version)).map((after) => ({ before: null, after: copy(after) }))
    ];
    for (const change of changes) {
      const expected = request.expectedRevisions.find((r) => refKey(r) === refKey(change.ref));
      if (!expected || expected.revision !== (change.before?.value.revision ?? null)) fail('precondition-required', 'Declara la revisión de cada escritura, incluido null para creación.', change.ref, 'REVISION_CONFLICT');
      if (change.after && change.after.value.revision !== (change.before ? change.before.value.revision + 1 : 1)) fail('invalid-result-revision', 'La revisión resultante no corresponde a la operación.', change.ref);
      if (change.after?.kind === 'relation') {
        if (!findRelationType(draft.registry, change.after.value) || diagnostics.some((d) => d.ref && refKey(d.ref) === refKey(change.ref) && d.detail === 'endpoint-rule-unavailable')) {
          fail('relation-rule-unavailable', 'No se puede crear una relación sin reglas comprobables.', change.ref, 'ENGINE_UNAVAILABLE');
        }
      }
    }
    const allRecords = changes.flatMap((c) => [c.before, c.after].filter((r): r is DomainRecord => r !== null));
    const entityIds = affectedEntities(allRecords, { records: [...snapshot.records, ...draft.snapshot.records] });
    if (entityIds.some((id) => !request.scope.entityIds.some((allowed) => sameId(allowed, id)))) fail('scope-exceeded', 'La propuesta excede las entidades de scope.', undefined, 'PERMISSION_DENIED');
    authorize(changes.map((c) => c.ref), entityIds, draft.effects, changes, nodeTypeChanges);
    const readSet: ExpectedRevision[] = revisionsOf(snapshot);
    for (const change of changes.filter((c) => !c.before)) readSet.push({ ...change.ref, revision: null });
    return { ok: true, value: freeze({ status: 'prepared', operationId: request.operationId, projectId: request.projectId,
      request: copy(request), requestFingerprint: canonical(request), baseFingerprint: baseFingerprint(snapshot, context),
      readSet, changes, nodeTypeChanges, contentEffects: draft.effects, nextSnapshot: draft.snapshot, nextRegistry: draft.registry }), diagnostics };
  } catch (error) {
    return { ok: false, diagnostics: [error instanceof DomainFault ? error.diagnostic : diagnostic('invalid-command-data', 'No se pudo interpretar la propuesta; no se aplicó ningún cambio.')] };
  }
}

export function revalidatePlan(plan: PreparedPlan, current: DomainSnapshot, context: CommandContext): Outcome<PreparedPlan> {
  try {
    if (plan.baseFingerprint !== baseFingerprint(current, context)) return { ok: false, diagnostics: [diagnostic('snapshot-conflict', 'Cambió el snapshot, el catálogo o el contenido; prepara otra propuesta.', undefined, 'REVISION_CONFLICT')] };
    const result = prepareCommand(current, plan.request, context);
    if (result.ok && canonical(result.value) !== canonical(plan)) return { ok: false, diagnostics: [diagnostic('plan-modified', 'La propuesta no coincide con su cálculo validado.')] };
    return result;
  } catch { return { ok: false, diagnostics: [diagnostic('invalid-plan', 'La propuesta no se puede revalidar.')] }; }
}

/** Project committed domain changes into the reversible event format consumed by the shared E2-B3 canvas history. */
export function reversibleCanvasCommand(plan: PreparedPlan, workspaceId: string): ReversibleCanvasCommand {
  if (!UUID_PATTERN.test(workspaceId)) throw new TypeError('workspaceId debe ser UUID.');
  for (const change of plan.changes) {
    if (change.ref.kind === 'workspace' && !sameId(change.ref.id, workspaceId)) {
      throw new TypeError('Un evento reversible de canvas no puede incluir otro workspace.');
    }
    if (change.ref.workspaceId !== undefined && !sameId(change.ref.workspaceId, workspaceId)) {
      throw new TypeError('Un evento reversible de canvas no puede incluir otro workspace.');
    }
    for (const record of [change.before, change.after]) {
      if (record && 'workspaceId' in record && !sameId(record.workspaceId, workspaceId)) {
        throw new TypeError('Un evento reversible de canvas no puede incluir otro workspace.');
      }
    }
  }
  return freeze(copy({ operationId: plan.operationId, projectId: plan.projectId, workspaceId,
    command: plan.request.command, changes: plan.changes, contentEffects: plan.contentEffects }));
}
