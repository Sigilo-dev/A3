import { diagnostic, isObject, sameId, UUID_PATTERN } from './data.js';
import type { Diagnostic, DomainRecord, DomainSnapshot, Entity, JsonValue, NodeType, RelationType, TypeRegistry } from './models.js';

export const C4_VERSION = '1.0.0';
export const C4_CATALOG = [
  { category: 'person', label: 'Persona' }, { category: 'software-system', label: 'Sistema' },
  { category: 'container', label: 'Contenedor' }, { category: 'component', label: 'Componente' },
  { category: 'boundary', label: 'Límite semántico' }, { category: 'deployment-node', label: 'Nodo de despliegue' },
  { category: 'instance', label: 'Instancia' }
] as const;
export type C4Category = typeof C4_CATALOG[number]['category'];
export const C4_VIEW_KINDS = ['context', 'containers', 'components', 'deployment', 'dynamic'] as const;
export type C4ViewKind = typeof C4_VIEW_KINDS[number];
export interface C4ElementData {
  [key: string]: JsonValue | undefined;
  description: string; technology: string; url: string; external: boolean;
  parentId?: string; instanceOfId?: string; environment?: string;
}
export interface C4Step { [key: string]: JsonValue; id: string; order: number; relationViewId: string; description: string; }
export interface C4ViewData {
  [key: string]: JsonValue | undefined;
  version: string; kind: C4ViewKind; workspaceId: string; scopeEntityId?: string; environment?: string; steps: C4Step[];
}
export interface C4ElementPatch { description?: string; technology?: string; url?: string; external?: boolean; parentId?: string | null; instanceOfId?: string | null; environment?: string | null; }
export type C4Operation =
  | { action: 'create-element'; typeName: string; typeVersion: string; title: string; data: C4ElementPatch; position: { x: number; y: number } }
  | { action: 'update-element'; entityId: string; expectedRevision: number; title: string; tags: string[]; data: C4ElementPatch }
  | { action: 'create-relationship'; sourcePlacementId: string; targetPlacementId: string; description: string; protocol: string }
  | { action: 'update-relationship'; relationId: string; expectedRevision: number; description: string; protocol: string }
  | { action: 'show-element'; entityId: string; position: { x: number; y: number } }
  | { action: 'show-relationship'; relationId: string; sourcePlacementId: string; targetPlacementId: string }
  | { action: 'configure-view'; title: string; kind: C4ViewKind; scopeEntityId?: string; environment?: string; newWorkspace: boolean; expectedDiagramRevision?: number }
  | { action: 'set-steps'; diagramId: string; expectedRevision: number; steps: C4Step[] };
export interface C4Change { workspaceId: string; operation: C4Operation; ids: { entityId: string; placementId: string; relationId: string; relationViewId: string; diagramId: string }; }

