import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { AV_CONVERSION_CHANNEL, IMAGE_CONVERSION_CHANNEL, type AvRequest, type ImageConversionRequest } from '../shared/desktop-api';
import { WORKSPACE_SESSION_CHANNEL, NAVIGATION_CHANNEL, type NavigationRequest, type WorkspaceSessionRequest } from '../shared/desktop-api';
import { APP_INFO_CHANNEL, CANVAS_CHANNEL, CODE_CHANNEL, DROP_STAGE_CHANNEL, FILES_CHANNEL, GALLERY_CHANNEL, MARKDOWN_CHANNEL, PROJECTS_CHANNEL, type DesktopAPI, type CanvasContentRequest, type CanvasRequest, type CodeRequest, type FileDropNotice, type FileDropStageResult, type FilesRequest, type GalleryRequest, type MarkdownRequest, type ProjectsRequest } from '../shared/desktop-api';

const dropListeners = new Set<(notice: FileDropNotice) => void>();
window.addEventListener('dragover', (event) => {
  if (event.composedPath().some((entry) => entry instanceof HTMLElement && entry.hasAttribute('data-canvas-drop-target'))) event.preventDefault();
}, true);
window.addEventListener('drop', (event) => {
  if (!event.composedPath().some((entry) => entry instanceof HTMLElement && entry.hasAttribute('data-canvas-drop-target'))) return;
  event.preventDefault(); event.stopPropagation();
  const paths = [...(event.dataTransfer?.files ?? [])].map((file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  }).filter(Boolean);
  void ipcRenderer.invoke(DROP_STAGE_CHANNEL, paths).then((result: FileDropStageResult) => {
    if (!result.ok) {
      for (const listener of dropListeners) listener({ token: '', clientX: event.clientX, clientY: event.clientY, error: result.error.message });
      return;
    }
    const notice: FileDropNotice = { ...result.value, clientX: event.clientX, clientY: event.clientY };
    for (const listener of dropListeners) listener(notice);
  }).catch(() => undefined);
}, true);

const api: DesktopAPI = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  projects: (request: ProjectsRequest) => ipcRenderer.invoke(PROJECTS_CHANNEL, request),
  workspaceSession: (request: WorkspaceSessionRequest) => ipcRenderer.invoke(WORKSPACE_SESSION_CHANNEL, request),
  navigation: (request: NavigationRequest) => ipcRenderer.invoke(NAVIGATION_CHANNEL, request),
  files: (request: FilesRequest) => ipcRenderer.invoke(FILES_CHANNEL, request),
  gallery: (request: GalleryRequest) => ipcRenderer.invoke(GALLERY_CHANNEL, request),
  imageConversion: (request: ImageConversionRequest) => ipcRenderer.invoke(IMAGE_CONVERSION_CHANNEL, request),
  avConversion: (request: AvRequest) => ipcRenderer.invoke(AV_CONVERSION_CHANNEL, request),
  canvas: ((request: CanvasRequest | CanvasContentRequest) => ipcRenderer.invoke(CANVAS_CHANNEL, request)) as DesktopAPI['canvas'],
  markdown: (request: MarkdownRequest) => ipcRenderer.invoke(MARKDOWN_CHANNEL, request),
  code: (request: CodeRequest) => ipcRenderer.invoke(CODE_CHANNEL, request),
  onFileDrop: (listener: (notice: FileDropNotice) => void) => { dropListeners.add(listener); return () => dropListeners.delete(listener); }
});

contextBridge.exposeInMainWorld('a3', api);
