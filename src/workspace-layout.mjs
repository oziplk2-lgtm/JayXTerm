export const DEFAULT_SIDEBAR_WIDTH = 248;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 480;
export const MIN_MAIN_WIDTH = 320;
export const SIDEBAR_COLLAPSE_THRESHOLD = 110;

export function clampSidebarWidth(width, viewportWidth = 1280) {
  const maxByViewport = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? Math.max(MIN_SIDEBAR_WIDTH, viewportWidth - MIN_MAIN_WIDTH)
    : MAX_SIDEBAR_WIDTH;
  const upper = Math.min(MAX_SIDEBAR_WIDTH, maxByViewport);
  const numeric = Number(width);
  if (!Number.isFinite(numeric)) return Math.min(DEFAULT_SIDEBAR_WIDTH, upper);
  return Math.round(Math.min(upper, Math.max(MIN_SIDEBAR_WIDTH, numeric)));
}

export function shouldSnapCollapseSidebar(pointerWidth) {
  return Number.isFinite(pointerWidth) && pointerWidth < SIDEBAR_COLLAPSE_THRESHOLD;
}

export function validateSearchRegex(pattern, { regex = false } = {}) {
  if (!regex || !pattern) return { valid: true, error: "" };
  try {
    new RegExp(pattern);
    return { valid: true, error: "" };
  } catch (err) {
    const message = String(err?.message || "无效的正则表达式")
      .replace(/^Invalid regular expression:\s*/i, "");
    return { valid: false, error: message };
  }
}

export function escapeRegexLiteral(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// @xterm/addon-search stops scanning a line on its first non-whole-word hit when
// wholeWord is used without regex; compiling wholeWord to a lookaround regex
// fixes multi-occurrence lines (e.g. "install ll" searching "ll").
export function buildEffectiveSearch(query, { wholeWord = false, regex = false } = {}) {
  if (!wholeWord || !query) {
    return { term: query, regex: Boolean(regex), wholeWord: false };
  }
  const body = regex ? `(?:${query})` : escapeRegexLiteral(query);
  return {
    term: `(?<![A-Za-z0-9_])(?:${body})(?![A-Za-z0-9_])`,
    regex: true,
    wholeWord: false,
  };
}

export function isSidebarToggleShortcut(event, { isMac = false } = {}) {
  if (!event || event.type !== "keydown") return false;
  if (event.isComposing || event.keyCode === 229) return false;
  const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.shiftKey || event.altKey) return false;
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  return event.code === "KeyB" || key === "b";
}

export function isTerminalSearchShortcut(event, { isMac = false } = {}) {
  if (!event || event.type !== "keydown") return false;
  if (event.isComposing || event.keyCode === 229) return false;
  const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.shiftKey || event.altKey) return false;
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  return event.code === "KeyF" || key === "f";
}