export const c4TypeName = (category: C4Category): string => `a3.c4.${category}`;
export const isC4Category = (value: unknown): value is C4Category => C4_CATALOG.some((item) => item.category === value);
export const isC4ViewKind = (value: unknown): value is C4ViewKind => (C4_VIEW_KINDS as readonly unknown[]).includes(value);
export function c4NodeDefinition(name: string): NodeType | undefined {
  if (name !== 'a3.c4.diagram' && !C4_CATALOG.some((item) => c4TypeName(item.category) === name)) return undefined;
  return { name, version: C4_VERSION, packageId: 'a3.builtin.c4', fields: [], ports: [], bindingFields: [], extensions: {} };
}
export function c4RelationDefinition(): RelationType {
  const rule = { entityTypes: '*' as const, requirePort: false, cardinality: { min: 0, max: null } };
  return { name: 'a3.c4.relationship', version: C4_VERSION, direction: 'directed', allowSelf: false, source: rule,
    target: { ...rule, cardinality: { ...rule.cardinality } }, extensions: {} };
}
export function c4Category(entity: Pick<Entity, 'type' | 'typeVersion'>, registry: TypeRegistry): C4Category | undefined {
  if (entity.typeVersion === C4_VERSION) {
    const builtin = C4_CATALOG.find((item) => c4TypeName(item.category) === entity.type);
    if (builtin) return builtin.category;
  }
  // An entity property or a suggestive name never grants a technical category.
  const definition = registry.nodeTypes.find((item) => item.name === entity.type && item.version === entity.typeVersion);
  const mapped = definition?.extensions['a3.c4.category'];
  return isC4Category(mapped) ? mapped : undefined;
}
export const isC4Relationship = (value: { type: string; typeVersion: string }): boolean => value.type === 'a3.c4.relationship' && value.typeVersion === C4_VERSION;
export const isC4Diagram = (entity: Pick<Entity, 'type' | 'typeVersion'>): boolean => entity.type === 'a3.c4.diagram' && entity.typeVersion === C4_VERSION;
export function c4Data(entity: Pick<Entity, 'properties'>): C4ElementData | undefined {
  const data = entity.properties['a3.c4'];
  return isObject(data) ? data as unknown as C4ElementData : undefined;
}
export function c4View(entity: Entity): C4ViewData | undefined {
  const data = entity.properties['a3.c4.view'];
  return isC4Diagram(entity) && entity.properties['a3.diagram.authority'] === 'a3-model' && isObject(data) && data.version === C4_VERSION && isC4ViewKind(data.kind) &&
    typeof data.workspaceId === 'string' && UUID_PATTERN.test(data.workspaceId) && validC4Steps(data.steps) ? data as unknown as C4ViewData : undefined;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID_PATTERN.test(v);
const text = (v: unknown, max = 20000): v is string => typeof v === 'string' && v.length <= max;
const nonempty = (v: unknown, max = 200): v is string => text(v, max) && !!v.trim();
const revision = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 1;
const point = (v: unknown): boolean => isObject(v) && Object.keys(v).length === 2 && Number.isFinite(v.x) && Number.isFinite(v.y);
export function validC4Patch(v: unknown): v is C4ElementPatch {
  if (!isObject(v) || Object.keys(v).some((key) => !['description', 'technology', 'url', 'external', 'parentId', 'instanceOfId', 'environment'].includes(key))) return false;
  return Object.entries(v).every(([key, value]) => ['parentId', 'instanceOfId'].includes(key) ? value === null || uuid(value) :
    key === 'external' ? typeof value === 'boolean' : key === 'environment' ? value === null || nonempty(value) : text(value));
}
export function validC4Steps(value: unknown): value is C4Step[] {
  return Array.isArray(value) && value.length <= 1000 && value.every((step) => isObject(step) && uuid(step.id) && uuid(step.relationViewId) && revision(step.order) && text(step.description)) &&
    new Set(value.map((s) => s.id.toLowerCase())).size === value.length && new Set(value.map((s) => s.order)).size === value.length;
}
export function validC4Operation(value: unknown): value is C4Operation {
  if (!isObject(value) || typeof value.action !== 'string') return false;
  const keys: Record<C4Operation['action'], string[]> = {
    'create-element': ['action', 'typeName', 'typeVersion', 'title', 'data', 'position'],
    'update-element': ['action', 'entityId', 'expectedRevision', 'title', 'tags', 'data'],
    'create-relationship': ['action', 'sourcePlacementId', 'targetPlacementId', 'description', 'protocol'],
    'update-relationship': ['action', 'relationId', 'expectedRevision', 'description', 'protocol'],
    'show-element': ['action', 'entityId', 'position'], 'show-relationship': ['action', 'relationId', 'sourcePlacementId', 'targetPlacementId'],
    'configure-view': ['action', 'title', 'kind', 'scopeEntityId', 'environment', 'newWorkspace', 'expectedDiagramRevision'], 'set-steps': ['action', 'diagramId', 'expectedRevision', 'steps']
  };
  if (!Object.hasOwn(keys, value.action) || Object.keys(value).some((key) => !keys[value.action as C4Operation['action']].includes(key))) return false;
  switch (value.action) {
    case 'create-element': return nonempty(value.typeName) && nonempty(value.typeVersion) && nonempty(value.title) && validC4Patch(value.data) && point(value.position);
    case 'update-element': return uuid(value.entityId) && revision(value.expectedRevision) && nonempty(value.title) && Array.isArray(value.tags) && value.tags.every((tag) => nonempty(tag)) && validC4Patch(value.data);
    case 'create-relationship': return uuid(value.sourcePlacementId) && uuid(value.targetPlacementId) && nonempty(value.description, 20000) && text(value.protocol, 1000);
    case 'update-relationship': return uuid(value.relationId) && revision(value.expectedRevision) && nonempty(value.description, 20000) && text(value.protocol, 1000);
    case 'show-element': return uuid(value.entityId) && point(value.position);
    case 'show-relationship': return uuid(value.relationId) && uuid(value.sourcePlacementId) && uuid(value.targetPlacementId);
    case 'configure-view': return nonempty(value.title) && isC4ViewKind(value.kind) && (value.scopeEntityId === undefined || uuid(value.scopeEntityId)) &&
      (value.environment === undefined || nonempty(value.environment)) && typeof value.newWorkspace === 'boolean' && (value.expectedDiagramRevision === undefined || revision(value.expectedDiagramRevision));
    case 'set-steps': return uuid(value.diagramId) && revision(value.expectedRevision) && validC4Steps(value.steps);
    default: return false;
  }
}

/** Family validation complements the E0 envelope without interpreting unknown versions. */
export function validateC4Snapshot(snapshot: DomainSnapshot, registry: TypeRegistry): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const entities = new Map(snapshot.records.filter((r): r is Extract<DomainRecord, { kind: 'entity' }> => r.kind === 'entity').map((r) => [r.value.id.toLowerCase(), r]));
  const lookup = (id: unknown) => typeof id === 'string' ? entities.get(id.toLowerCase()) : undefined;
  const category = (id: string | undefined) => { const e = lookup(id); return e ? c4Category(e.value, registry) : undefined; };
  const report = (r: DomainRecord, detail: string, message: string): void => { diagnostics.push(diagnostic(detail, message, { kind: r.kind, id: 'id' in r.value ? String(r.value.id) : '', ...('workspaceId' in r ? { workspaceId: r.workspaceId } : {}) })); };
  const ancestor = (id: string, target: string): boolean => {
    const seen = new Set<string>(); let current = lookup(id);
    while (current) { if (sameId(current.value.id, target)) return true; if (seen.has(current.value.id.toLowerCase())) return false;
      seen.add(current.value.id.toLowerCase()); current = lookup(c4Data(current.value)?.parentId); }
    return false;
  };
  for (const record of entities.values()) {
    const kind = c4Category(record.value, registry); if (!kind) continue;
    const data = c4Data(record.value);
    if (!data || !text(data.description) || !text(data.technology) || !text(data.url) || typeof data.external !== 'boolean' ||
        data.parentId !== undefined && !uuid(data.parentId) || data.instanceOfId !== undefined && !uuid(data.instanceOfId) || data.environment !== undefined && !nonempty(data.environment)) {
      report(record, 'c4-properties-invalid', 'Propiedades C4 inválidas; se conservan los datos originales.'); continue;
    }
    if (data.url) { try { const Ctor = (globalThis as unknown as { URL: new (input: string) => { protocol: string } }).URL;
      if (!['https:', 'http:'].includes(new Ctor(data.url).protocol)) throw new Error(); } catch { report(record, 'c4-url-invalid', 'La URL C4 debe ser HTTP(S); no se abre ni descarga automáticamente.'); } }
    if (data.external && kind !== 'software-system') report(record, 'c4-external-category', 'Solo un sistema de software puede declararse externo.');
    const parentCategory = category(data.parentId);
    if (data.parentId && !parentCategory) report(record, 'c4-parent-missing', 'El padre semántico no existe o no tiene categoría C4 disponible.');
    const visited = new Set([record.value.id.toLowerCase()]); let parent = lookup(data.parentId); let structural = parentCategory;
    while (parent) {
      const id = parent.value.id.toLowerCase(); if (visited.has(id)) { report(record, 'c4-containment-cycle', 'La contención C4 no admite ciclos.'); break; }
      visited.add(id); if (c4Category(parent.value, registry) !== 'boundary') break; parent = lookup(c4Data(parent.value)?.parentId); structural = parent ? c4Category(parent.value, registry) : undefined;
    }
    // Detect cycles even when the first ancestor is not a boundary.
    if (data.parentId && ancestor(data.parentId, record.value.id)) report(record, 'c4-containment-cycle', 'La contención C4 no admite ciclos.');
    const validParent = kind === 'container' ? structural === 'software-system' : kind === 'component' ? structural === 'container' :
      kind === 'instance' ? parentCategory === 'deployment-node' : kind === 'deployment-node' ? !data.parentId || parentCategory === 'deployment-node' :
      kind === 'boundary' ? !data.parentId || ['boundary', 'software-system', 'container'].includes(parentCategory ?? '') : !data.parentId || parentCategory === 'boundary' && structural === undefined;
    if (!validParent) report(record, 'c4-parent-category', `Jerarquía incompatible para ${kind}.`);
    if (kind === 'instance') {
      if (!['software-system', 'container'].includes(category(data.instanceOfId) ?? '')) report(record, 'c4-instance-target', 'Una instancia debe referenciar un sistema o contenedor existente.');
    } else if (data.instanceOfId !== undefined) report(record, 'c4-instance-category', 'instanceOfId solo pertenece a una instancia.');
    if (kind === 'deployment-node' && !nonempty(data.environment)) report(record, 'c4-environment-required', 'El nodo de despliegue requiere un entorno explícito.');
    if (kind === 'deployment-node' && data.parentId && lookup(data.parentId) && data.environment !== c4Data(lookup(data.parentId)!.value)?.environment) report(record, 'c4-environment-parent', 'Los nodos de despliegue anidados pertenecen al mismo entorno.');
    if (kind === 'instance' && data.environment !== undefined && data.environment !== (lookup(data.parentId) && c4Data(lookup(data.parentId)!.value)?.environment)) report(record, 'c4-environment-parent', 'La instancia pertenece al entorno de su nodo de despliegue.');
  }
  for (const record of snapshot.records) {
    if (record.kind === 'workspace' && 'a3.c4.diagram-id' in record.value.properties) {
      const target = lookup(record.value.properties['a3.c4.diagram-id']);
      if (!target || !isC4Diagram(target.value) || c4View(target.value)?.workspaceId !== record.value.id) report(record, 'c4-view-workspace', 'El workspace requiere un documento de vista C4 correspondiente.');
    }
    if (record.kind === 'relation' && isC4Relationship(record.value)) {
      const data = record.value.properties['a3.c4'];
      if (!isObject(data) || !nonempty(data.description, 20000) || !text(data.protocol, 1000)) report(record, 'c4-relationship-properties', 'La relación C4 requiere descripción y protocolo textual.');
      for (const endpoint of [record.value.source, record.value.target]) if (!category(endpoint.entityId) || category(endpoint.entityId) === 'boundary' || endpoint.portId !== undefined) report(record, 'c4-relationship-endpoint', 'El extremo debe tener categoría C4 disponible y no ser un límite.');
    }
    if (record.kind !== 'entity' || !isC4Diagram(record.value)) continue;
    const view = c4View(record.value);
    if (!view || view.version !== C4_VERSION || !isC4ViewKind(view.kind) || !uuid(view.workspaceId) || !validC4Steps(view.steps)) { report(record, 'c4-view-invalid', 'El documento de vista C4 no tiene un formato soportado.'); continue; }
    const workspace = snapshot.records.find((r) => r.kind === 'workspace' && sameId(r.value.id, view.workspaceId));
    if (workspace?.kind !== 'workspace' || workspace.value.properties['a3.c4.diagram-id'] !== record.value.id) report(record, 'c4-view-workspace', 'La vista y el workspace deben referenciarse por identidad.');
    const scope = category(view.scopeEntityId);
    if (['context', 'containers'].includes(view.kind) && scope !== 'software-system' || view.kind === 'components' && scope !== 'container' ||
        view.kind === 'dynamic' && view.scopeEntityId !== undefined && !['software-system', 'container'].includes(scope ?? '') ||
        view.kind === 'deployment' && view.scopeEntityId !== undefined && scope !== 'software-system') report(record, 'c4-view-scope', 'El ámbito de la vista no tiene la categoría C4 requerida.');
    if (view.kind === 'deployment' && !nonempty(view.environment)) report(record, 'c4-view-environment', 'La vista de despliegue requiere un entorno explícito.');
    const placements = snapshot.records.filter((r): r is Extract<DomainRecord, { kind: 'placement' }> => r.kind === 'placement' && sameId(r.workspaceId, view.workspaceId));
    for (const placement of placements) {
      const element = lookup(placement.value.entityId); if (!element) continue; const kind = category(element.value.id); if (!kind) continue;
      const data = c4Data(element.value); let allowed = false;
      if (view.kind === 'context') allowed = ['person', 'software-system', 'boundary'].includes(kind);
      if (view.kind === 'containers') allowed = ['person', 'software-system', 'boundary'].includes(kind) || kind === 'container' && !!view.scopeEntityId && ancestor(element.value.id, view.scopeEntityId);
      if (view.kind === 'components') allowed = ['person', 'software-system', 'container', 'boundary'].includes(kind) || kind === 'component' && !!view.scopeEntityId && ancestor(element.value.id, view.scopeEntityId);
      if (view.kind === 'dynamic') allowed = ['person', 'software-system', 'container', 'component', 'boundary'].includes(kind);
      if (view.kind === 'deployment') {
        const parent = lookup(data?.parentId); const environment = kind === 'instance' ? parent && c4Data(parent.value)?.environment : data?.environment;
        allowed = ['deployment-node', 'instance'].includes(kind) && environment === view.environment &&
          (kind !== 'instance' || !view.scopeEntityId || !!data?.instanceOfId && ancestor(data.instanceOfId, view.scopeEntityId));
      }
      if (!allowed) report(record, 'c4-view-element', `El elemento ${element.value.id} no corresponde a la vista ${view.kind}.`);
    }
    if (view.kind !== 'dynamic' && view.steps.length) report(record, 'c4-view-steps', 'Solo una vista dinámica contiene pasos ordenados.');
    for (const step of view.steps) {
      const rv = snapshot.records.find((r) => r.kind === 'relation-view' && sameId(r.workspaceId, view.workspaceId) && sameId(r.value.id, step.relationViewId));
      const rel = rv?.kind === 'relation-view' && snapshot.records.find((r) => r.kind === 'relation' && sameId(r.value.id, rv.value.relationId));
      if (!rel || rel.kind !== 'relation' || !isC4Relationship(rel.value)) report(record, 'c4-step-relationship', 'El paso debe referenciar una vista local de relación C4 existente.');
    }
  }
  return diagnostics;
}
