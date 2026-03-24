const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativeApp', {
  pickLaneBag: () => ipcRenderer.invoke('pick-lane-bag'),
});
