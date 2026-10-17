import type { CanvasContentNodeInput, CanvasDrawingPatch, CanvasPlacementMove, CanvasPlacementViewPatch, CanvasSelection, CanvasVisualEdgePatch, LocalCanvasWorkspace, WorkspaceViewport, LocalExplorerDeletePreview, LocalExplorerListing, LocalExplorerOpen, LocalProjectsState, MediaGalleryCatalog, MediaGalleryPreview } from '@a3/project-store';
import type { ConceptualNodeKind, ConceptualRelationKind, Drawing, DrawingParameters, DrawingPoint, GroupMember } from '@a3/domain';
import type { C4Operation } from '@a3/domain';
import type { UmlOperation } from '@a3/domain';
import type { ErOperation } from '@a3/domain/er';
import type { IotCircuitData } from '@a3/domain/iot-circuit';
import type { DiagramStyleProfile } from '@a3/domain';
export type { CanvasErState, CanvasErElement, CanvasErRelationship, CanvasErRelationView } from '@a3/project-store';
export type { CanvasUmlState, CanvasUmlElement, CanvasUmlRelationship, CanvasUmlRelationView } from '@a3/project-store';
export type { CanvasC4State, CanvasC4Element, CanvasC4Relationship, CanvasC4RelationView } from '@a3/project-store';
export type { CanvasEntityChoice, CanvasEntitySummary, CanvasPlacementView, CanvasPlacementViewPatch, CanvasSelection, CanvasSelectionRef, CanvasVisualEdgePatch, CanvasVisualEdgeView, CanvasConceptualRelationView, CanvasDrawingView, CanvasDrawingPatch, CanvasGroupView, CanvasResourceDescriptor, CanvasResourceChoice, CanvasResourcePreview, CanvasMermaidImportPreview, CanvasPlantUmlImportPreview, CanvasStructurizrImportPreview, MarkdownDocument, MarkdownAsset, LocalCanvasWorkspace, DiagramStyleState } from '@a3/project-store';
export type { MediaGalleryCatalog, MediaGalleryItem, MediaGalleryKind, MediaGalleryWorkspace, MediaGalleryGroup, MediaGalleryCollection, MediaGalleryRepresentation, MediaGalleryPreview } from '@a3/project-store';
export type { LocalProjectsState, LocalProjectSession, LocalExplorerDeletePreview, LocalExplorerEntry, LocalExplorerListing, LocalExplorerMount, LocalExplorerOpen } from '@a3/project-store';
// This bridge never carries effective grants, raw services or filesystem handles.
export const APP_INFO_CHANNEL = 'a3.shell:get-app-info';
export const PROJECTS_CHANNEL = 'a3.projects:command';
export const FILES_CHANNEL = 'a3.files:command';
export const CANVAS_CHANNEL = 'a3.canvas:command';
export const MARKDOWN_CHANNEL = 'a3.markdown:document';
export const WORKSPACE_SESSION_CHANNEL = 'a3.workspace:session';
export const NAVIGATION_CHANNEL = 'a3.navigation:command';
export const GALLERY_CHANNEL = 'a3.gallery:command';
export const IMAGE_CONVERSION_CHANNEL = 'a3.media:image-conversion';
export const AV_CONVERSION_CHANNEL = 'a3.media:av-conversion';
export const VARIABLES_CHANNEL = 'a3.variables:command';
export type { AvRequest, AvResult, AvJobView, AvEngineInfo, AvSettings } from './av-conversion';
export type { ImageConversionRequest, ImageConversionResult, ImageConversionView, ImageConversionSettings, ImageInspection, ImageOutputInfo } from './image-conversion';
export type GalleryRequest = { action: 'load'; sessionId: string } | { action: 'preview'; sessionId: string; resourceId: string; purpose?: 'preview' | 'playback' };
export type GalleryValue = MediaGalleryCatalog | MediaGalleryPreview;
export type GalleryResult = { ok: true; value: GalleryValue } | { ok: false; error: { code: string; message: string; recovery: string } };
export type { NavigationIndex, NavigationPage, PageLink, MenuPermissions, PageAnchor } from '@a3/project-store';
export type NavigationRequest = { action: 'index' | 'permissions'; sessionId: string }
  | { action: 'resolve'; sessionId: string; sourceId: string; target: string; kind: 'wiki' | 'markdown' }
  | { action: 'copy-link'; sessionId: string; entityId: string }
  | { action: 'rename-page'; sessionId: string; entityId: string; expectedRevision: number; title: string }
  | { action: 'move-page'; sessionId: string; entityId: string; expectedRevision: number; destination: string }
  | { action: 'shortcuts-load' | 'shortcuts-reset' }
  | { action: 'shortcuts-save'; bindings: import('@a3/domain').ShortcutBindings };
