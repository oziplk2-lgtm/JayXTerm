import { filterHistoryEntries, formatRelativeTime } from "./terminal-history.mjs";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === "button") node.type = "button";
  return node;
};

function makeSvg(paths) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

export function tabHistoryMeta(tab) {
  if (!tab?.session) return { scopeKey: "", hostKey: "", sessionName: "" };
  const s = tab.session;
  const hostKey = `${s.username}@${s.host}:${s.port}`;
  return {
    scopeKey: s.id ? `session:${s.id}` : `host:${hostKey}`,
    hostKey,
    sessionName: tab.customTitle || s.name || hostKey,
  };
}

export function installCommandHistory({ api, getActiveTab, showTerminal, sendCommand, toast, isMac }) {
  const $ = (selector) => document.querySelector(selector);
  const palette = $("#command-history-palette");
  const input = $("#command-history-input");
  const list = $("#command-history-list");
  const toggle = $("#terminal-history-toggle");
  const closeButton = $("#command-history-close");
  const clearScopeButton = $("#command-history-clear-scope");
  const countEl = $("#command-history-count");
  const scopeButtons = [...palette.querySelectorAll("[data-history-scope]")];
  const hintKey = isMac ? "Cmd+Enter" : "Ctrl+Enter";
  const shortcutLabel = isMac ? "Cmd+Shift+H" : "Ctrl+Shift+H";
  toggle.title = `历史命令（${shortcutLabel}）`;
  input.placeholder = `搜索历史命令（空格分词）· Enter 填入 · ${hintKey} 执行`;
  const runHint = $("#command-history-run-hint");
  if (runHint) runHint.textContent = `${hintKey} 执行`;

  let enabled = false;
  let scope = "session";
  let items = [];
  let visible = [];
  let selectedId = null;
  let loadVersion = 0;

  function setScope(next) {
    scope = next;
    for (const btn of scopeButtons) {
      const active = btn.dataset.historyScope === scope;
      btn.setAttribute("aria-selected", String(active));
    }
    render();
  }

  function updateClearButton() {
    if (!clearScopeButton) return;
    if (scope === "pinned") {
      clearScopeButton.hidden = true;
      return;
    }
    clearScopeButton.hidden = visible.length === 0;
    clearScopeButton.textContent = scope === "session" ? "清空当前会话" : "清空全部";
  }

  function render() {
    if (palette.hidden) return;
    const tab = getActiveTab();
    const meta = tabHistoryMeta(tab);
    const effectiveScope = scope === "session" && !meta.scopeKey ? "all" : scope;
    visible = filterHistoryEntries(items, {
      scope: effectiveScope,
      scopeKey: meta.scopeKey,
      hostKey: meta.hostKey,
      query: input.value,
    });
    if (!visible.some((item) => item.id === selectedId)) {
      selectedId = visible[0]?.id || null;
    }
    if (countEl) countEl.textContent = `${visible.length} 条`;
    updateClearButton();
    list.replaceChildren();
    if (!visible.length) {
      const emptyText = input.value.trim()
        ? "没有匹配的历史命令"
        : scope === "pinned"
          ? "还没有收藏命令，点击条目右侧星标即可收藏"
          : "暂无历史命令，在终端执行命令后会自动记录";
      list.append(el("div", "command-history-empty", emptyText));
      return;
    }
    const now = Date.now();
    for (const entry of visible) {
      const row = el("div", "command-history-item");
      row.dataset.historyId = entry.id;
      row.setAttribute("role", "option");
      const active = entry.id === selectedId;
      row.classList.toggle("selected", active);
      row.setAttribute("aria-selected", String(active));

      const main = el("div", "command-history-main");
      const cmd = el("code", "command-history-cmd", entry.command);
      cmd.title = entry.command;
      main.append(cmd);

      const metaRow = el("div", "command-history-meta");
      const parts = [];
      if (entry.note) parts.push(entry.note);
      if (effectiveScope !== "session" && entry.sessionName) parts.push(entry.sessionName);
      if (entry.useCount > 1) parts.push(`×${entry.useCount}`);
      const rel = formatRelativeTime(entry.lastUsedAt, now);
      if (rel) parts.push(rel);
      metaRow.textContent = parts.join(" · ");
      if (parts.length) main.append(metaRow);

      const actions = el("div", "command-history-actions");

      const pinBtn = el("button", "history-action history-pin" + (entry.pinned ? " pinned" : ""));
      pinBtn.append(makeSvg(["M8 2.2 9.8 5.9l4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6Z"]));
      pinBtn.title = entry.pinned ? "取消收藏" : "收藏命令";
      pinBtn.setAttribute("aria-label", pinBtn.title);
      pinBtn.setAttribute("aria-pressed", String(entry.pinned));
      pinBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          await api.pinCommandHistory(entry.id);
          await refresh();
        } catch (err) {
          toast(err.message);
        }
      };

      const fillBtn = el("button", "history-action history-fill");
      fillBtn.append(makeSvg(["M12.5 4.5v4a2 2 0 0 1-2 2H4", "M6.5 8 4 10.5 6.5 13"]));
      fillBtn.title = "填入终端（Enter）";
      fillBtn.setAttribute("aria-label", "填入终端");
      fillBtn.onclick = (e) => {
        e.stopPropagation();
        applyEntry(entry, false);
      };

      const runBtn = el("button", "history-action history-run");
      runBtn.append(makeSvg(["M5 3.5 12.5 8 5 12.5Z"]));
      runBtn.title = `直接执行（${hintKey}）`;
      runBtn.setAttribute("aria-label", "直接执行");
      runBtn.onclick = (e) => {
        e.stopPropagation();
        applyEntry(entry, true);
      };

      const copyBtn = el("button", "history-action history-copy");
      copyBtn.append(makeSvg(["M6 6h7v7H6Z", "M3.5 10H3V3h7v.5"]));
      copyBtn.title = "复制命令";
      copyBtn.setAttribute("aria-label", "复制命令");
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          await api.writeClipboard(entry.command);
          toast("已复制命令到剪贴板");
        } catch (err) {
          toast(err.message);
        }
      };

      const delBtn = el("button", "history-action history-delete");
      delBtn.append(makeSvg(["M4.5 4.5 11.5 11.5", "M11.5 4.5 4.5 11.5"]));
      delBtn.title = "删除记录";
      delBtn.setAttribute("aria-label", "删除记录");
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          await api.removeCommandHistory(entry.id);
          await refresh();
        } catch (err) {
          toast(err.message);
        }
      };

      actions.append(pinBtn, fillBtn, runBtn, copyBtn, delBtn);
      row.append(main, actions);
      row.onmouseenter = () => selectById(entry.id, false);
      row.onclick = () => applyEntry(entry, false);
      list.append(row);
    }
  }

  function selectById(id, scroll = true) {
    selectedId = id;
    for (const row of list.querySelectorAll(".command-history-item")) {
      const active = row.dataset.historyId === id;
      row.classList.toggle("selected", active);
      row.setAttribute("aria-selected", String(active));
      if (active && scroll) row.scrollIntoView({ block: "nearest" });
    }
  }

  function moveSelection(delta) {
    if (!visible.length) return;
    const index = visible.findIndex((item) => item.id === selectedId);
    const nextIndex = index < 0 ? 0 : (index + delta + visible.length) % visible.length;
    selectById(visible[nextIndex].id, true);
  }

  async function applyEntry(entry, execute) {
    if (!entry) return;
    const tab = getActiveTab();
    if (!tab || tab.moving || tab.state !== "已连接") {
      try {
        await api.writeClipboard(entry.command);
        toast("当前未连接终端，已复制命令到剪贴板");
      } catch (err) {
        toast(err.message);
      }
      close(false);
      return;
    }
    showTerminal();
    close(false);
    sendCommand(tab, entry.command, { execute });
    tab.term.focus();
  }

  async function refresh() {
    if (!enabled) return;
    const version = ++loadVersion;
    try {
      const result = await api.commandHistory();
      if (version !== loadVersion) return;
      items = Array.isArray(result?.items) ? result.items : [];
      if (!palette.hidden) render();
    } catch {
      // Non-fatal; keep previous cache if main process is busy.
    }
  }

  function onOutsidePointerDown(event) {
    if (palette.hidden) return;
    if (palette.contains(event.target) || toggle.contains(event.target)) return;
    close(false);
  }

  async function open() {
    if (!enabled) return;
    const tab = getActiveTab();
    if (!tab && scope === "session") scope = "all";
    for (const btn of scopeButtons) {
      btn.setAttribute("aria-selected", String(btn.dataset.historyScope === scope));
    }
    palette.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutsidePointerDown, true);
    render();
    input.focus();
    input.select();
    await refresh();
  }

  function close(focusTerminal = true) {
    if (palette.hidden) return;
    palette.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutsidePointerDown, true);
    if (focusTerminal) getActiveTab()?.term.focus();
  }

  function syncToggle() {
    toggle.hidden = !enabled;
    toggle.disabled = !enabled;
  }

  toggle.onclick = () => {
    if (!enabled) return;
    if (palette.hidden) open();
    else close();
  };
  closeButton.onclick = () => close();
  for (const btn of scopeButtons) {
    btn.onclick = () => {
      setScope(btn.dataset.historyScope);
      input.focus();
    };
  }
  input.oninput = () => render();
  palette.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Tab") {
      const current = visible.find((item) => item.id === selectedId);
      if (current) {
        event.preventDefault();
        applyEntry(current, false);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const current = visible.find((item) => item.id === selectedId);
      if (!current) return;
      const execute = isMac ? event.metaKey : event.ctrlKey;
      applyEntry(current, execute);
    }
  };
  clearScopeButton.onclick = async () => {
    const tab = getActiveTab();
    const meta = tabHistoryMeta(tab);
    const scopeKey = scope === "session" && meta.scopeKey ? meta.scopeKey : undefined;
    try {
      const res = await api.clearCommandHistory({ scopeKey });
      await refresh();
      if (res?.removed) toast(`已清空 ${res.removed} 条历史命令`);
    } catch (err) {
      toast(err.message);
    }
  };

  syncToggle();
  return {
    open,
    close,
    toggle() {
      if (!enabled) return;
      if (palette.hidden) open();
      else close();
    },
    isOpen: () => !palette.hidden,
    refresh,
    activate() {
      syncToggle();
      if (!palette.hidden) render();
    },
    setEnabled(value) {
      if (enabled === Boolean(value)) return;
      enabled = Boolean(value);
      syncToggle();
      if (!enabled) {
        close(palette.contains(document.activeElement));
        items = [];
        input.value = "";
      } else {
        refresh();
      }
    },
  };
}
