const { contextBridge, ipcRenderer, webUtils } = require("electron");
contextBridge.exposeInMainWorld("api", {
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:write", text),
  clipboardMenu: (s) => ipcRenderer.invoke("clipboard:menu", s),
  windowReady: () => ipcRenderer.invoke("windows:ready"),
  newWindow: () => ipcRenderer.invoke("windows:new"),
  windows: () => ipcRenderer.invoke("windows:list"),
  focusWindow: (id) => ipcRenderer.invoke("windows:focus", id),
  moveTab: (s) => ipcRenderer.invoke("windows:move", s),
  tabMenu: (id) => ipcRenderer.invoke("windows:tab-menu", id),
  windowTitle: (name) => ipcRenderer.send("windows:title", name),
  renameWindow: (name) => ipcRenderer.invoke("windows:rename", name),
  windowTheme: (color) => ipcRenderer.send("window:theme", color),
  windowReply: (s) => ipcRenderer.send("window:reply", s),
  onWindow: (callback) => {
    const listener = (_e, m) => callback(m);
    ipcRenderer.on("window:event", listener);
    return () => ipcRenderer.removeListener("window:event", listener);
  },
  sessions: () => ipcRenderer.invoke("sessions:list"),
  previewSessionImport: (format) => ipcRenderer.invoke("sessions:import-preview", format),
  applySessionImport: (preview) => ipcRenderer.invoke("sessions:import-apply", preview),
  exportSshConfig: () => ipcRenderer.invoke("sessions:export-ssh"),
  settings: () => ipcRenderer.invoke("settings:get"),
  pickScreenColor: () => ipcRenderer.invoke("settings:pick-color"),
  chooseCache: () => ipcRenderer.invoke("settings:choose-cache"),
  applySettings: (settings) => ipcRenderer.invoke("settings:apply", settings),
  passwordHistory: () => ipcRenderer.invoke("password-history:list"),
  historyPassword: (id) => ipcRenderer.invoke("password-history:select", id),
  quickPasswords: () => ipcRenderer.invoke("password-vault:list"),
  saveQuickPassword: (entry) => ipcRenderer.invoke("password-vault:save", entry),
  revealQuickPassword: (id) => ipcRenderer.invoke("password-vault:reveal", id),
  removeQuickPassword: (id) => ipcRenderer.invoke("password-vault:remove", id),
  fillQuickPassword: (selection) => ipcRenderer.invoke("password-vault:fill", selection),
  reveal: (id) => ipcRenderer.invoke("sessions:reveal", id),
  test: (s) => ipcRenderer.invoke("ssh:test", s),
  encoding: (s) => ipcRenderer.invoke("ssh:encoding", s),
  save: (s) => ipcRenderer.invoke("sessions:save", s),
  duplicateSession: (id) => ipcRenderer.invoke("sessions:duplicate", id),
  remove: (id) => ipcRenderer.invoke("sessions:delete", id),
  connect: (s) => ipcRenderer.invoke("ssh:connect", s),
  duplicate: (s) => ipcRenderer.invoke("ssh:duplicate", s),
  send: (m) => ipcRenderer.send("ssh:send", m),
  list: (s) => ipcRenderer.invoke("sftp:list", s),
  statRemoteTarget: (s) => ipcRenderer.invoke("sftp:stat-target", s),
  removeRemote: (s) => ipcRenderer.invoke("sftp:remove", s),
  shellDirectory: (id) => ipcRenderer.invoke("ssh:directory", id),
  localDragAvailable: () => ipcRenderer.invoke("local-drag:available"),
  warmLocalDrag: () => ipcRenderer.send("local-drag:warm"),
  startLocalDrag: (s) => ipcRenderer.send("local-drag:start", s),
  armFinderDrag: (s) => ipcRenderer.send("finder-drag:arm", s),
  openRemoteEditor: (s) => ipcRenderer.invoke("editor:open", s),
  drop: (s, files) =>
    ipcRenderer.invoke("sftp:drop", {
      ...s,
      paths: Array.from(files, (file) => webUtils.getPathForFile(file)),
    }),
  remoteDrag: (s) => ipcRenderer.sendSync("sftp:drag-token", s),
  relay: (s) => ipcRenderer.invoke("sftp:relay", s),
  transfer: (s) => ipcRenderer.invoke("sftp:transfer", s),
  onEvent: (callback) => {
    const listener = (_e, m) => callback(m);
    ipcRenderer.on("ssh:event", listener);
    return () => ipcRenderer.removeListener("ssh:event", listener);
  },
});
