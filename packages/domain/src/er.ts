import { copy, diagnostic, isObject, sameId, UUID_PATTERN } from './data.js';
import type { Diagnostic, DomainRecord, DomainSnapshot, Entity, JsonValue, NodeType, RelationType } from './models.js';

export const ER_VERSION = '1.0.0';
export const ER_CARDINALITIES = ['one', 'zero-or-one', 'many', 'zero-or-many'] as const;
export type ErCardinality = typeof ER_CARDINALITIES[number];
export interface ErForeignKey { [key: string]: JsonValue | undefined; tableId: string; fieldId: string; }
export interface ErField { [key: string]: JsonValue | ErForeignKey | undefined; id: string; name: string; type: string; nullable: boolean; primaryKey: boolean; unique: boolean; foreignKey?: ErForeignKey; }
export interface ErTableData { [key: string]: JsonValue | ErField[] | undefined; fields: ErField[]; description: string; }
export interface ErRelationData { [key: string]: JsonValue; label: string; sourceCardinality: ErCardinality; targetCardinality: ErCardinality; identifying: boolean; }
export type ErPatch = Partial<ErTableData>;
export type ErOperation =
  | { action: 'create-table'; title: string; data: ErPatch; position: { x: number; y: number } }
  | { action: 'update-table'; entityId: string; expectedRevision: number; title: string; data: ErPatch }
  | { action: 'show-table'; entityId: string; position: { x: number; y: number } }
  | { action: 'create-relationship'; sourcePlacementId: string; targetPlacementId: string; data: ErRelationData }
  | { action: 'update-relationship'; relationId: string; expectedRevision: number; data: ErRelationData }
  | { action: 'show-relationship'; relationId: string; sourcePlacementId: string; targetPlacementId: string };
export interface ErChange { workspaceId: string; operation: ErOperation; ids: { entityId: string; placementId: string; relationId: string; relationViewId: string }; }

const uuid = (v: unknown): v is string => typeof v === 'string' && UUID_PATTERN.test(v);
const titleText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const cardinality = (v: unknown): v is ErCardinality => (ER_CARDINALITIES as readonly unknown[]).includes(v);
export const erTable = (entity: Pick<Entity, 'type' | 'typeVersion'>): boolean => entity.type === 'a3.er.table' && entity.typeVersion === ER_VERSION;
export const erRelationship = (relation: { type: string; typeVersion: string }): boolean => relation.type === 'a3.er.relationship' && relation.typeVersion === ER_VERSION;
export function erNodeDefinition(type: string): NodeType | undefined {
  if (type !== 'a3.er.table') return undefined;
  return { name: type, version: ER_VERSION, packageId: 'a3.builtin.er', fields: [], ports: [], bindingFields: [], extensions: {} };
}
export function erRelationDefinition(type: string): RelationType | undefined {
  if (type !== 'a3.er.relationship') return undefined;
  const rule = { entityTypes: ['a3.er.table'], requirePort: false, cardinality: { min: 0, max: null } };
  return { name: type, version: ER_VERSION, direction: 'directed', allowSelf: true, source: rule, target: { ...rule, entityTypes: [...rule.entityTypes], cardinality: { ...rule.cardinality } }, extensions: {} };
}
export const validErForeignKey = (v: unknown): v is ErForeignKey => isObject(v) && uuid(v.tableId) && uuid(v.fieldId);
export const validErField = (v: unknown): v is ErField => isObject(v) && uuid(v.id) && titleText(v.name) && titleText(v.type, 200) &&
  typeof v.nullable === 'boolean' && typeof v.primaryKey === 'boolean' && typeof v.unique === 'boolean' && (v.foreignKey === undefined || validErForeignKey(v.foreignKey));
export const validErTableData = (v: unknown): v is ErTableData => isObject(v) && typeof v.description === 'string' && v.description.length <= 20000 &&
  Array.isArray(v.fields) && v.fields.length <= 512 && v.fields.every(validErField);
