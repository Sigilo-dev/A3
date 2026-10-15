import { watch, type FSWatcher } from 'node:fs';
import { mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultRegistry, getRecord, prepareCommand, refKey, refOf, revalidatePlan, type CommandContext, type Diagnostic, type DomainRecord, type JsonValue, type PreparedPlan, type Resource, type TypeRegistry } from '@a3/domain';
import { encodeDocument, issue, serializeRecord, sha256 } from './codec.js';
import { canonicalJson, freeze, pointerToken } from './json.js';
import { acquireOwnership, projectIdentity, type Ownership } from './ownership.js';
import { jsonBytes, ProgressLog, progressProtocol, transactionRoot } from './progress.js';
import { recoverTransactions } from './recovery.js';
import { checkedPath, fileBytes, ioIssue, PathError, readProject, readProjectResource, resolvePortablePath } from './reader.js';
import { absentPath, ensureDirectories, installExclusive, writeExclusive } from './write-io.js';
import type { JsonEdit, ProjectReadResult, StoreDiagnostic } from './types.js';
import type { AccessRequest, FaultPhase, IntentEntry, OpenResource, PreparedWrite, ResourceWriteRequest, ServiceEvent, ServiceOptions, ServiceState, StoreResult, WriteIntent, WriteReceipt } from './service-types.js';

