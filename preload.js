const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dashboard', {
  // Data
  getAllData: () => ipcRenderer.invoke('get-all-data'),
  onDataUpdate: (cb) => ipcRenderer.on('data-update', (_e, d) => cb(d)),

  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // Sessions
  getSessionDetail: (id) => ipcRenderer.invoke('get-session-detail', id),
  exportSessions: (format, ids) => ipcRenderer.invoke('export-sessions', format, ids),

  // Window controls
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // Navigation
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
});
