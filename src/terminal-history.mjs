const PROMPT_PREFIX_RE =
  /^(?:(?:\([^)\r\n]{1,40}\)\s+)*)?(?:(?:\[[^\]\r\n]{1,120}\]\s*[$#%❯➜]\s+)|(?:[^\s\r\n$#%]{1,64}@[^\s\r\n$#%]{1,120}(?:[:\s][^\r\n$#%]{0,160})?\s*[$#%❯➜]\s+)|(?:PS\s+[A-Za-z]:[^\r\n>]{0,200}>\s+)|(?:(?:~|\/[^\r\n$#%]{0,160})\s+[$#%❯➜]\s+)|(?:[$#%❯➜]\s+))/;

export function extractCommandFromTerminalLine(lineText) {
  if (typeof lineText !== "string" || !lineText.trim()) return null;
  const match = PROMPT_PREFIX_RE.exec(lineText);
  if (!match) return null;
  const candidate = lineText.slice(match[0].length).trimEnd();
  return candidate.length >= 2 ? candidate : null;
}

export function isCommandHistoryShortcut(event, { isMac = false } = {}) {
  if (!event || event.type !== "keydown") return false;
  if (event.isComposing || event.keyCode === 229) return false;
  const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || !event.shiftKey || event.altKey) return false;
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  return event.code === "KeyH" || key === "h";
}

export function createTerminalLineTracker() {
  let buffer = "";
  let dirty = false;

  function reset() {
    buffer = "";
    dirty = false;
  }

  function feed(data, { isNormalBuffer = true, isPasswordPrompt = false, readCurrentLine } = {}) {
    if (!isNormalBuffer || isPasswordPrompt || typeof data !== "string" || !data) {
      if (!isNormalBuffer || isPasswordPrompt) reset();
      return [];
    }
    // Strip bracketed paste wrappers so pasted commands stay intact.
    const clean = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
    const captured = [];
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      const code = clean.charCodeAt(i);
      if (ch === "\x1b") {
        // Any escape sequence (arrows, Home/End, Alt+B/F, etc.) means shell line editing diverged.
        dirty = true;
        // Consume CSI or SS3 sequence body so trailing letters aren't treated as typed chars.
        if (clean[i + 1] === "[") {
          i += 2;
          while (i < clean.length && !(clean.charCodeAt(i) >= 0x40 && clean.charCodeAt(i) <= 0x7e)) i++;
        } else if (clean[i + 1] === "O") {
          i += 2;
        }
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        // Handle \r\n as a single Enter.
        if (ch === "\r" && clean[i + 1] === "\n") i++;
        let command = "";
        if (!dirty && buffer) {
          command = buffer;
        } else if (typeof readCurrentLine === "function") {
          const extracted = extractCommandFromTerminalLine(readCurrentLine());
          if (extracted) command = extracted;
        }
        if (command) captured.push(command);
        reset();
        continue;
      }
      if (code === 0x03 || code === 0x04 || code === 0x15) {
        // Ctrl+C, Ctrl+D, Ctrl+U cancel or clear the line.
        reset();
        continue;
      }
      if (ch === "\t" || code === 0x01 || code === 0x05 || code === 0x0b || code === 0x12 || code === 0x17) {
        // Tab completion or readline cursor/history editing (Ctrl+A/E/K/R/W).
        dirty = true;
        continue;
      }
      if (code === 0x7f || code === 0x08) {
        if (dirty) continue;
        // Remove last Unicode code point.
        const chars = Array.from(buffer);
        chars.pop();
        buffer = chars.join("");
        continue;
      }
      if (code < 0x20) {
        dirty = true;
        continue;
      }
      if (!dirty) buffer += ch;
    }
    return captured;
  }

  return { feed, reset };
}

export function filterHistoryEntries(
  entries,
  { scope = "session", scopeKey = "", hostKey = "", query = "" } = {},
) {
  if (!Array.isArray(entries)) return [];
  const tokens = String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const scoped = entries.filter((entry) => {
    if (!entry || typeof entry.command !== "string") return false;
    if (scope === "pinned") return Boolean(entry.pinned);
    if (scope === "session") {
      if (scopeKey && entry.scopeKey === scopeKey) return true;
      if (hostKey && entry.hostKey === hostKey) return true;
      return false;
    }
    return true;
  });

  // Deduplicate identical commands across sessions when viewing session+host or all.
  const deduped = [];
  const byCommand = new Map();
  for (const entry of scoped) {
    const existingIndex = byCommand.get(entry.command);
    if (existingIndex === undefined) {
      byCommand.set(entry.command, deduped.length);
      deduped.push({ ...entry });
    } else {
      const existing = deduped[existingIndex];
      const preferNew =
        (scope === "session" && entry.scopeKey === scopeKey && existing.scopeKey !== scopeKey) ||
        entry.lastUsedAt > existing.lastUsedAt;
      if (preferNew) {
        deduped[existingIndex] = {
          ...entry,
          pinned: entry.pinned || existing.pinned,
          useCount: existing.useCount + entry.useCount,
          note: entry.note || existing.note,
        };
      } else {
        existing.pinned = existing.pinned || entry.pinned;
        existing.useCount += entry.useCount;
        if (!existing.note && entry.note) existing.note = entry.note;
      }
    }
  }

  const matched = tokens.length
    ? deduped.filter((entry) => {
        const haystack = `${entry.command}\n${entry.note || ""}\n${entry.sessionName || ""}`.toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      })
    : deduped;

  return matched.sort((a, b) => {
    if (scope === "pinned") {
      if (b.useCount !== a.useCount) return b.useCount - a.useCount;
      return b.lastUsedAt - a.lastUsedAt;
    }
    return b.lastUsedAt - a.lastUsedAt;
  });
}

export function formatRelativeTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const diff = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
