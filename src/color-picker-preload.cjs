const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("colorPickerApi", {
  ready() {
    ipcRenderer.send("color-picker:ready");
  },
  onInit(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("color-picker:init", listener);
    return () => ipcRenderer.removeListener("color-picker:init", listener);
  },
  finish(color) {
    ipcRenderer.send("color-picker:result", color ?? null);
  },
});
