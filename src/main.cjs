const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  Menu,
  clipboard,
  session,
  desktopCapturer,
  screen,
} = require("electron");
const { createWindows } = require("./windows.cjs");
const { normalizeEncoding } = require("./codec.cjs");
const path = require("node:path");
const fs = require("node:fs/promises");
const { safeName, validateRemoteRemoval } = require("./transfers.cjs");
const { installEditorWindows } = require("./editor-windows.cjs");
const { installLocalDrag } = require("./local-drag.cjs");
const { existsSync } = require("node:fs");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { openStore, validateSession } = require("./store.cjs");
const { buildDuplicatedSession } = require("./session-duplicate.cjs");
const { openAppSettings, validBackground } = require("./app-settings.cjs");
const { openPasswordVault } = require("./password-vault.cjs");
const { createTheme } = require("./theme.mjs");
const { readImport, previewImport, applyImport, exportOpenSsh } = require("./session-exchange.cjs");
// Deliberately use software rendering as the initial performance baseline.
app.setName("JayXTerm");
app.disableHardwareAcceleration();
if (!app.isPackaged) {
  app.setPath(
    "userData",
    path.join(
      __dirname,
      process.env.JAYXTERM_QA
        ? "../.codex-cache/qa/profile"
        : "../.codex-cache/profile",
    ),
  );
  app.setPath(
    "sessionData",
    path.join(
      __dirname,
      process.env.JAYXTERM_QA
        ? "../.codex-cache/qa/chromium"
        : "../.codex-cache/chromium",
    ),
  );
}
let window, worker, store, workspace;
const owners = new Map(),
  states = new Map(),
  busyTransfers = new Set();
function parentFor(id) {
  return workspace.owner(id) || BrowserWindow.getFocusedWindow() || window;
}
function ensureOwner(sender, id) {
  workspace.assertOwner(sender, id);
  if (workspace.moves.has(id)) throw new Error("会话正在移动");
}
const hasInstanceLock =
  process.env.JAYXTERM_QA || app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
const defaultCache = app.getPath("sessionData");
const appSettings = hasInstanceLock && openAppSettings(
  path.join(app.getPath("userData"), "settings.json"),
  defaultCache,
  safeStorage,
);
// Electron reads its Windows safeStorage key from sessionData/Local State
// before ready. Keep that path fixed and route only the windows' session.
const windowCache = appSettings && appSettings.initializeCache({ restoreWindowsKey: process.platform === "win32" });
let passwordVault;
const active = new Map(),
  requests = new Map();
