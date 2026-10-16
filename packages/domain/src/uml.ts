import { copy, diagnostic, isObject, sameId, UUID_PATTERN } from './data.js';
import type { Diagnostic, DomainRecord, DomainSnapshot, Entity, JsonValue, NodeType, RelationType } from './models.js';

export const UML_VERSION = '1.0.0';
export const UML_CATALOG = [{ kind: 'class', label: 'Clase' }, { kind: 'interface', label: 'Interfaz' }, { kind: 'enum', label: 'Enumeración' }, { kind: 'package', label: 'Paquete' }] as const;
export type UmlKind = typeof UML_CATALOG[number]['kind'];
export const UML_RELATIONS = ['association', 'dependency', 'generalization', 'realization', 'aggregation', 'composition'] as const;
export type UmlRelationKind = typeof UML_RELATIONS[number];
export const UML_VISIBILITIES = ['public', 'protected', 'private', 'package'] as const;
export type UmlVisibility = typeof UML_VISIBILITIES[number];
export interface UmlType { [key: string]: JsonValue | undefined; name: string; entityId?: string; }
export interface UmlAttribute { [key: string]: JsonValue | UmlType; id: string; name: string; type: UmlType; visibility: UmlVisibility; static: boolean; readOnly: boolean; defaultValue: string; }
export interface UmlParameter { [key: string]: JsonValue | UmlType; id: string; name: string; type: UmlType; direction: 'in' | 'out' | 'inout'; defaultValue: string; }
export interface UmlMethod { [key: string]: JsonValue | UmlType | UmlParameter[]; id: string; name: string; returnType: UmlType; visibility: UmlVisibility; static: boolean; abstract: boolean; parameters: UmlParameter[]; }
export interface UmlLiteral { [key: string]: JsonValue; id: string; name: string; value: string; }
export interface UmlData {
  [key: string]: JsonValue | UmlAttribute[] | UmlMethod[] | undefined;
  description: string; abstract: boolean; visibility: UmlVisibility; stereotypes: string[]; constraints: string[];
  parentId?: string; attributes: UmlAttribute[]; methods: UmlMethod[]; literals: UmlLiteral[];
}
export type UmlPatch = Partial<Pick<UmlData, 'description' | 'abstract' | 'visibility' | 'stereotypes' | 'constraints' | 'attributes' | 'methods' | 'literals'>> & { parentId?: string | null };
export interface UmlMultiplicity { [key: string]: JsonValue; lower: number; upper: number | '*'; }
export interface UmlEnd { [key: string]: JsonValue | UmlMultiplicity; role: string; multiplicity: UmlMultiplicity; navigable: boolean; }
export interface UmlRelationData { [key: string]: JsonValue | UmlEnd; label: string; source: UmlEnd; target: UmlEnd; stereotypes: string[]; constraints: string[]; }
export type UmlOperation =
  | { action: 'create-element'; kind: UmlKind; title: string; data: UmlPatch; position: { x: number; y: number } }
  | { action: 'update-element'; entityId: string; expectedRevision: number; title: string; data: UmlPatch }
  | { action: 'show-element'; entityId: string; position: { x: number; y: number } }
  | { action: 'create-relationship'; kind: UmlRelationKind; sourcePlacementId: string; targetPlacementId: string; data: UmlRelationData }
  | { action: 'update-relationship'; relationId: string; expectedRevision: number; data: UmlRelationData }
  | { action: 'show-relationship'; relationId: string; sourcePlacementId: string; targetPlacementId: string };
export interface UmlChange { workspaceId: string; operation: UmlOperation; ids: { entityId: string; placementId: string; relationId: string; relationViewId: string }; }

const uuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);
const text = (value: unknown, max = 20000): value is string => typeof value === 'string' && value.length <= max;
const name = (value: unknown): value is string => text(value, 200) && !!value.trim();
const positive = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 1;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every((v) => text(v) && !!v.trim());
export const isUmlKind = (value: unknown): value is UmlKind => UML_CATALOG.some((entry) => entry.kind === value);
export const isUmlRelationKind = (value: unknown): value is UmlRelationKind => (UML_RELATIONS as readonly unknown[]).includes(value);
export const isUmlVisibility = (value: unknown): value is UmlVisibility => (UML_VISIBILITIES as readonly unknown[]).includes(value);
export const umlKind = (entity: Pick<Entity, 'type' | 'typeVersion'>): UmlKind | undefined => entity.typeVersion === UML_VERSION ? UML_CATALOG.find((entry) => `a3.uml.${entry.kind}` === entity.type)?.kind : undefined;
export const umlRelationKind = (relation: { type: string; typeVersion: string }): UmlRelationKind | undefined => relation.typeVersion === UML_VERSION ? UML_RELATIONS.find((kind) => `a3.uml.${kind}` === relation.type) : undefined;
export function umlNodeDefinition(type: string): NodeType | undefined {
  if (!UML_CATALOG.some((entry) => `a3.uml.${entry.kind}` === type)) return undefined;
  return { name: type, version: UML_VERSION, packageId: 'a3.builtin.uml', fields: [], ports: [], bindingFields: [], extensions: {} };
}
export function umlRelationDefinition(type: string): RelationType | undefined {
  const kind = UML_RELATIONS.find((item) => `a3.uml.${item}` === type); if (!kind) return undefined;
  const rule = { entityTypes: UML_CATALOG.filter((item) => kind === 'dependency' || item.kind !== 'package').map((item) => `a3.uml.${item.kind}`), requirePort: false, cardinality: { min: 0, max: null } };
  return { name: type, version: UML_VERSION, direction: 'directed', allowSelf: !['generalization', 'realization'].includes(kind), source: rule, target: { ...rule, entityTypes: [...rule.entityTypes], cardinality: { ...rule.cardinality } }, extensions: {} };
}
export const validUmlType = (v: unknown): v is UmlType => isObject(v) && name(v.name) && (v.entityId === undefined || uuid(v.entityId));
export const validUmlAttribute = (v: unknown): v is UmlAttribute => isObject(v) && uuid(v.id) && name(v.name) && validUmlType(v.type) && isUmlVisibility(v.visibility) && typeof v.static === 'boolean' && typeof v.readOnly === 'boolean' && text(v.defaultValue);
export const validUmlParameter = (v: unknown): v is UmlParameter => isObject(v) && uuid(v.id) && name(v.name) && validUmlType(v.type) && ['in', 'out', 'inout'].includes(String(v.direction)) && text(v.defaultValue);
export const validUmlMethod = (v: unknown): v is UmlMethod => isObject(v) && uuid(v.id) && name(v.name) && validUmlType(v.returnType) && isUmlVisibility(v.visibility) && typeof v.static === 'boolean' && typeof v.abstract === 'boolean' && Array.isArray(v.parameters) && v.parameters.length <= 256 && v.parameters.every(validUmlParameter);
const validLiteral = (v: unknown): v is UmlLiteral => isObject(v) && uuid(v.id) && name(v.name) && text(v.value);
const list = (v: unknown, check: (item: unknown) => boolean): boolean => Array.isArray(v) && v.length <= 512 && v.every(check);
export function validUmlPatch(v: unknown): v is UmlPatch {
  if (!isObject(v)) return false;
  return Object.entries(v).every(([key, value]) => {
    switch (key) {
      case 'description': return text(value); case 'abstract': return typeof value === 'boolean'; case 'visibility': return isUmlVisibility(value);
      case 'stereotypes': case 'constraints': return strings(value); case 'parentId': return value === null || uuid(value);
      case 'attributes': return list(value, validUmlAttribute); case 'methods': return list(value, validUmlMethod); case 'literals': return list(value, validLiteral);
      default: return false;
    }
  });
}
export function validUmlData(v: unknown): v is UmlData {
  return isObject(v) && text(v.description) && typeof v.abstract === 'boolean' && isUmlVisibility(v.visibility) && strings(v.stereotypes) && strings(v.constraints) &&
    (v.parentId === undefined || uuid(v.parentId)) && list(v.attributes, validUmlAttribute) && list(v.methods, validUmlMethod) && list(v.literals, validLiteral);
}
export function umlData(entity: Pick<Entity, 'properties'>): UmlData | undefined { const data = entity.properties['a3.uml']; return validUmlData(data) ? data : undefined; }
export function validMultiplicity(v: unknown): v is UmlMultiplicity { return isObject(v) && Number.isSafeInteger(v.lower) && Number(v.lower) >= 0 && (v.upper === '*' || Number.isSafeInteger(v.upper) && Number(v.upper) >= Number(v.lower)); }
export function validUmlEnd(v: unknown): v is UmlEnd { return isObject(v) && text(v.role, 200) && validMultiplicity(v.multiplicity) && typeof v.navigable === 'boolean'; }
export function validUmlRelationData(v: unknown): v is UmlRelationData { return isObject(v) && text(v.label, 1000) && validUmlEnd(v.source) && validUmlEnd(v.target) && strings(v.stereotypes) && strings(v.constraints); }
export function validUmlOperation(v: unknown): v is UmlOperation {
  if (!isObject(v) || typeof v.action !== 'string') return false;
  const keys: Record<UmlOperation['action'], string[]> = {
    'create-element': ['action', 'kind', 'title', 'data', 'position'], 'update-element': ['action', 'entityId', 'expectedRevision', 'title', 'data'],
    'show-element': ['action', 'entityId', 'position'], 'create-relationship': ['action', 'kind', 'sourcePlacementId', 'targetPlacementId', 'data'],
    'update-relationship': ['action', 'relationId', 'expectedRevision', 'data'], 'show-relationship': ['action', 'relationId', 'sourcePlacementId', 'targetPlacementId']
  };
  if (!Object.hasOwn(keys, v.action) || Object.keys(v).some((key) => !keys[v.action as UmlOperation['action']].includes(key))) return false;
  const point = (p: unknown) => isObject(p) && Object.keys(p).length === 2 && Number.isFinite(p.x) && Number.isFinite(p.y);
  switch (v.action) {
    case 'create-element': return isUmlKind(v.kind) && name(v.title) && validUmlPatch(v.data) && point(v.position);
    case 'update-element': return uuid(v.entityId) && positive(v.expectedRevision) && name(v.title) && validUmlPatch(v.data);
    case 'show-element': return uuid(v.entityId) && point(v.position);
    case 'create-relationship': return isUmlRelationKind(v.kind) && uuid(v.sourcePlacementId) && uuid(v.targetPlacementId) && validUmlRelationData(v.data);
    case 'update-relationship': return uuid(v.relationId) && positive(v.expectedRevision) && validUmlRelationData(v.data);
    case 'show-relationship': return uuid(v.relationId) && uuid(v.sourcePlacementId) && uuid(v.targetPlacementId);
    default: return false;
  }
}

