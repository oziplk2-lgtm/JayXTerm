import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { applyTheme } from "./theme.mjs";
import { installSettingsPanel } from "./settings-panel.js";
import { terminalDefaults, terminalFont } from "./terminal-settings.mjs";
import { prepareTerminalFont } from "./terminal-fonts.js";
import { installKeywordHighlights } from "./terminal-keywords.mjs";
import { installTerminalSearch } from "./terminal-search.js";
import { fileIcon, trashIcon } from "./file-icons.js";
import { installQuickPasswords } from "./quick-passwords.js";
import { installTerminalEcho } from "./terminal-echo.mjs";
import { resolveTerminalClipboardShortcut } from "./terminal-clipboard.mjs";
import {
  collectLogicalTerminalLine,
  extractTerminalPathMatches,
  resolveRemoteClickPath,
} from "./terminal-file-links.mjs";
import "./style.css";
const $ = (s) => document.querySelector(s);
const api = window.api;
const isMacPlatform = /\bMac/i.test(navigator.platform || navigator.userAgent);
let linkModifierHeld = false;
let hoveredTerminalLink = null;
const isLinkModifier = (event) =>
  !!event && (isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey;
function syncHoveredLinkDecoration(held) {
  linkModifierHeld = held;
  if (!hoveredTerminalLink) return;
  hoveredTerminalLink.decorations.underline = held;
  hoveredTerminalLink.decorations.pointerCursor = held;
}
window.addEventListener("keydown", (event) => syncHoveredLinkDecoration(isLinkModifier(event)), true);
window.addEventListener("keyup", (event) => syncHoveredLinkDecoration(isLinkModifier(event)), true);
window.addEventListener("blur", () => syncHoveredLinkDecoration(false));
let sessions = [],
  current = null,
  pendingDelete = null,
  selectedSessionId = null,
  copiedSessionId = null,
  duplicatingSession = false,
  passwordResolve;
let editorVersion = 0;
const tabs = new Map();
const groups = [];
let groupMenuId = 0;
const terminalDragType = "application/x-jayxterm-terminal";
const remoteDragType = "application/x-jayxterm-sftp";
let focusedGroup;
let fileWorkspaceOpen = false;
let fileWorkspaceVersion = 0;
let fileOpen = "single";
let localDragAvailable = false;
let localDragWarmed = false;
let theme = applyTheme("#181818");
let fontPreferences = { ...terminalDefaults };
let fontOptions = terminalFont(fontPreferences);
let defaultEncoding = terminalDefaults.defaultEncoding;
let highlightKeywords = false;
let quickPasswordsEnabled = false;
let predictiveEcho = true;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").style.display = "none"), 6000);
}
function renderBackground(color) {
  theme = applyTheme(color);
  for (const tab of tabs.values()) {
    tab.term.options.theme = theme.terminal;
    tab.highlights?.setTheme(theme);
  }
  terminalSearch.refreshTheme();
  api.windowTheme(color);
}
function renderTerminalFont(settings) {
  fontPreferences = { fontFamily: settings.fontFamily, cjkFontFamily: settings.cjkFontFamily, fontSize: settings.fontSize };
  const applied = fontPreferences;
  const ready = prepareTerminalFont(fontPreferences);
  const options = terminalFont(fontPreferences);
  // Measure only after the local CJK face is ready. Otherwise xterm caches
  // fallback glyph widths and mixed-script lines can retain incorrect spacing.
  ready.then(() => {
    if (fontPreferences !== applied) return;
    fontOptions = options;
    for (const tab of tabs.values()) {
      tab.term.options.fontFamily = options.fontFamily;
      tab.term.options.fontSize = options.fontSize;
    }
    requestAnimationFrame(() => {
      if (fontPreferences === applied) for (const tab of tabs.values()) fitTerminal(tab);
    });
  });
}
const settingsPanel = installSettingsPanel({ api, previewColor: renderBackground,
  previewFont: renderTerminalFont, previewKeywords: renderKeywordHighlights, onSave: updateSettings, toast });