export type NavigationValue = import('@a3/project-store').NavigationIndex | import('@a3/project-store').MenuPermissions |
  Omit<import('@a3/project-store').PageLink, 'start' | 'end' | 'label'> | import('@a3/domain').ShortcutBindings | { changed: true };
export type NavigationResult = { ok: true; value: NavigationValue } | { ok: false; error: { code: string; message: string; recovery: string } };
export type { WorkspaceSession, WorkspaceSessionAction, PageViewState, CanvasViewState, FocusTab, PageReference } from '@a3/project-store';
export type WorkspaceSessionRequest = ({ action: 'load' } | { action: 'reference'; tabId: string } | { action: 'locate'; tabId: string } | (Exclude<import('@a3/project-store').WorkspaceSessionAction, { action: 'load' }> & { expectedRevision: number })) & { sessionId: string };
export type WorkspaceSessionResult = { ok: true; value: import('@a3/project-store').WorkspaceSession | import('@a3/project-store').PageReference | { located: boolean } } | { ok: false; error: { code: string; message: string; recovery: string } };
export const CODE_CHANNEL = 'a3.code:document';
export type { CodeDocument, CodeOpenTarget } from '@a3/project-store';
export type CodeRequest =
  | { action: 'open'; sessionId: string; target: import('@a3/project-store').CodeOpenTarget }
  | { action: 'reload'; sessionId: string; documentId: string }
  | { action: 'save'; sessionId: string; documentId: string; expectedRevision: number | null; expectedHash: string; content: string };
