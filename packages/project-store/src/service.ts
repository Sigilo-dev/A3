import { watch, type FSWatcher } from 'node:fs';
import { mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { defaultRegistry, getRecord, prepareCommand, refKey, refOf, revalidatePlan, validateSnapshot, type CommandContext, type Diagnostic, type DomainRecord, type JsonValue, type PreparedPlan, type Resource, type TypeRegistry } from '@a3/domain';
import { decodeDocument, encodeDocument, issue, serializeRecord, sha256 } from './codec.js';
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
import type { AccessRequest, FaultPhase, IntentEntry, MigrationReceipt, OpenResource, PreparedWrite, ResourceWriteRequest, ServiceEvent, ServiceOptions, ServiceState, SnapshotReceipt, StoreResult, WriteIntent, WriteReceipt } from './service-types.js';
import type { Capability, CapabilityDecision } from './capabilities.js';
import { isProjectCapabilityBroker } from './capabilities.js';

interface Observation { hash: string | null; identity: string | null; stamp: string; problem?: string; }
interface Scan { project: ProjectReadResult; files: Map<string, Observation>; diagnostics: StoreDiagnostic[]; }
interface Image { path: string; bytes: Uint8Array | null; ref?: ReturnType<typeof refOf>; }
interface PlanData {
  scan: Scan; images: Image[]; domain?: PreparedPlan; resourceWrite?: ResourceWriteRequest;
  nextRecords: DomainRecord[]; resources: Resource[]; requestHash: string; outcome?: StoreResult<WriteReceipt>;
  actor: string;
  requiredCapabilities: Capability[];
  preapproved?: boolean;
  maintenance?: boolean;
  allowRegisteredMigration?: boolean;
  snapshotId?: string;
  snapshotOperationId?: string;
  snapshotReason?: SnapshotReason;
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
function domainIssues(diagnostics: readonly Diagnostic[]): StoreDiagnostic[] {
  return diagnostics.map(({ instancePath, ...d }) => ({ ...d, path: 'a3.project.json', stage: 'references', ...(instancePath !== undefined ? { pointer: instancePath } : {}) }));
}
const diagramRefKinds = new Set(['workspace', 'placement', 'visual-edge', 'relation-view', 'group', 'drawing', 'relation']);
function domainCapabilities(plan: PreparedPlan): Capability[] {
  const command = plan.request.command;
  if (command === 'a3.core.register-node-type' || command === 'a3.core.unregister-node-type') return ['package.install'];
  const caps = new Set<Capability>();
  if (command === 'a3.core.delete') caps.add('delete');
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
  openResource(resourceId: string): Promise<StoreResult<OpenResource>> {
    return this.#queue(async () => {
      if (this.#closing) return failure([issue('resource', 'io', 'service-closed', 'El servicio está cerrado.')]);
      try {
        const next = await this.#scan(true); this.#acceptObservation(next);
        const record = getRecord(next.project.snapshot, { kind: 'resource', id: resourceId });
        if (record?.kind !== 'resource') return failure([issue('resource', 'references', 'resource-missing', 'Resource ID ausente o descriptor inválido.', { code: 'RESOURCE_MISSING' })]);
        if (!this.#authorized('read-resource', record.value.kind === 'project-file' ? [record.value.path] : [], [refOf(record)], [record.value])) return failure([this.#denied('resource')]);
        const opened = await readProjectResource(this.root, record.value, this.#resourceLimit);
        if (!opened.ok) return opened;
        const doc = next.project.documents.find((d) => d.record === record)!;
        if (opened.value.sha256 !== next.files.get(opened.value.path)?.hash) return failure([conflict(opened.value.path)]);
        return { ok: true, value: { ...opened.value, resourceId: record.value.id, revision: record.value.revision, descriptorHash: doc.sha256 }, diagnostics: [] };
      } catch (error) { return failure([this.#operationError('resource', error)]); }
    });
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
    const plan: PreparedWrite = freeze({ status: 'prepared', operationId, projectId, changes,
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
        return this.#makePlan(scan, domain.operationId, images, domain.nextSnapshot.records, resources,
          sha256(Buffer.from(domain.requestFingerprint)), { domain });
      } catch (error) { return failure([this.#operationError('operation', error)]); }
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
      const changed = this.#changes(data.scan, current.value);
      if (changed.length) return failure(changed.map((p) => conflict(p, 'stale-plan')));
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
      if (!data.images.length) return { ok: true, value: { status: 'committed', operationId: plan.operationId, atomic: false, paths: [], transactionPath: null }, diagnostics: [] };
      snapshotId = data.snapshotId ?? plan.operationId;
      const snapshot = await createSnapshot(this.root, { snapshotId, projectId: plan.projectId, operationId: data.snapshotOperationId ?? plan.operationId,
        reason: data.snapshotReason ?? 'batch', files: plan.changes.map((change) => ({ path: change.path, expectedHash: change.beforeHash,
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
      const intent: WriteIntent = { schemaVersion: '1.0.0', protocol: progressProtocol, operationId: plan.operationId, projectId: plan.projectId,
        actor: { kind: this.options.host.authenticatedActor.kind, id: this.options.host.authenticatedActor.id }, requestHash: data.requestHash,
        requiredCapabilities: [...data.requiredCapabilities], readSet: [...data.scan.files].map(([path, value]) => ({ path, hash: value.hash, identity: value.identity })), entries, extensions: {} };
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
      const beforeReplace = await this.#scan(true);
      const drift = this.#changes(data.scan, beforeReplace);
      const newErrors = introducesErrors(data.scan.diagnostics, beforeReplace.diagnostics);
      if (drift.length || newErrors || !data.maintenance && beforeReplace.diagnostics.some((d) => d.severity === 'error')) {
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
      const mismatches = this.#changes({ ...data.scan, files: expected }, final);
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
