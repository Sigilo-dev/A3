import { getRecord, type DomainRecord } from '@a3/domain';
import { isProjectCapabilityBroker, type Capability } from './capabilities.js';
import type { ProjectService } from './service.js';
import type { StoreHost } from './service-types.js';
import { searchExcluded } from './search-index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CALL_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_MEMORY_DOCUMENTS = 64;
const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text', 'json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'c', 'h', 'cpp', 'hpp', 'ino', 'sql', 'sh', 'bat', 'ps1', 'puml', 'plantuml', 'mmd', 'mermaid']);
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*(?:secret|credential|password|token|private[-_]?key).*)$/i;
const SENSITIVE_LINE = /^(\s*(?:[\w.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization|private[_-]?key)[\w.-]*\s*[:=]\s*).+)$/i;
const LIKELY_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** These are JSON Schema contracts for a future local tool transport, not MCP registration. */
export const A3_TOOL_SCHEMAS = Object.freeze({
  get_project_context: { $schema: JSON_SCHEMA_DRAFT, type: 'object', additionalProperties: false, properties: {} },
  query_entities: { $schema: JSON_SCHEMA_DRAFT, type: 'object', additionalProperties: false, required: ['query'], properties: {
    query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 }
  } },
  query_memory: { $schema: JSON_SCHEMA_DRAFT, type: 'object', additionalProperties: false, required: ['query'], properties: {
    query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 }
  } },
  read_resource: { $schema: JSON_SCHEMA_DRAFT, type: 'object', additionalProperties: false, required: ['resourceId', 'expectedRevision'], properties: {
    resourceId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 1 }
  } },
  validate_changes: { $schema: JSON_SCHEMA_DRAFT, type: 'object', additionalProperties: false, required: ['operationId', 'entityId', 'expectedRevision', 'patch'], properties: {
    operationId: { type: 'string', format: 'uuid' }, entityId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 1 },
    patch: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
      title: { type: 'string', minLength: 1, maxLength: 240 }, tags: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 64 } }
    } }
  } }
} as const);
const A3_TOOL_DESCRIPTIONS: Record<A3ToolName, string> = {
  get_project_context: 'Devuelve metadatos y referencias del proyecto dentro de la selección fijada por A3.',
  query_entities: 'Busca títulos, tipos y etiquetas entre las entidades explícitamente seleccionadas.',
  query_memory: 'Busca fragmentos en los documentos de memoria seleccionados, con procedencia por ID y hash.',
  read_resource: 'Lee un recurso de texto seleccionado por ID después de comprobar su revisión y permiso.',
  validate_changes: 'Valida una propuesta limitada a título y etiquetas con revisión esperada; devuelve diff y procedencia sin guardar.'
};

export type A3ToolName = keyof typeof A3_TOOL_SCHEMAS;
export interface A3ToolScope {
  /** Selected by trusted host preferences; never supplied by a tool call. */
  projectId: string;
  sessionId: string;
  rootIdentity: string;
  entityIds: readonly string[];
  resourceIds: readonly string[];
  relationIds: readonly string[];
  workspaceIds: readonly string[];
  /** Memory resources are a subset of resourceIds and are read only for query_memory. */
  memoryResourceIds: readonly string[];
}
export type A3ToolSelection = Pick<A3ToolScope, 'entityIds' | 'resourceIds' | 'relationIds' | 'workspaceIds' | 'memoryResourceIds'>;
export type A3ToolCall =
  | { name: 'get_project_context'; arguments: Record<string, never> }
  | { name: 'query_entities'; arguments: { query: string; limit?: number } }
  | { name: 'query_memory'; arguments: { query: string; limit?: number } }
  | { name: 'read_resource'; arguments: { resourceId: string; expectedRevision: number } }
  | { name: 'validate_changes'; arguments: { operationId: string; entityId: string; expectedRevision: number; patch: { title?: string; tags?: string[] } } };
export type A3ToolErrorCode = 'INVALID_SCHEMA' | 'SIZE_LIMIT' | 'PROJECT_MISMATCH' | 'STALE_SESSION' | 'ID_OUT_OF_SCOPE' |
  'PERMISSION_DENIED' | 'RESOURCE_MISSING' | 'RESOURCE_NOT_TEXT' | 'REVISION_CONFLICT' | 'VALIDATION_FAILED' | 'TOOL_FAILED';