export type CodeResult = { ok: true; value: import('@a3/project-store').CodeDocument } | { ok: false; error: { code: string; message: string; recovery: string } };
export const DROP_STAGE_CHANNEL = 'a3.canvas:stage-drop';
export type CanvasRequest =
  | CanvasExportRequest
  | { action: 'export-cancel'; sessionId: string; jobId: string }
  | { action: 'diagram-style-load'; sessionId: string; workspaceId: string }
  | { action: 'diagram-style-save'; sessionId: string; workspaceId: string; expectedProjectRevision: number; profile: DiagramStyleProfile }
  | { action: 'plantuml-render'; sessionId: string; workspaceId: string; sourceEntityId: string; placementId: string }
  | { action: 'plantuml-import-preview'; sessionId: string; workspaceId: string; sourceEntityId: string }
  | { action: 'plantuml-import-apply'; sessionId: string; workspaceId: string; token: string; authority: 'source' | 'a3-model' }
  | { action: 'structurizr-import-preview'; sessionId: string; workspaceId: string; sourceEntityId: string }
  | { action: 'structurizr-import-apply'; sessionId: string; workspaceId: string; token: string; authority: 'source' | 'a3-model'; viewKey: string }
  | { action: 'mermaid-import-preview'; sessionId: string; workspaceId: string; sourceEntityId: string }
  | { action: 'mermaid-import-apply'; sessionId: string; workspaceId: string; token: string; authority: 'source' | 'a3-model' }
  | { action: 'uml'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; operation: UmlOperation }
  | { action: 'er'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; operation: ErOperation }
  | { action: 'create-iot-component'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; catalogId: string; title: string; position: { x: number; y: number } }
  | { action: 'create-iot-circuit'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; title: string; position: { x: number; y: number } }
  | { action: 'change-iot-circuit'; sessionId: string; workspaceId: string; entityId: string; expectedRevision: number; model: IotCircuitData }
  | { action: 'c4'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; operation: C4Operation }
  | { action: 'load' | 'flush' | 'discard' | 'approve-edge-delete' | 'approve-drawing-delete' | 'approve-history-delete'; sessionId: string; workspaceId: string }
  | { action: 'stage'; sessionId: string; workspaceId: string; expectedRevision: number; viewport: WorkspaceViewport }
  | { action: 'create-placement'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; entityId: string; position: { x: number; y: number } }
  | { action: 'create-content-node'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; node: CanvasContentNodeInput }
  | { action: 'create-conceptual-node'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; kind: ConceptualNodeKind; title: string; position: { x: number; y: number } }
  | { action: 'update-conceptual-node'; sessionId: string; workspaceId: string; entityId: string; expectedRevision: number; patch: { title?: string; kind?: ConceptualNodeKind } }
  | { action: 'create-conceptual-relation'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; sourcePlacementId: string; targetPlacementId: string; label: string; kind?: ConceptualRelationKind }
  | { action: 'update-conceptual-relation'; sessionId: string; workspaceId: string; relationId: string; expectedRevision: number; patch: { label?: string; kind?: ConceptualRelationKind | null } }
  | { action: 'delete-conceptual-relation'; sessionId: string; workspaceId: string; relationId: string; expectedRevision: number }
  | { action: 'smart-paste'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; position: { x: number; y: number }; mode: 'smart' | 'text' }
  | { action: 'drop-file'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; position: { x: number; y: number }; token: string; mode: 'copy' | 'reference' | 'move' }
  | { action: 'cancel-drop'; token: string; sessionId: string; workspaceId: string }
  | { action: 'duplicate-selection'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; selection: CanvasSelection; mode: 'content' | 'representation' }
  | { action: 'undo' | 'redo'; sessionId: string; workspaceId: string }
  | { action: 'update-placement'; sessionId: string; workspaceId: string; placementId: string; expectedRevision: number;
      patch: { position?: { x: number; y: number }; size?: { width: number; height: number }; style?: Record<string, unknown> } }
  | { action: 'move-placements'; sessionId: string; workspaceId: string; placements: CanvasPlacementMove[] }
  | { action: 'update-placement-views'; sessionId: string; workspaceId: string; placements: CanvasPlacementViewPatch[] }
  | { action: 'create-group'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; name: string; members: GroupMember[] }
  | { action: 'set-group-members'; sessionId: string; workspaceId: string; groupId: string; expectedRevision: number; members: GroupMember[] }
  | { action: 'rename-group'; sessionId: string; workspaceId: string; groupId: string; expectedRevision: number; name: string }
  | { action: 'move-group'; sessionId: string; workspaceId: string; groupId: string; expectedRevision: number; offset: { x: number; y: number } }
  | { action: 'set-group-collapsed'; sessionId: string; workspaceId: string; groupId: string; expectedRevision: number; collapsed: boolean }
  | { action: 'create-visual-edge'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; sourcePlacementId: string; targetPlacementId: string }
  | { action: 'update-visual-edge'; sessionId: string; workspaceId: string; edgeId: string; expectedRevision: number; patch: CanvasVisualEdgePatch }
  | { action: 'delete-visual-edge'; sessionId: string; workspaceId: string; edgeId: string; expectedRevision: number }
  | { action: 'create-drawing'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; points: DrawingPoint[]; parameters: DrawingParameters; style?: Drawing['style'] }
  | { action: 'update-drawing'; sessionId: string; workspaceId: string; drawingId: string; expectedRevision: number; patch: CanvasDrawingPatch }
  | { action: 'delete-drawing'; sessionId: string; workspaceId: string; drawingId: string; expectedRevision: number }
  | { action: 'convert-drawings-to-node'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; drawings: { id: string; expectedRevision: number }[] };
