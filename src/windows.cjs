const { BrowserWindow, dialog, ipcMain, Menu, screen } = require("electron");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { createTheme } = require("./theme.mjs");
// Window metadata changes only on user actions, never on terminal output.
function createWindows({
  active,
  owners,
  states,
  send,
  request,
  onDisconnect,
  isBusy,
  background,
  browserSession,
}) {
  const windows = new Map(),
    moves = new Set(),
    replies = new Map();
  let number = 0;
  const get = (id) => windows.get(id);
  const owner = (id) => get(owners.get(id));
  const emit = (win, event) => {
    if (win && !win.isDestroyed()) win.webContents.send("window:event", event);
  };
  const assertOwner = (sender, id) => {
    if (owners.get(id) !== sender.id) throw new Error("此连接属于其他窗口");
  };
  function list() {
    return [...windows.values()]
      .filter((w) => !w.isDestroyed())
      .map((w) => ({
        id: w.webContents.id,
        title: w.getTitle(),
        count: [...active.keys()].filter(
          (id) => owners.get(id) === w.webContents.id,
        ).length,
      }));
  }
  function broadcast(event, except) {
    for (const w of windows.values())
      if (w.webContents.id !== except) emit(w, event);
  }
  function ask(win, action, payload) {
    return new Promise((resolve, reject) => {
      if (!win || win.isDestroyed()) return reject(new Error("窗口已关闭"));
      const token = randomUUID();
      const timer = setTimeout(() => {
        replies.delete(token);
        reject(new Error("窗口响应超时"));
      }, 20000);
      replies.set(token, { resolve, reject, timer, owner: win.webContents.id });
      emit(win, { type: "request", token, action, payload });
    });
  }
  ipcMain.on("window:reply", (e, { token, result, error }) => {
    const r = replies.get(token);
    if (!r || r.owner !== e.sender.id) return;
    clearTimeout(r.timer);
    replies.delete(token);
    error ? r.reject(new Error(error)) : r.resolve(result);
  });
  function cleanup(win, id) {
    for (const [token, r] of replies)
      if (r.owner === id) {
        clearTimeout(r.timer);
        replies.delete(token);
        r.reject(new Error("窗口已关闭"));
      }
    for (const [connection, wid] of owners)
      if (wid === id) {
        send({ type: "disconnect", id: connection });
        onDisconnect(connection);
        owners.delete(connection);
      }
    windows.delete(id);
  }
  function create() {
    const theme = createTheme(background());
    const offset = (number++ % 6) * 26;
    const focused = BrowserWindow.getFocusedWindow();
    const bounds = focused?.getBounds();
    const area = (
      bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()
    ).workArea;
    const width = Math.min(bounds?.width || 1380, area.width),
      height = Math.min(bounds?.height || 880, area.height);
    const x = Math.max(
      area.x,
      Math.min((bounds?.x || area.x) + offset, area.x + area.width - width),
    );
    const y = Math.max(
      area.y,
      Math.min((bounds?.y || area.y) + offset, area.y + area.height - height),
    );
    const win = new BrowserWindow({
      icon: path.join(__dirname, "../assets/jayxterm.png"),
      width,
      height,
      minWidth: Math.min(1000, area.width),
      minHeight: Math.min(650, area.height),
      x,
      y,
      backgroundColor: theme.background,
      title: `JayXTerm · 窗口 ${number}`,
      ...(process.platform === "win32" && {
        titleBarStyle: "hidden",
        titleBarOverlay: { color: theme.chrome, symbolColor: theme.ink, height: 54 },
      }),
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        ...(browserSession && { session: browserSession }),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.on("page-title-updated", (event) => event.preventDefault());
    win.windowNumber = number;
    const id = win.webContents.id;
    windows.set(id, win);
    win.frontendReady = new Promise((resolve, reject) => {
      win.resolveReady = resolve;
      win.rejectReady = reject;
    });
    win.frontendReady.catch(() => {});
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.on("render-process-gone", () => cleanup(win, id));
    win.on("closed", () => {
      win.rejectReady?.(new Error("窗口已关闭"));
      cleanup(win, id);
    });
    win.on("close", (e) => {
      if (win.allowClose) return;
      const ids = [...active.keys()].filter(
        (connection) => owners.get(connection) === id,
      );
      if (win.movingCount || ids.some((connection) => moves.has(connection))) {
        e.preventDefault();
        emit(win, {
          type: "notice",
          message: "会话正在移动，请稍后关闭窗口。",
        });
        return;
      }
      if (!ids.length) return;
      e.preventDefault();
      if (win.confirming) return;
      win.confirming = true;
      dialog
        .showMessageBox(win, {
          type: "question",
          message: `关闭窗口将断开本窗口的 ${ids.length} 个连接`,
          detail: "其他窗口的连接不会受影响。",
          buttons: ["取消", "关闭并断开"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          win.confirming = false;
          if (response === 1 && !win.isDestroyed()) {
            win.allowClose = true;
            win.close();
          }
        })
        .catch(() => {
          win.confirming = false;
        });
    });
    win.loadFile(
      path.join(__dirname, "../.codex-cache/build/renderer/index.html"),
    );
    return win;
  }
  const windowLabel = (win) => win.customWindowName || `窗口 ${win.windowNumber}`;
  ipcMain.handle("windows:ready", (e) => {
    const win = get(e.sender.id);
    win?.resolveReady();
    return { id: e.sender.id, number: win?.windowNumber, name: win?.customWindowName || "" };
  });
  ipcMain.handle("windows:new", () => create().webContents.id);
  ipcMain.handle("windows:list", () => list());
  ipcMain.handle("windows:focus", (_e, id) => {
    const win = get(id);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  ipcMain.on("windows:title", (e, name) => {
    const win = get(e.sender.id);
    if (!win) return;
    win.lastContentTitle = name || "工作空间";
    win.setTitle(`${win.lastContentTitle} · JayXTerm · ${windowLabel(win)}`);
  });
  ipcMain.handle("windows:rename", (e, name) => {
    const win = get(e.sender.id);
    if (!win || win.isDestroyed()) return "";
    const cleaned = typeof name === "string" ? name.trim().slice(0, 60) : "";
    win.customWindowName = cleaned;
    win.setTitle(`${win.lastContentTitle || "工作空间"} · JayXTerm · ${windowLabel(win)}`);
    return windowLabel(win);
  });
  async function move(sender, id, targetId) {
    assertOwner(sender, id);
    if (!active.has(id) || states.get(id) !== "ready")
      throw new Error("只能移动已连接的会话");
    if (moves.has(id) || isBusy(id))
      throw new Error("请等待文件传输或其他操作完成再移动");
    const source = get(sender.id);
    let target = targetId ? get(targetId) : null;
    let created = false,
      committed = false;
    if (targetId && !target) throw new Error("目标窗口已关闭");
    if (target === source) return;
    moves.add(id);
    source.movingCount = (source.movingCount || 0) + 1;
    try {
      // Wait for the destination UI before pausing the remote output.
      if (!target) {
        target = create();
        created = true;
      }
      target.movingCount = (target.movingCount || 0) + 1;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("目标窗口启动超时")),
          15000,
        );
        target.frontendReady.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      if (target.isMinimized()) target.restore();
      target.show();
      await request({ type: "freeze", id });
      const snapshot = await ask(source, "prepare", { id });
      if (
        typeof snapshot.screen !== "string" ||
        Buffer.byteLength(snapshot.screen, "utf8") > 4 * 1024 * 1024
      )
        throw new Error("终端历史过大，为避免卡顿，本次不移动");
      await ask(target, "restore", { ...snapshot, id });
      if (!active.has(id)) throw new Error("连接已断开，无法移动");
      owners.set(id, target.webContents.id);
      await ask(target, "commit", { id });
      committed = true;
      await ask(source, "release", { id }).catch(() => {});
      target.show();
      target.focus();
    } catch (error) {
      if (!committed) {
        if (source.isDestroyed()) {
          send({ type: "disconnect", id });
          owners.delete(id);
          onDisconnect(id);
        } else owners.set(id, sender.id);
        await ask(source, "rollback", { id }).catch(() => {});
        if (target && !target.isDestroyed())
          await ask(target, "discard", { id }).catch(() => {});
        if (created && !target?.isDestroyed()) {
          target.allowClose = true;
          target.close();
        }
      }
      throw error;
    } finally {
      send({ type: "thaw", id });
      moves.delete(id);
      if (committed) emit(target, { type: "settled", id });
      source.movingCount = Math.max(0, (source.movingCount || 1) - 1);
      if (target)
        target.movingCount = Math.max(0, (target.movingCount || 1) - 1);
    }
  }
  ipcMain.handle("windows:move", (e, { id, target }) =>
    move(e.sender, id, target),
  );
  ipcMain.handle("windows:tab-menu", (e, id) => {
    assertOwner(e.sender, id);
    const win = get(e.sender.id);
    const items = [
      {
        label: "重命名",
        enabled: !moves.has(id),
        click: () => emit(win, { type: "rename-tab", id }),
      },
      {
        label: "复制会话及路径",
        enabled: states.get(id) === "ready" && !moves.has(id),
        click: () => emit(win, { type: "duplicate-tab", id }),
      },
      { type: "separator" },
      {
        label: "移到新窗口",
        enabled: states.get(id) === "ready" && !moves.has(id),
        click: () =>
          move(e.sender, id).catch((error) =>
            emit(win, { type: "notice", message: error.message }),
          ),
      },
    ];
    const targets = list().filter((w) => w.id !== e.sender.id);
    if (targets.length)
      items.push({
        label: "移到已有窗口",
        submenu: targets.map((w) => ({
          label: w.title,
          click: () =>
            move(e.sender, id, w.id).catch((error) =>
              emit(win, { type: "notice", message: error.message }),
            ),
        })),
      });
    items.push(
      { type: "separator" },
      { label: "新建工作窗口", click: () => create() },
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  return { create, get, owner, assertOwner, broadcast, moves, windows, list };
}
module.exports = { createWindows };