const mergeType = (old: UmlType | undefined, next: UmlType): UmlType => { const result = { ...copy(old ?? {}), ...copy(next) }; if (!next.entityId) delete result.entityId; return result as UmlType; };
export function mergeUmlData(old: UmlData | undefined, patch: UmlPatch): UmlData {
  const next: UmlData = { description: '', abstract: false, visibility: 'public', stereotypes: [], constraints: [], attributes: [], methods: [], literals: [], ...copy(old ?? {}) };
  for (const [key, value] of Object.entries(patch)) { if (value === null) delete next[key]; else next[key] = copy(value); }
  if (patch.attributes) next.attributes = patch.attributes.map((a) => { const before = old?.attributes.find((item) => sameId(item.id, a.id)); return { ...before, ...copy(a), type: mergeType(before?.type, a.type) }; });
  if (patch.methods) next.methods = patch.methods.map((m) => { const before = old?.methods.find((item) => sameId(item.id, m.id)); return { ...before, ...copy(m), returnType: mergeType(before?.returnType, m.returnType), parameters: m.parameters.map((p) => { const previous = before?.parameters.find((item) => sameId(item.id, p.id)); return { ...previous, ...copy(p), type: mergeType(previous?.type, p.type) }; }) }; });
  if (patch.literals) next.literals = patch.literals.map((literal) => ({ ...old?.literals.find((item) => sameId(item.id, literal.id)), ...copy(literal) }));
  return next;
}
export function mergeUmlRelation(old: UmlRelationData | undefined, next: UmlRelationData): UmlRelationData {
  return { ...copy(old ?? {}), ...copy(next), source: { ...old?.source, ...copy(next.source), multiplicity: { ...old?.source.multiplicity, ...copy(next.source.multiplicity) } },
    target: { ...old?.target, ...copy(next.target), multiplicity: { ...old?.target.multiplicity, ...copy(next.target.multiplicity) } } };
}
export const umlMultiplicityText = (m: UmlMultiplicity): string => m.upper === m.lower ? String(m.lower) : `${m.lower}..${m.upper}`;
export const umlVisibilitySymbol = (v: UmlVisibility): string => ({ public: '+', private: '-', protected: '#', package: '~' })[v];
export function remapUmlReferences(data: UmlData, map: (id: string) => string): void {
  if (data.parentId) data.parentId = map(data.parentId);
  const remap = (type: UmlType) => { if (type.entityId) type.entityId = map(type.entityId); };
  data.attributes.forEach((a) => remap(a.type)); data.methods.forEach((m) => { remap(m.returnType); m.parameters.forEach((p) => remap(p.type)); });
}