export const erData = (entity: Pick<Entity, 'properties'>): ErTableData | undefined => {
  const value = entity.properties['a3.er']; return validErTableData(value) ? value : undefined;
};
export const validErRelationData = (v: unknown): v is ErRelationData => isObject(v) && typeof v.label === 'string' && v.label.length <= 200 &&
  cardinality(v.sourceCardinality) && cardinality(v.targetCardinality) && typeof v.identifying === 'boolean';
export function mergeErRelation(old: ErRelationData | undefined, next: ErRelationData): ErRelationData { return { ...copy(old ?? {}), ...copy(next) }; }
export function validErPatch(v: unknown): v is ErPatch {
  return isObject(v) && Object.entries(v).every(([key, value]) => key === 'description' ? typeof value === 'string' && value.length <= 20000 :
    key === 'fields' && Array.isArray(value) && value.length <= 512 && value.every(validErField));
}
export function validErOperation(v: unknown): v is ErOperation {
  if (!isObject(v) || typeof v.action !== 'string') return false;
  const keys: Record<ErOperation['action'], string[]> = {
    'create-table': ['action', 'title', 'data', 'position'], 'update-table': ['action', 'entityId', 'expectedRevision', 'title', 'data'],
    'show-table': ['action', 'entityId', 'position'], 'create-relationship': ['action', 'sourcePlacementId', 'targetPlacementId', 'data'],
    'update-relationship': ['action', 'relationId', 'expectedRevision', 'data'], 'show-relationship': ['action', 'relationId', 'sourcePlacementId', 'targetPlacementId']
  };
  if (!Object.hasOwn(keys, v.action) || Object.keys(v).some((key) => !keys[v.action as ErOperation['action']].includes(key))) return false;
  const point = (p: unknown) => isObject(p) && Object.keys(p).length === 2 && Number.isFinite(p.x) && Number.isFinite(p.y);
  switch (v.action) {
    case 'create-table': return titleText(v.title) && validErPatch(v.data) && point(v.position);
    case 'update-table': return uuid(v.entityId) && Number.isSafeInteger(v.expectedRevision) && Number(v.expectedRevision) > 0 && titleText(v.title) && validErPatch(v.data);
    case 'show-table': return uuid(v.entityId) && point(v.position);
    case 'create-relationship': return uuid(v.sourcePlacementId) && uuid(v.targetPlacementId) && validErRelationData(v.data);
    case 'update-relationship': return uuid(v.relationId) && Number.isSafeInteger(v.expectedRevision) && Number(v.expectedRevision) > 0 && validErRelationData(v.data);
    case 'show-relationship': return uuid(v.relationId) && uuid(v.sourcePlacementId) && uuid(v.targetPlacementId);
    default: return false;
  }
}

export function mergeErData(old: ErTableData | undefined, patch: ErPatch): ErTableData {
  const next = { fields: [], description: '', ...copy(old ?? {}) } as ErTableData;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.fields) next.fields = patch.fields.map((field) => {
    const before = old?.fields.find((item) => sameId(item.id, field.id));
    const result = { ...copy(before ?? {}), ...copy(field) } as ErField;
    if (field.foreignKey) result.foreignKey = { ...copy(before?.foreignKey ?? {}), ...copy(field.foreignKey) };
    else delete result.foreignKey;
    return result;
  });
  return next;
}