interface Observation { hash: string | null; identity: string | null; stamp: string; problem?: string; }
interface Scan { project: ProjectReadResult; files: Map<string, Observation>; diagnostics: StoreDiagnostic[]; }
interface Image { path: string; bytes: Uint8Array | null; ref?: ReturnType<typeof refOf>; }
interface PlanData {
  scan: Scan; images: Image[]; domain?: PreparedPlan; resourceWrite?: ResourceWriteRequest;
  nextRecords: DomainRecord[]; resources: Resource[]; requestHash: string; outcome?: StoreResult<WriteReceipt>;
  actor: string;
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
  #registry: TypeRegistry;
  #resourceLimit: number;
  #transactionLimit: number;
  #catalog = '.a3';
  private constructor(readonly root: string, private readonly options: ServiceOptions, private readonly identity: string, ownership?: Ownership, reason?: string) {
    this.#ownership = ownership; this.#reason = reason;
    this.#registry = freeze(JSON.parse(JSON.stringify(options.registry ?? defaultRegistry())) as TypeRegistry);
    this.#resourceLimit = options.maxResourceBytes ?? 128 * 1024 * 1024;
    this.#transactionLimit = options.maxTransactionBytes ?? 128 * 1024 * 1024;
    for (const limit of [this.#resourceLimit, this.#transactionLimit, options.pollMs ?? 2000, options.debounceMs ?? 50]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Los límites/intervalos deben ser enteros positivos.');
    }
  }
  static async create(root: string, options: ServiceOptions, identity: string, ownership?: Ownership, reason?: string): Promise<ProjectService> {
    const service = new ProjectService(root, options, identity, ownership, reason);
    try {
      service.#accepted = service.#observed = await service.#scan(true);
      const project = service.#accepted.project.snapshot.records.find((r) => r.kind === 'project');
      if (project?.kind === 'project') service.#catalog = project.value.catalogRoot;
      if (ownership) {
        const recovery = await recoverTransactions(root, { ...(project?.kind === 'project' ? { projectId: project.value.projectId } : {}), authenticatedActor: options.host.authenticatedActor,
          maxBytes: service.#resourceLimit, authorizeWrite: (paths) => service.#authorized('write', [...paths]), ...(options.fault ? { fault: options.fault } : {}) });
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
    return { mode: this.#ownership?.alive() && !this.#reason && !this.#closing ? 'writer' : 'read-only',
      ...(this.#reason ? { reason: this.#reason } : {}), project: this.#observed.project, externalConflict: this.#external,
      recoveryDiagnostics: this.#recoveryDiagnostics };
  }
  subscribe(listener: (event: ServiceEvent) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #emit(event: ServiceEvent): void { for (const listener of this.#listeners) { try { listener(freeze(event)); } catch { /* A UI listener cannot abort IO. */ } } }
  #queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work); this.#tail = result.catch(() => undefined); return result;
  }
  #projectId(): string | undefined { const p = this.#accepted?.project.snapshot.records.find((r) => r.kind === 'project'); return p?.kind === 'project' ? p.value.projectId : undefined; }
  #authorized(operation: AccessRequest['operation'], paths: string[], refs: AccessRequest['refs'] = [], resources: Resource[] = []): boolean {
    try { return this.options.host.authorizeAccess(freeze({ actor: JSON.parse(JSON.stringify(this.options.host.authenticatedActor)), root: this.root,
      ...(this.#projectId() ? { projectId: this.#projectId()! } : {}), operation, paths: [...paths], refs: [...refs], resources: [...resources] })) === true; }
    catch { return false; }
  }
  #denied(path: string): StoreDiagnostic { return issue(path, 'io', 'permission-denied', 'La política del host no autoriza esta acción.', { code: 'PERMISSION_DENIED' }); }
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
    const project = await readProject(this.root, { registry: this.#registry });
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
    if (!next.project.catalogComplete || next.project.mode !== 'ready' || next.diagnostics.some((d) => d.severity === 'error')) this.#external = true;
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
      } catch (error) { return failure([ioIssue('a3.project.json', error)]); }
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
      } catch (error) { return failure([ioIssue('resource', error)]); }
    });
  }
  #context(scan: Scan): CommandContext {
    const contentHashes: Record<string, string> = {};
    for (const r of scan.project.snapshot.records) if (r.kind === 'resource' && r.value.kind === 'project-file') {
      const hash = scan.files.get(r.value.path)?.hash; if (hash) contentHashes[r.value.id] = hash;
    }
    return { authenticatedActor: this.options.host.authenticatedActor, authorization: this.options.host.domain, registry: this.#registry, contentHashes };
  }
  async #currentForWrite(): Promise<StoreResult<Scan>> {
    const gate = this.#gate(); if (gate.length) return failure(gate);
    const next = await this.#scan(true); this.#acceptObservation(next);
    const changed = this.#changes(this.#accepted, next);
    if (this.#external || changed.length) return failure((changed.length ? changed : ['a3.project.json']).map((path) => conflict(path)));
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
    if (!this.#authorized('write', images.map((i) => i.path), changes.flatMap((c) => c.ref ? [c.ref] : []), resources)) return failure([this.#denied('operation')]);
    const plan: PreparedWrite = freeze({ status: 'prepared', operationId, projectId: this.#projectId()!, changes,
      proposedBytes: (path: string) => { const bytes = images.find((i) => i.path === path)?.bytes; return bytes ? Uint8Array.from(bytes) : null; } });
    this.#plans.set(plan, { scan, images, nextRecords, resources, requestHash, actor: JSON.stringify(this.options.host.authenticatedActor), ...extra });
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
      } catch (error) { return failure([ioIssue('operation', error)]); }
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
      } catch (error) { return failure([ioIssue('resource', error)]); }
    });
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
    try {
      const current = await this.#currentForWrite(); if (!current.ok) return current;
      if (data.actor !== JSON.stringify(this.options.host.authenticatedActor)) return failure([this.#denied('operation')]);
      const changed = this.#changes(data.scan, current.value);
      if (changed.length) return failure(changed.map((p) => conflict(p, 'stale-plan')));
      if (data.domain) { const valid = revalidatePlan(data.domain, current.value.project.snapshot, this.#context(current.value)); if (!valid.ok) return failure(domainIssues(valid.diagnostics)); }
      if (!this.#authorized('write', data.images.map((i) => i.path), plan.changes.flatMap((c) => c.ref ? [c.ref] : []), data.resources)) return failure([this.#denied('operation')]);
      if (!data.images.length) return { ok: true, value: { status: 'committed', operationId: plan.operationId, atomic: false, paths: [], transactionPath: null }, diagnostics: [] };
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
        readSet: [...data.scan.files].map(([path, value]) => ({ path, hash: value.hash, identity: value.identity })), entries, extensions: {} };
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
      if (drift.length || beforeReplace.diagnostics.some((d) => d.severity === 'error')) throw new PathError('external-conflict', drift[0] ?? 'a3.project.json');
      for (const [index, entry] of entries.entries()) {
        activePath = entry.path;
        if (!this.#ownership?.alive() || !this.#authorized('write', [entry.path], entry.ref ? [entry.ref] : [], data.resources)) throw new PathError('permission-denied', entry.path);
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
      if (!this.#ownership?.alive() || !this.#authorized('write', data.images.map((i) => i.path), plan.changes.flatMap((c) => c.ref ? [c.ref] : []), data.resources)) throw new PathError('permission-denied', 'operation');
      for (const entry of entries) {
        if (entry.beforeHash !== null && sha256(await fileBytes(this.root, entry.backupPath, this.#resourceLimit)) !== entry.beforeHash) throw new PathError('backup-changed', entry.path);
        if (entry.beforeHash !== null && sha256(await fileBytes(this.root, entry.detachedPath, this.#resourceLimit)) !== entry.beforeHash) throw new PathError('external-conflict', entry.path);
        if (entry.afterHash !== null && sha256(await fileBytes(this.root, entry.stagedPath, this.#resourceLimit)) !== entry.afterHash) throw new PathError('staging-changed', entry.path);
      }
      const final = await this.#scan(true);
      const expected = new Map(data.scan.files);
      for (const entry of entries) if (entry.afterHash === null) expected.delete(entry.path); else expected.set(entry.path, this.#own.get(entry.path)!);
      const mismatches = this.#changes({ ...data.scan, files: expected }, final);
      if (mismatches.length || final.project.mode !== 'ready' || final.diagnostics.some((d) => d.severity === 'error')) throw new PathError('external-conflict', mismatches[0] ?? 'a3.project.json');
      if (!equal(final.project.snapshot.records.map((r) => refKey(refOf(r))).sort(), data.nextRecords.map((r) => refKey(refOf(r))).sort())) throw new PathError('catalog-changed', 'a3.project.json');
      await log.append('verified'); await log.append('committed');
      this.#accepted = this.#observed = final; this.#external = false; this.#own.clear();
      const receipt: WriteReceipt = freeze({ status: 'committed', operationId: plan.operationId, atomic: false, paths: entries.map((e) => e.path), transactionPath: folder });
      // Post-commit injection represents process death only. A throwing hook cannot undo a confirmed receipt.
      try { await this.#fault('after-commit', plan.operationId); } catch { /* Already confirmed, never report rollback. */ }
      this.#emit({ kind: 'committed', receipt });
      return { ok: true, value: receipt, diagnostics: [] };
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
    const root = await realpath(resolve(path));
    let permitted = false;
    try { permitted = options.host.authorizeAccess({ actor: options.host.authenticatedActor, root, operation: 'open-project', paths: ['a3.project.json'], refs: [], resources: [] }) === true; } catch { /* Fail closed. */ }
    if (!permitted) return failure([issue('a3.project.json', 'io', 'permission-denied', 'El host no autoriza abrir el proyecto.', { code: 'PERMISSION_DENIED' })]);
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
    const service = await ProjectService.create(root, options, identity, ownership, !ownership ? process.platform === 'win32' ? 'writer-busy' : 'windows-writer-required' : undefined);
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