export function validateUmlSnapshot(snapshot: DomainSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [], entities = new Map(snapshot.records.flatMap((r) => r.kind === 'entity' ? [[r.value.id.toLowerCase(), r] as const] : []));
  const lookup = (id: string) => entities.get(id.toLowerCase());
  const report = (r: DomainRecord, detail: string, message: string) => diagnostics.push(diagnostic(detail, message, { kind: r.kind, id: String(r.value.id) }));
  const inheritance = new Map<string, string[]>();
  for (const record of entities.values()) {
    const kind = umlKind(record.value); if (!kind) continue;
    const data = umlData(record.value); if (!data) { report(record, 'uml-properties-invalid', 'Propiedades UML no soportadas o inválidas; conserva el documento original.'); continue; }
    if (data.parentId) {
      const parent = lookup(data.parentId); if (!parent || umlKind(parent.value) !== 'package') report(record, 'uml-package-parent', 'El propietario UML debe ser un paquete existente.');
      const seen = new Set([record.value.id.toLowerCase()]); let id: string | undefined = data.parentId;
      while (id) { if (seen.has(id.toLowerCase())) { report(record, 'uml-package-cycle', 'La contención de paquetes UML no admite ciclos.'); break; }
        seen.add(id.toLowerCase()); const p = lookup(id); id = p && umlData(p.value)?.parentId; }
    }
    if (kind === 'package' && (data.attributes.length || data.methods.length || data.literals.length || data.abstract)) report(record, 'uml-package-members', 'Un paquete contiene elementos; no atributos, métodos o literales.');
    if (kind !== 'enum' && data.literals.length) report(record, 'uml-literals-category', 'Solo una enumeración contiene literales.');
    const ids = [...data.attributes, ...data.methods, ...data.literals, ...data.methods.flatMap((m) => m.parameters)].map((item) => item.id.toLowerCase());
    if (new Set(ids).size !== ids.length) report(record, 'uml-member-id-duplicate', 'Las identidades de miembros y parámetros deben ser únicas dentro de la entidad.');
    const types = [...data.attributes.map((a) => a.type), ...data.methods.flatMap((m) => [m.returnType, ...m.parameters.map((p) => p.type)])];
    for (const type of types) if (type.entityId) { const target = lookup(type.entityId); if (!target || !umlKind(target.value) || umlKind(target.value) === 'package') report(record, 'uml-type-reference', 'El tipo referenciado debe ser un clasificador UML compatible.'); }
  }
  for (const record of snapshot.records) {
    if (record.kind !== 'relation') continue; const kind = umlRelationKind(record.value); if (!kind) continue;
    const source = lookup(record.value.source.entityId), target = lookup(record.value.target.entityId), sk = source && umlKind(source.value), tk = target && umlKind(target.value);
    const data = record.value.properties['a3.uml'];
    if (!validUmlRelationData(data)) report(record, 'uml-relationship-properties', 'La relación requiere roles, multiplicidades y metadatos UML válidos.');
    if (!sk || !tk || record.value.source.portId !== undefined || record.value.target.portId !== undefined) { report(record, 'uml-relationship-endpoint', 'La relación UML requiere entidades UML compatibles, sin puertos.'); continue; }
    if (kind !== 'dependency' && (sk === 'package' || tk === 'package')) report(record, 'uml-classifier-required', 'Esta relación conecta clasificadores, no paquetes.');
    if (kind === 'generalization') {
      if (!['class', 'interface'].includes(sk) || sk !== tk) report(record, 'uml-generalization-category', 'El subconjunto permite clase→clase o interfaz→interfaz.');
      const key = source.value.id.toLowerCase(), parents = inheritance.get(key) ?? []; parents.push(target.value.id.toLowerCase()); inheritance.set(key, parents);
    }
    if (kind === 'realization' && (sk !== 'class' || tk !== 'interface')) report(record, 'uml-realization-category', 'Una realización conecta clase implementadora→interfaz.');
    if (['aggregation', 'composition'].includes(kind) && sk !== 'class') report(record, 'uml-whole-category', 'El extremo origen de agregación/composición es la clase que representa el todo.');
    if (kind === 'composition' && validUmlRelationData(data) && (data.source.multiplicity.upper === '*' || data.source.multiplicity.upper > 1)) report(record, 'uml-composite-whole-multiplicity', 'Una parte compuesta tiene como máximo un todo a la vez.');
  }
  // Generalization is acyclic; ordinary associations and dependencies may be cyclic.
  const done = new Set<string>(), visiting = new Set<string>();
  const cycle = (id: string): boolean => { if (visiting.has(id)) return true; if (done.has(id)) return false; visiting.add(id);
    for (const parent of inheritance.get(id) ?? []) if (cycle(parent)) return true; visiting.delete(id); done.add(id); return false; };
  for (const id of inheritance.keys()) if (cycle(id)) { const r = lookup(id); if (r) report(r, 'uml-generalization-cycle', 'La jerarquía de generalización no admite ciclos.'); break; }
  return diagnostics;
}
