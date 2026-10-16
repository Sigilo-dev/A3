import { C4_CATALOG, C4_VERSION, c4Category, c4Data, c4TypeName, c4View, isC4Relationship, type C4Category, type C4ElementData, type C4ViewData, type DomainSnapshot, type TypeRegistry } from '@a3/domain';

export interface CanvasC4Relationship { id: string; revision: number; sourceEntityId: string; targetEntityId: string; description: string; protocol: string; }
export interface CanvasC4RelationView extends CanvasC4Relationship { relationId: string; relationRevision: number; sourcePlacementId: string; targetPlacementId: string; }
export interface CanvasC4Element { id: string; revision: number; title: string; type: string; typeVersion: string; tags: string[]; category: C4Category; data: C4ElementData; }
export interface CanvasC4State {
  elements: CanvasC4Element[]; relationships: CanvasC4Relationship[]; relationViews: CanvasC4RelationView[];
  types: { name: string; version: string; category: C4Category; label: string }[];
  views: { id: string; workspaceId: string; title: string; kind: C4ViewData['kind'] }[];
  current: { id: string; revision: number; title: string; data: C4ViewData } | null;
}
export function projectC4Canvas(snapshot: DomainSnapshot, registry: TypeRegistry, workspaceId: string): CanvasC4State {
  const elements: CanvasC4Element[] = [], views: CanvasC4State['views'] = [];
  let current: CanvasC4State['current'] = null;
  for (const record of snapshot.records) if (record.kind === 'entity') {
    const entity = record.value, category = c4Category(entity, registry), data = c4Data(entity), view = c4View(entity);
    if (category && data) elements.push({ id: entity.id, revision: entity.revision, title: entity.title, type: entity.type, typeVersion: entity.typeVersion, tags: entity.tags, category, data });
    const boundWorkspace = view && snapshot.records.find((r) => r.kind === 'workspace' && r.value.id === view.workspaceId && r.value.properties['a3.c4.diagram-id'] === entity.id);
    if (view && boundWorkspace) { views.push({ id: entity.id, workspaceId: view.workspaceId, title: entity.title, kind: view.kind });
      if (view.workspaceId.toLowerCase() === workspaceId.toLowerCase()) current = { id: entity.id, revision: entity.revision, title: entity.title, data: view }; }
  }
  const relationships: CanvasC4Relationship[] = snapshot.records.flatMap((record) => {
    if (record.kind !== 'relation' || !isC4Relationship(record.value)) return [];
    const data = record.value.properties['a3.c4'] as { description?: unknown; protocol?: unknown } | undefined;
    if (typeof data?.description !== 'string' || typeof data.protocol !== 'string') return [];
    return [{ id: record.value.id, revision: record.value.revision, sourceEntityId: record.value.source.entityId,
      targetEntityId: record.value.target.entityId, description: data.description, protocol: data.protocol }];
  });
  const relationViews: CanvasC4RelationView[] = snapshot.records.flatMap((record) => {
    if (record.kind !== 'relation-view' || record.workspaceId !== workspaceId) return [];
    const rel = relationships.find((r) => r.id.toLowerCase() === record.value.relationId.toLowerCase());
    return rel ? [{ ...rel, id: record.value.id, revision: record.value.revision, relationId: rel.id, relationRevision: rel.revision,
      sourcePlacementId: record.value.sourcePlacementId, targetPlacementId: record.value.targetPlacementId }] : [];
  });
  const types: CanvasC4State['types'] = C4_CATALOG.map((entry) => ({ name: c4TypeName(entry.category), version: C4_VERSION, category: entry.category, label: entry.label }));
  for (const definition of registry.nodeTypes) {
    const category = c4Category({ type: definition.name, typeVersion: definition.version }, registry);
    if (category && !types.some((t) => t.name === definition.name && t.version === definition.version)) types.push({ name: definition.name, version: definition.version, category, label: definition.name });
  }
  return { elements, relationships, relationViews, types, views, current };
}
