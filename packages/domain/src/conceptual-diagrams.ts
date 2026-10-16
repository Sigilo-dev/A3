import type { Entity, ExtensionMap, NodeType, Relation, RelationType, TypeRegistry } from './models.js';

export const CONCEPTUAL_NODE_VERSION = '1.0.0';

export const CONCEPTUAL_NODE_CATALOG = [
  { kind: 'concept', type: 'a3.conceptual.concept', label: 'Concepto' },
  { kind: 'idea', type: 'a3.conceptual.idea', label: 'Idea' },
  { kind: 'note', type: 'a3.conceptual.note', label: 'Nota' },
  { kind: 'decision', type: 'a3.conceptual.decision', label: 'Decisión' },
  { kind: 'question', type: 'a3.conceptual.question', label: 'Pregunta' },
  { kind: 'cause', type: 'a3.conceptual.cause', label: 'Causa' },
  { kind: 'result', type: 'a3.conceptual.result', label: 'Resultado' },
  { kind: 'reference', type: 'a3.conceptual.reference', label: 'Referencia' }
] as const;

export const CONCEPTUAL_RELATION_KINDS = ['composition', 'dependency', 'cause', 'association'] as const;
export const CONCEPTUAL_RELATION_TYPE = 'a3.conceptual.relationship';
export const CONCEPTUAL_RELATION_VERSION = '1.0.0';
export const CONCEPTUAL_LABEL_KEY = 'a3.conceptual.label';
export const CONCEPTUAL_KIND_KEY = 'a3.conceptual.kind';

export type ConceptualNodeKind = typeof CONCEPTUAL_NODE_CATALOG[number]['kind'];
export type ConceptualRelationKind = typeof CONCEPTUAL_RELATION_KINDS[number];
export type ConceptualNodeType = typeof CONCEPTUAL_NODE_CATALOG[number]['type'];
export type ConceptualEntity = Entity & { type: ConceptualNodeType; typeVersion: typeof CONCEPTUAL_NODE_VERSION };
export interface ConceptualRelationData {
  label: string;
  kind?: ConceptualRelationKind;
}

const nodeTypeDefinition = (entry: typeof CONCEPTUAL_NODE_CATALOG[number]): NodeType => ({
  name: entry.type,
  version: CONCEPTUAL_NODE_VERSION,
  packageId: 'a3.builtin.conceptual',
  fields: [],
  ports: [],
  bindingFields: [],
  extensions: {}
});

export function conceptualNodeTypeDefinition(type: string): NodeType | undefined {
  const entry = CONCEPTUAL_NODE_CATALOG.find((item) => item.type === type);
  return entry ? nodeTypeDefinition(entry) : undefined;
}

export function conceptualRelationType(): RelationType {
  const entityTypes = CONCEPTUAL_NODE_CATALOG.map((entry) => entry.type);
  const endpoint = { entityTypes, requirePort: false, cardinality: { min: 0, max: null } } as const;
  return { name: CONCEPTUAL_RELATION_TYPE, version: CONCEPTUAL_RELATION_VERSION, direction: 'directed', allowSelf: true,
    source: endpoint, target: { ...endpoint, entityTypes: [...entityTypes], cardinality: { ...endpoint.cardinality } }, extensions: {} };
}

export function conceptualRegistry(): TypeRegistry {
  return { nodeTypes: CONCEPTUAL_NODE_CATALOG.map(nodeTypeDefinition), relationTypes: [conceptualRelationType()] };
}

export function conceptualNodeDefinition(kind: ConceptualNodeKind): typeof CONCEPTUAL_NODE_CATALOG[number] {
  const definition = CONCEPTUAL_NODE_CATALOG.find((entry) => entry.kind === kind);
  if (!definition) throw new TypeError(`Tipo conceptual desconocido: ${String(kind)}.`);
  return definition;
}

export function conceptualNodeKind(type: string, version = CONCEPTUAL_NODE_VERSION): ConceptualNodeKind | undefined {
  if (version !== CONCEPTUAL_NODE_VERSION) return undefined;
  return CONCEPTUAL_NODE_CATALOG.find((entry) => entry.type === type)?.kind;
}

export function isConceptualEntity(entity: Pick<Entity, 'type' | 'typeVersion'>): entity is ConceptualEntity {
  return conceptualNodeKind(entity.type, entity.typeVersion) !== undefined;
}

export function isConceptualRelation(relation: Pick<Relation, 'type' | 'typeVersion'>): boolean {
  return relation.type === CONCEPTUAL_RELATION_TYPE && relation.typeVersion === CONCEPTUAL_RELATION_VERSION;
}

export function isConceptualNodeKind(value: unknown): value is ConceptualNodeKind {
  return typeof value === 'string' && CONCEPTUAL_NODE_CATALOG.some((entry) => entry.kind === value);
}

export function isConceptualRelationKind(value: unknown): value is ConceptualRelationKind {
  return typeof value === 'string' && (CONCEPTUAL_RELATION_KINDS as readonly string[]).includes(value);
}

export function conceptualRelationData(properties: ExtensionMap): ConceptualRelationData | undefined {
  const label = properties[CONCEPTUAL_LABEL_KEY];
  if (typeof label !== 'string') return undefined;
  const kind = properties[CONCEPTUAL_KIND_KEY];
  return isConceptualRelationKind(kind) ? { label, kind } : { label };
}
