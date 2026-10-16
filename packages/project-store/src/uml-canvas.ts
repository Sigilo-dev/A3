import { umlData, umlKind, umlRelationKind, validUmlRelationData, type DomainSnapshot, type UmlData, type UmlKind, type UmlRelationData, type UmlRelationKind } from '@a3/domain';

export interface CanvasUmlElement { id: string; revision: number; title: string; kind: UmlKind; data: UmlData; }
export interface CanvasUmlRelationship { id: string; revision: number; kind: UmlRelationKind; sourceEntityId: string; targetEntityId: string; data: UmlRelationData; }
export interface CanvasUmlRelationView extends CanvasUmlRelationship { relationId: string; relationRevision: number; sourcePlacementId: string; targetPlacementId: string; }
export interface CanvasUmlState { elements: CanvasUmlElement[]; relationships: CanvasUmlRelationship[]; relationViews: CanvasUmlRelationView[]; }
export function projectUmlCanvas(snapshot: DomainSnapshot, workspaceId: string): CanvasUmlState {
  const elements: CanvasUmlElement[] = snapshot.records.flatMap((r) => {
    if (r.kind !== 'entity') return []; const kind = umlKind(r.value), data = umlData(r.value);
    return kind && data ? [{ id: r.value.id, revision: r.value.revision, title: r.value.title, kind, data }] : [];
  });
  const relationships: CanvasUmlRelationship[] = snapshot.records.flatMap((r) => {
    if (r.kind !== 'relation') return []; const kind = umlRelationKind(r.value), data = r.value.properties['a3.uml'];
    return kind && validUmlRelationData(data) ? [{ id: r.value.id, revision: r.value.revision, kind, sourceEntityId: r.value.source.entityId, targetEntityId: r.value.target.entityId, data }] : [];
  });
  const byId = new Map(relationships.map((r) => [r.id.toLowerCase(), r]));
  const relationViews: CanvasUmlRelationView[] = snapshot.records.flatMap((r) => {
    if (r.kind !== 'relation-view' || r.workspaceId.toLowerCase() !== workspaceId.toLowerCase()) return [];
    const rel = byId.get(r.value.relationId.toLowerCase());
    return rel ? [{ ...rel, id: r.value.id, revision: r.value.revision, relationId: rel.id, relationRevision: rel.revision, sourcePlacementId: r.value.sourcePlacementId, targetPlacementId: r.value.targetPlacementId }] : [];
  });
  return { elements, relationships, relationViews };
}
