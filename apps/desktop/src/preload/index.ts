import { contextBridge, ipcRenderer } from 'electron';
import { APP_INFO_CHANNEL, FILES_CHANNEL, PROJECTS_CHANNEL, type DesktopAPI, type FilesRequest, type ProjectsRequest } from '../shared/desktop-api';

const api: DesktopAPI = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  projects: (request: ProjectsRequest) => ipcRenderer.invoke(PROJECTS_CHANNEL, request),
  files: (request: FilesRequest) => ipcRenderer.invoke(FILES_CHANNEL, request)
});

contextBridge.exposeInMainWorld('a3', api);
