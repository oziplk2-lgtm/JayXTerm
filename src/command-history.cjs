const { randomUUID } = require("node:crypto");
const { openStore } = require("./store.cjs");

const MAX_COMMAND_LENGTH = 4000;
const MAX_PER_SCOPE = 500;
const MAX_TOTAL = 2000;

const SECRET_ASSIGNMENT_RE =
  /(?:^|[\s;&|])(?:export\s+)?[A-Za-z0-9_]*(?:PASS(?:WORD|WD|PHRASE)?|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH(?:ORIZATION)?)\s*=\s*\S+/i;
const SECRET_FLAG_RE =
  /(?:--?(?:pass(?:word|wd|phrase)?|token|secret|api-?key)\s*(?:=|\s+)\S+|(?:^|[\s;&|])mysql\b[^\r\n]*\s-p\S+|(?:^|[\s;&|])sshpass\s+-p\s*\S+|(?:^|[\s;&|])curl\b[^\r\n]*(?:\s(?:-u|--user)\s+\S+:\S+|\s(?:-H|--header)\s+['"]?Authorization\s*:))/i;

function shouldRecordCommand(raw) {
  if (typeof raw !== "string") return false;
  // Leading whitespace follows Linux HISTCONTROL=ignorespace convention.
  if (!raw || /^\s/.test(raw)) return false;
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(raw)) return false;
  const trimmed = raw.trimEnd();
  if (trimmed.length < 2 || trimmed.length > MAX_COMMAND_LENGTH) return false;
  if (SECRET_ASSIGNMENT_RE.test(trimmed) || SECRET_FLAG_RE.test(trimmed)) return false;
  return true;
}

function normalizeEntry(item) {
  if (!item || typeof item !== "object" || typeof item.command !== "string") return null;
  const command = item.command.trimEnd();
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;
  return {
    id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
    command,
    scopeKey: typeof item.scopeKey === "string" ? item.scopeKey.slice(0, 160) : "",
    hostKey: typeof item.hostKey === "string" ? item.hostKey.slice(0, 160) : "",
    sessionName: typeof item.sessionName === "string" ? item.sessionName.slice(0, 120) : "",
    lastUsedAt: Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : 0,
    useCount: Number.isInteger(item.useCount) && item.useCount > 0 ? item.useCount : 1,
    pinned: Boolean(item.pinned),
    note: typeof item.note === "string" ? item.note.trim().slice(0, 80) : "",
  };
}

function enforceLimits(entries) {
  const sorted = [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const perScopeCount = new Map();
  const kept = [];
  for (const entry of sorted) {
    if (entry.pinned) {
      kept.push(entry);
      continue;
    }
    const key = entry.scopeKey || "";
    const count = perScopeCount.get(key) || 0;
    if (count >= MAX_PER_SCOPE) continue;
    perScopeCount.set(key, count + 1);
    kept.push(entry);
  }
  if (kept.length <= MAX_TOTAL) return kept;
  const pinned = kept.filter((e) => e.pinned);
  const unpinned = kept.filter((e) => !e.pinned);
  const remainingSlots = Math.max(0, MAX_TOTAL - pinned.length);
  return [...pinned, ...unpinned.slice(0, remainingSlots)].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

function openCommandHistory(file) {
  const store = openStore(file, { version: 1, entries: [] });
  function readEntries() {
    const data = store.get();
    if (!Array.isArray(data?.entries)) return [];
    return data.entries.map(normalizeEntry).filter(Boolean);
  }
  function saveEntries(entries) {
    const next = enforceLimits(entries);
    store.write({ version: 1, entries: next });
    return next;
  }
  return {
    list() {
      return readEntries().map((item) => ({ ...item }));
    },
    record({ command, scopeKey = "", hostKey = "", sessionName = "" } = {}) {
      if (!shouldRecordCommand(command)) return null;
      const normalized = command.trimEnd();
      const scope = String(scopeKey || "").slice(0, 160);
      const host = String(hostKey || "").slice(0, 160);
      const name = String(sessionName || "").slice(0, 120);
      const now = Date.now();
      const entries = readEntries();
      const existingIndex = entries.findIndex((item) => item.scopeKey === scope && item.command === normalized);
      let updated;
      if (existingIndex >= 0) {
        const prev = entries[existingIndex];
        updated = {
          ...prev,
          hostKey: host || prev.hostKey,
          sessionName: name || prev.sessionName,
          lastUsedAt: now,
          useCount: prev.useCount + 1,
        };
        entries.splice(existingIndex, 1);
      } else {
        updated = {
          id: randomUUID(),
          command: normalized,
          scopeKey: scope,
          hostKey: host,
          sessionName: name,
          lastUsedAt: now,
          useCount: 1,
          pinned: false,
          note: "",
        };
      }
      saveEntries([updated, ...entries]);
      return { ...updated };
    },
    togglePin(id) {
      const entries = readEntries();
      const target = entries.find((item) => item.id === id);
      if (!target) return null;
      target.pinned = !target.pinned;
      saveEntries(entries);
      return { ...target };
    },
    updateNote(id, note) {
      const entries = readEntries();
      const target = entries.find((item) => item.id === id);
      if (!target) return null;
      target.note = String(note || "").trim().slice(0, 80);
      saveEntries(entries);
      return { ...target };
    },
    remove(id) {
      const entries = readEntries();
      const next = entries.filter((item) => item.id !== id);
      if (next.length === entries.length) return { removed: false };
      saveEntries(next);
      return { removed: true };
    },
    clear({ scopeKey, keepPinned = false } = {}) {
      const entries = readEntries();
      const next = entries.filter((item) => {
        if (keepPinned && item.pinned) return true;
        if (scopeKey && item.scopeKey !== scopeKey) return true;
        return false;
      });
      const removed = entries.length - next.length;
      if (removed > 0) saveEntries(next);
      return { removed };
    },
  };
}

module.exports = {
  openCommandHistory,
  shouldRecordCommand,
  MAX_COMMAND_LENGTH,
  MAX_PER_SCOPE,
  MAX_TOTAL,
};