function renderKeywordHighlights(enabled) {
  if (enabled === highlightKeywords) return;
  highlightKeywords = enabled;
  for (const tab of tabs.values()) {
    tab.highlights?.dispose();
    tab.highlights = enabled ? installKeywordHighlights(tab.term, theme) : null;
  }
}
function showTerminal() {
  if (fileWorkspaceOpen) toggleFileWorkspace(false);
}
const terminalSearch = installTerminalSearch({ getActiveTab: () => tabs.get(current), showTerminal, getTheme: () => theme });
const quickPasswords = installQuickPasswords({ api, getActiveTab: () => tabs.get(current), showTerminal, toast });
function updateSettings(settings) {
  settingsPanel.setSaved(settings);
  renderBackground(settings.backgroundColor);
  renderTerminalFont(settings);
  renderKeywordHighlights(settings.highlightKeywords);
  terminalSearch.setEnabled(settings.terminalSearchEnabled);
  if (quickPasswordsEnabled !== settings.quickPasswordsEnabled) {
    quickPasswordsEnabled = settings.quickPasswordsEnabled;
    quickPasswords.setEnabled(quickPasswordsEnabled);
    for (const tab of tabs.values()) {
      tab.passwordPrompt?.dispose();
      tab.passwordPrompt = quickPasswordsEnabled ? quickPasswords.watch(tab) : null;
    }
    if (quickPasswordsEnabled) quickPasswords.activate();
  }
  predictiveEcho = settings.predictiveEcho;
  for (const tab of tabs.values()) tab.echo.setEnabled(predictiveEcho);
  defaultEncoding = settings.defaultEncoding;
  if (fileOpen === settings.fileOpen) return;
  fileOpen = settings.fileOpen;
  const tab = tabs.get(current);
  if (tab) renderSidebarFiles(tab);
  for (const group of groups) {
    if (!group.filePanel) continue;
    group.filePanel.rendered = null;
    if (fileWorkspaceOpen) renderWorkspaceFiles(group);
  }
}
function passwordVisibility(field, button, visible) {
  field.type = visible ? "text" : "password";
  button.textContent = visible ? "隐藏" : "显示";
  button.setAttribute("aria-pressed", String(visible));
}
function passwordHistory(dialog, select, field, toggle) {
  let generation = 0;
  dialog.addEventListener("close", () => {
    generation++;
    select.replaceChildren(new Option("无密码记录", ""));
    select.disabled = true;
  });
  select.onchange = async () => {
    const id = select.value;
    if (!id) return;
    const version = generation;
    try {
      const value = await api.historyPassword(id);
      if (generation !== version || !dialog.open || select.value !== id) return;
      if (value) {
        field.value = value;
        passwordVisibility(field, toggle, false);
        field.focus();
      } else toast("这条历史密码已不可用");
    } catch (error) {
      toast(error.message);
    } finally {
      if (generation === version && select.value === id) select.value = "";
    }
  };
  return async () => {
    const version = ++generation;
    select.disabled = true;
    select.replaceChildren(new Option("读取历史密码…", ""));
    try {
      const { enabled, items } = await api.passwordHistory();
      if (generation !== version || !dialog.open) return;
      const label = items.length ? "选择历史密码" : enabled ? "无密码记录" : "无密码记录（未开启）";
      select.replaceChildren(new Option(label, ""), ...items.map((item) => new Option(item.label, item.id)));
      select.disabled = !items.length;
    } catch {
      if (generation === version && dialog.open)
        select.replaceChildren(new Option("无法读取历史密码", ""));
    }
  };
}
const loadSessionHistory = passwordHistory(
  $("#editor"), $("#session-password-history"), $("#session-form").elements.password, $("#toggle-password"),
);
const loadConnectHistory = passwordHistory(
  $("#password-dialog"), $("#connect-password-history"), $("#connect-password"), $("#toggle-connect-password"),
);
async function openTerminalClickedPath(tab, rawPath) {
  if (!tab || !tabs.has(tab.id) || tab.moving || tab.state !== "已连接") {
    toast("请先连接 SSH");
    return;
  }
  try {
    let target = rawPath;
    let resolveHome = false;
    if (rawPath.startsWith("/")) {
      target = resolveRemoteClickPath(rawPath);
    } else if (rawPath === "~" || rawPath.startsWith("~/")) {
      target = rawPath;
      resolveHome = true;
    } else {
      const baseDirectory =
        tab.shellDirectory ||
        (await api.shellDirectory(tab.id).catch(() => null)) ||
        (tab.path?.startsWith("/") ? tab.path : null);
      if (baseDirectory) {
        target = resolveRemoteClickPath(rawPath, { baseDirectory });
      } else {
        target = rawPath;
        resolveHome = true;
      }
    }
    const stat = await api.statRemoteTarget({ id: tab.id, path: target, resolveHome });
    if (!stat?.exists) {
      toast("未找到远端文件：" + (stat?.path || target));
      return;
    }
    if (stat.directory) {
      await loadFiles(tab, stat.path);
      toast("已定位到目录：" + stat.path);
      return;
    }
    await api.openRemoteEditor({ id: tab.id, path: stat.path });
  } catch (error) {
    toast("打开文件失败：" + error.message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
  }
}
function installTerminalFileLinks(term, tab) {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      const rowIndex = bufferLineNumber - 1;
      const collected = collectLogicalTerminalLine(buffer, term.cols, rowIndex);
      if (!collected || !collected.cells.length) return callback(undefined);
      const { text, cells } = collected;
      const links = [];
      let cursor = 0;
      for (const match of extractTerminalPathMatches(text)) {
        while (cursor < cells.length && cells[cursor].end <= match.start) cursor++;
        const first = cells[cursor];
        if (!first || first.start >= match.end) continue;
        let last = first;
        for (let i = cursor; i < cells.length && cells[i].start < match.end; i++) {
          last = cells[i];
        }
        if (bufferLineNumber < first.y1 || bufferLineNumber > last.y1) continue;
        const link = {
          range: {
            start: { x: first.x1, y: first.y1 },
            end: { x: last.x1 + last.width - 1, y: last.y1 },
          },
          text: match.path,
          decorations: {
            underline: linkModifierHeld,
            pointerCursor: linkModifierHeld,
          },
          hover(event) {
            hoveredTerminalLink = link;
            const held = isLinkModifier(event) || linkModifierHeld;
            link.decorations.underline = held;
            link.decorations.pointerCursor = held;
          },
          leave() {
            if (hoveredTerminalLink === link) hoveredTerminalLink = null;
            link.decorations.underline = false;
            link.decorations.pointerCursor = false;
          },
          activate(event, pathText) {
            if (!isLinkModifier(event)) return;
            openTerminalClickedPath(tab, pathText);
          },
        };
        links.push(link);
      }
      callback(links.length ? links : undefined);
    },
  });
}
async function openRemoteEditor(t, file) {
  if (t.state !== "已连接" || t.moving) {
    toast("请先连接 SSH");
    return;
  }
  try {
    await api.openRemoteEditor({ id: t.id, path: remoteJoin(t.path, file.name) });
  } catch (error) {
    toast("打开文件失败：" + error.message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
  }
}
function setMode(mode) {
  const files = mode === "files";
  $("#session-panel").classList.toggle("hidden", files);
  $("#files-panel").classList.toggle("hidden", !files);
  $("#mode-sessions").classList.toggle("active", !files);
  $("#mode-files").classList.toggle("active", files);
  const t = tabs.get(current);
  if (files && !t)
    $("#file-list").replaceChildren(
      el("div", "empty", "请先在会话中连接一台服务器。"),
    );
}
$("#mode-sessions").onclick = () => setMode("sessions");
$("#mode-files").onclick = () => setMode("files");
function selectSessionRow(id, { focus = false } = {}) {
  selectedSessionId = id;
  for (const row of $("#sessions").querySelectorAll(".session")) {
    const active = row.dataset.sessionId === id;
    row.classList.toggle("selected", active);
    row.setAttribute("aria-selected", String(active));
    if (active && focus) row.focus();
  }
}
function copySelectedSession() {
  const target = sessions.find((s) => s.id === selectedSessionId);
  if (!target) return false;
  copiedSessionId = target.id;
  toast(`已复制会话「${target.name}」，在会话列表按 ${isMacPlatform ? "Cmd" : "Ctrl"}+V 粘贴新建`);
  return true;
}
async function pasteCopiedSession() {
  if (duplicatingSession || !copiedSessionId) return;
  duplicatingSession = true;
  try {
    const result = await api.duplicateSession(copiedSessionId);
    sessions = result.sessions;
    selectedSessionId = result.duplicatedId;
    renderSessions();
    const row = [...$("#sessions").querySelectorAll(".session")]
      .find((item) => item.dataset.sessionId === result.duplicatedId);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus();
    const created = sessions.find((s) => s.id === result.duplicatedId);
    if (created) toast(`已粘贴会话「${created.name}」`);
  } catch (error) {
    toast(error.message);
  } finally {
    duplicatingSession = false;
  }
}
function renderSessions() {
  $("#welcome-new").textContent = sessions.length
    ? "＋ 新建会话"
    : "＋ 添加第一台服务器";
  if (selectedSessionId && !sessions.some((s) => s.id === selectedSessionId))
    selectedSessionId = null;
  const list = $("#sessions");
  list.tabIndex = -1;
  list.replaceChildren();
  const q = $("#search").value.toLowerCase();
  const filtered = sessions.filter((s) =>
    [s.name, s.host, s.username, s.group].join(" ").toLowerCase().includes(q),
  );
  if (!filtered.length)
    list.append(
      el(
        "div",
        "empty",
        sessions.length
          ? "没有匹配的会话"
          : "还没有会话。\n添加一台服务器开始工作。",
      ),
    );
  const groups = [...new Set(filtered.map((s) => s.group || "未分组"))].sort();
  for (const group of groups) {
    list.append(el("div", "group-heading", group));
    for (const s of filtered.filter((s) => (s.group || "未分组") === group)) {
      const row = el("div", "session");
      row.dataset.sessionId = s.id;
      row.tabIndex = 0;
      row.setAttribute("role", "option");
      const active = s.id === selectedSessionId;
      row.classList.toggle("selected", active);
      row.setAttribute("aria-selected", String(active));
      row.title = `双击连接 · ${isMacPlatform ? "Cmd" : "Ctrl"}+C 复制，${isMacPlatform ? "Cmd" : "Ctrl"}+V 粘贴`;
      row.append(el("span", "server-icon", "▤"));
      const info = el("div", "session-info");
      info.append(
        el("strong", "", s.name),
        el("small", "", `${s.username}@${s.host}:${s.port}`),
      );
      row.append(info);
      const tools = el("div", "session-tools");
      for (const [label, title, handler] of [
        ["↗", "连接", () => connect(s)],
        ["✎", "编辑", () => edit(s)],
        [
          "×",
          "删除",
          () => {
            pendingDelete = s.id;
            $("#confirm-dialog").showModal();
          },
        ],
      ]) {
        const b = el("button", "", label);
        b.title = title;
        b.onclick = (e) => {
          e.stopPropagation();
          handler();
        };
        tools.append(b);
      }
      row.append(tools);
      row.onclick = () => selectSessionRow(s.id, { focus: true });
      row.onfocus = () => {
        if (selectedSessionId !== s.id) selectSessionRow(s.id, { focus: false });
      };
      row.ondblclick = () => connect(s);
      row.onkeydown = (e) => {
        if (e.key === "Enter") connect(s);
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const rows = [...list.querySelectorAll(".session")];
          const index = rows.indexOf(row);
          if (index < 0 || !rows.length) return;
          const next = rows[(index + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length];
          selectSessionRow(next.dataset.sessionId, { focus: true });
        }
      };
      list.append(row);
    }
  }
}
$("#session-panel").addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229 || document.querySelector("dialog[open]")) return;
  if (e.target.closest("input, textarea, select")) return;
  if (window.getSelection()?.toString()) return;
  const primary = isMacPlatform ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.altKey || e.shiftKey) return;
  const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
  if (e.code === "KeyC" || key === "c") {
    if (copySelectedSession()) e.preventDefault();
  } else if (e.code === "KeyV" || key === "v") {
    if (copiedSessionId) {
      e.preventDefault();
      if (!e.repeat) pasteCopiedSession();
    }
  }
});
function edit(s = {}) {
  const form = $("#session-form");
  form.reset();
  editorVersion++;
  passwordVisibility(form.elements.password, $("#toggle-password"), false);
  form.elements.encoding.value = s.encoding || (s.id ? "utf-8" : defaultEncoding);
  $("#test-status").textContent = "";
  $("#test-connection").disabled = false;
  for (const field of ["id", "name", "host", "port", "username", "group"])
    form.elements[field].value =
      s[field] ?? (field === "port" ? 22 : field === "username" ? "root" : "");
  form.elements.remember.checked = s.id ? s.hasPassword : true;
  form.elements.password.placeholder = s.hasPassword
    ? "已保存 · 留空保留密码"
    : "输入连接密码";
  $("#editor-title").textContent = s.id ? "编辑会话" : "新建会话";
  $("#form-error").textContent = "";
  $("#editor").showModal();
  loadSessionHistory();
}
$("#toggle-password").onclick = async () => {
  const form = $("#session-form"),
    field = form.elements.password,
    button = $("#toggle-password");
  if (field.type === "text") {
    passwordVisibility(field, button, false);
    return;
  }
  const version = editorVersion;
  try {
    if (!field.value && form.elements.id.value) {
      const password = await api.reveal(form.elements.id.value);
      if (version !== editorVersion || !$("#editor").open) return;
      if (!field.value) field.value = password;
    }
    passwordVisibility(field, button, true);
  } catch (e) {
    $("#form-error").textContent = e.message;
  }
};
$("#editor").addEventListener("close", () => {
  editorVersion++;
  $("#session-form").elements.password.value = "";
  $("#session-form").elements.password.type = "password";
});
$("#test-connection").onclick = async () => {
  const form = $("#session-form");
  for (const field of ["host", "port", "username"])
    if (!form.elements[field].reportValidity()) return;
  const version = editorVersion;
  $("#test-connection").disabled = true;
  $("#test-status").textContent = "正在测试 SSH 认证和 SFTP…";
  $("#test-status").className = "";
  try {
    const result = await api.test(Object.fromEntries(new FormData(form)));
    if (version !== editorVersion) return;
    $("#test-status").textContent = result.message;
    $("#test-status").className = result.sftp ? "success" : "warning";
  } catch (e) {
    if (version === editorVersion) {
      $("#test-status").textContent = "连接失败：" + e.message;
      $("#test-status").className = "error";
    }
  } finally {
    if (version === editorVersion) $("#test-connection").disabled = false;
  }
};
$("#encoding-help").onclick = () => {
  $("#help-options").hidePopover();
  $("#encoding-dialog").showModal();
};
$("#cwd-help").onclick = () => {
  $("#help-options").hidePopover();
  showCwdDialog(tabs.get(current));
};
for (const [menuId, buttonId, opensUp] of [
  ["#upload-options", "#upload", false],
  ["#help-options", "#help-menu", true],
]) {
  const menu = $(menuId);
  menu.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") return;
    const bounds = $(buttonId).getBoundingClientRect();
    menu.style.left = opensUp ? "auto" : `${bounds.left}px`;
    menu.style.right = opensUp ? `${innerWidth - bounds.right}px` : "auto";
    menu.style.top = opensUp ? "auto" : `${bounds.bottom + 5}px`;
    menu.style.bottom = opensUp ? `${innerHeight - bounds.top + 5}px` : "auto";
  });
}
$("#window-tools-options").addEventListener("beforetoggle", (event) => {
  if (event.newState !== "open") return;
  const bounds = $("#window-tools-menu").getBoundingClientRect();
  event.currentTarget.style.left = bounds.left + "px";
  event.currentTarget.style.top = bounds.bottom + 6 + "px";
});
$("#encoding-close").onclick = () => $("#encoding-dialog").close();
$("#terminal-encoding").onchange = async () => {
  const t = tabs.get(current);
  if (!t) return;
  const selector = $("#terminal-encoding");
  const encoding = selector.value;
  selector.disabled = true;
  try {
    await api.encoding({ id: t.id, encoding });
    t.encoding = encoding;
    sessions = await api.sessions();
    renderSessions();
    toast(
      "终端编码已切换为 " +
        encoding.toUpperCase() +
        "；仅影响后续输出，可按 Ctrl+L 重绘。",
    );
  } catch (e) {
    toast(e.message);
  } finally {
    const active = tabs.get(current);
    selector.value = active?.encoding || "utf-8";
    selector.disabled = !active;
  }
};
$("#new").onclick = $("#welcome-new").onclick = () => edit();
$("#editor-cancel").onclick = () => $("#editor").close();
$("#search").oninput = renderSessions;
// Use explicit checkbox state; unchecked fields are absent from FormData.
$("#session-form").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const s = Object.fromEntries(new FormData(form));
    s.remember = form.elements.remember.checked;
    sessions = await api.save(s);
    $("#editor").close();
    renderSessions();
  } catch (err) {
    $("#form-error").textContent = err.message;
  }
};
$("#delete-cancel").onclick = () => $("#confirm-dialog").close();
$("#delete-confirm").onclick = async () => {
  try {
    sessions = await api.remove(pendingDelete);
    renderSessions();
    $("#confirm-dialog").close();
  } catch (e) {
    toast(e.message);
  }
};
$("#password-form").onsubmit = (e) => {
  e.preventDefault();
  const p = $("#connect-password").value;
  $("#password-dialog").close();
  passwordResolve?.(p);
  passwordResolve = null;
  $("#connect-password").value = "";
};
$("#password-dialog").addEventListener("cancel", () => {
  passwordResolve?.(null);
  passwordResolve = null;
});
$("#password-dialog").addEventListener("close", () => {
  $("#connect-password").value = "";
  passwordVisibility($("#connect-password"), $("#toggle-connect-password"), false);
});
$("#toggle-connect-password").onclick = () => {
  const field = $("#connect-password");
  passwordVisibility(field, $("#toggle-connect-password"), field.type === "password");
};
$("#password-cancel").onclick = () => {
  $("#password-dialog").close();
  passwordResolve?.(null);
  passwordResolve = null;
};
async function connect(session) {
  let password;
  if (!session.hasPassword) {
    $("#password-host").textContent = `${session.username}@${session.host}`;
    $("#connect-password").value = "";
    $("#password-dialog").showModal();
    loadConnectHistory();
    password = await new Promise((r) => (passwordResolve = r));
    if (password === null) return;
  }
  try {
    const id = await api.connect({
      sessionId: session.id,
      password,
      cols: 100,
      rows: 30,
    });
    createTerminal(session, id);
  } catch (e) {
    toast(e.message);
  }
}
async function duplicateTab(tab) {
  if (!tab || tab.moving || tab.duplicating || tab.state !== "已连接") return;
  tab.duplicating = true;
  try {
    const directory = await api.shellDirectory(tab.id).catch(() => null) || tab.shellDirectory;
    if (!directory) {
      toast("未能读取 SSH 当前目录，请先使用“同步 SSH 当前目录”，再复制会话");
      showCwdDialog(tab);
      return;
    }
    if (!tabs.has(tab.id) || tab.moving || tab.state !== "已连接") return;
    const id = await api.duplicate({ id: tab.id, directory, cols: tab.term.cols, rows: tab.term.rows });
    focusedGroup = tab.group;
    createTerminal({ ...tab.session, encoding: tab.encoding }, id);
  } catch (error) {
    toast(error.message);
  } finally {
    tab.duplicating = false;
  }
}
async function terminalClipboard(t, action, { clearOnCopy = false } = {}) {
  if (!t || !tabs.has(t.id) || t.moving) return;
  try {
    if (action === "copy") {
      const text = t.term.getSelection();
      if (text) {
        if (clearOnCopy) t.term.clearSelection();
        await api.writeClipboard(text);
      }
    } else if (action === "paste") {
      if (t.state !== "已连接") return;
      const text = await api.readClipboard();
      if (!tabs.has(t.id) || t.moving || t.term.options.disableStdin) return;
      // xterm's paste API honors bracketed-paste mode and normalizes line breaks.
      // It uses the same onData path as typing, including GBK input conversion.
      if (text) {
        t.term.clearSelection();
        t.term.paste(text);
      }
    } else if (action === "select-all") t.term.selectAll();
    t.term.focus();
  } catch (error) {
    toast(error.message);
  }
}
function createTerminal(session, id, { moving = false } = {}) {
  const pane = el("div", "terminal-pane");
  const viewport = el("div", "terminal-viewport");
  pane.append(viewport);
  const group = focusedGroup || addGroup();
  group.body.append(pane);
  const term = new Terminal({
    ...fontOptions,
    lineHeight: 1.15,
    scrollback: 3000,
    cursorBlink: false,
    theme: theme.terminal,
    // xterm's search and keyword decorations use its buffer/marker API.
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(viewport);
  const tab = {
    moving,
    group,
    id,
    session,
    term,
    fit,
    pane,
    state: "连接中",
    encoding: session.encoding || "utf-8",
    path: ".",
    files: [],
    loadVersion: 0,
  };
  if (highlightKeywords) tab.highlights = installKeywordHighlights(term, theme);
  if (quickPasswordsEnabled) tab.passwordPrompt = quickPasswords.watch(tab);
  tab.echo = installTerminalEcho(tab, predictiveEcho);
  tab.fileLinks = installTerminalFileLinks(term, tab);
  term.parser.registerOscHandler(7, (value) => {
    const match = /^file:\/\/([^/]*)(\/[^\x00-\x1f]*)$/.exec(value);
    if (!match) return true;
    const [, host, path] = match;
    try {
      const decoded = decodeURIComponent(path);
      if (decoded.includes("\0")) return true;
      if (host.startsWith("jayxterm-query-")) {
        if (tab.cwdQuery?.host === host) {
          clearCwdQuery(tab);
          tab.shellDirectory = decoded;
          loadFiles(tab, decoded);
        }
      } else {
        tab.shellDirectory = decoded;
      }
    } catch {
      // A malformed URI should not replace the last known directory.
    }
    return true;
  });
  tabs.set(id, tab);
  pane.addEventListener("focusin", () => {
    if (current !== id && !fileWorkspaceOpen && tab.group.shown === id)
      activate(id, false);
  });
  // Route terminal clipboard shortcuts via Electron IPC and block browser-native
  // copy/paste events on the hidden textarea to avoid duplicate paste into xterm.
  const blockBrowserClipboard = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  pane.addEventListener("copy", blockBrowserClipboard, true);
  pane.addEventListener("paste", blockBrowserClipboard, true);
  term.attachCustomKeyEventHandler((event) => {
    const action = resolveTerminalClipboardShortcut(event, {
      hasSelection: term.hasSelection(),
      isMac: isMacPlatform,
    });
    if (!action) return true;
    event.preventDefault();
    if (action !== "noop" && !event.repeat) {
      terminalClipboard(tab, action, { clearOnCopy: action === "copy" });
    }
    return false;
  });
  pane.oncontextmenu = (event) => {
    event.preventDefault();
    api
      .clipboardMenu({
        id,
        hasSelection: term.hasSelection(),
        canPaste: tab.state === "已连接" && !tab.moving,
      })
      .catch((error) => toast(error.message));
  };
  term.onData((data) => {
    if (quickPasswordsEnabled) quickPasswords.userInput(tab);
    tab.echo.input(data);
    if (!tab.moving) api.send({ type: "input", id, data });
  });
  term.onResize(
    ({ cols, rows }) =>
      !tab.moving && api.send({ type: "resize", id, cols, rows }),
  );
  if (!moving) {
    activate(id);
    setMode("files");
    term.writeln("\x1b[32m正在连接 " + session.host + "…\x1b[0m");
  }
  return tab;
}
function addGroup() {
  if (groups.length >= 4) return null;
  const root = el("section", "terminal-group");
  const heading = el("header", "terminal-group-heading");
  const nav = el("nav", "tabs");
  const menuButton = el("button", "group-menu-button", "⋯");
  const menu = el("div", "action-popover group-menu");
  menu.id = "split-menu-" + ++groupMenuId;
  menu.setAttribute("popover", "");
  menu.setAttribute("aria-label", "分屏操作");
  menuButton.type = "button";
  menuButton.title = "分屏操作";
  menuButton.setAttribute("aria-label", "分屏操作");
  menuButton.setAttribute("popovertarget", menu.id);
  heading.append(nav, menuButton, menu);
  const body = el("div", "terminal-group-body");
  const empty = el("button", "group-empty", "拖入终端标签，或点击后连接会话");
  body.append(empty);
  root.append(heading, body);
  $("#terminal-area").append(root);
  terminalResize.observe(body);
  const group = { root, body, nav, menuButton, empty, shown: null };
  groups.push(group);
  const focusGroup = () => {
    focusedGroup = group;
    activate(group.shown);
    if (!group.shown) setMode("sessions");
  };
  empty.onclick = focusGroup;
  heading.addEventListener("click", (event) => {
    if (event.target === nav || event.target === heading) focusGroup();
  });
  menu.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") return;
    const bounds = menuButton.getBoundingClientRect();
    menu.style.top = bounds.bottom + 4 + "px";
    menu.style.right = innerWidth - bounds.right + "px";
    menu.replaceChildren();
    for (const [index, target] of groups.entries()) {
      if (target === group) continue;
      const item = el("button", "", `合并到分屏 ${index + 1}`);
      item.type = "button";
      item.onclick = () => {
        menu.hidePopover();
        mergeGroup(group, target);
      };
      menu.append(item);
    }
  });
  root.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes(terminalDragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    root.classList.add("split-drop");
  });
  root.addEventListener("dragleave", (event) => {
    if (!root.contains(event.relatedTarget))
      root.classList.remove("split-drop");
  });
  root.addEventListener("drop", (event) => {
    const id = event.dataTransfer.getData(terminalDragType);
    root.classList.remove("split-drop");
    const tab = tabs.get(id);
    if (!tab || tab.moving) return;
    event.preventDefault();
    moveToGroup(tab, group);
    activate(id);
  });
  return group;
}
function nextInGroup(group) {
  return [...tabs.values()].find((tab) => tab.group === group)?.id || null;
}
function moveToGroup(tab, group) {
  const previous = tab.group;
  if (previous === group) return;
  tab.group = group;
  group.body.append(tab.pane);
  if (previous.shown === tab.id) {
    previous.shown = nextInGroup(previous);
    const replacement = tabs.get(previous.shown);
    if (replacement) requestAnimationFrame(() => fitTerminal(replacement));
  }
}
function mergeGroup(group, target) {
  if (!groups.includes(target)) return;
  const incoming = [...tabs.values()].filter((tab) => tab.group === group);
  if (incoming.some((tab) => tab.moving)) {
    toast("请等会话移动完成后再合并分屏");
    return;
  }
  const shown = group.shown;
  for (const tab of incoming) moveToGroup(tab, target);
  if (!target.shown) target.shown = shown || nextInGroup(target);
  groups.splice(groups.indexOf(group), 1);
  terminalResize.unobserve(group.body);
  group.root.remove();
  if (focusedGroup === group) focusedGroup = target;
  activate(current || target.shown || nextInGroup(target));
}
function syncGroups() {
  $("#terminal-area").dataset.count = groups.length;
  $("#split-add").disabled =
    !tabs.size || groups.length >= 4;
  $("#file-workspace-toggle").disabled = !tabs.size && !fileWorkspaceOpen;
  for (const [index, group] of groups.entries()) {
    group.root.classList.toggle("focused", group === focusedGroup);
    group.nav.setAttribute("aria-label", `分屏 ${index + 1} 的终端标签`);
    group.menuButton.hidden = groups.length === 1;
    group.empty.classList.toggle("hidden", !!group.shown || fileWorkspaceOpen);
    if (fileWorkspaceOpen) {
      group.filePanel ??= createWorkspacePanel(group);
      renderWorkspaceFiles(group);
      syncWorkspaceDirectory(tabs.get(group.shown));
    }
  }
  for (const tab of tabs.values())
    tab.pane.classList.toggle("active", tab.group.shown === tab.id);
}
$("#split-add").onclick = () => {
  if (!tabs.size) return;
  addGroup();
  activate(current, false);
};
function createTabElement(tab) {
  const element = el("div", "tab");
  const select = el("button", "tab-select");
  const label = el("span", "tab-name", tab.session.name);
  const close = el("button", "close", "×");
  select.type = close.type = "button";
  select.append(el("span", "dot"), label);
  close.title = "关闭连接";
  close.setAttribute("aria-label", "关闭 " + tab.session.name);
  close.onclick = (event) => {
    event.stopPropagation();
    closeTab(tab.id);
  };
  element.append(select, close);
  element.onclick = () => activate(tab.id);
  element.oncontextmenu = (event) => {
    event.preventDefault();
    api.tabMenu(tab.id).catch((error) => toast(error.message));
  };
  element.onkeydown = (event) => {
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      api.tabMenu(tab.id).catch((error) => toast(error.message));
    }
  };
  element.dataset.connection = tab.id;
  element.title = tab.session.name + " · 可拖到其他分屏";
  element.ondragstart = (event) => {
    if (tab.moving || event.target.closest(".close")) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(terminalDragType, tab.id);
    event.dataTransfer.effectAllowed = "move";
  };
  return { element, select };
}
function renderTabs() {
  for (const tab of tabs.values()) {
    tab.header ??= createTabElement(tab);
    const { element, select } = tab.header;
    if (element.parentElement !== tab.group.nav) tab.group.nav.append(element);
    const visible = tab.group.shown === tab.id;
    element.classList.toggle("active", visible);
    select.setAttribute("aria-pressed", String(visible));
    element.draggable = !tab.moving;
  }
}
function fitTerminal(t) {
  if (
    t.moving ||
    !tabs.has(t.id) ||
    fileWorkspaceOpen ||
    t.group.shown !== t.id
  )
    return;
  t.fit.fit();
  t.pane.dataset.cols = t.term.cols;
  t.pane.dataset.rows = t.term.rows;
  // fit() emits nothing when the geometry is unchanged. Always resync a ready
  // shell, including the first fit that happened before SSH finished opening.
  if (t.state === "已连接")
    api.send({
      type: "resize",
      id: t.id,
      cols: t.term.cols,
      rows: t.term.rows,
    });
  t.highlights?.refresh();
}
function activate(id, focus = true) {
  current = id;
  const t = tabs.get(id);
  if (t) {
    focusedGroup = t.group;
    t.group.shown = id;
  }
  syncGroups();
  api.windowTitle(t?.session.name || "工作空间");
  $("#focused-sftp").textContent = t ? t.session.name : "SFTP";
  $("#move-tab").disabled = !t || t.moving || t.state !== "已连接";
  $("#terminal-encoding").disabled = !t;
  $("#terminal-encoding").value = t?.encoding || "utf-8";
  $("#welcome").classList.toggle("hidden", tabs.size > 0 || fileWorkspaceOpen);
  $("#connected").classList.toggle("hidden", !tabs.size && !fileWorkspaceOpen);
  $("#workspace-title").textContent = t ? t.session.name : "概览";
  $("#welcome-new").textContent = sessions.length
    ? "＋ 新建会话"
    : "＋ 添加第一台服务器";
  renderTabs();
  terminalSearch.activate();
  quickPasswords.activate();
  if (t) {
    if (!fileWorkspaceOpen)
      requestAnimationFrame(() => {
        if (current !== t.id || fileWorkspaceOpen) return;
        fitTerminal(t);
        if (focus) t.term.focus();
      });
    $("#status").textContent =
      `${t.session.username}@${t.session.host} · ${t.state}`;
    $("#remote-path").value = t.path;
    renderSidebarFiles(t);
  } else {
    $("#status").textContent = "就绪";
    $("#file-list").replaceChildren(el("div", "empty", "请先连接一台服务器。"));
    $("#remote-path").value = "";
    setMode("sessions");
  }
}
function closeTab(id, disconnect = true) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.moving && disconnect) {
    toast("会话正在移动，请稍后关闭");
    return;
  }
  if (disconnect) api.send({ type: "disconnect", id });
  clearCwdQuery(t);
  terminalSearch.remove(t);
  t.highlights?.dispose();
  t.passwordPrompt?.dispose();
  t.fileLinks?.dispose();
  t.echo.dispose();
  t.term.dispose();
  t.pane.remove();
  t.header?.element.remove();
  tabs.delete(id);
  if (t.group.shown === id) {
    t.group.shown = nextInGroup(t.group);
    const replacement = tabs.get(t.group.shown);
    if (replacement) requestAnimationFrame(() => fitTerminal(replacement));
  }
  if (current === id)
    activate(
      t.group.shown || groups.find((group) => group.shown)?.shown || null,
    );
  else {
    syncGroups();
    renderTabs();
  }
  if (!tabs.size && groups.length > 1) {
    for (const group of groups.splice(1)) {
      terminalResize.unobserve(group.body);
      group.root.remove();
    }
    focusedGroup = groups[0];
    syncGroups();
  }
}
let fitFrame;
const terminalResize = new ResizeObserver(() => {
  if (fileWorkspaceOpen || fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = null;
    for (const group of groups) {
      const tab = tabs.get(group.shown);
      if (tab) fitTerminal(tab);
    }
  });
});
api.onEvent((m) => {
  const t = tabs.get(m.id);
  if (!t) return;
  if (m.type === "data") {
    const bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
    const rendered = t.echo.output(bytes);
    t.term.write(bytes, () => {
      rendered();
      api.send({ type: "ack", id: m.id, bytes: m.bytes });
    });
  } else if (m.type === "ready") {
    t.state = "已连接";
    fitTerminal(t);
    loadFiles(t, m.directory || ".");
    if (fileWorkspaceOpen) syncWorkspaceDirectory(t);
    if (current === t.id) activate(t.id);
  } else if (m.type === "closed" || m.type === "error") {
    t.echo.reset();
    clearCwdQuery(t);
    t.state = m.type === "closed" ? "已断开" : "连接出错";
    quickPasswords.activate();
    if (fileWorkspaceOpen) renderWorkspaceFiles(t.group);
    t.term.writeln("\r\n\x1b[31m" + (m.message || "连接已关闭") + "\x1b[0m");
    if (current === t.id)
      $("#status").textContent =
        `${t.session.username}@${t.session.host} · ${t.state}`;
  } else if (m.type === "progress" && (t.transferring || t.localDragging)) {
    const text = `${m.files || 0} 个文件完成 · ${m.name?.split("/").pop() || ""} ${m.total ? Math.round((m.current / m.total) * 100) : 0}%`;
    showTransfer(t, text);
  }
});
function size(n) {
  return n < 1024
    ? n + " B"
    : n < 1048576
      ? (n / 1024).toFixed(1) + " KB"
      : (n / 1048576).toFixed(1) + " MB";
}
function remoteJoin(base, name) {
  return (base === "/" ? "" : base) + "/" + name;
}
function renderSidebarFiles(tab) {
  renderFiles(tab, $("#file-list"));
  $("#transfer-status").textContent = tab.transferStatus ||
    (fileOpen === "single" ? "拖入上传 · 单击文件编辑" : "拖入上传 · 双击文件编辑");
}
function warmLocalDrag() {
  if (localDragAvailable !== true || localDragWarmed) return;
  localDragWarmed = true;
  api.warmLocalDrag();
}
function renderFiles(t, list) {
  highlightDropTarget(null);
  list.replaceChildren();
  if (!t.files.length)
    list.append(
      el(
        "div",
        "empty",
        t.loading
          ? "正在读取目录…"
          : t.fileError || "目录为空，可将本地文件或文件夹拖到这里上传。",
      ),
    );
  for (const f of t.files) {
    const row = el(
      "div",
      "file-row" + (t.selected?.name === f.name ? " selected" : ""),
    );
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    let localGesture = false;
    if (!f.symlink) {
      const finder = localDragAvailable === "finder";
      row.draggable = !finder;
      if (finder) row.classList.add("finder-draggable");
      row.onpointerenter = warmLocalDrag;
      row.onpointerdown = (event) => {
        localGesture = false;
        if (finder && event.isTrusted && event.pointerType === "mouse" && event.button === 0 &&
            !event.target.closest("button") && !t.localDragging && canDragRemote(t))
          api.armFinderDrag({ id: t.id, path: remoteJoin(t.path, f.name), directory: f.directory });
      };
      row.ondragstart = (event) => {
        if (localGesture || (finder && event.isTrusted)) event.preventDefault();
        else localGesture = startRemoteDrag(event, t.id, remoteJoin(t.path, f.name)) === true;
      };
    }
    const gesture = fileOpen === "single" && !f.symlink ? "单击" : "双击";
    row.title = f.directory
      ? gesture + "进入目录；右侧 ↓ 下载整个目录"
      : f.symlink ? "双击下载文件" : gesture + "编辑；右侧 ↓ 下载文件";
    if (localDragAvailable && !f.symlink)
      row.title += localDragAvailable === "finder"
        ? "；拖动可复制到 Finder 或其他 SSH 面板"
        : "；拖动可复制到 Windows 桌面、文件夹或其他 SSH 面板";
    if (f.directory) row.dataset.directory = remoteJoin(t.path, f.name);
    row.append(
      fileIcon(f),
      el("span", "filename", f.name),
      el("small", "", f.directory ? "目录" : size(f.size)),
    );
    const download = el("button", "download-one", "↓");
    download.title = f.directory ? "下载整个目录" : "下载文件";
    download.onclick = (e) => {
      e.stopPropagation();
      transfer(t, "download", remoteJoin(t.path, f.name), f.directory);
    };
    row.append(download);
    const remove = el("button", "delete-one");
    remove.append(trashIcon());
    remove.type = "button";
    remove.title = f.directory ? "删除远端目录及其内容" : "删除远端文件";
    remove.setAttribute("aria-label", "删除 " + f.name);
    remove.disabled = t.removing || t.moving || t.loading || t.state !== "已连接";
    remove.onclick = (event) => {
      event.stopPropagation();
      deleteRemote(t, remoteJoin(t.path, f.name));
    };
    row.append(remove);
    if (localDragAvailable === true && !f.symlink) {
      const grip = el("button", "local-drag", "↗");
      grip.type = "button";
      grip.tabIndex = -1;
      grip.title = "拖到 Windows 桌面或文件夹";
      grip.setAttribute("aria-label", grip.title);
      grip.onclick = (event) => event.stopPropagation();
      grip.onpointerenter = warmLocalDrag;
      let press;
      grip.onpointerdown = (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        localGesture = true;
        event.stopPropagation();
        event.preventDefault();
        grip.setPointerCapture(event.pointerId);
        press = { id: event.pointerId, x: event.clientX, y: event.clientY };
      };
      grip.onpointermove = (event) => {
        if (!press || event.pointerId !== press.id || !(event.buttons & 1) ||
            Math.max(Math.abs(event.clientX - press.x), Math.abs(event.clientY - press.y)) < 4) return;
        press = null;
        if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
        if (t.loading || t.moving || t.state !== "已连接") return;
        api.startLocalDrag({ id: t.id, path: remoteJoin(t.path, f.name) });
      };
      grip.onpointerup = grip.onpointercancel = grip.onlostpointercapture = () => { press = null; };
      grip.ondragstart = (event) => {
        event.stopPropagation();
        event.preventDefault();
      };
      row.append(grip);
    }
    const open = () => {
      if (f.directory) loadFiles(t, remoteJoin(t.path, f.name));
      else if (f.symlink) transfer(t, "download", remoteJoin(t.path, f.name));
      else openRemoteEditor(t, f);
    };
    row.onclick = (event) => {
      if (localGesture) return;
      t.selected = f;
      list.querySelector(".file-row.selected")?.classList.remove("selected");
      row.classList.add("selected");
      if (fileOpen === "single" && !f.symlink && event.detail <= 1) open();
    };
    row.ondblclick = (event) => {
      if (!localGesture && !event.target.closest("button") && (fileOpen === "double" || f.symlink)) open();
    };
    row.onkeydown = (e) => {
      if (e.key === "Enter" && e.target === row) {
        e.preventDefault();
        open();
      }
    };
    list.append(row);
  }
}
async function loadFiles(t, path, { keepOnError = false } = {}) {
  const v = ++t.loadVersion;
  t.loading = true;
  t.workspaceDirectoryNote = "";
  t.fileError = "";
  if (current === t.id) renderSidebarFiles(t);
  if (fileWorkspaceOpen) renderWorkspaceFiles(t.group);
  try {
    const data = await api.list({ id: t.id, path });
    if (v !== t.loadVersion || !tabs.has(t.id)) return;
    t.path = data.path;
    t.selected = null;
    t.files = data.files
      .filter((f) => f.name !== "." && f.name !== "..")
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      );
    return true;
  } catch (e) {
    if (v !== t.loadVersion || !tabs.has(t.id)) return;
    if (keepOnError) return false;
    t.fileError = e.message;
    t.files = [];
  } finally {
    if (v === t.loadVersion && tabs.has(t.id)) {
      t.loading = false;
      if (current === t.id) {
        $("#remote-path").value = t.path;
        renderSidebarFiles(t);
      }
      if (fileWorkspaceOpen) renderWorkspaceFiles(t.group);
    }
  }
}
function showTransfer(t, message) {
  t.transferStatus = message;
  if (current === t.id) $("#transfer-status").textContent = message;
  if (t.group.filePanel && t.group.shown === t.id)
    t.group.filePanel.status.textContent = message;
}
async function deleteRemote(tab, path) {
  if (tab.transferring || tab.removing) return toast("请等待当前文件操作完成");
  tab.removing = true;
  if (current === tab.id) renderSidebarFiles(tab);
  if (fileWorkspaceOpen) renderWorkspaceFiles(tab.group);
  try {
    const result = await api.removeRemote({ id: tab.id, path });
    if (!result.cancelled) {
      showTransfer(tab, `已删除 ${result.files} 个文件、${result.directories} 个目录`);
      await loadFiles(tab, tab.path);
    }
  } catch (error) {
    toast(error.message);
    showTransfer(tab, "删除失败：" + error.message);
    // A recursive delete may have completed some entries before an error.
    await loadFiles(tab, tab.path);
  } finally {
    tab.removing = false;
    if (tabs.has(tab.id)) {
      if (current === tab.id) renderSidebarFiles(tab);
      if (fileWorkspaceOpen) renderWorkspaceFiles(tab.group);
    }
  }
}
async function transfer(
  t,
  action,
  path,
  directory = false,
  files = null,
  token = null,
) {
  const tab = tabs.get(t.id);
  if (!tab || tab.transferring || tab.removing) {
    toast("请等待当前传输完成");
    return;
  }
  tab.transferring = true;
  showTransfer(t, "准备传输…");
  try {
    const request = { id: t.id, path };
    const r = token
      ? await api.relay({ ...request, token })
      : files
        ? await api.drop(request, files)
        : await api.transfer({ ...request, action, directory });
    showTransfer(
      t,
      r?.cancelled
        ? "已取消"
        : `完成 ${r?.files || 0} 个文件 · ${size(r?.bytes || 0)}${r?.skipped ? " · 跳过 " + r.skipped + " 项" : ""}`,
    );
    if (!r?.cancelled && (token || files || action.startsWith("upload")))
      loadFiles(t, t.path);
  } catch (error) {
    toast(error.message);
    showTransfer(t, "传输失败：" + error.message);
  } finally {
    tab.transferring = false;
  }
}
const remoteTokenPrefix = "jayxterm-sftp:";
function canDragRemote(tab) {
  return tab?.state === "已连接" &&
    !tab.moving && !tab.loading && !tab.removing && !tab.transferring;
}
function startRemoteDrag(event, id, path) {
  if (!canDragRemote(tabs.get(id)) || event.target.closest("button")) {
    event.preventDefault();
    return;
  }
  const token = api.remoteDrag({ id, path });
  if (!token) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(remoteDragType, token);
  if (localDragAvailable === true) {
    event.dataTransfer.setData("text/plain", remoteTokenPrefix + token);
    // Cancel Chromium's text-only drag before the helper takes over. The native
    // data object carries this same token for drops back into an SSH panel.
    event.preventDefault();
    api.startLocalDrag({ id, path, token });
    return true;
  }
}
for (const type of ["dragover", "drop"])
  document.addEventListener(type, (event) => event.preventDefault());
