// Syslog severity names (RFC 5424 §6.2.1) plus common build/test outcomes.
export const keywordGroups = {
  success: ["success", "successful", "successfully", "succeeded", "pass", "passed", "ok", "done", "ready", "completed"],
  danger: ["fail", "failed", "failure", "error", "errors", "err", "fatal", "critical", "crit", "panic", "alert", "emergency", "emerg", "exception", "traceback", "aborted", "denied"],
  warning: ["warn", "warning", "warnings", "caution", "timeout", "timedout", "retry", "retrying", "deprecated", "skipped"],
  info: ["info", "notice", "debug", "trace"],
};
const kinds = new Map(Object.entries(keywordGroups).flatMap(([kind, words]) => words.map(word => [word, kind])));
for (const [word, kind] of [["成功", "success"], ["失败", "danger"], ["错误", "danger"], ["警告", "warning"], ["超时", "warning"]]) kinds.set(word, kind);
const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${Object.values(keywordGroups).flat().join("|")})(?![\\p{L}\\p{N}_])|成功|失败|错误|警告|超时`, "giu");

export function keywordMatches(text) {
  return Array.from(text.matchAll(pattern), match => ({
    start: match.index, end: match.index + match[0].length, kind: kinds.get(match[0].toLowerCase()),
  }));
}

// Use cells, rather than JS string offsets, so CJK, emoji and combining marks
// before a keyword do not shift its decoration. Join only soft-wrapped rows.
export function visibleKeywordSpans(buffer, cols, rows) {
  const first = buffer.viewportY, last = Math.min(buffer.length, first + rows);
  const spans = new Map();
  let text = "", cells = [];
  function flush() {
    let cursor = 0;
    for (const match of keywordMatches(text)) {
      while (cursor < cells.length && cells[cursor].end <= match.start) cursor++;
      let segment;
      for (let i = cursor; i < cells.length && cells[i].start < match.end; i++) {
        const cell = cells[i];
        if (cell.row < first || cell.row >= last) continue;
        if (segment?.row === cell.row) segment.width = cell.x + cell.width - segment.x;
        else {
          segment = { row: cell.row, x: cell.x, width: cell.width, kind: match.kind };
          if (!spans.has(cell.row)) spans.set(cell.row, []);
          spans.get(cell.row).push(segment);
        }
      }
    }
    text = "";
    cells = [];
  }
  // A small amount of context also covers keywords split at the viewport edge.
  const context = Math.ceil(16 / cols) + 1;
  for (let row = Math.max(0, first - context); row < Math.min(buffer.length, last + context); row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    if (!line.isWrapped) flush();
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      const width = cell?.getWidth();
      if (!width) continue;
      const chars = cell.getChars() || " ";
      cells.push({ row, x, width, start: text.length, end: text.length + chars.length });
      text += chars;
    }
  }
  flush();
  return spans;
}

function spanSignature(segments) {
  if (!segments?.length) return "";
  let out = "";
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (i) out += ",";
    out += s.x + ":" + s.width + ":" + s.kind;
  }
  return out;
}

export function installKeywordHighlights(term, theme) {
  let frame = null, throttleTimer = null, lastRefresh = 0, disposed = false;
  const rendered = new Map();
  const remove = entry => {
    entry.decorations.forEach(decoration => decoration.dispose());
    entry.marker.dispose();
  };
  function clear() {
    for (const entry of rendered.values()) remove(entry);
    rendered.clear();
  }
  function refresh() {
    frame = null;
    if (disposed) return;
    lastRefresh = performance.now();
    const buffer = term.buffer.active;
    if (buffer.type !== "normal" || !term.element.checkVisibility({ visibilityProperty: true })) { clear(); return; }
    const colors = { ...theme.variables, info: theme.accent };
    const spans = visibleKeywordSpans(buffer, term.cols, term.rows);
    for (const [row, entry] of rendered) {
      const signature = spanSignature(spans.get(row));
      if (entry.marker.isDisposed || entry.marker.line !== row || entry.signature !== signature) {
        remove(entry);
        rendered.delete(row);
      }
    }
    for (const [row, segments] of spans) {
      if (rendered.has(row)) continue;
      const marker = term.registerMarker(row - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
      const decorations = [];
      for (const { x, width, kind } of segments) {
        const decoration = term.registerDecoration({ marker, x, width, foregroundColor: colors[kind], layer: "bottom" });
        if (!decoration) continue;
        decoration.onRender(element => {
          element.classList.add("terminal-keyword");
          element.dataset.keywordKind = kind;
        });
        decorations.push(decoration);
      }
      rendered.set(row, { marker, decorations, signature: spanSignature(segments) });
    }
  }
  function scheduleNow() {
    if (disposed || frame != null) return;
    if (throttleTimer != null) { clearTimeout(throttleTimer); throttleTimer = null; }
    frame = requestAnimationFrame(refresh);
  }
  function scheduleOutput() {
    if (disposed || frame != null || throttleTimer != null) return;
    const elapsed = performance.now() - lastRefresh;
    if (elapsed >= 60) {
      frame = requestAnimationFrame(refresh);
    } else {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (!disposed && frame == null) frame = requestAnimationFrame(refresh);
      }, 100 - Math.min(elapsed, 60));
    }
  }
  const listeners = [
    term.onWriteParsed(scheduleOutput),
    term.onScroll(scheduleNow),
    term.onResize(scheduleNow),
    term.buffer.onBufferChange(() => { clear(); scheduleNow(); }),
  ];
  scheduleNow();
  return {
    refresh: scheduleNow,
    setTheme(value) { theme = value; clear(); scheduleNow(); },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      if (throttleTimer != null) clearTimeout(throttleTimer);
      listeners.forEach(listener => listener.dispose());
      clear();
    },
  };
}