const pendingPasswords = new Map();
const tests = new Map();
const remoteDrags = new Map();
function decryptSessionPassword(encrypted) {
  if (!encrypted) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    throw new Error("无法读取已保存的密码。请编辑会话，重新输入并保存密码。");
  }
}
function storedPassword(id) {
  const s = store.get().sessions.find((s) => s.id === id);
  return decryptSessionPassword(s?.password);
}
function finishTest(id, error, result) {
  const t = tests.get(id);
  if (!t) return;
  clearTimeout(t.timer);
  tests.delete(id);
  pendingPasswords.delete(id);
  active.delete(id);
  owners.delete(id);
  states.delete(id);
  send({ type: "disconnect", id });
  error ? t.reject(new Error(error)) : t.resolve(result);
}
function send(m) {
  if (worker?.connected) worker.send(m);
}
function safeSessions() {
  return store
    .get()
    .sessions.map(({ password, ...s }) => ({ ...s, hasPassword: !!password }));
}
function request(message) {
  return new Promise((resolve, reject) => {
    const rid = randomUUID();
    const timer = ["upload", "download", "relay", "save-text", "remove"].includes(message.action)
      ? null
      : setTimeout(() => {
          requests.delete(rid);
          reject(new Error("文件操作超时"));
        }, 30000);
    requests.set(rid, { resolve, reject, timer });
    send({ ...message, type: message.type || "sftp", rid });
  });
}
app.whenReady().then(() => {
  if (!hasInstanceLock) return;
  store = openStore(path.join(app.getPath("userData"), "sessions.json"));
  worker = fork(path.join(__dirname, "ssh-worker.cjs"), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  workspace = createWindows({
    active,
    owners,
    states,
    send,
    request,
    background: () => appSettings.describe().backgroundColor,
    browserSession: windowCache === defaultCache ? undefined : session.fromPath(windowCache),
    isBusy: (id) => busyTransfers.has(id),
    onDisconnect: (id) => {
      active.delete(id);
      pendingPasswords.delete(id);
      states.delete(id);
      if (tests.has(id)) finishTest(id, "窗口已关闭");
    },
  });
  const nativeDrag = app.isPackaged
    ? path.join(process.resourcesPath, "jayxterm-drag.exe")
    : path.join(__dirname, "../.codex-cache/build/native/jayxterm-drag.exe");
  const dragHelper = !app.isPackaged && process.env.JAYXTERM_QA &&
      process.env.JAYXTERM_LOCAL_DRAG_QA === "1"
    ? {
        file: process.execPath,
        args: [path.join(__dirname, "../scripts/local-drag-helper-fixture.cjs")],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      }
    : process.platform === "win32" && existsSync(nativeDrag) ? { file: nativeDrag } : null;
  if (process.platform === "darwin" && !dragHelper) {
    const binding = app.isPackaged
      ? path.join(process.resourcesPath, "jayxterm-finder-drag.node")
      : path.join(__dirname, "../.codex-cache/build/native/jayxterm-finder-drag.node");
    let native, loadError;
    try { native = require(binding); }
    catch (error) { loadError = error; }
    require("./finder-drag.cjs").installFinderDrag({
      ipcMain, native, loadError, windowFor: (sender) => BrowserWindow.fromWebContents(sender),
      logFile: path.join(app.getPath("userData"), "finder-drag-last.json"),
      ensureOwner, ready: editorConnectionReady, request, busyTransfers, createRemoteDrag, remoteDrags,
    });
  } else {
    app.once("will-quit", installLocalDrag({
      ipcMain,
      helper: dragHelper,
      tempRoot: path.join(app.getPath("userData"), "drag-out"),
      ensureOwner,
      ready: editorConnectionReady,
      request,
      busyTransfers,
      remoteDrags,
    }));
  }
  Menu.setApplicationMenu(null);
  window = workspace.create();
  worker.on("message", async (m) => {
    if (
      tests.has(m.id) &&
      ["test-result", "error", "closed"].includes(m.type)
    ) {
      if (m.type === "test-result" && m.result?.ssh)
        recordPassword(pendingPasswords.get(m.id), workspace.owner(m.id));
      finishTest(
        m.id,
        m.type === "test-result" ? null : m.message || "测试连接已关闭",
        m.result,
      );
      return;
    }
    if (m.type === "result") {
      const r = requests.get(m.rid);
      if (r) {
        clearTimeout(r.timer);
        requests.delete(m.rid);
        m.error ? r.reject(new Error(m.error)) : r.resolve(m.result);
      }
      return;
    }
    if (m.type === "hostkey") {
      const config = active.get(m.id);
      if (!config) return send({ type: "verify", id: m.id, accept: false });
      const host = JSON.stringify([config.host, config.port]);
      const known = store.get().hosts[host];
      let accept = known === m.fingerprint;
      if (!accept) {
        const { response } = await dialog.showMessageBox(parentFor(m.id), {
          type: known ? "warning" : "question",
          buttons: ["取消连接", "信任并连接"],
          defaultId: 0,
          cancelId: 0,
          title: known ? "服务器指纹发生变化" : "首次连接此服务器",
          message: `${config.host}:${config.port}`,
          detail: `请通过可信渠道核对服务器指纹。\n\n${m.fingerprint}${known ? "\n\n原指纹：" + known : ""}`,
        });
        accept = response === 1;
        if (accept) {
          const d = store.get();
          store.write({ ...d, hosts: { ...d.hosts, [host]: m.fingerprint } });
        }
      }
      send({ type: "verify", id: m.id, accept });
      return;
    }
    const owner = workspace.owner(m.id);
    if (
      owners.has(m.id) &&
      (m.type === "ready" || m.type === "closed" || m.type === "error")
    ) {
      states.set(m.id, m.type);
      if (m.type === "ready") recordPassword(pendingPasswords.get(m.id), owner);
      pendingPasswords.delete(m.id);
    }
    if (m.type === "closed") active.delete(m.id);
    if (owner && !owner.isDestroyed()) owner.webContents.send("ssh:event", m);
  });
  worker.on("exit", () => {
    for (const id of active.keys())
      workspace.owner(id)?.webContents.send("ssh:event", {
        type: "error",
        id,
        message: "SSH 后台进程已退出，请重启应用",
      });
    active.clear();
    pendingPasswords.clear();
    for (const id of tests.keys()) finishTest(id, "SSH 后台进程已退出");
    for (const r of requests.values()) {
      clearTimeout(r.timer);
      r.reject(new Error("SSH 后台进程已退出"));
    }
    requests.clear();
  });
});
// Clipboard access is demand-driven; terminal output never touches it.
ipcMain.handle("clipboard:read", () => clipboard.readText());
ipcMain.handle("clipboard:write", (_e, text) => {
  if (typeof text !== "string") throw new Error("无效的剪贴板文本");
  clipboard.writeText(text);
});
ipcMain.handle("clipboard:menu", (e, { id, hasSelection, canPaste }) => {
  workspace.assertOwner(e.sender, id);
  const win = workspace.get(e.sender.id);
  const act = (action) => {
    if (win && !win.isDestroyed())
      win.webContents.send("window:event", { type: "clipboard", id, action });
  };
  Menu.buildFromTemplate([
    {
      label: "复制",
      enabled: !!hasSelection,
      click: () => act("copy"),
    },
    {
      label: "粘贴",
      enabled: !!canPaste,
      click: () => act("paste"),
    },
    { type: "separator" },
    { label: "全选终端文本", click: () => act("select-all") },
  ]).popup({ window: win });
});
ipcMain.handle("sessions:list", () => safeSessions());
const pendingImports = new WeakMap();
ipcMain.handle("sessions:import-preview", async (event, format) => {
  if (format !== "xshell" && format !== "ssh") throw new Error("未知的会话导入格式");
  pendingImports.delete(event.sender);
  const xshell = format === "xshell";
  const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: xshell ? "选择 Xshell 备份或会话文件" : "选择 OpenSSH 配置文件",
    properties: ["openFile"],
    filters: xshell ? [{ name: "Xshell 备份与会话", extensions: ["xts", "xsh"] }]
      : [{ name: "OpenSSH 配置", extensions: ["*"] }],
  });
  if (selected.canceled) return null;
  const file = selected.filePaths[0];
  const items = await readImport(file, format);
  if (!items.length) throw new Error("文件中没有可预览的 SSH 会话");
  if (event.sender.isDestroyed()) return null;
  const snapshot = store.get().sessions;
  const rows = previewImport(items, snapshot);
  const token = randomUUID();
  pendingImports.set(event.sender, { token, rows, snapshot });
  return { token, file: path.basename(file), rows };
});
ipcMain.handle("sessions:import-apply", (event, { token, choices } = {}) => {
  const preview = pendingImports.get(event.sender);
  const data = store.get();
  if (!preview || token !== preview.token || preview.snapshot !== data.sessions)
    throw new Error("会话列表已更新，请重新打开导入预览");
  const { sessions, added, updated, skipped } = applyImport(preview.rows, data.sessions, choices);
  if (added || updated) {
    store.write({ ...data, sessions });
    workspace.broadcast({ type: "sessions-changed" }, event.sender.id);
  }
  pendingImports.delete(event.sender);
  return { sessions: safeSessions(), added, updated, skipped };
});
ipcMain.handle("sessions:export-ssh", async (event) => {
  const { text, count, skipped } = exportOpenSsh(store.get().sessions);
  if (!count) throw new Error("没有可导出的 SSH 会话");
  const selected = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: "导出为 OpenSSH 配置",
    defaultPath: "jayxterm-ssh.config",
    filters: [{ name: "OpenSSH 配置", extensions: ["config"] }],
  });
  if (selected.canceled) return null;
  const staged = path.join(path.dirname(selected.filePath), `.jayxterm-export-${randomUUID()}.tmp`);
  const handle = await fs.open(staged, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
    await fs.rename(staged, selected.filePath);
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
  return { count, skipped };
});
ipcMain.handle("sessions:reveal", (_e, id) => storedPassword(id));
function recordPassword(secret, win) {
  if (!secret) return;
  try {
    appSettings.record(secret);
  } catch {
    if (win && !win.isDestroyed())
      win.webContents.send("window:event", { type: "notice", message: "无法写入密码历史" });
  }
}
ipcMain.handle("settings:get", () => appSettings.describe());
function themeWindow(win, color) {
  if (!win || win.isDestroyed()) return;
  const theme = createTheme(color);
  win.setBackgroundColor(theme.background);
  if (process.platform === "win32" && workspace?.get(win.webContents.id))
    win.setTitleBarOverlay({ color: theme.chrome, symbolColor: theme.ink });
}
ipcMain.on("window:theme", (event, color) => {
  if (validBackground(color)) themeWindow(BrowserWindow.fromWebContents(event.sender), color);
});
let activeColorPicker = null;
ipcMain.handle("settings:pick-color", async (event) => {
  if (activeColorPicker) throw new Error("屏幕取色器已打开");
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (!parent || parent.isDestroyed()) return null;
  const display = screen.getDisplayMatching(parent.getBounds());
  const scale = display.scaleFactor || 1;
  const pixelWidth = Math.max(1, Math.round(display.bounds.width * scale));
  const pixelHeight = Math.max(1, Math.round(display.bounds.height * scale));
  let captureTimer;
  const sources = await Promise.race([
    desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: pixelWidth, height: pixelHeight },
    }),
    new Promise((_, reject) => {
      captureTimer = setTimeout(() => reject(new Error("获取屏幕画面超时，请重试")), 5000);
    }),
  ]).finally(() => clearTimeout(captureTimer));
  const source =
    sources.find((item) => String(item.display_id) === String(display.id)) ||
    sources[0];
  if (!source || source.thumbnail.isEmpty())
    throw new Error("无法获取屏幕画面，请检查系统屏幕录制权限");

  const picker = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    show: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "color-picker-preload.cjs"),
      session: parent.webContents.session,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  activeColorPicker = picker;
  picker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  picker.webContents.on("will-navigate", (e) => e.preventDefault());

  return await new Promise((resolve) => {
    let settled = false;
    let initialized = false;
    const finish = (color) => {
      if (settled) return;
      settled = true;
      activeColorPicker = null;
      ipcMain.removeListener("color-picker:ready", onReady);
      ipcMain.removeListener("color-picker:result", onResult);
      parent.removeListener("closed", onParentClosed);
      if (!picker.isDestroyed()) picker.destroy();
      if (!parent.isDestroyed()) parent.focus();
      resolve(validBackground(color) ? color.toLowerCase() : null);
    };
    const sendScreen = () => {
      if (initialized || settled || picker.isDestroyed()) return;
      initialized = true;
      picker.setBounds(display.bounds);
      picker.setAlwaysOnTop(true, "screen-saver");
      picker.webContents.send("color-picker:init", {
        dataUrl: source.thumbnail.toDataURL(),
        width: pixelWidth,
        height: pixelHeight,
      });
      picker.show();
      picker.focus();
    };
    const onReady = (e) => {
      if (e.sender === picker.webContents) sendScreen();
    };
    const onResult = (e, color) => {
      if (e.sender === picker.webContents) finish(color);
    };
    const onParentClosed = () => finish(null);
    ipcMain.on("color-picker:ready", onReady);
    ipcMain.on("color-picker:result", onResult);
    parent.once("closed", onParentClosed);
    picker.once("closed", () => finish(null));
    picker.webContents.once("did-fail-load", () => finish(null));
    picker
      .loadFile(
        path.join(__dirname, "../.codex-cache/build/renderer/color-picker.html"),
      )
      .then(() => sendScreen())
      .catch(() => finish(null));
  });
});
ipcMain.handle("settings:choose-cache", async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: "选择缓存所在的文件夹",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : path.join(result.filePaths[0], "JayXTerm-cache");
});
let savingSettings = false;
ipcMain.handle("settings:apply", async (event, input) => {
  if (savingSettings) throw new Error("另一个窗口正在保存设置");
  if (typeof input?.cachePath !== "string" ||
    (input.cachePath && (!path.isAbsolute(input.cachePath) ||
      path.basename(input.cachePath) !== "JayXTerm-cache")) ||
    typeof input.saveHistory !== "boolean" ||
    !["single", "double"].includes(input.fileOpen) ||
    (input.backgroundColor !== undefined && !validBackground(input.backgroundColor)))
    throw new Error("无效的设置");
  savingSettings = true;
  try {
    const settings = appSettings.describe();
    const previous = settings.pendingCache ?? settings.cachePath;
    let migrate = false;
    if (input.cachePath !== previous && input.cachePath !== settings.cachePath) {
      const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
        message: "是否迁移缓存数据？",
        detail: "下次启动时切换到新目录。现有会话与密码仍保存在应用配置中。",
        type: "question",
        buttons: ["取消", "迁移后切换", "直接切换"],
        defaultId: 1,
        cancelId: 0,
      });
      if (response === 0) return null;
      migrate = response === 1;
    }
    const result = appSettings.apply({ ...input, migrate });
    if (!result.saveHistory) pendingPasswords.clear();
    if (!result.quickPasswordsEnabled) passwordVault = undefined;
    for (const win of BrowserWindow.getAllWindows()) {
      themeWindow(win, result.backgroundColor);
      if (win.webContents.id !== event.sender.id)
        win.webContents.send("window:event", { type: "settings-changed", settings: result });
    }
    return result;
  } finally {
    savingSettings = false;
  }
});
ipcMain.handle("password-history:list", () => appSettings.listHistory());
ipcMain.handle("password-history:select", (_e, id) => appSettings.selectPassword(id));
function requirePasswordVault(event) {
  if (!workspace?.get(event.sender.id) || event.senderFrame !== event.sender.mainFrame)
    throw new Error("请在工作台中管理快捷密码");
  if (!appSettings.describe().quickPasswordsEnabled)
    throw new Error("快捷密码本已关闭");
  return passwordVault ??= openPasswordVault(path.join(app.getPath("userData"), "quick-passwords.json"), safeStorage);
}
function broadcastPasswords() {
  workspace.broadcast({ type: "passwords-changed" });
}
ipcMain.handle("password-vault:list", event => {
  return requirePasswordVault(event).list();
});
ipcMain.handle("password-vault:save", (event, input) => {
  const result = requirePasswordVault(event).save(input);
  broadcastPasswords();
  return result;
});
ipcMain.handle("password-vault:reveal", (event, id) => {
  return requirePasswordVault(event).reveal(id);
});
ipcMain.handle("password-vault:remove", async (event, id) => {
  const item = requirePasswordVault(event).list().items.find(entry => entry.id === id);
  if (!item) throw new Error("这条快捷密码已不存在");
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
    type: "question", message: `删除快捷密码「${item.description}」？`,
    buttons: ["取消", "删除"], defaultId: 0, cancelId: 0,
  });
  if (response !== 1) return { removed: false };
  requirePasswordVault(event).remove(id);
  broadcastPasswords();
  return { removed: true };
});
ipcMain.handle("password-vault:fill", (event, { id, passwordId }) => {
  const vault = requirePasswordVault(event);
  ensureOwner(event.sender, id);
  if (!editorConnectionReady(id)) throw new Error("请先连接 SSH");
  // Enter/click explicitly selects and submits to its owning connection.
  // Keep the secret out of the renderer and clipboard.
  send({ type: "input", id, data: vault.reveal(passwordId) + "\r" });
  return true;
});
ipcMain.handle("ssh:test", (e, input) => {
  const config = validateSession({
    ...input,
    name: String(input.name || "").trim() || "测试连接",
  });
  const password = input.password || storedPassword(input.id);
  const id = randomUUID();
  active.set(id, config);
  owners.set(id, e.sender.id);
  if (input.password && appSettings.describe().saveHistory) pendingPasswords.set(id, input.password);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finishTest(id, "测试连接超时"), 120000);
    tests.set(id, { resolve, reject, timer });
    send({ type: "connect", id, config, password, test: true });
  });
});
ipcMain.handle("ssh:encoding", async (e, { id, encoding }) => {
  ensureOwner(e.sender, id);
  const s = active.get(id);
  if (!s) throw new Error("会话已断开");
  encoding = normalizeEncoding(encoding);
  const result = await request({ type: "encoding", id, encoding });
  const d = store.get();
  store.write({
    ...d,
    sessions: d.sessions.map((item) =>
      item.id === s.id ? { ...item, encoding } : item,
    ),
  });
  workspace.broadcast({ type: "sessions-changed" }, e.sender.id);
  return result;
});
ipcMain.handle("sessions:save", (e, input) => {
  const d = store.get();
  const old = d.sessions.find((x) => x.id === input.id);
  const s = validateSession({ ...input,
    encoding: input.encoding ?? old?.encoding ?? appSettings.describe().defaultEncoding });
  if (input.remember) {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new Error("系统安全存储不可用，无法保存密码");
    s.password = input.password
      ? safeStorage.encryptString(input.password).toString("base64")
      : old?.password;
  }
  store.write({
    ...d,
    sessions: [...d.sessions.filter((x) => x.id !== s.id), s],
  });
  recordPassword(input.password, BrowserWindow.fromWebContents(e.sender));
  workspace.broadcast({ type: "sessions-changed" }, e.sender.id);
  return safeSessions();
});
ipcMain.handle("sessions:duplicate", (e, id) => {
  const d = store.get();
  const index = d.sessions.findIndex((x) => x.id === id);
  if (index < 0) throw new Error("原会话不存在");
  const copy = buildDuplicatedSession(d.sessions[index], d.sessions, randomUUID());
  const next = [...d.sessions];
  next.splice(index + 1, 0, copy);
  store.write({ ...d, sessions: next });
  workspace.broadcast({ type: "sessions-changed" }, e.sender.id);
  return { sessions: safeSessions(), duplicatedId: copy.id };
});
ipcMain.handle("sessions:delete", (e, id) => {
  const d = store.get();
  store.write({ ...d, sessions: d.sessions.filter((s) => s.id !== id) });
  workspace.broadcast({ type: "sessions-changed" }, e.sender.id);
  return safeSessions();
});
ipcMain.handle("ssh:connect", (e, { sessionId, password, cols, rows }) => {
  const s = store.get().sessions.find((s) => s.id === sessionId);
  if (!s) throw new Error("会话不存在");
  const id = randomUUID();
  const secret = password || decryptSessionPassword(s.password);
  active.set(id, s);
  owners.set(id, e.sender.id);
  states.set(id, "connecting");
  if (password && appSettings.describe().saveHistory) pendingPasswords.set(id, password);
  send({
    type: "connect",
    id,
    config: {
      host: s.host,
      port: s.port,
      username: s.username,
      encoding: s.encoding || "utf-8",
    },
    password: secret,
    cols,
    rows,
  });
  return id;
});
ipcMain.on("ssh:send", (e, m) => {
  if (
    m.type === "disconnect" &&
    owners.get(m.id) === e.sender.id &&
    !workspace.moves.has(m.id)
  ) {
    send(m);
    owners.delete(m.id);
    active.delete(m.id);
    pendingPasswords.delete(m.id);
    states.delete(m.id);
    return;
  }
  if (
    active.has(m.id) &&
    owners.get(m.id) === e.sender.id &&
    (!workspace.moves.has(m.id) || ["ack", "resize"].includes(m.type)) &&
    ["input", "resize", "ack", "disconnect"].includes(m.type)
  )
    send(m);
});
ipcMain.handle("ssh:duplicate", (event, { id: source, directory, cols, rows }) => {
  ensureOwner(event.sender, source);
  if (!editorConnectionReady(source)) throw new Error("请先连接 SSH");
  if (typeof directory !== "string" || !directory.startsWith("/") ||
      /[\x00-\x1f\x7f]/.test(directory) || directory.length > 16384)
    throw new Error("无法获取有效的 SSH 当前目录");
  const id = randomUUID();
  active.set(id, { ...active.get(source) });
  owners.set(id, event.sender.id);
  states.set(id, "connecting");
  send({ type: "duplicate", id, source, directory, cols, rows });
  return id;
});
ipcMain.handle("sftp:list", (e, { id, path: remote }) => {
  ensureOwner(e.sender, id);
  return request({ id, action: "list", path: remote });
});
ipcMain.handle("sftp:stat-target", (e, { id, path: target, resolveHome }) => {
  ensureOwner(e.sender, id);
  if (typeof target !== "string" || !target || target.includes("\0") || target.length > 4096)
    throw new Error("无效的远端路径");
  return request({ id, action: "stat-target", path: target, resolveHome: !!resolveHome });
});
ipcMain.handle("sftp:remove", async (event, { id, path: remote }) => {
  ensureOwner(event.sender, id);
  validateRemoteRemoval(remote);
  if (!editorConnectionReady(id)) throw new Error("请先连接 SSH");
  if (busyTransfers.has(id)) throw new Error("请等待当前文件操作完成");
  busyTransfers.add(id);
  try {
    const preview = await request({ id, action: "remove-preview", path: remote });
    if (!editorConnectionReady(id)) throw new Error("SSH 已断开，未执行删除");
    const { response } = await dialog.showMessageBox(parentFor(id), {
      type: "warning", title: "删除远端文件",
      message: preview.directory ? `删除此远端目录及其中的 ${preview.count - 1} 项？` : "删除此远端文件？",
      detail: `${active.get(id).name}\n${remote}\n\n删除后无法撤销。`,
      buttons: ["取消", "删除"], defaultId: 0, cancelId: 0,
    });
    if (response !== 1) return { cancelled: true };
    ensureOwner(event.sender, id);
    if (!editorConnectionReady(id)) throw new Error("SSH 已断开，未执行删除");
    return await request({ id, action: "remove", path: remote, revision: preview.revision });
  } finally {
    busyTransfers.delete(id);
  }
});
ipcMain.handle("ssh:directory", (event, id) => {
  ensureOwner(event.sender, id);
  return editorConnectionReady(id) ? request({ id, type: "shell-directory" }) : null;
});
function editorConnectionReady(id) {
  return active.has(id) && states.get(id) === "ready" && !workspace.moves.has(id);
}
installEditorWindows({
  background: () => appSettings.describe().backgroundColor,
  request,
  connected: editorConnectionReady,
  ensureOwner(sender, id) {
    ensureOwner(sender, id);
    if (!editorConnectionReady(id)) throw new Error("请先连接 SSH");
    return active.get(id);
  },
  didSave(id, directory) {
    const win = workspace.owner(id);
    if (win && !win.isDestroyed())
      win.webContents.send("window:event", { type: "remote-text-saved", id, directory });
  },
});
async function confirmReplace(id, target, directory = false) {
  const answer = await dialog.showMessageBox(parentFor(id), {
    type: "warning",
    buttons: ["取消", directory ? "合并并覆盖同名文件" : "覆盖文件"],
    defaultId: 0,
    cancelId: 0,
    message: directory
      ? "目标目录已存在，是否合并？"
      : "目标文件已存在，是否覆盖？",
    detail:
      target +
      (directory ? "\n保留目标中其他文件，覆盖本次传输中遇到的同名文件。" : ""),
  });
  return answer.response === 1;
}
async function uploadPaths(id, remote, paths) {
  let files = 0,
    bytes = 0,
    skipped = 0;
  for (const local of paths) {
    const name = path.basename(local);
    if (!name || name === "." || name === "..")
      throw new Error("不能上传文件系统根目录");
    const destination = path.posix.join(remote, name);
    const stat = await request({ id, action: "stat", path: destination });
    if (
      stat.exists &&
      !(await confirmReplace(id, destination, stat.directory))
    ) {
      skipped++;
      continue;
    }
    const result = await request({
      id,
      action: "upload",
      local,
      path: destination,
    });
    files += result.files;
    bytes += result.bytes;
  }
  return { files, bytes, skipped };
}
// Only the window owning the source connection can create a drag token.
function createRemoteDrag(sender, id, remote) {
  if (
    owners.get(id) !== sender.id ||
    states.get(id) !== "ready" ||
    workspace.moves.has(id) ||
    typeof remote !== "string" ||
    !remote.startsWith("/") ||
    remote.includes("\0") ||
    remote === "/"
  ) return "";
  const now = Date.now();
  for (const [token, drag] of remoteDrags)
    if (drag.expires <= now) remoteDrags.delete(token);
  if (remoteDrags.size >= 128)
    remoteDrags.delete(remoteDrags.keys().next().value);
  const token = randomUUID();
  remoteDrags.set(token, {
    id,
    remote,
    owner: sender.id,
    expires: now + 120000,
  });
  return token;
}
ipcMain.on("sftp:drag-token", (e, { id, path: remote }) => {
  e.returnValue = createRemoteDrag(e.sender, id, remote);
});
ipcMain.handle("sftp:relay", async (e, { id, path: directory, token }) => {
  ensureOwner(e.sender, id);
  const drag = remoteDrags.get(token);
  if (!drag || drag.expires <= Date.now() || owners.get(drag.id) !== drag.owner)
    throw new Error("拖放已失效，请重新拖动文件");
  remoteDrags.delete(token);
  drag.claimed = true;
  if (drag.nativeDrop && (await drag.nativeDrop) !== "copy")
    throw new Error("拖放未完成，请重新拖动文件");
  // Ownership and readiness may have changed while the native drag finished.
  ensureOwner(e.sender, id);
  if (owners.get(drag.id) !== drag.owner)
    throw new Error("源连接已移动或关闭，请重新拖动文件");
  const source = active.get(drag.id),
    target = active.get(id);
  if (
    !source ||
    !target ||
    states.get(drag.id) !== "ready" ||
    states.get(id) !== "ready" ||
    workspace.moves.has(drag.id)
  )
    throw new Error("源或目标 SSH 连接已断开或正在移动");
  if (
    typeof directory !== "string" ||
    !directory.startsWith("/") ||
    directory.includes("\0")
  )
    throw new Error("请选择有效的目标目录");
  if (busyTransfers.has(id) || busyTransfers.has(drag.id))
    throw new Error("请等待当前传输完成");
  const endpoint = (session) => JSON.stringify([session.host, session.port]);
  const hosts = store.get().hosts;
  const sameServer =
    endpoint(source) === endpoint(target) ||
    Boolean(
      hosts[endpoint(source)] &&
      hosts[endpoint(source)] === hosts[endpoint(target)],
    );
  busyTransfers.add(id);
  busyTransfers.add(drag.id);
  try {
    return await request({
      id,
      action: "relay",
      source: drag.id,
      from: drag.remote,
      path: directory,
      sameServer,
    });
  } finally {
    busyTransfers.delete(id);
    busyTransfers.delete(drag.id);
  }
});
ipcMain.handle("sftp:drop", async (e, { id, path: remote, paths }) => {
  ensureOwner(e.sender, id);
  if (!active.has(id)) throw new Error("会话已断开");
  if (
    !Array.isArray(paths) ||
    paths.some((p) => typeof p !== "string" || !path.isAbsolute(p))
  )
    throw new Error("无效的本地文件");
  if (busyTransfers.has(id)) throw new Error("请等待当前传输完成");
  busyTransfers.add(id);
  try {
    return await uploadPaths(id, remote, paths);
  } finally {
    busyTransfers.delete(id);
  }
});
ipcMain.handle(
  "sftp:transfer",
  async (e, { id, action, path: remote, directory }) => {
    ensureOwner(e.sender, id);
    if (!active.has(id)) throw new Error("会话已断开");
    if (busyTransfers.has(id)) throw new Error("请等待当前传输完成");
    busyTransfers.add(id);
    try {
      if (action === "upload" || action === "upload-directory") {
        const r = await dialog.showOpenDialog(parentFor(id), {
          properties:
            action === "upload-directory"
              ? ["openDirectory", "multiSelections"]
              : ["openFile", "multiSelections"],
        });
        if (r.canceled) return { cancelled: true };
        return await uploadPaths(id, remote, r.filePaths);
      }
      if (action === "download") {
        let local;
        if (directory) {
          const r = await dialog.showOpenDialog(parentFor(id), {
            title: "选择下载到的本地目录",
            properties: ["openDirectory", "createDirectory"],
          });
          if (r.canceled) return { cancelled: true };
          local = path.join(
            r.filePaths[0],
            safeName(path.posix.basename(remote)),
          );
          let exists = false;
          try {
            await fs.lstat(local);
            exists = true;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (exists && !(await confirmReplace(id, local, true)))
            return { cancelled: true };
        } else {
          const r = await dialog.showSaveDialog(parentFor(id), {
            defaultPath: safeName(path.posix.basename(remote)),
          });
          if (r.canceled) return { cancelled: true };
          local = r.filePath;
        }
        return await request({ id, action, local, path: remote });
      }
      throw new Error("未知文件操作");
    } finally {
      busyTransfers.delete(id);
    }
  },
);
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => worker?.kill());
app.on("second-instance", () => {
  if (workspace) workspace.create();
});
