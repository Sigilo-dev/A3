import { access, lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defaultRegistry, revisionsOf, validateSnapshot, type DomainRecord, type Project, type Workspace } from '@a3/domain';
import { decodeDocument, serializeRecord, sha256 } from './codec.js';
import { isProjectCapabilityBroker } from './capabilities.js';
import { absentPath, ensureDirectories, installExclusive, writeExclusive } from './write-io.js';
import { checkedPath, fileBytes } from './reader.js';
import { acquireOwnership, projectIdentity, type Ownership } from './ownership.js';
import { jsonBytes, ProgressLog, progressProtocol, transactionRoot } from './progress.js';
import { recoverTransactions } from './recovery.js';
import { openProjectService, type ProjectLease } from './service.js';
import type { IntentEntry, ServiceOptions, StoreHost, WriteIntent } from './service-types.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class LocalProjectError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'LocalProjectError'; }
}
export interface RecentProject { id: string; projectId: string; root: string; name: string; lastOpened: string; }
export interface ProjectInitializationPreview {
  token: string; name: string; root: string; kind: 'create' | 'incorporate';
  files: string[]; directories: string[]; existingEntries: string[]; atomic: false;
}
export interface LocalProjectSession {
  sessionId: string; projectId: string; name: string; root: string; mode: 'writer' | 'read-only';
  format: string; pendingName: boolean; externalConflict: boolean; draftName: string | null; workspaces: { id: string; name: string }[]; diagnostics: string[];
}
export interface LocalProjectsState {
  sequence: number;
  active: LocalProjectSession | null;
  recents: (RecentProject & { available: boolean })[];
  preview: ProjectInitializationPreview | null;
}
interface Initialization {
  root: string; rootIdentity: string; project: Project; workspace: Workspace;
}
interface Catalog { version: 1; recents: RecentProject[]; pending: Initialization[]; }
interface PreviewData { public: ProjectInitializationPreview; parent: string; identity: string; initialization: Initialization; resume: boolean; }
export interface LocalProjectsOptions {
  stateDirectory: string; host: StoreHost;
  /** Trusted main-process prompt, called only for unresolved external changes/recovery. */
  confirmClose?: (session: LocalProjectSession) => Promise<boolean>;
  fault?: ServiceOptions['fault'];
}
function demand(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new LocalProjectError(code, message);
}
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
export function validateProjectName(value: string): string {
  demand(typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/[\x00-\x1f]/.test(value), 'INVALID_NAME', 'Escribe un nombre de proyecto de 1 a 120 caracteres.');
  return value.trim();
}
function folderName(name: string): string {
  validateProjectName(name);
  demand(!/[\\/:<>"|?*]/.test(name) && !/[. ]$/.test(name) && !/^(?:\.{1,2}|con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name),
    'INVALID_FOLDER_NAME', 'El nombre contiene un carácter o alias de carpeta no válido en Windows.');
  return name;
}
function within(root: string, target: string): boolean {
  const rel = relative(root, target); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}
async function localRoot(path: string): Promise<string> {
  demand(isAbsolute(path), 'INVALID_ROOT', 'Selecciona una carpeta absoluta.');
  const canonical = await realpath(path);
  demand(process.platform === 'win32' && /^[a-z]:[\\/]/i.test(canonical), 'WINDOWS_LOCAL_ROOT_REQUIRED', 'Este flujo requiere una carpeta local de Windows.');
  const stat = await lstat(canonical);
  demand(stat.isDirectory() && !stat.isSymbolicLink(), 'INVALID_ROOT', 'La ubicación debe ser una carpeta local.');
  await access(canonical, constants.R_OK);
  return canonical;
}
const directories = (workspaceId: string): string[] => [
  '.a3/entities', '.a3/resources', '.a3/relations', '.a3/collections', '.a3/variables/workspaces', '.a3/variables/entities', '.a3/packages',
  ...['placements', 'visual-edges', 'relation-views', 'groups', 'drawings'].map((part) => `.a3/workspaces/${workspaceId}/${part}`),
  ...['recovery', 'conflicts', 'trash', 'cache', 'logs', 'exports'].map((part) => `.a3/local/${part}`),
  'pages', 'stories', 'tasks', 'prompts', 'memory', 'diagrams', 'assets/images', 'assets/video', 'assets/audio', 'assets/files'
];
function initialFiles(value: Initialization): { path: string; bytes: Uint8Array; record?: DomainRecord }[] {
  const records: DomainRecord[] = [{ kind: 'project', value: value.project }, { kind: 'workspace', value: value.workspace }];
  demand(!validateSnapshot({ records }, defaultRegistry()).some((d) => d.severity === 'error'), 'INVALID_INITIAL_PROJECT', 'Los metadatos iniciales no cumplen el contrato A3.');
  const files = records.map((record) => {
    const path = record.kind === 'project' ? 'a3.project.json' : `.a3/workspaces/${value.workspace.id}/workspace.json`;
    const serialized = serializeRecord({ kind: record.kind, path }, record);
    demand(serialized.ok, 'INVALID_INITIAL_PROJECT', 'No se pudieron serializar los metadatos A3.');
    return { path, bytes: serialized.bytes, record };
  });
  // Publish the manifest last. The multi-file operation remains explicitly non-atomic.
  return [{ path: '.a3/.gitignore', bytes: Buffer.from('/local/\n') }, files[1]!, files[0]!];
}

/** Main-process lifecycle; renderer receives summaries and opaque preview/session IDs only. */
export class LocalProjectManager {
  #tail: Promise<unknown> = Promise.resolve();
  #catalog: Catalog = { version: 1, recents: [], pending: [] };
  #loaded = false;
  #active: { lease: ProjectLease; sessionId: string; projectId: string; name: string } | undefined;
  #preview: PreviewData | undefined;
  #disposed = false;
  #nameDraft: string | undefined;
  #catalogOwnership: Ownership | undefined;
  #stateRoot = '';
  #sequence = 0;
  constructor(private readonly options: LocalProjectsOptions) {
    demand(isProjectCapabilityBroker(options.host.capabilities), 'BROKER_REQUIRED', 'Se requiere el broker de permisos del host.');
  }
  #queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(async () => { demand(!this.#disposed, 'SESSION_CLOSED', 'El gestor está cerrado.'); await this.#load(); return work(); });
    this.#tail = next.catch(() => undefined); return next;
  }
  async #load(): Promise<void> {
    if (this.#loaded) return;
    await mkdir(this.options.stateDirectory, { recursive: true });
    this.#stateRoot = await realpath(this.options.stateDirectory);
    this.#catalogOwnership ??= await acquireOwnership(await projectIdentity(this.#stateRoot));
    demand(this.#catalogOwnership, 'LOCAL_CATALOG_BUSY', 'Otra instancia tiene abierto el catálogo local de proyectos. Usa esa ventana o ciérrala primero.');
    try {
      const stat = await lstat(join(this.#stateRoot, 'projects.json'));
      demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 'LOCAL_CATALOG_INVALID', 'El catálogo local no es válido; conserva el archivo para recuperarlo.');
      const handle = await open(join(this.#stateRoot, 'projects.json'), 'r');
      let value: Catalog;
      try { value = JSON.parse(await handle.readFile('utf8')) as Catalog; } finally { await handle.close(); }
      demand(value?.version === 1 && Array.isArray(value.recents) && Array.isArray(value.pending) && value.recents.length <= 100 && value.pending.length <= 100,
        'LOCAL_CATALOG_INVALID', 'El catálogo local tiene una versión o estructura desconocida.');
      for (const recent of value.recents) demand(recent && uuid.test(recent.id) && uuid.test(recent.projectId) && isAbsolute(recent.root) && typeof recent.name === 'string' && typeof recent.lastOpened === 'string', 'LOCAL_CATALOG_INVALID', 'Entrada reciente inválida.');
      for (const item of value.pending) { demand(item && isAbsolute(item.root) && /^[a-f0-9]{64}$/.test(item.rootIdentity), 'LOCAL_CATALOG_INVALID', 'Inicialización local inválida.'); initialFiles(item); }
      this.#catalog = value;
    } catch (error) {
      if (!missing(error)) throw error instanceof LocalProjectError ? error : new LocalProjectError('LOCAL_CATALOG_INVALID', 'No se pudo leer el catálogo local; no se reemplazó su contenido.');
    }
    this.#loaded = true;
  }
  async #persist(): Promise<void> {
    const temporary = join(this.#stateRoot, randomUUID() + '.tmp');
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(jsonBytes(this.#catalog)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(this.#stateRoot, 'projects.json'));
  }
  #assertLocalState(root: string): void {
    const local = this.#stateRoot;
    demand(local.toLowerCase() !== root.toLowerCase() && !within(root, local), 'LOCAL_STATE_INSIDE_PROJECT', 'El catálogo local debe estar fuera del proyecto.');
  }
  #summary(): LocalProjectSession | null {
    if (!this.#active) return null;
    const { lease, sessionId, projectId, name } = this.#active;
    const state = lease.service.state;
    const manifest = state.project.documents.find((d) => d.location.kind === 'project')?.value;
    return { sessionId, projectId, name, root: lease.service.root, mode: state.mode, pendingName: this.#nameDraft !== undefined && this.#nameDraft !== name, externalConflict: state.externalConflict, draftName: this.#nameDraft ?? null,
      format: manifest && typeof manifest === 'object' && !Array.isArray(manifest) && typeof manifest.formatVersion === 'string' ? manifest.formatVersion : 'desconocido',
      workspaces: state.project.snapshot.records.flatMap((r) => r.kind === 'workspace' ? [{ id: r.value.id, name: r.value.name }] : []),
      diagnostics: [...new Set([...state.project.diagnostics, ...state.recoveryDiagnostics].map((d) => `${d.path}: ${d.message}`)), ...(state.reason ? [state.reason] : [])] };
  }
  async #state(): Promise<LocalProjectsState> {
    const recents = await Promise.all(this.#catalog.recents.map(async (recent) => {
      let available = false;
      try { await localRoot(recent.root); available = await exists(join(recent.root, 'a3.project.json')); } catch { /* Missing/offline never creates a directory. */ }
      return { ...recent, available };
    }));
    return { sequence: ++this.#sequence, active: this.#summary(), recents, preview: this.#preview ? structuredClone(this.#preview.public) : null };
  }
  getState(): Promise<LocalProjectsState> { return this.#queue(() => this.#state()); }
  async #approve(root: string, projectId: string): Promise<void> {
    this.#assertLocalState(root);
    const broker = this.options.host.capabilities;
    const granted = broker.authorizeAccess({ root, projectId, actor: this.options.host.authenticatedActor, operation: 'open-project', paths: ['a3.project.json'], refs: [], resources: [] });
    if (!granted.allowed) demand(await broker.setProfile({ root, projectId, profile: 'proponer' }), 'PERMISSION_DENIED', 'La carpeta requiere aprobación local de lectura y del perfil Proponer.');
  }
  async #allowSwitch(): Promise<void> {
    if (!this.#active) return;
    if (this.#nameDraft !== undefined && this.#nameDraft !== this.#active.name) await this.#rename(this.#active.sessionId, this.#nameDraft);
    const state = this.#active.lease.service.state;
    if (state.externalConflict || state.reason === 'recovery-required') demand(await this.options.confirmClose?.(this.#summary()!), 'SWITCH_CANCELLED', 'Se conservó el proyecto abierto; revisa los cambios o la recuperación pendiente.');
    // Edits in F1 are awaited writer transactions. Closing the lease drains its queue.
  }
  async #activate(root: string, expectedId?: string): Promise<void> {
    await this.#allowSwitch();
    const manifest = decodeDocument({ kind: 'project', path: 'a3.project.json' }, await fileBytes(root, 'a3.project.json', 16 * 1024 * 1024));
    const value = manifest.value;
    demand(value && typeof value === 'object' && !Array.isArray(value) && typeof value.projectId === 'string' && uuid.test(value.projectId),
      'INVALID_MANIFEST', 'El manifiesto no contiene una identidad válida; sus bytes se conservaron.');
    const projectId = value.projectId;
    demand(!expectedId || expectedId.toLowerCase() === projectId.toLowerCase(), 'PROJECT_ID_MISMATCH', 'La carpeta seleccionada pertenece a otro proyecto.');
    await this.#approve(root, projectId);
    const candidate = await openProjectService(root, { host: this.options.host });
    demand(candidate.ok, 'OPEN_FAILED', candidate.diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n'));
    const name = typeof value.name === 'string' ? value.name : 'Proyecto sin nombre';
    const previous = this.#active;
    const previousCatalog = this.#catalog;
    try {
      const old = this.#catalog.recents.find((r) => r.projectId.toLowerCase() === projectId.toLowerCase() && (r.root.toLowerCase() === root.toLowerCase() || expectedId));
      this.#catalog = { version: 1,
        recents: [{ id: old?.id ?? randomUUID(), projectId, name, root, lastOpened: new Date().toISOString() }, ...this.#catalog.recents.filter((r) => r !== old && r.root.toLowerCase() !== root.toLowerCase())].slice(0, 30),
        pending: this.#catalog.pending.filter((p) => p.root.toLowerCase() !== root.toLowerCase()) };
      await this.#persist();
      await previous?.lease.close();
      this.#active = { lease: candidate.value, sessionId: randomUUID(), projectId, name };
      this.#nameDraft = undefined;
      this.#preview = undefined;
    } catch (error) { this.#catalog = previousCatalog; await candidate.value.close(); throw error; }
  }
  async #previewAt(root: string, name: string, kind: 'create' | 'incorporate', resume?: Initialization): Promise<void> {
    const parent = kind === 'create' ? await localRoot(resolve(root, '..')) : await localRoot(root);
    this.#assertLocalState(root);
    const rootIdentity = kind === 'create' ? '' : await projectIdentity(root);
    if (kind === 'incorporate') demand(!await exists(join(root, '.a3')) || resume, 'METADATA_CONFLICT', 'La carpeta ya contiene .a3 sin manifiesto. Revisa esos metadatos antes de incorporarla.');
    const projectId = resume?.project.projectId ?? randomUUID();
    const workspaceId = resume?.workspace.id ?? randomUUID();
    const initialization: Initialization = resume ?? { root, rootIdentity,
      project: { formatVersion: '1.0.0', projectId, revision: 1, name, defaultWorkspaceId: workspaceId, createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), locale: 'es', catalogRoot: '.a3', extensions: {} },
      workspace: { schemaVersion: '1.0.0', id: workspaceId, revision: 1, name: 'Principal', viewport: { x: 0, y: 0, zoom: 1 }, properties: {}, extensions: {} } };
    this.#preview = { parent, identity: await projectIdentity(parent), initialization, resume: !!resume,
      public: { token: randomUUID(), root, name: initialization.project.name, kind, files: initialFiles(initialization).map((f) => f.path), directories: directories(workspaceId),
        existingEntries: kind === 'incorporate' ? (await readdir(root)).slice(0, 100) : [], atomic: false } };
  }
  previewCreate(parent: string, inputName: string): Promise<LocalProjectsState> { return this.#queue(async () => {
    const name = folderName(validateProjectName(inputName));
    const canonicalParent = await localRoot(parent);
    const root = join(canonicalParent, name);
    demand(!await exists(root), 'DUPLICATE_NAME', 'Ya existe una carpeta con ese nombre. Abre la carpeta existente o elige otro nombre.');
    await this.#previewAt(root, name, 'create'); return this.#state();
  }); }
  async #openFolder(path: string, expectedId?: string): Promise<void> {
    const root = await localRoot(path); this.#assertLocalState(root);
    const identity = await projectIdentity(root);
    const pending = this.#catalog.pending.find((p) => p.rootIdentity === identity);
    if (pending) {
      await this.#approve(root, pending.project.projectId);
      const ownership = await acquireOwnership(identity);
      demand(ownership, 'WRITER_BUSY', 'Otra instancia está inicializando o recuperando esta carpeta.');
      try {
        const recovery = await recoverTransactions(root, { projectId: pending.project.projectId, authenticatedActor: this.options.host.authenticatedActor, maxBytes: 16 * 1024 * 1024,
          authorizeWrite: (_paths, capabilities, operationId) => this.options.host.capabilities.authorizeCapabilities(root, this.options.host.authenticatedActor, pending.project.projectId,
            ['project.recover', ...(capabilities ?? [])], `journal.recovery:${operationId}`, 'apply') });
        demand(!recovery.blocked, 'RECOVERY_REQUIRED', recovery.diagnostics.map((d) => `${d.path} (${d.detail}): ${d.message}`).join('\n'));
      } finally { await ownership.close(); }
    }
    if (await exists(join(root, 'a3.project.json'))) await this.#activate(root, expectedId);
    else {
      demand(!expectedId, 'MANIFEST_MISSING', 'El proyecto reciente no tiene manifiesto. Localiza su carpeta; no se creó un proyecto vacío.');
      await this.#previewAt(root, pending?.project.name ?? resolve(root).split(/[\\/]/).at(-1)!, 'incorporate', pending ? { ...pending, root } : undefined);
    }
  }
  openFolder(path: string): Promise<LocalProjectsState> { return this.#queue(async () => { await this.#openFolder(path); return this.#state(); }); }
  openRecent(id: string): Promise<LocalProjectsState> { return this.#queue(async () => {
    const recent = this.#catalog.recents.find((r) => r.id === id); demand(recent, 'RECENT_MISSING', 'El proyecto ya no está en recientes.');
    await this.#openFolder(recent.root, recent.projectId); return this.#state();
  }); }
  relocateRecent(id: string, path: string): Promise<LocalProjectsState> { return this.#queue(async () => {
    const recent = this.#catalog.recents.find((r) => r.id === id); demand(recent, 'RECENT_MISSING', 'El proyecto ya no está en recientes.');
    await this.#openFolder(path, recent.projectId); return this.#state();
  }); }
  cancelPreview(token: string): Promise<LocalProjectsState> { return this.#queue(async () => {
    demand(this.#preview?.public.token === token, 'STALE_PREVIEW', 'La vista previa ya no está vigente.'); this.#preview = undefined; return this.#state();
  }); }
  confirmInitialization(token: string): Promise<LocalProjectsState> { return this.#queue(async () => {
    const plan = this.#preview; demand(plan?.public.token === token, 'STALE_PREVIEW', 'Vuelve a previsualizar la creación.');
    await this.#allowSwitch();
    const currentParent = await localRoot(plan.parent);
    demand(currentParent.toLowerCase() === plan.parent.toLowerCase() && await projectIdentity(currentParent) === plan.identity, 'ROOT_CHANGED', 'La carpeta elegida cambió desde la vista previa.');
    const { root } = plan.public;
    if (plan.public.kind === 'create') { demand(!await exists(root), 'DUPLICATE_NAME', 'El destino apareció después de la vista previa.'); await mkdir(root); }
    const canonical = await localRoot(root);
    demand(canonical.toLowerCase() === root.toLowerCase(), 'ROOT_CHANGED', 'El destino fue sustituido por un enlace.');
    const identity = await projectIdentity(root);
    demand(plan.public.kind === 'create' || identity === plan.initialization.rootIdentity, 'ROOT_CHANGED', 'La carpeta cambió desde la vista previa.');
    await this.#approve(root, plan.initialization.project.projectId);
    const decision = await this.options.host.capabilities.authorizeCapabilities(root, this.options.host.authenticatedActor, plan.initialization.project.projectId,
      ['document.edit', 'diagram.edit'], 'project.initialize', 'apply');
    demand(decision.allowed, 'PERMISSION_DENIED', 'No se aprobó la creación de metadatos del proyecto.');
    const ownership = await acquireOwnership(identity); demand(ownership, 'WRITER_BUSY', 'La carpeta ya tiene un escritor activo.');
    try {
      demand(!await exists(join(root, '.a3')) || plan.resume, 'METADATA_CONFLICT', 'Aparecieron metadatos .a3 después de la vista previa.');
      const initialization = { ...plan.initialization, rootIdentity: identity };
      this.#catalog.pending = [...this.#catalog.pending.filter((p) => p.rootIdentity !== identity), initialization];
      await this.#persist();
      await initialize(root, identity, initialization, this.options);
    } finally { await ownership.close(); this.#preview = undefined; }
    await this.#activate(root); return this.#state();
  }); }
  async #rename(sessionId: string, inputName: string): Promise<void> {
    const name = validateProjectName(inputName);
    demand(this.#active?.sessionId === sessionId, 'STALE_SESSION', 'La sesión cambió; vuelve a abrir el proyecto.');
    const { lease, projectId } = this.#active; const snapshot = lease.service.state.project.snapshot;
    const prepared = await lease.service.prepare({ operationId: randomUUID(), projectId, actor: this.options.host.authenticatedActor, command: 'a3.core.rename',
      payload: { ref: { kind: 'project', id: projectId }, name }, expectedRevisions: revisionsOf(snapshot), expectedContentHashes: [], scope: { entityIds: [] } });
    demand(prepared.ok, 'RENAME_FAILED', prepared.diagnostics.map((d) => d.message).join('\n'));
    const committed = await lease.service.commit(prepared.value); demand(committed.ok, 'RENAME_FAILED', committed.diagnostics.map((d) => d.message).join('\n'));
    this.#active.name = name;
    for (const recent of this.#catalog.recents) if (recent.root.toLowerCase() === lease.service.root.toLowerCase()) recent.name = name;
    this.#nameDraft = undefined;
    try { await this.#persist(); }
    catch { throw new LocalProjectError('RECENTS_SAVE_FAILED', 'El nombre se guardó en el proyecto, pero no se pudo actualizar el catálogo local de recientes. Reabre el proyecto para sincronizarlo.'); }
  }
  stageName(sessionId: string, name: string): Promise<LocalProjectsState> { return this.#queue(async () => {
    demand(this.#active?.sessionId === sessionId && typeof name === 'string' && name.length <= 120, 'STALE_SESSION', 'El borrador pertenece a otra sesión o no es válido.');
    this.#nameDraft = name; return this.#state();
  }); }
  renameActive(sessionId: string, inputName: string): Promise<LocalProjectsState> { return this.#queue(async () => {
    await this.#rename(sessionId, inputName); return this.#state();
  }); }
  closeActive(sessionId: string): Promise<LocalProjectsState> { return this.#queue(async () => {
    demand(this.#active?.sessionId === sessionId, 'STALE_SESSION', 'La sesión ya cambió.'); await this.#allowSwitch();
    await this.#active.lease.close(); this.#active = undefined; this.#preview = undefined; this.#nameDraft = undefined; return this.#state();
  }); }
  /** Interactive app shutdown must flush the draft; unlike getState it can exit with a damaged local catalog. */
  shutdown(): Promise<void> {
    const result = this.#tail.then(async () => {
      await this.#allowSwitch(); await this.#active?.lease.close(); this.#active = undefined;
      this.#disposed = true; await this.#catalogOwnership?.close();
    });
    this.#tail = result.catch(() => undefined); return result;
  }
  async dispose(): Promise<void> { await this.#tail; this.#disposed = true; await this.#active?.lease.close(); this.#active = undefined; await this.#catalogOwnership?.close(); }
}