let highlightedDropTarget;
function highlightDropTarget(target) {
  if (target === highlightedDropTarget) return;
  highlightedDropTarget?.classList.remove("drop-active");
  highlightedDropTarget = target;
  target?.classList.add("drop-active");
}
function addFileDropZone(zone, list, getEntry) {
  const targetAt = (element) =>
    element.closest(".file-row[data-directory]") || list;
  function allowed() {
    const tab = getEntry();
    return tab?.state === "已连接" && !tab.moving && !tab.loading && !tab.transferring;
  }
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    const types = event.dataTransfer.types;
    const accepts =
      allowed() &&
      (types.includes("Files") ||
        types.includes(remoteDragType) ||
        types.includes("text/plain"));
    highlightDropTarget(accepts ? targetAt(event.target) : null);
    event.dataTransfer.dropEffect = accepts ? "copy" : "none";
  });
  zone.addEventListener("dragleave", (event) => {
    if (!zone.contains(event.relatedTarget)) highlightDropTarget(null);
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    highlightDropTarget(null);
    if (!allowed()) return;
    const t = getEntry();
    const to = targetAt(event.target).dataset.directory || t.path;
    const data = event.dataTransfer;
    let token = data.getData(remoteDragType);
    const text = data.getData("text/plain");
    if (!token && text.startsWith(remoteTokenPrefix))
      token = text.slice(remoteTokenPrefix.length);
    const files = Array.from(data.files);
    if (token || files.length)
      transfer(t, "upload", to, false, files, token);
  });
}
addFileDropZone($("#files-panel"), $("#file-list"), () => tabs.get(current));
$("#upload-file").onclick = () => {
  $("#upload-options").hidePopover();
  const t = tabs.get(current);
  if (t) transfer(t, "upload", t.path);
};
$("#upload-directory").onclick = () => {
  $("#upload-options").hidePopover();
  const t = tabs.get(current);
  if (t) transfer(t, "upload-directory", t.path);
};
function clearCwdQuery(tab) {
  clearTimeout(tab.cwdQuery?.timer);
  tab.cwdQuery = null;
}
let cwdDialogTab;
function showCwdDialog(tab) {
  cwdDialogTab = tab;
  $("#cwd-dialog").showModal();
}
function cwdCommand(host) {
  const report = (name) =>
    String.raw`printf '\033]7;file://${name}%s\007' "$(command pwd -P | sed 's/%/%25/g')"`;
  const reporter = "__jayxterm_report_cwd() { " +
    '[ "${__jayxterm_last_cwd-}" = "$PWD" ] && return 0; ' +
    '__jayxterm_last_cwd=$PWD; ' +
    String.raw`printf '\033]7;file://jayxterm-shell%s\007' "` +
    '${PWD//\\%/%25}"; };';
  const bash = [
    reporter,
    "if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then",
    "PROMPT_COMMAND+=(__jayxterm_report_cwd);",
    'elif [[ -n "${PROMPT_COMMAND-}" ]]; then',
    String.raw`PROMPT_COMMAND+=$'\n'__jayxterm_report_cwd;`,
    "else PROMPT_COMMAND=__jayxterm_report_cwd; fi",
  ].join(" ");
  const zsh = reporter + " typeset -ga precmd_functions; precmd_functions+=(__jayxterm_report_cwd)";
  const quote = (script) => "'" + script.replaceAll("'", "'\\''") + "'";
  // Only install a prompt hook in the interactive shell that the user confirmed.
  // Other shells still get the one-shot result and can use their native OSC 7.
  return report(host) + [
    "; case $- in *i*)",
    'if [ -n "${BASH_VERSION-}" ]; then',
    `if ! declare -F __jayxterm_report_cwd >/dev/null; then eval ${quote(bash)}; fi;`,
    'elif [ -n "${ZSH_VERSION-}" ]; then',
    `if ! typeset -f __jayxterm_report_cwd >/dev/null; then eval ${quote(zsh)}; fi;`,
    "fi;; esac",
  ].join(" ");
}
$("#sync-cwd").onclick = () => {
  const t = tabs.get(current);
  if (t?.state !== "已连接" || t.moving) {
    toast("请先连接 SSH");
    return;
  }
  if (t.shellDirectory) loadFiles(t, t.shellDirectory);
  else if (t.cwdQuery) toast("正在等候 Shell 返回目录");
  else showCwdDialog(t);
};
$("#cwd-query").onclick = () => {
  const dialog = $("#cwd-dialog");
  const tab = cwdDialogTab;
  if (tab?.state !== "已连接" || tabs.get(tab.id) !== tab || tab.moving || tab.term.options.disableStdin) {
    dialog.close();
    toast("请先连接 SSH");
    return;
  }
  if (tab.term.buffer.active.type === "alternate") {
    dialog.close();
    toast("请先退出 Vim 等全屏程序，回到 Shell 提示符后再同步");
    return;
  }
  if (tab.cwdQuery) {
    dialog.close();
    toast("正在等候 Shell 返回目录");
    return;
  }
  const host = `jayxterm-query-${crypto.randomUUID()}`;
  tab.cwdQuery = {
    host,
    timer: setTimeout(() => {
      clearCwdQuery(tab);
      if (current === tab.id)
        toast("未收到目录，请回到空白的 Shell 提示符后重试");
    }, 5000),
  };
  dialog.close();
  if (current === tab.id && !fileWorkspaceOpen) tab.term.focus();
  api.send({ type: "input", id: tab.id, data: cwdCommand(host) + "\r" });
};
$("#path-form").onsubmit = (e) => {
  e.preventDefault();
  const t = tabs.get(current);
  if (t) loadFiles(t, $("#remote-path").value);
};
$("#up").onclick = () => {
  const t = tabs.get(current);
  if (t) loadFiles(t, remoteJoin(t.path, ".."));
};
$("#refresh").onclick = () => {
  const t = tabs.get(current);
  if (t) loadFiles(t, t.path);
};
function createWorkspacePanel(group) {
  const root = el("section", "workspace-files");
  root.setAttribute("aria-label", "远程文件");
  const form = el("form", "pathbar");
  const up = el("button", "", "↑");
  up.type = "button";
  up.title = "上一级";
  const input = el("input");
  input.setAttribute("aria-label", "远程目录");
  const go = el("button", "", "↵");
  go.title = "打开目录";
  const refresh = el("button", "", "↻");
  refresh.type = "button";
  refresh.title = "刷新";
  form.append(up, input, go, refresh);
  const list = el("div", "file-list");
  const status = el("div", "transfer-status");
  const empty = el("button", "group-empty hidden");
  empty.type = "button";
  root.append(form, list, status, empty);
  group.body.append(root);

  const tab = () => tabs.get(group.shown);
  const focusGroup = () => {
    if (focusedGroup === group) return;
    focusedGroup = group;
    activate(group.shown, false);
  };
  root.addEventListener("focusin", focusGroup);
  root.addEventListener("pointerdown", focusGroup);
  empty.onclick = () => {
    focusGroup();
    if (!tab()) setMode("sessions");
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const t = tab();
    if (t) loadFiles(t, input.value);
  };
  up.onclick = () => {
    const t = tab();
    if (t) loadFiles(t, remoteJoin(t.path, ".."));
  };
  refresh.onclick = () => {
    const t = tab();
    if (t) loadFiles(t, t.path);
  };
  addFileDropZone(root, list, tab);
  return { form, input, list, status, empty };
}
function renderWorkspaceFiles(group) {
  const panel = group.filePanel;
  if (!panel) return;
  const tab = tabs.get(group.shown);
  const ready = tab?.state === "已连接" && !tab.moving;
  const previous = panel.rendered;
  const state = { tab, ready, path: tab?.path, files: tab?.files, loading: tab?.loading,
    status: tab?.state, removing: tab?.removing, directoryNote: tab?.workspaceDirectoryNote };
  if (previous && Object.keys(state).every((key) => state[key] === previous[key])) return;
  panel.rendered = state;
  panel.form.classList.toggle("hidden", !ready);
  panel.list.classList.toggle("hidden", !ready);
  panel.status.classList.toggle("hidden", !ready);
  panel.empty.classList.toggle("hidden", ready);
  panel.empty.textContent = tab?.moving
    ? "会话正在移动…"
    : tab?.state || "拖入终端标签，或在左侧连接会话";
  if (!ready) {
    panel.list.replaceChildren();
    return;
  }
  if (previous?.tab !== tab || previous.path !== tab.path || tab.loading)
    panel.input.value = tab.path;
  panel.status.textContent = tab.workspaceDirectoryNote || tab.transferStatus || "拖到其他分屏或窗口即可复制";
  renderFiles(tab, panel.list);
}
async function syncWorkspaceDirectory(tab) {
  if (tab?.state !== "已连接" || tab.moving || tab.group.shown !== tab.id ||
      tab.workspaceSyncVersion === fileWorkspaceVersion) return;
  const version = fileWorkspaceVersion;
  tab.workspaceSyncVersion = version;
  if (tab.workspaceDirectoryNote) {
    tab.workspaceDirectoryNote = "";
    renderWorkspaceFiles(tab.group);
  }
  const stillVisible = () => fileWorkspaceOpen && fileWorkspaceVersion === version &&
    tabs.get(tab.id) === tab && !tab.moving && tab.state === "已连接" && tab.group.shown === tab.id;
  const listVersion = tab.loadVersion;
  // Prefer a directory report from the interactive shell. Servers that do
  // not report one may expose the PTY process's directory on a separate channel.
  const directory = tab.shellDirectory || await api.shellDirectory(tab.id).catch(() => null);
  if (!stillVisible() || listVersion !== tab.loadVersion) return;
  const target = tab.shellDirectory || directory;
  if (target) {
    if (target === tab.path && !tab.loading && !tab.fileError) return;
    const loaded = await loadFiles(tab, target, { keepOnError: true });
    if (loaded !== false || !stillVisible() || tab.loadVersion !== listVersion + 1) return;
    if (tab.path === ".") {
      await loadFiles(tab, ".");
      if (tab.loadVersion !== listVersion + 2) return;
    }
  }
  if (!stillVisible()) return;
  tab.workspaceDirectoryNote = "未能同步 SSH 当前目录，已保留原目录";
  renderWorkspaceFiles(tab.group);
}
function toggleFileWorkspace(focus = true) {
  fileWorkspaceOpen = !fileWorkspaceOpen;
  fileWorkspaceVersion++;
  $("#terminal-area").classList.toggle("show-file-space", fileWorkspaceOpen);
  const button = $("#file-workspace-toggle");
  button.querySelector("span").textContent = fileWorkspaceOpen ? "返回终端" : "文件空间";
  button.setAttribute("aria-pressed", String(fileWorkspaceOpen));
  highlightDropTarget(null);
  activate(current, !fileWorkspaceOpen && focus);
  if (!fileWorkspaceOpen)
    requestAnimationFrame(() => {
      for (const group of groups) {
        const tab = tabs.get(group.shown);
        if (tab && tab.id !== current) fitTerminal(tab);
      }
    });
}
$("#file-workspace-toggle").onclick = () => toggleFileWorkspace();
function markMoving(t, moving) {
  t.echo.reset();
  t.moving = moving;
  t.term.options.disableStdin = moving;
  t.pane.classList.toggle("moving", moving);
  quickPasswords.activate();
  if (fileWorkspaceOpen) renderWorkspaceFiles(t.group);
  if (current === t.id)
    $("#move-tab").disabled = moving || t.state !== "已连接";
}
api.onWindow(async (m) => {
  if (m.type === "passwords-changed") {
    if (quickPasswordsEnabled) quickPasswords.refresh();
    return;
  }
  if (m.type === "duplicate-tab") {
    await duplicateTab(tabs.get(m.id));
    return;
  }
  if (m.type === "local-drag-status") {
    const tab = tabs.get(m.id);
    if (tab) {
      tab.localDragging = m.active;
      if (m.message) showTransfer(tab, m.message);
    }
    return;
  }
  if (m.type === "settings-changed") {
    updateSettings(m.settings);
    if ($("#editor").open) loadSessionHistory();
    if ($("#password-dialog").open) loadConnectHistory();
    return;
  }
  if (m.type === "remote-text-saved") {
    const tab = tabs.get(m.id);
    if (tab && tab.path === m.directory) loadFiles(tab, tab.path);
    return;
  }
  if (m.type === "clipboard") {
    await terminalClipboard(tabs.get(m.id), m.action);
    return;
  }
  if (m.type === "sessions-changed") {
    sessions = await api.sessions();
    renderSessions();
    return;
  }
  if (m.type === "notice") {
    toast(m.message);
    return;
  }
  if (m.type === "settled") {
    const t = tabs.get(m.id);
    if (t) {
      markMoving(t, false);
      loadFiles(t, t.path);
    }
    return;
  }
  if (m.type !== "request") return;
  const { id } = m.payload;
  let result;
  try {
    if (m.action === "prepare") {
      const t = tabs.get(id);
      if (
        !t ||
        t.transferring ||
        t.loading ||
        t.cwdQuery ||
        t.state !== "已连接"
      )
        throw new Error("当前会话暂时无法移动");
      markMoving(t, true);
      // Drain received terminal output before the one-off snapshot. Never poll buffers.
      await new Promise((resolve) => t.term.write("", resolve));
      const { SerializeAddon } = await import("@xterm/addon-serialize");
      const serializer = new SerializeAddon();
      t.term.loadAddon(serializer);
      try {
        result = {
          session: t.session,
          encoding: t.encoding,
          path: t.path,
          shellDirectory: t.shellDirectory,
          cols: t.term.cols,
          rows: t.term.rows,
          distanceFromBottom:
            t.term.buffer.active.baseY - t.term.buffer.active.viewportY,
          screen: serializer.serialize({ scrollback: 3000 }),
        };
      } finally {
        serializer.dispose();
      }
    } else if (m.action === "restore") {
      if (tabs.has(id)) throw new Error("目标窗口已有该连接");
      const t = createTerminal(m.payload.session, id, { moving: true });
      t.encoding = m.payload.encoding;
      t.path = m.payload.path;
      t.shellDirectory = m.payload.shellDirectory;
      t.state = "已连接";
      t.term.resize(m.payload.cols, m.payload.rows);
      await new Promise((resolve) => t.term.write(m.payload.screen, resolve));
      t.restoreDistance = m.payload.distanceFromBottom;
    } else if (m.action === "commit") {
      const t = tabs.get(id);
      if (!t) throw new Error("目标标签已关闭");
      markMoving(t, false);
      t.term.options.disableStdin = true;
      t.pane.classList.add("moving");
      activate(id);
      setMode("files");
      fitTerminal(t);
      t.term.scrollToLine(
        Math.max(0, t.term.buffer.active.baseY - (t.restoreDistance || 0)),
      );
      delete t.restoreDistance;
    } else if (m.action === "release" || m.action === "discard") {
      closeTab(id, false);
    } else if (m.action === "rollback") {
      const t = tabs.get(id);
      if (t) {
        markMoving(t, false);
        if (current === id) activate(id);
      }
    }
    api.windowReply({ token: m.token, result });
  } catch (error) {
    api.windowReply({ token: m.token, error: error.message });
  }
});
$("#new-window").onclick = () => {
  $("#window-tools-options").hidePopover();
  api.newWindow();
};
const importDialog = $("#session-import-dialog");
const importList = $("#session-import-rows");
const importSummary = $("#session-import-summary");
const applyImportButton = $("#session-import-apply");
const cancelImportButton = $("#session-import-cancel");
const importError = $("#session-import-error");
let importPreview, importChoices;
let exchangingSessions = false;
function renderImportSummary() {
  const added = importChoices.filter((choice) => choice === "add").length;
  const skipped = importChoices.filter((choice) => choice === "skip").length;
  const updated = importChoices.length - added - skipped;
  importSummary.value = `新增 ${added} · 更新 ${updated} · 跳过 ${skipped}`;
  applyImportButton.disabled = added + updated === 0;
}
function importRow(item, index) {
  const row = el("div", "session-import-row");
  row.setAttribute("role", "listitem");
  const heading = el("div", "import-item");
  heading.append(el("strong", "", item.name || "未命名会话"));
  row.append(heading);
  if (item.reason) {
    heading.append(el("small", "", item.reason));
    row.append(el("span", "import-skip", "跳过"));
    return row;
  }
  heading.append(el("small", "", `${item.username}@${item.host}:${item.port}${item.group ? " · " + item.group : ""}`));
  const select = el("select", "import-action");
  select.setAttribute("aria-label", "处理会话 " + item.name);
  const possibleMatch = item.duplicate || item.matches.length > 0;
  select.append(new Option(possibleMatch ? "保留两条" : "新增", "add"), new Option("跳过", "skip"));
  for (const match of item.matches) {
    const detail = [match.group || "未分组", match.encoding?.toUpperCase() || "UTF-8",
      match.hasPassword ? "已保存密码" : "未保存密码"].join(" · ");
    select.append(new Option(`更新「${match.name}」 · ${detail}`, "update:" + match.id));
  }
  select.value = importChoices[index];
  row.append(select);
  if (possibleMatch) {
    const details = el("div", "import-details");
    const note = el("small", "", item.matches.length
      ? "可能重复 · 已有会话使用相同主机、端口和用户名"
      : "可能重复 · 本批次已有相同主机、端口和用户名的会话");
    const changes = el("div", "import-changes");
    changes.hidden = true;
    details.append(note, changes);
    row.append(details);
    select.onchange = () => {
      const match = item.matches.find(({ id }) => select.value === "update:" + id);
      changes.hidden = !match;
      if (match) {
        const rows = [];
        if (match.name !== item.name)
          rows.push(el("div", "", `名称　${match.name} → ${item.name}`));
        if (item.group && item.group !== match.group)
          rows.push(el("div", "", `分组　${match.group || "未分组"} → ${item.group}`));
        if (!rows.length) rows.push(el("div", "", "名称和分组相同"));
        rows.push(el("small", "", "继续使用已有会话的密码和终端编码"));
        changes.replaceChildren(...rows);
      }
      importChoices[index] = select.value;
      renderImportSummary();
    };
  } else {
    select.onchange = () => {
      importChoices[index] = select.value;
      renderImportSummary();
    };
  }
  return row;
}
async function chooseSessionImport(format) {
  if (exchangingSessions) return;
  exchangingSessions = true;
  $("#window-tools-options").hidePopover();
  try {
    const preview = await api.previewSessionImport(format);
    if (!preview) return;
    importPreview = preview;
    importChoices = preview.rows.map((item) =>
      item.reason || item.duplicate || item.matches.length ? "skip" : "add");
    $("#session-import-source").textContent = (format === "xshell" ? "Xshell · " : "OpenSSH · ") + preview.file;
    importList.replaceChildren(...preview.rows.map(importRow));
    importError.hidden = true;
    renderImportSummary();
    importDialog.showModal();
  } catch (error) {
    toast(error.message);
  } finally {
    exchangingSessions = false;
  }
}
$("#import-xshell").onclick = () => chooseSessionImport("xshell");
$("#import-openssh").onclick = () => chooseSessionImport("ssh");
cancelImportButton.onclick = () => importDialog.close();
importDialog.oncancel = (event) => { if (exchangingSessions) event.preventDefault(); };
importDialog.onclose = () => {
  // A native close event can arrive after the next file has already opened.
  if (importDialog.open) return;
  importPreview = null;
  importList.replaceChildren();
};
$("#session-import-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!importPreview || exchangingSessions || applyImportButton.disabled) return;
  exchangingSessions = true;
  applyImportButton.disabled = cancelImportButton.disabled = true;
  importError.hidden = true;
  try {
    const result = await api.applySessionImport({ token: importPreview.token, choices: importChoices });
    sessions = result.sessions;
    renderSessions();
    importDialog.close();
    setMode("sessions");
    toast(`导入完成 · 新增 ${result.added} · 更新 ${result.updated} · 跳过 ${result.skipped}`);
  } catch (error) {
    importError.textContent = error.message;
    importError.hidden = false;
  } finally {
    exchangingSessions = false;
    cancelImportButton.disabled = false;
    if (importDialog.open) renderImportSummary();
  }
};
$("#export-openssh").onclick = async () => {
  if (exchangingSessions) return;
  exchangingSessions = true;
  $("#window-tools-options").hidePopover();
  try {
    const result = await api.exportSshConfig();
    if (result) toast(`已导出 ${result.count} 条会话${result.skipped ? "，跳过无效会话 " + result.skipped + " 条" : ""}`);
  } catch (error) {
    toast(error.message);
  } finally {
    exchangingSessions = false;
  }
};
$("#move-tab").onclick = async () => {
  $("#window-tools-options").hidePopover();
  if (current)
    try {
      await api.moveTab({ id: current });
    } catch (e) {
      toast(e.message);
    }
};
$("#window-picker").onclick = async () => {
  $("#window-tools-options").hidePopover();
  const list = $("#window-list");
  list.replaceChildren();
  const windows = await api.windows();
  for (const w of windows) {
    const row = el("div", "window-row");
    row.append(el("span", "", w.title + " · " + w.count + " 个连接"));
    const focus = el("button", "", "切换");
    focus.onclick = () => {
      api.focusWindow(w.id);
      $("#windows-dialog").close();
    };
    row.append(focus);
    if (w.id !== windowId && current) {
      const move = el("button", "", "移到此窗口");
      move.onclick = async () => {
        const id = current;
        $("#windows-dialog").close();
        try {
          await api.moveTab({ id, target: w.id });
        } catch (e) {
          toast(e.message);
        }
      };
      row.append(move);
    }
    list.append(row);
  }
  $("#windows-dialog").showModal();
};
$("#windows-close").onclick = () => $("#windows-dialog").close();
document.addEventListener("keydown", (e) => {
  if (
    e.ctrlKey &&
    (e.code === "PageDown" || e.code === "PageUp") &&
    !document.querySelector("dialog[open]")
  ) {
    e.preventDefault();
    const ids = [...tabs.values()]
      .filter((tab) => tab.group === focusedGroup)
      .map((tab) => tab.id);
    if (ids.length) {
      const next =
        (ids.indexOf(current) + (e.code === "PageDown" ? 1 : -1) + ids.length) %
        ids.length;
      activate(ids[next]);
    }
  } else if (e.ctrlKey && e.shiftKey && e.code === "KeyN") {
    e.preventDefault();
    api.newWindow();
  } else if (e.ctrlKey && e.shiftKey && e.code === "KeyO") {
    e.preventDefault();
    $("#window-picker").click();
  }
});
const { id: windowId, number: windowNumber } = await api.windowReady();
$("#window-label").textContent = "窗口 " + windowNumber;
try {
  const [savedSessions, settings, dragAvailable] = await Promise.all([
    api.sessions(), api.settings(), api.localDragAvailable(),
  ]);
  localDragAvailable = dragAvailable;
  sessions = savedSessions;
  updateSettings(settings);
  renderSessions();
} catch (e) {
  toast(e.message);
}
