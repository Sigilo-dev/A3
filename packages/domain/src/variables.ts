import { copy, diagnostic, indexSnapshot, isJson, isObject, NAMESPACE_PATTERN, UUID_PATTERN } from './data.js';
import type { DocumentRef, DomainRecord, DomainSnapshot, JsonValue, Outcome, UUID, Variable } from './models.js';

export interface VariableContext { workspaceId?: UUID; entityId?: UUID; executionVariables?: Variable[]; }

export function resolveVariable(snapshot: DomainSnapshot, name: string, context: VariableContext = {}): Outcome<JsonValue> {
  if (!isJson(snapshot) || !Array.isArray(snapshot.records)) {
    return { ok: false, diagnostics: [diagnostic('variable-invalid', 'El snapshot o nombre de variable no es válido.')] };
  }
  try { return resolveValidatedVariable(snapshot, name, context, indexSnapshot(snapshot)); }
  catch { return { ok: false, diagnostics: [diagnostic('variable-invalid', 'El snapshot de variables no es válido.')] }; }
}

// Internal graph validation already checked snapshot structure; reuse its index.
export function resolveValidatedVariable(snapshot: DomainSnapshot, name: string, context: VariableContext,
  lookup: (ref: DocumentRef) => DomainRecord | undefined): Outcome<JsonValue> {
  if (typeof name !== 'string' || !NAMESPACE_PATTERN.test(name) || !isJson(context)) {
    return { ok: false, diagnostics: [diagnostic('variable-invalid', 'Nombre o contexto de variables inválido.')] };
  }
  const project = snapshot.records.find((r) => r.kind === 'project');
  if (project?.kind !== 'project') return { ok: false, diagnostics: [diagnostic('project-missing', 'Manifiesto ausente.')] };
  for (const [kind, id] of [['workspace', context.workspaceId], ['entity', context.entityId]] as const) {
    if (id !== undefined && (typeof id !== 'string' || !UUID_PATTERN.test(id) || !lookup({ kind, id }))) return { ok: false, diagnostics: [diagnostic('variable-context-missing', 'El contexto de variables no existe.')] };
  }
  const layers: Variable[][] = [context.executionVariables ?? []];
  for (const [kind, id] of [['entity', context.entityId], ['workspace', context.workspaceId], ['project', project.value.projectId]] as const) {
    if (!id) continue;
    const record = lookup({ kind: 'variable-set', id, variableScope: kind });
    if (record?.kind === 'variable-set') layers.push(record.value.variables);
  }
  if (!isJson(layers) || layers.some((layer) => !Array.isArray(layer) || layer.some((variable) =>
      !isObject(variable) || typeof variable.name !== 'string' || !NAMESPACE_PATTERN.test(variable.name) ||
      !['string', 'number', 'boolean', 'json'].includes(variable.valueType) || !isObject(variable.source) ||
      (variable.source.kind === 'literal' ? !Object.hasOwn(variable.source, 'value') :
        variable.source.kind !== 'reference' || typeof variable.source.name !== 'string' || !NAMESPACE_PATTERN.test(variable.source.name))))) {
    return { ok: false, diagnostics: [diagnostic('variable-invalid', 'Las variables no son datos declarativos válidos.')] };
  }
  if (layers.some((layer) => new Set(layer.map((variable) => variable.name)).size !== layer.length)) {
    return { ok: false, diagnostics: [diagnostic('duplicate-variable', 'Hay variables repetidas en un mismo alcance.')] };
  }
  const stack = new Set<string>();
  function resolve(current: string): Outcome<JsonValue> {
    if (stack.has(current)) return { ok: false, diagnostics: [diagnostic('variable-cycle', `Ciclo de variables en ${current}.`)] };
    const variable = layers.flat().find((v) => v.name === current);
    if (!variable) return { ok: false, diagnostics: [diagnostic('variable-missing', `Variable ${current} no disponible en este contexto.`, undefined, 'RESOURCE_MISSING')] };
    stack.add(current);
    const result: Outcome<JsonValue> = variable.source.kind === 'reference'
      ? resolve(variable.source.name) : { ok: true, value: copy(variable.source.value), diagnostics: [] };
    stack.delete(current);
    if (result.ok && variable.valueType !== 'json' && typeof result.value !== variable.valueType) {
      return { ok: false, diagnostics: [diagnostic('variable-type-invalid', `Tipo de ${current} incompatible.`)] };
    }
    return result;
  }
  return resolve(name);
}