export function validateErSnapshot(snapshot: DomainSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [], entities = new Map(snapshot.records.flatMap((r) => r.kind === 'entity' ? [[r.value.id.toLowerCase(), r.value] as const] : []));
  const tables = new Map([...entities.values()].filter((e) => erTable(e)).map((e) => [e.id.toLowerCase(), e]));
  const tableData = (id: string) => { const e = tables.get(id.toLowerCase()); return e && erData(e); };
  const field = (tableId: string, fieldId: string) => tableData(tableId)?.fields.find((f) => sameId(f.id, fieldId));
  const report = (record: DomainRecord, detail: string, message: string) => diagnostics.push(diagnostic(detail, message, { kind: record.kind, id: String(record.value.id) }));
  for (const table of tables.values()) {
    const data = erData(table);
    if (!data) { const record = snapshot.records.find((r) => r.kind === 'entity' && sameId(r.value.id, table.id)); if (record) report(record, 'er-properties-invalid', 'Los campos ER son inválidos o no compatibles; conserva el documento original.'); continue; }
    const seen = new Set<string>();
    for (const f of data.fields) {
      if (seen.has(f.id.toLowerCase())) report({ kind: 'entity', value: table }, 'er-field-id-duplicate', 'Los IDs de campo deben ser únicos dentro de la tabla.');
      seen.add(f.id.toLowerCase());
      if (f.primaryKey && f.nullable) report({ kind: 'entity', value: table }, 'er-primary-nullable', 'Un campo de clave primaria no puede ser nullable.');
      if (f.foreignKey) {
        const targetTable = tables.get(f.foreignKey.tableId.toLowerCase()), target = field(f.foreignKey.tableId, f.foreignKey.fieldId);
        if (!targetTable || !target) report({ kind: 'entity', value: table }, 'er-foreign-key-target-missing', 'La clave foránea debe referenciar un campo de una tabla ER existente.');
        else if (!target.primaryKey && !target.unique) report({ kind: 'entity', value: table }, 'er-foreign-key-target-not-key', 'El campo referenciado por una clave foránea debe ser PK o único.');
      }
    }
  }
  for (const record of snapshot.records) {
    if (record.kind !== 'relation' || !erRelationship(record.value)) continue;
    if (!validErRelationData(record.value.properties['a3.er'])) report(record, 'er-relationship-properties', 'La relación ER requiere cardinalidad y etiqueta válidas.');
    for (const id of [record.value.source.entityId, record.value.target.entityId]) {
      if (!tables.has(id.toLowerCase()) || record.value.source.portId !== undefined || record.value.target.portId !== undefined) {
        report(record, 'er-relationship-endpoint', 'Una relación ER une tablas, sin usar puertos.'); break;
      }
    }
  }
  return diagnostics;
}