export interface CanvasExportRequest {
  action: 'export'; sessionId: string; workspaceId: string; jobId: string; format: 'svg' | 'png' | 'pdf'; scope: import('@a3/project-store').CanvasExportScope;
  selection: import('@a3/project-store').CanvasExportSelection; groupId?: string;
  background: 'transparent' | 'opaque' | 'project'; margin: number; scale: number; fileName: string;
  paper: 'A3' | 'A4'; orientation: 'portrait' | 'landscape'; fit: 'page' | 'tiles';
}
export type CanvasExportOutcome = { cancelled: true } | { cancelled?: false; format: 'svg' | 'png' | 'pdf'; fileName: string; width: number; height: number; pages: number; rasterized: readonly string[]; diagnostics: readonly string[] };
export type CanvasExportResult = { ok: true; value: CanvasExportOutcome } | { ok: false; error: { code: string; message: string; recovery: string } };
export type CanvasContentRequest = { action: 'content'; sessionId: string; workspaceId: string; entityId: string; resourceId: string; purpose?: 'preview' | 'playback' };
export type MarkdownRequest =
  | { action: 'open'; sessionId: string; entityId: string; resourceId: string }
  | { action: 'asset'; sessionId: string; entityId: string; resourceId: string; reference: string }
  | { action: 'save'; sessionId: string; entityId: string; resourceId: string; entityRevision: number; expectedRevision: number; expectedHash: string; content: string };
export type MarkdownResult = { ok: true; value: import('@a3/project-store').MarkdownDocument | import('@a3/project-store').MarkdownAsset } | { ok: false; error: { code: string; message: string; recovery: string } };
export type CanvasResult = { ok: true; value: LocalCanvasWorkspace } | { ok: false; error: { code: string; message: string; recovery: string } };
export type CanvasStyleResult = { ok: true; value: import('@a3/project-store').DiagramStyleState } | { ok: false; error: { code: string; message: string; recovery: string } };
export type CanvasMermaidImportResult = { ok: true; value: import('@a3/project-store').CanvasMermaidImportPreview } | { ok: false; error: { code: string; message: string; recovery: string } };
export type CanvasPlantUmlImportResult = { ok: true; value: import('@a3/project-store').CanvasPlantUmlImportPreview } | { ok: false; error: { code: string; message: string; recovery: string } };
export type CanvasStructurizrImportResult = { ok: true; value: import('@a3/project-store').CanvasStructurizrImportPreview } | { ok: false; error: { code: string; message: string; recovery: string } };
export type CanvasPlantUmlRenderOutcome =
  | { state: 'rendered'; svg: string; sourceHash: string; rendererVersion: string; javaVersion: string }
  | { state: 'invalid' | 'timeout' | 'unavailable' | 'too-large'; message: string; line?: number; sourceHash?: string };
export type CanvasPlantUmlResult = { ok: true; value: CanvasPlantUmlRenderOutcome } | { ok: false; error: { code: string; message: string; recovery: string } };
export type CanvasContentResult = { ok: true; value: import('@a3/project-store').CanvasResourcePreview } | { ok: false; error: { code: string; message: string; recovery: string } };
export type FileDropNotice = { token: string; kind?: 'file' | 'folder'; files?: readonly { name: string; size: number; copyDestination: string; referenceDestination: string }[]; clientX: number; clientY: number; error?: string };
export type FileDropStageResult = { ok: true; value: { token: string; kind: 'file' | 'folder'; files: readonly { name: string; size: number; copyDestination: string; referenceDestination: string }[] } } | { ok: false; error: { code: string; message: string; recovery: string } };
export type ProjectsRequest =
  | { action: 'list' | 'open' | 'restore' }
  | { action: 'create'; name: string }
  | { action: 'recent' | 'relocate'; id: string }
  | { action: 'confirm' | 'cancel'; token: string }
  | { action: 'close'; sessionId: string }
  | { action: 'rename' | 'draft-name'; sessionId: string; name: string };
export type ProjectsResult = { ok: true; value: LocalProjectsState } | { ok: false; error: { code: string; message: string; recovery: string } };
export type FilesRequest =
  | { action: 'list'; sessionId: string; directoryId?: string; cursor?: string }
  | { action: 'open'; sessionId: string; itemId: string }
  | { action: 'open-mount'; sessionId: string; resourceId: string }
  | { action: 'create-file' | 'create-folder'; sessionId: string; parentId: string; name: string }
  | { action: 'rename'; sessionId: string; itemId: string; name: string }
  | { action: 'move'; sessionId: string; itemId: string; destination: string }
  | { action: 'duplicate'; sessionId: string; itemId: string; name?: string }
  | { action: 'preview-delete'; sessionId: string; itemId: string }
  | { action: 'cancel-delete' | 'confirm-delete'; sessionId: string; token: string }
  | { action: 'copy-path'; sessionId: string; itemId: string; kind: 'absolute' | 'relative' }
  | { action: 'copy-mount-path'; sessionId: string; resourceId: string; kind: 'absolute' | 'relative' };
