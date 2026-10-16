import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { defaultRegistry, getRecord, prepareCommand, refKey, refOf, revalidatePlan, reversibleCanvasCommand, validateSnapshot, type CommandContext, type Diagnostic, type DomainRecord, type JsonValue, type PreparedPlan, type Resource, type TypeRegistry } from '@a3/domain';
import { decodeDocument, encodeDocument, issue, serializeRecord, sha256 } from './codec.js';
import { decodeCodeText, encodeCodeText } from './code-text.js';
import { buildNavigationIndex, rewritePageReferences, type NavigationIndex, type NavigationSource } from './navigation.js';
import { MountPathError, inspectLocalMountFile, readLocalMountFile, readMountedResource, readMountedResourceDetailed, type MountActionPreview } from './mounts.js';
import { canonicalJson, freeze, object, pointerToken } from './json.js';
import { acquireOwnership, projectIdentity, type Ownership } from './ownership.js';
import { jsonBytes, ProgressLog, progressProtocol, transactionRoot } from './progress.js';
import { recoverTransactions } from './recovery.js';
import { checkedPath, fileBytes, ioIssue, PathError, readProject, readProjectResource, resolvePortablePath } from './reader.js';
import { absentPath, ensureDirectories, installExclusive, writeExclusive } from './write-io.js';
import { createSnapshot, listSnapshots, readSnapshot, type SnapshotReason } from './snapshots.js';
import { applyMigrationChain, migrationChain, type MigrationScope } from './migrations.js';
import { completeMigration, loadPreparedMigration, prepareMigration, verifyAppliedMigration, type LoadedMigration } from './migration-store.js';
import type { DocumentLocation, JsonEdit, ProjectReadResult, StoreDiagnostic } from './types.js';
import type { AccessRequest, ExplorerDeletePreview, ExplorerDirectoryPage, ExplorerFileEntry, ExplorerMountEntry, ExplorerOpenResult, ExplorerOperationRequest, FaultPhase, IntentEntry, MigrationReceipt, MountActionRequest, OpenResource, PreparedWrite, ResourceWriteRequest, ServiceEvent, ServiceOptions, ServiceState, SnapshotReceipt, StoreResult, WriteIntent, WriteReceipt } from './service-types.js';
import type { Capability, CapabilityDecision } from './capabilities.js';
import { isProjectCapabilityBroker } from './capabilities.js';

interface Observation { hash: string | null; identity: string | null; stamp: string; problem?: string; }
interface DirectoryObservation { path: string; identity: string; entriesHash: string; }
interface Scan { project: ProjectReadResult; files: Map<string, Observation>; diagnostics: StoreDiagnostic[]; }
interface Image { path: string; bytes: Uint8Array | null; ref?: ReturnType<typeof refOf>; }
interface PlanData {
  scan: Scan; images: Image[]; domain?: PreparedPlan; resourceWrite?: ResourceWriteRequest;
  nextRecords: DomainRecord[]; resources: Resource[]; requestHash: string; outcome?: StoreResult<WriteReceipt>;
  actor: string;
  requiredCapabilities: Capability[];
  mountSource?: { resource: Resource & { kind: 'mounted-file'; path: string; mountId: string }; sha256: string; identity: string };
  preapproved?: boolean;
  maintenance?: boolean;
  allowRegisteredMigration?: boolean;
  snapshotId?: string;
  snapshotOperationId?: string;
  snapshotReason?: SnapshotReason;
  externalPaths?: readonly string[];
  externalDirectories?: readonly DirectoryObservation[];
}
const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const pool = new Map<string, { service: ProjectService; host: ServiceOptions['host']; leases: number }>();
const missing: Observation = { hash: null, identity: null, stamp: 'missing' };
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const imageEqual = (a: Observation, b: Observation): boolean => a.hash === b.hash && a.identity === b.identity && a.problem === b.problem;
const failure = <T>(diagnostics: readonly StoreDiagnostic[]): StoreResult<T> => ({ ok: false, diagnostics });
function conflict(path: string, detail = 'external-conflict'): StoreDiagnostic {
  return issue(path, 'references', detail, 'Cambió el archivo o su revisión; conserva ambas versiones y relee antes de proponer otra escritura.',
    { code: 'REVISION_CONFLICT', recovery: 'Revisa los bytes externos y la propuesta. reload() acepta una nueva base; no mezcla ni restaura archivos.' });
}
function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : undefined; }
async function destinationExists(root: string, path: string): Promise<boolean> {
  const target = resolvePortablePath(root, path);
  const parent = path.split('/').slice(0, -1).join('/');
  if (parent) {
    try { await checkedPath(root, parent, 'directory'); }
    catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
  }
  try { await lstat(target); return true; }
  catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}
function mountError(path: string, error: unknown): StoreDiagnostic {
  if (error instanceof MountPathError) return issue(path, 'io', error.detail, error.message, { code: error.failureCode });
  return ioIssue(path, error);
}
function domainIssues(diagnostics: readonly Diagnostic[]): StoreDiagnostic[] {
  return diagnostics.map(({ instancePath, ...d }) => ({ ...d, path: 'a3.project.json', stage: 'references', ...(instancePath !== undefined ? { pointer: instancePath } : {}) }));
}
const explorerPageSize = 100;
const folderMarker = '.a3-folder.json';
const forbiddenExplorerName = /^(?:\.a3|\.git|node_modules|\.env(?:\..*)?|credentials?|secrets?|id_(?:rsa|ed25519)(?:\.pub)?|[^/]*\.(?:pem|p12|pfx|key))$/i;
function explorerIdentity(statValue: { dev: bigint; ino: bigint; mode: bigint }): string {
  return `${statValue.dev.toString(16)}:${statValue.ino.toString(16)}:${(statValue.mode & 0o170000n).toString(16)}`;
}
function explorerName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' && !/[\\/:<>"|?*\x00-\x1f]/.test(value) &&
    !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value) && !forbiddenExplorerName.test(value);
}
function mediaTypeForPath(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase();
  const types: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', json: 'application/json', toml: 'application/toml', yaml: 'application/yaml', yml: 'application/yaml',
    ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript', jsx: 'text/javascript', py: 'text/x-python', rs: 'text/x-rust', html: 'text/html', css: 'text/css', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };
  return types[extension ?? ''] ?? 'application/octet-stream';
}
function gitIgnoreRegex(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; }
      else out += '[^/]*';
    }
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(out + '(?:/.*)?$', 'i');
}
interface IgnoreRule { base: string; expression: RegExp; negated: boolean; directoryOnly: boolean; }
function parseIgnoreRules(text: string, base: string): IgnoreRule[] {
  return text.split(/\r?\n/).flatMap((raw) => {
    let value = raw.trim();
    if (!value || value.startsWith('#')) return [];
    const negated = value.startsWith('!'); if (negated) value = value.slice(1);
    if (value.startsWith('\\#') || value.startsWith('\\!')) value = value.slice(1);
    const directoryOnly = value.endsWith('/'); value = value.replace(/^\//, '').replace(/\/$/, '');
    if (!value) return [];
    const anchored = raw.trim().replace(/^!/, '').startsWith('/') || value.includes('/');
    return [{ base, expression: gitIgnoreRegex(anchored ? value : `**/${value}`), negated, directoryOnly }];
  });
}
function gitIgnored(path: string, isDirectory: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/');
      const prefixIsDirectory = length < parts.length || isDirectory;
      const rel = rule.base ? prefix.startsWith(rule.base + '/') ? prefix.slice(rule.base.length + 1) : prefix === rule.base ? '' : undefined : prefix;
      if (rel === undefined || rule.directoryOnly && !prefixIsDirectory) continue;
      if (rule.expression.test(rel)) ignored = !rule.negated;
    }
  }
  return ignored;
}
const diagramRefKinds = new Set(['workspace', 'placement', 'visual-edge', 'relation-view', 'group', 'drawing', 'relation']);
function domainCapabilities(plan: PreparedPlan): Capability[] {
  const command = plan.request.command;
  if (command === 'a3.core.register-node-type' || command === 'a3.core.unregister-node-type') return ['package.install'];
  const caps = new Set<Capability>();
  if (command.startsWith('a3.conceptual.') || command.startsWith('a3.c4.')) caps.add('diagram.edit');
  if (command === 'a3.core.delete' || plan.changes.some((change) => !change.after) || plan.contentEffects.some((effect) => effect.kind === 'remove')) caps.add('delete');
  const refs = plan.changes.map((change) => change.ref);
  if (refs.some((ref) => diagramRefKinds.has(ref.kind))) caps.add('diagram.edit');
  if (refs.some((ref) => !diagramRefKinds.has(ref.kind))) caps.add('document.edit');
  if (!caps.has('diagram.edit') && !caps.has('document.edit')) caps.add('document.edit');
  if (command === 'a3.core.set-collection-members') { caps.delete('document.edit'); caps.add('task.edit'); }
  return [...caps];
}
function diagnosticKey(diagnostic: StoreDiagnostic): string {
  return JSON.stringify([diagnostic.path, diagnostic.stage, diagnostic.detail, diagnostic.pointer ?? '', diagnostic.code ?? '']);
}
function introducesErrors(baseline: readonly StoreDiagnostic[], observed: readonly StoreDiagnostic[]): boolean {
  const remaining = new Map<string, number>();
  for (const diagnostic of baseline) if (diagnostic.severity === 'error') {
    const key = diagnosticKey(diagnostic); remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return observed.filter((diagnostic) => diagnostic.severity === 'error').some((diagnostic) => {
    const key = diagnosticKey(diagnostic); const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1); return false;
  });
}
function editsBetween(before: JsonValue, after: JsonValue, pointer = ''): JsonEdit[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key): JsonEdit[] => {
      const path = pointer + '/' + pointerToken(key);
      if (!Object.hasOwn(after, key)) return [{ op: 'remove', pointer: path }];
      if (!Object.hasOwn(before, key)) return [{ op: 'set', pointer: path, value: after[key]! }];
      return editsBetween(before[key]!, after[key]!, path);
    });
  }
  return [{ op: 'set', pointer, value: after }];
}
function recordPath(record: DomainRecord, catalog: string): string {
  const ref = refOf(record);
  if (record.kind === 'project') return 'a3.project.json';
  if (record.kind === 'workspace') return `${catalog}/workspaces/${ref.id}/workspace.json`;
  if (record.kind === 'variable-set') return ref.variableScope === 'project' ? `${catalog}/variables/project.json` : `${catalog}/variables/${ref.variableScope === 'entity' ? 'entities' : 'workspaces'}/${ref.id}.json`;
  if ('workspaceId' in record) {
    const folder = { placement: 'placements', 'visual-edge': 'visual-edges', 'relation-view': 'relation-views', group: 'groups', drawing: 'drawings' }[record.kind];
    return `${catalog}/workspaces/${record.workspaceId}/${folder}/${ref.id}.json`;
  }
  return `${catalog}/${{ entity: 'entities', resource: 'resources', relation: 'relations', collection: 'collections' }[record.kind]}/${ref.id}.json`;
}
function locationForPath(path: string, catalog: string, projectId: string): DocumentLocation | undefined {
  if (path === 'a3.project.json') return { kind: 'project', path };
  const parts = path.split('/');
  if (parts[0] !== catalog) return undefined;
  const top = parts[1]; const name = parts.at(-1)!; const id = name.endsWith('.json') ? name.slice(0, -5) : '';
  if (!uuid.test(id)) return undefined;
  const simple: Record<string, DocumentLocation['kind']> = { entities: 'entity', resources: 'resource', relations: 'relation', collections: 'collection' };
  if (parts.length === 3 && simple[top ?? '']) return { kind: simple[top!]!, path, expectedId: id };
  if (parts.length === 4 && top === 'workspaces' && name === 'workspace.json' && uuid.test(parts[2]!)) {
    const workspaceId = parts[2]!; return { kind: 'workspace', path, expectedId: workspaceId };
  }
  if (parts.length === 5 && top === 'workspaces' && uuid.test(parts[2]!)) {
    const folder: Record<string, DocumentLocation['kind']> = { placements: 'placement', 'visual-edges': 'visual-edge', 'relation-views': 'relation-view', groups: 'group', drawings: 'drawing' };
    const workspaceId = parts[2]!;
    if (folder[parts[3] ?? '']) return { kind: folder[parts[3]!]!, path, expectedId: id, workspaceId };
  }
  if (parts.length === 3 && top === 'variables' && name === 'project.json') return { kind: 'variable-set', path, expectedId: projectId, variableScope: 'project' };
  if (parts.length === 4 && top === 'variables' && ['entities', 'workspaces'].includes(parts[2]!)) {
    return { kind: 'variable-set', path, expectedId: id, variableScope: parts[2] === 'entities' ? 'entity' : 'workspace' };
  }
  return undefined;
}

