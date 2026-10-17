import { copy, diagnostic, indexSnapshot, isJson, isObject, NAMESPACE_PATTERN, sameId, UUID_PATTERN } from './data.js';
import type { Diagnostic, DocumentRef, DomainRecord, DomainSnapshot, Entity, FieldRule, JsonValue, NodeType, Outcome, UUID, ValueSpec, Variable, VariableBinding, VariableSelectorScope, VariableSet } from './models.js';

export interface VariableContext { workspaceId?: UUID; entityId?: UUID; executionVariables?: Variable[]; }
export interface EffectiveVariable {
  name: string; value: JsonValue; valueType: ValueSpec['valueType']; scope: VariableSelectorScope;
  dependencies: { name: string; scope: VariableSelectorScope }[];
}
export interface EffectiveField { name: string; value: JsonValue; valueType: ValueSpec['valueType']; source: 'literal' | 'variable'; variable?: EffectiveVariable; }
export interface VariableTextIssue {
  name?: string; detail: string; message: string; required: boolean; offset?: number; line?: number; column?: number;
}
export interface VariableTextResolution {
  /** A derived string; callers must keep the original source unchanged. */
  text: string;
  /** Copy/export form with explicit diagnostics when any reference is unresolved. */
  markedExport: string;
  variables: EffectiveVariable[];
  unresolved: VariableTextIssue[];
  canSendAutomatically: boolean;
}
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

/** Resolves only explicit {{namespace.name}} tokens into a derived view. It never edits source text. */
export function resolveVariableText(snapshot: DomainSnapshot, source: string, context: VariableContext = {}, requiredNames: readonly string[] = []): VariableTextResolution {
  const unresolved: VariableTextIssue[] = [], used = new Map<string, EffectiveVariable>();
  if (typeof source !== 'string' || source.length > 2 * 1024 * 1024 || !isJson(context) || !Array.isArray(requiredNames) ||
    requiredNames.length > 256 || Array.from(requiredNames).some((name) => typeof name !== 'string' || !NAMESPACE_PATTERN.test(name))) {
    const issue: VariableTextIssue = { detail: 'variable-template-invalid', message: 'La plantilla o su contexto supera el contrato de resolución.', required: true };
    return { text: String(source ?? ''), markedExport: `> **A3: resolución de variables bloqueada**\n> ${issue.message}\n\n${String(source ?? '')}`, variables: [], unresolved: [issue], canSendAutomatically: false };
  }
  const required = new Set(requiredNames);
  let lookup: Lookup;
  try { lookup = indexSnapshot(snapshot); }
  catch {
    const issue: VariableTextIssue = { detail: 'variable-invalid', message: 'El snapshot del proyecto no se puede indexar para compilar.', required: true };
    return { text: source, markedExport: `> **A3: resolución de variables bloqueada**\n> ${issue.message}\n\n${source}`, variables: [], unresolved: [issue], canSendAutomatically: false };
  }
  const cache = new Map<string, Outcome<EffectiveVariable>>();
  const effective = (name: string): Outcome<EffectiveVariable> => {
    let value = cache.get(name); if (!value) { value = resolveIndexedVariable(snapshot, name, context, lookup); cache.set(name, value); }
    return value;
  };
  const loc = (value: string, offset: number): Pick<VariableTextIssue, 'offset' | 'line' | 'column'> => {
    const before = value.slice(0, offset), lines = before.split('\n'); return { offset, line: lines.length, column: lines.at(-1)!.length + 1 };
  };
  let tokenCount = 0;
  const render = (value: string, active: Set<string>, origin?: string): string => {
    const token = /\{\{([^{}]*)\}\}/g; let result = '', last = 0, match: RegExpExecArray | null;
    while ((match = token.exec(value))) {
      result += value.slice(last, match.index);
      const name = match[1]!.trim(), position = loc(value, match.index);
      if (++tokenCount > 10000) {
        unresolved.push({ ...(origin ? { name: origin } : {}), detail: 'variable-template-token-limit', message: 'La plantilla supera el límite seguro de 10 000 referencias.', required: true, ...position });
        return result + value.slice(match.index);
      }
      if (!NAMESPACE_PATTERN.test(name)) {
        unresolved.push({ ...(origin ? { name: origin } : {}), detail: 'variable-template-syntax-invalid', message: 'El token debe usar un nombre con namespace, por ejemplo {{proyecto.nombre}}.', required: true, ...position });
        result += `[A3: variable inválida ${match[0]}]`; last = token.lastIndex; continue;
      }
      const resolved = effective(name);
      if (!resolved.ok) {
        const issue = resolved.diagnostics[0]!;
        unresolved.push({ name, detail: issue.detail, message: issue.message, required: required.has(name), ...position });
        result += `[A3: variable sin resolver ${name} · ${issue.detail}]`; last = token.lastIndex; continue;
      }
      const identity = `${resolved.value.scope.kind}:${resolved.value.scope.kind === 'execution' ? '' : resolved.value.scope.ownerId.toLowerCase()}:${name}`;
      if (active.size >= 64) {
        unresolved.push({ name, detail: 'variable-depth-limit', message: 'La cadena de interpolación supera el límite de 64 niveles.', required: required.has(name), ...position });
        result += `[A3: límite de profundidad ${name}]`; last = token.lastIndex; continue;
      }
      if (active.has(identity)) {
        unresolved.push({ name, detail: 'variable-cycle', message: `Se detectó una referencia cíclica al resolver ${name}.`, required: required.has(name), ...position });
        result += `[A3: ciclo de variable ${name}]`; last = token.lastIndex; continue;
      }
      used.set(identity, resolved.value);
      const replacement = typeof resolved.value.value === 'string' ? render(resolved.value.value, new Set([...active, identity]), name) : JSON.stringify(resolved.value.value);
      result += replacement; last = token.lastIndex;
      if (result.length > 4 * 1024 * 1024) {
        unresolved.push({ ...(origin ? { name: origin } : {}), detail: 'variable-template-output-limit', message: 'La salida compilada supera el límite seguro de 4 MiB.', required: true, ...position });
        return result.slice(0, 4 * 1024 * 1024);
      }
    }
    return result + value.slice(last);
  };
  const text = render(source, new Set());
  // Required declarations are checked even when the template accidentally omits their token.
  for (const name of required) {
    const resolved = effective(name);
    if (resolved.ok) used.set(`${resolved.value.scope.kind}:${resolved.value.scope.kind === 'execution' ? '' : resolved.value.scope.ownerId.toLowerCase()}:${name}`, resolved.value);
    else if (!unresolved.some((issue) => issue.name === name && issue.required)) unresolved.push({ name, detail: resolved.diagnostics[0]?.detail ?? 'variable-missing',
      message: resolved.diagnostics[0]?.message ?? `La variable obligatoria ${name} no se resolvió.`, required: true });
  }
  const markedExport = unresolved.length ? `> **A3: exportación con variables sin resolver**\n> ${unresolved.map((issue) => `- ${issue.name ?? 'plantilla'} · ${issue.detail}: ${issue.message}`).join('\n> ')}\n\n${text}` : text;
  return { text, markedExport, variables: [...used.values()], unresolved, canSendAutomatically: !unresolved.some((issue) => issue.required) };
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