export type A3ToolResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: { code: A3ToolErrorCode; missingCapability?: Capability } };
export interface A3ToolContext { isCurrent(): boolean; }
export interface ProjectAgentToolOptions {
  service: ProjectService;
  host: StoreHost;
  scope: A3ToolScope;
  context: A3ToolContext;
}

const plainObject = (value: unknown): value is Record<string, unknown> => {
  try { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
  catch { return false; }
};
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): boolean =>
  Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
const validUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const boundedString = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max;
const boundedLimit = (value: unknown): value is number => value === undefined || Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 20;
const resultError = (code: A3ToolErrorCode, missingCapability?: Capability): A3ToolResult => ({ ok: false, error: { code, ...(missingCapability ? { missingCapability } : {}) } });
const normalize = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
function redactLikelySecrets(text: string): string {
  return text.split(/\r?\n/).map((line) => SENSITIVE_LINE.test(line) ? '[redacted secret-like setting]' : line.replace(LIKELY_TOKEN, '[redacted token]')).join('\n');
}
function validScope(scope: A3ToolScope): boolean {
  const sets = [scope.entityIds, scope.resourceIds, scope.relationIds, scope.workspaceIds, scope.memoryResourceIds];
  return validUuid(scope.projectId) && validUuid(scope.sessionId) && typeof scope.rootIdentity === 'string' && /^[a-f0-9]{64}$/i.test(scope.rootIdentity) &&
    sets.every((ids, index) => Array.isArray(ids) && ids.length <= (index === 3 ? 64 : 256) && ids.every(validUuid) && new Set(ids.map((id) => id.toLowerCase())).size === ids.length) &&
    scope.memoryResourceIds.every((id) => scope.resourceIds.some((resourceId) => resourceId.toLowerCase() === id.toLowerCase()));
}
function parseCall(input: unknown): A3ToolCall | undefined {
  if (!plainObject(input) || !exactKeys(input, ['name', 'arguments'], ['name', 'arguments']) || !plainObject(input.arguments)) return undefined;
  const name = input.name, args = input.arguments;
  if (name === 'get_project_context' && exactKeys(args, [])) return { name, arguments: {} };
  if (name === 'query_entities' && exactKeys(args, ['query', 'limit'], ['query']) && boundedString(args.query, 1, 200) && boundedLimit(args.limit)) return { name, arguments: { query: args.query, ...(args.limit === undefined ? {} : { limit: args.limit }) } };
  if (name === 'query_memory' && exactKeys(args, ['query', 'limit'], ['query']) && boundedString(args.query, 1, 200) && boundedLimit(args.limit)) return { name, arguments: { query: args.query, ...(args.limit === undefined ? {} : { limit: args.limit }) } };
  if (name === 'read_resource' && exactKeys(args, ['resourceId', 'expectedRevision'], ['resourceId', 'expectedRevision']) && validUuid(args.resourceId) && Number.isSafeInteger(args.expectedRevision) && Number(args.expectedRevision) >= 1) return { name, arguments: { resourceId: args.resourceId, expectedRevision: Number(args.expectedRevision) } };
  if (name === 'validate_changes' && exactKeys(args, ['operationId', 'entityId', 'expectedRevision', 'patch'], ['operationId', 'entityId', 'expectedRevision', 'patch']) && validUuid(args.operationId) && validUuid(args.entityId) && Number.isSafeInteger(args.expectedRevision) && Number(args.expectedRevision) >= 1 &&
      plainObject(args.patch) && exactKeys(args.patch, ['title', 'tags']) && Object.keys(args.patch).length > 0 &&
      (args.patch.title === undefined || boundedString(args.patch.title, 1, 240)) && (args.patch.tags === undefined || Array.isArray(args.patch.tags) && args.patch.tags.length <= 64 && args.patch.tags.every((tag) => boundedString(tag, 1, 64)))) {
    return { name, arguments: { operationId: args.operationId, entityId: args.entityId, expectedRevision: Number(args.expectedRevision), patch: { ...(args.patch.title === undefined ? {} : { title: args.patch.title }), ...(args.patch.tags === undefined ? {} : { tags: [...args.patch.tags as string[]] }) } } };
  }
  return undefined;
}
function safeMemoryResource(record: DomainRecord | undefined): record is Extract<DomainRecord, { kind: 'resource' }> {
  return record?.kind === 'resource' && record.value.kind === 'project-file' && /^memory\/(?!.*\.\.)[^\\:]+\.md$/i.test(record.value.path) && !searchExcluded(record.value.path) &&
    !SENSITIVE_NAME.test(record.value.path.split('/').at(-1) ?? '');
}
function safeTextResource(resource: Extract<DomainRecord, { kind: 'resource' }>['value']): boolean {
  if (resource.kind === 'remote-url') return false;
  const filename = resource.path.split('/').at(-1) ?? '';
  if (searchExcluded(resource.path) || SENSITIVE_NAME.test(filename)) return false;
  const extension = filename.toLowerCase().split('.').at(-1) ?? '';
  const mediaType = resource.mediaType?.toLowerCase() ?? '';
  return mediaType.startsWith('text/') || ['application/json', 'application/yaml', 'application/toml', 'application/xml'].includes(mediaType) || TEXT_EXTENSIONS.has(extension);
}

