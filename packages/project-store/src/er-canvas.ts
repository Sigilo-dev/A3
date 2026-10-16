import { erData, erRelationship, erTable, validErRelationData, type DomainSnapshot, type ErRelationData, type ErTableData } from '@a3/domain';

export interface CanvasErElement { id: string; revision: number; title: string; data: ErTableData; }
export interface CanvasErRelationship { id: string; revision: number; sourceEntityId: string; targetEntityId: string; data: ErRelationData; }
export interface CanvasErRelationView extends CanvasErRelationship { relationId: string; relationRevision: number; sourcePlacementId: string; targetPlacementId: string; }
export interface CanvasErState { elements: CanvasErElement[]; relationships: CanvasErRelationship[]; relationViews: CanvasErRelationView[]; }
export function projectErCanvas(snapshot: DomainSnapshot, workspaceId: string): CanvasErState {
  const elements: CanvasErElement[] = snapshot.records.flatMap((r) => r.kind === 'entity' && erTable(r.value) && erData(r.value)
    ? [{ id: r.value.id, revision: r.value.revision, title: r.value.title, data: erData(r.value)! }] : []);
  const relationships: CanvasErRelationship[] = snapshot.records.flatMap((r) => r.kind === 'relation' && erRelationship(r.value) && validErRelationData(r.value.properties['a3.er'])
    ? [{ id: r.value.id, revision: r.value.revision, sourceEntityId: r.value.source.entityId, targetEntityId: r.value.target.entityId, data: r.value.properties['a3.er'] }] : []);
  const byId = new Map(relationships.map((r) => [r.id.toLowerCase(), r]));
  const relationViews: CanvasErRelationView[] = snapshot.records.flatMap((r) => {
    if (r.kind !== 'relation-view' || r.workspaceId.toLowerCase() !== workspaceId.toLowerCase()) return [];
    const relation = byId.get(r.value.relationId.toLowerCase());
    return relation ? [{ ...relation, id: r.value.id, revision: r.value.revision, relationId: relation.id, relationRevision: relation.revision,
      sourcePlacementId: r.value.sourcePlacementId, targetPlacementId: r.value.targetPlacementId }] : [];
  });
  return { elements, relationships, relationViews };
}
