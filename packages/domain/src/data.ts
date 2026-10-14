import type { Diagnostic, DocumentRef, DomainRecord, DomainSnapshot, ExpectedRevision, JsonValue } from './models.js';

export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
export const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isJson(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some((d) => d.get || d.set)) return false;
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((k, i) => k !== String(i)))) return false;
  if (!Array.isArray(value) && Object.values(descriptors).some((d) => !d.enumerable)) return false;
  ancestors.add(value);
  const valid = Object.entries(descriptors).every(([key, d]) => Array.isArray(value) && key === 'length' || isJson(d.value, ancestors));
  ancestors.delete(value);
  return valid;
}

export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function refOf(record: DomainRecord): DocumentRef {
  if (record.kind === 'project') return { kind: record.kind, id: record.value.projectId };
  if (record.kind === 'variable-set') return { kind: record.kind, id: record.value.scope.ownerId, variableScope: record.value.scope.kind };
  return { kind: record.kind, id: record.value.id, ...('workspaceId' in record ? { workspaceId: record.workspaceId } : {}) };
}
export function refKey(ref: DocumentRef): string {
  return [ref.kind, ref.workspaceId?.toLowerCase() ?? '', ref.variableScope ?? '', ref.id.toLowerCase()].join(':');
}
export const getRecord = (snapshot: DomainSnapshot, ref: DocumentRef): DomainRecord | undefined => {
  const key = refKey(ref);
  return snapshot.records.find((r) => refKey(refOf(r)) === key);
};
export function indexSnapshot(snapshot: DomainSnapshot): (ref: DocumentRef) => DomainRecord | undefined {
  const index = new Map<string, DomainRecord>();
  for (const record of snapshot.records) {
    const key = refKey(refOf(record));
    if (!index.has(key)) index.set(key, record);
  }
  return (ref) => index.get(refKey(ref));
}
export const revisionsOf = (snapshot: DomainSnapshot): ExpectedRevision[] => snapshot.records.map((record) => ({ ...refOf(record), revision: record.value.revision }));
export function diagnostic(detail: string, message: string, ref?: DocumentRef,
  code: Diagnostic['code'] = 'VALIDATION_FAILED', severity: Diagnostic['severity'] = 'error'): Diagnostic {
  return { code, detail, severity, message, recovery: 'Revisa la propuesta y vuelve a validar.', ...(ref ? { ref } : {}) };
}
