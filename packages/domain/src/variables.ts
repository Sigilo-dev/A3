import { copy, diagnostic, indexSnapshot, isJson, isObject, NAMESPACE_PATTERN, sameId, UUID_PATTERN } from './data.js';
import type { Diagnostic, DocumentRef, DomainRecord, DomainSnapshot, Entity, FieldRule, JsonValue, NodeType, Outcome, UUID, ValueSpec, Variable, VariableBinding, VariableSelectorScope, VariableSet } from './models.js';

export interface VariableContext { workspaceId?: UUID; entityId?: UUID; executionVariables?: Variable[]; }
export interface EffectiveVariable {
  name: string; value: JsonValue; valueType: ValueSpec['valueType']; scope: VariableSelectorScope;
  dependencies: { name: string; scope: VariableSelectorScope }[];
}
export interface EffectiveField { name: string; value: JsonValue; valueType: ValueSpec['valueType']; source: 'literal' | 'variable'; variable?: EffectiveVariable; }
type Lookup = (ref: DocumentRef) => DomainRecord | undefined;
/** E1 fields that were opaque remain opaque until an explicit versioned edit. */
export function interpretedVariables(set: VariableSet): Variable[] {
  if (set.schemaVersion !== '1.0.0') return set.variables;
  return set.variables.map((variable) => {
    const interpreted: Variable = { ...variable, source: { ...variable.source } };
    for (const key of ['enumValues', 'items', 'referenceKinds', 'minimum', 'maximum']) delete interpreted[key];
    delete interpreted.source.scope; return interpreted;
  });
}
const fail = <T>(detail: string, message: string): Outcome<T> => ({ ok: false, diagnostics: [diagnostic(detail, message)] });
export function validVariableScope(scope: unknown, execution = false): scope is VariableSelectorScope {
  return isObject(scope) && (scope.kind === 'execution' ? execution && Object.keys(scope).length === 1 :
    ['project', 'workspace', 'entity'].includes(String(scope.kind)) && typeof scope.ownerId === 'string' && UUID_PATTERN.test(scope.ownerId));
}
export function validValueSpec(value: unknown, depth = 0): value is ValueSpec {
  if (depth > 8 || !isObject(value) || !['string', 'number', 'boolean', 'enum', 'list', 'reference', 'json'].includes(String(value.valueType))) return false;
  if (value.valueType === 'enum' && (!Array.isArray(value.enumValues) || !value.enumValues.length || value.enumValues.some((v) => typeof v !== 'string') || new Set(value.enumValues).size !== value.enumValues.length)) return false;
  if (value.valueType === 'list' && !validValueSpec(value.items, depth + 1)) return false;
  if (value.referenceKinds !== undefined && (!Array.isArray(value.referenceKinds) || !value.referenceKinds.length || value.referenceKinds.some((kind) => kind !== 'entity' && kind !== 'resource') || new Set(value.referenceKinds).size !== value.referenceKinds.length)) return false;
  if ([value.minimum, value.maximum].some((v) => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v)))) return false;
  return !(typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum);
}
export function matchesTypedValue(value: JsonValue, spec: ValueSpec, lookup?: Lookup): boolean {
  if (!validValueSpec(spec) || !isJson(value)) return false;
  switch (spec.valueType) {
    case 'json': return true;
    case 'enum': return typeof value === 'string' && spec.enumValues!.includes(value);
    case 'list': return Array.isArray(value) && value.every((item) => matchesTypedValue(item, spec.items!, lookup));
    case 'reference': return isObject(value) && (value.kind === 'entity' || value.kind === 'resource') && typeof value.id === 'string' && UUID_PATTERN.test(value.id) &&
      (!spec.referenceKinds || spec.referenceKinds.includes(value.kind)) && (!lookup || !!lookup({ kind: value.kind, id: value.id }));
    case 'number': return typeof value === 'number' && Number.isFinite(value) && (spec.minimum === undefined || value >= spec.minimum) && (spec.maximum === undefined || value <= spec.maximum);
    default: return typeof value === spec.valueType;
  }
}
/** Preserve opaque descriptor members when a known list item declaration is edited. */
export function mergeValueSpec(previous: ValueSpec | undefined, next: ValueSpec): ValueSpec {
  if (!validValueSpec(next)) return copy(next);
  return { ...previous, ...copy(next), ...(next.items ? { items: mergeValueSpec(previous?.items, next.items) } : {}) };
}
export function validVariableBinding(value: unknown): value is VariableBinding {
  return isObject(value) && value.kind === 'variable' && typeof value.name === 'string' && NAMESPACE_PATTERN.test(value.name) && (value.scope === undefined || validVariableScope(value.scope, true));
}
/** Rejects explicit credential markers and reserved names, not arbitrary free-form secret detection. */
export function variableCredential(variable: unknown): boolean {
  if (!isObject(variable)) return false;
  return variable.secret === true || variable.sensitive === true || variable.classification === 'credential' ||
    typeof variable.name === 'string' && /(?:^|\.)(?:credentials?|secrets?|password|token|api-key|access-token|refresh-token|contrasena|clave-api)(?:\.|$)/.test(variable.name) ||
    isObject(variable.source) && variable.source.kind === 'literal' && typeof variable.source.value === 'string' && /^(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(variable.source.value);
}
export function validateVariable(variable: unknown): Diagnostic[] {
  if (!isJson(variable) || !isObject(variable) || typeof variable.name !== 'string' || !NAMESPACE_PATTERN.test(variable.name) || !validValueSpec(variable) || !isObject(variable.source) ||
    (variable.source.kind === 'literal' ? !Object.hasOwn(variable.source, 'value') : variable.source.kind !== 'reference' || typeof variable.source.name !== 'string' || !NAMESPACE_PATTERN.test(variable.source.name) ||
      variable.source.scope !== undefined && !validVariableScope(variable.source.scope, true))) return [diagnostic('variable-invalid', 'Variable o declaración de tipo inválida.')];
  return variableCredential(variable) ? [diagnostic('variable-credential-forbidden', 'Las credenciales no son variables; no se han guardado.')] : [];
}
export function resolveEffectiveVariable(snapshot: DomainSnapshot, name: string, context: VariableContext = {}, scope?: VariableSelectorScope): Outcome<EffectiveVariable> {
  if (!isJson(snapshot) || !Array.isArray(snapshot.records)) return fail('variable-invalid', 'Snapshot de variables inválido.');
  try { return resolveIndexedVariable(snapshot, name, context, indexSnapshot(snapshot), scope); }
  catch { return fail('variable-invalid', 'El snapshot de variables no es válido.'); }
}
export function resolveVariable(snapshot: DomainSnapshot, name: string, context: VariableContext = {}): Outcome<JsonValue> {
  const result = resolveEffectiveVariable(snapshot, name, context);
  return result.ok ? { ...result, value: result.value.value } : result;
}
export function resolveValidatedVariable(snapshot: DomainSnapshot, name: string, context: VariableContext, lookup: Lookup): Outcome<JsonValue> {
  const result = resolveIndexedVariable(snapshot, name, context, lookup);
  return result.ok ? { ...result, value: result.value.value } : result;
}
function resolveIndexedVariable(snapshot: DomainSnapshot, name: string, context: VariableContext, lookup: Lookup, explicit?: VariableSelectorScope): Outcome<EffectiveVariable> {
  if (typeof name !== 'string' || !NAMESPACE_PATTERN.test(name) || !isJson(context) || explicit !== undefined && !validVariableScope(explicit, true)) return fail('variable-invalid', 'Nombre o contexto de variables inválido.');
  const project = snapshot.records.find((r) => r.kind === 'project');
  if (project?.kind !== 'project') return fail('project-missing', 'Manifiesto ausente.');
  for (const [kind, id] of [['workspace', context.workspaceId], ['entity', context.entityId]] as const) {
    if (id !== undefined && (typeof id !== 'string' || !UUID_PATTERN.test(id) || !lookup({ kind, id }))) return fail('variable-context-missing', 'El contexto de variables no existe.');
  }
  const layers: { scope: VariableSelectorScope; variables: Variable[] }[] = [{ scope: { kind: 'execution' }, variables: context.executionVariables ?? [] }];
  for (const [kind, id] of [['entity', context.entityId], ['workspace', context.workspaceId], ['project', project.value.projectId]] as const) {
    if (!id) continue;
    const record = lookup({ kind: 'variable-set', id, variableScope: kind });
    if (record?.kind === 'variable-set' && !['1.0.0', '1.1.0'].includes(record.value.schemaVersion)) return fail('variable-version-unsupported', 'La versión del ámbito no se interpreta ni se degrada.');
    if (record?.kind === 'variable-set') layers.push({ scope: record.value.scope, variables: interpretedVariables(record.value) });
  }
  for (const layer of layers) {
    if (!Array.isArray(layer.variables)) return fail('variable-invalid', 'Lista de variables inválida.');
    const issues = layer.variables.flatMap(validateVariable); if (issues.length) return { ok: false, diagnostics: issues };
    if (new Set(layer.variables.map((v) => v.name)).size !== layer.variables.length) return fail('duplicate-variable', 'Hay variables repetidas en un mismo alcance.');
  }
  const stack = new Set<string>();
  function resolve(current: string, selectedScope?: VariableSelectorScope): Outcome<EffectiveVariable> {
    let layer = layers.find((layer) => layer.variables.some((v) => v.name === current));
    if (selectedScope) {
      if (selectedScope.kind === 'execution') layer = layers[0];
      else {
        if (!lookup({ kind: selectedScope.kind, id: selectedScope.ownerId })) return fail('variable-context-missing', 'El propietario de la referencia explícita no existe.');
        const record = lookup({ kind: 'variable-set', id: selectedScope.ownerId, variableScope: selectedScope.kind });
        if (record?.kind === 'variable-set' && !['1.0.0', '1.1.0'].includes(record.value.schemaVersion)) return fail('variable-version-unsupported', 'La versión del ámbito no se interpreta ni se degrada.');
        layer = record?.kind === 'variable-set' ? { scope: record.value.scope, variables: interpretedVariables(record.value) } : undefined;
      }
    }
    // An entity export without a workspace must not silently pick the project default.
    if (!selectedScope && !context.workspaceId && context.entityId && (!layer || layer.scope.kind === 'project')) {
      const workspaces = new Set(snapshot.records.filter((r) => r.kind === 'placement' && sameId(r.value.entityId, context.entityId!)).map((r) => r.kind === 'placement' ? r.workspaceId.toLowerCase() : ''));
      if (snapshot.records.some((r) => r.kind === 'variable-set' && r.value.scope.kind === 'workspace' && workspaces.has(r.value.scope.ownerId.toLowerCase()) && r.value.variables.some((v) => v.name === current))) return fail('variable-context-required', 'Selecciona un workspace o una referencia de ámbito explícita para esta entidad.');
    }
    const variable = layer?.variables.find((v) => v.name === current);
    if (!variable || !layer) return fail('variable-missing', `Variable ${current} no disponible en este contexto.`);
    const invalid = validateVariable(variable); if (invalid.length) return { ok: false, diagnostics: invalid };
    const key = `${layer.scope.kind}:${layer.scope.kind === 'execution' ? '' : layer.scope.ownerId.toLowerCase()}:${current}`;
    if (stack.has(key) || stack.size >= 64) return fail('variable-cycle', 'Ciclo de variables o cadena de referencias superior al límite de 64.');
    stack.add(key);
    const resolved = variable.source.kind === 'reference' ? resolve(variable.source.name, variable.source.scope) : undefined;
    stack.delete(key); if (resolved && !resolved.ok) return resolved;
    const value = resolved?.ok ? resolved.value.value : variable.source.kind === 'literal' ? variable.source.value : null;
    if (!matchesTypedValue(value, variable, lookup)) return fail('variable-type-invalid', `Tipo o referencia de ${current} incompatible.`);
    return { ok: true, value: { name: current, value: copy(value), valueType: variable.valueType, scope: copy(layer.scope),
      dependencies: resolved?.ok ? [{ name: resolved.value.name, scope: resolved.value.scope }, ...resolved.value.dependencies] : [] }, diagnostics: [] };
  }
  return resolve(name, explicit);
}
export function resolveEntityField(snapshot: DomainSnapshot, definition: NodeType, entity: Entity, fieldName: string, context: VariableContext = {}): Outcome<EffectiveField> {
  const field: FieldRule | undefined = definition.fields.find((field) => field.name === fieldName);
  if (!field) return fail('node-field-undeclared', 'El tipo de nodo no declara ese campo.');
  const binding = entity.bindings[fieldName];
  if (binding !== undefined) {
    if (!definition.bindingFields.includes(fieldName) || field.acceptsBinding === false || !validVariableBinding(binding)) return fail('node-binding-forbidden', 'El campo no admite este binding declarativo.');
    const result = resolveEffectiveVariable(snapshot, binding.name, { ...context, entityId: entity.id }, binding.scope);
    if (!result.ok) return result;
    if (!matchesTypedValue(result.value.value, field, indexSnapshot(snapshot))) return fail('node-field-invalid', `El binding no produce el tipo/rango de ${fieldName}.`);
    return { ok: true, value: { name: fieldName, value: result.value.value, valueType: field.valueType, source: 'variable', variable: result.value }, diagnostics: [] };
  }
  const value = entity.properties[fieldName];
  return value !== undefined && matchesTypedValue(value, field, indexSnapshot(snapshot)) ? { ok: true, value: { name: fieldName, value: copy(value), valueType: field.valueType, source: 'literal' }, diagnostics: [] } : fail('node-field-invalid', `Campo ${fieldName} ausente o incompatible.`);
}
