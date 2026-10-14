const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('a3Demo', Object.freeze({
  copyText: (value) => ipcRenderer.invoke('app:copy-text', value),
  retryChat: () => ipcRenderer.invoke('chat:retry'),
  history: (direction) => ipcRenderer.invoke('chat:history', direction),
  openExternal: () => ipcRenderer.invoke('app:open-external'),
  onStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('chat:status', listener);
    return () => ipcRenderer.removeListener('chat:status', listener);
  },
  onNavigation: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('chat:navigation', listener);
    return () => ipcRenderer.removeListener('chat:navigation', listener);
  },
  onExternalLink: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('chat:external-link', listener);
    return () => ipcRenderer.removeListener('chat:external-link', listener);
  },
}));