export type FilesValue = LocalExplorerListing | LocalExplorerOpen | LocalExplorerDeletePreview | { copied: true } | { changed: true } | { cancelled: true };
export type FilesResult = { ok: true; value: FilesValue } | { ok: false; error: { code: string; message: string; recovery: string } };

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chromium: string;
  node: string;
}

export type ShellResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: 'PERMISSION_DENIED' | 'IO_FAILED'; message: string; recovery: string } };

export interface DesktopAPI {
  git(request: import('./git-operations').GitRequest): Promise<import('./git-operations').GitResult>;
  agentProfiles(request: import('./agent-profiles').AgentProfilesRequest): Promise<import('./agent-profiles').AgentProfilesResult>;
  codexAuthorization(request: import('./codex-auth').CodexAuthRequest): Promise<import('./codex-auth').CodexAuthResult>;
  manualChat(request: import('./manual-chat').ManualChatRequest): Promise<import('./manual-chat').ManualChatResult>;
  onManualChatFocus(listener: () => void): () => void;
  memorySearch(request: import('./memory-search').MemorySearchRequest): Promise<import('./memory-search').MemorySearchResult>;
  planning(request: import('./planning').PlanningRequest): Promise<import('./planning').PlanningResult>;
  variables(request: import('./variables').VariablesRequest): Promise<import('./variables').VariablesResult>;
  getAppInfo(): Promise<ShellResult<AppInfo>>;
  projects(request: ProjectsRequest): Promise<ProjectsResult>;
  workspaceSession(request: WorkspaceSessionRequest): Promise<WorkspaceSessionResult>;
  navigation(request: NavigationRequest): Promise<NavigationResult>;
  files(request: FilesRequest): Promise<FilesResult>;
  gallery(request: GalleryRequest): Promise<GalleryResult>;
  imageConversion(request: import('./image-conversion').ImageConversionRequest): Promise<import('./image-conversion').ImageConversionResult>;
  avConversion(request: import('./av-conversion').AvRequest): Promise<import('./av-conversion').AvResult>;
  canvas(request: Extract<CanvasRequest, { action: 'mermaid-import-preview' }>): Promise<CanvasMermaidImportResult>;
  canvas(request: Extract<CanvasRequest, { action: 'mermaid-import-apply' }>): Promise<CanvasResult>;
  canvas(request: Extract<CanvasRequest, { action: 'plantuml-import-preview' }>): Promise<CanvasPlantUmlImportResult>;
  canvas(request: Extract<CanvasRequest, { action: 'plantuml-import-apply' }>): Promise<CanvasResult>;
  canvas(request: Extract<CanvasRequest, { action: 'structurizr-import-preview' }>): Promise<CanvasStructurizrImportResult>;
  canvas(request: Extract<CanvasRequest, { action: 'structurizr-import-apply' }>): Promise<CanvasResult>;
  canvas(request: Extract<CanvasRequest, { action: 'plantuml-render' }>): Promise<CanvasPlantUmlResult>;
  canvas(request: Extract<CanvasRequest, { action: 'diagram-style-load' | 'diagram-style-save' }>): Promise<CanvasStyleResult>;
  canvas(request: Extract<CanvasRequest, { action: 'export' | 'export-cancel' }>): Promise<CanvasExportResult>;
  canvas(request: CanvasRequest): Promise<CanvasResult>;
  canvas(request: CanvasContentRequest): Promise<CanvasContentResult>;
  canvas(request: CanvasRequest): Promise<CanvasResult>;
  markdown(request: MarkdownRequest): Promise<MarkdownResult>;
  code(request: CodeRequest): Promise<CodeResult>;
  onFileDrop(listener: (notice: FileDropNotice) => void): () => void;
}
