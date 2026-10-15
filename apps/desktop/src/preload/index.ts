import { contextBridge, ipcRenderer } from 'electron';
import { APP_INFO_CHANNEL, PROJECTS_CHANNEL, type DesktopAPI, type ProjectsRequest } from '../shared/desktop-api';

const api: DesktopAPI = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  projects: (request: ProjectsRequest) => ipcRenderer.invoke(PROJECTS_CHANNEL, request)
});

contextBridge.exposeInMainWorld('a3', api);
