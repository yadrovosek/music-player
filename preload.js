const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('library:pick-folder'),
  scan: (folder) => ipcRenderer.invoke('library:scan', folder),
  pickImage: () => ipcRenderer.invoke('ui:pick-image'),
  cover: (filePath, size) => ipcRenderer.invoke('track:cover', filePath, size),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),

  // трей и мини-панель
  sendMeta: (m) => ipcRenderer.send('player:meta', m),
  sendTick: (t) => ipcRenderer.send('player:tick', t),
  onCmd: (cb) => ipcRenderer.on('player:cmd', (_e, cmd, value) => cb(cmd, value)),
  onMeta: (cb) => ipcRenderer.on('player:meta', (_e, m) => cb(m)),
  onTick: (cb) => ipcRenderer.on('player:tick', (_e, t) => cb(t)),
  onOpen: (cb) => ipcRenderer.on('mini:open', (_e, v) => cb(v)),
  cmd: (cmd, value) => ipcRenderer.send('mini:cmd', cmd, value),
  sendLibrary: (list) => ipcRenderer.send('library:update', list),
  discordToggle: () => ipcRenderer.invoke('discord:toggle'),
  discordConfig: () => ipcRenderer.invoke('discord:open-config'),
  onDiscord: (cb) => ipcRenderer.on('discord:status', (_e, s) => cb(s)),
  setCorner: (on) => ipcRenderer.send('app:corner', on),
});