import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { schemas } from '../.generated/schemas.js';
import { canonical, diagnostic, indexSnapshot, isJson, isObject, refKey, refOf, sameId } from './data.js';
import type { Diagnostic, DomainRecord, DomainSnapshot, Entity, Endpoint, EndpointRule, JsonValue, NodeType, Relation, RelationType, TypeRegistry, ValueType } from './models.js';
import { resolveValidatedVariable } from './variables.js';
import { conceptualNodeTypeDefinition, conceptualRelationType } from './conceptual-diagrams.js';
import { c4NodeDefinition, c4RelationDefinition, isC4Category, validateC4Snapshot } from './c4.js';
import { umlNodeDefinition, umlRelationDefinition, validateUmlSnapshot } from './uml.js';
import { erNodeDefinition, erRelationDefinition, validateErSnapshot } from './er.js';
import { iotNodeDefinition, validateIotSnapshot } from './iot.js';
import { IOT_CIRCUIT_TYPE, IOT_CIRCUIT_VERSION, validateIotCircuitSnapshot } from './iot-circuit.js';

const ajv = new Ajv2020({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
ajv.addFormat('utc-date-time', (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value.replace('Z', '.000Z');
});
ajv.addFormat('absolute-url', (value: string) => {
  // URL is provided by both Electron/Node and browsers; no Node or DOM import.
  const URLConstructor = (globalThis as unknown as { URL: new (input: string) => { protocol: string } }).URL;
  try { return Boolean(new URLConstructor(value).protocol); } catch { return false; }
});
for (const schema of Object.values(schemas)) ajv.addSchema(schema as AnySchemaObject);
const scopedKinds = new Set(['placement', 'visual-edge', 'relation-view', 'group', 'drawing']);
const e1Kinds = new Set(['group', 'collection', 'variable-set', 'node-type', 'relation-type']);
const e2Kinds = new Set(['drawing']);
const recordKinds = new Set(['project', 'workspace', 'entity', 'resource', 'relation', 'placement', 'visual-edge', 'relation-view', 'group', 'collection', 'variable-set', 'drawing']);

export function validateDefinition(kind: 'node-type' | 'relation-type', value: unknown): Diagnostic[] {
  const diagnostics = validateShape(kind, value);
  if (diagnostics.length) return diagnostics;
  if (kind === 'node-type') {
    const definition = value as NodeType;
    if ('a3.c4.category' in definition.extensions && !isC4Category(definition.extensions['a3.c4.category'])) {
      diagnostics.push(diagnostic('c4-category-invalid', 'El tipo personalizado debe declarar una categoría C4 soportada.'));
    }
    if (new Set(definition.fields.map((f) => f.name)).size !== definition.fields.length ||
        new Set(definition.ports.map((p) => p.id)).size !== definition.ports.length) {
      diagnostics.push(diagnostic('duplicate-definition-member', 'Los campos y puertos deben tener identidades únicas.'));
    }
  } else {
    const definition = value as RelationType;
    for (const rule of [definition.source, definition.target]) {
      if (rule.cardinality.max !== null && rule.cardinality.min > rule.cardinality.max) {
        diagnostics.push(diagnostic('invalid-cardinality', 'La cardinalidad mínima supera la máxima.'));
      }
    }
    const supportedRule = (rule: EndpointRule) => ({ entityTypes: rule.entityTypes === '*' ? '*' : [...rule.entityTypes].sort(), requirePort: rule.requirePort,
      portDirections: rule.portDirections ? [...rule.portDirections].sort() : null, cardinality: { min: rule.cardinality.min, max: rule.cardinality.max } });
    if (definition.direction === 'undirected' && canonical(supportedRule(definition.source)) !== canonical(supportedRule(definition.target))) {
      diagnostics.push(diagnostic('asymmetric-undirected-rule', 'Una relación no dirigida requiere reglas simétricas.'));
    }
  }
  return diagnostics;
}

export function validateRegistry(registry: TypeRegistry): Diagnostic[] {
  if (!isJson(registry) || !Array.isArray(registry.nodeTypes) || !Array.isArray(registry.relationTypes)) {
    return [diagnostic('invalid-registry', 'El catálogo de tipos no es válido.')];
  }
  const diagnostics: Diagnostic[] = [];
  for (const [kind, definitions] of [['node-type', registry.nodeTypes], ['relation-type', registry.relationTypes]] as const) {
    const seen = new Set<string>();
    for (const definition of definitions) {
      const errors = validateDefinition(kind, definition);
      diagnostics.push(...errors);
      if (errors.length) continue;
      const key = `${definition.name}@${definition.version}`;
      if (seen.has(key)) diagnostics.push(diagnostic('duplicate-type', `El tipo ${key} está repetido.`));
      seen.add(key);
    }
  }
  return diagnostics;
}

function validateShape(kind: string, value: unknown): Diagnostic[] {
  if (!isJson(value)) return [diagnostic('non-json-data', 'Los datos deben ser JSON finito, sin ciclos ni accessors.')];
  const version = e2Kinds.has(kind) ? 'e2' : e1Kinds.has(kind) ? 'e1' : 'e0';
  const validator = ajv.getSchema(`https://sigilo-dev.github.io/A3/schemas/${version}/${kind}.schema.json`);
  if (!validator) return [diagnostic('unknown-document-kind', 'El tipo de documento no está soportado.')];
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error) => ({
    ...diagnostic('schema-invalid', `${kind}${error.instancePath}: ${error.message ?? 'inválido'}`),
    instancePath: error.instancePath
  }));
}

