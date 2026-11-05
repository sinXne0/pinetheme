const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadReferenceTree: () => ipcRenderer.invoke('loadReferenceTree'),
  openThemeFolder: () => ipcRenderer.invoke('openThemeFolder'),
  readTree: (p) => ipcRenderer.invoke('readTree', p),
  pickSaveFolder: () => ipcRenderer.invoke('pickSaveFolder'),
  saveThemeToFolder: (files, folderPath) => ipcRenderer.invoke('saveThemeToFolder', files, folderPath),
  joinPath: (parent, name) => ipcRenderer.invoke('joinPath', parent, name),
  saveZip: (base64, defaultName) => ipcRenderer.invoke('saveZip', base64, defaultName),
  saveBinaryFile: (base64, defaultName, filters) => ipcRenderer.invoke('saveBinaryFile', base64, defaultName, filters),
  setDirty: (dirty) => ipcRenderer.send('setDirty', dirty),
  openZip: () => ipcRenderer.invoke('openZip'),
  pickAssetFiles: () => ipcRenderer.invoke('pickAssetFiles'),
  platform: process.platform
});
