import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { GIT_OPERATIONS_CHANNEL, type GitRequest } from '../shared/git-operations';
import { GITHUB_CHANNEL, type GithubRequest } from '../shared/github-publishing';
import { HISTORY_CHANNEL, type HistoryRequest } from '../shared/history';
import { MEMORY_SEARCH_CHANNEL, type MemorySearchRequest } from '../shared/memory-search';
import { PLANNING_CHANNEL, type PlanningRequest } from '../shared/planning';
import { MANUAL_CHAT_CHANNEL, type ManualChatRequest } from '../shared/manual-chat';
import { CODEX_AUTH_CHANNEL, type CodexAuthRequest } from '../shared/codex-auth';
import { VARIABLES_CHANNEL } from '../shared/desktop-api';
import { AGENT_PROFILES_CHANNEL, type AgentProfilesRequest } from '../shared/agent-profiles';
import { EXTENSION_HOST_CHANNEL, type ExtensionsRequest } from '../shared/extensions';
import type { VariablesRequest } from '../shared/variables';
import { AV_CONVERSION_CHANNEL, IMAGE_CONVERSION_CHANNEL, type AvRequest, type ImageConversionRequest } from '../shared/desktop-api';
import { WORKSPACE_SESSION_CHANNEL, NAVIGATION_CHANNEL, type NavigationRequest, type WorkspaceSessionRequest } from '../shared/desktop-api';
import { APP_INFO_CHANNEL, CANVAS_CHANNEL, CODE_CHANNEL, DROP_STAGE_CHANNEL, FILES_CHANNEL, GALLERY_CHANNEL, MARKDOWN_CHANNEL, NODE_PACKAGES_CHANNEL, PROJECTS_CHANNEL, type DesktopAPI, type CanvasContentRequest, type CanvasRequest, type CodeRequest, type FileDropNotice, type FileDropStageResult, type FilesRequest, type GalleryRequest, type MarkdownRequest, type NodePackagesRequest, type ProjectsRequest } from '../shared/desktop-api';

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
  history: (request: HistoryRequest) => ipcRenderer.invoke(HISTORY_CHANNEL, request),
  git: (request: GitRequest) => ipcRenderer.invoke(GIT_OPERATIONS_CHANNEL, request),
  github: (request: GithubRequest) => ipcRenderer.invoke(GITHUB_CHANNEL, request),
  agentProfiles: (request: AgentProfilesRequest) => ipcRenderer.invoke(AGENT_PROFILES_CHANNEL, request),
  codexAuthorization: (request: CodexAuthRequest) => ipcRenderer.invoke(CODEX_AUTH_CHANNEL, request),
  manualChat: (request: ManualChatRequest) => ipcRenderer.invoke(MANUAL_CHAT_CHANNEL, request),
  onManualChatFocus: (listener: () => void) => { const handler = (): void => listener(); ipcRenderer.on('a3.manual-chat:focus-url', handler); return () => { ipcRenderer.removeListener('a3.manual-chat:focus-url', handler); }; },
  memorySearch: (request: MemorySearchRequest) => ipcRenderer.invoke(MEMORY_SEARCH_CHANNEL, request),
  planning: (request: PlanningRequest) => ipcRenderer.invoke(PLANNING_CHANNEL, request),
  variables: (request: VariablesRequest) => ipcRenderer.invoke(VARIABLES_CHANNEL, request),
  nodePackages: (request: NodePackagesRequest) => ipcRenderer.invoke(NODE_PACKAGES_CHANNEL, request),
  extensions: (request: ExtensionsRequest) => ipcRenderer.invoke(EXTENSION_HOST_CHANNEL, request),
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