export function validateRecord(record: unknown): Diagnostic[] {
  if (!isJson(record) || !isObject(record) || typeof record.kind !== 'string' || !recordKinds.has(record.kind)) {
    return [diagnostic('invalid-record', 'El registro de dominio no es válido.')];
  }
  const diagnostics = validateShape(record.kind, record.value);
  if (scopedKinds.has(record.kind)) {
    const validator = ajv.getSchema('https://sigilo-dev.github.io/A3/schemas/e0/common.schema.json#/$defs/uuid')!;
    if (!validator(record.workspaceId)) diagnostics.push(diagnostic('workspace-scope-missing', 'La vista requiere workspaceId válido.'));
  } else if ('workspaceId' in record) diagnostics.push(diagnostic('unexpected-workspace-scope', 'Un documento global no pertenece a un workspace.'));
  return diagnostics;
}

export const matchesValueType = (value: JsonValue, type: ValueType): boolean => type === 'json' || typeof value === type;
const typeKey = (value: { name: string; version: string }): string => `${value.name}@${value.version}`;
export const findNodeType = (registry: TypeRegistry, entity: Entity): NodeType | undefined => {
  const builtin = entity.typeVersion === '1.0.0'
    ? conceptualNodeTypeDefinition(entity.type) ?? c4NodeDefinition(entity.type) ?? umlNodeDefinition(entity.type) ?? erNodeDefinition(entity.type) ?? iotNodeDefinition(entity.type)
    : undefined;
  const circuit = entity.type === IOT_CIRCUIT_TYPE && entity.typeVersion === IOT_CIRCUIT_VERSION
    ? { name: IOT_CIRCUIT_TYPE, version: IOT_CIRCUIT_VERSION, packageId: 'a3.builtin.iot', fields: [], ports: [], bindingFields: [], extensions: {} }
    : undefined;
  return builtin ?? circuit ?? registry.nodeTypes.find((d) => typeKey(d) === `${entity.type}@${entity.typeVersion}`);
};
export const findRelationType = (registry: TypeRegistry, relation: Relation): RelationType | undefined =>
  (relation.type === 'a3.conceptual.relationship' && relation.typeVersion === '1.0.0' ? conceptualRelationType() : undefined) ??
  (relation.type === 'a3.c4.relationship' && relation.typeVersion === '1.0.0' ? c4RelationDefinition() : undefined) ??
  (relation.typeVersion === '1.0.0' ? erRelationDefinition(relation.type) : undefined) ??
  (relation.typeVersion === '1.0.0' ? umlRelationDefinition(relation.type) : undefined) ??
  registry.relationTypes.find((d) => typeKey(d) === `${relation.type}@${relation.typeVersion}`);