export interface ErExport { ok: boolean; content: string; diagnostics: string[]; }
const exportedType = /^[A-Za-z][A-Za-z0-9_-]*(?:(?:\([0-9]+(?:,[0-9]+)?\))|(?:\[[0-9]*(?:,[0-9]+)?\]))?$/;
const exportedIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
function erName(title: string, id: string): string {
  const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'table';
  return `T_${slug}_${id.replaceAll('-', '').toLowerCase()}`;
}
function erAlias(title: string): string {
  return /[\u0000-\u001f"\\\[\]]/.test(title) ? '' : `[${JSON.stringify(title)}]`;
}
function erMarker(cardinality: ErCardinality, end: 'source' | 'target'): string {
  if (cardinality === 'one') return '||';
  if (cardinality === 'zero-or-one') return end === 'source' ? 'o|' : '|o';
  if (cardinality === 'many') return end === 'source' ? '}|' : '|{';
  return end === 'source' ? '}o' : 'o{';
}
/** Exports only identifiers/types and relation labels representable by the declared Mermaid ER subset. */
export function exportMermaidEr(state: { elements: readonly { id: string; title: string; data: ErTableData }[];
  relationships: readonly { id: string; sourceEntityId: string; targetEntityId: string; data: ErRelationData }[] }): ErExport {
  const diagnostics: string[] = [], elements = [...state.elements].sort((a, b) => a.id.localeCompare(b.id)), names = new Map(elements.map((e) => [e.id.toLowerCase(), erName(e.title, e.id)]));
  for (const table of elements) for (const field of table.data.fields) {
    if (!exportedIdentifier.test(field.name)) diagnostics.push(`Campo «${field.name}» de ${table.title}: Mermaid ER requiere identificador ASCII sin espacios.`);
    if (!exportedType.test(field.type)) diagnostics.push(`Tipo «${field.type}» de ${table.title}.${field.name}: fuera de la gramática segura de este exportador.`);
    if (field.foreignKey && !names.has(field.foreignKey.tableId.toLowerCase())) diagnostics.push(`Campo ${table.title}.${field.name}: tabla destino fuera del modelo exportado.`);
    else if (field.foreignKey && !state.elements.find((e) => sameId(e.id, field.foreignKey!.tableId))?.data.fields.some((f) => sameId(f.id, field.foreignKey!.fieldId))) diagnostics.push(`Campo ${table.title}.${field.name}: campo destino fuera del modelo exportado.`);
  }
  for (const table of elements) {
    const seen = new Set<string>();
    for (const field of table.data.fields) {
      if (seen.has(field.id.toLowerCase())) diagnostics.push(`Tabla ${table.title}: ID de campo duplicado ${field.id}.`);
      seen.add(field.id.toLowerCase());
      if (field.primaryKey && field.nullable) diagnostics.push(`Campo ${table.title}.${field.name}: una clave primaria no puede ser nullable.`);
      if (field.foreignKey) {
        const target = elements.find((e) => sameId(e.id, field.foreignKey!.tableId))?.data.fields.find((f) => sameId(f.id, field.foreignKey!.fieldId));
        if (!target || !target.primaryKey && !target.unique) diagnostics.push(`Campo ${table.title}.${field.name}: la clave foránea no referencia una clave válida.`);
      }
    }
  }
  for (const rel of state.relationships) if (!names.has(rel.sourceEntityId.toLowerCase()) || !names.has(rel.targetEntityId.toLowerCase()) ||
      rel.data.label && !/^[A-Za-z0-9_ -]{1,80}$/.test(rel.data.label)) diagnostics.push(`Relación ${rel.id}: extremos o etiqueta fuera del subconjunto Mermaid ER.`);
  if (diagnostics.length) return { ok: false, content: '', diagnostics };
  const lines = ['erDiagram'];
  for (const table of elements) {
    const tableName = names.get(table.id.toLowerCase())!;
    lines.push(`    %% A3 table ${table.id} ${JSON.stringify(table.title)}`, `    ${tableName}${erAlias(table.title)} {`);
    for (const field of table.data.fields) {
      const keys = [field.primaryKey && 'PK', field.foreignKey && 'FK', field.unique && 'UK'].filter(Boolean).join(', ');
      const comment = [field.nullable ? 'nullable' : 'not null', field.foreignKey ? `A3 FK ${field.foreignKey.tableId}.${field.foreignKey.fieldId}` : ''].filter(Boolean).join('; ');
      lines.push(`        ${field.type} ${field.name}${keys ? ` ${keys}` : ''} ${JSON.stringify(comment)}`);
      lines.push(`        %% A3 field ${table.id}.${field.id}`);
    }
    lines.push('    }');
  }
  for (const rel of [...state.relationships].sort((a, b) => a.id.localeCompare(b.id))) {
    const source = names.get(rel.sourceEntityId.toLowerCase())!, target = names.get(rel.targetEntityId.toLowerCase())!;
    lines.push(`    %% A3 relation ${rel.id}`, `    ${source} ${erMarker(rel.data.sourceCardinality, 'source')}${rel.data.identifying ? '--' : '..'}${erMarker(rel.data.targetCardinality, 'target')} ${target} : ${rel.data.label || 'relates'}`);
  }
  return { ok: true, content: `${lines.join('\n')}\n`, diagnostics: [] };
}

export function remapErReferences(data: ErTableData, map: (id: string) => string): void {
  for (const field of data.fields) if (field.foreignKey) {
    field.foreignKey.tableId = map(field.foreignKey.tableId);
    // The referenced field ID stays unchanged when its owning table is not duplicated.
  }
}
