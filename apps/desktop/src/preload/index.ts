import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { APP_INFO_CHANNEL, CANVAS_CHANNEL, DROP_STAGE_CHANNEL, FILES_CHANNEL, PROJECTS_CHANNEL, type DesktopAPI, type CanvasContentRequest, type CanvasRequest, type FileDropNotice, type FileDropStageResult, type FilesRequest, type ProjectsRequest } from '../shared/desktop-api';

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
  files: (request: FilesRequest) => ipcRenderer.invoke(FILES_CHANNEL, request),
  canvas: ((request: CanvasRequest | CanvasContentRequest) => ipcRenderer.invoke(CANVAS_CHANNEL, request)) as DesktopAPI['canvas'],
  onFileDrop: (listener: (notice: FileDropNotice) => void) => { dropListeners.add(listener); return () => dropListeners.delete(listener); }
});

contextBridge.exposeInMainWorld('a3', api);