/** Host-side, read/validate-only tool facade. It has no apply, process, network, Git or filesystem-path tool. */
export class ProjectAgentTools {
  readonly #scope: A3ToolScope;
  readonly #service: ProjectService;
  readonly #host: StoreHost;
  readonly #context: A3ToolContext;
  constructor(options: ProjectAgentToolOptions) {
    if (!isProjectCapabilityBroker(options.host?.capabilities)) throw new TypeError('ProjectAgentTools requiere el broker sellado del host.');
    if (!validScope(options.scope)) throw new TypeError('El scope A3 debe ser una selección acotada y válida.');
    this.#service = options.service; this.#host = options.host; this.#scope = structuredClone(options.scope); this.#context = options.context;
  }

  async call(input: unknown): Promise<A3ToolResult> {
    if (!plainObject(input)) return resultError('INVALID_SCHEMA');
    try { if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_CALL_BYTES) return resultError('SIZE_LIMIT'); }
    catch { return resultError('INVALID_SCHEMA'); }
    const call = parseCall(input);
    if (!call) return resultError('INVALID_SCHEMA');
    try {
      if (!this.#context.isCurrent()) return resultError('STALE_SESSION');
      const read = this.#authorizeRead();
      if (!read.allowed) return resultError('PERMISSION_DENIED', read.missingCapability);
      const snapshot = this.#service.state.project.snapshot;
      const project = snapshot.records.find((record) => record.kind === 'project');
      if (project?.kind !== 'project' || project.value.projectId.toLowerCase() !== this.#scope.projectId.toLowerCase()) return resultError('PROJECT_MISMATCH');
      let value: Record<string, unknown>;
      switch (call.name) {
        case 'get_project_context': value = this.#projectContext(snapshot.records, project.value); break;
        case 'query_entities': value = this.#queryEntities(snapshot.records, call.arguments.query, call.arguments.limit ?? 10); break;
        case 'query_memory': value = await this.#queryMemory(snapshot.records, call.arguments.query, call.arguments.limit ?? 10); break;
        case 'read_resource': value = await this.#readResource(snapshot.records, call.arguments.resourceId, call.arguments.expectedRevision); break;
        case 'validate_changes': value = await this.#validateChanges(snapshot.records, call.arguments); break;
      }
      if (!this.#context.isCurrent()) return resultError('STALE_SESSION');
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESPONSE_BYTES) return resultError('SIZE_LIMIT');
      return { ok: true, value };
    } catch (error) {
      if (error && typeof error === 'object' && 'toolError' in error) return resultError((error as { toolError: A3ToolErrorCode }).toolError,
        'missingCapability' in error ? (error as { missingCapability?: Capability }).missingCapability : undefined);
      return resultError('TOOL_FAILED');
    }
  }

  #authorizeRead(): { allowed: boolean; missingCapability?: Capability } {
    try {
      return this.#host.capabilities.authorizeAccess({ actor: this.#host.authenticatedActor, root: this.#service.root, projectId: this.#scope.projectId,
        operation: 'read-resource', paths: [], refs: [{ kind: 'project', id: this.#scope.projectId }], resources: [] });
    } catch { return { allowed: false, missingCapability: 'project.read' }; }
  }
  #projectContext(records: DomainRecord[], project: Extract<DomainRecord, { kind: 'project' }>['value']): Record<string, unknown> {
    const inScope = (ids: readonly string[], id: string): boolean => ids.some((item) => item.toLowerCase() === id.toLowerCase());
    const selected = (kind: DomainRecord['kind'], ids: readonly string[]): DomainRecord[] => records.filter((record) => record.kind === kind && 'id' in record.value && typeof record.value.id === 'string' && inScope(ids, record.value.id));
    return {
      project: { id: project.projectId, name: redactLikelySecrets(project.name), revision: project.revision,
        ...(this.#scope.workspaceIds.some((id) => id.toLowerCase() === project.defaultWorkspaceId.toLowerCase()) ? { defaultWorkspaceId: project.defaultWorkspaceId } : {}) },
      selection: {
        entities: selected('entity', this.#scope.entityIds).map((record) => record.kind === 'entity' ? { id: record.value.id, revision: record.value.revision, type: record.value.type, title: redactLikelySecrets(record.value.title) } : null).filter(Boolean),
        workspaces: selected('workspace', this.#scope.workspaceIds).map((record) => record.kind === 'workspace' ? { id: record.value.id, revision: record.value.revision, name: redactLikelySecrets(record.value.name) } : null).filter(Boolean),
        relations: selected('relation', this.#scope.relationIds).filter((record) => record.kind === 'relation' && inScope(this.#scope.entityIds, record.value.source.entityId) && inScope(this.#scope.entityIds, record.value.target.entityId))
          .map((record) => record.kind === 'relation' ? { id: record.value.id, revision: record.value.revision, type: record.value.type, sourceEntityId: record.value.source.entityId, targetEntityId: record.value.target.entityId } : null).filter(Boolean),
        resources: selected('resource', this.#scope.resourceIds).map((record) => record.kind === 'resource' ? { id: record.value.id, revision: record.value.revision,
          mediaType: record.value.mediaType ?? null, kind: record.value.kind, memory: this.#scope.memoryResourceIds.some((id) => id.toLowerCase() === record.value.id.toLowerCase()) } : null).filter(Boolean)
      }
    };
  }
  #queryEntities(records: DomainRecord[], query: string, limit: number): Record<string, unknown> {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    const results = records.flatMap((record) => {
      if (record.kind !== 'entity' || !this.#scope.entityIds.some((id) => id.toLowerCase() === record.value.id.toLowerCase())) return [];
      const searchable = normalize([record.value.title, record.value.type, ...record.value.tags].join('\n'));
      if (terms.length && !terms.every((term) => searchable.includes(term))) return [];
      return [{ id: record.value.id, revision: record.value.revision, type: record.value.type, title: redactLikelySecrets(record.value.title), tags: record.value.tags.map(redactLikelySecrets) }];
    }).slice(0, limit);
    const project = records.find((record) => record.kind === 'project');
    return { projectId: this.#scope.projectId, projectRevision: project?.kind === 'project' ? project.value.revision : null,
      results, provenance: { selectedEntityIds: results.map((entry) => entry.id) } };
  }
  async #queryMemory(records: DomainRecord[], query: string, limit: number): Promise<Record<string, unknown>> {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean), results: Record<string, unknown>[] = [], omitted: Record<string, unknown>[] = [];
    let bytesRead = 0, partial = this.#scope.memoryResourceIds.length > MAX_MEMORY_DOCUMENTS;
    const selectedIds = this.#scope.memoryResourceIds.slice(0, MAX_MEMORY_DOCUMENTS);
    for (let index = 0; index < selectedIds.length; index++) {
      const resourceId = selectedIds[index]!;
      if (results.length >= limit) {
        partial = true;
        omitted.push(...selectedIds.slice(index).map((id) => ({ resourceId: id, reason: 'result-limit' })));
        break;
      }
      const descriptor = getRecord({ records }, { kind: 'resource', id: resourceId });
      if (!safeMemoryResource(descriptor)) { partial = true; omitted.push({ resourceId, reason: 'not-a-memory-document' }); continue; }
      const opened = await this.#service.openResource(resourceId, Math.min(MAX_RESOURCE_BYTES, MAX_MEMORY_DOCUMENTS * MAX_RESOURCE_BYTES - bytesRead));
      if (!opened.ok) { partial = true; omitted.push({ resourceId, reason: opened.diagnostics.some((diagnostic) => diagnostic.code === 'PERMISSION_DENIED') ? 'permission-denied' : 'unavailable-or-too-large' }); continue; }
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(opened.value.bytes); }
      catch { partial = true; omitted.push({ resourceId, reason: 'invalid-utf8' }); continue; }
      bytesRead += opened.value.bytes.byteLength;
      if (bytesRead > MAX_MEMORY_DOCUMENTS * MAX_RESOURCE_BYTES) throw { toolError: 'SIZE_LIMIT' };
      const text = redactLikelySecrets(decoded), owners = records.filter((record) => record.kind === 'entity' && this.#scope.entityIds.some((id) => id.toLowerCase() === record.value.id.toLowerCase()) && record.value.contentResourceId?.toLowerCase() === resourceId.toLowerCase());
      const searchable = normalize([descriptor.value.id, ...owners.map((record) => record.kind === 'entity' ? record.value.title : ''), text].join('\n'));
      if (terms.length && !terms.every((term) => searchable.includes(term))) continue;
      const lines = text.split(/\r?\n/), line = terms.length ? lines.find((candidate) => terms.some((term) => normalize(candidate).includes(term))) ?? text.slice(0, 300) : lines.find((candidate) => candidate.trim()) ?? '';
      results.push({ title: owners.map((record) => record.kind === 'entity' ? redactLikelySecrets(record.value.title) : '').filter(Boolean).join(' · ') || 'Memoria del proyecto',
        snippet: line.slice(0, 300), role: owners.flatMap((record) => record.kind === 'entity' && typeof record.value.properties['a3.memory.role'] === 'string' ? [record.value.properties['a3.memory.role']] : []).at(0) ?? 'memory',
        provenance: { resourceId: descriptor.value.id, revision: opened.value.revision, sha256: opened.value.sha256,
          entityIds: owners.flatMap((record) => record.kind === 'entity' ? [record.value.id] : []) } });
    }
    const project = records.find((record) => record.kind === 'project');
    return { projectId: this.#scope.projectId, projectRevision: project?.kind === 'project' ? project.value.revision : null, results, partial, omitted };
  }
  async #readResource(records: DomainRecord[], resourceId: string, expectedRevision: number): Promise<Record<string, unknown>> {
    if (!this.#scope.resourceIds.some((id) => id.toLowerCase() === resourceId.toLowerCase())) throw { toolError: 'ID_OUT_OF_SCOPE' };
    const descriptor = getRecord({ records }, { kind: 'resource', id: resourceId });
    if (descriptor?.kind !== 'resource') throw { toolError: 'RESOURCE_MISSING' };
    if (descriptor.value.revision !== expectedRevision) throw { toolError: 'REVISION_CONFLICT' };
    if (!safeTextResource(descriptor.value)) throw { toolError: 'RESOURCE_NOT_TEXT' };
    const opened = await this.#service.openResource(resourceId, MAX_RESOURCE_BYTES);
    if (!opened.ok) {
      const denied = opened.diagnostics.find((diagnostic) => diagnostic.code === 'PERMISSION_DENIED');
      if (denied) throw { toolError: 'PERMISSION_DENIED', missingCapability: denied.missingCapability as Capability | undefined };
      if (opened.diagnostics.some((diagnostic) => diagnostic.code === 'REVISION_CONFLICT')) throw { toolError: 'REVISION_CONFLICT' };
      throw { toolError: 'RESOURCE_MISSING' };
    }
    if (opened.value.revision !== expectedRevision) throw { toolError: 'REVISION_CONFLICT' };
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(opened.value.bytes); } catch { throw { toolError: 'RESOURCE_NOT_TEXT' }; }
    const entityIds = records.flatMap((record) => record.kind === 'entity' && this.#scope.entityIds.some((id) => id.toLowerCase() === record.value.id.toLowerCase()) && record.value.contentResourceId?.toLowerCase() === resourceId.toLowerCase() ? [record.value.id] : []);
    const project = records.find((record) => record.kind === 'project');
    return { projectId: this.#scope.projectId, projectRevision: project?.kind === 'project' ? project.value.revision : null,
      resourceId, revision: opened.value.revision, content: redactLikelySecrets(content),
      provenance: { entityIds, sha256: opened.value.sha256, descriptorHash: opened.value.descriptorHash, byteLength: opened.value.bytes.byteLength } };
  }
  async #validateChanges(records: DomainRecord[], input: Extract<A3ToolCall, { name: 'validate_changes' }>['arguments']): Promise<Record<string, unknown>> {
    if (!this.#scope.entityIds.some((id) => id.toLowerCase() === input.entityId.toLowerCase())) throw { toolError: 'ID_OUT_OF_SCOPE' };
    const entity = records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === input.entityId.toLowerCase());
    if (entity?.kind !== 'entity') throw { toolError: 'RESOURCE_MISSING' };
    if (entity.value.revision !== input.expectedRevision) throw { toolError: 'REVISION_CONFLICT' };
    const patch = input.patch;
    const command = { operationId: input.operationId, projectId: this.#scope.projectId, actor: this.#host.authenticatedActor,
      command: 'a3.core.update-entity' as const, payload: patch, expectedRevisions: [{ kind: 'entity' as const, id: entity.value.id, revision: input.expectedRevision }],
      expectedContentHashes: [], scope: { entityIds: [entity.value.id] } };
    const prepared = await this.#service.prepare(command);
    if (!prepared.ok) {
      if (prepared.diagnostics.some((diagnostic) => diagnostic.code === 'PERMISSION_DENIED')) {
        const missing = prepared.diagnostics.find((diagnostic) => diagnostic.missingCapability)?.missingCapability as Capability | undefined;
        throw { toolError: 'PERMISSION_DENIED', ...(missing ? { missingCapability: missing } : {}) };
      }
      if (prepared.diagnostics.some((diagnostic) => diagnostic.code === 'REVISION_CONFLICT')) throw { toolError: 'REVISION_CONFLICT' };
      throw { toolError: 'VALIDATION_FAILED' };
    }
    const fields: Record<string, unknown>[] = [];
    if (patch.title !== undefined && patch.title !== entity.value.title) fields.push({ field: 'title', before: redactLikelySecrets(entity.value.title), after: redactLikelySecrets(patch.title) });
    if (patch.tags !== undefined && JSON.stringify(patch.tags) !== JSON.stringify(entity.value.tags)) fields.push({ field: 'tags', before: entity.value.tags.map(redactLikelySecrets), after: patch.tags.map(redactLikelySecrets) });
    const latest = this.#service.state.project, document = latest.documents.find((item) => item.record?.kind === 'entity' && item.record.value.id.toLowerCase() === entity.value.id.toLowerCase());
    const project = latest.snapshot.records.find((record) => record.kind === 'project');
    return { projectId: this.#scope.projectId, operationId: input.operationId, validated: true, persisted: false,
      diff: { entityId: entity.value.id, expectedRevision: input.expectedRevision, resultingRevision: fields.length ? input.expectedRevision + 1 : input.expectedRevision, fields },
      provenance: { projectRevision: project?.kind === 'project' ? project.value.revision : null,
        entityId: entity.value.id, sourceRevision: entity.value.revision, sourceHash: document?.sha256 ?? null, command: command.command } };
  }
}

/** Serialize a tool contract for compatible transports; this module intentionally does not implement MCP. */
export function describeA3Tools(): { name: A3ToolName; description: string; inputSchema: (typeof A3_TOOL_SCHEMAS)[A3ToolName] }[] {
  return Object.entries(A3_TOOL_SCHEMAS).map(([name, inputSchema]) => ({ name: name as A3ToolName, description: A3_TOOL_DESCRIPTIONS[name as A3ToolName], inputSchema }));
}

/** Constructed only from a current LocalProjectManager binding in the trusted main process. */
export function bindProjectAgentTools(options: ProjectAgentToolOptions): ProjectAgentTools {
  return new ProjectAgentTools(options);
}
