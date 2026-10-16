import { access, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { c4Category, isC4Diagram, validC4Operation, type C4Category, type C4Change, type C4Operation } from '@a3/domain';
import { isIotCircuit, validIotCircuitOperation, type IotCircuitData } from '@a3/domain/iot-circuit';
import { projectC4Canvas, type CanvasC4State } from './c4-canvas.js';
import { umlData, umlKind, validUmlOperation, type UmlChange, type UmlOperation } from '@a3/domain';
import { projectUmlCanvas, type CanvasUmlState } from './uml-canvas.js';
import { erData, erTable, validErOperation, type ErChange, type ErOperation } from '@a3/domain';
import { MERMAID_SOURCE_TYPE, mermaidSourceProperties } from '@a3/domain/mermaid-source';
import { PLANTUML_SOURCE_LIMIT, PLANTUML_SOURCE_TYPE, plantUmlSourceProperties, supportsPlantUmlSourceRenderer } from '@a3/domain/plantuml-source';
import { buildMermaidImportRecords, parseMermaidImport, requiredMermaidMapping, type MermaidImportGraph, type MermaidImportIdentityMap, type MermaidImportIssue } from '@a3/domain/mermaid-import';
import { parsePlantUmlClassImport } from '@a3/domain/plantuml-import';
import { parseStructurizrDslImport, parseStructurizrJsonImport, type StructurizrImportGraph, type StructurizrImportIssue } from '@a3/domain/structurizr-import';
import { STRUCTURIZR_DSL_SOURCE_TYPE, STRUCTURIZR_JSON_SOURCE_TYPE, STRUCTURIZR_SOURCE_LIMIT, structurizrSourceProperties, type StructurizrSourceFormat } from '@a3/domain/structurizr-source';
import { projectErCanvas, type CanvasErState } from './er-canvas.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { CONTENT_NODE_CATALOG, contentNodeDefinition, conceptualNodeKind, conceptualRelationData, isConceptualRelation, isIotComponent, iotCatalogEntry, defaultRegistry, inspectMarkdownParse, inspectMarkdownSource, isBuiltinContentNodeType, refKey, refOf, revisionsOf, validateSnapshot, type ConceptualNodeKind, type ConceptualRelationKind, type ContentNodeKind, type ContentEffect, type CreateContentNodeSource, type DocumentRef, type DomainCommand, type DomainRecord, type Drawing, type DrawingParameters, type DrawingPoint, type DuplicateSelection, type Entity, type ExtensionMap, type Group, type GroupMember, type JsonValue, type Placement, type Project, type RecordChange, type ReversibleCanvasCommand, type TypeRegistry, type VisualEdge, type Workspace } from '@a3/domain';
import { decodeDocument, serializeRecord, sha256 } from './codec.js';
import { decodeCodeText, encodeCodeText, codeLineEnding, type CodeDocument, type CodeOpenTarget } from './code-text.js';
import { initialPageView, insertFocusTab, readWorkspaceSession, writeWorkspaceSession, validCanvasView, validPageView, type WorkspaceSession, type WorkspaceSessionAction, type PageReference } from './workspace-session.js';
import { isProjectCapabilityBroker } from './capabilities.js';
import { defaultShortcuts, validateShortcuts, type ShortcutBindings } from '@a3/domain';
import { resolvePageLink, type NavigationIndex, type PageLink } from './navigation.js';
import { absentPath, ensureDirectories, installExclusive, writeExclusive } from './write-io.js';
import { checkedPath, fileBytes } from './reader.js';
import { acquireOwnership, projectIdentity, type Ownership } from './ownership.js';
import { jsonBytes, ProgressLog, progressProtocol, transactionRoot } from './progress.js';
import { recoverTransactions } from './recovery.js';
import { openProjectService, type ProjectLease } from './service.js';
import { inspectLocalMountFile, readLocalMountFile, validateMountRelativePath } from './mounts.js';
import type { ExplorerDeletePreview, ExplorerDirectoryPage, ExplorerMountEntry, ExplorerOpenResult, IntentEntry, ServiceOptions, StoreHost, WriteIntent } from './service-types.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function detectedMediaType(resource: Extract<DomainRecord, { kind: 'resource' }>['value']): string | undefined {
  if (resource.mediaType) return resource.mediaType;
  if (resource.kind === 'remote-url') return 'text/uri-list';
  const extension = resource.path.split('/').at(-1)?.toLowerCase().split('.').at(-1);
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav',
    ogg: 'audio/ogg', flac: 'audio/flac', md: 'text/markdown', txt: 'text/plain', json: 'application/json' } as Record<string, string>)[extension ?? ''];
}
function resourceDescriptor(record: Extract<DomainRecord, { kind: 'resource' }>): CanvasResourceDescriptor {
  const resource = record.value;
  const mediaType = detectedMediaType(resource);
  if (resource.kind === 'remote-url') {
    let label = 'Referencia externa';
    try { label = new URL(resource.url).hostname; } catch { /* The domain validator reports malformed URLs. */ }
    return { id: resource.id, kind: resource.kind, label, ...(mediaType ? { mediaType } : {}), url: resource.url };
  }
  return { id: resource.id, kind: resource.kind, label: basename(resource.path), ...(mediaType ? { mediaType } : {}) };
}
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
  restoreNotice?: string;
}
export interface WorkspaceViewport { x: number; y: number; zoom: number; }
export interface CanvasEntitySummary {
  c4Category?: C4Category;
  id: string; revision: number; type: string; typeVersion: string; title: string; properties: Entity['properties']; ports: Entity['ports'];
  contentResourceId?: string; contentResource?: CanvasResourceDescriptor; typeAvailable: boolean;
}
export interface CanvasResourceDescriptor { id: string; kind: 'project-file' | 'mounted-file' | 'remote-url'; label: string; mediaType?: string; url?: string; }
export interface CanvasResourceChoice extends CanvasResourceDescriptor {}
export interface CanvasContentNodeInput {
  kind: ContentNodeKind; title: string; position: { x: number; y: number }; value?: string; url?: string; resourceId?: string;
  description?: string; altText?: string; language?: string; bytes?: Uint8Array; mediaType?: string; mountId?: string; mountedPath?: string;
  dropMode?: 'copy' | 'reference'; dropMountId?: string; dropPath?: string;
}
export interface CanvasEntityChoice { id: string; type: string; typeVersion: string; title: string; }
export interface CanvasPlacementView {
  id: string; revision: number; entityId: string; position: Placement['position']; size: Placement['size']; style: Placement['style'];
}
export type CanvasVisualEdgeView = Pick<VisualEdge, 'id' | 'revision' | 'sourcePlacementId' | 'targetPlacementId' | 'label' | 'waypoints' | 'style'>;
export type CanvasVisualEdgePatch = Partial<Pick<VisualEdge, 'sourcePlacementId' | 'targetPlacementId' | 'label' | 'waypoints' | 'style'>>;
export interface CanvasConceptualRelationView {
  id: string; relationId: string; relationRevision: number; revision: number; sourcePlacementId: string; targetPlacementId: string;
  sourceEntityId: string; targetEntityId: string; label: string; kind?: ConceptualRelationKind;
}
export type CanvasDrawingView = Pick<Drawing, 'id' | 'revision' | 'points' | 'parameters' | 'style'>;
export type CanvasDrawingPatch = Omit<Partial<Pick<Drawing, 'points' | 'parameters' | 'style'>>, 'parameters'> & { parameters?: Partial<DrawingParameters> };
export type CanvasGroupView = Pick<Group, 'id' | 'revision' | 'name' | 'members'> & { collapsed: boolean };
export interface CanvasPlacementMove { id: string; expectedRevision: number; position: { x: number; y: number }; }
export interface CanvasPlacementViewPatch { id: string; expectedRevision: number; position?: { x: number; y: number }; style?: ExtensionMap; }
export interface CanvasSelectionRef { id: string; expectedRevision: number; }
export interface CanvasSelection { placements: CanvasSelectionRef[]; drawings: CanvasSelectionRef[]; groups: CanvasSelectionRef[]; }
export interface CanvasResourcePreview { entityId: string; resourceId: string; text: string | null; state: 'ready' | 'too-large' | 'unavailable' | 'binary'; mediaType?: string; bytes?: Uint8Array; }
/** Main-process-only read context for the pinned renderer; never expose its absolute paths to the renderer. */
export interface PlantUmlRenderInput { source: string; sourceHash: string; workingDirectory: string; includeRoots: readonly string[]; }
export interface CanvasMermaidImportItem { key: string; kind: string; title: string; action: 'create' | 'update' | 'unchanged' | 'conflict'; }
export interface CanvasMermaidImportPreview {
  token: string; sourceEntityId: string; sourceRevision: number; resourceId: string; family: MermaidImportGraph['family']; mode: 'new' | 'update';
  sourceHash: string; authority: 'source' | 'a3-model'; converted: readonly CanvasMermaidImportItem[]; unconverted: readonly MermaidImportIssue[];
  missingResources: readonly MermaidImportIssue[]; idConflicts: readonly MermaidImportIssue[]; staleSourceKeys: readonly string[];
  mapping: Readonly<MermaidImportIdentityMap>; canApply: boolean; message: string;
}
export type CanvasPlantUmlImportPreview = Omit<CanvasMermaidImportPreview, 'family'> & { family: 'class' | null };
export interface CanvasStructurizrImportView { key: string; kind: string; title: string; workspaceId: string; elements: number; relations: number; action: 'create' | 'update' | 'unchanged'; }
export interface CanvasStructurizrImportPreview {
  token: string; sourceEntityId: string; sourceRevision: number; resourceId: string; format: StructurizrSourceFormat; mode: 'new' | 'update';
  sourceHash: string; authority: 'source' | 'a3-model'; converted: readonly CanvasMermaidImportItem[]; views: readonly CanvasStructurizrImportView[];
  unconverted: readonly StructurizrImportIssue[]; missingResources: readonly StructurizrImportIssue[]; idConflicts: readonly StructurizrImportIssue[];
  staleSourceKeys: readonly string[]; mapping: Readonly<Record<string, string>>; canApply: boolean; message: string;
}
export interface MarkdownDocument {
  entityId: string; entityRevision: number; resourceId: string; revision: number; hash: string; content: string;
  canWrite: boolean; readOnlyReason: string | null; unsupported: readonly string[];
}
export interface MarkdownAsset { reference: string; mediaType: string; bytes: Uint8Array; }
export type MenuPermissions = Record<'read' | 'document' | 'diagram' | 'delete', { allowed: boolean; reason: string }>;
export interface LocalCanvasWorkspace {
  er: CanvasErState;
  uml: CanvasUmlState;
  c4: CanvasC4State;
  sessionId: string; workspaceId: string; name: string; revision: number;
  viewport: WorkspaceViewport; canWrite: boolean; pending: boolean; entities: readonly CanvasEntitySummary[]; entityChoices: readonly CanvasEntityChoice[];
  resourceChoices: readonly CanvasResourceChoice[]; placements: readonly CanvasPlacementView[]; visualEdges: readonly CanvasVisualEdgeView[];
  conceptualRelations: readonly CanvasConceptualRelationView[]; drawings: readonly CanvasDrawingView[]; groups: readonly CanvasGroupView[];
  history: { canUndo: boolean; canRedo: boolean; undoRequiresDelete: boolean; redoRequiresDelete: boolean; deleteAvailable: boolean };
  canDeleteEdges: boolean; canDeleteRelations: boolean; canDeleteDrawings: boolean; canConvertDrawings: boolean;
}
export interface LocalExplorerEntry extends Omit<ExplorerDirectoryPage['entries'][number], 'path' | 'identity'> { id: string; path: string; }
export interface LocalExplorerMount extends Omit<ExplorerMountEntry, 'resourceId'> { id: string; }
export interface LocalExplorerListing { sessionId: string; directoryId: string; entries: readonly LocalExplorerEntry[]; nextCursor: string | null; mounts: readonly LocalExplorerMount[]; }
export interface LocalExplorerOpen extends Omit<ExplorerOpenResult, 'path'> { relativePath: string; }
export interface LocalExplorerDeletePreview extends Omit<ExplorerDeletePreview, 'path'> { token: string; name: string; }
interface ExplorerItemBinding { sessionId: string; path: string; identity: string; kind: 'file' | 'directory' | 'blocked-link'; resourceId?: string; }
interface ExplorerPageBinding { sessionId: string; path: string; offset: number; }
interface CodeBinding { sessionId: string; path: string; resourceId?: string; entityId?: string; entityRevision?: number; identity?: string; hash?: string; revision?: number | null; }
interface ExplorerDeleteBinding { sessionId: string; itemId: string; path: string; identity: string; }
interface ActiveProjectBinding { lease: ProjectLease; sessionId: string; projectId: string; name: string; rootIdentity: string; }
interface Initialization {
  root: string; rootIdentity: string; project: Project; workspace: Workspace;
}
interface Catalog { version: 1; recents: RecentProject[]; pending: Initialization[]; resumeId?: string; }
interface PreviewData { public: ProjectInitializationPreview; parent: string; identity: string; initialization: Initialization; resume: boolean; }
interface CanvasHistoryPending { action: 'push' | 'undo' | 'redo'; event: ReversibleCanvasCommand; cursorBefore: number; }
interface CanvasHistoryState {
  schemaVersion: '1.0.0'; projectId: string; rootIdentity: string; workspaceId: string;
  entries: ReversibleCanvasCommand[]; cursor: number; revisionFloors: Record<string, number>; pending?: CanvasHistoryPending; blocked?: string;
}
interface MermaidImportPreviewBinding {
  sessionId: string; workspaceId: string; sourceEntityId: string; sourceRevision: number; resourceId: string; sourceHash: string;
  family: 'flowchart' | 'class' | 'er'; mode: 'new' | 'update'; graph: MermaidImportGraph; mapping: MermaidImportIdentityMap; records: DomainRecord[]; expiresAt: number;
}
interface PlantUmlImportPreviewBinding {
  sessionId: string; workspaceId: string; sourceEntityId: string; sourceRevision: number; resourceId: string; sourceHash: string;
  family: 'class'; mode: 'new' | 'update'; graph: MermaidImportGraph; mapping: MermaidImportIdentityMap; records: DomainRecord[]; expiresAt: number;
}
interface StructurizrImportPreviewBinding {
  sessionId: string; workspaceId: string; sourceEntityId: string; sourceRevision: number; resourceId: string; sourceHash: string;
  format: StructurizrSourceFormat; mode: 'new' | 'update'; graph: StructurizrImportGraph; mapping: Record<string, string>;
  records: DomainRecord[]; views: CanvasStructurizrImportView[]; expiresAt: number;
}
function structurizrMappingKeys(graph: StructurizrImportGraph): string[] {
  const keys = graph.elements.map((item) => `entity:${item.key}`);
  const relations = new Set(graph.views.flatMap((view) => view.relations));
  keys.push(...graph.relations.filter((item) => relations.has(item.key)).map((item) => `relation:${item.key}`));
  for (const view of graph.views) {
    keys.push(`workspace:${view.key}`, `diagram:${view.key}`);
    keys.push(...view.elements.map((element) => `placement:${view.key}|${element}`));
    keys.push(...view.relations.map((relation) => `relationView:${view.key}|${relation}`));
  }
  return [...new Set(keys)];
}
function buildStructurizrImportRecords(graph: StructurizrImportGraph, sourceEntityId: string, mapping: Record<string, string>): DomainRecord[] {
  const marker = (sourceKey: string): ExtensionMap => ({ 'a3.structurizr.import': { sourceEntityId, sourceKey } });
  const entityId = (key: string): string => {
    const value = mapping[`entity:${key}`]; if (!value) throw new Error(`No hay ID A3 para ${key}.`); return value;
  };
  const relationKeys = new Set(graph.views.flatMap((view) => view.relations));
  const records: DomainRecord[] = graph.elements.map((item) => {
    const data: Record<string, unknown> = { description: item.description, technology: item.technology, url: item.url, external: item.external };
    if (item.parentKey && mapping[`entity:${item.parentKey}`]) data.parentId = mapping[`entity:${item.parentKey}`];
    if (item.instanceOfKey && mapping[`entity:${item.instanceOfKey}`]) data.instanceOfId = mapping[`entity:${item.instanceOfKey}`];
    if (item.environment) data.environment = item.environment;
    return { kind: 'entity', value: { schemaVersion: '1.0.0', id: entityId(item.key), revision: 1, type: `a3.c4.${item.category}`,
      typeVersion: '1.0.0', title: item.title, tags: [], properties: { 'a3.c4': data as JsonValue }, ports: [], bindings: {}, extensions: marker(item.key) } };
  });
  for (const item of graph.relations.filter((relation) => relationKeys.has(relation.key))) {
    const id = mapping[`relation:${item.key}`]; if (!id) throw new Error(`No hay ID A3 para ${item.key}.`);
    records.push({ kind: 'relation', value: { schemaVersion: '1.0.0', id, revision: 1, type: 'a3.c4.relationship', typeVersion: '1.0.0',
      source: { entityId: entityId(item.sourceKey) }, target: { entityId: entityId(item.targetKey) },
      properties: { 'a3.c4': { description: item.description || 'relates to', protocol: item.technology } }, extensions: marker(item.key) } });
  }
  for (const view of graph.views) {
    const workspaceId = mapping[`workspace:${view.key}`], diagramId = mapping[`diagram:${view.key}`];
    if (!workspaceId || !diagramId) throw new Error(`No hay ID A3 para la vista ${view.key}.`);
    const viewData: Record<string, unknown> = { version: '1.0.0', kind: view.kind, workspaceId, steps: [] };
    if (view.scopeKey && mapping[`entity:${view.scopeKey}`]) viewData.scopeEntityId = mapping[`entity:${view.scopeKey}`];
    if (view.environment) viewData.environment = view.environment;
    records.push({ kind: 'workspace', value: { schemaVersion: '1.0.0', id: workspaceId, revision: 1,
      name: `${graph.name || 'Structurizr'} · ${view.title}`.slice(0, 120), viewport: { x: 0, y: 0, zoom: 1 },
      properties: { 'a3.c4.diagram-id': diagramId }, extensions: marker(view.key) } });
    records.push({ kind: 'entity', value: { schemaVersion: '1.0.0', id: diagramId, revision: 1, type: 'a3.c4.diagram', typeVersion: '1.0.0',
      title: view.title, tags: [], properties: { 'a3.diagram.authority': 'a3-model', 'a3.c4.view': viewData as JsonValue }, ports: [], bindings: {}, extensions: marker(view.key) } });
    const placementIds = new Map<string, string>();
    view.elements.forEach((key, index) => {
      const placementId = mapping[`placement:${view.key}|${key}`]; if (!placementId) throw new Error(`No hay placement A3 para ${key} en ${view.key}.`);
      placementIds.set(key, placementId);
      const sourcePosition = view.positions[key];
      const position = sourcePosition ?? { x: (index % 4) * 360, y: Math.floor(index / 4) * 260 };
      records.push({ kind: 'placement', workspaceId, value: { schemaVersion: '1.0.0', id: placementId, revision: 1, entityId: entityId(key),
        position: { x: Math.max(-999_999, Math.min(999_999, position.x)), y: Math.max(-999_999, Math.min(999_999, position.y)) },
        size: { width: 300, height: 210 }, style: {}, extensions: marker(`${view.key}|${key}`) } });
    });
    for (const relationKey of view.relations) {
      const relation = graph.relations.find((item) => item.key === relationKey); if (!relation) continue;
      const relationId = mapping[`relation:${relationKey}`], relationViewId = mapping[`relationView:${view.key}|${relationKey}`];
      const sourcePlacementId = placementIds.get(relation.sourceKey), targetPlacementId = placementIds.get(relation.targetKey);
      if (!relationId || !relationViewId || !sourcePlacementId || !targetPlacementId) throw new Error(`No se pudieron resolver los extremos de ${relationKey} en ${view.key}.`);
      records.push({ kind: 'relation-view', workspaceId, value: { schemaVersion: '1.0.0', id: relationViewId, revision: 1, relationId,
        sourcePlacementId, targetPlacementId, waypoints: [], style: {}, extensions: marker(`${view.key}|${relationKey}`) } });
    }
  }
  return records;
}
function historyRequiresDelete(event: ReversibleCanvasCommand, direction: 'undo' | 'redo'): boolean {
  const removesRecord = event.changes.some((change) => {
    const source = direction === 'undo' ? change.after : change.before;
    const target = direction === 'undo' ? change.before : change.after;
    return !!source && !target;
  });
  const removesResource = event.contentEffects.some((effect) => direction === 'undo'
    ? effect.kind === 'create' || effect.kind === 'create-binary' || effect.kind === 'copy'
    : effect.kind === 'remove');
  return removesRecord || removesResource;
}
const canvasHistoryLimit = 50;
const canvasHistoryByteLimit = 16 * 1024 * 1024;
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
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function comparableHistoryRecord(value: DomainRecord | null): string {
  if (!value) return 'null';
  const copy = structuredClone(value); copy.value.revision = 0; return stableJson(copy);
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
  #focusSession: WorkspaceSession | undefined;
  #restoreNotice: string | undefined;
  #explorerSessionId = '';
  #explorerItems = new Map<string, ExplorerItemBinding>();
  #explorerPaths = new Map<string, { id: string; identity: string }>();
  #explorerPages = new Map<string, ExplorerPageBinding>();
  #explorerDeletes = new Map<string, ExplorerDeleteBinding>();
  #codeDocuments = new Map<string, CodeBinding>();
  #viewportDrafts = new Map<string, { sessionId: string; expectedRevision: number; viewport: WorkspaceViewport }>();
  #canvasHistories = new Map<string, CanvasHistoryState>();
  #mermaidImportPreviews = new Map<string, MermaidImportPreviewBinding>();
  #plantUmlImportPreviews = new Map<string, PlantUmlImportPreviewBinding>();
  #structurizrImportPreviews = new Map<string, StructurizrImportPreviewBinding>();
  #resetExplorerBindings = (): void => {
    this.#explorerSessionId = ''; this.#explorerItems.clear(); this.#explorerPaths.clear(); this.#explorerPages.clear(); this.#explorerDeletes.clear(); this.#codeDocuments.clear();
  };
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
      demand(value.resumeId === undefined || typeof value.resumeId === 'string' && uuid.test(value.resumeId), 'LOCAL_CATALOG_INVALID', 'Referencia de restauración local inválida.');
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
    return { sequence: ++this.#sequence, active: this.#summary(), recents, preview: this.#preview ? structuredClone(this.#preview.public) : null, ...(this.#restoreNotice ? { restoreNotice: this.#restoreNotice } : {}) };
  }
  getState(): Promise<LocalProjectsState> { return this.#queue(() => this.#state()); }
  restoreLastProject(): Promise<LocalProjectsState> { return this.#queue(async () => {
    if (!this.#active && this.#catalog.resumeId) {
      const recent = this.#catalog.recents.find((r) => r.id === this.#catalog.resumeId);
      if (recent) try {
        const allowed = this.options.host.capabilities.authorizeAccess({ root: recent.root, projectId: recent.projectId, actor: this.options.host.authenticatedActor,
          operation: 'open-project', paths: ['a3.project.json'], refs: [], resources: [] });
        demand(allowed.allowed, 'PERMISSION_DENIED', 'La reapertura requiere aprobación local; abre el proyecto desde Recientes.');
        await this.#openFolder(recent.root, recent.projectId);
      } catch { this.#restoreNotice = 'No se pudo reabrir el último proyecto. Conservamos su referencia; usa Recientes o Localizar.'; }
    }
    return this.#state();
  }); }
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
    const candidate = await openProjectService(root, { host: this.options.host, registry: this.options.registry ?? defaultRegistry(), ...(this.options.fault ? { fault: this.options.fault } : {}) });
    demand(candidate.ok, 'OPEN_FAILED', candidate.diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n'));
    const name = typeof value.name === 'string' ? value.name : 'Proyecto sin nombre';
    const previous = this.#active;
    const previousCatalog = this.#catalog;
    try {
      const old = this.#catalog.recents.find((r) => r.projectId.toLowerCase() === projectId.toLowerCase() && (r.root.toLowerCase() === root.toLowerCase() || expectedId));
      const recentId = old?.id ?? randomUUID();
      this.#catalog = { version: 1, resumeId: recentId,
        recents: [{ id: recentId, projectId, name, root, lastOpened: new Date().toISOString() }, ...this.#catalog.recents.filter((r) => r !== old && r.root.toLowerCase() !== root.toLowerCase())].slice(0, 30),
        pending: this.#catalog.pending.filter((p) => p.root.toLowerCase() !== root.toLowerCase()) };
      await this.#persist();
      await previous?.lease.close();
      this.#active = { lease: candidate.value, sessionId: randomUUID(), projectId, name, rootIdentity: await projectIdentity(root) };
      this.#focusSession = undefined; this.#restoreNotice = undefined;
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
    const resumeId = this.#catalog.resumeId; delete this.#catalog.resumeId;
    try { await this.#persist(); } catch (error) { if (resumeId) this.#catalog.resumeId = resumeId; throw error; }
    this.#focusSession = undefined;
    await this.#active.lease.close(); this.#active = undefined; this.#preview = undefined; this.#nameDraft = undefined; this.#resetExplorerBindings(); return this.#state();
  }); }
  async #loadFocusSession(active: ActiveProjectBinding): Promise<WorkspaceSession> {
    if (this.#focusSession) return this.#focusSession;
    try {
      const saved = await readWorkspaceSession(this.#stateRoot, active.projectId, active.rootIdentity);
      if (saved) return this.#focusSession = saved;
      const workspace = active.lease.service.state.project.snapshot.records.find((r) => r.kind === 'workspace');
      const state: WorkspaceSession = { schemaVersion: '1.0.0', projectId: active.projectId, rootIdentity: active.rootIdentity, revision: 0, tabs: [], selectedId: null };
      if (workspace?.kind === 'workspace') insertFocusTab(state, { id: randomUUID(), kind: 'workspace', workspaceId: workspace.value.id, title: workspace.value.name.slice(0, 512), view: null });
      return this.#focusSession = state;
    } catch (error) { throw new LocalProjectError('LOCAL_SESSION_INVALID', error instanceof Error ? error.message : 'No se pudo leer la sesión local.'); }
  }
  navigationIndex(sessionId: string): Promise<NavigationIndex> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId), result = await active.lease.service.navigationIndex();
    demand(result.ok, result.diagnostics[0]?.code ?? 'INDEX_UNAVAILABLE', result.diagnostics.map((d) => d.message).join('\n'));
    return result.value;
  }); }
  shortcuts(input?: ShortcutBindings | 'reset'): Promise<ShortcutBindings> { return this.#queue(async () => {
    await this.#load(); const path = join(this.#stateRoot, 'shortcuts.json');
    if (input === undefined) {
      try { const info = await lstat(path); demand(info.isFile() && !info.isSymbolicLink() && info.size <= 16384, 'SHORTCUTS_INVALID', 'El archivo local de atajos no es válido.');
        const handle = await open(path, 'r'); let parsed: unknown; try { parsed = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
        const result = validateShortcuts(parsed); demand(result.ok, 'SHORTCUTS_INVALID', result.ok ? '' : result.message); return result.bindings;
      } catch (error) { if (missing(error)) return defaultShortcuts(); throw error; }
    }
    const result = validateShortcuts(input === 'reset' ? defaultShortcuts() : input); demand(result.ok, 'SHORTCUT_COLLISION', result.ok ? '' : result.message);
    const temp = join(this.#stateRoot, `${randomUUID()}.tmp`), handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(jsonBytes(result.bindings)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path); return result.bindings;
  }); }
  async resolvePageLink(sessionId: string, sourceId: string, target: string, kind: 'wiki' | 'markdown'): Promise<Omit<PageLink, 'start' | 'end' | 'label'>> {
    return resolvePageLink(await this.navigationIndex(sessionId), sourceId, target, kind);
  }
  menuPermissions(sessionId: string): Promise<MenuPermissions> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId), capabilities = { read: 'project.read', document: 'document.edit', diagram: 'diagram.edit', delete: 'delete' } as const;
    return Object.fromEntries(Object.entries(capabilities).map(([name, capability]) => {
      const decision = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root, projectId: active.projectId,
        operation: name === 'read' ? 'read-resource' : 'write', paths: [], refs: [], resources: [], requiredCapabilities: [capability], stage: 'prepare' });
      const state = active.lease.service.state, allowed = decision.allowed && (name === 'read' || state.mode === 'writer' && !state.externalConflict);
      return [name, { allowed, reason: allowed ? '' : `${capability}: ${decision.allowed ? state.externalConflict ? 'Cambios externos pendientes de resolver' : 'Proyecto en solo lectura' : decision.reason}` }];
    })) as MenuPermissions;
  }); }
  renamePage(sessionId: string, entityId: string, expectedRevision: number, title: string): Promise<void> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId), prepared = await active.lease.service.preparePageRename({ operationId: randomUUID(), entityId, expectedRevision, title });
    demand(prepared.ok, prepared.diagnostics[0]?.code ?? 'PAGE_RENAME_REJECTED', prepared.diagnostics.map((d) => d.message).join('\n'));
    const applied = await active.lease.service.commit(prepared.value); demand(applied.ok, applied.diagnostics[0]?.code ?? 'PAGE_RENAME_FAILED', applied.diagnostics.map((d) => d.message).join('\n'));
    if (this.#focusSession) { const next = structuredClone(this.#focusSession); for (const tab of next.tabs) if (tab.kind === 'page' && tab.entityId === entityId) tab.title = title.trim(); next.revision++; await writeWorkspaceSession(this.#stateRoot, next); this.#focusSession = next; }
  }); }
  movePage(sessionId: string, entityId: string, expectedRevision: number, destination: string): Promise<void> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId), snapshot = active.lease.service.state.project.snapshot;
    const entity = snapshot.records.find((r) => r.kind === 'entity' && r.value.id === entityId);
    demand(entity?.kind === 'entity' && entity.value.revision === expectedRevision, 'REVISION_CONFLICT', 'La página cambió; relee antes de mover.');
    const resource = snapshot.records.find((r) => r.kind === 'resource' && r.value.id === entity.value.contentResourceId);
    demand(resource?.kind === 'resource' && resource.value.kind === 'project-file', 'PAGE_READ_ONLY', 'La referencia externa no se puede mover.');
    demand(destination.toLowerCase().endsWith('.md'), 'MARKDOWN_PATH_REQUIRED', 'El destino debe ser una ruta relativa Markdown dentro del proyecto.');
    await this.#commitExplorer(active, 'rename', { sourcePath: resource.value.path, targetPath: destination });
  }); }
  workspaceSession(sessionId: string, action: WorkspaceSessionAction, expectedRevision?: number): Promise<WorkspaceSession> {
    return this.#queue(async () => {
      const active = this.#active; demand(active?.sessionId === sessionId, 'STALE_SESSION', 'Las pestañas pertenecen a otra sesión del proyecto.');
      const current = await this.#loadFocusSession(active);
      if (action.action === 'load') return structuredClone(current);
      demand(expectedRevision === current.revision, 'SESSION_REVISION_CONFLICT', 'La sesión local cambió; recarga las pestañas antes de reintentar.');
      const next = structuredClone(current), snapshot = active.lease.service.state.project.snapshot;
      if (action.action === 'open-page') {
        const entity = snapshot.records.find((r) => r.kind === 'entity' && r.value.id === action.entityId);
        demand(entity?.kind === 'entity' && ['a3.core.page', 'a3.content.short-text', 'a3.content.markdown'].includes(entity.value.type) && entity.value.contentResourceId, 'PAGE_MISSING', 'La página no tiene una referencia Markdown; sus datos se conservan.');
        insertFocusTab(next, { id: randomUUID(), kind: 'page', entityId: entity.value.id, resourceId: entity.value.contentResourceId, title: entity.value.title.slice(0, 512), view: initialPageView() }, action.anotherView);
      } else if (action.action === 'open-workspace') {
        const workspace = snapshot.records.find((r) => r.kind === 'workspace' && r.value.id === action.workspaceId);
        demand(workspace?.kind === 'workspace', 'WORKSPACE_MISSING', 'El workspace ya no está disponible.');
        insertFocusTab(next, { id: randomUUID(), kind: 'workspace', workspaceId: workspace.value.id, title: workspace.value.name.slice(0, 512), view: null });
      } else if (action.action === 'reorder') {
        demand(action.tabIds.length === next.tabs.length && new Set(action.tabIds).size === next.tabs.length && action.tabIds.every((id) => next.tabs.some((t) => t.id === id)), 'INVALID_TAB_ORDER', 'El orden debe incluir exactamente las pestañas actuales.');
        next.tabs = action.tabIds.map((id) => next.tabs.find((t) => t.id === id)!);
      } else {
        const index = next.tabs.findIndex((tab) => tab.id === action.tabId), tab = next.tabs[index];
        demand(tab, 'TAB_MISSING', 'La pestaña ya se cerró.');
        if (action.action === 'activate') next.selectedId = tab.id;
        else if (action.action === 'close') { next.tabs.splice(index, 1); if (next.selectedId === tab.id) next.selectedId = next.tabs[Math.min(index, next.tabs.length - 1)]?.id ?? null; }
        else if (action.action === 'view') {
          demand(tab.kind === 'page' ? validPageView(action.view) : validCanvasView(action.view), 'INVALID_VIEW_STATE', 'La posición o selección de la vista no es válida.');
          if (tab.kind === 'page' && validPageView(action.view)) tab.view = structuredClone(action.view);
          else if (tab.kind === 'workspace' && validCanvasView(action.view)) tab.view = { ...action.view };
        }
      }
      next.revision++;
      try { await writeWorkspaceSession(this.#stateRoot, next); } catch { throw new LocalProjectError('LOCAL_SESSION_SAVE_FAILED', 'No se guardó la sesión local; las pestañas anteriores y los documentos se conservan.'); }
      this.#focusSession = next; return structuredClone(next);
    });
  }
  pageReference(sessionId: string, tabId: string): Promise<PageReference> { return this.#queue(async () => {
    const active = this.#active; demand(active?.sessionId === sessionId, 'STALE_SESSION', 'La sesión cambió.');
    const state = await this.#loadFocusSession(active), tab = state.tabs.find((t) => t.id === tabId);
    demand(tab?.kind === 'page', 'TAB_MISSING', 'Selecciona una pestaña de página.');
    const snapshot = active.lease.service.state.project.snapshot;
    const resource = snapshot.records.find((r) => r.kind === 'resource' && r.value.id === tab.resourceId);
    return { entityId: tab.entityId, resourceId: tab.resourceId, title: tab.title, kind: resource?.kind === 'resource' ? resource.value.kind : 'missing',
      relativePath: resource?.kind === 'resource' && resource.value.kind !== 'remote-url' ? resource.value.path : null,
      ...(resource?.kind === 'resource' && resource.value.kind === 'mounted-file' ? { mountId: resource.value.mountId } : {}) };
  }); }
  locatePageResource(sessionId: string, tabId: string, selectedPath: string): Promise<void> { return this.#queue(async () => {
    const active = this.#active; demand(active?.sessionId === sessionId, 'STALE_SESSION', 'La sesión cambió antes de localizar el recurso.');
    const tab = (await this.#loadFocusSession(active)).tabs.find((t) => t.id === tabId);
    demand(tab?.kind === 'page', 'TAB_MISSING', 'La pestaña no está disponible.');
    const resource = active.lease.service.state.project.snapshot.records.find((r) => r.kind === 'resource' && r.value.id === tab.resourceId);
    demand(resource?.kind === 'resource' && resource.value.kind === 'project-file', 'LOCAL_RESOURCE_REQUIRED', 'La referencia necesita su descriptor o la aprobación local del montaje; no se creó un documento vacío.');
    demand(isAbsolute(selectedPath), 'INVALID_ROOT', 'Usa el selector nativo de archivos.');
    const path = relative(active.lease.service.root, selectedPath).replaceAll('\\', '/');
    const prepared = await active.lease.service.prepareResourceRelocation({ operationId: randomUUID(), resourceId: resource.value.id, expectedRevision: resource.value.revision, path });
    demand(prepared.ok, 'RESOURCE_RELOCATION_FAILED', prepared.diagnostics.map((d) => d.message).join('\n'));
    const saved = await active.lease.service.commit(prepared.value);
    demand(saved.ok, 'RESOURCE_RELOCATION_FAILED', saved.diagnostics.map((d) => d.message).join('\n'));
  }); }
  #canvasHistoryLocation(rootIdentity: string, projectId: string, workspaceId: string): { key: string; directory: string; path: string } {
    const directory = join(this.#stateRoot, 'canvas-history');
    const key = sha256(Buffer.from(`${rootIdentity}:${projectId}:${workspaceId}`));
    return { key, directory, path: join(directory, `${key}.json`) };
  }
  async #persistCanvasHistory(history: CanvasHistoryState): Promise<void> {
    const { directory, path } = this.#canvasHistoryLocation(history.rootIdentity, history.projectId, history.workspaceId);
    const bytes = Buffer.from(JSON.stringify(history) + '\n', 'utf8');
    demand(bytes.byteLength <= canvasHistoryByteLimit, 'CANVAS_HISTORY_LIMIT', 'El historial alcanzó el límite local de 16 MiB; elimina historial antiguo antes de continuar.');
    await mkdir(directory, { recursive: true });
    try {
      const existing = await lstat(path);
      demand(existing.isFile() && !existing.isSymbolicLink(), 'CANVAS_HISTORY_INVALID', 'El historial local no es un archivo regular; se conserva para revisión.');
    } catch (error) { if (!missing(error)) throw error; }
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  #historyMatches(event: ReversibleCanvasCommand, side: 'before' | 'after', snapshot: { records: DomainRecord[] }): boolean {
    return event.changes.every((change) => {
      const current = snapshot.records.find((record) => refKey(refOf(record)) === refKey(change.ref)) ?? null;
      return comparableHistoryRecord(current) === comparableHistoryRecord(change[side]);
    });
  }
  async #resolveCanvasHistoryPending(active: ActiveProjectBinding, history: CanvasHistoryState): Promise<void> {
    if (history.blocked) throw new LocalProjectError('CANVAS_HISTORY_CONFLICT', history.blocked);
    const pending = history.pending;
    if (!pending) return;
    const snapshot = active.lease.service.state.project.snapshot;
    const before = this.#historyMatches(pending.event, 'before', snapshot);
    const after = this.#historyMatches(pending.event, 'after', snapshot);
    if (pending.action === 'push') {
      if (after) {
        history.entries.splice(pending.cursorBefore);
        history.entries.push(pending.event);
        if (history.entries.length > canvasHistoryLimit) history.entries.splice(0, history.entries.length - canvasHistoryLimit);
        history.cursor = history.entries.length;
      } else if (!before) {
        history.blocked = 'El store recuperó un estado que no coincide con ninguno de los lados del último comando; se conserva el historial y se requiere revisión.';
      }
    } else if (pending.action === 'undo') {
      if (before) history.cursor = Math.max(0, pending.cursorBefore - 1);
      else if (!after) history.blocked = 'El estado actual difiere del comando de undo pendiente; se conserva el historial para revisión.';
    } else {
      if (after) history.cursor = Math.min(history.entries.length, pending.cursorBefore + 1);
      else if (!before) history.blocked = 'El estado actual difiere del comando de redo pendiente; se conserva el historial para revisión.';
    }
    for (const change of pending.event.changes) {
      const current = snapshot.records.find((record) => refKey(refOf(record)) === refKey(change.ref));
      if (current) history.revisionFloors[refKey(change.ref)] = Math.max(history.revisionFloors[refKey(change.ref)] ?? 0, current.value.revision);
    }
    delete history.pending;
    await this.#persistCanvasHistory(history);
    if (history.blocked) throw new LocalProjectError('CANVAS_HISTORY_CONFLICT', history.blocked);
  }
  async #canvasHistory(active: ActiveProjectBinding, workspaceId: string): Promise<CanvasHistoryState> {
    const root = active.lease.service.root;
    this.#assertLocalState(root);
    const rootIdentity = active.rootIdentity;
    const { key, path } = this.#canvasHistoryLocation(rootIdentity, active.projectId, workspaceId);
    let history = this.#canvasHistories.get(key);
    if (!history) {
      history = { schemaVersion: '1.0.0', projectId: active.projectId, rootIdentity, workspaceId, entries: [], cursor: 0, revisionFloors: {} };
      try {
        const stat = await lstat(path);
        demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= canvasHistoryByteLimit, 'CANVAS_HISTORY_INVALID', 'El historial local es inválido o demasiado grande; sus bytes se conservaron.');
        const handle = await open(path, 'r'); let parsed: unknown;
        try { parsed = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
        demand(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'CANVAS_HISTORY_INVALID', 'El historial local tiene un formato desconocido; se conservó sin cambios.');
        const saved = parsed as CanvasHistoryState;
        demand(saved.schemaVersion === '1.0.0' && saved.projectId === active.projectId && saved.rootIdentity === rootIdentity && saved.workspaceId === workspaceId &&
          Array.isArray(saved.entries) && saved.entries.length <= canvasHistoryLimit && Number.isSafeInteger(saved.cursor) && saved.cursor >= 0 && saved.cursor <= saved.entries.length &&
          saved.entries.every((event) => event && event.projectId === active.projectId && event.workspaceId === workspaceId && Array.isArray(event.changes) && Array.isArray(event.contentEffects)) &&
          saved.revisionFloors && typeof saved.revisionFloors === 'object' && !Array.isArray(saved.revisionFloors),
        'CANVAS_HISTORY_INVALID', 'El historial local no coincide con este proyecto/workspace; se conservaron sus bytes.');
        history = saved;
      } catch (error) { if (!missing(error)) throw error; }
      this.#canvasHistories.set(key, history);
    }
    await this.#resolveCanvasHistoryPending(active, history);
    return history;
  }
  #refreshHistoryRevisionFloors(history: CanvasHistoryState, event: ReversibleCanvasCommand, snapshot: { records: DomainRecord[] }): void {
    for (const change of event.changes) {
      const current = snapshot.records.find((record) => refKey(refOf(record)) === refKey(change.ref));
      if (current) history.revisionFloors[refKey(change.ref)] = Math.max(history.revisionFloors[refKey(change.ref)] ?? 0, current.value.revision);
      else history.revisionFloors[refKey(change.ref)] = Math.max(history.revisionFloors[refKey(change.ref)] ?? 0,
        change.before?.value.revision ?? 0, change.after?.value.revision ?? 0);
    }
  }
  #explorerContext(sessionId?: string): ActiveProjectBinding {
    demand(this.#active && (!sessionId || this.#active.sessionId === sessionId), 'STALE_SESSION', 'La sesión del proyecto cambió; vuelve a abrir Archivos.');
    if (this.#explorerSessionId !== this.#active.sessionId) { this.#resetExplorerBindings(); this.#explorerSessionId = this.#active.sessionId; }
    return this.#active;
  }
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
  async #commitCanvasCommand(active: ActiveProjectBinding, operation: Pick<DomainCommand, 'command' | 'payload'>, entityIds: string[], absent?: DocumentRef | readonly DocumentRef[], expectedContentHashes: { resourceId: string; hash: string }[] = []): Promise<void> {
    const absentRefs = !absent ? [] : Array.isArray(absent) ? absent : [absent];
    const payload = operation.payload as unknown as Record<string, unknown>;
    const reference = payload.ref as { workspaceId?: unknown } | undefined;
    const record = payload.record as DomainRecord | undefined;
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : typeof reference?.workspaceId === 'string' ? reference.workspaceId :
      record && 'workspaceId' in record ? record.workspaceId : undefined;
    if (typeof workspaceId === 'string' && uuid.test(workspaceId)) await this.#canvasHistory(active, workspaceId);
    const prepared = await active.lease.service.prepare({ operationId: randomUUID(), projectId: active.projectId, actor: this.options.host.authenticatedActor,
      ...operation, expectedRevisions: [...revisionsOf(active.lease.service.state.project.snapshot), ...absentRefs.map((ref) => ({ ...ref, revision: null }))],
      expectedContentHashes, scope: { entityIds: [...new Set(entityIds)] } });
    demand(prepared.ok, prepared.diagnostics[0]?.code ?? 'CANVAS_COMMAND_FAILED', prepared.diagnostics.map((item) => `${item.path} · ${item.detail}: ${item.message}`).join('\n'));
    const event = prepared.value.canvasCommand;
    let history: CanvasHistoryState | undefined;
    if (event?.changes.length) {
      demand(event.changes.length <= 1024 && event.contentEffects.length <= 1024, 'CANVAS_HISTORY_LIMIT', 'El cambio supera el límite reversible de 1024 documentos o recursos y no se ha escrito.');
      history = await this.#canvasHistory(active, event.workspaceId);
      const pendingState = structuredClone(history);
      pendingState.pending = { action: 'push', event, cursorBefore: history.cursor };
      await this.#persistCanvasHistory(pendingState);
      history.pending = pendingState.pending;
    }
    const committed = await active.lease.service.commit(prepared.value);
    demand(committed.ok, committed.diagnostics[0]?.code ?? 'CANVAS_COMMAND_FAILED', committed.diagnostics.map((item) => item.message).join('\n'));
    if (history && event) {
      this.#refreshHistoryRevisionFloors(history, event, active.lease.service.state.project.snapshot);
      await this.#resolveCanvasHistoryPending(active, history);
    }
  }
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
    const snapshot = active.lease.service.state.project.snapshot, registry = active.lease.service.typeRegistry;
    const choices = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'entity' }> => record.kind === 'entity');
    const resourceRecords = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'resource' }> => record.kind === 'resource');
    const resources = new Map(resourceRecords.map((record) => [record.value.id.toLowerCase(), record]));
    const placements = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'placement' }> => record.kind === 'placement' && record.workspaceId === workspaceId)
      .map(({ value }) => ({ id: value.id, revision: value.revision, entityId: value.entityId, position: value.position, size: value.size, style: value.style }));
    const placedIds = new Set(placements.map((placement) => placement.entityId.toLowerCase()));
    const entities = choices.filter(({ value }) => placedIds.has(value.id.toLowerCase()))
      .map(({ value }) => ({ id: value.id, revision: value.revision, type: value.type, typeVersion: value.typeVersion,
        title: value.title, properties: value.properties, ports: value.ports, ...(value.contentResourceId ? { contentResourceId: value.contentResourceId,
          ...(resources.get(value.contentResourceId.toLowerCase()) ? { contentResource: resourceDescriptor(resources.get(value.contentResourceId.toLowerCase())!) } : {}) } : {}),
        ...(c4Category(value, registry) ? { c4Category: c4Category(value, registry)! } : {}),
        typeAvailable: isBuiltinContentNodeType(value.type) || conceptualNodeKind(value.type, value.typeVersion) !== undefined || c4Category(value, registry) !== undefined || umlKind(value) !== undefined && umlData(value) !== undefined || erTable(value) && erData(value) !== undefined || isIotComponent(value) || isIotCircuit(value) }));
    const entityChoices = choices.filter(({ value }) => !isC4Diagram(value)).map(({ value }) => ({ id: value.id, type: value.type, typeVersion: value.typeVersion, title: value.title }));
    const resourceChoices = resourceRecords.map((record) => resourceDescriptor(record));
    const placementIds = new Map(placements.map((placement) => [placement.id.toLowerCase(), placement.id]));
    const visualEdges = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'visual-edge' }> => record.kind === 'visual-edge' && record.workspaceId === workspaceId)
      .map(({ value }) => ({ id: value.id, revision: value.revision, sourcePlacementId: placementIds.get(value.sourcePlacementId.toLowerCase()) ?? value.sourcePlacementId,
        targetPlacementId: placementIds.get(value.targetPlacementId.toLowerCase()) ?? value.targetPlacementId,
        label: value.label, waypoints: value.waypoints, style: value.style }));
    const relations = new Map(snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'relation' }> => record.kind === 'relation')
      .map((record) => [record.value.id.toLowerCase(), record]));
    const conceptualRelations: CanvasConceptualRelationView[] = snapshot.records
      .filter((record): record is Extract<DomainRecord, { kind: 'relation-view' }> => record.kind === 'relation-view' && record.workspaceId === workspaceId)
      .flatMap(({ value }) => {
        const relation = relations.get(value.relationId.toLowerCase());
        if (!relation || !isConceptualRelation(relation.value)) return [];
        const data = conceptualRelationData(relation.value.properties);
        const source = snapshot.records.find((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === value.sourcePlacementId.toLowerCase());
        const target = snapshot.records.find((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === value.targetPlacementId.toLowerCase());
        if (!data || source?.kind !== 'placement' || target?.kind !== 'placement') return [];
        return [{ id: value.id, relationId: relation.value.id, relationRevision: relation.value.revision, revision: value.revision,
          sourcePlacementId: source.value.id, targetPlacementId: target.value.id, sourceEntityId: relation.value.source.entityId,
          targetEntityId: relation.value.target.entityId, ...data }];
      });
    const deletion = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
      projectId: active.projectId, operation: 'write', paths: [], refs: [], resources: [], requiredCapabilities: ['delete', 'diagram.edit'], stage: 'prepare' });
    const drawingDeletion = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
      projectId: active.projectId, operation: 'write', paths: [], refs: [], resources: [],
      requiredCapabilities: ['delete', 'diagram.edit'], stage: 'prepare' });
    const drawingConversion = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
      projectId: active.projectId, operation: 'write', paths: [], refs: [], resources: [],
      requiredCapabilities: ['document.edit', 'diagram.edit', 'delete'], stage: 'prepare' });
    const drawings = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'drawing' }> => record.kind === 'drawing' && record.workspaceId === workspaceId)
      .map(({ value }) => ({ id: value.id, revision: value.revision, points: value.points, parameters: value.parameters, style: value.style }));
    const groups = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'group' }> => record.kind === 'group' && record.workspaceId === workspaceId)
      .map(({ value }) => ({ id: value.id, revision: value.revision, name: value.name, members: value.members, collapsed: value.collapsed === true }));
    const draft = this.#viewportDrafts.get(workspaceId);
    const { x, y, zoom } = draft?.viewport ?? workspace.viewport;
    const history = this.#canvasHistories.get(this.#canvasHistoryLocation(active.rootIdentity, active.projectId, workspaceId).key);
    const undoEvent = history?.entries[history.cursor - 1], redoEvent = history?.entries[history.cursor];
    const historyDelete = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
      projectId: active.projectId, operation: 'write', paths: [], refs: [], resources: [], requiredCapabilities: ['delete'], stage: 'prepare' });
    return { sessionId, workspaceId, name: workspace.name, revision: workspace.revision, viewport: { x, y, zoom }, pending: !!draft, entities, entityChoices, resourceChoices, placements, visualEdges, conceptualRelations, drawings, groups,
      c4: projectC4Canvas(snapshot, registry, workspaceId),
      uml: projectUmlCanvas(snapshot, workspaceId),
      er: projectErCanvas(snapshot, workspaceId),
      history: { canUndo: !!undoEvent && !history?.blocked && !undoEvent.changes.some((change) => change.ref.kind === 'workspace' && !change.before), canRedo: !!redoEvent && !history?.blocked,
        undoRequiresDelete: !!undoEvent && historyRequiresDelete(undoEvent, 'undo'), redoRequiresDelete: !!redoEvent && historyRequiresDelete(redoEvent, 'redo'),
        deleteAvailable: historyDelete.allowed },
      canDeleteEdges: active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict && deletion.allowed,
      canDeleteRelations: active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict && deletion.allowed,
      canDeleteDrawings: active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict && drawingDeletion.allowed,
      canConvertDrawings: active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict && drawingConversion.allowed,
      canWrite: active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict && edit.allowed };
  }
  loadCanvasWorkspace(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => { const { active } = this.#canvasContext(sessionId, workspaceId); await this.#canvasHistory(active, workspaceId); return this.#canvasWorkspace(sessionId, workspaceId); });
  }
  stageCanvasViewport(sessionId: string, workspaceId: string, expectedRevision: number, viewport: WorkspaceViewport): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId); await this.#canvasHistory(active, workspaceId);
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
      await this.#commitCanvasCommand(active, { command: 'a3.core.create-document', payload: { record } }, [entity.value.id], { kind: 'placement', id, workspaceId });
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  createCanvasContentNode(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, input: CanvasContentNodeInput): Promise<LocalCanvasWorkspace> {
    const captured = input?.bytes ? { ...input, bytes: Uint8Array.from(input.bytes) } : input;
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      const view = this.#canvasWorkspace(sessionId, workspaceId);
      demand(view.canWrite, 'PERMISSION_DENIED', 'El proyecto no permite insertar nodos de contenido.');
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision,
        'REVISION_CONFLICT', 'El workspace cambió; recarga antes de insertar el nodo.');
      demand(input && CONTENT_NODE_CATALOG.some((item) => item.kind === input.kind), 'INVALID_CONTENT_NODE', 'El tipo no existe en el catálogo de nodos A3.');
      demand(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= 200 &&
        input.position && Number.isFinite(input.position.x) && Number.isFinite(input.position.y), 'INVALID_CONTENT_NODE', 'El título y la posición del nodo deben ser válidos.');
      const definition = contentNodeDefinition(input.kind), snapshot = active.lease.service.state.project.snapshot;
      const entityId = randomUUID(), placementId = randomUUID(), resourceId = input.dropMode ? input.resourceId ?? randomUUID() : randomUUID();
      demand(uuid.test(resourceId), 'INVALID_CONTENT_RESOURCE', 'El identificador del recurso no es válido.');
      const absent: DocumentRef[] = [{ kind: 'entity', id: entityId }, { kind: 'placement', id: placementId, workspaceId }];
      const properties: ExtensionMap = {};
      for (const [key, value] of [['a3.content.description', input.description], ['a3.content.alt-text', input.altText], ['a3.content.language', input.language]] as const) {
        if (value !== undefined) {
          demand(typeof value === 'string' && value.length <= 16000, 'INVALID_CONTENT_METADATA', 'Los metadatos del nodo deben ser texto de hasta 16000 caracteres.');
          properties[key] = value;
        }
      }
      if (input.kind === 'mermaid') {
        Object.assign(properties, mermaidSourceProperties());
      }
      if (input.kind === 'plantuml') {
        Object.assign(properties, plantUmlSourceProperties());
      }
      if (input.kind === 'structurizr-dsl') Object.assign(properties, structurizrSourceProperties('structurizr-dsl'));
      if (input.kind === 'structurizr-json') Object.assign(properties, structurizrSourceProperties('structurizr-json'));
      let source: CreateContentNodeSource;
      const sourceFromResource = ['mermaid', 'plantuml', 'structurizr-dsl', 'structurizr-json'].includes(input.kind) && !!input.resourceId;
      if (definition.source === 'inline' && !sourceFromResource) {
        const limitedBytes = input.kind === 'plantuml' ? PLANTUML_SOURCE_LIMIT : input.kind.startsWith('structurizr-') ? STRUCTURIZR_SOURCE_LIMIT : undefined;
        demand(typeof input.value === 'string' && (limitedBytes ? Buffer.byteLength(input.value, 'utf8') <= limitedBytes : input.value.length <= 1_000_000),
        'INVALID_CONTENT_SOURCE', limitedBytes ? `La fuente debe ocupar como máximo ${limitedBytes} bytes.` : 'Escribe contenido de hasta 1 MB para el nodo.');
        source = { kind: 'inline', resourceId, path: `content/${resourceId}${definition.extension}`, mediaType: definition.mediaType, content: input.value };
        absent.push({ kind: 'resource', id: resourceId });
      } else if (definition.source === 'url' || input.kind === 'image' && input.url !== undefined) {
        demand(typeof input.url === 'string' && input.url.length <= 2048, 'INVALID_CONTENT_URL', 'Escribe una URL absoluta válida.');
        source = { kind: 'url', resourceId, url: input.url };
        absent.push({ kind: 'resource', id: resourceId });
      } else if (sourceFromResource) {
        const selectedResourceId = input.resourceId ?? '';
        demand(uuid.test(selectedResourceId), 'INVALID_DIAGRAM_RESOURCE', 'El recurso fuente seleccionado no tiene una identidad válida.');
        const resource = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> => record.kind === 'resource' && record.value.id.toLowerCase() === selectedResourceId.toLowerCase());
        const sourcePath = resource && resource.value.kind !== 'remote-url' ? resource.value.path : '';
        const allowedExtension = input.kind === 'mermaid' ? /\.(?:mmd|mermaid)$/i : input.kind === 'plantuml' ? /\.(?:puml|plantuml)$/i : input.kind === 'structurizr-dsl' ? /\.dsl$/i : /\.json$/i;
        demand(resource && resource.value.kind === 'project-file' && allowedExtension.test(sourcePath), 'INVALID_DIAGRAM_RESOURCE',
          input.kind.startsWith('structurizr-') ? 'Selecciona un archivo interno del proyecto con la extensión Structurizr correspondiente.' : 'Selecciona un archivo interno Mermaid o PlantUML con extensión reconocida.');
        source = { kind: 'existing-resource', resourceId: resource.value.id };
      } else if (captured.dropMode || captured.dropMountId || captured.dropPath) {
        demand(['image', 'video', 'audio', 'file'].includes(input.kind) && ['copy', 'reference'].includes(captured.dropMode ?? '') &&
          uuid.test(captured.dropMountId ?? '') && typeof captured.dropPath === 'string', 'INVALID_DROP_SOURCE', 'La selección externa ya no es válida.');
        const relativePath = validateMountRelativePath(captured.dropPath!).join('/');
        const decision = await this.options.host.capabilities.authorizeCapabilities(active.lease.service.root, this.options.host.authenticatedActor,
          active.projectId, ['mount.read'], 'canvas.drop.' + captured.dropMode, 'apply');
        demand(decision.allowed, 'PERMISSION_DENIED', 'El broker denegó la lectura del archivo externo.');
        const binding = this.options.host.capabilities.getLocalMount({ root: active.lease.service.root, projectId: active.projectId, mountId: captured.dropMountId! });
        demand(binding?.status === 'available', 'MOUNT_APPROVAL_REQUIRED', 'Aprueba o vuelve a localizar la carpeta de origen.');
        const external = await readLocalMountFile(binding, relativePath, 10 * 1024 * 1024);
        const mediaType = captured.mediaType ?? 'application/octet-stream';
        source = captured.dropMode === 'copy'
          ? { kind: 'binary', resourceId, path: `content/${resourceId}.bin`, mediaType, bytesBase64: Buffer.from(external.bytes).toString('base64') }
          : { kind: 'mounted-file', resourceId, mountId: captured.dropMountId!, path: relativePath, mediaType };
        absent.push({ kind: 'resource', id: resourceId });
      } else if (captured.bytes) {
        demand(['image', 'video', 'audio', 'file'].includes(input.kind) && captured.bytes.length > 0 && captured.bytes.length <= 10 * 1024 * 1024 &&
          typeof captured.mediaType === 'string', 'INVALID_CONTENT_SOURCE', 'El archivo debe ser un medio compatible de hasta 10 MiB.');
        source = { kind: 'binary', resourceId, path: `content/${resourceId}.bin`, mediaType: captured.mediaType!, bytesBase64: Buffer.from(captured.bytes).toString('base64') };
        absent.push({ kind: 'resource', id: resourceId });
      } else if (captured.mountId || captured.mountedPath) {
        demand(['image', 'video', 'audio', 'file'].includes(input.kind) && uuid.test(captured.mountId ?? '') && typeof captured.mountedPath === 'string',
          'INVALID_MOUNTED_RESOURCE', 'La referencia externa no identifica un archivo montado válido.');
        const relativePath = validateMountRelativePath(captured.mountedPath! ).join('/');
        const decision = await this.options.host.capabilities.authorizeCapabilities(active.lease.service.root, this.options.host.authenticatedActor,
          active.projectId, ['mount.read'], 'canvas.drop.reference', 'apply');
        demand(decision.allowed, 'PERMISSION_DENIED', 'El broker denegó la lectura del archivo externo.');
        const binding = this.options.host.capabilities.getLocalMount({ root: active.lease.service.root, projectId: active.projectId, mountId: captured.mountId! });
        demand(binding?.status === 'available', 'MOUNT_APPROVAL_REQUIRED', 'Aprueba o vuelve a localizar la carpeta de origen.');
        await readLocalMountFile(binding, relativePath, 10 * 1024 * 1024);
        source = { kind: 'mounted-file', resourceId, mountId: captured.mountId!, path: relativePath, mediaType: captured.mediaType ?? 'application/octet-stream' };
        absent.push({ kind: 'resource', id: resourceId });
      } else {
        demand(typeof input.resourceId === 'string' && uuid.test(input.resourceId), 'RESOURCE_REQUIRED', `Selecciona un recurso para ${definition.label}.`);
        const resource = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> => record.kind === 'resource' && record.value.id.toLowerCase() === input.resourceId!.toLowerCase());
        demand(resource, 'RESOURCE_MISSING', 'El recurso seleccionado ya no existe.');
        const mediaType = detectedMediaType(resource.value);
        if (definition.mediaType.endsWith('/*') && mediaType && !mediaType.startsWith(definition.mediaType.slice(0, -1))) {
          throw new LocalProjectError('RESOURCE_TYPE_MISMATCH', `El recurso seleccionado no es ${definition.mediaType.slice(0, -1)}.`);
        }
        source = { kind: 'existing-resource', resourceId: resource.value.id };
      }
      await this.#commitCanvasCommand(active, { command: 'a3.core.create-content-node', payload: {
        workspaceId, entityId, placementId, kind: input.kind, title: input.title.trim(), position: input.position, properties, source
      } }, [entityId], absent);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  duplicateCanvasSelection(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, selection: CanvasSelection,
    mode: 'content' | 'representation', offset = { x: 40, y: 40 }): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && expectedWorkspaceRevision === workspace.revision, 'REVISION_CONFLICT', 'El workspace cambió; recarga antes de duplicar.');
      demand(selection && Array.isArray(selection.placements) && Array.isArray(selection.drawings) && Array.isArray(selection.groups) &&
        [offset?.x, offset?.y].every(Number.isFinite) && ['content', 'representation'].includes(mode), 'INVALID_SELECTION', 'La selección de duplicación no es válida.');
      const snapshot = active.lease.service.state.project.snapshot;
      const placements = new Map(snapshot.records.filter((r): r is Extract<DomainRecord, { kind: 'placement' }> => r.kind === 'placement' && r.workspaceId === workspaceId).map((r) => [r.value.id.toLowerCase(), r]));
      const drawings = new Map(snapshot.records.filter((r): r is Extract<DomainRecord, { kind: 'drawing' }> => r.kind === 'drawing' && r.workspaceId === workspaceId).map((r) => [r.value.id.toLowerCase(), r]));
      const groups = new Map(snapshot.records.filter((r): r is Extract<DomainRecord, { kind: 'group' }> => r.kind === 'group' && r.workspaceId === workspaceId).map((r) => [r.value.id.toLowerCase(), r]));
      const selected = { placements: new Map<string, number>(), drawings: new Map<string, number>(), groups: new Map<string, number>() };
      for (const [kind, items] of Object.entries(selection) as [keyof typeof selected, CanvasSelectionRef[]][]) {
        for (const item of items) {
          const key = item.id.toLowerCase(); const record = (kind === 'placements' ? placements : kind === 'drawings' ? drawings : groups).get(key);
          demand(record && record.value.revision === item.expectedRevision, 'REVISION_CONFLICT', 'Un miembro de la selección cambió; recarga el canvas antes de duplicar.');
          demand(!selected[kind].has(key), 'INVALID_SELECTION', 'La selección no puede repetir miembros.');
          selected[kind].set(key, item.expectedRevision);
        }
      }
      const visitedGroups = new Set<string>();
      const visitGroup = (id: string, path = new Set<string>()): void => {
        const key = id.toLowerCase();
        demand(!path.has(key), 'INVALID_GROUP_CYCLE', 'No se puede duplicar un grupo cíclico.');
        if (visitedGroups.has(key)) return;
        const group = groups.get(key); demand(group, 'GROUP_MISSING', 'Un subgrupo de la selección ya no está disponible.');
        visitedGroups.add(key); selected.groups.set(key, group.value.revision);
        const nextPath = new Set(path); nextPath.add(key);
        for (const member of group.value.members) {
          if (member.kind === 'group') visitGroup(member.id, nextPath);
          else if (member.kind === 'placement') {
            const placement = placements.get(member.id.toLowerCase()); demand(placement, 'PLACEMENT_MISSING', 'Una representación del grupo ya no está disponible.');
            selected.placements.set(placement.value.id.toLowerCase(), placement.value.revision);
          } else {
            const drawing = drawings.get(member.id.toLowerCase()); demand(drawing, 'DRAWING_MISSING', 'Un trazo del grupo ya no está disponible.');
            selected.drawings.set(drawing.value.id.toLowerCase(), drawing.value.revision);
          }
        }
      };
      for (const id of [...selected.groups.keys()]) visitGroup(id);
      demand(selected.placements.size + selected.drawings.size + selected.groups.size > 0, 'INVALID_SELECTION', 'Selecciona al menos una representación, trazo o grupo.');
      demand(selected.placements.size + selected.drawings.size + selected.groups.size <= 512, 'SELECTION_TOO_LARGE', 'La selección expandida supera el límite reversible de 512 miembros.');
      const placementIds = [...selected.placements.keys()], drawingIds = [...selected.drawings.keys()], groupIds = [...selected.groups.keys()];
      const entityIds = [...new Set(placementIds.map((id) => placements.get(id)!.value.entityId))];
      const ids: DuplicateSelection['ids'] = { entities: {}, placements: {}, relations: {}, visualEdges: {}, relationViews: {}, drawings: {}, groups: {} };
      const newRefs: DocumentRef[] = [];
      const newEntityIds: string[] = [];
      const resourceMap = new Map<string, string>();
      const resourceCopies: DuplicateSelection['resourceCopies'] = [];
      const expectedContentHashes: { resourceId: string; hash: string }[] = [];
      const addMap = (table: Record<string, string>, sourceId: string, ref: DocumentRef): string => {
        const next = randomUUID(); table[sourceId] = next; newRefs.push({ ...ref, id: next }); return next;
      };
      if (mode === 'content') {
        for (const id of entityIds) {
          const entity = snapshot.records.find((r): r is Extract<DomainRecord, { kind: 'entity' }> => r.kind === 'entity' && r.value.id.toLowerCase() === id.toLowerCase());
          demand(entity, 'ENTITY_MISSING', 'Una entidad de la selección ya no existe.');
          const newId = addMap(ids.entities, entity.value.id, { kind: 'entity', id: entity.value.id });
          newEntityIds.push(newId);
          if (entity.value.contentResourceId) {
            const resource = snapshot.records.find((r): r is Extract<DomainRecord, { kind: 'resource' }> => r.kind === 'resource' && r.value.id.toLowerCase() === entity.value.contentResourceId!.toLowerCase());
            demand(resource, 'RESOURCE_MISSING', 'El recurso de una entidad ya no existe.');
            const sourceId = resource.value.id;
            let resourceCopy = resourceMap.get(sourceId.toLowerCase());
            if (!resourceCopy) {
              resourceCopy = randomUUID(); resourceMap.set(sourceId.toLowerCase(), resourceCopy);
              newRefs.push({ kind: 'resource', id: resourceCopy });
              if (resource.value.kind === 'remote-url') {
                resourceCopies.push({ sourceId, id: resourceCopy, location: { kind: 'remote-url', url: resource.value.url } });
              } else {
                demand(resource.value.kind === 'project-file', 'CONTENT_DUPLICATE_UNAVAILABLE', 'Duplicar contenido desde un montaje requiere copiarlo explícitamente al proyecto primero.');
                const opened = await active.lease.service.openResource(sourceId);
                demand(opened.ok, opened.diagnostics[0]?.code ?? 'RESOURCE_READ_FAILED', opened.diagnostics.map((item) => item.message).join('\n'));
                expectedContentHashes.push({ resourceId: sourceId, hash: opened.value.sha256 });
                const sourcePath = resource.value.path, slash = sourcePath.lastIndexOf('/'), directory = slash < 0 ? '' : sourcePath.slice(0, slash + 1);
                const leaf = slash < 0 ? sourcePath : sourcePath.slice(slash + 1), dot = leaf.lastIndexOf('.');
                const stem = dot > 0 ? leaf.slice(0, dot) : leaf, extension = dot > 0 ? leaf.slice(dot) : '';
                const targetPath = `${directory}${stem} copy ${resourceCopy.slice(0, 8)}${extension}`;
                resourceCopies.push({ sourceId, id: resourceCopy, location: { kind: 'project-file', path: targetPath } });
              }
            }
          }
          const variableSet = snapshot.records.find((r) => r.kind === 'variable-set' && r.value.scope.kind === 'entity' && r.value.scope.ownerId.toLowerCase() === entity.value.id.toLowerCase());
          if (variableSet) newRefs.push({ kind: 'variable-set', id: newId, variableScope: 'entity' });
        }
      }
      for (const id of placementIds) addMap(ids.placements, id, { kind: 'placement', id, workspaceId });
      for (const id of drawingIds) addMap(ids.drawings!, id, { kind: 'drawing', id, workspaceId });
      for (const id of groupIds) addMap(ids.groups!, id, { kind: 'group', id, workspaceId });
      const placementSet = new Set(placementIds);
      for (const record of snapshot.records) {
        if (record.kind === 'relation' && mode === 'content' && entityIds.some((id) => id.toLowerCase() === record.value.source.entityId.toLowerCase()) &&
            entityIds.some((id) => id.toLowerCase() === record.value.target.entityId.toLowerCase())) addMap(ids.relations, record.value.id, { kind: 'relation', id: record.value.id });
        if ((record.kind === 'visual-edge' || record.kind === 'relation-view') && record.workspaceId === workspaceId &&
            placementSet.has(record.value.sourcePlacementId.toLowerCase()) && placementSet.has(record.value.targetPlacementId.toLowerCase())) {
          addMap(record.kind === 'visual-edge' ? ids.visualEdges : ids.relationViews, record.value.id,
            { kind: record.kind, id: record.value.id, workspaceId });
        }
      }
      const payload: DuplicateSelection = { workspaceId, placementIds, drawingIds, groupIds, mode, offset, ids, resourceCopies, includeExternalRelations: false };
      await this.#commitCanvasCommand(active, { command: 'a3.core.duplicate-selection', payload }, [...entityIds, ...newEntityIds], newRefs, expectedContentHashes);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  updateCanvasPlacementViews(sessionId: string, workspaceId: string, patches: CanvasPlacementViewPatch[]): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      demand(Array.isArray(patches) && patches.length > 0 && patches.length <= 512 && new Set(patches.map((item) => item.id.toLowerCase())).size === patches.length,
        'INVALID_PLACEMENT_VIEW_BATCH', 'Selecciona representaciones únicas para ordenar o bloquear.');
      const entities = patches.map((item) => {
        const record = active.lease.service.state.project.snapshot.records.find((r) => r.kind === 'placement' && r.workspaceId === workspaceId && r.value.id.toLowerCase() === item.id.toLowerCase());
        demand(record?.kind === 'placement' && record.value.revision === item.expectedRevision, 'REVISION_CONFLICT', 'Una representación cambió; recarga antes de aplicar el lote.');
        return record.value.entityId;
      });
      await this.#commitCanvasCommand(active, { command: 'a3.core.update-placement-views', payload: { workspaceId, placements: patches.map(({ id, position, style }) => ({ id, ...(position ? { position } : {}), ...(style ? { style } : {}) })) } }, entities);
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
      const ref = { kind: 'placement' as const, id: record.value.id, workspaceId };
      const command = patch.position && !patch.size && !patch.style ? 'a3.core.move-placement' as const : 'a3.core.update-placement-view' as const;
      await this.#commitCanvasCommand(active, { command, payload: command === 'a3.core.move-placement' ? { ref, position: patch.position! } : { ...patch, ref } }, [record.value.entityId]);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  loadCanvasContent(sessionId: string, workspaceId: string, entityId: string, resourceId: string, purpose: 'preview' | 'playback' = 'preview'): Promise<CanvasResourcePreview> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const snapshot = active.lease.service.state.project.snapshot;
      const entity = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === entityId.toLowerCase());
      demand(entity?.kind === 'entity' && entity.value.contentResourceId?.toLowerCase() === resourceId.toLowerCase() &&
        snapshot.records.some((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.entityId.toLowerCase() === entityId.toLowerCase()),
      'RESOURCE_NOT_IN_VIEW', 'El recurso no pertenece a una entidad representada en este workspace.');
      const descriptor = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> => record.kind === 'resource' && record.value.id.toLowerCase() === resourceId.toLowerCase());
      demand(descriptor, 'RESOURCE_MISSING', 'El descriptor del recurso no está disponible; el nodo se conserva para reparación.');
      const mediaType = detectedMediaType(descriptor.value) ?? 'application/octet-stream';
      if (descriptor.value.kind === 'remote-url') return { entityId, resourceId, text: null, state: 'unavailable', mediaType };
      if (purpose === 'playback' && !mediaType.startsWith('video/') && !mediaType.startsWith('audio/')) {
        throw new LocalProjectError('MEDIA_TYPE_NOT_PLAYABLE', 'Solo se permite activar video o audio local en el reproductor.');
      }
      // Renderer receives bounded transient bytes for small image previews or explicit media playback;
      // A3 never writes a preview copy beside the original resource.
      const isMermaidSource = entity.value.type === MERMAID_SOURCE_TYPE && entity.value.properties['a3.diagram.authority'] === 'source';
      const isPlantUmlSource = entity.value.type === PLANTUML_SOURCE_TYPE && entity.value.properties['a3.diagram.authority'] === 'source';
      const isStructurizrSource = [STRUCTURIZR_DSL_SOURCE_TYPE, STRUCTURIZR_JSON_SOURCE_TYPE].includes(entity.value.type) && entity.value.properties['a3.diagram.authority'] === 'source';
      const limit = purpose === 'playback' ? 32 * 1024 * 1024 : mediaType.startsWith('image/') ? 4 * 1024 * 1024 : isMermaidSource ? 1024 * 1024 : isPlantUmlSource ? PLANTUML_SOURCE_LIMIT : isStructurizrSource ? STRUCTURIZR_SOURCE_LIMIT : 64 * 1024;
      const opened = await active.lease.service.openResource(resourceId, limit);
      if (!opened.ok) {
        const tooLarge = opened.diagnostics.some((item) => item.detail.includes('read-limit') || item.detail.includes('size-limit') || item.detail.includes('resource-too-large'));
        return { entityId, resourceId, text: null, state: tooLarge ? 'too-large' : 'unavailable', mediaType };
      }
      if (purpose === 'playback' || mediaType.startsWith('image/')) return { entityId, resourceId, text: null, state: 'binary', mediaType, bytes: opened.value.bytes };
      try { return { entityId, resourceId, text: new TextDecoder('utf-8', { fatal: true }).decode(opened.value.bytes), state: 'ready', mediaType }; }
      catch { return { entityId, resourceId, text: null, state: 'binary', mediaType }; }
    });
  }
  preparePlantUmlRender(sessionId: string, workspaceId: string, sourceEntityId: string): Promise<PlantUmlRenderInput> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const snapshot = active.lease.service.state.project.snapshot;
      const entity = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === sourceEntityId.toLowerCase());
      demand(entity?.kind === 'entity' && supportsPlantUmlSourceRenderer(entity.value.type, entity.value.typeVersion, entity.value.properties) &&
        typeof entity.value.contentResourceId === 'string' && snapshot.records.some((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.entityId.toLowerCase() === sourceEntityId.toLowerCase()),
      'PLANTUML_SOURCE_MISSING', 'La fuente PlantUML no está en este workspace o su versión/autoridad no está reconocida; el contenido se conserva.');
      const resource = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> => record.kind === 'resource' && record.value.id.toLowerCase() === entity.value.contentResourceId!.toLowerCase());
      demand(resource && resource.value.kind !== 'remote-url' && /\.(?:puml|plantuml)$/i.test(resource.value.path),
        'PLANTUML_SOURCE_UNAVAILABLE', 'La vista PlantUML requiere un recurso de texto local o montado con extensión .puml o .plantuml.');
      const opened = await active.lease.service.openResource(resource.value.id, PLANTUML_SOURCE_LIMIT);
      demand(opened.ok, opened.diagnostics[0]?.code ?? 'PLANTUML_SOURCE_UNAVAILABLE', opened.diagnostics.map((item) => item.message).join('\n'));
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(opened.value.bytes); }
      catch { throw new LocalProjectError('PLANTUML_SOURCE_ENCODING', 'La fuente no es UTF-8 válida; sus bytes originales permanecen intactos.'); }
      const projectRoot = await realpath(active.lease.service.root);
      const includeRoots = new Set<string>([projectRoot]);
      let workingDirectory = projectRoot;
      if (resource.value.kind === 'project-file') {
        const sourcePath = await checkedPath(projectRoot, resource.value.path, 'file');
        workingDirectory = dirname(sourcePath);
      } else {
        const binding = this.options.host.capabilities.getLocalMount({ root: active.lease.service.root, projectId: active.projectId, mountId: resource.value.mountId });
        demand(binding?.status === 'available' && await inspectLocalMountFile(binding, resource.value.path) === 'available',
          'PLANTUML_SOURCE_UNAVAILABLE', 'La raíz del diagrama montado falta, cambió o contiene una ruta enlazada; vuelve a aprobar el montaje.');
        const segments = validateMountRelativePath(resource.value.path);
        workingDirectory = dirname(resolve(binding.canonicalRoot, ...segments));
        includeRoots.add(binding.canonicalRoot);
      }
        const mountResources = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'resource' }> & { value: import('@a3/domain').Resource & { kind: 'mounted-file' } } => record.kind === 'resource' && record.value.kind === 'mounted-file');
      for (const mountResource of mountResources) {
        if (includeRoots.size >= 16) break;
        const decision = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
          projectId: active.projectId, operation: 'read-resource', paths: [], refs: [refOf(mountResource)], resources: [mountResource.value] });
        if (!decision.allowed) continue;
        const binding = this.options.host.capabilities.getLocalMount({ root: active.lease.service.root, projectId: active.projectId, mountId: mountResource.value.mountId });
        if (binding?.status !== 'available') continue;
        const physical = await realpath(binding.canonicalRoot).catch(() => '');
        const stat = await lstat(binding.canonicalRoot).catch(() => undefined);
        if (!physical || !stat?.isDirectory() || stat.isSymbolicLink() || physical.toLowerCase() !== binding.canonicalRoot.toLowerCase()) continue;
        includeRoots.add(binding.canonicalRoot);
      }
      demand(includeRoots.size <= 16 && ![...includeRoots].some((path) => path.includes(';') || /[\r\n\0]/.test(path)),
        'PLANTUML_INCLUDE_ROOT_LIMIT', 'Hay demasiadas raíces o una ruta no representable de forma segura para los includes locales.');
      return { source, sourceHash: opened.value.sha256, workingDirectory, includeRoots: [...includeRoots] };
    });
  }
  previewCanvasMermaidImport(sessionId: string, workspaceId: string, sourceEntityId: string): Promise<CanvasMermaidImportPreview> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId), snapshot = active.lease.service.state.project.snapshot;
      const source = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === sourceEntityId.toLowerCase());
      demand(source?.kind === 'entity' && source.value.type === MERMAID_SOURCE_TYPE && source.value.typeVersion === '1.0.0' &&
        typeof source.value.contentResourceId === 'string' && snapshot.records.some((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.entityId.toLowerCase() === sourceEntityId.toLowerCase()),
      'MERMAID_SOURCE_MISSING', 'La fuente Mermaid no está en este workspace; se conservan sus documentos para reparar la referencia.');
      const resource = snapshot.records.find((record) => record.kind === 'resource' && record.value.id.toLowerCase() === source.value.contentResourceId!.toLowerCase());
      demand(resource?.kind === 'resource' && resource.value.kind === 'project-file' && /\.(?:mmd|mermaid)$/i.test(resource.value.path),
        'MERMAID_IMPORT_SOURCE_UNAVAILABLE', 'La conversión requiere un recurso Mermaid interno del proyecto; los montajes y URLs no se leen ni descargan en esta operación.');
      const opened = await active.lease.service.openResource(resource.value.id, 1024 * 1024);
      demand(opened.ok, opened.diagnostics[0]?.code ?? 'MERMAID_IMPORT_SOURCE_UNAVAILABLE', opened.diagnostics.map((item) => item.message).join('\n'));
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(opened.value.bytes); }
      catch { throw new LocalProjectError('MERMAID_IMPORT_SOURCE_ENCODING', 'La fuente no es UTF-8 válido; sus bytes originales se conservan.'); }
      const graph = parseMermaidImport(text), priorImport = recordObject(source.value.properties['a3.diagram.import']);
      const priorMapping = recordObject(priorImport?.mapping) as MermaidImportIdentityMap | undefined;
      const mode: 'new' | 'update' = priorImport ? 'update' : 'new';
      const mapping: MermaidImportIdentityMap = {};
      const idConflicts = [...graph.idConflicts];
      if (priorImport && (!priorMapping || priorImport.schemaVersion !== '1.0.0' || priorImport.family !== graph.family)) {
        idConflicts.push({ line: 1, source: '', reason: 'La importación existente tiene una versión o familia distinta y no se puede actualizar con seguridad.' });
      }
      if (priorMapping) for (const [key, value] of Object.entries(priorMapping)) {
        if (typeof value !== 'string' || !uuid.test(value)) idConflicts.push({ line: 1, source: key, reason: 'El mapa persistido contiene un ID inválido.' });
        else mapping[key] = value;
      }
      for (const key of requiredMermaidMapping(graph)) if (!mapping[key]) mapping[key] = randomUUID();
      const mapValues = Object.values(mapping).map((value) => value.toLowerCase());
      if (new Set(mapValues).size !== mapValues.length) idConflicts.push({ line: 1, source: '', reason: 'El mapa persistido repite IDs; no se elegirá uno automáticamente.' });
      let records: DomainRecord[] = [];
      if (graph.family && !idConflicts.length) {
        try { records = buildMermaidImportRecords(graph, workspaceId, source.value.id, mapping).records; }
        catch (error) { idConflicts.push({ line: 1, source: '', reason: error instanceof Error ? error.message : 'No se pudo formar el modelo A3.' }); }
      }
      const report: CanvasMermaidImportItem[] = [];
      const sourceKey = (record: DomainRecord): string => {
        const marker = recordObject(record.value.extensions['a3.mermaid.import']); return typeof marker?.sourceKey === 'string' ? marker.sourceKey : '';
      };
      const recordTitle = (record: DomainRecord): string => {
        if (record.kind === 'entity') return record.value.title;
        if (record.kind !== 'relation') return '';
        const properties = record.value.properties;
        const conceptual = recordObject(properties['a3.conceptual.relation']);
        const uml = recordObject(properties['a3.uml']);
        const er = recordObject(properties['a3.er']);
        return String(properties['a3.conceptual.label'] ?? conceptual?.label ?? uml?.label ?? er?.label ?? '');
      };
      for (const record of records) {
        const existing = snapshot.records.find((candidate) => String(candidate.value.id).toLowerCase() === String(record.value.id).toLowerCase());
        const key = sourceKey(record);
        if (existing) {
          const marker = recordObject(existing.value.extensions['a3.mermaid.import']);
          if (refKey(refOf(existing)) !== refKey(refOf(record)) || mode !== 'update' || marker?.sourceEntityId !== source.value.id || marker.sourceKey !== key) {
            if (record.kind === 'entity' || record.kind === 'relation') report.push({ key, kind: record.value.type, title: recordTitle(record), action: 'conflict' });
            idConflicts.push({ line: 1, source: key, reason: `El ID ${record.value.id} está ocupado por un documento no perteneciente a esta importación.` });
          } else if (record.kind === 'entity' || record.kind === 'relation') {
            const before = structuredClone(existing); before.value.revision = 1;
            const after = structuredClone(record); after.value.revision = 1;
            report.push({ key, kind: record.value.type, title: recordTitle(record), action: stableJson(before) === stableJson(after) ? 'unchanged' : 'update' });
          }
        } else if (record.kind === 'entity' || record.kind === 'relation') report.push({ key, kind: record.value.type, title: recordTitle(record), action: 'create' });
      }
      const needed = new Set(requiredMermaidMapping(graph));
      const staleSourceKeys = Object.keys(priorMapping ?? {}).filter((key) => !needed.has(key));
      const token = randomUUID();
      const binding: MermaidImportPreviewBinding = { sessionId, workspaceId, sourceEntityId: source.value.id, sourceRevision: source.value.revision,
        resourceId: resource.value.id, sourceHash: opened.value.sha256, family: graph.family ?? 'flowchart', mode, graph,
        mapping, records, expiresAt: Date.now() + 10 * 60_000 };
      for (const [key, value] of this.#mermaidImportPreviews) if (value.expiresAt < Date.now() || value.sessionId !== sessionId) this.#mermaidImportPreviews.delete(key);
      if (this.#mermaidImportPreviews.size >= 20) this.#mermaidImportPreviews.delete(this.#mermaidImportPreviews.keys().next().value!);
      this.#mermaidImportPreviews.set(token, binding);
      const authority = source.value.properties['a3.diagram.authority'] === 'a3-model' ? 'a3-model' : 'source';
      const writeDecision = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
        projectId: active.projectId, operation: 'write', paths: [resource.value.path], refs: [{ kind: 'workspace', id: workspaceId }, { kind: 'entity', id: source.value.id }], resources: [resource.value],
        requiredCapabilities: ['diagram.edit', 'document.edit'], stage: 'prepare' });
      const historyLimitOk = records.length > 0 && records.length < 1024;
      const canApply = !!graph.family && graph.nodes.length > 0 && historyLimitOk && idConflicts.length === 0 && writeDecision.allowed &&
        active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict;
      return { token, sourceEntityId: source.value.id, sourceRevision: source.value.revision, resourceId: resource.value.id, family: graph.family,
        mode, sourceHash: opened.value.sha256, authority, converted: report, unconverted: graph.unconverted, missingResources: graph.missingResources, idConflicts,
        staleSourceKeys, mapping: { ...mapping }, canApply, message: canApply ? graph.unconverted.length || graph.missingResources.length ? 'Conversión parcial lista; revisa cada línea conservada antes de aplicar.' : 'Vista previa lista; revisa IDs y diferencias antes de aplicar.' :
          !historyLimitOk ? 'La operación supera el límite reversible de documentos; reduce la fuente antes de aplicar.' : idConflicts.length ? 'La vista previa contiene conflictos de identidad que deben resolverse antes de aplicar.' :
            !writeDecision.allowed || active.lease.service.state.mode !== 'writer' || active.lease.service.state.externalConflict ? 'El proyecto no permite escribir en este momento; la vista previa se conserva.' : 'La fuente no tiene un modelo aplicable.' };
    });
  }
  applyCanvasMermaidImport(sessionId: string, workspaceId: string, token: string, authority: 'source' | 'a3-model'): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const binding = this.#mermaidImportPreviews.get(token);
      demand(binding?.sessionId === sessionId && binding.workspaceId === workspaceId && binding.expiresAt > Date.now(), 'MERMAID_IMPORT_PREVIEW_EXPIRED', 'La vista previa venció o pertenece a otra sesión; vuelve a prepararla.');
      const { active } = this.#canvasContext(sessionId, workspaceId), snapshot = active.lease.service.state.project.snapshot;
      const source = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === binding.sourceEntityId.toLowerCase());
      demand(source?.kind === 'entity' && source.value.revision === binding.sourceRevision && source.value.contentResourceId?.toLowerCase() === binding.resourceId.toLowerCase(),
        'REVISION_CONFLICT', 'La fuente o sus metadatos cambiaron desde la vista previa; prepara un diff actualizado.');
      const opened = await active.lease.service.openResource(binding.resourceId, 1024 * 1024);
      demand(opened.ok && opened.value.sha256 === binding.sourceHash, 'REVISION_CONFLICT', 'La fuente cambió después de la vista previa; sus bytes originales se conservan.');
      const missingRefs = binding.records.filter((record) => !snapshot.records.some((current) => refKey(refOf(current)) === refKey(refOf(record)))).map(refOf);
      const entityIds = [binding.sourceEntityId, ...binding.records.flatMap((record) => record.kind === 'entity' ? [record.value.id] : record.kind === 'relation' ? [record.value.source.entityId, record.value.target.entityId] : [])];
      await this.#commitCanvasCommand(active, { command: 'a3.mermaid.import', payload: { workspaceId, sourceEntityId: binding.sourceEntityId,
        expectedSourceRevision: binding.sourceRevision, sourceResourceId: binding.resourceId, sourceHash: binding.sourceHash,
        family: binding.family, authority, mode: binding.mode, mapping: binding.mapping, records: binding.records } }, entityIds, missingRefs,
      [{ resourceId: binding.resourceId, hash: binding.sourceHash }]);
      this.#mermaidImportPreviews.delete(token);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  previewCanvasPlantUmlImport(sessionId: string, workspaceId: string, sourceEntityId: string): Promise<CanvasPlantUmlImportPreview> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId), snapshot = active.lease.service.state.project.snapshot;
      const source = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === sourceEntityId.toLowerCase());
      demand(source?.kind === 'entity' && source.value.type === PLANTUML_SOURCE_TYPE && source.value.typeVersion === '1.0.0' && source.value.properties['a3.diagram.format'] === 'plantuml' &&
        typeof source.value.contentResourceId === 'string' && snapshot.records.some((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.entityId.toLowerCase() === sourceEntityId.toLowerCase()),
      'PLANTUML_SOURCE_MISSING', 'La fuente PlantUML no está en este workspace o su autoridad ya no se reconoce; se conserva el documento.');
      const resource = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> => record.kind === 'resource' && record.value.id.toLowerCase() === source.value.contentResourceId!.toLowerCase());
      demand(resource?.value.kind === 'project-file' && /\.(?:puml|plantuml)$/i.test(resource.value.path),
        'PLANTUML_IMPORT_SOURCE_UNAVAILABLE', 'La importación estructurada solo lee un recurso PlantUML interno del proyecto; los montajes y URLs no se recorren.');
      const opened = await active.lease.service.openResource(resource.value.id, PLANTUML_SOURCE_LIMIT);
      demand(opened.ok, opened.diagnostics[0]?.code ?? 'PLANTUML_IMPORT_SOURCE_UNAVAILABLE', opened.diagnostics.map((item) => item.message).join('\n'));
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(opened.value.bytes); }
      catch { throw new LocalProjectError('PLANTUML_IMPORT_SOURCE_ENCODING', 'La fuente no es UTF-8 válido; sus bytes originales se conservan.'); }

      const graph = parsePlantUmlClassImport(text), priorImport = recordObject(source.value.properties['a3.diagram.import']);
      const priorMapping = recordObject(priorImport?.mapping) as MermaidImportIdentityMap | undefined;
      const priorCompatible = priorImport?.format === 'plantuml' && priorImport.schemaVersion === '1.0.0' && priorImport.family === 'class';
      const mode: 'new' | 'update' = priorCompatible ? 'update' : 'new';
      const mapping: MermaidImportIdentityMap = {};
      const idConflicts = [...graph.idConflicts];
      if (priorImport && !priorCompatible) idConflicts.push({ line: 1, source: '', reason: 'La importación existente no pertenece a PlantUML clase o no tiene una versión/mapeo conocido.' });
      if (priorCompatible && !priorMapping) idConflicts.push({ line: 1, source: '', reason: 'La importación existente no contiene un mapa verificable de IDs.' });
      if (priorMapping) for (const [key, value] of Object.entries(priorMapping)) {
        if (typeof value !== 'string' || !uuid.test(value)) idConflicts.push({ line: 1, source: key, reason: 'El mapa persistido contiene un ID inválido.' });
        else mapping[key] = value;
      }
      for (const key of requiredMermaidMapping(graph)) if (!mapping[key]) mapping[key] = randomUUID();
      const mapValues = Object.values(mapping).map((value) => value.toLowerCase());
      if (new Set(mapValues).size !== mapValues.length) idConflicts.push({ line: 1, source: '', reason: 'El mapa persistido repite IDs; no se elegirá una identidad automáticamente.' });
      let records: DomainRecord[] = [];
      if (graph.family === 'class' && !idConflicts.length) {
        try { records = buildMermaidImportRecords(graph, workspaceId, source.value.id, mapping, 'plantuml').records; }
        catch (error) { idConflicts.push({ line: 1, source: '', reason: error instanceof Error ? error.message : 'No se pudo formar el modelo UML A3.' }); }
      }

      const report: CanvasMermaidImportItem[] = [];
      const sourceKey = (record: DomainRecord): string => {
        const marker = recordObject(record.value.extensions['a3.plantuml.import']); return typeof marker?.sourceKey === 'string' ? marker.sourceKey : '';
      };
      const recordTitle = (record: DomainRecord): string => {
        if (record.kind === 'entity') return record.value.title;
        if (record.kind !== 'relation') return '';
        return String(record.value.properties['a3.uml'] && recordObject(record.value.properties['a3.uml'])?.label || '');
      };
      for (const record of records) {
        const existing = snapshot.records.find((candidate) => String(candidate.value.id).toLowerCase() === String(record.value.id).toLowerCase());
        const key = sourceKey(record);
        if (existing) {
          const marker = recordObject(existing.value.extensions['a3.plantuml.import']);
          if (refKey(refOf(existing)) !== refKey(refOf(record)) || mode !== 'update' || marker?.sourceEntityId !== source.value.id || marker.sourceKey !== key) {
            if (record.kind === 'entity' || record.kind === 'relation') report.push({ key, kind: record.value.type, title: recordTitle(record), action: 'conflict' });
            idConflicts.push({ line: 1, source: key, reason: `El ID ${record.value.id} está ocupado por un documento que no pertenece a esta importación.` });
          } else if (record.kind === 'entity' || record.kind === 'relation') {
            const before = structuredClone(existing); before.value.revision = 1;
            const after = structuredClone(record); after.value.revision = 1;
            report.push({ key, kind: record.value.type, title: recordTitle(record), action: stableJson(before) === stableJson(after) ? 'unchanged' : 'update' });
          }
        } else if (record.kind === 'entity' || record.kind === 'relation') report.push({ key, kind: record.value.type, title: recordTitle(record), action: 'create' });
      }
      const needed = new Set(requiredMermaidMapping(graph));
      const staleSourceKeys = Object.keys(priorMapping ?? {}).filter((key) => !needed.has(key));
      const token = randomUUID();
      const binding: PlantUmlImportPreviewBinding = { sessionId, workspaceId, sourceEntityId: source.value.id, sourceRevision: source.value.revision,
        resourceId: resource.value.id, sourceHash: opened.value.sha256, family: 'class', mode, graph, mapping, records, expiresAt: Date.now() + 10 * 60_000 };
      for (const [key, value] of this.#plantUmlImportPreviews) if (value.expiresAt < Date.now() || value.sessionId !== sessionId) this.#plantUmlImportPreviews.delete(key);
      if (this.#plantUmlImportPreviews.size >= 20) this.#plantUmlImportPreviews.delete(this.#plantUmlImportPreviews.keys().next().value!);
      this.#plantUmlImportPreviews.set(token, binding);
      const authority = source.value.properties['a3.diagram.authority'] === 'a3-model' ? 'a3-model' : 'source';
      const writeDecision = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
        projectId: active.projectId, operation: 'write', paths: [resource.value.path], refs: [{ kind: 'workspace', id: workspaceId }, { kind: 'entity', id: source.value.id }], resources: [resource.value],
        requiredCapabilities: ['diagram.edit', 'document.edit'], stage: 'prepare' });
      const historyLimitOk = records.length > 0 && records.length < 1024;
      const canApply = graph.family === 'class' && graph.nodes.length > 0 && historyLimitOk && idConflicts.length === 0 && writeDecision.allowed &&
        active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict;
      const message = canApply ? graph.unconverted.length ? 'Conversión parcial lista; revisa las construcciones omitidas, IDs y diferencias. La fuente completa no se reescribe.' : 'Vista previa lista; revisa IDs y diferencias antes de aplicar.' :
        !historyLimitOk ? 'La operación supera el límite reversible de documentos; reduce la fuente antes de aplicar.' : idConflicts.length ? 'La vista previa tiene conflictos de identidad o mapeo que deben resolverse.' :
          !writeDecision.allowed || active.lease.service.state.mode !== 'writer' || active.lease.service.state.externalConflict ? 'El proyecto no permite escribir en este momento; la vista previa se conserva.' : 'No se detectó una clase UML compatible.';
      return { token, sourceEntityId: source.value.id, sourceRevision: source.value.revision, resourceId: resource.value.id, family: graph.family === 'class' ? 'class' : null,
        mode, sourceHash: opened.value.sha256, authority, converted: report, unconverted: graph.unconverted, missingResources: graph.missingResources, idConflicts,
        staleSourceKeys, mapping: { ...mapping }, canApply, message };
    });
  }
  applyCanvasPlantUmlImport(sessionId: string, workspaceId: string, token: string, authority: 'source' | 'a3-model'): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const binding = this.#plantUmlImportPreviews.get(token);
      demand(binding?.sessionId === sessionId && binding.workspaceId === workspaceId && binding.expiresAt > Date.now(), 'PLANTUML_IMPORT_PREVIEW_EXPIRED', 'La vista previa venció o pertenece a otra sesión; vuelve a prepararla.');
      const { active } = this.#canvasContext(sessionId, workspaceId), snapshot = active.lease.service.state.project.snapshot;
      const source = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === binding.sourceEntityId.toLowerCase());
      demand(source?.kind === 'entity' && source.value.revision === binding.sourceRevision && source.value.contentResourceId?.toLowerCase() === binding.resourceId.toLowerCase(),
        'REVISION_CONFLICT', 'La fuente o sus metadatos cambiaron desde la vista previa; prepara un diff actualizado.');
      const opened = await active.lease.service.openResource(binding.resourceId, PLANTUML_SOURCE_LIMIT);
      demand(opened.ok && opened.value.sha256 === binding.sourceHash, 'REVISION_CONFLICT', 'La fuente cambió después de la vista previa; conserva ambas versiones y prepara de nuevo.');
      const missingRefs = binding.records.filter((record) => !snapshot.records.some((current) => refKey(refOf(current)) === refKey(refOf(record)))).map(refOf);
      const entityIds = [binding.sourceEntityId, ...binding.records.flatMap((record) => record.kind === 'entity' ? [record.value.id] : record.kind === 'relation' ? [record.value.source.entityId, record.value.target.entityId] : [])];
      await this.#commitCanvasCommand(active, { command: 'a3.plantuml.import', payload: { workspaceId, sourceEntityId: binding.sourceEntityId,
        expectedSourceRevision: binding.sourceRevision, sourceResourceId: binding.resourceId, sourceHash: binding.sourceHash,
        family: 'class', authority, mode: binding.mode, mapping: binding.mapping, records: binding.records } }, entityIds, missingRefs,
      [{ resourceId: binding.resourceId, hash: binding.sourceHash }]);
      this.#plantUmlImportPreviews.delete(token);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  previewCanvasStructurizrImport(sessionId: string, workspaceId: string, sourceEntityId: string): Promise<CanvasStructurizrImportPreview> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId), snapshot = active.lease.service.state.project.snapshot;
      const source = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === sourceEntityId.toLowerCase());
      const format: StructurizrSourceFormat | undefined = source?.kind === 'entity' && source.value.type === STRUCTURIZR_DSL_SOURCE_TYPE ? 'structurizr-dsl' :
        source?.kind === 'entity' && source.value.type === STRUCTURIZR_JSON_SOURCE_TYPE ? 'structurizr-json' : undefined;
      demand(source?.kind === 'entity' && source.value.typeVersion === '1.0.0' && format && source.value.properties['a3.diagram.format'] === format &&
        ['source', 'a3-model'].includes(String(source.value.properties['a3.diagram.authority'])) && typeof source.value.contentResourceId === 'string' &&
        snapshot.records.some((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.entityId.toLowerCase() === sourceEntityId.toLowerCase()),
      'STRUCTURIZR_SOURCE_MISSING', 'La fuente Structurizr no está en este workspace o su autoridad/version no es compatible; el documento se conserva.');
      const resource = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> => record.kind === 'resource' && record.value.id.toLowerCase() === source.value.contentResourceId!.toLowerCase());
      const extension = format === 'structurizr-dsl' ? /\.dsl$/i : /\.json$/i;
      demand(resource?.value.kind === 'project-file' && extension.test(resource.value.path), 'STRUCTURIZR_IMPORT_SOURCE_UNAVAILABLE',
        'La importación lee un archivo interno .dsl o .json del proyecto; montajes y URLs no se recorren.');
      const opened = await active.lease.service.openResource(resource.value.id, STRUCTURIZR_SOURCE_LIMIT);
      demand(opened.ok, opened.diagnostics[0]?.code ?? 'STRUCTURIZR_IMPORT_SOURCE_UNAVAILABLE', opened.diagnostics.map((item) => item.message).join('\n'));
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(opened.value.bytes); }
      catch { throw new LocalProjectError('STRUCTURIZR_IMPORT_SOURCE_ENCODING', 'La fuente Structurizr no es UTF-8 válida; sus bytes originales se conservan.'); }
      const graph = format === 'structurizr-dsl' ? parseStructurizrDslImport(text) : parseStructurizrJsonImport(text);
      if (graph.missingResources.some((item) => /^\s*!include(?:url)?\s+(?:https?:\/\/|\\\\)/i.test(item.source))) {
        const remoteDecision = await this.options.host.capabilities.authorizeCapabilities(active.lease.service.root, this.options.host.authenticatedActor,
          active.projectId, ['network.access'], 'structurizr.remote-include', 'prepare');
        if (!remoteDecision.allowed) for (const item of graph.missingResources) if (/^\s*!include(?:url)?\s+(?:https?:\/\/|\\\\)/i.test(item.source)) {
          item.reason = 'Include remoto bloqueado: falta el permiso de proyecto network.access. A3 no realizó una solicitud de red.';
        }
      }
      const prior = recordObject(source.value.properties['a3.diagram.import']);
      const priorMapping = recordObject(prior?.mapping);
      const compatible = prior?.schemaVersion === '1.0.0' && prior.format === format && !!priorMapping;
      const mode: 'new' | 'update' = compatible ? 'update' : 'new';
      const mapping: Record<string, string> = {};
      const idConflicts = [...graph.idConflicts];
      if (prior && !compatible) idConflicts.push({ line: 1, source: '', reason: 'La importación existente tiene otro formato/version o no tiene un mapa verificable.', code: 'conflict' });
      if (priorMapping) for (const [key, value] of Object.entries(priorMapping)) {
        if (typeof value !== 'string' || !uuid.test(value)) idConflicts.push({ line: 1, source: key, reason: 'El mapa guardado contiene un ID inválido.', code: 'conflict' });
        else mapping[key] = value;
      }
      for (const key of structurizrMappingKeys(graph)) if (!mapping[key]) mapping[key] = randomUUID();
      if (new Set(Object.values(mapping).map((value) => value.toLowerCase())).size !== Object.keys(mapping).length) {
        idConflicts.push({ line: 1, source: '', reason: 'El mapa de identidades asigna un mismo UUID a dos documentos.', code: 'conflict' });
      }
      let records: DomainRecord[] = [];
      if (!idConflicts.length && graph.views.length) {
        try { records = buildStructurizrImportRecords(graph, source.value.id, mapping); }
        catch (error) { idConflicts.push({ line: 1, source: '', reason: error instanceof Error ? error.message : 'No se pudo construir las vistas C4 A3.', code: 'conflict' }); }
      }
      const converted: CanvasMermaidImportItem[] = [];
      for (const record of records) {
        if (record.kind !== 'entity' && record.kind !== 'relation') continue;
        const marker = recordObject(record.value.extensions['a3.structurizr.import']);
        const key = typeof marker?.sourceKey === 'string' ? marker.sourceKey : '';
        const title = record.kind === 'entity' ? record.value.title : String(record.value.properties['a3.c4'] && recordObject(record.value.properties['a3.c4'])?.description || '');
        const existing = snapshot.records.find((candidate) => String(candidate.value.id).toLowerCase() === String(record.value.id).toLowerCase());
        if (!existing) converted.push({ key, kind: record.kind === 'entity' ? record.value.type : 'a3.c4.relationship', title, action: 'create' });
        else {
          const existingMarker = recordObject(existing.value.extensions['a3.structurizr.import']);
          const owned = mode === 'update' && refKey(refOf(existing)) === refKey(refOf(record)) && existingMarker?.sourceEntityId === source.value.id && existingMarker.sourceKey === key;
          const before = structuredClone(existing), after = structuredClone(record); before.value.revision = 1; after.value.revision = 1;
          converted.push({ key, kind: record.kind === 'entity' ? record.value.type : 'a3.c4.relationship', title, action: !owned ? 'conflict' : stableJson(before) === stableJson(after) ? 'unchanged' : 'update' });
          if (!owned) idConflicts.push({ line: 1, source: key, reason: `El UUID ${record.value.id} ya pertenece a otro documento.`, code: 'conflict' });
        }
      }
      const required = new Set(structurizrMappingKeys(graph));
      const staleSourceKeys = Object.keys(priorMapping ?? {}).filter((key) => !required.has(key));
      const viewSummaries = graph.views.map((view) => {
        const viewId = mapping[`workspace:${view.key}`]!;
        const existing = snapshot.records.some((record) => record.kind === 'workspace' && record.value.id.toLowerCase() === viewId.toLowerCase());
        return { key: view.key, kind: view.kind, title: view.title, workspaceId: viewId, elements: view.elements.length, relations: view.relations.length, action: existing ? 'update' as const : 'create' as const };
      });
      const token = randomUUID();
      const binding: StructurizrImportPreviewBinding = { sessionId, workspaceId, sourceEntityId: source.value.id, sourceRevision: source.value.revision,
        resourceId: resource.value.id, sourceHash: opened.value.sha256, format, mode, graph, mapping, records, views: viewSummaries, expiresAt: Date.now() + 10 * 60_000 };
      for (const [key, item] of this.#structurizrImportPreviews) if (item.expiresAt < Date.now() || item.sessionId !== sessionId) this.#structurizrImportPreviews.delete(key);
      if (this.#structurizrImportPreviews.size >= 20) this.#structurizrImportPreviews.delete(this.#structurizrImportPreviews.keys().next().value!);
      this.#structurizrImportPreviews.set(token, binding);
      const authority = source.value.properties['a3.diagram.authority'] === 'a3-model' ? 'a3-model' : 'source';
      const writeDecision = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
        projectId: active.projectId, operation: 'write', paths: [resource.value.path], refs: [{ kind: 'workspace', id: workspaceId }, { kind: 'entity', id: source.value.id }], resources: [resource.value],
        requiredCapabilities: ['diagram.edit', 'document.edit'], stage: 'prepare' });
      const canApply = records.length > 0 && records.length < 1024 && graph.views.length > 0 && graph.elements.length > 0 && idConflicts.length === 0 &&
        writeDecision.allowed && active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict;
      const message = canApply ? graph.unconverted.length || graph.missingResources.length ? 'Conversión parcial lista: revisa el informe, el mapa de IDs y las vistas que se crearán. La fuente completa permanece intacta.' :
        'Vista previa lista: revisa las vistas C4, IDs y relaciones antes de aplicar.' : !graph.views.length ? 'No hay una vista estática C4 compatible para convertir.' :
        records.length >= 1024 ? 'La conversión supera el límite de 1024 documentos reversibles.' : idConflicts.length ? 'La vista previa tiene conflictos de identidad que deben resolverse.' :
        !writeDecision.allowed || active.lease.service.state.mode !== 'writer' || active.lease.service.state.externalConflict ? 'El proyecto no permite escribir en este momento; la vista previa se conserva.' : 'No hay elementos convertibles.';
      return { token, sourceEntityId: source.value.id, sourceRevision: source.value.revision, resourceId: resource.value.id, format, mode,
        sourceHash: opened.value.sha256, authority, converted, views: viewSummaries, unconverted: graph.unconverted, missingResources: graph.missingResources,
        idConflicts, staleSourceKeys, mapping: { ...mapping }, canApply, message };
    });
  }
  applyCanvasStructurizrImport(sessionId: string, workspaceId: string, token: string, authority: 'source' | 'a3-model', viewKey: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const binding = this.#structurizrImportPreviews.get(token);
      demand(binding?.sessionId === sessionId && binding.workspaceId === workspaceId && binding.expiresAt > Date.now(), 'STRUCTURIZR_IMPORT_PREVIEW_EXPIRED', 'La vista previa venció o pertenece a otra sesión; vuelve a prepararla.');
      const { active } = this.#canvasContext(sessionId, workspaceId), snapshot = active.lease.service.state.project.snapshot;
      const source = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === binding.sourceEntityId.toLowerCase());
      demand(source?.kind === 'entity' && source.value.revision === binding.sourceRevision && source.value.contentResourceId?.toLowerCase() === binding.resourceId.toLowerCase(),
        'REVISION_CONFLICT', 'La fuente o sus metadatos cambiaron después de la vista previa; prepara otro diff.');
      const opened = await active.lease.service.openResource(binding.resourceId, STRUCTURIZR_SOURCE_LIMIT);
      demand(opened.ok && opened.value.sha256 === binding.sourceHash, 'REVISION_CONFLICT', 'La fuente cambió después de la vista previa; sus bytes originales se conservan.');
      const selectedView = binding.graph.views.find((view) => view.key === viewKey);
      demand(selectedView, 'STRUCTURIZR_VIEW_MISSING', 'La vista elegida ya no forma parte de la previsualización.');
      const selectedKeys = new Set(selectedView.elements);
      const addAncestors = (key: string): void => {
        const parentKey = binding.graph.elements.find((item) => item.key === key)?.parentKey;
        if (parentKey && !selectedKeys.has(parentKey)) { selectedKeys.add(parentKey); addAncestors(parentKey); }
      };
      for (const key of [...selectedKeys]) addAncestors(key);
      const selectedGraph: StructurizrImportGraph = { ...binding.graph, elements: binding.graph.elements.filter((item) => selectedKeys.has(item.key)),
        relations: binding.graph.relations.filter((item) => selectedView.relations.includes(item.key)), views: [selectedView] };
      const records = buildStructurizrImportRecords(selectedGraph, binding.sourceEntityId, binding.mapping);
      const targetWorkspaceId = binding.mapping[`workspace:${selectedView.key}`]!;
      const absent = records.filter((record) => !snapshot.records.some((current) => refKey(refOf(current)) === refKey(refOf(record)))).map(refOf);
      const entityIds = [binding.sourceEntityId, ...records.flatMap((record) => record.kind === 'entity' ? [record.value.id] : record.kind === 'relation' ? [record.value.source.entityId, record.value.target.entityId] : [])];
      await this.#commitCanvasCommand(active, { command: 'a3.structurizr.import', payload: { workspaceId: targetWorkspaceId, sourceWorkspaceId: workspaceId, sourceEntityId: binding.sourceEntityId,
        expectedSourceRevision: binding.sourceRevision, sourceResourceId: binding.resourceId, sourceHash: binding.sourceHash, format: binding.format,
        authority, mode: binding.mode, mapping: binding.mapping, records } }, entityIds, absent, [{ resourceId: binding.resourceId, hash: binding.sourceHash }]);
      this.#structurizrImportPreviews.delete(token);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  async #readCodeDocument(active: ActiveProjectBinding, input: CodeBinding, documentId: string): Promise<{ document: CodeDocument; binding: CodeBinding }> {
    const binding = { ...input };
    await active.lease.service.checkExternalChanges();
    const snapshot = active.lease.service.state.project.snapshot;
    let resource = binding.resourceId ? snapshot.records.find((r): r is Extract<DomainRecord, { kind: 'resource' }> => r.kind === 'resource' && r.value.id.toLowerCase() === binding.resourceId!.toLowerCase()) : undefined;
    if (!binding.resourceId) {
      const matches = snapshot.records.filter((r): r is Extract<DomainRecord, { kind: 'resource' }> => r.kind === 'resource' && r.value.kind === 'project-file' && r.value.path.toLowerCase() === binding.path.toLowerCase());
      demand(matches.length <= 1, 'CODE_RESOURCE_AMBIGUOUS', 'La ruta tiene varios recursos; revisa el catálogo antes de editar.');
      resource = matches[0]; if (resource) binding.resourceId = resource.value.id;
    }
    demand(!binding.resourceId || resource, 'RESOURCE_MISSING', 'El recurso ya no existe; se conserva el borrador.');
    let languageHint: string | null = null;
    if (binding.entityId) {
      const entity = snapshot.records.find((r) => r.kind === 'entity' && r.value.id.toLowerCase() === binding.entityId!.toLowerCase());
      demand(entity?.kind === 'entity' && entity.value.type === 'a3.content.code' && entity.value.contentResourceId === resource?.value.id,
        'REVISION_CONFLICT', 'El nodo de código cambió de recurso; vuelve a abrirlo.');
      binding.entityRevision = entity.value.revision;
      languageHint = typeof entity.value.properties['a3.content.language'] === 'string' ? entity.value.properties['a3.content.language'] : null;
    }
    demand(resource?.value.kind !== 'remote-url', 'CODE_REMOTE_UNAVAILABLE', 'Las URLs no se descargan para abrir código.');
    let bytes: Uint8Array, hash: string;
    let revision: number | null = resource?.value.revision ?? null;
    const mounted = resource?.value.kind === 'mounted-file';
    if (mounted) {
      const opened = await active.lease.service.openResource(resource!.value.id, 2 * 1024 * 1024);
      demand(opened.ok, 'CODE_READ_FAILED', opened.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
      bytes = opened.value.bytes; hash = opened.value.sha256; revision = opened.value.revision;
      binding.path = resource!.value.path as string;
    } else {
      if (resource?.value.kind === 'project-file') binding.path = resource.value.path;
      const opened = await active.lease.service.readCodeFile(binding.path, binding.identity);
      demand(opened.ok, opened.diagnostics.some((d) => d.code === 'REVISION_CONFLICT') ? 'REVISION_CONFLICT' : opened.diagnostics.some((d) => d.code === 'PERMISSION_DENIED') ? 'PERMISSION_DENIED' : 'CODE_READ_FAILED', opened.diagnostics.map((d) => d.message).join('\n'));
      bytes = opened.value.bytes; hash = opened.value.hash; binding.identity = opened.value.identity;
    }
    const decoded = decodeCodeText(bytes);
    const state = active.lease.service.state;
    const managed = binding.path.toLowerCase() === 'a3.project.json' || binding.path.toLowerCase().startsWith('.a3/') ||
      !!resource && snapshot.records.some((r) => r.kind === 'entity' && r.value.type === 'a3.core.drawing' && r.value.contentResourceId === resource.value.id);
    let readOnlyReason = decoded.readOnlyReason ?? (mounted ? 'Montaje externo: solo lectura. La edición externa no está habilitada por E0-C2.' : managed ? 'Archivo administrado por A3: solo lectura; su guardado requiere el editor de contrato correspondiente.' : state.mode !== 'writer' ? 'Proyecto abierto en solo lectura.' : state.externalConflict ? 'Hay cambios externos pendientes; reabre el proyecto antes de escribir.' : null);
    if (!readOnlyReason) {
      const allowed = this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root, projectId: active.projectId,
        operation: 'write', paths: [binding.path], refs: resource ? [refOf(resource)] : [], resources: resource ? [resource.value] : [], requiredCapabilities: ['document.edit'], stage: 'prepare' });
      if (!allowed.allowed) readOnlyReason = 'El broker local no concede edición documental.';
    }
    binding.hash = hash; binding.revision = revision;
    return { binding, document: { ...decoded, readOnlyReason, documentId, resourceId: binding.resourceId ?? null, revision, hash,
      name: binding.path.split('/').at(-1) ?? binding.path, relativePath: binding.path, size: bytes.length, canWrite: readOnlyReason === null, languageHint } };
  }
  openCodeDocument(sessionId: string, target: CodeOpenTarget): Promise<CodeDocument> {
    return this.#queue(async () => {
      const active = this.#explorerContext(sessionId);
      let binding: CodeBinding;
      if ('itemId' in target) {
        const item = this.#explorerPath(target.itemId, sessionId);
        demand(item.kind === 'file', 'CODE_FILE_REQUIRED', 'Abre un archivo regular del explorador.');
        binding = { sessionId, path: item.path, identity: item.identity, ...(item.resourceId ? { resourceId: item.resourceId } : {}) };
      } else binding = { sessionId, path: '', resourceId: target.resourceId, ...(target.entityId ? { entityId: target.entityId } : {}) };
      const documentId = randomUUID();
      const opened = await this.#readCodeDocument(active, binding, documentId);
      this.#codeDocuments.set(documentId, opened.binding); return opened.document;
    });
  }
  reloadCodeDocument(sessionId: string, documentId: string): Promise<CodeDocument> {
    return this.#queue(async () => {
      const active = this.#explorerContext(sessionId), binding = this.#codeDocuments.get(documentId);
      demand(binding?.sessionId === sessionId, 'STALE_DOCUMENT', 'El documento pertenece a otra sesión.');
      const { identity: _identity, ...current } = binding;
      const opened = await this.#readCodeDocument(active, current, documentId);
      this.#codeDocuments.set(documentId, opened.binding); return opened.document;
    });
  }
  saveCodeDocument(input: { sessionId: string; documentId: string; expectedRevision: number | null; expectedHash: string; content: string }): Promise<CodeDocument> {
    return this.#queue(async () => {
      const active = this.#explorerContext(input.sessionId), binding = this.#codeDocuments.get(input.documentId);
      demand(binding?.sessionId === input.sessionId, 'STALE_DOCUMENT', 'El documento pertenece a otra sesión; se conserva el borrador.');
      demand(typeof input.content === 'string' && input.content.length <= 2 * 1024 * 1024, 'CODE_SIZE_LIMIT', 'El editor admite hasta 2 MiB.');
      demand(binding.hash === input.expectedHash && binding.revision === input.expectedRevision, 'REVISION_CONFLICT', 'La vista del documento cambió; compara antes de guardar.');
      const opened = await this.#readCodeDocument(active, binding, input.documentId), current = opened.document;
      demand(current.hash === input.expectedHash && current.revision === input.expectedRevision && opened.binding.entityRevision === binding.entityRevision,
        'REVISION_CONFLICT', 'El archivo o su nodo cambió desde que se abrió. El borrador se conserva.');
      demand(current.canWrite && current.encoding && current.content !== null, 'PERMISSION_DENIED', current.readOnlyReason ?? 'No se puede editar este archivo.');
      if (input.content === current.content) return current;
      const ending = codeLineEnding(input.content);
      demand(ending !== 'mixed' && ending !== 'cr' && (ending === 'none' || current.lineEnding === 'none' || ending === current.lineEnding), 'CODE_REPRESENTATION_CHANGED', 'El buffer cambió el convenio de finales de línea; conserva el original.');
      let bytes: Uint8Array;
      try { bytes = encodeCodeText(input.content, current.encoding); } catch { throw new LocalProjectError('CODE_ENCODING_FAILED', 'El buffer contiene Unicode incompleto; los bytes originales se conservan.'); }
      demand(bytes.length <= 2 * 1024 * 1024 && decodeCodeText(bytes).state === 'text', 'CODE_ENCODING_FAILED', 'El buffer no es texto seguro o supera 2 MiB.');
      const plan = current.resourceId ? await active.lease.service.prepareResourceWrite({ operationId: randomUUID(), resourceId: current.resourceId,
        expectedRevision: current.revision!, expectedHash: current.hash, bytes }) : await active.lease.service.prepareExplorerOperation({ operationId: randomUUID(), action: 'write-file', sourcePath: opened.binding.path,
        ...(opened.binding.identity ? { expectedSourceIdentity: opened.binding.identity } : {}), expectedHash: current.hash, bytes });
      demand(plan.ok, plan.diagnostics.some((d) => d.code === 'REVISION_CONFLICT') ? 'REVISION_CONFLICT' : plan.diagnostics.some((d) => d.code === 'PERMISSION_DENIED') ? 'PERMISSION_DENIED' : 'CODE_WRITE_FAILED', plan.diagnostics.map((d) => d.message).join('\n'));
      const committed = await active.lease.service.commit(plan.value);
      demand(committed.ok, committed.diagnostics.some((d) => d.code === 'REVISION_CONFLICT') ? 'REVISION_CONFLICT' : 'CODE_WRITE_FAILED', committed.diagnostics.map((d) => d.message).join('\n'));
      const { identity: _identity, ...next } = opened.binding;
      const saved = await this.#readCodeDocument(active, next, input.documentId);
      this.#codeDocuments.set(input.documentId, saved.binding); return saved.document;
    });
  }
  #markdownWriteAllowed(active: ActiveProjectBinding, resource: Extract<DomainRecord, { kind: 'resource' }>): boolean {
    const state = active.lease.service.state;
    if (resource.value.kind !== 'project-file' || state.mode !== 'writer' || state.externalConflict) return false;
    return this.options.host.capabilities.authorizeAccess({ actor: this.options.host.authenticatedActor, root: active.lease.service.root,
      projectId: active.projectId, operation: 'write', paths: [resource.value.path], refs: [refOf(resource)], resources: [resource.value],
      requiredCapabilities: ['document.edit'], stage: 'prepare' }).allowed;
  }
  #markdownReadOnlyReason(active: ActiveProjectBinding, resource: Extract<DomainRecord, { kind: 'resource' }>): string | null {
    if (resource.value.kind === 'mounted-file') return 'El recurso está montado como referencia de solo lectura.';
    if (active.lease.service.state.mode !== 'writer') return 'El proyecto está abierto en modo de solo lectura.';
    if (active.lease.service.state.externalConflict) return 'Hay cambios externos pendientes de resolver en el proyecto.';
    if (!this.#markdownWriteAllowed(active, resource)) return 'El broker local no concede edición documental para este proyecto.';
    return null;
  }
  openMarkdownDocument(sessionId: string, entityId: string, resourceId: string): Promise<MarkdownDocument> {
    return this.#queue(async () => {
      const active = this.#active;
      demand(active && active.sessionId === sessionId, 'STALE_SESSION', 'El proyecto cambió antes de abrir la página.');
      const snapshot = active.lease.service.state.project.snapshot;
      const entity = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === entityId.toLowerCase());
      demand(entity?.kind === 'entity' && ['a3.core.page', 'a3.content.short-text', 'a3.content.markdown'].includes(entity.value.type) &&
        entity.value.contentResourceId?.toLowerCase() === resourceId.toLowerCase(), 'MARKDOWN_ENTITY_MISMATCH', 'La entidad ya no apunta a este recurso Markdown.');
      const resource = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> =>
        record.kind === 'resource' && record.value.id.toLowerCase() === resourceId.toLowerCase());
      demand(resource && resource.value.kind !== 'remote-url' && (resource.value.mediaType === 'text/markdown' || resource.value.path.toLowerCase().endsWith('.md')),
        'MARKDOWN_RESOURCE_REQUIRED', 'El editor solo abre recursos Markdown UTF-8.');
      const opened = await active.lease.service.openResource(resourceId, 2 * 1024 * 1024);
      demand(opened.ok, opened.diagnostics.some((item) => item.code === 'PERMISSION_DENIED') ? 'PERMISSION_DENIED' : 'MARKDOWN_READ_FAILED',
        opened.diagnostics.map((item) => item.message).join('\n') || 'No se pudo leer el recurso Markdown.');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(opened.value.bytes); }
      catch { throw new LocalProjectError('MARKDOWN_ENCODING_UNSUPPORTED', 'El Markdown no es UTF-8 válido. Los bytes originales se conservan y la edición visual queda desactivada.'); }
      const inspection = inspectMarkdownSource(content);
      const readOnlyReason = this.#markdownReadOnlyReason(active, resource);
      return { entityId: entity.value.id, entityRevision: entity.value.revision, resourceId: resource.value.id, revision: opened.value.revision,
        hash: opened.value.sha256, content, canWrite: readOnlyReason === null, readOnlyReason, unsupported: inspection.reasons };
    });
  }
  openMarkdownImage(sessionId: string, entityId: string, resourceId: string, reference: string): Promise<MarkdownAsset> {
    return this.#queue(async () => {
      const active = this.#active;
      demand(active && active.sessionId === sessionId, 'STALE_SESSION', 'El proyecto cambió antes de abrir la imagen Markdown.');
      demand(typeof reference === 'string' && reference.length > 0 && reference.length <= 2048 && !/[\\\0?#]/.test(reference) &&
        !/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(reference), 'MARKDOWN_ASSET_UNAVAILABLE', 'La imagen debe ser una referencia relativa portable del proyecto.');
      let decoded: string;
      try { decoded = decodeURIComponent(reference); }
      catch { throw new LocalProjectError('MARKDOWN_ASSET_UNAVAILABLE', 'La referencia de imagen contiene codificación inválida.'); }
      demand(!/[\\\0?#:]/.test(decoded), 'MARKDOWN_ASSET_UNAVAILABLE', 'La referencia de imagen no es una ruta portable.');
      const snapshot = active.lease.service.state.project.snapshot;
      const entity = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === entityId.toLowerCase());
      demand(entity?.kind === 'entity' && ['a3.core.page', 'a3.content.short-text', 'a3.content.markdown'].includes(entity.value.type) &&
        entity.value.contentResourceId?.toLowerCase() === resourceId.toLowerCase(), 'MARKDOWN_ENTITY_MISMATCH', 'La entidad ya no apunta a este recurso Markdown.');
      const source = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> =>
        record.kind === 'resource' && record.value.id.toLowerCase() === resourceId.toLowerCase());
      demand(source?.kind === 'resource' && source.value.kind === 'project-file' &&
        (source.value.mediaType === 'text/markdown' || source.value.path.toLowerCase().endsWith('.md')), 'MARKDOWN_RESOURCE_REQUIRED', 'El editor solo resuelve imágenes desde Markdown del proyecto.');
      const path = posix.normalize(posix.join(posix.dirname(source.value.path), decoded));
      demand(path !== '.' && path !== '..' && !path.startsWith('../') && !path.startsWith('/'), 'MARKDOWN_ASSET_UNAVAILABLE', 'La imagen sale de la raíz portable del proyecto.');
      const matches = snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'resource' }> =>
        record.kind === 'resource' && record.value.kind === 'project-file' && record.value.path.toLowerCase() === path.toLowerCase());
      demand(matches.length === 1 && !!matches[0], 'MARKDOWN_ASSET_UNAVAILABLE', 'La imagen local no tiene una referencia de recurso única en el proyecto.');
      const asset = matches[0]!;
      demand(asset.value.kind === 'project-file', 'MARKDOWN_ASSET_UNAVAILABLE', 'La referencia no es un archivo interno del proyecto.');
      const allowedImages = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
      const imageMediaTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp' };
      const declaredMediaType = typeof asset.value.mediaType === 'string' ? asset.value.mediaType.toLowerCase() : undefined;
      const mediaType = declaredMediaType ?? imageMediaTypes[posix.extname(asset.value.path).toLowerCase()];
      demand(mediaType && allowedImages.has(mediaType), 'MARKDOWN_ASSET_UNAVAILABLE', 'Solo se previsualizan imágenes locales rasterizadas aprobadas; SVG y otros tipos permanecen como referencia de texto.');
      const opened = await active.lease.service.openResource(asset.value.id, 4 * 1024 * 1024);
      demand(opened.ok, opened.diagnostics.some((item) => item.code === 'PERMISSION_DENIED') ? 'PERMISSION_DENIED' : 'MARKDOWN_ASSET_UNAVAILABLE',
        opened.diagnostics.map((item) => item.message).join('\n') || 'No se pudo leer la imagen local.');
      return { reference, mediaType, bytes: opened.value.bytes };
    });
  }
  saveMarkdownDocument(input: { sessionId: string; entityId: string; resourceId: string; entityRevision: number; expectedRevision: number; expectedHash: string; content: string }): Promise<MarkdownDocument> {
    const content = input.content;
    return this.#queue(async () => {
      const active = this.#active;
      demand(active && active.sessionId === input.sessionId, 'STALE_SESSION', 'El proyecto cambió; el borrador Markdown sigue en el editor.');
      demand(typeof content === 'string' && content.length <= 2 * 1024 * 1024, 'MARKDOWN_SIZE_LIMIT', 'El documento supera el límite de edición visual de 2 MiB.');
      const bytes = new TextEncoder().encode(content);
      demand(bytes.byteLength <= 2 * 1024 * 1024, 'MARKDOWN_SIZE_LIMIT', 'El documento supera el límite de edición visual de 2 MiB.');
      const snapshot = active.lease.service.state.project.snapshot;
      const entity = snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === input.entityId.toLowerCase());
      demand(entity?.kind === 'entity' && ['a3.core.page', 'a3.content.short-text', 'a3.content.markdown'].includes(entity.value.type) &&
        entity.value.contentResourceId?.toLowerCase() === input.resourceId.toLowerCase(), 'MARKDOWN_ENTITY_MISMATCH', 'La entidad o el recurso cambiaron; no se guardó el borrador.');
      demand(entity.value.revision === input.entityRevision, 'REVISION_CONFLICT', 'La entidad cambió; vuelve a cargarla o copia el borrador antes de resolver el conflicto.');
      const resource = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> =>
        record.kind === 'resource' && record.value.id.toLowerCase() === input.resourceId.toLowerCase());
      demand(resource?.kind === 'resource' && resource.value.kind === 'project-file' &&
        (resource.value.mediaType === 'text/markdown' || resource.value.path.toLowerCase().endsWith('.md')), 'MARKDOWN_READ_ONLY', 'Solo se guardan páginas Markdown internas del proyecto. Las referencias externas son de solo lectura.');
      const opened = await active.lease.service.openResource(resource.value.id, 2 * 1024 * 1024);
      demand(opened.ok, opened.diagnostics.some((item) => item.code === 'PERMISSION_DENIED') ? 'PERMISSION_DENIED' : 'MARKDOWN_READ_FAILED',
        opened.diagnostics.map((item) => item.message).join('\n') || 'No se pudo verificar la revisión actual del recurso.');
      demand(opened.value.revision === input.expectedRevision && opened.value.sha256 === input.expectedHash, 'REVISION_CONFLICT',
        'El archivo Markdown cambió fuera de este editor. El borrador se conserva; recarga o copia antes de resolver.');
      let current: string;
      try { current = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(opened.value.bytes); }
      catch { throw new LocalProjectError('MARKDOWN_ENCODING_UNSUPPORTED', 'El archivo dejó de ser UTF-8 válido. No se sobrescribió.'); }
      const currentInspection = inspectMarkdownSource(current);
      if (Buffer.from(bytes).equals(Buffer.from(opened.value.bytes))) {
        const readOnlyReason = this.#markdownReadOnlyReason(active, resource);
        return {
          entityId: entity.value.id, entityRevision: entity.value.revision, resourceId: resource.value.id, revision: opened.value.revision,
          hash: opened.value.sha256, content: current, canWrite: readOnlyReason === null, readOnlyReason, unsupported: currentInspection.reasons
        };
      }
      const parseIssue = inspectMarkdownParse(content);
      demand(!parseIssue, 'MARKDOWN_PARSE_FAILED', parseIssue ? `Error Markdown en línea ${parseIssue.line}, columna ${parseIssue.column}: ${parseIssue.message}` : 'Markdown inválido.');
      const plan = await active.lease.service.prepareResourceWrite({ operationId: randomUUID(), resourceId: resource.value.id,
        expectedRevision: input.expectedRevision, expectedHash: input.expectedHash, bytes });
      demand(plan.ok, plan.diagnostics.some((item) => item.code === 'PERMISSION_DENIED') ? 'PERMISSION_DENIED' :
        plan.diagnostics.some((item) => item.code === 'REVISION_CONFLICT') ? 'REVISION_CONFLICT' : 'MARKDOWN_WRITE_REJECTED',
      plan.diagnostics.map((item) => item.message).join('\n') || 'El servicio rechazó el guardado Markdown.');
      const committed = await active.lease.service.commit(plan.value);
      demand(committed.ok, committed.diagnostics.some((item) => item.code === 'PERMISSION_DENIED') ? 'PERMISSION_DENIED' :
        committed.diagnostics.some((item) => item.code === 'REVISION_CONFLICT') ? 'REVISION_CONFLICT' : 'MARKDOWN_WRITE_FAILED',
      committed.diagnostics.map((item) => item.message).join('\n') || 'No se pudo confirmar el guardado Markdown.');
      const saved = await active.lease.service.openResource(resource.value.id, 2 * 1024 * 1024);
      demand(saved.ok, 'MARKDOWN_VERIFY_FAILED', 'El guardado terminó, pero no se pudo volver a leer para verificarlo.');
      const savedInspection = inspectMarkdownSource(content);
      const readOnlyReason = this.#markdownReadOnlyReason(active, resource);
      return { entityId: entity.value.id, entityRevision: entity.value.revision, resourceId: resource.value.id, revision: saved.value.revision,
        hash: saved.value.sha256, content, canWrite: readOnlyReason === null, readOnlyReason, unsupported: savedInspection.reasons };
    });
  }
  approveCanvasDropMount(sessionId: string, mountId: string, selectedRoot: string): Promise<boolean> {
    return this.#queue(async () => {
      const active = this.#active;
      demand(active && active.sessionId === sessionId && uuid.test(mountId), 'STALE_SESSION', 'El proyecto cambió antes de aprobar el archivo externo.');
      const approved = await this.options.host.capabilities.approveLocalMount({ root: active.lease.service.root, projectId: active.projectId,
        mountId, selectedRoot, permission: 'read-only' });
      if (!approved) return false;
      return this.options.host.capabilities.setGrant({ root: active.lease.service.root, projectId: active.projectId,
        capability: 'mount.read', mode: 'direct' });
    });
  }
  #canvasHistoryEntityIds(active: ActiveProjectBinding, event: ReversibleCanvasCommand): string[] {
    const records = [...active.lease.service.state.project.snapshot.records, ...event.changes.flatMap((change) => [change.before, change.after].filter((record): record is DomainRecord => !!record))];
    const placements = new Map(records.filter((r): r is Extract<DomainRecord, { kind: 'placement' }> => r.kind === 'placement').map((r) => [r.value.id.toLowerCase(), r]));
    const groups = new Map(records.filter((r): r is Extract<DomainRecord, { kind: 'group' }> => r.kind === 'group').map((r) => [refKey(refOf(r)), r]));
    const entities = new Set<string>();
    const visitGroup = (record: Extract<DomainRecord, { kind: 'group' }>, visited = new Set<string>()): void => {
      const key = refKey(refOf(record)); if (visited.has(key)) return; visited.add(key);
      for (const member of record.value.members) {
        if (member.kind === 'placement') { const placement = placements.get(member.id.toLowerCase()); if (placement) entities.add(placement.value.entityId); }
        else if (member.kind === 'group') { const group = groups.get(refKey({ kind: 'group', id: member.id, workspaceId: record.workspaceId })); if (group) visitGroup(group, visited); }
      }
    };
    for (const change of event.changes) for (const record of [change.before, change.after]) {
      if (!record) continue;
      if (record.kind === 'entity') entities.add(record.value.id);
      else if (record.kind === 'placement') entities.add(record.value.entityId);
      else if (record.kind === 'relation') { entities.add(record.value.source.entityId); entities.add(record.value.target.entityId); }
      else if (record.kind === 'variable-set' && record.value.scope.kind === 'entity') entities.add(record.value.scope.ownerId);
      else if (record.kind === 'group') visitGroup(record);
      else if (record.kind === 'visual-edge' || record.kind === 'relation-view') for (const id of [record.value.sourcePlacementId, record.value.targetPlacementId]) {
        const placement = placements.get(id.toLowerCase()); if (placement) entities.add(placement.value.entityId);
      }
      else if (record.kind === 'resource') for (const candidate of records) {
        if (candidate.kind === 'entity' && candidate.value.contentResourceId?.toLowerCase() === record.value.id.toLowerCase()) entities.add(candidate.value.id);
      }
    }
    return [...entities];
  }
  async #historyEffects(active: ActiveProjectBinding, event: ReversibleCanvasCommand, direction: 'undo' | 'redo'): Promise<ContentEffect[]> {
    if (direction === 'redo') return structuredClone(event.contentEffects) as ContentEffect[];
    const snapshot = active.lease.service.state.project.snapshot;
    const effects: ContentEffect[] = [];
    for (const effect of event.contentEffects) {
      if (effect.kind === 'create' || effect.kind === 'create-binary' || effect.kind === 'copy') {
        const resourceId = effect.kind === 'copy' ? effect.targetId : effect.resourceId;
        const expectedHash = effect.kind === 'create' ? sha256(Buffer.from(effect.content, 'utf8')) :
          effect.kind === 'create-binary' ? sha256(Buffer.from(effect.bytesBase64, 'base64')) : effect.expectedHash;
        const resource = snapshot.records.find((record): record is Extract<DomainRecord, { kind: 'resource' }> => record.kind === 'resource' && record.value.id.toLowerCase() === resourceId.toLowerCase());
        demand(resource?.kind === 'resource' && resource.value.kind === 'project-file', 'REVISION_CONFLICT', 'El recurso que creó el comando ya no está disponible para deshacer.');
        const opened = await active.lease.service.openResource(resourceId);
        demand(opened.ok && opened.value.sha256 === expectedHash, 'REVISION_CONFLICT', 'Los bytes del recurso creado cambiaron; se conserva el archivo y se detiene el undo.');
        effects.push({ kind: 'remove', resourceId, path: resource.value.path, expectedHash });
      } else if (effect.kind === 'move') effects.push({ ...effect, before: effect.after, after: effect.before });
      else throw new LocalProjectError('CANVAS_HISTORY_UNSUPPORTED', 'El historial contiene un efecto que esta versión no puede invertir con seguridad.');
    }
    return effects;
  }
  async #replayCanvasHistory(sessionId: string, workspaceId: string, direction: 'undo' | 'redo'): Promise<LocalCanvasWorkspace> {
    const { active } = this.#canvasContext(sessionId, workspaceId);
    const history = await this.#canvasHistory(active, workspaceId);
    demand(active.lease.service.state.mode === 'writer' && !active.lease.service.state.externalConflict, 'PERMISSION_DENIED', 'El historial requiere un proyecto escribible y sin conflicto externo.');
    const event = direction === 'undo' ? history.entries[history.cursor - 1] : history.entries[history.cursor];
    demand(event, direction === 'undo' ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO', direction === 'undo' ? 'No hay cambios para deshacer.' : 'No hay cambios para rehacer.');
    const snapshot = active.lease.service.state.project.snapshot;
    const contentEffects = await this.#historyEffects(active, event, direction);
    const missingRefs = event.changes.filter((change) => !snapshot.records.some((record) => refKey(refOf(record)) === refKey(change.ref)))
      .map((change) => ({ ...change.ref, revision: null }));
    const request: DomainCommand = { operationId: randomUUID(), projectId: active.projectId, actor: this.options.host.authenticatedActor,
      command: 'a3.core.apply-canvas-history', payload: { workspaceId, direction, changes: structuredClone(event.changes) as RecordChange[], contentEffects,
        revisionFloors: { ...history.revisionFloors } }, expectedRevisions: [...revisionsOf(snapshot), ...missingRefs], expectedContentHashes: [],
      scope: { entityIds: this.#canvasHistoryEntityIds(active, event) } };
    const prepared = await active.lease.service.prepare(request);
    demand(prepared.ok, prepared.diagnostics[0]?.code ?? 'CANVAS_HISTORY_FAILED', prepared.diagnostics.map((item) => item.message).join('\n'));
    const pendingState = structuredClone(history);
    pendingState.pending = { action: direction, event, cursorBefore: history.cursor };
    await this.#persistCanvasHistory(pendingState);
    history.pending = pendingState.pending;
    const committed = await active.lease.service.commit(prepared.value);
    demand(committed.ok, committed.diagnostics[0]?.code ?? 'CANVAS_HISTORY_FAILED', committed.diagnostics.map((item) => item.message).join('\n'));
    this.#refreshHistoryRevisionFloors(history, event, active.lease.service.state.project.snapshot);
    await this.#resolveCanvasHistoryPending(active, history);
    return this.#canvasWorkspace(sessionId, workspaceId);
  }
  undoCanvas(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(() => this.#replayCanvasHistory(sessionId, workspaceId, 'undo'));
  }
  redoCanvas(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(() => this.#replayCanvasHistory(sessionId, workspaceId, 'redo'));
  }
  #canvasEndpointEntities(active: ActiveProjectBinding, workspaceId: string, placementIds: string[]): string[] {
    return placementIds.map((id) => {
      const placement = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === id.toLowerCase());
      demand(placement?.kind === 'placement', 'PLACEMENT_MISSING', 'El extremo debe pertenecer a este workspace.');
      return placement.value.entityId;
    });
  }
  #canvasGroupEntityIds(active: ActiveProjectBinding, workspaceId: string, groupId: string): string[] {
    return this.#canvasMemberEntityIds(active, workspaceId, [{ kind: 'group', id: groupId }]);
  }
  #canvasMemberEntityIds(active: ActiveProjectBinding, workspaceId: string, members: readonly GroupMember[]): string[] {
    const records = active.lease.service.state.project.snapshot.records;
    const groups = new Map(records.filter((record): record is Extract<DomainRecord, { kind: 'group' }> => record.kind === 'group' && record.workspaceId === workspaceId)
      .map((record) => [record.value.id.toLowerCase(), record]));
    const placements = new Map(records.filter((record): record is Extract<DomainRecord, { kind: 'placement' }> => record.kind === 'placement' && record.workspaceId === workspaceId)
      .map((record) => [record.value.id.toLowerCase(), record]));
    const entities = new Set<string>(), visited = new Set<string>();
    const visitGroup = (id: string): void => {
      const key = id.toLowerCase(); if (visited.has(key)) return; visited.add(key);
      const group = groups.get(key); if (!group) return;
      for (const member of group.value.members) {
        if (member.kind === 'group') visitGroup(member.id);
        else if (member.kind === 'placement') {
          const placement = placements.get(member.id.toLowerCase()); if (placement) entities.add(placement.value.entityId);
        }
      }
    };
    for (const member of members) {
      if (member.kind === 'group') visitGroup(member.id);
      else if (member.kind === 'placement') {
        const placement = placements.get(member.id.toLowerCase()); if (placement) entities.add(placement.value.entityId);
      }
    }
    return [...entities];
  }
  createCanvasGroup(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, name: string, members: GroupMember[]): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision, 'REVISION_CONFLICT', 'El workspace cambió; recarga antes de agrupar.');
      demand(typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 120, 'INVALID_GROUP_NAME', 'El grupo necesita un nombre de 1 a 120 caracteres.');
      demand(Array.isArray(members) && members.length > 0 && members.length <= 512, 'INVALID_GROUP_MEMBERS', 'Selecciona al menos un miembro para agrupar.');
      const id = randomUUID();
      const record: DomainRecord = { kind: 'group', workspaceId, value: { schemaVersion: '1.0.0', id, revision: 1, extensions: {}, name: name.trim(), members, collapsed: false } };
      const entities = members.flatMap((member) => member.kind === 'placement' ? this.#canvasEndpointEntities(active, workspaceId, [member.id]) :
        member.kind === 'group' ? this.#canvasGroupEntityIds(active, workspaceId, member.id) : []);
      await this.#commitCanvasCommand(active, { command: 'a3.core.create-document', payload: { record } }, entities, { kind: 'group', workspaceId, id });
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  setCanvasGroupMembers(sessionId: string, workspaceId: string, groupId: string, expectedRevision: number, members: GroupMember[]): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const group = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'group' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === groupId.toLowerCase());
      demand(group?.kind === 'group', 'GROUP_MISSING', 'El grupo ya no está disponible en este workspace.');
      demand(Number.isSafeInteger(expectedRevision) && group.value.revision === expectedRevision, 'REVISION_CONFLICT', 'El grupo cambió; recarga antes de modificar sus miembros.');
      const scope = new Set([...this.#canvasGroupEntityIds(active, workspaceId, group.value.id), ...this.#canvasMemberEntityIds(active, workspaceId, members)]);
      await this.#commitCanvasCommand(active, { command: 'a3.core.set-group-members', payload: { ref: { kind: 'group', id: group.value.id, workspaceId }, members } }, [...scope]);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  renameCanvasGroup(sessionId: string, workspaceId: string, groupId: string, expectedRevision: number, name: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const group = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'group' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === groupId.toLowerCase());
      demand(group?.kind === 'group', 'GROUP_MISSING', 'El grupo ya no está disponible en este workspace.');
      demand(Number.isSafeInteger(expectedRevision) && group.value.revision === expectedRevision, 'REVISION_CONFLICT', 'El grupo cambió; recarga antes de renombrarlo.');
      demand(typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 120, 'INVALID_GROUP_NAME', 'El grupo necesita un nombre de 1 a 120 caracteres.');
      await this.#commitCanvasCommand(active, { command: 'a3.core.rename', payload: { ref: { kind: 'group', id: group.value.id, workspaceId }, name: name.trim() } }, this.#canvasGroupEntityIds(active, workspaceId, group.value.id));
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  moveCanvasGroup(sessionId: string, workspaceId: string, groupId: string, expectedRevision: number, offset: { x: number; y: number }): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const group = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'group' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === groupId.toLowerCase());
      demand(group?.kind === 'group', 'GROUP_MISSING', 'El grupo ya no está disponible en este workspace.');
      demand(Number.isSafeInteger(expectedRevision) && group.value.revision === expectedRevision, 'REVISION_CONFLICT', 'El grupo cambió; recarga antes de moverlo.');
      await this.#commitCanvasCommand(active, { command: 'a3.core.move-group', payload: { ref: { kind: 'group', id: group.value.id, workspaceId }, offset } }, this.#canvasGroupEntityIds(active, workspaceId, group.value.id));
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  setCanvasGroupCollapsed(sessionId: string, workspaceId: string, groupId: string, expectedRevision: number, collapsed: boolean): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const group = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'group' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === groupId.toLowerCase());
      demand(group?.kind === 'group', 'GROUP_MISSING', 'El grupo ya no está disponible en este workspace.');
      demand(Number.isSafeInteger(expectedRevision) && group.value.revision === expectedRevision, 'REVISION_CONFLICT', 'El grupo cambió; recarga antes de contraerlo.');
      await this.#commitCanvasCommand(active, { command: 'a3.core.set-group-collapsed', payload: { ref: { kind: 'group', id: group.value.id, workspaceId }, collapsed } }, this.#canvasGroupEntityIds(active, workspaceId, group.value.id));
      return this.#canvasWorkspace(sessionId, workspaceId);
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
  changeCanvasUml(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, operation: UmlOperation): Promise<LocalCanvasWorkspace> {
    const captured = structuredClone(operation);
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(validUmlOperation(captured), 'UML_OPERATION_INVALID', 'La operación UML no cumple el contrato.');
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision, 'REVISION_CONFLICT', 'El workspace cambió; recarga antes de editar UML.');
      const ids: UmlChange['ids'] = { entityId: randomUUID(), placementId: randomUUID(), relationId: randomUUID(), relationViewId: randomUUID() };
      const absent: DocumentRef[] = [];
      if (captured.action === 'create-element') absent.push({ kind: 'entity', id: ids.entityId });
      if (['create-element', 'show-element'].includes(captured.action)) absent.push({ kind: 'placement', id: ids.placementId, workspaceId });
      if (captured.action === 'create-relationship') absent.push({ kind: 'relation', id: ids.relationId });
      if (['create-relationship', 'show-relationship'].includes(captured.action)) absent.push({ kind: 'relation-view', id: ids.relationViewId, workspaceId });
      const scope = active.lease.service.state.project.snapshot.records.flatMap((r) => r.kind === 'entity' ? [r.value.id] : []);
      await this.#commitCanvasCommand(active, { command: 'a3.uml.change', payload: { workspaceId, operation: captured, ids } }, [...scope, ids.entityId], absent);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  changeCanvasEr(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, operation: ErOperation): Promise<LocalCanvasWorkspace> {
    const captured = structuredClone(operation);
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(validErOperation(captured), 'ER_OPERATION_INVALID', 'La operación ER no cumple el contrato.');
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision, 'REVISION_CONFLICT', 'El workspace cambió; recarga antes de editar ER.');
      const ids: ErChange['ids'] = { entityId: randomUUID(), placementId: randomUUID(), relationId: randomUUID(), relationViewId: randomUUID() };
      const absent: DocumentRef[] = [];
      if (captured.action === 'create-table') absent.push({ kind: 'entity', id: ids.entityId });
      if (['create-table', 'show-table'].includes(captured.action)) absent.push({ kind: 'placement', id: ids.placementId, workspaceId });
      if (captured.action === 'create-relationship') absent.push({ kind: 'relation', id: ids.relationId });
      if (['create-relationship', 'show-relationship'].includes(captured.action)) absent.push({ kind: 'relation-view', id: ids.relationViewId, workspaceId });
      const scope = active.lease.service.state.project.snapshot.records.flatMap((r) => r.kind === 'entity' ? [r.value.id] : []);
      await this.#commitCanvasCommand(active, { command: 'a3.er.change', payload: { workspaceId, operation: captured, ids } }, [...scope, ids.entityId], absent);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  createCanvasIotComponent(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, catalogId: string, title: string, position: { x: number; y: number }): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId), view = this.#canvasWorkspace(sessionId, workspaceId);
      demand(view.canWrite, 'PERMISSION_DENIED', 'El proyecto no permite insertar componentes IoT.');
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision,
        'REVISION_CONFLICT', 'El workspace cambió; recarga antes de insertar el componente.');
      const entry = iotCatalogEntry(catalogId);
      demand(entry && !entry.template, 'IOT_CATALOG_ENTRY_UNAVAILABLE', 'La pieza no es un componente concreto disponible para instanciar.');
      demand(typeof title === 'string' && title.trim().length > 0 && title.trim().length <= 200 && position && Number.isFinite(position.x) && Number.isFinite(position.y),
        'IOT_COMPONENT_INVALID', 'El título y la posición del componente deben ser válidos.');
      const entityId = randomUUID(), placementId = randomUUID();
      await this.#commitCanvasCommand(active, { command: 'a3.iot.create-component', payload: { workspaceId, entityId, placementId, catalogId, title: title.trim(), position } },
        [entityId], [{ kind: 'entity', id: entityId }, { kind: 'placement', id: placementId, workspaceId }]);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  createCanvasIotCircuit(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, title: string, position: { x: number; y: number }): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId), view = this.#canvasWorkspace(sessionId, workspaceId);
      demand(view.canWrite, 'PERMISSION_DENIED', 'El proyecto no permite crear un circuito IoT.');
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision,
        'REVISION_CONFLICT', 'El workspace cambió; recarga antes de crear el circuito.');
      demand(typeof title === 'string' && title.trim().length > 0 && title.trim().length <= 200 && position && Number.isFinite(position.x) && Number.isFinite(position.y),
        'IOT_CIRCUIT_INVALID', 'El título y la posición del circuito deben ser válidos.');
      const entityId = randomUUID(), placementId = randomUUID();
      await this.#commitCanvasCommand(active, { command: 'a3.iot.create-circuit', payload: { workspaceId, entityId, placementId, title: title.trim(), position } },
        [entityId], [{ kind: 'entity', id: entityId }, { kind: 'placement', id: placementId, workspaceId }]);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  changeCanvasIotCircuit(sessionId: string, workspaceId: string, entityId: string, expectedRevision: number, model: IotCircuitData): Promise<LocalCanvasWorkspace> {
    const captured = structuredClone(model);
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId), view = this.#canvasWorkspace(sessionId, workspaceId);
      demand(view.canWrite, 'PERMISSION_DENIED', 'El proyecto no permite editar el circuito IoT.');
      const record = active.lease.service.state.project.snapshot.records.find((item) => item.kind === 'entity' && item.value.id.toLowerCase() === entityId.toLowerCase());
      demand(record?.kind === 'entity' && isIotCircuit(record.value), 'IOT_CIRCUIT_MISSING', 'El circuito ya no está disponible en el proyecto.');
      demand(Number.isSafeInteger(expectedRevision) && record.value.revision === expectedRevision, 'REVISION_CONFLICT', 'El circuito cambió; compara el modelo antes de guardar.');
      demand(validIotCircuitOperation({ kind: 'replace-model', model: captured }), 'IOT_CIRCUIT_INVALID', 'El modelo del circuito no cumple el formato A3.');
      const workspaceEntityIds = new Set(view.entities.filter((entity) => isIotComponent(entity)).map((entity) => entity.id.toLowerCase()));
      demand(captured.instances.every((instance) => workspaceEntityIds.has(instance.entityId.toLowerCase())), 'IOT_INSTANCE_NOT_IN_WORKSPACE',
        'Cada instancia del circuito debe ser un componente IoT visible en este workspace.');
      const scope = [record.value.id, ...captured.instances.map((instance) => instance.entityId)];
      await this.#commitCanvasCommand(active, { command: 'a3.iot.change-circuit', payload: { entityId: record.value.id, operation: { kind: 'replace-model', model: captured } } }, scope);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  changeCanvasC4(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, operation: C4Operation): Promise<LocalCanvasWorkspace> {
    const captured = structuredClone(operation);
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(validC4Operation(captured), 'C4_OPERATION_INVALID', 'La operación C4 no cumple el contrato.');
      demand(workspace.revision === expectedWorkspaceRevision, 'REVISION_CONFLICT', 'El workspace cambió; recarga antes de editar C4.');
      const ids: C4Change['ids'] = { entityId: randomUUID(), placementId: randomUUID(), relationId: randomUUID(), relationViewId: randomUUID(), diagramId: randomUUID() };
      const snapshot = active.lease.service.state.project.snapshot, absent: DocumentRef[] = [];
      const targetWorkspace = captured.action === 'configure-view' && captured.newWorkspace ? randomUUID() : workspaceId;
      switch (captured.action) {
        case 'create-element': absent.push({ kind: 'entity', id: ids.entityId }, { kind: 'placement', id: ids.placementId, workspaceId }); break;
        case 'show-element': absent.push({ kind: 'placement', id: ids.placementId, workspaceId }); break;
        case 'create-relationship': absent.push({ kind: 'relation', id: ids.relationId }, { kind: 'relation-view', id: ids.relationViewId, workspaceId }); break;
        case 'show-relationship': absent.push({ kind: 'relation-view', id: ids.relationViewId, workspaceId }); break;
        case 'configure-view': {
          if (captured.newWorkspace) absent.push({ kind: 'workspace', id: targetWorkspace });
          const existing = !captured.newWorkspace && workspace.properties['a3.c4.diagram-id'];
          if (typeof existing === 'string') ids.diagramId = existing;
          else absent.push({ kind: 'entity', id: ids.diagramId });
          break;
        }
      }
      const scope = snapshot.records.flatMap((r) => r.kind === 'entity' ? [r.value.id] : []);
      await this.#commitCanvasCommand(active, { command: 'a3.c4.change', payload: { workspaceId: targetWorkspace, operation: captured, ids } },
        [...scope, ids.entityId, ids.diagramId], absent);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  createCanvasConceptualNode(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number, kind: ConceptualNodeKind, title: string, position: { x: number; y: number }): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision, 'REVISION_CONFLICT', 'El workspace cambió; recarga antes de añadir el nodo conceptual.');
      const entityId = randomUUID(), placementId = randomUUID();
      await this.#commitCanvasCommand(active, { command: 'a3.conceptual.create-node', payload: { workspaceId, entityId, placementId, kind, title, position } },
        [entityId], [{ kind: 'entity', id: entityId }, { kind: 'placement', id: placementId, workspaceId }]);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  updateCanvasConceptualNode(sessionId: string, workspaceId: string, entityId: string, expectedRevision: number, patch: { title?: string; kind?: ConceptualNodeKind }): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const entity = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'entity' && record.value.id.toLowerCase() === entityId.toLowerCase());
      demand(entity?.kind === 'entity' && conceptualNodeKind(entity.value.type, entity.value.typeVersion) !== undefined, 'CONCEPTUAL_NODE_MISSING', 'El nodo conceptual ya no está disponible.');
      demand(Number.isSafeInteger(expectedRevision) && entity.value.revision === expectedRevision, 'REVISION_CONFLICT', 'El nodo cambió; recarga el inspector antes de editar.');
      demand(active.lease.service.state.project.snapshot.records.some((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.entityId.toLowerCase() === entityId.toLowerCase()),
        'CONCEPTUAL_NODE_MISSING', 'El nodo ya no está representado en este workspace.');
      await this.#commitCanvasCommand(active, { command: 'a3.conceptual.update-node', payload: { workspaceId, entityId: entity.value.id, ...patch } }, [entity.value.id]);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  createCanvasConceptualRelation(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number,
    sourcePlacementId: string, targetPlacementId: string, label: string, kind?: ConceptualRelationKind): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision, 'REVISION_CONFLICT', 'El workspace cambió; recarga antes de crear la relación.');
      const snapshot = active.lease.service.state.project.snapshot;
      const source = snapshot.records.find((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === sourcePlacementId.toLowerCase());
      const target = snapshot.records.find((record) => record.kind === 'placement' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === targetPlacementId.toLowerCase());
      demand(source?.kind === 'placement' && target?.kind === 'placement', 'CONCEPTUAL_PLACEMENT_MISSING', 'Selecciona dos representaciones del workspace.');
      const entities = new Map(snapshot.records.filter((record): record is Extract<DomainRecord, { kind: 'entity' }> => record.kind === 'entity').map((record) => [record.value.id.toLowerCase(), record]));
      demand(entities.has(source.value.entityId.toLowerCase()) && entities.has(target.value.entityId.toLowerCase()) &&
        conceptualNodeKind(entities.get(source.value.entityId.toLowerCase())!.value.type, entities.get(source.value.entityId.toLowerCase())!.value.typeVersion) !== undefined &&
        conceptualNodeKind(entities.get(target.value.entityId.toLowerCase())!.value.type, entities.get(target.value.entityId.toLowerCase())!.value.typeVersion) !== undefined,
      'CONCEPTUAL_ENDPOINT_REQUIRED', 'Las relaciones conceptuales solo conectan nodos de esta familia.');
      const relationId = randomUUID(), relationViewId = randomUUID();
      await this.#commitCanvasCommand(active, { command: 'a3.conceptual.create-relation', payload: { workspaceId, relationId, relationViewId,
        sourcePlacementId: source.value.id, targetPlacementId: target.value.id, label, ...(kind ? { kind } : {}) } },
      [entities.get(source.value.entityId.toLowerCase())!.value.id, entities.get(target.value.entityId.toLowerCase())!.value.id],
      [{ kind: 'relation', id: relationId }, { kind: 'relation-view', id: relationViewId, workspaceId }]);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  updateCanvasConceptualRelation(sessionId: string, workspaceId: string, relationId: string, expectedRevision: number,
    patch: { label?: string; kind?: ConceptualRelationKind | null }): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const relation = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'relation' && record.value.id.toLowerCase() === relationId.toLowerCase());
      demand(relation?.kind === 'relation' && isConceptualRelation(relation.value) && active.lease.service.state.project.snapshot.records.some((record) => record.kind === 'relation-view' &&
        record.workspaceId === workspaceId && record.value.relationId.toLowerCase() === relationId.toLowerCase()), 'CONCEPTUAL_RELATION_MISSING', 'La relación conceptual ya no está disponible en este workspace.');
      demand(Number.isSafeInteger(expectedRevision) && relation.value.revision === expectedRevision, 'REVISION_CONFLICT', 'La relación cambió; recarga el inspector antes de editar.');
      await this.#commitCanvasCommand(active, { command: 'a3.conceptual.update-relation', payload: { workspaceId, relationId: relation.value.id, ...patch } },
        [relation.value.source.entityId, relation.value.target.entityId]);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  deleteCanvasConceptualRelation(sessionId: string, workspaceId: string, relationId: string, expectedRevision: number): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const relation = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'relation' && record.value.id.toLowerCase() === relationId.toLowerCase());
      demand(relation?.kind === 'relation' && isConceptualRelation(relation.value) && active.lease.service.state.project.snapshot.records.some((record) => record.kind === 'relation-view' &&
        record.workspaceId === workspaceId && record.value.relationId.toLowerCase() === relationId.toLowerCase()), 'CONCEPTUAL_RELATION_MISSING', 'La relación conceptual ya no está disponible en este workspace.');
      demand(Number.isSafeInteger(expectedRevision) && relation.value.revision === expectedRevision, 'REVISION_CONFLICT', 'La relación cambió; recarga el inspector antes de borrarla.');
      await this.#commitCanvasCommand(active, { command: 'a3.conceptual.delete-relation', payload: { workspaceId, relationId: relation.value.id } },
        [relation.value.source.entityId, relation.value.target.entityId]);
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
  approveCanvasDrawingDeletion(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      demand(this.options.host.authenticatedActor.kind === 'user', 'PERMISSION_DENIED', 'Solo una persona puede solicitar permisos locales.');
      demand(await this.options.host.capabilities.setGrant({ root: active.lease.service.root, projectId: active.projectId, capability: 'delete', mode: 'approval' }),
        'PERMISSION_DENIED', 'El permiso de eliminación no fue aprobado.');
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  approveCanvasHistoryDeletion(sessionId: string, workspaceId: string): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      demand(this.options.host.authenticatedActor.kind === 'user', 'PERMISSION_DENIED', 'Solo una persona puede solicitar permisos locales.');
      demand(await this.options.host.capabilities.setGrant({ root: active.lease.service.root, projectId: active.projectId, capability: 'delete', mode: 'approval' }),
        'PERMISSION_DENIED', 'El permiso de eliminación para el historial no fue aprobado.');
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  createCanvasDrawing(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number,
    points: DrawingPoint[], parameters: DrawingParameters, style: Drawing['style'] = {}): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision,
        'REVISION_CONFLICT', 'El workspace cambió; recarga antes de guardar el trazo.');
      const id = randomUUID();
      const record: DomainRecord = { kind: 'drawing', workspaceId, value: { schemaVersion: '1.0.0', id, revision: 1,
        points, parameters, style, extensions: {} } };
      await this.#commitCanvasCommand(active, { command: 'a3.core.create-document', payload: { record } }, [], { kind: 'drawing', workspaceId, id });
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  updateCanvasDrawing(sessionId: string, workspaceId: string, drawingId: string, expectedRevision: number, patch: CanvasDrawingPatch): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const drawing = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'drawing' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === drawingId.toLowerCase());
      demand(drawing?.kind === 'drawing', 'DRAWING_MISSING', 'El trazo ya no está disponible en este workspace.');
      demand(Number.isSafeInteger(expectedRevision) && drawing.value.revision === expectedRevision, 'REVISION_CONFLICT', 'El trazo cambió; recárgalo antes de editar.');
      await this.#commitCanvasCommand(active, { command: 'a3.core.update-drawing', payload: { ...patch, ref: { kind: 'drawing', id: drawing.value.id, workspaceId } } }, []);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  deleteCanvasDrawing(sessionId: string, workspaceId: string, drawingId: string, expectedRevision: number): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active } = this.#canvasContext(sessionId, workspaceId);
      const drawing = active.lease.service.state.project.snapshot.records.find((record) => record.kind === 'drawing' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === drawingId.toLowerCase());
      demand(drawing?.kind === 'drawing', 'DRAWING_MISSING', 'El trazo ya no está disponible en este workspace.');
      demand(Number.isSafeInteger(expectedRevision) && drawing.value.revision === expectedRevision, 'REVISION_CONFLICT', 'El trazo cambió; recárgalo antes de borrarlo.');
      await this.#commitCanvasCommand(active, { command: 'a3.core.delete', payload: { ref: { kind: 'drawing', id: drawing.value.id, workspaceId } } }, []);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
  }
  createCanvasDrawingNode(sessionId: string, workspaceId: string, expectedWorkspaceRevision: number,
    drawings: { id: string; expectedRevision: number }[]): Promise<LocalCanvasWorkspace> {
    return this.#queue(async () => {
      const { active, workspace } = this.#canvasContext(sessionId, workspaceId);
      demand(Number.isSafeInteger(expectedWorkspaceRevision) && workspace.revision === expectedWorkspaceRevision,
        'REVISION_CONFLICT', 'El workspace cambió; recarga antes de convertir los trazos.');
      demand(Array.isArray(drawings) && drawings.length > 0 && drawings.length <= 256 &&
        new Set(drawings.map((drawing) => drawing.id.toLowerCase())).size === drawings.length, 'INVALID_DRAWING_SELECTION', 'Selecciona trazos únicos del workspace.');
      const snapshot = active.lease.service.state.project.snapshot;
      for (const selected of drawings) {
        const drawing = snapshot.records.find((record) => record.kind === 'drawing' && record.workspaceId === workspaceId && record.value.id.toLowerCase() === selected.id.toLowerCase());
        demand(drawing?.kind === 'drawing' && drawing.value.revision === selected.expectedRevision, 'REVISION_CONFLICT', 'Uno de los trazos cambió; recarga la selección antes de convertirla.');
      }
      const entityId = randomUUID(), resourceId = randomUUID(), placementId = randomUUID();
      await this.#commitCanvasCommand(active, { command: 'a3.core.convert-drawings-to-node', payload: { workspaceId, drawingIds: drawings.map(({ id }) => id),
        entityId, resourceId, placementId, title: drawings.length === 1 ? 'Dibujo' : `Dibujo (${drawings.length})` } }, [entityId], [
        { kind: 'entity', id: entityId }, { kind: 'resource', id: resourceId }, { kind: 'placement', id: placementId, workspaceId }
      ]);
      return this.#canvasWorkspace(sessionId, workspaceId);
    });
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
  moveExplorerItem(itemId: string, destination: string, sessionId: string): Promise<void> { return this.#queue(async () => {
    const active = this.#explorerContext(sessionId), item = this.#explorerPath(itemId, sessionId);
    demand(item.kind !== 'blocked-link', 'LINK_BLOCKED', 'Los enlaces no se mueven desde el explorador.');
    await this.#commitExplorer(active, 'rename', { sourcePath: item.path, targetPath: destination, identity: item.identity, cleanupDirectory: item.kind === 'directory' });
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
