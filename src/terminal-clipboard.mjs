/**
 * Resolve VS Code-style clipboard shortcut actions for a terminal key event.
 * Returns "copy", "paste", "noop" (swallow key without PTY input), or null
 * when xterm should handle the key normally.
 */
export function resolveTerminalClipboardShortcut(
  event,
  { hasSelection = false, isMac = false } = {},
) {
  if (!event || event.type !== "keydown" || event.isComposing || event.keyCode === 229) {
    return null;
  }
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  const isC = event.code === "KeyC" || key === "c";
  const isV = event.code === "KeyV" || key === "v";
  if (!isC && !isV) return null;

  if (isMac) {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
    if (isC) return hasSelection ? "copy" : "noop";
    return "paste";
  }

  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  if (!event.shiftKey) {
    if (isC) return hasSelection ? "copy" : null;
    return "paste";
  }
  // Ctrl+Shift+C / Ctrl+Shift+V (Windows/Linux terminal convention)
  if (isC) return hasSelection ? "copy" : "noop";
  return "paste";
}
