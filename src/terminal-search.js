import { SearchAddon } from "@xterm/addon-search";
import { buildEffectiveSearch, validateSearchRegex } from "./workspace-layout.mjs";

const MAX_QUERY_HISTORY = 20;

export function installTerminalSearch({ getActiveTab, showTerminal, getTheme }) {
  const $ = (selector) => document.querySelector(selector);
  const panel = $("#terminal-search");
  const field = panel.querySelector(".terminal-search-field");
  const input = $("#terminal-search-input");
  const toggle = $("#terminal-search-toggle");
  const count = $("#terminal-search-count");
  const errorEl = $("#terminal-search-error");
  const caseButton = $("#terminal-search-case");
  const wordButton = $("#terminal-search-word");
  const regexButton = $("#terminal-search-regex");
  const previous = $("#terminal-search-previous");
  const next = $("#terminal-search-next");
  let enabled = false, active, addon, listener, timer;
  const queryHistory = [];
  let historyIndex = -1;

  function isPressed(button) {
    return button?.getAttribute("aria-pressed") === "true";
  }

  function rememberQuery(value) {
    if (!value) return;
    const existing = queryHistory.indexOf(value);
    if (existing >= 0) queryHistory.splice(existing, 1);
    queryHistory.unshift(value);
    if (queryHistory.length > MAX_QUERY_HISTORY) queryHistory.length = MAX_QUERY_HISTORY;
    historyIndex = -1;
  }

  function setError(message) {
    if (field) field.dataset.invalid = message ? "true" : "false";
    if (!errorEl) return;
    errorEl.textContent = message || "";
    errorEl.hidden = !message;
  }

  function results({ resultIndex = -1, resultCount = 0 } = {}) {
    const hasQuery = Boolean(input.value);
    const empty = hasQuery && resultCount === 0;
    if (resultIndex < 0 && resultCount >= 1000) {
      count.textContent = "1000+";
    } else if (empty) {
      count.textContent = "无结果";
    } else {
      count.textContent = `${Math.max(0, resultIndex + 1)} / ${resultCount}`;
    }
    count.dataset.empty = String(empty);
    previous.disabled = next.disabled = resultCount === 0;
  }

  function options(incremental, { effectiveRegex, effectiveWholeWord }) {
    const theme = getTheme();
    const dark = theme.dark;
    return {
      incremental,
      caseSensitive: isPressed(caseButton),
      wholeWord: effectiveWholeWord,
      regex: effectiveRegex,
      decorations: dark
        ? {
            matchBackground: "#613214",
            matchBorder: "#9e6a03",
            matchOverviewRuler: "#d18616",
            activeMatchBackground: "#ea5c00",
            activeMatchBorder: "#f5a623",
            activeMatchColorOverviewRuler: "#ea5c00",
          }
        : {
            matchBackground: "#f5d79c",
            matchBorder: "#c27d16",
            matchOverviewRuler: "#c27d16",
            activeMatchBackground: "#ea7c2c",
            activeMatchBorder: "#a84a00",
            activeMatchColorOverviewRuler: "#ea5c00",
          },
    };
  }

  function find(backward = false, incremental = false) {
    clearTimeout(timer);
    if (panel.hidden || !active || active !== getActiveTab()) return;
    const query = input.value;
    if (!query) {
      setError("");
      addon.clearDecorations();
      results();
      return;
    }
    const regexEnabled = isPressed(regexButton);
    const wholeWordEnabled = isPressed(wordButton);
    const validation = validateSearchRegex(query, { regex: regexEnabled });
    if (!validation.valid) {
      addon.clearDecorations();
      setError("正则表达式无效：" + validation.error);
      results({ resultIndex: -1, resultCount: 0 });
      return;
    }
    setError("");
    if (!incremental) rememberQuery(query);
    const effective = buildEffectiveSearch(query, { wholeWord: wholeWordEnabled, regex: regexEnabled });
    addon[backward ? "findPrevious" : "findNext"](
      effective.term,
      options(incremental, { effectiveRegex: effective.regex, effectiveWholeWord: effective.wholeWord }),
    );
  }

  function release() {
    clearTimeout(timer);
    listener?.dispose();
    addon?.dispose();
    listener = addon = active = null;
  }

  function bind() {
    if (!enabled) return;
    const tab = getActiveTab();
    toggle.disabled = !tab || tab.moving;
    if (panel.hidden || active === tab) return;
    release();
    setError("");
    results();
    if (!tab) {
      close(false);
      return;
    }
    active = tab;
    addon = new SearchAddon({ highlightLimit: 1000 });
    tab.term.loadAddon(addon);
    listener = addon.onDidChangeResults(results);
    find(false, true);
  }

  function open({ focusSelect = true } = {}) {
    if (!enabled) return;
    showTerminal();
    const tab = getActiveTab();
    if (!tab || tab.moving) return;
    const selection = tab.term.getSelection();
    if (selection && !/[\r\n]/.test(selection) && selection.length <= 1000) {
      input.value = selection;
    }
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    bind();
    if (focusSelect) {
      input.focus();
      input.select();
    }
  }

  function close(focus = true) {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    setError("");
    release();
    results();
    if (focus) getActiveTab()?.term.focus();
  }

  function toggleFlag(button) {
    if (!button) return;
    button.setAttribute("aria-pressed", String(!isPressed(button)));
    // Rebuild cached matches whenever search flags change.
    addon?.clearDecorations();
    find(false, true);
  }

  toggle.onclick = () => {
    if (!enabled) return;
    if (!panel.hidden) {
      close();
      return;
    }
    open();
  };
  panel.onsubmit = (event) => {
    event.preventDefault();
    find(false, false);
  };
  input.oninput = () => {
    historyIndex = -1;
    clearTimeout(timer);
    timer = setTimeout(() => find(false, true), 60);
  };
  panel.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" || event.key === "F3") {
      event.preventDefault();
      find(event.shiftKey, false);
    } else if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const k = typeof event.key === "string" ? event.key.toLowerCase() : "";
      if (k === "c" || event.code === "KeyC") {
        event.preventDefault();
        toggleFlag(caseButton);
      } else if (k === "w" || event.code === "KeyW") {
        event.preventDefault();
        toggleFlag(wordButton);
      } else if (k === "r" || event.code === "KeyR") {
        event.preventDefault();
        toggleFlag(regexButton);
      } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && queryHistory.length) {
        event.preventDefault();
        if (event.key === "ArrowUp") {
          historyIndex = Math.min(queryHistory.length - 1, historyIndex + 1);
        } else {
          historyIndex = Math.max(-1, historyIndex - 1);
        }
        input.value = historyIndex >= 0 ? queryHistory[historyIndex] : "";
        input.select();
        find(false, true);
      }
    }
  };
  previous.onclick = () => find(true, false);
  next.onclick = () => find(false, false);
  $("#terminal-search-close").onclick = () => close();
  caseButton.onclick = () => toggleFlag(caseButton);
  wordButton.onclick = () => toggleFlag(wordButton);
  regexButton.onclick = () => toggleFlag(regexButton);
  results();

  return {
    open,
    activate: bind,
    close,
    isOpen: () => !panel.hidden,
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      toggle.hidden = !enabled;
      if (enabled) bind();
      else {
        toggle.disabled = true;
        input.value = "";
        close(panel.contains(document.activeElement));
      }
    },
    refreshTheme() {
      if (addon) {
        addon.clearDecorations();
        find(false, true);
      }
    },
    remove(tab) {
      if (active === tab) release();
    },
  };
}
