import type { CanvasDrawingPatch, CanvasPlacementMove, CanvasVisualEdgePatch, LocalCanvasWorkspace, WorkspaceViewport, LocalExplorerDeletePreview, LocalExplorerListing, LocalExplorerOpen, LocalProjectsState } from '@a3/project-store';
import type { Drawing, DrawingParameters, DrawingPoint, GroupMember } from '@a3/domain';
export type { CanvasEntityChoice, CanvasEntitySummary, CanvasPlacementView, CanvasVisualEdgePatch, CanvasVisualEdgeView, CanvasDrawingView, CanvasDrawingPatch, CanvasGroupView, CanvasResourcePreview, LocalCanvasWorkspace } from '@a3/project-store';
export type { LocalProjectsState, LocalProjectSession, LocalExplorerDeletePreview, LocalExplorerEntry, LocalExplorerListing, LocalExplorerMount, LocalExplorerOpen } from '@a3/project-store';
// This bridge never carries effective grants, raw services or filesystem handles.
export const APP_INFO_CHANNEL = 'a3.shell:get-app-info';
export const PROJECTS_CHANNEL = 'a3.projects:command';
export const FILES_CHANNEL = 'a3.files:command';
export const CANVAS_CHANNEL = 'a3.canvas:command';
export type CanvasRequest =
  | { action: 'load' | 'flush' | 'discard' | 'approve-edge-delete' | 'approve-drawing-delete'; sessionId: string; workspaceId: string }
  | { action: 'stage'; sessionId: string; workspaceId: string; expectedRevision: number; viewport: WorkspaceViewport }
  | { action: 'create-placement'; sessionId: string; workspaceId: string; expectedWorkspaceRevision: number; entityId: string; position: { x: number; y: number } }
  | { action: 'update-placement'; sessionId: string; workspaceId: string; placementId: string; expectedRevision: number;
      patch: { position?: { x: number; y: number }; size?: { width: number; height: number }; style?: Record<string, unknown> } }
  | { action: 'move-placements'; sessionId: string; workspaceId: string; placements: CanvasPlacementMove[] }
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
export type CanvasContentRequest = { action: 'content'; sessionId: string; workspaceId: string; entityId: string; resourceId: string };
export type CanvasResult = { ok: true; value: LocalCanvasWorkspace } | { ok: false; error: { code: string; message: string; recovery: string } };
export type CanvasContentResult = { ok: true; value: import('@a3/project-store').CanvasResourcePreview } | { ok: false; error: { code: string; message: string; recovery: string } };
export type ProjectsRequest =
  | { action: 'list' | 'open' }
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
  getAppInfo(): Promise<ShellResult<AppInfo>>;
  projects(request: ProjectsRequest): Promise<ProjectsResult>;
  files(request: FilesRequest): Promise<FilesResult>;
  canvas(request: CanvasContentRequest): Promise<CanvasContentResult>;
  canvas(request: CanvasRequest): Promise<CanvasResult>;
}
