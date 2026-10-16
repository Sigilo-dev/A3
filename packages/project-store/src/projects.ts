import { access, lstat, mkdir, open, readdir, realpath, rename, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defaultRegistry, revisionsOf, validateSnapshot, type DocumentRef, type DomainCommand, type DomainRecord, type Entity, type Placement, type Project, type TypeRegistry, type VisualEdge, type Workspace } from '@a3/domain';
import { decodeDocument, serializeRecord, sha256 } from './codec.js';
import { isProjectCapabilityBroker } from './capabilities.js';
import { absentPath, ensureDirectories, installExclusive, writeExclusive } from './write-io.js';
import { checkedPath, fileBytes } from './reader.js';
import { acquireOwnership, projectIdentity, type Ownership } from './ownership.js';
import { jsonBytes, ProgressLog, progressProtocol, transactionRoot } from './progress.js';
import { recoverTransactions } from './recovery.js';
import { openProjectService, type ProjectLease } from './service.js';
import { inspectLocalMountFile, validateMountRelativePath } from './mounts.js';
import type { ExplorerDeletePreview, ExplorerDirectoryPage, ExplorerMountEntry, ExplorerOpenResult, IntentEntry, ServiceOptions, StoreHost, WriteIntent } from './service-types.js';

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
  format: string; pendingName: boolean; pendingViewport: boolean; externalConflict: boolean; draftName: string | null; workspaces: { id: string; name: string }[]; diagnostics: string[];
}
export interface LocalProjectsState {
  sequence: number;
  active: LocalProjectSession | null;
  recents: (RecentProject & { available: boolean })[];
  preview: ProjectInitializationPreview | null;
}
export interface WorkspaceViewport { x: number; y: number; zoom: number; }
export interface CanvasEntitySummary {
  id: string; revision: number; type: string; typeVersion: string; title: string; properties: Entity['properties']; ports: Entity['ports'];
  contentResourceId?: string; typeAvailable: boolean;
}
export interface CanvasEntityChoice { id: string; type: string; typeVersion: string; title: string; }
export interface CanvasPlacementView {
  id: string; revision: number; entityId: string; position: Placement['position']; size: Placement['size']; style: Placement['style'];
}
export type CanvasVisualEdgeView = Pick<VisualEdge, 'id' | 'revision' | 'sourcePlacementId' | 'targetPlacementId' | 'label' | 'waypoints' | 'style'>;
export type CanvasVisualEdgePatch = Partial<Pick<VisualEdge, 'sourcePlacementId' | 'targetPlacementId' | 'label' | 'waypoints' | 'style'>>;
export interface CanvasPlacementMove { id: string; expectedRevision: number; position: { x: number; y: number }; }
export interface CanvasResourcePreview { entityId: string; resourceId: string; text: string | null; state: 'ready' | 'too-large' | 'unavailable' | 'binary'; }
export interface LocalCanvasWorkspace {
  sessionId: string; workspaceId: string; name: string; revision: number;
  viewport: WorkspaceViewport; canWrite: boolean; pending: boolean; entities: readonly CanvasEntitySummary[]; entityChoices: readonly CanvasEntityChoice[];
  placements: readonly CanvasPlacementView[]; visualEdges: readonly CanvasVisualEdgeView[]; canDeleteEdges: boolean;
}
export interface LocalExplorerEntry extends Omit<ExplorerDirectoryPage['entries'][number], 'path' | 'identity'> { id: string; path: string; }
export interface LocalExplorerMount extends Omit<ExplorerMountEntry, 'resourceId'> { id: string; }
export interface LocalExplorerListing { sessionId: string; directoryId: string; entries: readonly LocalExplorerEntry[]; nextCursor: string | null; mounts: readonly LocalExplorerMount[]; }
export interface LocalExplorerOpen extends Omit<ExplorerOpenResult, 'path'> { relativePath: string; }
export interface LocalExplorerDeletePreview extends Omit<ExplorerDeletePreview, 'path'> { token: string; name: string; }
interface ExplorerItemBinding { sessionId: string; path: string; identity: string; kind: 'file' | 'directory' | 'blocked-link'; resourceId?: string; }
interface ExplorerPageBinding { sessionId: string; path: string; offset: number; }
interface ExplorerDeleteBinding { sessionId: string; itemId: string; path: string; identity: string; }
interface ActiveProjectBinding { lease: ProjectLease; sessionId: string; projectId: string; name: string; }
interface Initialization {
  root: string; rootIdentity: string; project: Project; workspace: Workspace;
}
interface Catalog { version: 1; recents: RecentProject[]; pending: Initialization[]; }
interface PreviewData { public: ProjectInitializationPreview; parent: string; identity: string; initialization: Initialization; resume: boolean; }
export interface LocalProjectsOptions {
  stateDirectory: string; host: StoreHost;
  /** Trusted host registry; project documents cannot install or activate their own node renderers. */
  registry?: TypeRegistry;
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
async function removeEmptyDirectoryTree(root: string, relativePath: string): Promise<void> {
  try {
    const target = await checkedPath(root, relativePath, 'directory');
    for (const name of await readdir(target)) {
      const child = `${relativePath}/${name}`;
      const info = await lstat(join(target, name));
      if (!info.isSymbolicLink() && info.isDirectory()) await removeEmptyDirectoryTree(root, child);
    }
    if ((await readdir(target)).length === 0) await rmdir(target);
  } catch { /* Cleanup removes empty folders only; any changed or nonempty path remains recoverable. */ }
}
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
  #active: ActiveProjectBinding | undefined;
  #preview: PreviewData | undefined;
  #disposed = false;
  #nameDraft: string | undefined;
  #catalogOwnership: Ownership | undefined;
  #stateRoot = '';
  #sequence = 0;
  #explorerSessionId = '';
  #explorerItems = new Map<string, ExplorerItemBinding>();
  #explorerPaths = new Map<string, { id: string; identity: string }>();
  #explorerPages = new Map<string, ExplorerPageBinding>();
  #explorerDeletes = new Map<string, ExplorerDeleteBinding>();
  #viewportDrafts = new Map<string, { sessionId: string; expectedRevision: number; viewport: WorkspaceViewport }>();
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
    return { sessionId, projectId, name, root: lease.service.root, mode: state.mode, pendingName: this.#nameDraft !== undefined && this.#nameDraft !== name, pendingViewport: this.#viewportDrafts.size > 0, externalConflict: state.externalConflict, draftName: this.#nameDraft ?? null,
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
    for (const workspaceId of this.#viewportDrafts.keys()) await this.#flushCanvasWorkspace(this.#active.sessionId, workspaceId);
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
    const candidate = await openProjectService(root, { host: this.options.host, registry: this.options.registry ?? defaultRegistry() });
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
      this.#viewportDrafts.clear();
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
    await this.#active.lease.close(); this.#active = undefined; this.#preview = undefined; this.#nameDraft = undefined; this.#clearExplorer(); return this.#state();
  }); }
  #canvasContext(sessionId: string, workspaceId: string): { active: ActiveProjectBinding; workspace: Workspace } {
    const active = this.#active;
    demand(active?.sessionId === sessionId, 'STALE_SESSION', 'La sesión cambió; vuelve a abrir el lienzo.');
    const record = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'workspace' && record.value.id === workspaceId);
    demand(record?.kind === 'workspace', 'WORKSPACE_MISSING', 'Este workspace no está disponible; sus archivos se conservaron.');
    const decision = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
      projectId: active.projectId, operation: 'read-resource', paths: [], refs: [{ kind: 'workspace', id: workspaceId }], resources: [] });
    demand(decision.allowed, 'PERMISSION_DENIED', 'El broker denegó la lectura del workspace.');
    return { active, workspace: record.value };
  }
  #canvasWorkspace(sessionId: string, workspaceId: string): LocalCanvasWorkspace {
    const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
    const edit = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
      projectId: active.projectId, operation: 'write', paths: [], refs: [{ kind: 'workspace', id: workspaceId }], resources: [], requiredCapabilities: ['diagram.edit'], stage: 'prepare' });
    const snapshot = active.lease.service.state.project.snapshot;
    const choices = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'entity' }> => record.kind === 'entity');
    const placements = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'placement' }> => record.kind === 'placement' && record.workspaceId === workspaceId)
      .map(({ value }) => ({ id: value.id, revision: value.revision, entityId: value.entityId, position: value.position, size: value.size, style: value.style }));
    const placedIds = new Set(placements.map((placement) => placement.entityId.toLowerCase()));
    const entities = choices.filter(({ value }) => placedIds.has(value.id.toLowerCase()))
      .map(({ value }) => ({ id: value.id, revision: value.revision, type: value.type, typeVersion: value.typeVersion,
        title: value.title, properties: value.properties, ports: value.ports, ...(value.contentResourceId ? { contentResourceId: value.contentResourceId } : {}),
        typeAvailable: (this.options.registry ?? defaultRegistry()).nodeTypes.some((definition) => definition.name === value.type && definition.version === value.typeVersion) }));
    const entityChoices = choices.map(({ value }) => ({ id: value.id, type: value.type, typeVersion: value.typeVersion, title: value.title }));
    const placementIds = new Map(placements.map((placement) => [placement.id.toLowerCase(), placement.id]));
    const visualEdges = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'visual-edge' }> => record.kind === 'visual-edge' && record.workspaceId === workspaceId)
      .map(({ value }) => ({ id: value.id, revision: value.revision, sourcePlacementId: placementIds.get(value.sourcePlacementId.toLowerCase()) ?? value.sourcePlacementId,
        targetPlacementId: placementIds.get(value.targetPlacementId.toLowerCase()) ?? value.targetPlacementId,
        label: value.label, waypoints: value.waypoints, style: value.style }));
    const deletion = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
      projectId: active.projectId, operation: 'write', paths: [], refs: [], resources: [], requiredCapabilities: ['delete', 'diagram.edit'], stage: 'prepare' });
    const draft = this.#viewportDrafts.get(workspaceId);
    const { x, y, zoom } = draft?.viewport ?? workspace.viewport;
    return { sessionId, workspaceId, name: workspace.name, revision: workspace.revision, viewport: { x, y, zoom }, pending: !!draft, entities, entityChoices, placements, visualEdges,
      canDeleteEdges: active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict && deletion.allowed,
      canWrite: active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict && edit.allowed };
  }
  loadCanvasWorkspace(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => this.#canvasWorkspace(sessionId, workspaceId));
  }
  stageCanvasViewport(sessionId: string, workspaceId: string, expectedRevision: number, viewport: WorkspaceViewport): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const view = this.#canvasWorkspace(sessionId, workspaceId);
      demand(view.canWrite, 'PERMISSION_DENIED', 'La vista puede navegarse, pero el proyecto no permite guardar el viewport.');
      demand(viewport && Object.keys(viewport).length === 3 && [viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) && viewport.zoom > 0,
        'INVALID_VIEWPORT', 'El viewport requiere coordenadas finitas y una escala positiva.');
      const draft = this.#viewportDrafts.get(workspaceId);
      demand(Number.isSafeInteger(expectedRevision) && expectedRevision === view.revision && (!draft || draft.expectedRevision === expectedRevision),
        'REVISION_CONFLICT', 'El workspace cambió; relee la vista antes de guardar.');
      this.#viewportDrafts.set(workspaceId, { sessionId, expectedRevision, viewport: { ...viewport } });
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  async #flushCanvasWorkspace(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
    const draft = this.#viewportDrafts.get(workspaceId);
    if (!draft) return this.#canvasWorkspace(sessionId, workspaceId);
    demand(draft.sessionId === sessionId && workspace.revision === draft.expectedRevision, 'REVISION_CONFLICT', 'El workspace cambió; el viewport pendiente se conserva sin sobrescribir.');
    if (workspace.viewport.x !== draft.viewport.x || workspace.viewport.y !== draft.viewport.y || workspace.viewport.zoom !== draft.viewport.zoom) {
      const snapshot = active.lease.service.state.project.snapshot;
      const prepared = await active.lease.service.prepare({ operationId: randomUUID(), projectId: active.projectId, actor: this.options.host.authenticatedActor,
        command: 'a3.core.set-workspace-viewport', payload: { workspaceId, viewport: draft.viewport }, expectedRevisions: revisionsOf(snapshot),
        expectedContentHashes: [], scope: { entityIds: [] } });
      demand(prepared.ok, prepared.diagnostics[0]?.code ?? 'VIEWPORT_SAVE_FAILED', prepared.diagnostics.map((d) => d.message).join('\n'));
      const committed = await active.lease.service.commit(prepared.value);
      demand(committed.ok, committed.diagnostics[0]?.code ?? 'VIEWPORT_SAVE_FAILED', committed.diagnostics.map((d) => d.message).join('\n'));
    }
    this.#viewportDrafts.delete(workspaceId);
    return this.#canvasWorkspace(sessionId, workspaceId);
  }
  flushCanvasWorkspace(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(() => this.#flushCanvasWorkspace(sessionId, workspaceId));
  }
  discardCanvasViewport(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => { this.#canvasContext(sessionId, workspaceId); this.#viewportDrafts.delete(workspaceId); return this.#canvasWorkspace(sessionId, workspaceId); });
  }
  createCanvasPlacement(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, entityId: string, position: { x: number; y: number }): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision, 'REVISION_CONFLICT', 'El workspace cambió; recarga antes de crear la representación.');
      demand(position && Number.isFinite(position.x) && Number.isFinite(position.y), 'INVALID_PLACEMENT_POSITION', 'La posición debe usar coordenadas finitas.');
      const snapshot = active.lease.service.state.project.snapshot;
      const entity = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === entityId.toLowerCase());
      demand(entity?.kind === 'entity', 'ENTITY_MISSING', 'La entidad ya no está disponible en este proyecto.');
      const id = randomUUID();
      const record: DomainRecord = { kind: 'placement', workspaceId, value: { schemaVersion: '1.0.0', id, revision: 1, entityId: entity.value.id,
        position: { x: position.x, y: position.y }, size: { width: 300, height: 190 }, style: {}, extensions: {} } };
      const prepared = await active.lease.service.prepare({ operationId: randomUUID(), projectId: active.projectId, actor: this.options.host.authenticatedActor,
        command: 'a3.core.create-document', payload: { record }, expectedRevisions: [...revisionsOf(snapshot), { kind: 'placement', id, workspaceId, revision: null }],
        expectedContentHashes: [], scope: { entityIds: [entity.value.id] } });
      demand(prepared.ok, prepared.diagnostics[0]?.code ?? 'PLACEMENT_CREATE_FAILED', prepared.diagnostics.map((item) => item.message).join('\n'));
      const committed = await active.lease.service.commit(prepared.value);
      demand(committed.ok, committed.diagnostics[0]?.code ?? 'PLACEMENT_CREATE_FAILED', committed.diagnostics.map((item) => item.message).join('\n'));
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  updateCanvasPlacement(sessionId: string, workspaceId: string, placementId: string, expectedRevision: number,
    patch: { position?: { x: number; y: number }; size?: { width: number; height: number }; style?: Record<string, unknown> }): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const snapshot = active.lease.service.state.project.snapshot;
      const record = snapshot.records.find((item) => item.kind === 'placement' && item.workspaceId === workspaceId && item.value.id.toLowerCase() === placementId.toLowerCase());
      demand(record?.kind === 'placement', 'PLACEMENT_MISSING', 'La representación ya no existe en este workspace.');
      demand(Number.isSafeInteger(expectedRevision) && expectedRevision === record.value.revision, 'REVISION_CONFLICT', 'La representación cambió; vuelve a cargar el placement antes de guardarlo.');
      const payload = { ...patch, ref: { kind: 'placement' as const, id: record.value.id, workspaceId } };
      const command = patch.position && !patch.size && !patch.style ? 'a3.core.move-placement' : 'a3.core.update-placement-view';
      const prepared = await active.lease.service.prepare({ operationId: randomUUID(), projectId: active.projectId, actor: this.options.host.authenticatedActor,
        command, payload: command === 'a3.core.move-placement' ? { ref: payload.ref, position: patch.position } : payload,
        expectedRevisions: revisionsOf(snapshot), expectedContentHashes: [], scope: { entityIds: [record.value.entityId] } });
      demand(prepared.ok, prepared.diagnostics[0]?.code ?? 'PLACEMENT_UPDATE_FAILED', prepared.diagnostics.map((item) => item.message).join('\n'));
      const committed = await active.lease.service.commit(prepared.value);
      demand(committed.ok, committed.diagnostics[0]?.code ?? 'PLACEMENT_UPDATE_FAILED', committed.diagnostics.map((item) => item.message).join('\n'));
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  loadCanvasContent(sessionId: string, workspaceId: string, entityId: string, resourceId: string): Promise<CanvasResourcePreview> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const snapshot = active.lease.service.state.project.snapshot;
      const entity = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === entityId.toLowerCase());
      demand(entity?.kind === 'entity' && entity.value.contentResourceId?.toLowerCase() === resourceId.toLowerCase() &&
        snapshot.records.some((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.entityId.toLowerCase() === entityId.toLowerCase()),
      'RESOURCE_NOT_IN_VIEW', 'El recurso no pertenece a una entidad representada en este workspace.');
      const opened = await active.lease.service.openResource(resourceId, 64 * 1024);
      if (!opened.ok) {
        const tooLarge = opened.diagnostics.some((item) => item.detail.includes('read-limit') || item.detail.includes('size-limit') || item.detail.includes('resource-too-large'));
        return { entityId, resourceId, text: null, state: tooLarge ? 'too-large' : 'unavailable' };
      }
      try { return { entityId, resourceId, text: new TextDecoder('utf-8', { fatal: true }).decode(opened.value.bytes), state: 'ready' }; }
      catch { return { entityId, resourceId, text: null, state: 'binary' }; }
    });
  }
  async #commitCanvasCommand(active: ActiveProjectBinding, operation: Pick<DomainCommand, 'command' | 'payload'>, entityIds: string[], absent?: DocumentRef): Promise<void> {
    const prepared = await active.lease.service.prepare({ operationId: randomUUID(), projectId: active.projectId, actor: this.options.host.authenticatedActor,
      ...operation, expectedRevisions: [...revisionsOf(active.lease.service.state.project.snapshot), ...(absent ? [{ ...absent, revision: null }] : [])],
      expectedContentHashes: [], scope: { entityIds: [...new Set(entityIds)] } });
    demand(prepared.ok, prepared.diagnostics[0]?.code ?? 'CANVAS_COMMAND_FAILED', prepared.diagnostics.map((item) => item.message).join('\n'));
    const committed = await active.lease.service.commit(prepared.value);
    demand(committed.ok, committed.diagnostics[0]?.code ?? 'CANVAS_COMMAND_FAILED', committed.diagnostics.map((item) => item.message).join('\n'));
  }
  #canvasEndpointEntities(active: ActiveProjectBinding, workspaceId: string, placementIds: string[]): string[] {
    return placementIds.map((id) => {
      const placement = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === id.toLowerCase());
      demand(placement?.kind === 'placement', 'PLACEMENT_MISSING', 'El extremo debe pertenecer a este workspace.');
      return placement.value.entityId;
    });
  }
  moveCanvasPlacements(sessionId: string, workspaceId: string, placements: CanvasPlacementMove[]): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      demand(Array.isArray(placements) && placements.length > 0, 'INVALID_PLACEMENT_MOVES', 'Selecciona representaciones para mover.');
      const entityIds = this.#canvasEndpointEntities(active, workspaceId, placements.map((item) => item.id));
      for (const item of placements) {
        const record = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === item.id.toLowerCase())!;
        demand(Number.isSafeInteger(item.expectedRevision) && record.value.revision === item.expectedRevision, 'REVISION_CONFLICT', 'La selección cambió; recarga antes de moverla.');
      }
      await this.#commitCanvasCommand(active, { command: 'a3.core.move-placements', payload: { workspaceId, placements: placements.map(({ id, position }) => ({ id, position })) } }, entityIds);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  createCanvasVisualEdge(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, sourcePlacementId: string, targetPlacementId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision, 'REVISION_CONFLICT', 'El workspace cambió; recarga antes de conectar.');
      const entityIds = this.#canvasEndpointEntities(active, workspaceId, [sourcePlacementId, targetPlacementId]);
      const record: DomainRecord = { kind: 'visual-edge', workspaceId, value: { schemaVersion: '1.0.0', id: randomUUID(), revision: 1,
        sourcePlacementId, targetPlacementId, label: '', waypoints: [], style: {}, extensions: {} } };
      await this.#commitCanvasCommand(active, { command: 'a3.core.create-document', payload: { record } }, entityIds, { kind: 'visual-edge', workspaceId, id: record.value.id });
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  updateCanvasVisualEdge(sessionId: string, workspaceId: string, edgeId: string, expectedRevision: number, patch: CanvasVisualEdgePatch): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const edge = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'visual-edge' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === edgeId.toLowerCase());
      demand(edge?.kind === 'visual-edge', 'EDGE_MISSING', 'La línea visual ya no está disponible.');
      demand(Number.isSafeInteger(expectedRevision) && edge.value.revision === expectedRevision, 'REVISION_CONFLICT', 'La línea cambió; vuelve a cargarla antes de editar.');
      const entityIds = this.#canvasEndpointEntities(active, workspaceId, [edge.value.sourcePlacementId, edge.value.targetPlacementId,
        patch.sourcePlacementId ?? edge.value.sourcePlacementId, patch.targetPlacementId ?? edge.value.targetPlacementId]);
      await this.#commitCanvasCommand(active, { command: 'a3.core.update-visual-edge', payload: { ...patch, ref: { kind: 'visual-edge', id: edge.value.id, workspaceId } } }, entityIds);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  deleteCanvasVisualEdge(sessionId: string, workspaceId: string, edgeId: string, expectedRevision: number): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const edge = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'visual-edge' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === edgeId.toLowerCase());
      demand(edge?.kind === 'visual-edge', 'EDGE_MISSING', 'La línea visual ya no está disponible.');
      demand(Number.isSafeInteger(expectedRevision) && edge.value.revision === expectedRevision, 'REVISION_CONFLICT', 'La línea cambió; recarga antes de eliminar.');
      const entityIds = this.#canvasEndpointEntities(active, workspaceId, [edge.value.sourcePlacementId, edge.value.targetPlacementId]);
      await this.#commitCanvasCommand(active, { command: 'a3.core.delete', payload: { ref: { kind: 'visual-edge', id: edge.value.id, workspaceId } } }, entityIds);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  approveCanvasEdgeDeletion(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      demand(this.options.host.authenticatedActor.kind === 'user', 'PERMISSION_DENIED', 'Solo una persona puede solicitar permisos locales.');
      demand(await this.options.host.capabilities.setGrant({ root: active.lease.service.root, projectId: active.projectId, capability: 'delete', mode: 'approval' }),
        'PERMISSION_DENIED', 'El permiso de eliminación no fue aprobado.');
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  #clearExplorer(): void {
    this.#explorerSessionId = ''; this.#explorerItems.clear(); this.#explorerPaths.clear(); this.#explorerPages.clear(); this.#explorerDeletes.clear();
  }
  #explorerContext(sessionId?: string): ActiveProjectBinding {
    demand(this.#active && (!sessionId || this.#active.sessionId === sessionId), 'STALE_SESSION', 'La sesión del proyecto cambió; vuelve a abrir Archivos.');
    if (this.#explorerSessionId !== this.#active.sessionId) { this.#clearExplorer(); this.#explorerSessionId = this.#active.sessionId; }
    return this.#active;
  }
  #explorerPath(id: string, sessionId: string): ExplorerItemBinding {
    const binding = this.#explorerItems.get(id);
    demand(binding && binding.sessionId === sessionId, 'STALE_FILE_ID', 'El elemento cambió o pertenece a otro proyecto; actualiza el explorador.');
    return binding;
  }
  listExplorer(sessionId?: string, directoryId = 'project-root', cursor?: string): Promise<LocalExplorerListing> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId);
    let path = '';
    let offset = 0;
    if (cursor) {
      const page = this.#explorerPages.get(cursor);
      demand(page && page.sessionId === active.sessionId && page.path === (directoryId === 'project-root' ? '' : this.#explorerPath(directoryId, active.sessionId).path), 'STALE_PAGE', 'La página del explorador ya no está vigente.');
      path = page.path; offset = page.offset;
    } else if (directoryId !== 'project-root') {
      const item = this.#explorerPath(directoryId, active.sessionId);
      demand(item.kind === 'directory', 'NOT_DIRECTORY', 'Selecciona una carpeta para navegar.'); path = item.path;
    }
    const result = await active.lease.service.listExplorerDirectory(path, offset);
    demand(result.ok, 'EXPLORER_READ_FAILED', result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    const entries = result.value.entries.map((entry) => {
      const key = entry.path.toLowerCase(); const prior = this.#explorerPaths.get(key);
      const id = prior?.identity === entry.identity ? prior.id : randomUUID();
      this.#explorerPaths.set(key, { id, identity: entry.identity });
      const binding: ExplorerItemBinding = { sessionId: active.sessionId, path: entry.path, identity: entry.identity, kind: entry.kind,
        ...(entry.resourceId ? { resourceId: entry.resourceId } : {}) };
      this.#explorerItems.set(id, binding);
      const { path: _path, identity: _identity, ...publicEntry } = entry;
      return { ...publicEntry, id, path: entry.path };
    });
    const nextCursor = result.value.nextOffset === null ? null : randomUUID();
    if (nextCursor) this.#explorerPages.set(nextCursor, { sessionId: active.sessionId, path, offset: result.value.nextOffset! });
    const mounts = result.value.mounts.map(({ resourceId, ...mount }) => ({ ...mount, id: resourceId }));
    return { sessionId: active.sessionId, directoryId, entries, nextCursor, mounts };
  }); }
  openExplorerItem(itemId: string, sessionId?: string): Promise<LocalExplorerOpen> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId); const item = this.#explorerPath(itemId, active.sessionId);
    demand(item.kind === 'file', 'ITEM_NOT_OPENABLE', 'Este elemento no es un archivo regular o es un enlace bloqueado.');
    const result = await active.lease.service.openExplorerFile(item.path, item.identity);
    demand(result.ok, 'FILE_OPEN_FAILED', result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    return { ...result.value, relativePath: result.value.path };
  }); }
  async #commitExplorer(active: ActiveProjectBinding, action: 'create-file' | 'create-folder' | 'rename' | 'duplicate' | 'trash', input: { sourcePath?: string; targetPath?: string; identity?: string; parentIdentity?: string; content?: string; cleanupDirectory?: boolean }): Promise<void> {
    const prepared = await active.lease.service.prepareExplorerOperation({ operationId: randomUUID(), action,
      ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}), ...(input.targetPath ? { targetPath: input.targetPath } : {}),
      ...(input.identity ? { expectedSourceIdentity: input.identity } : {}), ...(input.parentIdentity ? { targetParentIdentity: input.parentIdentity } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}) });
    demand(prepared.ok, 'FILE_OPERATION_REJECTED', prepared.diagnostics.map((diagnostic) => `${diagnostic.detail}: ${diagnostic.message}`).join('\n'));
    const committed = await active.lease.service.commit(prepared.value);
    demand(committed.ok, 'FILE_OPERATION_FAILED', committed.diagnostics.map((diagnostic) => `${diagnostic.detail}: ${diagnostic.message}`).join('\n'));
    if (input.cleanupDirectory && input.sourcePath) await removeEmptyDirectoryTree(active.lease.service.root, input.sourcePath);
    this.#explorerPages.clear();
  }
  createExplorerItem(parentId: string, name: string, kind: 'file' | 'directory', sessionId?: string): Promise<void> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId); let parent = ''; let parentIdentity: string | undefined;
    if (parentId !== 'project-root') { const item = this.#explorerPath(parentId, active.sessionId); demand(item.kind === 'directory', 'NOT_DIRECTORY', 'Selecciona una carpeta para crear el elemento.'); parent = item.path; parentIdentity = item.identity; }
    demand(typeof name === 'string' && name.length <= 255, 'INVALID_NAME', 'El nombre no es válido.');
    await this.#commitExplorer(active, kind === 'file' ? 'create-file' : 'create-folder', { targetPath: parent ? `${parent}/${name}` : name, ...(parentIdentity ? { parentIdentity } : {}) });
  }); }
  renameExplorerItem(itemId: string, name: string, sessionId?: string): Promise<void> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId); const item = this.#explorerPath(itemId, active.sessionId);
    demand(item.kind !== 'blocked-link', 'LINK_BLOCKED', 'Los enlaces no se renombran desde el explorador.');
    const parent = item.path.split('/').slice(0, -1).join('/');
    await this.#commitExplorer(active, 'rename', { sourcePath: item.path, targetPath: parent ? `${parent}/${name}` : name, identity: item.identity, cleanupDirectory: item.kind === 'directory' });
    this.#explorerItems.delete(itemId); this.#explorerPaths.delete(item.path.toLowerCase());
  }); }
  duplicateExplorerItem(itemId: string, name: string | undefined, sessionId?: string): Promise<void> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId); const item = this.#explorerPath(itemId, active.sessionId);
    demand(item.kind !== 'blocked-link', 'LINK_BLOCKED', 'Los enlaces no se duplican desde el explorador.');
    const originalName = item.path.split('/').at(-1)!;
    const targetName = name?.trim() || `${originalName} copia`;
    const parent = item.path.split('/').slice(0, -1).join('/');
    await this.#commitExplorer(active, 'duplicate', { sourcePath: item.path, targetPath: parent ? `${parent}/${targetName}` : targetName, identity: item.identity });
  }); }
  previewExplorerDelete(itemId: string, sessionId?: string): Promise<LocalExplorerDeletePreview> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId); const item = this.#explorerPath(itemId, active.sessionId);
    demand(item.kind !== 'blocked-link', 'LINK_BLOCKED', 'Los enlaces no se envían a la papelera desde el explorador.');
    const result = await active.lease.service.previewExplorerDelete(item.path, item.identity);
    demand(result.ok, 'DELETE_PREVIEW_FAILED', result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    const token = randomUUID(); this.#explorerDeletes.set(token, { sessionId: active.sessionId, itemId, path: item.path, identity: item.identity });
    return { token, name: item.path.split('/').at(-1)!, uses: result.value.uses, deletable: result.value.deletable, ...(result.value.reason ? { reason: result.value.reason } : {}) };
  }); }
  cancelExplorerDelete(token: string, sessionId?: string): Promise<void> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId); const pending = this.#explorerDeletes.get(token);
    demand(pending?.sessionId === active.sessionId, 'STALE_DELETE', 'La confirmación de borrado ya no está vigente.'); this.#explorerDeletes.delete(token);
  }); }
  confirmExplorerDelete(token: string, sessionId?: string): Promise<void> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId); const pending = this.#explorerDeletes.get(token);
    demand(pending?.sessionId === active.sessionId, 'STALE_DELETE', 'La confirmación de borrado ya no está vigente.');
    const item = this.#explorerPath(pending.itemId, active.sessionId);
    const preview = await active.lease.service.previewExplorerDelete(pending.path, pending.identity);
    demand(preview.ok, 'DELETE_PREVIEW_FAILED', preview.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    demand(preview.value.deletable, preview.value.uses.length ? 'RESOURCE_IN_USE' : 'PERMISSION_DENIED', preview.value.reason ?? 'El borrado no está autorizado.');
    await this.#commitExplorer(active, 'trash', { sourcePath: pending.path, identity: item.identity, cleanupDirectory: item.kind === 'directory' }); this.#explorerDeletes.delete(token);
    this.#explorerItems.delete(pending.itemId); this.#explorerPaths.delete(pending.path.toLowerCase());
  }); }
  copyExplorerPath(itemId: string, kind: 'absolute' | 'relative', sessionId?: string): Promise<string> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId); const item = this.#explorerPath(itemId, active.sessionId);
    demand(item.kind !== 'blocked-link', 'LINK_BLOCKED', 'No se copia la ruta de un enlace bloqueado.');
    const result = await active.lease.service.validateExplorerEntry(item.path, item.identity, item.kind === 'directory' ? 'directory' : 'file');
    demand(result.ok, result.diagnostics[0]?.code ?? 'FILE_PATH_UNAVAILABLE', result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    return kind === 'relative' ? item.path : resolve(active.lease.service.root, ...item.path.split('/'));
  }); }
  openMountedExplorerResource(resourceId: string, sessionId?: string): Promise<LocalExplorerOpen> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId);
    const record = active.lease.service.state.project.snapshot.records.find((candidate) => candidate.kind === 'resource' && candidate.value.id.toLowerCase() === resourceId.toLowerCase());
    demand(record?.kind === 'resource' && record.value.kind === 'mounted-file', 'MOUNT_MISSING', 'La referencia montada ya no existe.');
    const result = await active.lease.service.openResource(resourceId);
    demand(result.ok, 'MOUNT_OPEN_FAILED', result.diagnostics.map((diagnostic) => `${diagnostic.detail}: ${diagnostic.message}`).join('\n'));
    if (result.value.bytes.length > 2 * 1024 * 1024) throw new LocalProjectError('PREVIEW_SIZE_LIMIT', 'El archivo montado supera el límite de vista previa de 2 MiB.');
    let text: string | null = null; try { text = new TextDecoder('utf-8', { fatal: true }).decode(result.value.bytes); } catch { /* Binary reference. */ }
    return { name: record.value.path.split('/').at(-1) ?? record.value.path, relativePath: record.value.path, text, size: result.value.bytes.length,
      mediaType: record.value.mediaType ?? 'application/octet-stream' };
  }); }
  copyMountedExplorerPath(resourceId: string, kind: 'absolute' | 'relative', sessionId?: string): Promise<string> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId);
    const record = active.lease.service.state.project.snapshot.records.find((candidate) => candidate.kind === 'resource' && candidate.value.id.toLowerCase() === resourceId.toLowerCase());
    demand(record?.kind === 'resource' && record.value.kind === 'mounted-file', 'MOUNT_MISSING', 'La referencia montada ya no existe.');
    const access = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
      projectId: active.projectId, operation: 'read-resource', paths: [], refs: [{ kind: 'resource', id: record.value.id }], resources: [record.value] });
    demand(access.allowed, 'PERMISSION_DENIED', 'El broker denegó el acceso a la ruta montada.');
    const binding = this.options.host.capabilities.getLocalMount({ root: active.lease.service.root, projectId: active.projectId, mountId: record.value.mountId });
    demand(binding?.status === 'available', 'MOUNT_UNAVAILABLE', 'El montaje no está disponible; vuelve a localizar su carpeta.');
    validateMountRelativePath(record.value.path);
    demand(await inspectLocalMountFile(binding, record.value.path) === 'available', 'MOUNT_UNAVAILABLE', 'El archivo montado ya no está disponible o su ruta cambió; la referencia se conserva.');
    if (kind === 'relative') return record.value.path;
    return resolve(binding.canonicalRoot, ...record.value.path.split('/'));
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
