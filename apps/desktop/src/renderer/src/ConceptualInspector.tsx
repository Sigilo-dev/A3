import { useState } from 'react';
import { CONCEPTUAL_NODE_CATALOG, CONCEPTUAL_RELATION_KINDS, conceptualNodeKind } from '@a3/domain/conceptual-diagrams';
import type { ConceptualNodeKind, ConceptualRelationKind } from '@a3/domain';
import type { CanvasEntitySummary, LocalCanvasWorkspace } from '../../shared/desktop-api';

type NodePatch = { title?: string; kind?: ConceptualNodeKind };
type RelationPatch = { label?: string; kind?: ConceptualRelationKind | null };

export function ConceptualInspector({ workspace, entity, placementId, onCreateNode, onUpdateNode, onCreateRelation, onUpdateRelation, onDeleteRelation }: {
  workspace: LocalCanvasWorkspace; entity?: CanvasEntitySummary; placementId?: string;
  onCreateNode: (kind: ConceptualNodeKind, title: string) => void;
  onUpdateNode: (entityId: string, revision: number, patch: NodePatch) => void;
  onCreateRelation: (sourcePlacementId: string, targetPlacementId: string, label: string, kind?: ConceptualRelationKind) => void;
  onUpdateRelation: (relationId: string, revision: number, patch: RelationPatch) => void;
  onDeleteRelation: (relationId: string, revision: number) => void;
}): React.JSX.Element {
  const [newKind, setNewKind] = useState<ConceptualNodeKind>('concept');
  const selectedKind = entity ? conceptualNodeKind(entity.type, entity.typeVersion) : undefined;
  const placements = workspace.placements.flatMap((placement) => {
    const candidate = workspace.entities.find((item) => item.id === placement.entityId);
    return candidate && conceptualNodeKind(candidate.type, candidate.typeVersion) ? [{ placement, entity: candidate }] : [];
  });
  const visibleRelations = entity ? workspace.conceptualRelations.filter((relation) => relation.sourceEntityId === entity.id || relation.targetEntityId === entity.id) : [];

  return <section className="conceptual-inspector" aria-label="Inspector de diagramas conceptuales" data-conceptual-inspector>
    <details className="conceptual-create" data-conceptual-create>
      <summary>Insertar nodo conceptual</summary>
      <form onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget); const title = String(data.get('title')).trim();
        const kind = String(data.get('kind')) as ConceptualNodeKind; if (title && CONCEPTUAL_NODE_CATALOG.some((item) => item.kind === kind)) onCreateNode(kind, title);
      }}>
        <label>Tipo <select name="kind" value={newKind} disabled={!workspace.canWrite} onChange={(event) => setNewKind(event.target.value as ConceptualNodeKind)}>
          {CONCEPTUAL_NODE_CATALOG.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
        </select></label>
        <label>Título <input name="title" aria-label="Título del nodo conceptual" required maxLength={200} defaultValue="Nuevo concepto" disabled={!workspace.canWrite} /></label>
        <button type="submit" data-conceptual-create-node disabled={!workspace.canWrite}>Añadir al lienzo</button>
      </form>
    </details>
    {entity && selectedKind && <div className="conceptual-node-inspector" data-conceptual-node-inspector>
      <h3>{CONCEPTUAL_NODE_CATALOG.find((item) => item.kind === selectedKind)?.label}: {entity.title}</h3>
      <form key={`${entity.id}:${entity.revision}`} onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget); const title = String(data.get('title')).trim();
        const kind = String(data.get('kind')) as ConceptualNodeKind; const patch: NodePatch = {};
        if (title !== entity.title) patch.title = title; if (kind !== selectedKind) patch.kind = kind;
        if (Object.keys(patch).length) onUpdateNode(entity.id, entity.revision, patch);
      }}>
        <label>Título <input name="title" defaultValue={entity.title} required maxLength={200} disabled={!workspace.canWrite} /></label>
        <label>Tipo <select name="kind" defaultValue={selectedKind} disabled={!workspace.canWrite}>
          {CONCEPTUAL_NODE_CATALOG.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
        </select></label>
        <button type="submit" disabled={!workspace.canWrite}>Guardar nodo</button>
      </form>
      <form className="conceptual-relation-create" data-conceptual-relation-create onSubmit={(event) => {
        event.preventDefault(); if (!placementId) return; const data = new FormData(event.currentTarget);
        const target = String(data.get('target')), label = String(data.get('label')).trim(), kind = String(data.get('kind'));
        if (target && label) onCreateRelation(placementId, target, label, kind ? kind as ConceptualRelationKind : undefined);
      }}>
        <h4>Nueva relación semántica</h4>
        <label>Destino <select name="target" required disabled={!workspace.canWrite || placements.length === 0}>
          {placements.map(({ placement, entity: target }) => <option key={placement.id} value={placement.id}>{target.title} · {CONCEPTUAL_NODE_CATALOG.find((item) => item.kind === conceptualNodeKind(target.type, target.typeVersion))?.label}</option>)}
        </select></label>
        <label>Etiqueta <input name="label" required maxLength={300} placeholder="conduce a, contiene, explica…" disabled={!workspace.canWrite} /></label>
        <label>Tipo opcional <select name="kind" defaultValue="" disabled={!workspace.canWrite}>
          <option value="">Sin tipo</option>{CONCEPTUAL_RELATION_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select></label>
        <button type="submit" disabled={!workspace.canWrite || !placementId || placements.length === 0}>Conectar</button>
        <small>Se crea una Relation semántica con una RelationView. Las líneas visuales del canvas siguen siendo organización.</small>
      </form>
      <div className="conceptual-relations" aria-label="Relaciones conceptuales de este nodo">
        <h4>Relaciones ({visibleRelations.length})</h4>
        {visibleRelations.map((relation) => <form key={`${relation.relationId}:${relation.relationRevision}`} data-conceptual-relation={relation.relationId}
          onSubmit={(event) => {
            event.preventDefault(); const data = new FormData(event.currentTarget); const label = String(data.get('label')).trim();
            const selected = String(data.get('kind')); const patch: RelationPatch = {};
            if (label !== relation.label) patch.label = label;
            if ((relation.kind ?? '') !== selected) patch.kind = selected ? selected as ConceptualRelationKind : null;
            if (Object.keys(patch).length) onUpdateRelation(relation.relationId, relation.relationRevision, patch);
          }}>
          <small>{relation.sourceEntityId === entity.id ? 'Sale hacia' : 'Llega desde'} {workspace.entities.find((candidate) => candidate.id === (relation.sourceEntityId === entity.id ? relation.targetEntityId : relation.sourceEntityId))?.title ?? 'nodo no disponible'}</small>
          <label>Etiqueta <input name="label" required maxLength={300} defaultValue={relation.label} disabled={!workspace.canWrite} /></label>
          <label>Tipo <select name="kind" defaultValue={relation.kind ?? ''} disabled={!workspace.canWrite}>
            <option value="">Sin tipo</option>{CONCEPTUAL_RELATION_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select></label>
          <div className="conceptual-relation-actions"><button type="submit" disabled={!workspace.canWrite}>Guardar relación</button>
            <button type="button" className="quiet" data-conceptual-delete-relation disabled={!workspace.canDeleteRelations}
              title={!workspace.canDeleteRelations ? 'El broker local no concede delete.' : 'Elimina la Relation y todas sus vistas del proyecto.'}
              onClick={() => onDeleteRelation(relation.relationId, relation.relationRevision)}>Eliminar en el proyecto</button>
          </div>
        </form>)}
        {!visibleRelations.length && <p className="canvas-help">Este nodo todavía no tiene relaciones semánticas.</p>}
      </div>
    </div>}
    {!entity && <p className="canvas-help">Selecciona un nodo conceptual para inspeccionar sus propiedades y relaciones.</p>}
    {!workspace.canWrite && <p role="note">Inspector en solo lectura. El broker del proyecto no concede edición documental o de diagramas.</p>}
  </section>;
}
