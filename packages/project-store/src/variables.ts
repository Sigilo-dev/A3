import { findNodeType, resolveEffectiveVariable, resolveEntityField, type Diagnostic, type DomainSnapshot, type EffectiveField, type EffectiveVariable, type FieldRule, type Outcome, type TypeRegistry, type VariableBinding, type VariableScope, type VariableSelectorScope, type VariableSet } from '@a3/domain';
import type { VariableContext } from '@a3/domain';

export interface VariablesQuery extends VariableContext { referenceScope?: VariableSelectorScope; }
export interface ProjectVariablesState {
  sessionId: string; projectId: string; canEdit: boolean; sets: VariableSet[];
  blockedScopes: { scope: VariableScope; diagnostics: string[] }[];
  workspaces: { id: string; name: string }[];
  entities: { id: string; title: string; revision: number; type: string }[];
  resources: { id: string; label: string }[];
  effective: { name: string; result: Outcome<EffectiveVariable> }[];
  executionDiagnostics: Diagnostic[];
  fields: { rule: FieldRule; acceptsBinding: boolean; binding?: VariableBinding; result: Outcome<EffectiveField> }[];
}
/** Regenerated from the accepted snapshot; transient execution values are not project documents. */
export function projectVariablesState(snapshot: DomainSnapshot, registry: TypeRegistry, sessionId: string, projectId: string, canEdit: boolean, query: VariablesQuery): ProjectVariablesState {
  const sets = snapshot.records.filter((r) => r.kind === 'variable-set').map((r) => r.kind === 'variable-set' ? r.value : null).filter((v): v is VariableSet => v !== null);
  const names = [...new Set([...sets.flatMap((set) => set.variables.map((variable) => variable.name)), ...(query.executionVariables ?? []).map((variable) => variable.name)])].sort();
  const entity = snapshot.records.find((r) => r.kind === 'entity' && r.value.id.toLowerCase() === query.entityId?.toLowerCase());
  const definition = entity?.kind === 'entity' ? findNodeType(registry, entity.value) : undefined;
  const { referenceScope, ...context } = query;
  return structuredClone({ sessionId, projectId, canEdit, sets, blockedScopes: [],
    workspaces: snapshot.records.flatMap((r) => r.kind === 'workspace' ? [{ id: r.value.id, name: r.value.name }] : []),
    entities: snapshot.records.flatMap((r) => r.kind === 'entity' ? [{ id: r.value.id, title: r.value.title, revision: r.value.revision, type: r.value.type }] : []),
    resources: snapshot.records.flatMap((r) => r.kind === 'resource' ? [{ id: r.value.id, label: r.value.kind === 'remote-url' ? r.value.id : r.value.path }] : []),
    effective: names.map((name) => ({ name, result: resolveEffectiveVariable(snapshot, name, context, referenceScope) })),
    executionDiagnostics: (context.executionVariables ?? []).flatMap((variable) => {
      const result = resolveEffectiveVariable(snapshot, variable.name, context, { kind: 'execution' }); return result.ok ? [] : result.diagnostics;
    }),
    fields: entity?.kind === 'entity' && definition ? definition.fields.map((rule) => ({ rule, acceptsBinding: definition.bindingFields.includes(rule.name) && rule.acceptsBinding !== false,
      ...(entity.value.bindings[rule.name] ? { binding: entity.value.bindings[rule.name] as unknown as VariableBinding } : {}),
      result: resolveEntityField(snapshot, definition, entity.value, rule.name, context) })) : [] });
}
export interface SetProjectVariables { scope: VariableScope; expectedRevision: number | null; variables: VariableSet['variables']; }
