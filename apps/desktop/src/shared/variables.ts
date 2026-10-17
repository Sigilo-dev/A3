import { validVariableBinding, validVariableScope } from '@a3/domain';
import type { ProjectVariablesState, SetProjectVariables, VariablesQuery } from '@a3/project-store';
import type { JsonValue, PromptTemplateCompilationResult, VariableBinding, VariableTextResolution } from '@a3/domain';
export type VariablesRequest = { action: 'load'; sessionId: string; query: VariablesQuery } |
  { action: 'compile'; sessionId: string; source: string; requiredNames: string[]; query: VariablesQuery } |
  { action: 'compile-template'; sessionId: string; templateSource: string; inputs: Record<string, JsonValue>; query: VariablesQuery } |
  { action: 'set'; sessionId: string; input: SetProjectVariables; query: VariablesQuery } |
  { action: 'bind'; sessionId: string; entityId: string; expectedRevision: number; field: string; binding: VariableBinding | null; query: VariablesQuery };
export type VariablesResult = { ok: true; value: ProjectVariablesState | VariableTextResolution | PromptTemplateCompilationResult } | { ok: false; error: { code: string; message: string; recovery: string } };
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
  if (!object(value) || !uuid(value.sessionId) || !validQuery(value.query)) return false;
  try { if (JSON.stringify(value).length > (value.action === 'compile' || value.action === 'compile-template' ? 5 * 1024 * 1024 : 128 * 1024)) return false; } catch { return false; }
  const keys = value.action === 'load' ? ['action', 'sessionId', 'query'] : value.action === 'compile' ? ['action', 'sessionId', 'query', 'source', 'requiredNames'] :
    value.action === 'compile-template' ? ['action', 'sessionId', 'query', 'templateSource', 'inputs'] : value.action === 'set' ? ['action', 'sessionId', 'query', 'input'] : ['action', 'sessionId', 'query', 'entityId', 'expectedRevision', 'field', 'binding'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) return false;
  if (value.action === 'load') return true;
  if (value.action === 'compile') return typeof value.source === 'string' && value.source.length <= 2 * 1024 * 1024 && Array.isArray(value.requiredNames) && value.requiredNames.length <= 256 && value.requiredNames.every((name) => typeof name === 'string' && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(name));
  if (value.action === 'compile-template') return typeof value.templateSource === 'string' && value.templateSource.length <= 2 * 1024 * 1024 && object(value.inputs) && safeJson(value.inputs) && JSON.stringify(value.inputs).length <= 128 * 1024;
  if (value.action === 'set') return object(value.input) && Object.keys(value.input).length === 3 && Object.keys(value.input).every((key) => ['scope', 'expectedRevision', 'variables'].includes(key)) && validVariableScope(value.input.scope) &&
    (value.input.expectedRevision === null || revision(value.input.expectedRevision)) && Array.isArray(value.input.variables) && value.input.variables.length <= 256;
  return value.action === 'bind' && uuid(value.entityId) && revision(value.expectedRevision) && typeof value.field === 'string' && value.field.length <= 256 &&
    (value.binding === null || validVariableBinding(value.binding));
}