const matchesEntity = (entity: Entity, rule: EndpointRule): boolean => rule.entityTypes === '*' || rule.entityTypes.includes(entity.type);
const endpointKey = (endpoint: Endpoint): string => endpoint.entityId.toLowerCase() + ':' + (endpoint.portId ?? '');

export function validateSnapshot(snapshot: DomainSnapshot, registry: TypeRegistry): Diagnostic[] {
  if (!isJson(snapshot) || !Array.isArray(snapshot.records)) return [diagnostic('invalid-snapshot', 'El snapshot no es válido.')];
  const diagnostics = [...validateRegistry(registry), ...snapshot.records.flatMap(validateRecord)];
  if (diagnostics.some((d) => d.severity === 'error')) return diagnostics;
  const projects = snapshot.records.filter((r) => r.kind === 'project');
  if (projects.length !== 1) return [...diagnostics, diagnostic('project-count', 'El snapshot requiere exactamente un manifiesto.')];
  const project = projects[0]!;
  const lookup = indexSnapshot(snapshot);
  const seen = new Set<string>();
  const report = (record: DomainRecord, detail: string, message: string, severity: Diagnostic['severity'] = 'error'): void => {
    diagnostics.push(diagnostic(detail, message, refOf(record), 'VALIDATION_FAILED', severity));
  };
  for (const record of snapshot.records) {
    const ref = refOf(record);
    const identity = record.kind === 'variable-set' ? refKey(ref) :
      record.kind === 'group' || record.kind === 'drawing' ? `local:${ref.workspaceId}:${ref.id}`.toLowerCase() : `global:${ref.id.toLowerCase()}`;
    if (seen.has(identity)) report(record, 'duplicate-id', `Identidad repetida: ${identity}.`);
    seen.add(identity);
    if ('workspaceId' in record && !lookup({ kind: 'workspace', id: record.workspaceId })) {
      report(record, 'workspace-missing', `Workspace ${record.workspaceId} ausente.`);
    }
    if (record.kind === 'entity') {
      if (record.value.contentResourceId && !lookup({ kind: 'resource', id: record.value.contentResourceId })) {
        report(record, 'resource-missing', `Recurso ${record.value.contentResourceId} ausente.`);
      }
      if (new Set(record.value.ports.map((p) => p.id)).size !== record.value.ports.length) report(record, 'duplicate-port', 'Puerto repetido.');
      const definition = findNodeType(registry, record.value);
      if (!definition) report(record, 'node-type-unavailable', `Tipo ${record.value.type}@${record.value.typeVersion} ausente; se conserva el contenido.`, 'warning');
      for (const field of definition?.fields ?? []) {
        const value = record.value.properties[field.name];
        if (value === undefined ? field.required : !matchesValueType(value, field.valueType)) report(record, 'node-field-invalid', `Campo ${field.name} inválido.`);
      }
    }
    if (record.kind === 'collection') for (const id of record.value.entityIds) {
      if (!lookup({ kind: 'entity', id })) report(record, 'collection-entity-missing', `Entidad ${id} ausente.`);
    }
    if (record.kind === 'collection' && new Set(record.value.entityIds.map((id) => id.toLowerCase())).size !== record.value.entityIds.length) report(record, 'duplicate-collection-member', 'Miembro de colección repetido.');
    if (record.kind === 'variable-set') {
      const owner = lookup({ kind: record.value.scope.kind, id: record.value.scope.ownerId });
      if (!owner) report(record, 'variable-owner-missing', 'Propietario de variables ausente.');
      if (new Set(record.value.variables.map((v) => v.name)).size !== record.value.variables.length) report(record, 'duplicate-variable', 'Variable repetida en el mismo alcance.');
      for (const variable of record.value.variables) {
        if (variable.source.kind === 'literal' && !matchesValueType(variable.source.value, variable.valueType)) {
          report(record, 'variable-type-invalid', `Tipo de ${variable.name} inválido.`);
        }
        const scope = record.value.scope;
        const result = resolveValidatedVariable(snapshot, variable.name, {
          ...(scope.kind === 'workspace' ? { workspaceId: scope.ownerId } : {}),
          ...(scope.kind === 'entity' ? { entityId: scope.ownerId } : {})
        }, lookup);
        if (!result.ok) for (const issue of result.diagnostics) report(record, issue.detail, issue.message,
          issue.detail === 'variable-missing' ? 'warning' : 'error');
      }
    }
    if (record.kind === 'placement' && !lookup({ kind: 'entity', id: record.value.entityId })) report(record, 'entity-missing', `Entidad ${record.value.entityId} ausente.`);
    if (record.kind === 'relation') {
      const definition = findRelationType(registry, record.value);
      if (!definition) report(record, 'relation-rule-unavailable', `Reglas de ${record.value.type}@${record.value.typeVersion} ausentes.`, 'warning');
      if (definition && !definition.allowSelf && sameId(record.value.source.entityId, record.value.target.entityId)) report(record, 'self-relation-forbidden', 'La relación no admite el mismo extremo.');
      for (const [role, end] of [['source', record.value.source], ['target', record.value.target]] as const) {
        const entity = lookup({ kind: 'entity', id: end.entityId });
        if (entity?.kind !== 'entity') { report(record, 'relation-entity-missing', `Entidad ${end.entityId} ausente.`); continue; }
        if (end.portId !== undefined && !entity.value.ports.some((p) => p.id === end.portId)) report(record, 'port-missing', `Puerto ${end.portId} ausente en ${end.entityId}.`);
        const rule = definition?.[role];
        if (!rule) continue;
        if (!matchesEntity(entity.value, rule)) report(record, 'endpoint-type-invalid', `Tipo no admitido en ${role}.`);
        if ((rule.requirePort || rule.portDirections) && !end.portId) report(record, 'endpoint-port-required', `Puerto requerido en ${role}.`);
        if (rule.portDirections && end.portId) {
          const nodeType = findNodeType(registry, entity.value);
          const port = nodeType?.ports.find((p) => p.id === end.portId);
          if (!port) report(record, 'endpoint-rule-unavailable', `Dirección del puerto ${end.portId} desconocida.`, 'warning');
          else if (!rule.portDirections.includes(port.direction)) report(record, 'port-direction-invalid', `Dirección de ${end.portId} no admitida en ${role}.`);
        }
      }
    }
    if (record.kind === 'visual-edge' || record.kind === 'relation-view') {
      const source = lookup({ kind: 'placement', id: record.value.sourcePlacementId, workspaceId: record.workspaceId });
      const target = lookup({ kind: 'placement', id: record.value.targetPlacementId, workspaceId: record.workspaceId });
      if (source?.kind !== 'placement' || target?.kind !== 'placement') { report(record, 'placement-not-local', 'Los extremos deben existir en el mismo workspace.'); continue; }
      if (record.kind === 'relation-view') {
        const relation = lookup({ kind: 'relation', id: record.value.relationId });
        if (relation?.kind !== 'relation') report(record, 'relation-missing', `Relación ${record.value.relationId} ausente.`);
        else if (!sameId(source.value.entityId, relation.value.source.entityId) || !sameId(target.value.entityId, relation.value.target.entityId)) {
          report(record, 'relation-view-endpoints', 'La vista no representa los extremos de la relación.');
        }
      }
    }
    if (record.kind === 'group') {
      const members = new Set<string>();
      for (const member of record.value.members) {
        const key = member.kind + ':' + member.id.toLowerCase();
        if (members.has(key)) report(record, 'duplicate-group-member', 'Miembro de grupo repetido.');
        members.add(key);
        if (!lookup({ kind: member.kind, id: member.id, workspaceId: record.workspaceId })) report(record, 'group-member-missing', `Miembro ${member.id} ausente.`);
      }
    }
  }
  if (!lookup({ kind: 'workspace', id: project.value.defaultWorkspaceId })) report(project, 'default-workspace-missing', 'Workspace principal ausente.');

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visitGroup(record: Extract<DomainRecord, { kind: 'group' }>): void {
    const key = refKey(refOf(record));
    if (visiting.has(key)) { report(record, 'group-cycle', 'Los grupos no pueden contener ciclos.'); return; }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const member of record.value.members.filter((m) => m.kind === 'group')) {
      const child = lookup({ kind: 'group', id: member.id, workspaceId: record.workspaceId });
      if (child?.kind === 'group') visitGroup(child);
    }
    visiting.delete(key); visited.add(key);
  }
  snapshot.records.filter((r) => r.kind === 'group').forEach(visitGroup);
  const relations = snapshot.records.filter((r) => r.kind === 'relation');
  for (const definition of registry.relationTypes) {
    const matching = relations.filter((r) => `${r.value.type}@${r.value.typeVersion}` === typeKey(definition));
    for (const role of definition.direction === 'undirected' ? ['source'] as const : ['source', 'target'] as const) {
      const rule = definition[role];
      if (rule.cardinality.min === 0 && rule.cardinality.max === null) continue;
      for (const record of snapshot.records.filter((r) => r.kind === 'entity' && matchesEntity(r.value, rule))) {
        if (record.kind !== 'entity') continue;
        const candidates: Endpoint[] = rule.requirePort || rule.portDirections
          ? record.value.ports.filter((p) => {
            const direction = findNodeType(registry, record.value)?.ports.find((q) => q.id === p.id)?.direction;
            return !rule.portDirections || direction !== undefined && rule.portDirections.includes(direction);
          }).map((p) => ({ entityId: record.value.id, portId: p.id }))
          : [{ entityId: record.value.id }, ...record.value.ports.map((p) => ({ entityId: record.value.id, portId: p.id }))];
        for (const endpoint of candidates) {
          const key = endpointKey(endpoint);
          const count = matching.filter((r) => endpointKey(r.value[role]) === key || definition.direction === 'undirected' && endpointKey(r.value.target) === key).length;
          if (rule.cardinality.max !== null && count > rule.cardinality.max) report(record, 'cardinality-max', `${definition.name}/${role}/${endpoint.portId ?? ''}: ${count} supera ${rule.cardinality.max}.`);
          if (count < rule.cardinality.min) report(record, 'cardinality-incomplete', `${definition.name}/${role}/${endpoint.portId ?? ''}: ${count} no alcanza ${rule.cardinality.min}.`, 'warning');
        }
      }
    }
  }
  return [...diagnostics, ...validateC4Snapshot(snapshot, registry), ...validateUmlSnapshot(snapshot), ...validateErSnapshot(snapshot), ...validateIotSnapshot(snapshot), ...validateIotCircuitSnapshot(snapshot)];
}

export function defaultRegistry(): TypeRegistry {
  const rule: EndpointRule = { entityTypes: '*', requirePort: false, cardinality: { min: 0, max: null } };
  return { nodeTypes: [], relationTypes: [{ name: 'a3.core.references', version: '1.0.0', direction: 'directed', allowSelf: true, source: rule, target: { ...rule, cardinality: { ...rule.cardinality } }, extensions: {} }] };
}