export class ProjectService {
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;
  #ownership: Ownership | undefined;
  #reason: string | undefined;
  #accepted!: Scan;
  #observed!: Scan;
  #external = false;
  #plans = new WeakMap<PreparedWrite, PlanData>();
  #listeners = new Set<(event: ServiceEvent) => void>();
  #watcher: FSWatcher | undefined;
  #timer: NodeJS.Timeout | undefined;
  #debounce: NodeJS.Timeout | undefined;
  #dirty = false;
  #own = new Map<string, Observation>();
  #recoveryDiagnostics: StoreDiagnostic[] = [];
  #sourceRefs = new Map<string, Resource>();
  #knownProjectId: string | undefined;
  #registry: TypeRegistry;
  get typeRegistry(): TypeRegistry { return structuredClone(this.#registry); }
  #resourceLimit: number;
  #transactionLimit: number;
  #snapshotRetentionDays: number;
  #snapshotMaxBytes: number;
  #catalog = '.a3';
  private constructor(readonly root: string, private readonly options: ServiceOptions, private readonly identity: string, ownership?: Ownership, reason?: string) {
    this.#ownership = ownership; this.#reason = reason;
    this.#registry = freeze(JSON.parse(JSON.stringify(options.registry ?? defaultRegistry())) as TypeRegistry);
    this.#resourceLimit = options.maxResourceBytes ?? 128 * 1024 * 1024;
    this.#transactionLimit = options.maxTransactionBytes ?? 128 * 1024 * 1024;
    this.#snapshotRetentionDays = options.snapshotRetentionDays ?? 30;
    this.#snapshotMaxBytes = options.snapshotMaxBytes ?? 2 * 1024 * 1024 * 1024;
    for (const limit of [this.#resourceLimit, this.#transactionLimit, options.pollMs ?? 2000, options.debounceMs ?? 50, this.#snapshotMaxBytes]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Los límites/intervalos deben ser enteros positivos.');
    }
    if (!Number.isSafeInteger(this.#snapshotRetentionDays) || this.#snapshotRetentionDays < 0) throw new TypeError('Los días de retención deben ser un entero no negativo.');
  }
  static async create(root: string, projectId: string, options: ServiceOptions, identity: string, ownership?: Ownership, reason?: string): Promise<ProjectService> {
    if (!options?.host || !isProjectCapabilityBroker(options.host.capabilities)) throw new TypeError('ProjectService requiere el broker sellado del host.');
    const service = new ProjectService(root, options, identity, ownership, reason);
    service.#knownProjectId = projectId;
    try {
      service.#accepted = service.#observed = await service.#scan(true);
      const project = service.#accepted.project.snapshot.records.find((r) => r.kind === 'project');
      if (project?.kind === 'project') service.#catalog = project.value.catalogRoot;
      else {
        const manifest = service.#accepted.project.documents.find((document) => document.location.kind === 'project');
        const raw = manifest?.value;
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.catalogRoot === 'string') service.#catalog = raw.catalogRoot;
      }
      if (ownership) {
        const recoveredProjectId = service.#projectId();
        const recovery = await recoverTransactions(root, { ...(recoveredProjectId ? { projectId: recoveredProjectId } : {}), authenticatedActor: options.host.authenticatedActor,
          maxBytes: service.#resourceLimit, authorizeWrite: async (_paths, capabilities, operationId) => {
            if (!recoveredProjectId) return { allowed: false, missingCapability: 'project.read' };
            const required = ['project.recover' as Capability, ...(capabilities ?? [])];
            return options.host.capabilities.authorizeCapabilities(root, options.host.authenticatedActor, recoveredProjectId, required,
              `journal.recovery:${operationId}`, 'apply');
          }, ...(options.fault ? { fault: options.fault } : {}) });
        service.#recoveryDiagnostics = [...recovery.diagnostics];
        if (recovery.diagnostics.some((d) => d.code === 'REVISION_CONFLICT')) service.#external = true;
        if (recovery.blocked) service.#reason = 'recovery-required';
        else if (recovery.recovered.length) service.#accepted = service.#observed = await service.#scan(true);
      }
      if (!service.#reason && (service.#accepted.project.mode !== 'ready' || !service.#accepted.project.catalogComplete || service.#accepted.diagnostics.some((d) => d.severity === 'error'))) service.#reason = 'project-not-writable';
      service.#startWatcher();
      return service;
    } catch (error) { await ownership?.close(); throw error; }
  }
  get state(): ServiceState {
    if (!this.#authorized('open-project', ['a3.project.json'])) {
      const denied = this.#denied('a3.project.json');
      return { mode: 'read-only', reason: 'permission-denied', project: { root: this.root, mode: 'unavailable', writable: false,
        catalogComplete: false, documents: [], snapshot: { records: [] }, diagnostics: [denied] }, externalConflict: false, recoveryDiagnostics: [] };
    }
    return { mode: this.#ownership?.alive() && !this.#reason && !this.#closing ? 'writer' : 'read-only',
      ...(this.#reason ? { reason: this.#reason } : {}), project: this.#observed.project, externalConflict: this.#external,
      recoveryDiagnostics: this.#recoveryDiagnostics };
  }
  subscribe(listener: (event: ServiceEvent) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #emit(event: ServiceEvent): void { for (const listener of this.#listeners) { try { listener(freeze(event)); } catch { /* A UI listener cannot abort IO. */ } } }
  #queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work); this.#tail = result.catch(() => undefined); return result;
  }
  #projectId(): string | undefined {
    if (this.#knownProjectId) return this.#knownProjectId;
    const project = this.#accepted?.project.snapshot.records.find((record) => record.kind === 'project');
    if (project?.kind === 'project') return project.value.projectId;
    const manifest = this.#accepted?.project.documents.find((document) => document.location.kind === 'project')?.value;
    return manifest && typeof manifest === 'object' && !Array.isArray(manifest) && typeof manifest.projectId === 'string' && uuid.test(manifest.projectId) ? manifest.projectId : undefined;
  }
  #lastDecision: CapabilityDecision | undefined;
  #authorized(operation: AccessRequest['operation'], paths: string[], refs: AccessRequest['refs'] = [], resources: Resource[] = [], requiredCapabilities?: Capability[], stage: 'prepare' | 'apply' = 'prepare'): boolean {
    try {
      const result = this.options.host.capabilities.authorizeAccess(freeze({ actor: JSON.parse(JSON.stringify(this.options.host.authenticatedActor)), root: this.root,
        ...(this.#projectId() ? { projectId: this.#projectId()! } : {}), operation, paths: [...paths], refs: [...refs], resources: [...resources],
        ...(requiredCapabilities ? { requiredCapabilities } : {}), stage }));
      this.#lastDecision = result;
      return result.allowed;
    } catch { this.#lastDecision = undefined; return false; }
  }
  #denied(path: string, explicit?: CapabilityDecision): StoreDiagnostic {
    const result = explicit ?? this.#lastDecision;
    this.#lastDecision = undefined;
    return issue(path, 'io', 'permission-denied', result?.reason === 'approval-required' ? 'La persona debe aprobar esta operación.' : 'El broker del host denegó esta acción.',
      { code: 'PERMISSION_DENIED', ...(result?.missingCapability ? { missingCapability: result.missingCapability } : {}), recovery: result?.reason ?? 'Revisa la concesión local del proyecto.' });
  }
  #operationError(path: string, error: unknown): StoreDiagnostic {
    if (error instanceof PathError && ['file-identity-changed', 'external-conflict', 'destination-exists'].includes(error.detail)) return conflict(path, error.detail);
    return error instanceof PathError && error.detail === 'permission-denied' ? this.#denied(path) : ioIssue(path, error);
  }
  #gate(): StoreDiagnostic[] {
    if (this.#closing || this.#reason || !this.#ownership?.alive()) return [issue('a3.project.json', 'io', this.#reason ?? 'writer-not-owner',
      'Este servicio está en solo lectura; no acepta escrituras.', { code: 'PERMISSION_DENIED' })];
    if (this.#external) return [conflict('a3.project.json')];
    return [];
  }
  async #observe(path: string, force: boolean, previous?: Observation): Promise<Observation> {
    try {
      const native = await checkedPath(this.root, path, 'file');
      const info = await stat(native, { bigint: true });
      const identity = `${info.dev}:${info.ino}`;
      const stamp = `${identity}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (!force && previous?.stamp === stamp) return previous;
      const bytes = await fileBytes(this.root, path, this.#resourceLimit);
      return { hash: sha256(bytes), identity, stamp };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return missing;
      return { hash: null, identity: null, stamp: 'unavailable', problem: ioIssue(path, error).detail };
    }
  }
  async #scan(force: boolean): Promise<Scan> {
    if (await projectIdentity(this.root) !== this.identity) {
      this.#reason = 'project-root-changed';
      throw new PathError('project-root-changed', 'Cambió la identidad de la carpeta raíz; cierra y vuelve a abrir el proyecto.');
    }
    if (!this.#authorized('open-project', ['a3.project.json'])) throw new PathError('permission-denied', 'La política de lectura fue revocada.');
    const migrationSteps = this.options.migrationSteps ?? [];
    const knownReadOnlyManifestSources = [...new Set(migrationSteps.filter((step) => step.scope === 'project' || step.scope === '*').map((step) => step.fromVersion))]
      .filter((version) => migrationChain('project', version, '1.0.0', migrationSteps).ok);
    const project = await readProject(this.root, { registry: this.#registry, knownReadOnlyManifestSources });
    const manifestRecord = project.snapshot.records.find((record) => record.kind === 'project');
    const manifestValue = manifestRecord?.kind === 'project' ? manifestRecord.value : project.documents.find((document) => document.location.kind === 'project')?.value;
    const observedProjectId = manifestValue && typeof manifestValue === 'object' && !Array.isArray(manifestValue) && typeof manifestValue.projectId === 'string' && uuid.test(manifestValue.projectId)
      ? manifestValue.projectId : undefined;
    if (!observedProjectId || observedProjectId.toLowerCase() !== this.#knownProjectId?.toLowerCase()) {
      throw new PathError('project-id-mismatch', 'La identidad del manifiesto cambió respecto a la concesión local.');
    }
    const files = new Map<string, Observation>();
    const diagnostics: StoreDiagnostic[] = [...project.diagnostics];
    for (const document of project.documents) {
      const observation = await this.#observe(document.location.path, false);
      if (observation.hash !== document.sha256) diagnostics.push(conflict(document.location.path, 'changed-during-catalog-read'));
      files.set(document.location.path, observation);
    }
    for (const record of project.snapshot.records) if (record.kind === 'resource' && record.value.kind === 'project-file') {
      this.#sourceRefs.set(record.value.path, record.value);
      if (files.has(record.value.path)) continue;
      if (!this.#authorized('read-resource', [record.value.path], [refOf(record)], [record.value])) {
        diagnostics.push(this.#denied(record.value.path)); files.set(record.value.path, { ...missing, problem: 'permission-denied' }); continue;
      }
      const observation = await this.#observe(record.value.path, force, this.#observed?.files.get(record.value.path));
      if (observation.problem) diagnostics.push(issue(record.value.path, 'io', observation.problem, 'No se pudieron observar los bytes del recurso.', { code: 'IO_FAILED' }));
      files.set(record.value.path, observation);
    }
    // Losing a descriptor/layout does not mean that its files were deleted. Keep
    // observing previously known names rather than fabricating deletion events.
    for (const [path, previous] of this.#observed?.files ?? []) if (!files.has(path)) {
      const resource = this.#sourceRefs.get(path);
      if (resource && !this.#authorized('read-resource', [path], [{ kind: 'resource', id: resource.id }], [resource])) {
        diagnostics.push(this.#denied(path)); files.set(path, { ...missing, problem: 'permission-denied' }); continue;
      }
      files.set(path, await this.#observe(path, force, previous));
    }
    return { project, files, diagnostics };
  }
  #changes(old: Scan, next: Scan): string[] {
    return [...new Set([...old.files.keys(), ...next.files.keys()])].filter((path) => !imageEqual(old.files.get(path) ?? missing, next.files.get(path) ?? missing)).sort();
  }
  #acceptObservation(next: Scan): void {
    for (const path of this.#changes(this.#observed, next)) {
      const before = this.#observed.files.get(path) ?? missing;
      const after = next.files.get(path) ?? missing;
      if (this.#own.has(path) && imageEqual(this.#own.get(path)!, after)) continue;
      this.#external = true;
      const doc = next.project.documents.find((d) => d.location.path === path);
      this.#emit({ kind: 'external-change', path, change: after.problem ? 'unavailable' : after.hash === null ? 'deleted' : before.hash === null ? 'created' : before.identity !== after.identity ? 'replaced' : 'edited',
        beforeHash: before.hash, afterHash: after.hash, diagnostics: [conflict(path), ...(doc?.diagnostics ?? [])] });
    }
    this.#observed = next;
  }
  #startWatcher(): void {
    const schedule = (): void => {
      if (this.#closing) return;
      this.#dirty = true;
      if (this.#debounce) return;
      this.#debounce = setTimeout(() => {
        this.#debounce = undefined;
        void this.checkExternalChanges().catch((error) => this.#watchError(error));
      }, this.options.debounceMs ?? 50);
      this.#debounce.unref();
    };
    try {
      this.#watcher = watch(this.root, { recursive: true, persistent: false }, (_event, name) => {
        const path = name?.toString().replaceAll('\\', '/');
        if (path?.startsWith('.a3/local/') || path?.startsWith('.git/')) return;
        schedule();
      });
      this.#watcher.on('error', (error) => this.#watchError(error));
    } catch (error) { this.#watchError(error); }
    this.#timer = setInterval(() => { void this.checkExternalChanges(false).catch((error) => this.#watchError(error)); }, this.options.pollMs ?? 2000);
    this.#timer.unref();
  }
  #watchError(error: unknown): void { this.#emit({ kind: 'watcher-error', diagnostics: [ioIssue('a3.project.json', error)] }); this.#external = true; }
  checkExternalChanges(force = true): Promise<ServiceState> {
    return this.#queue(async () => {
      if (!this.#closing) { const dirty = this.#dirty; this.#dirty = false; this.#acceptObservation(await this.#scan(force || dirty)); }
      return this.state;
    });
  }
  reload(): Promise<StoreResult<ProjectReadResult>> {
    return this.#queue(async () => {
      if (this.#closing) return failure([issue('a3.project.json', 'io', 'service-closed', 'El servicio está cerrado.')]);
      try {
        const next = await this.#scan(true);
        this.#acceptObservation(next);
        if (next.project.mode !== 'ready' || !next.project.catalogComplete || next.diagnostics.some((d) => d.severity === 'error')) return failure(next.diagnostics);
        const oldProject = this.#projectId();
        const newProject = next.project.snapshot.records.find((r) => r.kind === 'project');
        if (newProject?.kind !== 'project' || newProject.value.projectId !== oldProject || newProject.value.catalogRoot !== this.#catalog) return failure([conflict('a3.project.json', 'project-layout-changed')]);
        this.#accepted = this.#observed = next; this.#external = false;
        return { ok: true, value: next.project, diagnostics: next.diagnostics };
      } catch (error) { return failure([this.#operationError('a3.project.json', error)]); }
    });
  }
  async #ignoreRulesFor(directoryPath: string): Promise<IgnoreRule[]> {
    const folders = [''];
    let current = '';
    for (const part of directoryPath.split('/').filter(Boolean)) { current = current ? `${current}/${part}` : part; folders.push(current); }
    const rules: IgnoreRule[] = [];
    for (const base of folders) {
      const path = base ? `${base}/.gitignore` : '.gitignore';
      try {
        const bytes = await fileBytes(this.root, path, 1024 * 1024);
        rules.push(...parseIgnoreRules(new TextDecoder('utf-8', { fatal: true }).decode(bytes), base));
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    return rules;
  }
  async #isHiddenExplorerPath(path: string, directory: boolean, rules: readonly IgnoreRule[]): Promise<boolean> {
    const parts = path.split('/');
    if (parts.some((part) => part === '.a3' || part === '.git' || part === 'node_modules' || part === folderMarker || forbiddenExplorerName.test(part)) ||
        path.split('/').some((_, index, all) => all.slice(0, index + 1).join('/') === '.a3/local')) return true;
    return gitIgnored(path, directory, rules);
  }
  listExplorerDirectory(directoryPath = '', offset = 0): Promise<StoreResult<ExplorerDirectoryPage>> {
    return this.#queue(async () => {
      try {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset % explorerPageSize !== 0) return failure([issue('files', 'schema', 'invalid-page', 'El desplazamiento de la página no es válido.')]);
        if (!this.#authorized('read-resource', directoryPath ? [directoryPath] : [], [], [])) return failure([this.#denied(directoryPath || 'project')]);
        if (directoryPath) resolvePortablePath(this.root, directoryPath);
        const directory = directoryPath ? await checkedPath(this.root, directoryPath, 'directory') : this.root;
        const rules = await this.#ignoreRulesFor(directoryPath);
        const editable = this.#authorized('write', directoryPath ? [directoryPath] : [], [], [], ['document.edit'], 'prepare');
        const names = await readdir(directory);
        const visible: ExplorerFileEntry[] = [];
        for (const name of names) {
          const path = directoryPath ? `${directoryPath}/${name}` : name;
          let info;
          try { info = await lstat(resolvePortablePath(this.root, path), { bigint: true }); }
          catch { continue; }
          const isDirectory = info.isDirectory();
          if (await this.#isHiddenExplorerPath(path, isDirectory, rules)) continue;
          const kind = info.isSymbolicLink() ? 'blocked-link' : isDirectory ? 'directory' : info.isFile() ? 'file' : undefined;
          if (!kind) continue;
          const resource = this.#observed.project.snapshot.records.find((record) => record.kind === 'resource' && record.value.kind === 'project-file' && record.value.path.toLowerCase() === path.toLowerCase());
          visible.push({ path, name, kind, identity: explorerIdentity(info), size: kind === 'file' ? Number(info.size) : null,
            modifiedAt: Number(info.mtimeMs), readOnly: this.state.mode !== 'writer' || !editable || kind === 'blocked-link', ...(resource?.kind === 'resource' ? { resourceId: resource.value.id } : {}) });
        }
        visible.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        const page = visible.slice(offset, offset + explorerPageSize);
        const mounts: ExplorerMountEntry[] = [];
        if (!directoryPath) for (const record of this.#observed.project.snapshot.records) {
          if (record.kind !== 'resource' || record.value.kind !== 'mounted-file') continue;
          let status: ExplorerMountEntry['status'] = 'approval-required';
          const binding = this.options.host.capabilities.getLocalMount({ root: this.root, projectId: this.#projectId() ?? '', mountId: record.value.mountId });
          const approved = this.#authorized('read-resource', [], [refOf(record)], [record.value]);
          if (approved && binding) status = binding.status === 'root-missing' ? 'missing' : binding.status === 'root-changed' ? 'changed' : await inspectLocalMountFile(binding, record.value.path);
          mounts.push({ resourceId: record.value.id, name: record.value.path.split('/').at(-1) ?? record.value.path,
            relativePath: record.value.path, status, readOnly: true });
        }
        return { ok: true, value: { path: directoryPath, entries: page, nextOffset: offset + page.length < visible.length ? offset + page.length : null, mounts }, diagnostics: [] };
      } catch (error) { return failure([this.#operationError(directoryPath || 'project', error)]); }
    });
  }
  readCodeFile(path: string, expectedIdentity?: string): Promise<StoreResult<{ bytes: Uint8Array; hash: string; identity: string }>> {
    return this.#queue(async () => {
      try {
        if (!this.#authorized('read-resource', [path], [], [])) return failure([this.#denied(path)]);
        if (await this.#isHiddenExplorerPath(path, false, await this.#ignoreRulesFor(path.split('/').slice(0, -1).join('/')))) throw new PathError('hidden-path', 'El archivo está oculto o excluido.');
        const native = await checkedPath(this.root, path, 'file');
        const identity = explorerIdentity(await lstat(native, { bigint: true }));
        if (expectedIdentity && identity !== expectedIdentity) return failure([conflict(path, 'file-identity-changed')]);
        const bytes = await fileBytes(this.root, path, 2 * 1024 * 1024);
        if (explorerIdentity(await lstat(await checkedPath(this.root, path, 'file'), { bigint: true })) !== identity) return failure([conflict(path, 'file-identity-changed')]);
        return { ok: true, value: { bytes, hash: sha256(bytes), identity }, diagnostics: [] };
      } catch (error) { return failure([this.#operationError(path, error)]); }
    });
  }
  openExplorerFile(path: string, expectedIdentity?: string): Promise<StoreResult<ExplorerOpenResult>> {
    return this.#queue(async () => {
      try {
        if (!this.#authorized('read-resource', [path], [], [])) return failure([this.#denied(path)]);
        const target = await checkedPath(this.root, path, 'file');
        const info = await lstat(target, { bigint: true });
        if (expectedIdentity && explorerIdentity(info) !== expectedIdentity) return failure([conflict(path, 'file-identity-changed')]);
        const size = Number(info.size);
        if (size > 2 * 1024 * 1024) return failure([issue(path, 'io', 'preview-size-limit', 'El archivo supera el límite de vista previa de 2 MiB; los bytes siguen intactos.')]);
        const bytes = await fileBytes(this.root, path, 2 * 1024 * 1024);
        let text: string | null = null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Binary files open as metadata only. */ }
        return { ok: true, value: { path, name: path.split('/').at(-1) ?? path, text, size, ...(this.#observed.project.snapshot.records.find((record) => record.kind === 'resource' && record.value.kind === 'project-file' && record.value.path === path)?.kind === 'resource' ? { mediaType: (this.#observed.project.snapshot.records.find((record) => record.kind === 'resource' && record.value.kind === 'project-file' && record.value.path === path) as Extract<DomainRecord, { kind: 'resource' }>).value.mediaType } : {}) }, diagnostics: [] };
      } catch (error) { return failure([this.#operationError(path, error)]); }
    });
  }
  validateExplorerEntry(path: string, expectedIdentity: string, kind: 'file' | 'directory'): Promise<StoreResult<{ valid: true }>> {
    return this.#queue(async () => {
      try {
        const resource = this.#observed.project.snapshot.records.find((record) => record.kind === 'resource' && record.value.kind === 'project-file' && record.value.path.toLowerCase() === path.toLowerCase());
        if (!this.#authorized('read-resource', [path], resource?.kind === 'resource' ? [refOf(resource)] : [], resource?.kind === 'resource' ? [resource.value] : [])) {
          return failure([this.#denied(path)]);
        }
        resolvePortablePath(this.root, path);
        if (await this.#isHiddenExplorerPath(path, kind === 'directory', await this.#ignoreRulesFor(path.split('/').slice(0, -1).join('/')))) {
          return failure([issue(path, 'io', 'hidden-path', 'El elemento quedó oculto o excluido de la vista normal.')]);
        }
        const target = await checkedPath(this.root, path, kind);
        const info = await lstat(target, { bigint: true });
        if (explorerIdentity(info) !== expectedIdentity) return failure([conflict(path, 'file-identity-changed')]);
        return { ok: true, value: { valid: true }, diagnostics: [] };
      } catch (error) { return failure([this.#operationError(path, error)]); }
    });
  }
  previewExplorerDelete(path: string, expectedIdentity?: string): Promise<StoreResult<ExplorerDeletePreview>> {
    return this.#queue(async () => {
      try {
        resolvePortablePath(this.root, path);
        const native = resolvePortablePath(this.root, path); const rawInfo = await lstat(native, { bigint: true });
        if (rawInfo.isSymbolicLink() || !rawInfo.isFile() && !rawInfo.isDirectory()) throw new PathError('linked-path', 'No se envían enlaces ni archivos especiales a la papelera.');
        const target = rawInfo.isDirectory() ? await checkedPath(this.root, path, 'directory') : await checkedPath(this.root, path, 'file');
        const info = await lstat(target, { bigint: true });
        if (expectedIdentity && explorerIdentity(info) !== expectedIdentity) return failure([conflict(path, 'file-identity-changed')]);
        if (!this.#authorized('read-resource', [path], [], [])) return failure([this.#denied(path)]);
        const sourcePaths = new Set<string>();
        const collect = async (current: string): Promise<void> => {
          const currentPath = resolvePortablePath(this.root, current); const statValue = await lstat(currentPath, { bigint: true });
          if (statValue.isSymbolicLink()) throw new PathError('linked-path', 'No se siguen enlaces dentro de la carpeta que se va a revisar.');
          if (statValue.isFile()) { if (!current.endsWith('/' + folderMarker)) sourcePaths.add(current.toLowerCase()); return; }
          for (const name of await readdir(await checkedPath(this.root, current, 'directory'))) {
            if (name === folderMarker) continue;
            const child = `${current}/${name}`; const childStat = await lstat(resolvePortablePath(this.root, child), { bigint: true });
            if (await this.#isHiddenExplorerPath(child, childStat.isDirectory(), await this.#ignoreRulesFor(current))) {
              throw new PathError('hidden-content-present', 'La carpeta contiene datos ocultos o ignorados; no se ofrece su eliminación conjunta.');
            }
            await collect(child);
          }
        };
        await collect(path);
        const resources = this.#observed.project.snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'resource' }> =>
          record.kind === 'resource' && record.value.kind === 'project-file' && sourcePaths.has(record.value.path.toLowerCase()));
        const uses = resources.flatMap((resource) => this.#observed.project.snapshot.records.flatMap((record) =>
          record.kind === 'entity' && record.value.contentResourceId?.toLowerCase() === resource.value.id.toLowerCase()
            ? [{ entityId: record.value.id, title: record.value.title }] : []));
        const permission = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: this.root,
          ...(this.#projectId() ? { projectId: this.#projectId()! } : {}), operation: 'write', paths: [path], refs: resources.map(refOf), resources: resources.map((resource) => resource.value),
          requiredCapabilities: ['document.edit', 'delete'], stage: 'prepare' });
        const reason = uses.length ? 'Este recurso tiene usos en entidades; desvincula esos usos antes de enviarlo a la papelera.' : !permission.allowed
          ? 'El perfil del proyecto no concede el permiso de eliminación. Cambia su concesión local antes de continuar.' : undefined;
        return { ok: true, value: { path, uses, deletable: uses.length === 0 && permission.allowed, ...(reason ? { reason } : {}) }, diagnostics: [] };
      } catch (error) { return failure([this.#operationError(path, error)]); }
    });
  }
  #resourceDocumentImages(before: readonly DomainRecord[], after: readonly DomainRecord[], documents: ProjectReadResult['documents']): { images: Image[]; refs: ReturnType<typeof refOf>[] } | StoreDiagnostic {
    const old = new Map(before.filter((record) => record.kind === 'resource').map((record) => [refKey(refOf(record)), record]));
    const next = new Map(after.filter((record) => record.kind === 'resource').map((record) => [refKey(refOf(record)), record]));
    const images: Image[] = []; const refs: ReturnType<typeof refOf>[] = [];
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      const was = old.get(key); const now = next.get(key);
      if (equal(was, now)) continue;
      const record = now ?? was!; const path = recordPath(record, this.#catalog); refs.push(refOf(record));
      if (!now) { images.push({ path, bytes: null, ref: refOf(record) }); continue; }
      if (was) {
        const document = documents.find((candidate) => refKey(refOf(candidate.record!)) === key);
        if (!document) return issue(path, 'schema', 'resource-document-missing', 'No se pudo localizar el documento de recurso para actualizarlo.');
        const previous = was.value as Extract<DomainRecord, { kind: 'resource' }>['value'];
        const current = now.value as Extract<DomainRecord, { kind: 'resource' }>['value'];
        const edits: JsonEdit[] = [];
        if (previous.kind === 'project-file' && current.kind === 'project-file' && previous.path !== current.path) edits.push({ op: 'set', pointer: '/path', value: current.path });
        edits.push({ op: 'set', pointer: '/revision', value: current.revision });
        const encoded = encodeDocument(document, edits);
        if (!encoded.ok) return encoded.diagnostics[0] ?? issue(path, 'schema', 'resource-serialization-failed', 'No se pudo serializar el recurso.');
        images.push({ path, bytes: Uint8Array.from(encoded.bytes), ref: refOf(record) });
      } else {
        const encoded = serializeRecord({ kind: 'resource', path }, now);
        if (!encoded.ok) return encoded.diagnostics[0] ?? issue(path, 'schema', 'resource-serialization-failed', 'No se pudo serializar el recurso.');
        images.push({ path, bytes: Uint8Array.from(encoded.bytes), ref: refOf(record) });
      }
    }
    return { images, refs };
  }
  async #navigationSources(scan: Scan): Promise<NavigationSource[]> {
    const sources: NavigationSource[] = [];
    for (const record of scan.project.snapshot.records) if (record.kind === 'entity' && ['a3.core.page', 'a3.content.markdown', 'a3.content.short-text'].includes(record.value.type)) {
      const resource = scan.project.snapshot.records.find((r) => r.kind === 'resource' && r.value.id === record.value.contentResourceId);
      if (resource?.kind !== 'resource' || resource.value.kind === 'remote-url') continue;
      const mounted = resource.value.kind === 'mounted-file';
      if (resource.value.mediaType !== 'text/markdown' && !resource.value.path.toLowerCase().endsWith('.md')) throw new PathError('navigation-format', 'La página no referencia Markdown.');
      if (resource.value.path.split('/').some((part) => forbiddenExplorerName.test(part)) || !mounted && await this.#isHiddenExplorerPath(resource.value.path, false, await this.#ignoreRulesFor(resource.value.path.split('/').slice(0, -1).join('/')))) throw new PathError('navigation-hidden-source', 'La fuente de página está oculta o excluida; no se indexa.');
      if (!this.#authorized('read-resource', mounted ? [] : [resource.value.path], [refOf(resource)], [resource.value])) throw new PathError(mounted ? 'mount-permission-denied' : 'permission-denied', 'No se puede indexar este recurso.');
      const limit = Math.min(this.#resourceLimit, 2 * 1024 * 1024);
      let bytes: Uint8Array;
      if (mounted) {
        const opened = await readMountedResource({ projectRoot: this.root, projectId: this.#projectId()!, actor: this.options.host.authenticatedActor, broker: this.options.host.capabilities, resource: resource.value, maxBytes: limit });
        if (!opened.ok) throw new PathError('mount-unavailable', opened.diagnostics.map((d) => d.message).join('\n')); bytes = opened.value.bytes;
      } else { bytes = await fileBytes(this.root, resource.value.path, limit); if (sha256(bytes) !== scan.files.get(resource.value.path)?.hash) throw new PathError('external-conflict', 'El Markdown cambió mientras se indexaba.'); }
      const decoded = decodeCodeText(bytes);
      if (decoded.content === null || !decoded.encoding?.startsWith('utf-8')) throw new PathError('navigation-encoding', 'El índice de páginas requiere Markdown UTF-8.');
      sources.push({ entityId: record.value.id, resourceId: resource.value.id, title: record.value.title, path: resource.value.kind === 'mounted-file' ? `@mount/${resource.value.mountId}/${resource.value.path}` : resource.value.path, content: decoded.content, revision: record.value.revision, resourceRevision: resource.value.revision, ...(mounted ? { mounted: true } : {}) });
    }
    return sources;
  }
  navigationIndex(): Promise<StoreResult<NavigationIndex>> { return this.#queue(async () => {
    try {
      const scan = await this.#scan(true); const sources: NavigationSource[] = [], diagnostics: string[] = [];
      // A missing/corrupt resource does not fabricate a blank page or erase other backlinks.
      for (const record of scan.project.snapshot.records.filter((r) => r.kind === 'entity')) {
        try { sources.push(...await this.#navigationSources({ ...scan, project: { ...scan.project, snapshot: { records: scan.project.snapshot.records.filter((r) => r.kind !== 'entity' || r === record) } } })); }
        catch (error) { if (error instanceof PathError && error.detail === 'permission-denied') return failure([this.#denied('navigation')]); diagnostics.push(`${refOf(record).id}: ${error instanceof Error ? error.message : 'Recurso no disponible'}`); }
      }
      return { ok: true, value: buildNavigationIndex(sources, diagnostics), diagnostics: [] };
    } catch (error) { return failure([this.#operationError('navigation', error)]); }
  }); }
  async #rewriteNavigation(scan: Scan, nextRecords: DomainRecord[], images: Image[]): Promise<void> {
    const sources = await this.#navigationSources(scan);
    const replacements = sources.map((s) => {
      const entity = nextRecords.find((r) => r.kind === 'entity' && r.value.id === s.entityId);
      const resource = nextRecords.find((r) => r.kind === 'resource' && r.value.id === s.resourceId);
      return { ...s, title: entity?.kind === 'entity' ? entity.value.title : s.title, path: resource?.kind === 'resource' && resource.value.kind === 'project-file' ? resource.value.path : s.path };
    });
    for (const [resourceId, content] of rewritePageReferences(sources, replacements)) {
      const record = nextRecords.find((r) => r.kind === 'resource' && r.value.id === resourceId);
      const source = sources.find((s) => s.resourceId === resourceId)!;
      if (source.mounted) throw new PathError('navigation-read-only', 'Una referencia conocida pertenece a un montaje de solo lectura. No se modificó ningún archivo; usa vínculos por ID o copia la página al proyecto.');
      if (record?.kind !== 'resource' || record.value.kind !== 'project-file') continue;
      this.#sourcePath(record.value.path); this.#sourcePath(source.path);
      const bytes = await fileBytes(this.root, source.path, this.#resourceLimit), decoded = decodeCodeText(bytes);
      if (sha256(bytes) !== scan.files.get(source.path)?.hash) throw new PathError('external-conflict', 'Cambió una referencia antes de preparar la transacción.');
      if (!decoded.encoding || decoded.readOnlyReason) throw new PathError('navigation-read-only', 'Una referencia conocida requiere edición pero su codificación o finales de línea son de solo lectura.');
      const updated = encodeCodeText(content, decoded.encoding), existing = images.find((image) => image.path === record.value.path);
      if (existing) existing.bytes = updated; else images.push({ path: record.value.path, bytes: updated, ref: refOf(record) });
      const before = scan.project.snapshot.records.find((r) => r.kind === 'resource' && r.value.id === resourceId)!;
      record.value.revision = Math.max(record.value.revision, (before.value as Resource).revision + 1);
    }
  }
  #navigationChanged(before: readonly DomainRecord[], after: readonly DomainRecord[]): boolean {
    const next = new Map(after.map((r) => [refKey(refOf(r)), r]));
    return before.some((record) => {
      if (record.kind !== 'entity' || !['a3.core.page', 'a3.content.markdown', 'a3.content.short-text'].includes(record.value.type)) return false;
      const entity = next.get(refKey(refOf(record))), resource = before.find((r) => r.kind === 'resource' && r.value.id === record.value.contentResourceId);
      const replacement = resource && next.get(refKey(refOf(resource)));
      return entity?.kind === 'entity' && entity.value.title !== record.value.title || resource?.kind === 'resource' && resource.value.kind === 'project-file' && replacement?.kind === 'resource' && replacement.value.kind === 'project-file' && resource.value.path !== replacement.value.path;
    });
  }
  preparePageRename(input: { operationId: string; entityId: string; expectedRevision: number; title: string }): Promise<StoreResult<PreparedWrite>> { return this.#queue(async () => {
    try {
      const current = await this.#currentForWrite(); if (!current.ok) return current; const scan = current.value;
      const before = scan.project.snapshot.records, next = structuredClone(before) as DomainRecord[];
      const entity = next.find((r) => r.kind === 'entity' && r.value.id === input.entityId);
      if (entity?.kind !== 'entity' || !['a3.core.page', 'a3.content.markdown', 'a3.content.short-text'].includes(entity.value.type) || !input.title.trim() || input.title.length > 200 || /[\r\n]/.test(input.title)) return failure([issue('page', 'schema', 'invalid-page-title', 'Elige un título de página de 1 a 200 caracteres, sin saltos de línea.')]);
      if (entity.value.revision !== input.expectedRevision) return failure([conflict('page')]);
      entity.value.title = input.title.trim(); entity.value.revision++;
      const images: Image[] = []; await this.#rewriteNavigation(scan, next, images);
      const document = scan.project.documents.find((d) => d.record?.kind === 'entity' && d.record.value.id === entity.value.id)!;
      const encoded = encodeDocument(document, [{ op: 'set', pointer: '/title', value: entity.value.title }, { op: 'set', pointer: '/revision', value: entity.value.revision }]);
      if (!encoded.ok) return encoded;
      images.push({ path: document.location.path, bytes: encoded.bytes, ref: refOf(entity) });
      const resources = this.#resourceDocumentImages(before, next, scan.project.documents); if ('detail' in resources) return failure([resources]); images.push(...resources.images);
      const invalid = validateSnapshot({ records: next }, this.#registry); if (invalid.some((d) => d.severity === 'error')) return failure(domainIssues(invalid));
      return this.#makePlan(scan, input.operationId, images, next, next.flatMap((r) => r.kind === 'resource' ? [r.value] : []), sha256(jsonBytes(input)));
    } catch (error) { return failure([this.#operationError('page', error)]); }
  }); }
  prepareExplorerOperation(input: ExplorerOperationRequest): Promise<StoreResult<PreparedWrite>> {
    const request = { ...input, ...(input.bytes ? { bytes: Uint8Array.from(input.bytes) } : {}) };
    return this.#queue(async () => {
      try {
        const current = await this.#currentForWrite(); if (!current.ok) return current;
        if (!uuid.test(request.operationId) || !['create-file', 'create-folder', 'rename', 'duplicate', 'trash', 'write-file'].includes(request.action)) return failure([issue('files', 'schema', 'invalid-file-operation', 'La operación de archivos no es válida.')]);
        const records = structuredClone(current.value.project.snapshot.records) as DomainRecord[];
        const originalRecords = current.value.project.snapshot.records;
        const fileImages: Image[] = [];
        const extPaths = new Set<string>();
        const sourceFiles: { path: string; bytes: Uint8Array; identity: string }[] = [];
        const sourceDirectories: string[] = [];
        let sourceIsDirectory = false;
        const checkPath = (path: string): void => {
          resolvePortablePath(this.root, path);
          if (path.split('/').some((part) => forbiddenExplorerName.test(part) || part === folderMarker)) throw new PathError('hidden-path', 'La ruta está oculta o reservada al sistema A3.');
        };
        const hiddenRules = await this.#ignoreRulesFor(request.sourcePath?.split('/').slice(0, -1).join('/') ?? '');
        const ensureSource = async (): Promise<void> => {
          if (!request.sourcePath) throw new PathError('source-required', 'Selecciona un elemento del explorador.');
          checkPath(request.sourcePath);
          if (await this.#isHiddenExplorerPath(request.sourcePath, false, hiddenRules)) throw new PathError('ignored-path', 'El elemento está excluido de la vista normal.');
          const rootPath = await checkedPath(this.root, request.sourcePath, (await lstat(resolvePortablePath(this.root, request.sourcePath))).isDirectory() ? 'directory' : 'file');
          const rootStat = await lstat(rootPath, { bigint: true });
          if (request.expectedSourceIdentity && explorerIdentity(rootStat) !== request.expectedSourceIdentity) throw new PathError('file-identity-changed', 'El elemento cambió desde que se mostró en el explorador.');
          sourceIsDirectory = rootStat.isDirectory();
          const visit = async (path: string): Promise<void> => {
            const info = await lstat(resolvePortablePath(this.root, path), { bigint: true });
            if (info.isSymbolicLink()) throw new PathError('linked-path', 'No se siguen enlaces simbólicos ni junctions desde el explorador.');
            if (info.isDirectory()) {
              sourceDirectories.push(path);
              const children = await readdir(await checkedPath(this.root, path, 'directory'));
              const childRules = await this.#ignoreRulesFor(path);
              for (const name of children) {
                if (name === folderMarker) continue;
                const child = `${path}/${name}`;
                const childInfo = await lstat(resolvePortablePath(this.root, child), { bigint: true });
                if (await this.#isHiddenExplorerPath(child, childInfo.isDirectory(), childRules)) throw new PathError('hidden-content-present', 'La carpeta contiene archivos ignorados u ocultos. Desplaza esos archivos explícitamente antes de modificar la carpeta.');
                await visit(child);
              }
            } else if (info.isFile()) {
              extPaths.add(path);
              sourceFiles.push({ path, bytes: await fileBytes(this.root, path, this.#resourceLimit), identity: explorerIdentity(info) });
            } else throw new PathError('unexpected-file-kind', 'El elemento no es un archivo regular ni una carpeta.');
          };
          await visit(request.sourcePath);
          if (sourceDirectories.length) sourceIsDirectory = true;
        };
        const resourceByPath = new Map<string, Extract<DomainRecord, { kind: 'resource' }>[] >();
        for (const record of records) if (record.kind === 'resource' && record.value.kind === 'project-file') {
          const bucket = resourceByPath.get(record.value.path.toLowerCase()) ?? []; bucket.push(record); resourceByPath.set(record.value.path.toLowerCase(), bucket);
        }
        const nextRecords = records;
        const targetDirectoryObservations: DirectoryObservation[] = [];
        if (request.action === 'create-file' || request.action === 'create-folder') {
          const target = request.targetPath; if (!target) throw new PathError('target-required', 'Indica la ubicación nueva.'); checkPath(target);
          if (!explorerName(target.split('/').at(-1) ?? '')) throw new PathError('invalid-name', 'El nombre del archivo o carpeta no es válido.');
          const parent = target.split('/').slice(0, -1).join('/'); if (parent) {
            await checkedPath(this.root, parent, 'directory');
            const parentObservation = await this.#directoryObservation(parent);
            if (request.targetParentIdentity && parentObservation.identity !== request.targetParentIdentity) throw new PathError('file-identity-changed', 'La carpeta de destino cambió desde que se mostró.');
            targetDirectoryObservations.push(parentObservation);
          }
          if (await this.#isHiddenExplorerPath(target, request.action === 'create-folder', await this.#ignoreRulesFor(parent))) throw new PathError('ignored-path', 'El nombre quedaría oculto por las exclusiones del proyecto.');
          await absentPath(this.root, target);
          if (request.action === 'create-folder') {
            const marker = `${target}/${folderMarker}`;
            const markerBytes = Buffer.from(JSON.stringify({ schemaVersion: '1.0.0', folderId: randomUUID() }) + '\n');
            fileImages.push({ path: marker, bytes: markerBytes }); extPaths.add(marker);
          } else {
            const bytes = Buffer.from(request.content ?? '', 'utf8');
            const id = randomUUID(); const resource: DomainRecord = { kind: 'resource', value: { schemaVersion: '1.0.0', id, revision: 1,
              kind: 'project-file', path: target, mediaType: mediaTypeForPath(target), extensions: {} } };
            nextRecords.push(resource);
            fileImages.push({ path: target, bytes }); extPaths.add(target);
          }
        } else {
          await ensureSource();
          if (request.action === 'rename' || request.action === 'trash') for (const file of sourceFiles) this.#sourcePath(file.path);
          if (request.action === 'write-file') {
            this.#sourcePath(request.sourcePath!);
            if (sourceIsDirectory || sourceFiles.length !== 1 || !request.bytes || request.bytes.length > 2 * 1024 * 1024 ||
                !request.expectedHash || !/^[a-f0-9]{64}$/.test(request.expectedHash)) throw new PathError('invalid-code-write', 'Se requiere un archivo de texto acotado y su hash observado.');
            const source = sourceFiles[0]!;
            if (sha256(source.bytes) !== request.expectedHash) return failure([conflict(source.path, 'code-content-changed')]);
            if (resourceByPath.has(source.path.toLowerCase())) return failure([conflict(source.path, 'code-resource-now-tracked')]);
            const resource: DomainRecord = { kind: 'resource', value: { schemaVersion: '1.0.0', id: randomUUID(), revision: 1,
              kind: 'project-file', path: source.path, mediaType: mediaTypeForPath(source.path), extensions: {} } };
            nextRecords.push(resource);
            fileImages.push({ path: source.path, bytes: request.bytes, ref: refOf(resource) });
          } else if (request.action === 'trash') {
            const tracked = resourceByPath;
            for (const source of sourceFiles) for (const resource of tracked.get(source.path.toLowerCase()) ?? []) {
              const used = originalRecords.some((record) => record.kind === 'entity' && record.value.contentResourceId?.toLowerCase() === resource.value.id.toLowerCase());
              if (used) return failure([issue(source.path, 'references', 'resource-in-use', 'El archivo se conserva porque entidades del proyecto todavía lo utilizan; revisa los usos antes de quitar esas referencias.')]);
            }
            const targetRoot = `.a3/local/trash/${request.operationId}`;
            const markers = sourceIsDirectory ? await this.#folderMarkers(request.sourcePath!) : [];
            const markerDirectories = new Set(markers.map((marker) => marker.slice(0, -1 * (folderMarker.length + 1)).toLowerCase()));
            for (const source of sourceFiles) {
              const sourceResource = resourceByPath.get(source.path.toLowerCase())?.[0];
              fileImages.push({ path: `${targetRoot}/${source.path}`, bytes: source.bytes, ...(sourceResource ? { ref: refOf(sourceResource) } : {}) });
              fileImages.push({ path: source.path, bytes: null, ...(sourceResource ? { ref: refOf(sourceResource) } : {}) });
              extPaths.add(source.path); extPaths.add(`${targetRoot}/${source.path}`);
              for (const resource of resourceByPath.get(source.path.toLowerCase()) ?? []) {
                nextRecords.splice(nextRecords.findIndex((record) => record.kind === 'resource' && record.value.id.toLowerCase() === resource.value.id.toLowerCase()), 1);
              }
            }
            for (const marker of markers) {
              const bytes = await fileBytes(this.root, marker, 4096);
              fileImages.push({ path: `${targetRoot}/${marker}`, bytes }, { path: marker, bytes: null });
              extPaths.add(marker); extPaths.add(`${targetRoot}/${marker}`);
            }
            for (const directory of sourceDirectories) {
              if (sourceFiles.some((file) => file.path.toLowerCase().startsWith(directory.toLowerCase() + '/')) || markerDirectories.has(directory.toLowerCase())) continue;
              const suffix = directory.slice(request.sourcePath!.length).replace(/^\//, '');
              const targetDirectory = suffix ? `${targetRoot}/${request.sourcePath}/${suffix}` : `${targetRoot}/${request.sourcePath}`;
              const marker = `${targetDirectory}/${folderMarker}`;
              fileImages.push({ path: marker, bytes: Buffer.from(JSON.stringify({ schemaVersion: '1.0.0', folderId: randomUUID() }) + '\n') });
              extPaths.add(marker);
            }
          } else {
            const target = request.targetPath; if (!target) throw new PathError('target-required', 'Indica el destino del elemento.'); checkPath(target);
            if (!explorerName(target.split('/').at(-1) ?? '')) throw new PathError('invalid-name', 'El nombre nuevo no es válido.');
            const parent = target.split('/').slice(0, -1).join('/'); if (parent) {
              await checkedPath(this.root, parent, 'directory');
              targetDirectoryObservations.push(await this.#directoryObservation(parent));
            }
            if (await this.#isHiddenExplorerPath(target, sourceIsDirectory, await this.#ignoreRulesFor(parent))) throw new PathError('ignored-path', 'El nombre nuevo quedaría oculto por las exclusiones del proyecto.');
            if (target.toLowerCase() === request.sourcePath!.toLowerCase() || target.toLowerCase().startsWith(request.sourcePath!.toLowerCase() + '/')) throw new PathError('nested-target', 'El destino no puede estar dentro del elemento de origen.');
            await absentPath(this.root, target);
            const moving = request.action === 'rename';
            if (sourceIsDirectory) {
              for (const source of sourceFiles) {
                const suffix = source.path.slice(request.sourcePath!.length).replace(/^\//, '');
                const dest = `${target}/${suffix}`;
                fileImages.push({ path: dest, bytes: source.bytes });
                if (moving) fileImages.push({ path: source.path, bytes: null });
                extPaths.add(source.path); extPaths.add(dest);
              }
              for (const markerPath of await this.#folderMarkers(request.sourcePath!)) {
                const suffix = markerPath.slice(request.sourcePath!.length).replace(/^\//, '');
                const dest = `${target}/${suffix}`;
                const bytes = await fileBytes(this.root, markerPath, 4096);
                const replacement = moving ? bytes : Buffer.from(JSON.stringify({ schemaVersion: '1.0.0', folderId: randomUUID() }) + '\n');
                fileImages.push({ path: dest, bytes: replacement }); if (moving) fileImages.push({ path: markerPath, bytes: null });
                extPaths.add(markerPath); extPaths.add(dest);
              }
              const markers = await this.#folderMarkers(request.sourcePath!);
              const markerDirectories = new Set(markers.map((marker) => marker.slice(0, -1 * (folderMarker.length + 1)).toLowerCase()));
              for (const directory of sourceDirectories) {
                if (sourceFiles.some((file) => file.path.toLowerCase().startsWith(directory.toLowerCase() + '/')) || markerDirectories.has(directory.toLowerCase())) continue;
                const suffix = directory.slice(request.sourcePath!.length).replace(/^\//, '');
                const targetDirectory = suffix ? `${target}/${suffix}` : target;
                fileImages.push({ path: `${targetDirectory}/${folderMarker}`, bytes: Buffer.from(JSON.stringify({ schemaVersion: '1.0.0', folderId: randomUUID() }) + '\n') });
                extPaths.add(`${targetDirectory}/${folderMarker}`);
              }
            } else {
              const source = sourceFiles[0]!;
              fileImages.push({ path: target, bytes: source.bytes }); if (moving) fileImages.push({ path: source.path, bytes: null });
              extPaths.add(source.path); extPaths.add(target);
            }
            for (const source of sourceFiles) for (const oldResource of resourceByPath.get(source.path.toLowerCase()) ?? []) {
              const id = moving ? oldResource.value.id : randomUUID();
              const destinationPath = sourceIsDirectory ? `${target}/${source.path.slice(request.sourcePath!.length).replace(/^\//, '')}` : target;
              const value = { ...structuredClone(oldResource.value), id, revision: moving ? oldResource.value.revision + 1 : 1, path: destinationPath };
              const key = refKey({ kind: 'resource', id: oldResource.value.id });
              const index = nextRecords.findIndex((record) => refKey(refOf(record)) === key);
              if (moving) nextRecords[index] = { kind: 'resource', value };
              else nextRecords.push({ kind: 'resource', value });
            }
            if (request.action === 'duplicate') {
              // A copied file receives a catalog identity even when the original was an ordinary untracked file.
              for (const source of sourceFiles) if (!(resourceByPath.get(source.path.toLowerCase())?.length)) {
                const id = randomUUID();
                nextRecords.push({ kind: 'resource', value: { schemaVersion: '1.0.0', id, revision: 1, kind: 'project-file',
                  path: sourceIsDirectory ? `${target}/${source.path.slice(request.sourcePath!.length).replace(/^\//, '')}` : target,
                  mediaType: mediaTypeForPath(source.path), extensions: {} } });
              }
            }
          }
        }
        if (request.action === 'rename' && this.#navigationChanged(originalRecords, nextRecords)) await this.#rewriteNavigation(current.value, nextRecords, fileImages);
        const encodedResources = this.#resourceDocumentImages(originalRecords, nextRecords, current.value.project.documents);
        if ('detail' in encodedResources) return failure([encodedResources]);
        const allImages = [...fileImages, ...encodedResources.images];
        const finalScan: Scan = { ...current.value, files: new Map(current.value.files) };
        for (const path of extPaths) if (!finalScan.files.has(path)) finalScan.files.set(path, await this.#observe(path, true));
        if (request.action === 'write-file' && finalScan.files.get(request.sourcePath!)?.hash !== request.expectedHash) return failure([conflict(request.sourcePath!, 'code-content-changed')]);
        if (request.action === 'write-file' && request.expectedSourceIdentity && explorerIdentity(await lstat(await checkedPath(this.root, request.sourcePath!, 'file'), { bigint: true })) !== request.expectedSourceIdentity) return failure([conflict(request.sourcePath!, 'file-identity-changed')]);
        const externalDirectories = [...await Promise.all(sourceDirectories.map((path) => this.#directoryObservation(path))), ...targetDirectoryObservations]
          .filter((value, index, all) => all.findIndex((candidate) => candidate.path.toLowerCase() === value.path.toLowerCase()) === index);
        if (allImages.length === 0) return failure([issue(request.sourcePath ?? request.targetPath ?? 'files', 'io', 'empty-operation', 'No hay archivos que modificar.')]);
        const invalid = validateSnapshot({ records: nextRecords }, this.#registry);
        if (invalid.some((diagnostic) => diagnostic.severity === 'error')) return failure(domainIssues(invalid));
        const required: Capability[] = request.action === 'trash' ? ['document.edit', 'delete'] : ['document.edit'];
        const resources = nextRecords.flatMap((record) => record.kind === 'resource' ? [record.value] : []);
        return this.#makePlan(finalScan, request.operationId, allImages, nextRecords, resources,
          sha256(jsonBytes({ action: request.action, source: request.sourcePath ?? null, target: request.targetPath ?? null,
            hashes: sourceFiles.map((file) => sha256(file.bytes)), ...(request.action === 'write-file' ? { afterHash: sha256(request.bytes!) } : {}), actor: this.options.host.authenticatedActor })),
          { requiredCapabilities: required, externalPaths: [...extPaths], externalDirectories });
      } catch (error) { return failure([this.#operationError(request.sourcePath ?? request.targetPath ?? 'files', error)]); }
    });
  }
  async #folderMarkers(rootPath: string): Promise<string[]> {
    const found: string[] = [];
    const visit = async (path: string): Promise<void> => {
      const entries = await readdir(await checkedPath(this.root, path, 'directory'));
      if (entries.includes(folderMarker)) found.push(`${path}/${folderMarker}`);
      for (const name of entries) {
        if (name === folderMarker) continue;
        const child = `${path}/${name}`; const info = await lstat(resolvePortablePath(this.root, child));
        if (info.isSymbolicLink()) throw new PathError('linked-path', 'No se copian ni mueven enlaces de carpeta.');
        if (info.isDirectory()) await visit(child);
      }
    };
    await visit(rootPath); return found;
  }
  openResource(resourceId: string, maxBytes = this.#resourceLimit): Promise<StoreResult<OpenResource>> {
    return this.#queue(async () => {
      if (this.#closing) return failure([issue('resource', 'io', 'service-closed', 'El servicio está cerrado.')]);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > this.#resourceLimit) {
        return failure([issue('resource', 'io', 'invalid-read-limit', 'El límite de lectura solicitado no es válido.')]);
      }
      try {
        const next = await this.#scan(true); this.#acceptObservation(next);
        const record = getRecord(next.project.snapshot, { kind: 'resource', id: resourceId });
        if (record?.kind !== 'resource') return failure([issue('resource', 'references', 'resource-missing', 'Resource ID ausente o descriptor inválido.', { code: 'RESOURCE_MISSING' })]);
        if (!this.#authorized('read-resource', record.value.kind === 'project-file' ? [record.value.path] : [], [refOf(record)], [record.value])) return failure([this.#denied('resource')]);
        if (record.value.kind === 'remote-url') return failure([issue(record.value.url, 'io', 'remote-resource-unavailable',
          'Las URLs remotas siguen deshabilitadas; no se inicia red desde el lector de proyectos.', { code: 'PERMISSION_DENIED', missingCapability: 'network.access' })]);
        const opened = record.value.kind === 'mounted-file'
          ? await readMountedResource({ projectRoot: this.root, projectId: this.#projectId() ?? '', actor: this.options.host.authenticatedActor,
              broker: this.options.host.capabilities, resource: record.value, maxBytes })
          : await readProjectResource(this.root, record.value, maxBytes);
        if (!opened.ok) return opened;
        const doc = next.project.documents.find((d) => d.record === record)!;
        if (record.value.kind === 'project-file' && opened.value.sha256 !== next.files.get(opened.value.path)?.hash) return failure([conflict(opened.value.path)]);
        return { ok: true, value: { ...opened.value, resourceId: record.value.id, revision: record.value.revision, descriptorHash: doc.sha256,
          source: record.value.kind, ...(record.value.kind === 'mounted-file' ? { mountId: record.value.mountId } : {}) }, diagnostics: [] };
      } catch (error) { return failure([this.#operationError('resource', error)]); }
    });
  }
  async #evaluateMountAction(scan: Scan, input: MountActionRequest): Promise<{
    preview: MountActionPreview; sourceResource: Resource & { kind: 'mounted-file'; path: string; mountId: string };
    targetResource: Resource; descriptorPath: string;
    source?: Awaited<ReturnType<typeof readLocalMountFile>>; diagnostics: StoreDiagnostic[];
  }> {
    if (!['copy', 'move', 'reference'].includes(input.action) || !uuid.test(input.operationId) || !uuid.test(input.resourceId) || !uuid.test(input.mountId)) {
      throw new MountPathError('invalid-mount-action', 'La acción, el operationId, el resourceId o el mountId no son válidos.', 'VALIDATION_FAILED');
    }
    const projectId = this.#projectId();
    if (!projectId) throw new MountPathError('project-id-unavailable', 'No se puede verificar la identidad local del proyecto.', 'PERMISSION_DENIED');
    const sourceResource: Resource & { kind: 'mounted-file'; path: string; mountId: string } = { schemaVersion: '1.0.0', id: input.resourceId, revision: 1,
      kind: 'mounted-file', mountId: input.mountId, path: input.sourcePath, extensions: {} };
    let targetResource: Resource;
    if (input.action === 'reference') {
      if (input.destinationPath) throw new MountPathError('unexpected-destination', 'Una referencia conserva la ruta relativa al montaje y no acepta destino de copia.', 'VALIDATION_FAILED');
      targetResource = { ...sourceResource };
    } else {
      if (!input.destinationPath) throw new MountPathError('destination-required', 'Copy/move requiere una ruta destino dentro del proyecto.', 'VALIDATION_FAILED');
      this.#sourcePath(input.destinationPath);
      targetResource = { schemaVersion: '1.0.0', id: input.resourceId, revision: 1, kind: 'project-file',
        path: input.destinationPath, extensions: {}, ...(input.mediaType ? { mediaType: input.mediaType } : {}) };
    }
    if (scan.project.snapshot.records.some((record) => record.kind === 'resource' && record.value.id.toLowerCase() === input.resourceId.toLowerCase())) {
      throw new MountPathError('resource-id-exists', 'El resourceId ya existe en este proyecto.', 'REVISION_CONFLICT');
    }
    const descriptorPath = recordPath({ kind: 'resource', value: targetResource }, this.#catalog);
    const destinationPaths = input.action === 'reference' ? [descriptorPath] : [descriptorPath, input.destinationPath!];
    const destinationConflicts: string[] = [];
    for (const path of destinationPaths) {
      try { if (await destinationExists(this.root, path)) destinationConflicts.push(path); }
      catch (error) { throw error instanceof MountPathError ? error : error instanceof PathError
        ? new MountPathError(error.detail, error.message, 'PATH_UNAVAILABLE') : error; }
    }
    const requiredCapabilities: Capability[] = input.action === 'move'
      ? ['mount.read', 'mount.write', 'document.edit'] : ['mount.read', 'document.edit'];
    const editCapabilities = requiredCapabilities.filter((capability) => capability !== 'mount.read');
    const editDecision = await this.options.host.capabilities.authorizeCapabilities(this.root, this.options.host.authenticatedActor,
      projectId, editCapabilities, 'mount.action.prepare:' + input.operationId, 'prepare');
    const binding = this.options.host.capabilities.getLocalMount({ root: this.root, projectId, mountId: input.mountId });
    let source: Awaited<ReturnType<typeof readLocalMountFile>> | undefined;
    const diagnostics: StoreDiagnostic[] = [];
    if (!binding) diagnostics.push(issue(input.sourcePath, 'io', 'mount-approval-required',
      'Este proyecto solo solicita el montaje. Selecciona la carpeta local y apruébala para este proyecto.',
      { code: 'PERMISSION_DENIED', missingCapability: 'mount.read' }));
    else if (binding.status !== 'available') diagnostics.push(issue(input.sourcePath, 'io', binding.status === 'root-missing' ? 'mount-root-missing' : 'mount-root-changed',
      binding.status === 'root-missing' ? 'La carpeta montada desapareció o se movió; la referencia se conserva y puede recuperarse al seleccionarla de nuevo.'
        : 'La carpeta montada fue reemplazada; la referencia se conserva hasta que vuelvas a aprobar la raíz.',
      { code: 'PATH_UNAVAILABLE' }));
    else if (input.action === 'move' && binding.permission !== 'read-write') diagnostics.push(issue(input.sourcePath, 'io', 'mount-write-not-approved',
      'El permiso local de este montaje es de solo lectura.', { code: 'PERMISSION_DENIED', missingCapability: 'mount.write' }));
    else {
      const opened = await readMountedResourceDetailed({ projectRoot: this.root, projectId, actor: this.options.host.authenticatedActor,
        broker: this.options.host.capabilities, resource: sourceResource, maxBytes: this.#resourceLimit });
      if (opened.ok) source = opened.value; else diagnostics.push(...opened.diagnostics);
    }
    const permissionBlock = !editDecision.allowed
      ? editDecision.reason === 'capability-unavailable'
        ? 'capability-unavailable:' + (editDecision.missingCapability ?? editDecision.capability)
        : 'missing-capability:' + (editDecision.missingCapability ?? 'document.edit')
      : undefined;
    const sourceDiagnostic = diagnostics[0];
    const reason = sourceDiagnostic?.detail ?? permissionBlock ??
      (destinationConflicts.length ? 'destination-conflict' : undefined);
    return { sourceResource, targetResource, descriptorPath, ...(source ? { source } : {}), diagnostics,
      preview: { action: input.action, mountId: input.mountId, relativePath: input.sourcePath, destinationPaths,
        requiredCapabilities, sourceAvailable: !!source, destinationConflicts, canProceed: !!source && !destinationConflicts.length &&
          editDecision.allowed && input.action !== 'move', ...(reason ? { reason } : input.action === 'move' ? { reason: 'capability-unavailable:mount.write' } : {}) } };
  }
  previewMountAction(input: MountActionRequest): Promise<StoreResult<MountActionPreview>> {
    return this.#queue(async () => {
      try {
        const current = await this.#currentForWrite(); if (!current.ok) return failure(current.diagnostics);
        const evaluated = await this.#evaluateMountAction(current.value, input);
        return { ok: true, value: evaluated.preview, diagnostics: evaluated.diagnostics };
      } catch (error) { return failure([mountError('mount', error)]); }
    });
  }
  prepareMountAction(input: MountActionRequest): Promise<StoreResult<PreparedWrite>> {
    return this.#queue(async () => {
      try {
        const current = await this.#currentForWrite(); if (!current.ok) return failure(current.diagnostics);
        const scan = current.value;
        const evaluated = await this.#evaluateMountAction(scan, input);
        if (!evaluated.preview.canProceed || !evaluated.source) {
          const blocker = evaluated.diagnostics[0] ?? issue(evaluated.preview.destinationConflicts[0] ?? 'mount', 'io',
            evaluated.preview.reason ?? 'mount-action-denied', 'La vista previa contiene conflictos o permisos que impiden preparar esta operación.',
            { code: evaluated.preview.reason?.startsWith('missing-capability:') || evaluated.preview.reason?.startsWith('capability-unavailable:') ? 'PERMISSION_DENIED' : 'REVISION_CONFLICT',
              ...(evaluated.preview.reason?.includes('mount.write') ? { missingCapability: 'mount.write' } :
                evaluated.preview.reason?.startsWith('missing-capability:') ? { missingCapability: evaluated.preview.reason.slice('missing-capability:'.length) } : {}) });
          return failure([...evaluated.diagnostics, blocker]);
        }
        const record: DomainRecord = { kind: 'resource', value: evaluated.targetResource };
        const nextRecords = [...scan.project.snapshot.records, record];
        const referenceDiagnostics = validateSnapshot({ records: nextRecords }, this.#registry);
        const blockingReferenceDiagnostics = referenceDiagnostics.filter((diagnostic) => diagnostic.severity === 'error');
        if (blockingReferenceDiagnostics.length) return failure(domainIssues(blockingReferenceDiagnostics));
        const serialized = serializeRecord({ kind: 'resource', path: evaluated.descriptorPath, expectedId: input.resourceId }, record);
        if (!serialized.ok) return serialized;
        const images: Image[] = [{ path: evaluated.descriptorPath, bytes: Uint8Array.from(serialized.bytes), ref: refOf(record) }];
        if (input.action === 'copy') images.push({ path: input.destinationPath!, bytes: Uint8Array.from(evaluated.source.bytes), ref: refOf(record) });
        const requestHash = sha256(jsonBytes({ action: input.action, operationId: input.operationId, resourceId: input.resourceId,
          mountId: input.mountId, sourcePath: input.sourcePath, destinationPath: input.destinationPath ?? null,
          sourceHash: evaluated.source.sha256, actor: this.options.host.authenticatedActor }));
        return this.#makePlan(scan, input.operationId, images, nextRecords, [evaluated.sourceResource, evaluated.targetResource], requestHash,
          { requiredCapabilities: [...evaluated.preview.requiredCapabilities] as Capability[],
            mountSource: { resource: evaluated.sourceResource, sha256: evaluated.source.sha256, identity: evaluated.source.identity } });
      } catch (error) { return failure([mountError('mount', error)]); }
    });
  }
  async #verifyMountSource(source: NonNullable<PlanData['mountSource']>): Promise<StoreDiagnostic | undefined> {
    const projectId = this.#projectId();
    if (!projectId) return issue(source.resource.path, 'io', 'project-id-unavailable', 'No se puede verificar el montaje.', { code: 'PERMISSION_DENIED' });
    const binding = this.options.host.capabilities.getLocalMount({ root: this.root, projectId, mountId: source.resource.mountId });
    if (!binding) return issue(source.resource.path, 'io', 'mount-approval-required', 'La concesión local del montaje ya no existe.',
      { code: 'PERMISSION_DENIED', missingCapability: 'mount.read' });
    if (binding.status !== 'available') return issue(source.resource.path, 'io', binding.status === 'root-missing' ? 'mount-root-missing' : 'mount-root-changed',
      'La raíz montada cambió antes de aplicar la operación; no se modificó el proyecto.', { code: 'PATH_UNAVAILABLE' });
    try {
      const current = await readLocalMountFile(binding, source.resource.path, this.#resourceLimit);
      if (current.sha256 !== source.sha256 || current.identity !== source.identity) return conflict(source.resource.path, 'mounted-source-conflict');
    } catch (error) { return mountError(source.resource.path, error); }
    return undefined;
  }
  #context(scan: Scan): CommandContext {
    const contentHashes: Record<string, string> = {};
    for (const r of scan.project.snapshot.records) if (r.kind === 'resource' && r.value.kind === 'project-file') {
      const hash = scan.files.get(r.value.path)?.hash; if (hash) contentHashes[r.value.id] = hash;
    }
    const actor = this.options.host.authenticatedActor;
    const broker = this.options.host.capabilities;
    return { authenticatedActor: actor, authorization: {
      authorize: (request) => broker.authorizeDomain(this.root, actor, request).allowed,
      authorizeDetailed: (request) => broker.authorizeDomain(this.root, actor, request)
    }, registry: this.#registry, contentHashes };
  }
  async #currentForWrite(): Promise<StoreResult<Scan>> {
    const gate = this.#gate(); if (gate.length) return failure(gate);
    const next = await this.#scan(true); this.#acceptObservation(next);
    const changed = this.#changes(this.#accepted, next);
    if (this.#external || changed.length) return failure((changed.length ? changed : ['a3.project.json']).map((path) => conflict(path)));
    return { ok: true, value: next, diagnostics: [] };
  }
  async #currentForMaintenance(allowRegisteredMigration = false): Promise<StoreResult<Scan>> {
    if (this.#closing || !this.#ownership?.alive() || this.#reason && this.#reason !== 'project-not-writable') {
      return failure([issue('a3.project.json', 'io', this.#reason ?? 'writer-not-owner', 'La operación de mantenimiento requiere el escritor local.', { code: 'PERMISSION_DENIED' })]);
    }
    if (this.#external) return failure([conflict('a3.project.json')]);
    const next = await this.#scan(true); this.#acceptObservation(next);
    const changed = this.#changes(this.#accepted, next);
    if (changed.length || this.#external) return failure((changed.length ? changed : ['a3.project.json']).map((path) => conflict(path)));
    const manifest = next.project.documents.find((document) => document.location.kind === 'project');
    const value = manifest?.value;
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    if (!manifest || !raw || typeof raw.projectId !== 'string' || !uuid.test(raw.projectId) || !next.project.catalogComplete || next.project.mode === 'unavailable') {
      return failure(next.project.diagnostics.length ? next.project.diagnostics : [issue('a3.project.json', 'compatibility', 'maintenance-project-unavailable', 'El manifiesto no permite identificar un proyecto restaurable o migrable.')]);
    }
    if (next.project.diagnostics.some((diagnostic) => diagnostic.detail === 'unsupported-major')) {
      return failure([issue(manifest.location.path, 'compatibility', 'unsupported-major-read-only', 'Una versión mayor desconocida bloquea cualquier reescritura del proyecto.')]);
    }
    if (manifest.status !== 'valid') {
      const version = raw.formatVersion;
      const chain = typeof version === 'string' ? migrationChain('project', version, '1.0.0', this.options.migrationSteps ?? []) : undefined;
      if (!allowRegisteredMigration || !chain?.ok) return failure([issue(manifest.location.path, 'compatibility', 'project-format-read-only', 'El formato del proyecto requiere una cadena de migración explícita.')]);
    }
    for (const document of next.project.documents) {
      if (document.status !== 'read-only' || document.location.kind === 'project' && manifest.status !== 'valid') continue;
      if (document.diagnostics.some((diagnostic) => diagnostic.detail === 'unsupported-major')) {
        return failure([issue(document.location.path, 'compatibility', 'unsupported-major-read-only', 'Una versión mayor desconocida bloquea cualquier reescritura del proyecto.')]);
      }
      const opaque = document.diagnostics.every((diagnostic) => diagnostic.detail === 'opaque-drawing');
      const sourceVersion = document.value && typeof document.value === 'object' && !Array.isArray(document.value) ? document.value.schemaVersion : undefined;
      const chain = typeof sourceVersion === 'string' ? migrationChain(document.location.kind, sourceVersion, '1.0.0', this.options.migrationSteps ?? [], document.location.path) : undefined;
      if (!opaque && (!allowRegisteredMigration || !chain?.ok)) return failure([issue(document.location.path, 'compatibility', 'document-version-read-only', 'Un documento tiene una versión no migrable; el proyecto no se reescribió.')]);
    }
    return { ok: true, value: next, diagnostics: [] };
  }
  #sourcePath(path: string): void {
    resolvePortablePath(this.root, path);
    const lower = path.toLowerCase();
    if (lower === 'a3.project.json' || lower === this.#catalog.toLowerCase() || lower.startsWith(this.#catalog.toLowerCase() + '/') || lower === '.a3' || lower.startsWith('.a3/') || lower === '.git' || lower.startsWith('.git/')) throw new PathError('managed-source-path', 'Los bytes fuente no pueden reemplazar metadatos administrados, sesiones o Git.');
  }
  async #withExtraPaths(scan: Scan, paths: readonly string[]): Promise<Scan> {
    const files = new Map(scan.files);
    for (const path of paths) if (!files.has(path)) files.set(path, await this.#observe(path, true));
    return { ...scan, files };
  }
  async #directoryObservation(path: string): Promise<DirectoryObservation> {
    const native = await checkedPath(this.root, path, 'directory');
    const directoryStat = await lstat(native, { bigint: true });
    const children = await readdir(native);
    const entries = [];
    for (const name of children.sort((a, b) => a.localeCompare(b))) {
      const info = await lstat(resolvePortablePath(this.root, `${path}/${name}`), { bigint: true });
      entries.push([name, explorerIdentity(info), info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other']);
    }
    return { path, identity: explorerIdentity(directoryStat), entriesHash: sha256(Buffer.from(JSON.stringify(entries))) };
  }
  async #verifyDirectories(expected: readonly DirectoryObservation[]): Promise<void> {
    for (const before of expected) {
      let after: DirectoryObservation;
      try { after = await this.#directoryObservation(before.path); }
      catch { throw new PathError('external-conflict', before.path); }
      if (after.identity !== before.identity || after.entriesHash !== before.entriesHash) throw new PathError('external-conflict', before.path);
    }
  }
  #makePlan(scan: Scan, operationId: string, images: Image[], nextRecords: DomainRecord[], resources: Resource[], requestHash: string, extra: Partial<PlanData> = {}): StoreResult<PreparedWrite> {
    if (!uuid.test(operationId)) return failure([issue('operation', 'schema', 'invalid-operation-id', 'operationId debe ser UUID.')]);
    const keys = images.map((i) => i.path.toLowerCase());
    if (new Set(keys).size !== keys.length) return failure([issue('operation', 'schema', 'overlapping-paths', 'La operación contiene destinos repetidos/aliases.')]);
    if (images.reduce((n, i) => n + (i.bytes?.length ?? 0), 0) > this.#transactionLimit) return failure([issue('operation', 'io', 'write-limit', 'La propuesta supera el presupuesto de escritura.')]);
    const changes = images.map((image) => ({ path: image.path, ...(image.ref ? { ref: image.ref } : {}), beforeHash: scan.files.get(image.path)?.hash ?? null,
      afterHash: image.bytes === null ? null : sha256(image.bytes), bytes: image.bytes?.length ?? 0 }));
    const requiredCapabilities: Capability[] = extra.requiredCapabilities ?? (extra.domain ? domainCapabilities(extra.domain) : ['document.edit']);
    if (extra.maintenance && images.some((image) => image.bytes === null) && !requiredCapabilities.includes('delete')) requiredCapabilities.push('delete');
    if (!this.#authorized('write', images.map((i) => i.path), changes.flatMap((c) => c.ref ? [c.ref] : []), resources, requiredCapabilities, 'prepare')) return failure([this.#denied('operation')]);
    const projectId = this.#projectId();
    if (!projectId) return failure([issue('a3.project.json', 'compatibility', 'project-id-unavailable', 'No se pudo validar la identidad del proyecto.')]);
    const requestPayload = extra.domain?.request.payload as unknown as Record<string, unknown> | undefined;
    const referencedDocument = requestPayload?.record as DomainRecord | undefined;
    const reference = requestPayload?.ref as { workspaceId?: unknown } | undefined;
    const workspaceId = typeof requestPayload?.workspaceId === 'string' ? requestPayload.workspaceId :
      typeof reference?.workspaceId === 'string' ? reference.workspaceId : referencedDocument && 'workspaceId' in referencedDocument ? referencedDocument.workspaceId : undefined;
    const canvasCommand = extra.domain && typeof workspaceId === 'string' && uuid.test(workspaceId)
      ? reversibleCanvasCommand(extra.domain, workspaceId) : undefined;
    const plan: PreparedWrite = freeze({ status: 'prepared', operationId, projectId, changes, ...(canvasCommand ? { canvasCommand } : {}),
      proposedBytes: (path: string) => { const bytes = images.find((i) => i.path === path)?.bytes; return bytes ? Uint8Array.from(bytes) : null; } });
    this.#plans.set(plan, { scan, images, nextRecords, resources, requestHash, actor: JSON.stringify(this.options.host.authenticatedActor), requiredCapabilities, ...extra });
    return { ok: true, value: plan, diagnostics: [] };
  }
  prepare(input: unknown): Promise<StoreResult<PreparedWrite>> {
    return this.#queue(async () => {
      try {
        const current = await this.#currentForWrite(); if (!current.ok) return current;
        const scan = current.value;
        const result = prepareCommand(scan.project.snapshot, input, this.#context(scan));
        if (!result.ok) return failure(domainIssues(result.diagnostics));
        const domain = result.value;
        if (domain.nodeTypeChanges.length) return failure([issue('registry', 'schema', 'registry-persistence-unavailable', 'La persistencia de paquetes/tipos requiere su módulo; no se confirma solo en memoria.')]);
        if (domain.changes.some((c) => c.before?.kind === 'workspace' && c.after === null)) return failure([issue('workspace', 'schema', 'workspace-directory-delete-unavailable', 'La eliminación de carpetas de workspace requiere el protocolo de carpetas recuperables; no se aplica parcialmente.')]);
        const images: Image[] = [];
        const documents = new Map(scan.project.documents.filter((d) => d.record).map((d) => [refKey(refOf(d.record!)), d]));
        for (const change of domain.changes) {
          const document = documents.get(refKey(change.ref));
          const path = document?.location.path ?? recordPath(change.after!, this.#catalog);
          if (!change.after) { images.push({ path, bytes: null, ref: change.ref }); continue; }
          const serialized = document ? encodeDocument(document, editsBetween(document.value!, change.after.value as JsonValue)) : serializeRecord({ kind: change.after.kind, path, ...('workspaceId' in change.after ? { workspaceId: change.after.workspaceId } : {}) }, change.after);
          if (!serialized.ok) return serialized;
          images.push({ path, bytes: Uint8Array.from(serialized.bytes), ref: change.ref });
        }
        const resources: Resource[] = [];
        for (const effect of domain.contentEffects) {
          if (effect.kind === 'create-binary') {
            const target = getRecord(domain.nextSnapshot, { kind: 'resource', id: effect.resourceId });
            if (target?.kind !== 'resource' || target.value.kind !== 'project-file' || target.value.path !== effect.path ||
                target.value.mediaType !== effect.mediaType || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(effect.bytesBase64)) {
              return failure([issue(effect.path, 'schema', 'resource-binary-create-effect-invalid', 'El efecto debe crear bytes que coincidan con el Resource local.')]);
            }
            const bytes = Buffer.from(effect.bytesBase64, 'base64');
            if (!bytes.length || bytes.length > 32 * 1024 * 1024 || bytes.toString('base64') !== effect.bytesBase64) {
              return failure([issue(effect.path, 'schema', 'resource-binary-create-effect-invalid', 'Los bytes locales están vacíos, son demasiado grandes o no usan base64 canónico.')]);
            }
            this.#sourcePath(effect.path);
            try { await absentPath(this.root, effect.path); }
            catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
            images.push({ path: effect.path, bytes: Uint8Array.from(bytes), ref: refOf(target) });
            resources.push(target.value);
            continue;
          }
          if (effect.kind === 'create') {
            const target = getRecord(domain.nextSnapshot, { kind: 'resource', id: effect.resourceId });
            if (target?.kind !== 'resource' || target.value.kind !== 'project-file' || target.value.path !== effect.path || typeof effect.content !== 'string') {
              return failure([issue(effect.path, 'schema', 'resource-create-effect-invalid', 'El efecto debe crear un recurso local que coincida con su descriptor.')]);
            }
            this.#sourcePath(effect.path);
            try { await absentPath(this.root, effect.path); }
            catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
            images.push({ path: effect.path, bytes: Buffer.from(effect.content, 'utf8'), ref: refOf(target) });
            resources.push(target.value);
            continue;
          }
          if (effect.kind === 'remove') {
            const source = getRecord(scan.project.snapshot, { kind: 'resource', id: effect.resourceId });
            const target = getRecord(domain.nextSnapshot, { kind: 'resource', id: effect.resourceId });
            if (source?.kind !== 'resource' || source.value.kind !== 'project-file' || source.value.path !== effect.path || target) {
              return failure([issue(effect.path, 'schema', 'resource-remove-effect-invalid', 'El efecto debe retirar el archivo de un recurso local que deja de existir.')]);
            }
            this.#sourcePath(effect.path);
            const bytes = await readProjectResource(this.root, source.value, this.#resourceLimit);
            if (!bytes.ok) return bytes;
            if (bytes.value.sha256 !== effect.expectedHash) return failure([conflict(source.value.path, 'history-content-conflict')]);
            images.push({ path: effect.path, bytes: null, ref: refOf(source) });
            resources.push(source.value);
            continue;
          }
          const sourceId = effect.kind === 'copy' ? effect.sourceId : effect.resourceId;
          const source = getRecord(scan.project.snapshot, { kind: 'resource', id: sourceId });
          const target = getRecord(domain.nextSnapshot, { kind: 'resource', id: effect.kind === 'copy' ? effect.targetId : effect.resourceId });
          if (source?.kind !== 'resource' || source.value.kind !== 'project-file' || target?.kind !== 'resource' || target.value.kind !== 'project-file') return failure([issue('resource', 'io', 'external-write-unavailable', 'Montajes/URLs no tienen writer de bytes en C2.', { code: 'PERMISSION_DENIED' })]);
          this.#sourcePath(source.value.path); this.#sourcePath(target.value.path);
          const bytes = await readProjectResource(this.root, source.value, this.#resourceLimit);
          if (!bytes.ok) return bytes;
          if (bytes.value.sha256 !== effect.expectedHash) return failure([conflict(source.value.path)]);
          // Copies/moves must never overwrite an existing unrelated file, even outside the catalog.
          await absentPath(this.root, target.value.path).catch((error) => { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return; throw error; });
          images.push({ path: target.value.path, bytes: Uint8Array.from(bytes.value.bytes), ref: refOf(target) });
          if (effect.kind === 'move') images.push({ path: source.value.path, bytes: null, ref: refOf(source) });
          resources.push(source.value, target.value);
        }
        let nextRecords = domain.nextSnapshot.records;
        if (this.#navigationChanged(scan.project.snapshot.records, nextRecords)) {
          // Preserve the sealed pure-domain plan for revalidation. The host appends
          // derived reference edits to the SAME journal/optimistic read set.
          const augmented = structuredClone(nextRecords) as DomainRecord[];
          await this.#rewriteNavigation(scan, augmented, images);
          const descriptors = this.#resourceDocumentImages(scan.project.snapshot.records, augmented, scan.project.documents);
          if ('detail' in descriptors) return failure([descriptors]);
          for (const image of descriptors.images) { const at = images.findIndex((i) => i.path === image.path); if (at >= 0) images[at] = image; else images.push(image); }
          const invalid = validateSnapshot({ records: augmented }, this.#registry); if (invalid.some((d) => d.severity === 'error')) return failure(domainIssues(invalid));
          nextRecords = augmented;
          for (const record of augmented) if (record.kind === 'resource' && images.some((image) => image.ref?.id === record.value.id) && !resources.some((r) => r.id === record.value.id)) resources.push(record.value);
        }
        return this.#makePlan(scan, domain.operationId, images, nextRecords, resources,
          sha256(Buffer.from(domain.requestFingerprint)), { domain });
      } catch (error) { return failure([this.#operationError('operation', error)]); }
    });
  }
  /** Rebind a missing local source after an explicit native file selection. Never moves or replaces source bytes. */
  prepareResourceRelocation(input: { operationId: string; resourceId: string; expectedRevision: number; path: string }): Promise<StoreResult<PreparedWrite>> {
    return this.#queue(async () => {
      try {
        const current = await this.#currentForMaintenance(); if (!current.ok) return current;
        const scan = current.value, records = scan.project.snapshot.records;
        const resource = records.find((r) => r.kind === 'resource' && r.value.id === input.resourceId);
        if (!uuid.test(input.operationId) || resource?.kind !== 'resource' || resource.value.kind !== 'project-file') return failure([issue('resource', 'schema', 'local-resource-required', 'Localizar requiere un recurso interno existente.')]);
        if (resource.value.revision !== input.expectedRevision) return failure([conflict('resource', 'resource-revision-changed')]);
        this.#sourcePath(input.path);
        if (await this.#isHiddenExplorerPath(input.path, false, await this.#ignoreRulesFor(input.path.split('/').slice(0, -1).join('/')))) throw new PathError('hidden-path', 'La selección está oculta o excluida.');
        if (!this.#authorized('read-resource', [input.path], [refOf(resource)], [resource.value])) return failure([this.#denied(input.path)]);
        const previous = await this.#observe(resource.value.path, true);
        if (previous.hash !== null || previous.problem) return failure([conflict(resource.value.path, 'source-not-missing')]);
        const selected = await this.#observe(input.path, true);
        if (!selected.hash || selected.problem || !input.path.toLowerCase().endsWith('.md')) throw new PathError('markdown-required', 'Selecciona un archivo Markdown UTF-8 disponible dentro de este proyecto.');
        new TextDecoder('utf-8', { fatal: true }).decode(await fileBytes(this.root, input.path, 2 * 1024 * 1024));
        if (records.some((r) => r.kind === 'resource' && r.value.kind === 'project-file' && r.value.path.toLowerCase() === input.path.toLowerCase() && r.value.id !== input.resourceId)) return failure([conflict(input.path, 'resource-path-in-use')]);
        const next = structuredClone(records) as DomainRecord[], replacement = next.find((r) => r.kind === 'resource' && r.value.id === input.resourceId)!;
        if (replacement.kind !== 'resource' || replacement.value.kind !== 'project-file') throw new Error('resource');
        replacement.value.path = input.path; replacement.value.revision++;
        const invalid = validateSnapshot({ records: next }, this.#registry).filter((d) => d.severity === 'error');
        if (invalid.length) return failure(domainIssues(invalid));
        const encoded = this.#resourceDocumentImages(records, next, scan.project.documents);
        if ('detail' in encoded) return failure([encoded]);
        const guarded = { ...scan, files: new Map(scan.files) }; guarded.files.set(input.path, selected);
        return this.#makePlan(guarded, input.operationId, encoded.images, next, [resource.value, replacement.value],
          sha256(jsonBytes({ action: 'relocate-missing-resource', ...input, selectedHash: selected.hash })), { maintenance: true, requiredCapabilities: ['document.edit'], externalPaths: [input.path] });
      } catch (error) { return failure([this.#operationError(input.path, error)]); }
    });
  }
  prepareResourceWrite(input: ResourceWriteRequest): Promise<StoreResult<PreparedWrite>> {
    // Capture caller bytes immediately, before an asynchronous queue boundary.
    const request = { ...input, bytes: Uint8Array.from(input.bytes) };
    return this.#queue(async () => {
      try {
        const current = await this.#currentForWrite(); if (!current.ok) return current;
        const scan = current.value;
        const record = getRecord(scan.project.snapshot, { kind: 'resource', id: request.resourceId });
        if (record?.kind !== 'resource' || record.value.kind !== 'project-file') return failure([issue('resource', 'references', 'local-resource-required', 'Se requiere Resource project-file válido.')]);
        this.#sourcePath(record.value.path);
        const document = scan.project.documents.find((d) => d.record === record)!;
        if (record.value.revision !== request.expectedRevision || scan.files.get(record.value.path)?.hash !== request.expectedHash) return failure([conflict(record.value.path, 'resource-precondition-conflict')]);
        const changed = sha256(request.bytes) !== request.expectedHash;
        const images: Image[] = [];
        let after = record;
        if (changed) {
          const encoded = encodeDocument(document, [{ op: 'set', pointer: '/revision', value: record.value.revision + 1 }]);
          if (!encoded.ok) return encoded;
          after = encoded.record as typeof record;
          images.push({ path: document.location.path, bytes: Uint8Array.from(encoded.bytes), ref: refOf(record) }, { path: record.value.path, bytes: request.bytes, ref: refOf(record) });
        }
        const nextRecords = scan.project.snapshot.records.map((r) => r === record ? after : r);
        const requestHash = sha256(jsonBytes({ resourceId: request.resourceId, expectedRevision: request.expectedRevision, expectedHash: request.expectedHash, afterHash: sha256(request.bytes), actor: this.options.host.authenticatedActor }));
        return this.#makePlan(scan, request.operationId, images, nextRecords, [record.value], requestHash, { resourceWrite: request });
      } catch (error) { return failure([this.#operationError('resource', error)]); }
    });
  }
  listSnapshots(): ReturnType<typeof listSnapshots> {
    if (!this.#authorized('read-resource', [])) return Promise.resolve(failure([this.#denied('snapshot')]));
    return listSnapshots(this.root, this.#projectId());
  }
  createSnapshot(operationId: string, reason: SnapshotReason, paths?: readonly string[]): Promise<StoreResult<SnapshotReceipt>> {
    return this.#queue(async () => {
      const current = await this.#currentForMaintenance(reason === 'migration');
      if (!current.ok) return failure(current.diagnostics);
      const projectId = this.#projectId();
      if (!projectId || !uuid.test(operationId)) return failure([issue('snapshot', 'schema', 'snapshot-request-invalid', 'Se requiere projectId y operationId UUID.')]);
      const selected = paths ? [...paths] : [...current.value.files.keys()];
      if (new Set(selected.map((path) => path.toLowerCase())).size !== selected.length) return failure([issue('snapshot', 'schema', 'snapshot-path-duplicate', 'La solicitud repite rutas.')]);
      const decision = await this.options.host.capabilities.authorizeCapabilities(this.root, this.options.host.authenticatedActor, projectId,
        ['document.edit'], `snapshot.create:${operationId}`, 'apply');
      if (!decision.allowed) return failure([this.#denied('snapshot', decision)]);
      const result = await createSnapshot(this.root, { snapshotId: randomUUID(), projectId, operationId, reason,
        files: selected.map((path) => ({ path, expectedHash: current.value.files.get(path)?.hash ?? null,
          expectedIdentity: current.value.files.get(path)?.identity ?? null })), retentionDays: this.#snapshotRetentionDays, maxBytes: this.#snapshotMaxBytes });
      if (!result.ok) return failure(result.diagnostics);
      return { ok: true, value: { ...result.value, status: 'created' }, diagnostics: result.diagnostics };
    });
  }
  restoreSnapshot(snapshotId: string, operationId: string): Promise<StoreResult<WriteReceipt>> {
    return this.#queue(async () => {
      try {
        const current = await this.#currentForMaintenance(); if (!current.ok) return current;
        const projectId = this.#projectId();
        if (!projectId || !uuid.test(operationId)) return failure([issue('snapshot', 'schema', 'restore-request-invalid', 'Se requiere projectId y operationId UUID.')]);
        if (!this.#authorized('read-resource', [])) return failure([this.#denied('snapshot')]);
        const saved = await readSnapshot(this.root, snapshotId, projectId); if (!saved.ok) return failure(saved.diagnostics);
        const images: Image[] = [];
        const nextRecords = new Map(current.value.project.snapshot.records.map((record) => [refKey(refOf(record)), record]));
        const documentByPath = new Map(current.value.project.documents.map((document) => [document.location.path, document]));
        for (const file of saved.value.files) {
          const currentDocument = documentByPath.get(file.path);
          if (file.bytes === null) {
            images.push({ path: file.path, bytes: null, ...(currentDocument?.record ? { ref: refOf(currentDocument.record) } : {}) });
            if (currentDocument?.record) nextRecords.delete(refKey(refOf(currentDocument.record)));
            continue;
          }
          let bytes = Uint8Array.from(file.bytes);
          let restoredRecord: DomainRecord | undefined;
          const location = currentDocument?.location ?? locationForPath(file.path, this.#catalog, projectId);
          if (location) {
            if (location.kind === 'drawing') {
              if (current.value.files.get(file.path)?.hash === file.sha256) continue;
              return failure([issue(file.path, 'compatibility', 'opaque-drawing-restore-unavailable', 'El dibujo opaco se conserva sin reescritura automática.')]);
            }
            const decoded = decodeDocument(location, bytes);
            if (decoded.status !== 'valid' || !decoded.record || !decoded.value || !object(decoded.value) || typeof decoded.value.revision !== 'number') {
              return failure(decoded.diagnostics.length ? decoded.diagnostics : [issue(file.path, 'schema', 'snapshot-document-invalid', 'El documento guardado no pasa el esquema actual.')]);
            }
            const currentValue = currentDocument?.value;
            const oldRevision = currentDocument?.record?.value.revision ?? (currentValue && object(currentValue) && typeof currentValue.revision === 'number' ? currentValue.revision : decoded.value.revision);
            const revision = Math.max(oldRevision, decoded.value.revision) + 1;
            if (!Number.isSafeInteger(revision)) return failure([issue(file.path, 'schema', 'revision-exhausted', 'No se puede asignar una revisión nueva al restaurar.')]);
            bytes = Buffer.from(canonicalJson({ ...decoded.value, revision }) + '\n');
            const validated = decodeDocument(location, bytes);
            if (validated.status !== 'valid' || !validated.record) return failure(validated.diagnostics);
            restoredRecord = validated.record;
            nextRecords.delete(refKey(refOf(restoredRecord)));
            nextRecords.set(refKey(refOf(restoredRecord)), restoredRecord);
          }
          images.push({ path: file.path, bytes, ...(restoredRecord ? { ref: refOf(restoredRecord) } : currentDocument?.record ? { ref: refOf(currentDocument.record) } : {}) });
        }
        const changedImages = images.filter((image) => {
          const before = current.value.files.get(image.path)?.hash ?? null;
          const after = image.bytes === null ? null : sha256(image.bytes);
          return before !== after;
        });
        const records = [...nextRecords.values()];
        const domainDiagnostics = validateSnapshot({ records }, this.#registry).filter((diagnostic) => diagnostic.severity === 'error');
        if (domainDiagnostics.length) return failure(domainIssues(domainDiagnostics));
        const requestEnvelope = { operationId, snapshotId, projectId, actor: { kind: this.options.host.authenticatedActor.kind, id: this.options.host.authenticatedActor.id },
          files: changedImages.map((image) => ({ path: image.path, hash: image.bytes === null ? null : sha256(image.bytes) })) } as unknown as JsonValue;
        const requestHash = sha256(Buffer.from(canonicalJson(requestEnvelope)));
        const prepared = this.#makePlan(current.value, operationId, changedImages, records, [], requestHash, { maintenance: true, snapshotReason: 'restore' });
        if (!prepared.ok) return prepared;
        return await this.#commit(prepared.value, this.#plans.get(prepared.value)!);
      } catch (error) { return failure([this.#operationError('snapshot', error)]); }
    });
  }
  migrateProject(operationId: string): Promise<StoreResult<MigrationReceipt>> {
    return this.#queue(async () => {
      try {
        if (!uuid.test(operationId)) return failure([issue('migration', 'schema', 'migration-id-invalid', 'operationId debe ser UUID.')]);
        const steps = this.options.migrationSteps ?? [];
        if (!steps.length) return failure([issue('a3.project.json', 'compatibility', 'migration-registry-empty', 'No hay pasos de migración de confianza registrados en esta aplicación.')]);
        const current = await this.#currentForMaintenance(true); if (!current.ok) return current;
        const projectId = this.#projectId();
        if (!projectId) return failure([issue('a3.project.json', 'compatibility', 'project-id-unavailable', 'No se pudo identificar el proyecto.')]);
        const authorization = await this.options.host.capabilities.authorizeCapabilities(this.root, this.options.host.authenticatedActor, projectId,
          ['document.edit'], `project.maintenance:${operationId}`, 'apply');
        if (!authorization.allowed) return failure([this.#denied('migration', authorization)]);
        const saved = await loadPreparedMigration(this.root, operationId);
        if (!saved.ok) return failure([saved.diagnostic]);
        let preparedMigration = saved.value;
        let resumed = !!preparedMigration;
        if (preparedMigration && preparedMigration.projectId !== projectId) return failure([issue('migration', 'io', 'migration-project-mismatch', 'La migración preparada pertenece a otro proyecto.')]);
        let outputs: readonly { path: string; beforeHash: string | null; beforeIdentity: string | null; afterHash: string; bytes: Uint8Array }[];
        let recordedSteps: readonly { id: string; scope: MigrationScope; fromVersion: string; toVersion: string }[];
        if (preparedMigration) {
          outputs = preparedMigration.outputs; recordedSteps = preparedMigration.steps;
        } else {
          const candidates = current.value.project.documents.filter((document) => document.status === 'read-only' &&
            document.diagnostics.some((diagnostic) => diagnostic.detail === 'unsupported-version'));
          if (!candidates.length) return failure([issue('a3.project.json', 'compatibility', 'migration-not-needed', 'No hay documentos en una versión anterior registrada que requieran migración.')]);
          const out: { path: string; beforeHash: string | null; beforeIdentity: string | null; afterHash: string; bytes: Uint8Array }[] = [];
          const stepRecords: { id: string; scope: MigrationScope; fromVersion: string; toVersion: string }[] = [];
          const nextRecords = new Map(current.value.project.snapshot.records.map((record) => [refKey(refOf(record)), record]));
          for (const document of candidates.sort((a, b) => a.location.path.localeCompare(b.location.path))) {
            const source = document.value;
            const scope = document.location.kind === 'project' ? 'project' : document.location.kind;
            const versionField = scope === 'project' ? 'formatVersion' : 'schemaVersion';
            const fromVersion = source && typeof source === 'object' && !Array.isArray(source) ? source[versionField] : undefined;
            if (!source || typeof source !== 'object' || Array.isArray(source) || typeof fromVersion !== 'string') return failure([issue(document.location.path, 'compatibility', 'migration-source-version-missing', 'El documento no declara una versión migrable.')]);
            const chain = migrationChain(scope, fromVersion, '1.0.0', steps, document.location.path);
            if (!chain.ok) return failure(chain.diagnostics);
            const migrated = applyMigrationChain(scope, document.location.path, source, fromVersion, versionField, steps);
            if (!migrated.ok) return failure(migrated.diagnostics);
            const bytes = Buffer.from(canonicalJson(migrated.value) + '\n');
            const decoded = decodeDocument(document.location, bytes);
            if (decoded.status !== 'valid' || !decoded.record) return failure(decoded.diagnostics.length ? decoded.diagnostics : [issue(document.location.path, 'compatibility', 'migration-output-invalid', 'La salida no es aceptada por el esquema activo.')]);
            out.push({ path: document.location.path, beforeHash: current.value.files.get(document.location.path)?.hash ?? document.sha256,
              beforeIdentity: current.value.files.get(document.location.path)?.identity ?? null,
              afterHash: sha256(bytes), bytes });
            const oldRef = document.record ? refKey(refOf(document.record)) : undefined;
            if (oldRef) nextRecords.delete(oldRef);
            nextRecords.set(refKey(refOf(decoded.record)), decoded.record);
            stepRecords.push(...chain.value.map((step) => ({ id: step.id, scope: step.scope, fromVersion: step.fromVersion, toVersion: step.toVersion })));
          }
          const referenceErrors = validateSnapshot({ records: [...nextRecords.values()] }, this.#registry).filter((diagnostic) => diagnostic.severity === 'error');
          if (referenceErrors.length) return failure(domainIssues(referenceErrors));
          const snapshot = await createSnapshot(this.root, { snapshotId: operationId, projectId, operationId, reason: 'migration',
            files: out.map((file) => ({ path: file.path, expectedHash: file.beforeHash, expectedIdentity: current.value.files.get(file.path)?.identity ?? null })),
            retentionDays: this.#snapshotRetentionDays, maxBytes: this.#snapshotMaxBytes });
          if (!snapshot.ok) return failure(snapshot.diagnostics);
          const durable = await prepareMigration(this.root, { operationId, projectId, steps: stepRecords, outputs: out });
          if (!durable.ok) return failure([durable.diagnostic]);
          preparedMigration = durable.value; outputs = preparedMigration.outputs; recordedSteps = preparedMigration.steps;
          await this.#fault('migration-after-stage', operationId);
          // Keep the exact output records for the plan below; on retry they are reconstructed from staged bytes.
        }
        if (!preparedMigration) return failure([issue('migration', 'io', 'migration-stage-missing', 'No se pudo preparar la salida inmutable.')]);
        const scan = current.value;
        const targetStates = outputs.map((file) => scan.files.get(file.path) ?? missing);
        const allAfter = targetStates.every((state, index) => state.hash === outputs[index]!.afterHash);
        if (preparedMigration.completed) {
          const identities = new Map(preparedMigration.completedIdentities?.map((entry) => [entry.path, entry.identity]) ?? []);
          if (!allAfter || targetStates.some((state, index) => state.identity !== identities.get(outputs[index]!.path))) return failure(outputs.map((file) => conflict(file.path, 'migration-completed-state-changed')));
          return { ok: true, value: this.#migrationReceipt(preparedMigration, null, true), diagnostics: [] };
        }
        if (allAfter) {
          const identities = await verifyAppliedMigration(this.root, preparedMigration);
          if (!identities) return failure(outputs.map((file) => conflict(file.path, 'migration-apply-not-proven')));
          const done = await completeMigration(this.root, preparedMigration, identities);
          return { ok: true, value: this.#migrationReceipt(preparedMigration, null, true), diagnostics: done ? [done] : [] };
        }
        if (!targetStates.every((state, index) => state.hash === outputs[index]!.beforeHash && state.identity === outputs[index]!.beforeIdentity)) {
          return failure(outputs.map((file) => conflict(file.path, 'migration-source-changed')));
        }
        await this.#fault('migration-before-apply', operationId);
        const nextRecords = new Map(scan.project.snapshot.records.map((record) => [refKey(refOf(record)), record]));
        const images: Image[] = [];
        for (const output of outputs) {
          const document = scan.project.documents.find((candidate) => candidate.location.path === output.path);
          if (!document) return failure([issue(output.path, 'compatibility', 'migration-document-missing', 'El documento preparado ya no pertenece al catálogo actual.')]);
          const decoded = decodeDocument(document.location, output.bytes);
          if (decoded.status !== 'valid' || !decoded.record) return failure(decoded.diagnostics);
          if (document.record) nextRecords.delete(refKey(refOf(document.record)));
          nextRecords.set(refKey(refOf(decoded.record)), decoded.record);
          images.push({ path: output.path, bytes: Uint8Array.from(output.bytes), ref: refOf(decoded.record) });
        }
        const referenceErrors = validateSnapshot({ records: [...nextRecords.values()] }, this.#registry).filter((diagnostic) => diagnostic.severity === 'error');
        if (referenceErrors.length) return failure(domainIssues(referenceErrors));
        const transactionOperationId = randomUUID();
        const requestHash = sha256(Buffer.from(canonicalJson({ operationId, projectId, files: outputs.map((file) => ({ path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash })),
          steps: recordedSteps.map((step) => ({ ...step })) } as unknown as JsonValue)));
        const prepared = this.#makePlan(scan, transactionOperationId, images, [...nextRecords.values()], [], requestHash,
          { maintenance: true, preapproved: true, allowRegisteredMigration: true, snapshotId: operationId, snapshotOperationId: operationId, snapshotReason: 'migration' });
        if (!prepared.ok) return prepared;
        const applied = await this.#commit(prepared.value, this.#plans.get(prepared.value)!);
        if (!applied.ok) return applied;
        await this.#fault('migration-after-apply', operationId);
        const identities = preparedMigration.files.map((file) => ({ path: file.path, identity: this.#accepted.files.get(file.path)?.identity ?? '' }));
        const done = await completeMigration(this.root, preparedMigration, identities);
        const receipt = this.#migrationReceipt(preparedMigration, transactionOperationId, resumed);
        return { ok: true, value: receipt, diagnostics: [...applied.diagnostics, ...(done ? [done] : [])] };
      } catch (error) { return failure([this.#operationError('migration', error)]); }
    });
  }
  #migrationReceipt(migration: LoadedMigration,
    transactionOperationId: string | null, resumed: boolean): MigrationReceipt {
    return { status: 'migrated', operationId: migration.operationId, projectId: migration.projectId,
      sourceVersions: [...new Set(migration.steps.map((step) => step.fromVersion))].sort(), targetVersion: '1.0.0',
      paths: migration.files.map((file) => file.path), snapshotId: migration.operationId, transactionOperationId, resumed };
  }
  async #fault(phase: FaultPhase, operationId: string, index?: number, path?: string): Promise<void> {
    await this.options.fault?.(phase, { operationId, ...(index !== undefined ? { index } : {}), ...(path ? { path } : {}) });
  }
  commit(plan: PreparedWrite): Promise<StoreResult<WriteReceipt>> {
    return this.#queue(async () => {
      const data = this.#plans.get(plan);
      if (!data) return failure([issue('operation', 'schema', 'unknown-plan', 'La propuesta no fue preparada por este servicio.')]);
      if (data.outcome) return data.outcome;
      const outcome = freeze(await this.#commit(plan, data)); data.outcome = outcome; return outcome;
    });
  }
  async #commit(plan: PreparedWrite, data: PlanData): Promise<StoreResult<WriteReceipt>> {
    let transactionPath: string | undefined;
    let log: ProgressLog | undefined;
    let activePath = 'a3.project.json';
    let snapshotId: string | undefined;
    let snapshotDiagnostics: readonly StoreDiagnostic[] = [];
    try {
      const current = data.maintenance ? await this.#currentForMaintenance(data.allowRegisteredMigration) : await this.#currentForWrite();
      if (!current.ok) return current;
      if (data.actor !== JSON.stringify(this.options.host.authenticatedActor)) return failure([this.#denied('operation')]);
      const currentObserved = await this.#withExtraPaths(current.value, data.externalPaths ?? []);
      const changed = this.#changes(data.scan, currentObserved);
      if (changed.length) return failure(changed.map((p) => conflict(p, 'stale-plan')));
      await this.#verifyDirectories(data.externalDirectories ?? []);
      if (data.domain) { const valid = revalidatePlan(data.domain, current.value.project.snapshot, this.#context(current.value)); if (!valid.ok) return failure(domainIssues(valid.diagnostics)); }
      const applyDecision = data.preapproved
        ? await this.options.host.capabilities.authorizeCapabilities(this.root, this.options.host.authenticatedActor, plan.projectId,
          data.requiredCapabilities, `${data.maintenance ? 'project.maintenance' : 'resource.write'}:${data.snapshotOperationId ?? plan.operationId}`, 'prepare')
        : data.domain
        ? await this.options.host.capabilities.authorizeApply(this.root, this.options.host.authenticatedActor, {
          actor: this.options.host.authenticatedActor, projectId: data.domain.projectId, operationId: data.domain.operationId, command: data.domain.request.command,
          entityIds: data.domain.request.scope.entityIds, refs: data.domain.changes.map((change) => change.ref),
          contentEffects: data.domain.contentEffects, registryWrite: data.domain.nodeTypeChanges.length > 0,
          changes: data.domain.changes, nodeTypeChanges: data.domain.nodeTypeChanges
        })
        : await this.options.host.capabilities.authorizeCapabilities(this.root, this.options.host.authenticatedActor, plan.projectId,
          data.requiredCapabilities, `${data.maintenance ? 'project.maintenance' : 'resource.write'}:${data.snapshotOperationId ?? plan.operationId}`, 'apply');
      if (!applyDecision.allowed) return failure([this.#denied('operation', applyDecision)]);
      if (!this.#authorized('write', data.images.map((i) => i.path), plan.changes.flatMap((c) => c.ref ? [c.ref] : []), data.resources, data.requiredCapabilities, 'prepare')) return failure([this.#denied('operation')]);
      if (data.mountSource) {
        const sourceProblem = await this.#verifyMountSource(data.mountSource);
        if (sourceProblem) return failure([sourceProblem]);
      }
      if (!data.images.length) return { ok: true, value: { status: 'committed', operationId: plan.operationId, atomic: false, paths: [], transactionPath: null }, diagnostics: [] };
      snapshotId = data.snapshotId ?? plan.operationId;
      const snapshotChanges = plan.changes.filter((change) => !change.path.toLowerCase().startsWith('.a3/local/'));
      const snapshot = await createSnapshot(this.root, { snapshotId, projectId: plan.projectId, operationId: data.snapshotOperationId ?? plan.operationId,
        reason: data.snapshotReason ?? 'batch', files: snapshotChanges.map((change) => ({ path: change.path, expectedHash: change.beforeHash,
          expectedIdentity: data.scan.files.get(change.path)?.identity ?? null })), retentionDays: this.#snapshotRetentionDays, maxBytes: this.#snapshotMaxBytes });
      if (!snapshot.ok) return failure(snapshot.diagnostics);
      snapshotDiagnostics = snapshot.diagnostics;
      const transactions = transactionRoot;
      await ensureDirectories(this.root, transactions);
      const folder = `${transactions}/${plan.operationId}`;
      // Never reuse an operation directory, including one left by a dead process.
      await mkdir(await absentPath(this.root, folder));
      transactionPath = folder;
      const entries: IntentEntry[] = plan.changes.map((c, index) => {
        const before = c.ref ? data.scan.project.snapshot.records.find((record) => refKey(refOf(record)) === refKey(c.ref!)) : undefined;
        const after = c.ref ? data.nextRecords.find((record) => refKey(refOf(record)) === refKey(c.ref!)) : undefined;
        return { ...c, backupPath: `${folder}/${index}.before`, stagedPath: `${folder}/${index}.staged`, candidatePath: `${folder}/${index}.candidate`, detachedPath: `${folder}/${index}.detached`,
          revisionBefore: before?.value.revision ?? null, revisionAfter: after?.value.revision ?? null };
      });
      const createdWorkspaceDirectories: string[] = [];
      for (const entry of entries) if (entry.ref?.kind === 'workspace' && entry.beforeHash === null) {
        const parent = entry.path.slice(0, entry.path.lastIndexOf('/'));
        try { await checkedPath(this.root, parent, 'directory'); }
        catch (error) { if (errorCode(error) !== 'ENOENT') throw error; createdWorkspaceDirectories.push(parent); }
      }
      const intent: WriteIntent = { schemaVersion: '1.0.0', protocol: progressProtocol, operationId: plan.operationId, projectId: plan.projectId,
        actor: { kind: this.options.host.authenticatedActor.kind, id: this.options.host.authenticatedActor.id }, requestHash: data.requestHash,
        requiredCapabilities: [...data.requiredCapabilities], readSet: [...data.scan.files].map(([path, value]) => ({ path, hash: value.hash, identity: value.identity })), entries,
        extensions: createdWorkspaceDirectories.length ? { 'a3.store.created-workspace-directories': createdWorkspaceDirectories } : {} };
      log = new ProgressLog(this.root, folder); await log.intent(intent);
      await this.#fault('after-intent', plan.operationId);
      for (const image of data.images) {
        resolvePortablePath(this.root, image.path);
        const parent = image.path.includes('/') ? image.path.slice(0, image.path.lastIndexOf('/')) : undefined;
        if (parent) await ensureDirectories(this.root, parent);
      }
      for (const [index, entry] of entries.entries()) {
        activePath = entry.path;
        if (entry.beforeHash !== null) {
          const before = await fileBytes(this.root, entry.path, this.#resourceLimit);
          if (sha256(before) !== entry.beforeHash) throw new PathError('external-conflict', entry.path);
          await writeExclusive(this.root, entry.backupPath, before);
        } else await absentPath(this.root, entry.path);
        if (data.images[index]!.bytes !== null) {
          await writeExclusive(this.root, entry.stagedPath, data.images[index]!.bytes!);
          await writeExclusive(this.root, entry.candidatePath, data.images[index]!.bytes!);
          const probe = `${folder}/${index}.probe`;
          await installExclusive(this.root, entry.candidatePath, probe);
          await unlink(await checkedPath(this.root, probe, 'file'));
          const destinationParent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : undefined;
          const nativeParent = destinationParent ? await checkedPath(this.root, destinationParent, 'directory') : this.root;
          if ((await stat(nativeParent, { bigint: true })).dev !== (await stat(this.root, { bigint: true })).dev) throw new PathError('different-volume', entry.path);
        }
        await log.append('staged', { index });
      }
      await this.#fault('after-staging', plan.operationId);
      // Recheck all catalog/source dependencies after staging and before any target mutation.
      const beforeReplace = await this.#withExtraPaths(await this.#scan(true), data.externalPaths ?? []);
      await this.#verifyDirectories(data.externalDirectories ?? []);
      const drift = this.#changes(data.scan, beforeReplace);
      // Creating the destination parent exposes an empty workspace directory during staging.
      // Ignore ONLY the absent manifest this plan will create; bytes/errors elsewhere still conflict.
      const pendingWorkspaceManifests = new Set(entries.filter((entry) => entry.ref?.kind === 'workspace' && entry.beforeHash === null).map((entry) => entry.path));
      const stagingDiagnostics = beforeReplace.diagnostics.filter((d) => !(d.stage === 'io' && d.detail === 'file-missing' && pendingWorkspaceManifests.has(d.path)));
      const newErrors = introducesErrors(data.scan.diagnostics, stagingDiagnostics);
      if (drift.length || newErrors || !data.maintenance && stagingDiagnostics.some((d) => d.severity === 'error')) {
        throw new PathError('external-conflict', drift[0] ?? 'a3.project.json');
      }
      for (const [index, entry] of entries.entries()) {
        activePath = entry.path;
        if (!this.#ownership?.alive() || !this.#authorized('write', [entry.path], entry.ref ? [entry.ref] : [], data.resources, data.requiredCapabilities, 'prepare')) throw new PathError('permission-denied', entry.path);
        if (entry.beforeHash !== null) {
          await log.append('detach-start', { index });
          await this.#fault('before-detach', plan.operationId, index, entry.path);
          const observed = await this.#observe(entry.path, true);
          if (!imageEqual(observed, data.scan.files.get(entry.path) ?? missing)) throw new PathError('external-conflict', entry.path);
          await rename(await checkedPath(this.root, entry.path, 'file'), await absentPath(this.root, entry.detachedPath));
          await log.append('detached', { index }); this.#own.set(entry.path, missing);
          await this.#fault('after-detach', plan.operationId, index, entry.path);
          if (sha256(await fileBytes(this.root, entry.detachedPath, this.#resourceLimit)) !== entry.beforeHash) {
            // Narrow compensation only: restore the captured object IF the original name is free.
            try { await installExclusive(this.root, entry.detachedPath, entry.path); await log.append('restored-link', { index }); } catch { /* Never overwrite an externally recreated path. */ }
            throw new PathError('external-conflict', entry.path);
          }
        }
        if (entry.afterHash !== null) {
          await this.#fault('before-install', plan.operationId, index, entry.path);
          await log.append('install-start', { index });
          // Candidate is disposable; immutable staged bytes remain a separate file.
          if (sha256(await fileBytes(this.root, entry.candidatePath, this.#resourceLimit)) !== entry.afterHash) throw new PathError('candidate-changed', entry.path);
          await installExclusive(this.root, entry.candidatePath, entry.path);
          this.#own.set(entry.path, await this.#observe(entry.path, true));
          await log.append('installed', { index });
          await this.#fault('after-install', plan.operationId, index, entry.path);
        }
        const actual = await this.#observe(entry.path, true);
        if (actual.hash !== entry.afterHash || actual.problem) throw new PathError('external-conflict', entry.path);
      }
      await this.#fault('before-commit', plan.operationId);
      if (!this.#ownership?.alive() || !this.#authorized('write', data.images.map((i) => i.path), plan.changes.flatMap((c) => c.ref ? [c.ref] : []), data.resources, data.requiredCapabilities, 'prepare')) throw new PathError('permission-denied', 'operation');
      for (const entry of entries) {
        if (entry.beforeHash !== null && sha256(await fileBytes(this.root, entry.backupPath, this.#resourceLimit)) !== entry.beforeHash) throw new PathError('backup-changed', entry.path);
        if (entry.beforeHash !== null && sha256(await fileBytes(this.root, entry.detachedPath, this.#resourceLimit)) !== entry.beforeHash) throw new PathError('external-conflict', entry.path);
        if (entry.afterHash !== null && sha256(await fileBytes(this.root, entry.stagedPath, this.#resourceLimit)) !== entry.afterHash) throw new PathError('staging-changed', entry.path);
      }
      const final = await this.#scan(true);
      const expected = new Map(data.scan.files);
      for (const entry of entries) if (entry.afterHash === null) expected.delete(entry.path); else expected.set(entry.path, this.#own.get(entry.path)!);
      const finalObserved = await this.#withExtraPaths(final, data.externalPaths ?? []);
      const mismatches = this.#changes({ ...data.scan, files: expected }, finalObserved);
      if (mismatches.length || !final.project.catalogComplete || final.project.mode === 'unavailable' ||
          !data.maintenance && (final.project.mode !== 'ready' || final.diagnostics.some((d) => d.severity === 'error')) ||
          data.maintenance && introducesErrors(data.scan.diagnostics, final.diagnostics)) throw new PathError('external-conflict', mismatches[0] ?? 'a3.project.json');
      if (data.maintenance) {
        for (const image of data.images) {
          if (image.bytes === null) continue;
          const document = final.project.documents.find((candidate) => candidate.location.path === image.path);
          if (document && (document.sha256 !== sha256(image.bytes) || document.status === 'invalid' ||
              document.status === 'read-only' && !document.diagnostics.every((diagnostic) => diagnostic.detail === 'opaque-drawing'))) {
            throw new PathError('maintenance-output-invalid', image.path);
          }
        }
      } else if (!equal(final.project.snapshot.records.map((r) => refKey(refOf(r))).sort(), data.nextRecords.map((r) => refKey(refOf(r))).sort())) {
        throw new PathError('catalog-changed', 'a3.project.json');
      }
      await log.append('verified'); await log.append('committed');
      this.#accepted = this.#observed = final; this.#external = false; this.#own.clear();
      this.#reason = data.maintenance && (final.project.mode !== 'ready' || final.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) ? 'project-not-writable' : undefined;
      const receipt: WriteReceipt = freeze({ status: 'committed', operationId: plan.operationId, atomic: false, paths: entries.map((e) => e.path), transactionPath: folder,
        ...(snapshotId ? { snapshotId } : {}) });
      // Post-commit injection represents process death only. A throwing hook cannot undo a confirmed receipt.
      try { await this.#fault('after-commit', plan.operationId); } catch { /* Already confirmed, never report rollback. */ }
      this.#emit({ kind: 'committed', receipt });
      return { ok: true, value: receipt, diagnostics: snapshotDiagnostics };
    } catch (error) {
      const detail = error instanceof PathError ? error.detail : 'write-failed';
      const diagnostics = [detail === 'external-conflict' || detail === 'destination-exists' || error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
        ? conflict(error instanceof PathError && error.detail === 'external-conflict' ? error.message : activePath) : detail === 'permission-denied' ? this.#denied(activePath) : ioIssue(activePath, error)];
      if (transactionPath) {
        this.#reason = 'recovery-required';
        try { await log?.append('failed', { detail }); } catch { /* Preserve a possibly truncated log, never continue writing targets. */ }
      }
      this.#emit({ kind: 'write-failed', diagnostics });
      return { ok: false, diagnostics, ...(transactionPath ? { recoveryRequired: true, transactionPath } : {}) };
    }
  }
  /** Host lifecycle; leases call this only after the last window closes. */
  async dispose(): Promise<void> {
    this.#closing = true;
    this.#watcher?.close(); if (this.#timer) clearInterval(this.#timer); if (this.#debounce) clearTimeout(this.#debounce);
    await this.#tail; await this.#ownership?.close(); this.#listeners.clear();
  }
}

export interface ProjectLease { service: ProjectService; reused: boolean; close(): Promise<void>; }
let opening: Promise<unknown> = Promise.resolve();
export function openProjectService(path: string, options: ServiceOptions): Promise<StoreResult<ProjectLease>> {
  const result = opening.then(() => openService(path, options)); opening = result.catch(() => undefined); return result;
}
async function openService(path: string, options: ServiceOptions): Promise<StoreResult<ProjectLease>> {
  let ownership: Ownership | undefined;
  try {
    if (!options?.host || !isProjectCapabilityBroker(options.host.capabilities)) {
      return failure([issue('a3.project.json', 'io', 'capability-broker-required', 'El host debe proporcionar un broker de capacidades emitido por la aplicación.', { code: 'PERMISSION_DENIED', missingCapability: 'project.read' })]);
    }
    const root = await realpath(resolve(path));
    const manifestBytes = await fileBytes(root, 'a3.project.json', 16 * 1024 * 1024);
    const manifest = decodeDocument({ kind: 'project', path: 'a3.project.json' }, manifestBytes);
    const rawManifest = manifest.value;
    const projectId = rawManifest && typeof rawManifest === 'object' && !Array.isArray(rawManifest) && typeof rawManifest.projectId === 'string' && uuid.test(rawManifest.projectId)
      ? rawManifest.projectId : undefined;
    if (!projectId) return failure([issue('a3.project.json', 'compatibility', 'project-id-unavailable', 'No se pudo leer un UUID de proyecto para verificar la concesión local.', { code: 'PERMISSION_DENIED', missingCapability: 'project.read' })]);
    let openDecision: CapabilityDecision | undefined;
    try { openDecision = options.host.capabilities.authorizeAccess({ actor: options.host.authenticatedActor, root, projectId, operation: 'open-project', paths: ['a3.project.json'], refs: [], resources: [] }); } catch { /* Fail closed. */ }
    if (!openDecision?.allowed) return failure([issue('a3.project.json', 'io', 'permission-denied', 'El broker del host no autoriza abrir el proyecto.', {
      code: 'PERMISSION_DENIED', ...(openDecision?.missingCapability ? { missingCapability: openDecision.missingCapability } : {}) })]);
    const identity = await projectIdentity(root);
    const existing = pool.get(identity);
    if (existing && existing.leases > 0 && existing.host === options.host) {
      existing.leases++;
      let closed = false;
      return { ok: true, value: { service: existing.service, reused: true, close: async () => {
        if (closed) return; closed = true; if (--existing.leases === 0) { await existing.service.dispose(); if (pool.get(identity) === existing) pool.delete(identity); }
      } }, diagnostics: [] };
    }
    ownership = await acquireOwnership(identity);
    const service = await ProjectService.create(root, projectId, options, identity, ownership, !ownership ? process.platform === 'win32' ? 'writer-busy' : 'windows-writer-required' : undefined);
    const entry = { service, host: options.host, leases: 1 };
    if (ownership) pool.set(identity, entry);
    let closed = false;
    return { ok: true, value: { service, reused: false, close: async () => {
      if (closed) return; closed = true;
      if (--entry.leases === 0) { await service.dispose(); if (pool.get(identity) === entry) pool.delete(identity); }
    } }, diagnostics: service.state.mode === 'read-only' ? [...service.state.recoveryDiagnostics,
      issue('a3.project.json', 'io', service.state.reason ?? 'writer-unavailable', 'Proyecto abierto en solo lectura; no se transfirió el escritor.', { severity: 'warning' })] : service.state.recoveryDiagnostics };
  } catch (error) { await ownership?.close(); return failure([ioIssue('a3.project.json', error)]); }
}