async function initialize(root: string, identity: string, initial: Initialization, options: LocalProjectsOptions): Promise<void> {
  const operationId = randomUUID(); const [ignore, ...files] = initialFiles(initial); const folder = `${transactionRoot}/${operationId}`;
  const verifyRoot = async (): Promise<void> => {
    const canonical = await localRoot(root);
    demand(canonical.toLowerCase() === root.toLowerCase() && await projectIdentity(canonical) === identity, 'ROOT_CHANGED', 'La raíz de creación cambió.');
  };
  await verifyRoot();
  for (const file of files) demand(!await exists(join(root, file.path)), 'METADATA_CONFLICT', 'Apareció un destino de metadatos; se conserva sin sobrescribir.');
  // This non-destructive prerequisite protects the journal even if document creation rolls back.
  await ensureDirectories(root, '.a3');
  if (await exists(join(root, ignore!.path))) demand(sha256(await fileBytes(root, ignore!.path, 1024)) === sha256(ignore!.bytes), 'METADATA_CONFLICT', 'Cambió la exclusión local de Git; no se reemplazó.');
  else await writeExclusive(root, ignore!.path, ignore!.bytes);
  // Directory creation can leave empty directories after rollback; all document bytes use D1.
  await ensureDirectories(root, transactionRoot); await mkdir(await absentPath(root, folder));
  const entries: IntentEntry[] = files.map((file, index) => ({ path: file.path, beforeHash: null, afterHash: sha256(file.bytes), bytes: file.bytes.length,
    backupPath: `${folder}/${index}.before`, stagedPath: `${folder}/${index}.staged`, candidatePath: `${folder}/${index}.candidate`, detachedPath: `${folder}/${index}.detached`, revisionBefore: null, revisionAfter: file.record?.value.revision ?? null }));
  const intent: WriteIntent = { schemaVersion: '1.0.0', protocol: progressProtocol, projectId: initial.project.projectId, operationId,
    actor: options.host.authenticatedActor, requiredCapabilities: ['document.edit', 'diagram.edit'], requestHash: sha256(jsonBytes(initial.project)),
    readSet: entries.map((entry) => ({ path: entry.path, hash: null, identity: null })), entries, extensions: {} };
  const log = new ProgressLog(root, folder); await log.intent(intent);
  await options.fault?.('after-intent', { operationId });
  for (const path of directories(initial.workspace.id)) await ensureDirectories(root, path);
  for (const [index, file] of files.entries()) {
    await writeExclusive(root, entries[index]!.stagedPath, file.bytes); await writeExclusive(root, entries[index]!.candidatePath, file.bytes); await log.append('staged', { index });
  }
  await options.fault?.('after-staging', { operationId });
  for (const [index, entry] of entries.entries()) {
    await verifyRoot();
    const permitted = await options.host.capabilities.authorizeCapabilities(root, options.host.authenticatedActor, initial.project.projectId, ['document.edit', 'diagram.edit'], 'project.initialize', 'prepare');
    demand(permitted.allowed, 'PERMISSION_DENIED', 'Los permisos de creación fueron revocados.');
    await options.fault?.('before-install', { operationId, index, path: entry.path });
    await log.append('install-start', { index }); await installExclusive(root, entry.candidatePath, entry.path); await log.append('installed', { index });
    await options.fault?.('after-install', { operationId, index, path: entry.path });
  }
  await verifyRoot();
  for (const entry of entries) demand(sha256(await fileBytes(root, entry.path, 16 * 1024 * 1024)) === entry.afterHash, 'INITIALIZATION_CONFLICT', 'Los metadatos cambiaron antes de confirmar.');
  await checkedPath(root, `.a3/workspaces/${initial.workspace.id}/workspace.json`, 'file');
  await options.fault?.('before-commit', { operationId });
  await log.append('verified'); await log.append('committed');
}
