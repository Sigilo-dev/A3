import { validVariableBinding, validVariableScope } from '@a3/domain';
import type { ProjectVariablesState, SetProjectVariables, VariablesQuery, PromptContextCatalog, PromptContextCompileInput, ProjectPromptContextResult } from '@a3/project-store';
import type { JsonValue, PromptTemplateCompilationResult, VariableBinding, VariableTextResolution } from '@a3/domain';
export type VariablesRequest = { action: 'load'; sessionId: string; query: VariablesQuery } |
  { action: 'context-catalog'; sessionId: string } |
  { action: 'compile-context'; sessionId: string; input: PromptContextCompileInput } |
  { action: 'compile'; sessionId: string; source: string; requiredNames: string[]; query: VariablesQuery } |
  { action: 'compile-template'; sessionId: string; templateSource: string; inputs: Record<string, JsonValue>; query: VariablesQuery } |
  { action: 'set'; sessionId: string; input: SetProjectVariables; query: VariablesQuery } |
  { action: 'bind'; sessionId: string; entityId: string; expectedRevision: number; field: string; binding: VariableBinding | null; query: VariablesQuery };
export type VariablesResult = { ok: true; value: ProjectVariablesState | VariableTextResolution | PromptTemplateCompilationResult | PromptContextCatalog | ProjectPromptContextResult } | { ok: false; error: { code: string; message: string; recovery: string } };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function safeJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((entry) => safeJson(entry, depth + 1));
  return object(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((entry) => safeJson(entry, depth + 1));
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const revision = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 1;
function validQuery(value: unknown): boolean {
  return object(value) && Object.keys(value).every((key) => ['workspaceId', 'entityId', 'executionVariables', 'referenceScope'].includes(key)) &&
    (value.workspaceId === undefined || uuid(value.workspaceId)) && (value.entityId === undefined || uuid(value.entityId)) &&
    (value.referenceScope === undefined || validVariableScope(value.referenceScope, true)) &&
    (value.executionVariables === undefined || Array.isArray(value.executionVariables) && value.executionVariables.length <= 256);
}
export function validVariablesRequest(value: unknown): value is VariablesRequest {
  if (!object(value) || !uuid(value.sessionId) || value.action !== 'context-catalog' && value.action !== 'compile-context' && !validQuery(value.query)) return false;
  try { if (JSON.stringify(value).length > (value.action === 'compile' || value.action === 'compile-template' || value.action === 'compile-context' ? 5 * 1024 * 1024 : 128 * 1024)) return false; } catch { return false; }
  const keys = value.action === 'load' ? ['action', 'sessionId', 'query'] : value.action === 'context-catalog' ? ['action', 'sessionId'] : value.action === 'compile-context' ? ['action', 'sessionId', 'input'] : value.action === 'compile' ? ['action', 'sessionId', 'query', 'source', 'requiredNames'] :
    value.action === 'compile-template' ? ['action', 'sessionId', 'query', 'templateSource', 'inputs'] : value.action === 'set' ? ['action', 'sessionId', 'query', 'input'] : ['action', 'sessionId', 'query', 'entityId', 'expectedRevision', 'field', 'binding'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) return false;
  if (value.action === 'load' || value.action === 'context-catalog') return true;
  if (value.action === 'compile-context') {
    if (!object(value.input) || Object.keys(value.input).some((key) => !['mode', 'source', 'inputs', 'requiredNames', 'query', 'selection', 'maxBytes', 'split'].includes(key)) ||
        Object.keys(value.input).length !== 8 || !['template', 'manual'].includes(String(value.input.mode)) || typeof value.input.source !== 'string' || value.input.source.length > 2 * 1024 * 1024 ||
        !object(value.input.inputs) || !safeJson(value.input.inputs) || JSON.stringify(value.input.inputs).length > 128 * 1024 || !Array.isArray(value.input.requiredNames) || value.input.requiredNames.length > 256 ||
        !value.input.requiredNames.every((name) => typeof name === 'string' && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(name)) || !validQuery(value.input.query) ||
        !Number.isSafeInteger(value.input.maxBytes) || Number(value.input.maxBytes) < 4 * 1024 || Number(value.input.maxBytes) > 1024 * 1024 || typeof value.input.split !== 'boolean' || !object(value.input.selection)) return false;
    const selection = value.input.selection;
    if (Object.keys(selection).length !== 4 || Object.keys(selection).some((key) => !['entities', 'resourceIds', 'relationIds', 'excludedSourceKeys'].includes(key)) ||
        !Array.isArray(selection.entities) || selection.entities.length > 128 || !Array.isArray(selection.resourceIds) || selection.resourceIds.length > 128 ||
        !Array.isArray(selection.relationIds) || selection.relationIds.length > 128 || !Array.isArray(selection.excludedSourceKeys) || selection.excludedSourceKeys.length > 512) return false;
    const selected = new Set<string>();
    for (const item of selection.entities) {
      if (!object(item) || Object.keys(item).length !== 2 || !uuid(item.entityId) || !['selection', 'requirement', 'acceptance-criterion'].includes(String(item.role)) || selected.has(String(item.entityId).toLowerCase())) return false;
      selected.add(String(item.entityId).toLowerCase());
    }
    for (const id of [...selection.resourceIds, ...selection.relationIds]) {
      if (!uuid(id) || selected.has(String(id).toLowerCase())) return false;
      selected.add(String(id).toLowerCase());
    }
    return selection.excludedSourceKeys.every((key) => typeof key === 'string' && /^(?:entity|resource|relation):[0-9a-f-]{36}$/i.test(key));
  }
  if (value.action === 'compile') return typeof value.source === 'string' && value.source.length <= 2 * 1024 * 1024 && Array.isArray(value.requiredNames) && value.requiredNames.length <= 256 && value.requiredNames.every((name) => typeof name === 'string' && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(name));
  if (value.action === 'compile-template') return typeof value.templateSource === 'string' && value.templateSource.length <= 2 * 1024 * 1024 && object(value.inputs) && safeJson(value.inputs) && JSON.stringify(value.inputs).length <= 128 * 1024;
  if (value.action === 'set') return object(value.input) && Object.keys(value.input).length === 3 && Object.keys(value.input).every((key) => ['scope', 'expectedRevision', 'variables'].includes(key)) && validVariableScope(value.input.scope) &&
    (value.input.expectedRevision === null || revision(value.input.expectedRevision)) && Array.isArray(value.input.variables) && value.input.variables.length <= 256;
  return value.action === 'bind' && uuid(value.entityId) && revision(value.expectedRevision) && typeof value.field === 'string' && value.field.length <= 256 &&
    (value.binding === null || validVariableBinding(value.binding));
}
