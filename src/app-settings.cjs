const fs = require("node:fs");
const path = require("node:path");
const { createHmac, randomBytes, randomUUID } = require("node:crypto");
const { openStore } = require("./store.cjs");
const { terminalDefaults, terminalEncodings, validFontFamily, validCjkFontFamily, validFontSize } = require("./terminal-settings.mjs");

const cacheFolders = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "ShaderCache"];
const defaultBackground = "#181818";
const validBackground = (color) => typeof color === "string" && /^#[\da-f]{6}$/i.test(color);
const defaults = {
  ...terminalDefaults,
  cachePath: "", pendingCache: null, cacheError: "",
  saveHistory: false, passwordHistory: [], fileOpen: "single", workspaceBackground: null,
};

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}
function prepareCache(destination, source) {
  fs.mkdirSync(destination, { recursive: true });
  if (!fs.lstatSync(destination).isDirectory())
    throw new Error("缓存目标必须是普通文件夹");
  fs.accessSync(destination, fs.constants.W_OK);
  if (!source || !fs.existsSync(source)) return;
  const origin = fs.realpathSync(source);
  const target = fs.realpathSync(destination);
  if (origin === target) return;
  const directories = cacheFolders
    .filter((name) => fs.existsSync(path.join(origin, name)))
    .filter((name) => fs.lstatSync(path.join(origin, name)).isDirectory());
  for (const name of directories) {
    if (contains(path.join(origin, name), target) || contains(path.join(target, name), origin))
      throw new Error("缓存目录不能互相包含");
  }
  if (!directories.length) return;
  const staging = fs.mkdtempSync(path.join(target, ".jayxterm-migrate-"));
  const incoming = path.join(staging, "incoming");
  const backup = path.join(staging, "backup");
  const replaced = [];
  const installed = [];
  let keepBackup = false;
  try {
    fs.mkdirSync(incoming);
    fs.mkdirSync(backup);
    for (const name of directories) {
      fs.cpSync(path.join(origin, name), path.join(incoming, name), {
        recursive: true,
        filter(from) {
          const stat = fs.lstatSync(from);
          return stat.isDirectory() || stat.isFile();
        },
      });
    }
    // Preserve each index and its data files as a unit across cache locations.
    for (const name of directories) {
      const to = path.join(target, name);
      const existing = fs.lstatSync(to, { throwIfNoEntry: false });
      if (existing) {
        if (!existing.isDirectory()) throw new Error("目标缓存中存在同名文件或链接");
        fs.renameSync(to, path.join(backup, name));
        replaced.push(name);
      }
      fs.renameSync(path.join(incoming, name), to);
      installed.push(name);
    }
  } catch (error) {
    try {
      for (const name of installed) fs.rmSync(path.join(target, name), { recursive: true });
      for (const name of replaced) fs.renameSync(path.join(backup, name), path.join(target, name));
    } catch {
      keepBackup = true;
    }
    throw error;
  } finally {
    if (!keepBackup) fs.rmSync(staging, { recursive: true, force: true });
  }
}
function readLocalState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : null;
  } catch (error) {
    return error.code === "ENOENT" ? {} : null;
  }
}
function restoreLegacyWindowsKey(defaultCache, legacyCache) {
  const defaultFile = path.join(defaultCache, "Local State");
  const state = readLocalState(defaultFile);
  if (!state || Object.hasOwn(state.os_crypt ?? {}, "encrypted_key")) return;
  const encryptedKey = readLocalState(path.join(legacyCache, "Local State"))?.os_crypt?.encrypted_key;
  // Chromium stores the AES key in a DPAPI envelope. Preserve it as-is.
  if (typeof encryptedKey !== "string") return;
  const envelope = Buffer.from(encryptedKey, "base64");
  if (envelope.length <= 5 || envelope.toString("ascii", 0, 5) !== "DPAPI") return;
  fs.mkdirSync(defaultCache, { recursive: true });
  const staging = path.join(defaultCache, ".jayxterm-local-state-" + randomUUID());
  try {
    fs.writeFileSync(staging, JSON.stringify({
      ...state, os_crypt: { ...state.os_crypt, encrypted_key: encryptedKey },
    }), { mode: 0o600, flag: "wx" });
    fs.renameSync(staging, defaultFile);
  } finally {
    fs.rmSync(staging, { force: true });
  }
}
function mask(secret) {
  const chars = Array.from(secret);
  if (chars.length <= 6) return "*".repeat(Math.max(3, chars.length));
  return chars.slice(0, 2).join("") + "*".repeat(Math.min(chars.length - 4, 12)) + chars.slice(-2).join("");
}

const terminalToggles = ["highlightKeywords", "terminalSearchEnabled", "commandHistoryEnabled", "quickPasswordsEnabled", "predictiveEcho"];

function openAppSettings(file, defaultCache, safeStorage) {
  const store = openStore(file, defaults);
  const key = randomBytes(32);
  let index;
  const fingerprint = (secret) => createHmac("sha256", key).update(secret).digest("hex");
  const decrypt = ({ encrypted }) => safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  function settings() {
    const { backgroundColor: previousBackground, ...saved } = store.get();
    const data = { ...defaults, ...saved };
    if (!validFontFamily(data.fontFamily)) data.fontFamily = terminalDefaults.fontFamily;
    if (!validCjkFontFamily(data.cjkFontFamily)) data.cjkFontFamily = terminalDefaults.cjkFontFamily;
    if (!validFontSize(data.fontSize)) data.fontSize = terminalDefaults.fontSize;
    if (!terminalEncodings.includes(data.defaultEncoding)) data.defaultEncoding = terminalDefaults.defaultEncoding;
    for (const name of terminalToggles)
      if (typeof data[name] !== "boolean") data[name] = terminalDefaults[name];
    // Earlier releases persisted the default whenever any setting was saved.
    if (!Object.hasOwn(saved, "workspaceBackground") && validBackground(previousBackground) &&
        previousBackground.toLowerCase() !== "#eff1f5")
      data.workspaceBackground = previousBackground;
    return data;
  }
  const resolveCache = (directory) => directory || defaultCache;
  function available() {
    return safeStorage.isEncryptionAvailable() &&
      !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
  }
  function historyIndex(data) {
    if (index) return index;
    index = { keys: new Set(), labels: [] };
    for (const item of data.passwordHistory) {
      try {
        const secret = decrypt(item);
        index.keys.add(fingerprint(secret));
        index.labels.push({ id: item.id, label: mask(secret) });
      } catch {
        // Credentials from a different OS account are unavailable on this one.
      }
    }
    return index;
  }
  return {
    initializeCache({ restoreWindowsKey = false } = {}) {
      const data = settings();
      if (restoreWindowsKey && data.cachePath) {
        try {
          restoreLegacyWindowsKey(defaultCache, data.cachePath);
        } catch {
          console.error("JayXTerm could not restore the Windows encryption key from the old cache directory.");
        }
      }
      if (data.pendingCache) {
        const { path: next, migrate } = data.pendingCache;
        try {
          prepareCache(resolveCache(next), migrate ? resolveCache(data.cachePath) : null);
          data.cachePath = next;
          data.cacheError = "";
        } catch {
          data.cacheError = "缓存切换失败，已继续使用原位置。请确认目标目录存在且可写。";
        }
        data.pendingCache = null;
        store.write(data);
      }
      if (data.cachePath) {
        try {
          prepareCache(resolveCache(data.cachePath));
        } catch {
          data.cachePath = "";
          data.cacheError = "自定义缓存目录不可用，已切换回默认位置。";
          store.write(data);
        }
      }
      if (!data.cachePath) fs.mkdirSync(defaultCache, { recursive: true });
      return resolveCache(data.cachePath);
    },
    describe() {
      const { cachePath, pendingCache, cacheError, saveHistory, fileOpen, workspaceBackground,
        fontFamily, cjkFontFamily, fontSize, defaultEncoding, highlightKeywords, terminalSearchEnabled, commandHistoryEnabled, quickPasswordsEnabled,
        predictiveEcho } = settings();
      return {
        cachePath, pendingCache: pendingCache?.path ?? null, cacheError, saveHistory, fileOpen, defaultCache,
        backgroundColor: validBackground(workspaceBackground) ? workspaceBackground : defaultBackground,
        defaultBackground,
        fontFamily, cjkFontFamily, fontSize, defaultEncoding, highlightKeywords, terminalSearchEnabled, commandHistoryEnabled, quickPasswordsEnabled,
        predictiveEcho,
      };
    },
    apply({ cachePath, migrate, saveHistory, fileOpen, backgroundColor, fontFamily, cjkFontFamily, fontSize, defaultEncoding, ...toggles }) {
      if ((fontFamily !== undefined && !validFontFamily(fontFamily)) ||
          (cjkFontFamily !== undefined && !validCjkFontFamily(cjkFontFamily)) ||
          (fontSize !== undefined && !validFontSize(fontSize)) ||
          (defaultEncoding !== undefined && !terminalEncodings.includes(defaultEncoding)))
        throw new Error("无效的终端设置：字号范围为 8–48，编码为 UTF-8、GBK 或 GB2312");
      const data = settings();
      for (const name of terminalToggles) {
        if (toggles[name] === undefined) continue;
        if (typeof toggles[name] !== "boolean") throw new Error("无效的终端功能开关");
        data[name] = toggles[name];
      }
      if (saveHistory && !data.saveHistory && !available())
        throw new Error("系统安全存储不可用，无法启用密码历史");
      const previous = data.pendingCache?.path ?? data.cachePath;
      if (cachePath !== previous) {
        if (cachePath !== data.cachePath)
          prepareCache(resolveCache(cachePath));
        data.pendingCache = cachePath === data.cachePath ? null : { path: cachePath, migrate };
        data.cacheError = "";
      }
      data.saveHistory = saveHistory;
      if (!saveHistory) data.passwordHistory = [];
      data.fileOpen = fileOpen;
      if (fontFamily !== undefined) data.fontFamily = fontFamily.trim();
      if (cjkFontFamily !== undefined) data.cjkFontFamily = cjkFontFamily.trim();
      if (fontSize !== undefined) data.fontSize = fontSize;
      if (defaultEncoding !== undefined) data.defaultEncoding = defaultEncoding;
      if (validBackground(backgroundColor))
        data.workspaceBackground = backgroundColor.toLowerCase() === defaultBackground ? null : backgroundColor;
      store.write(data);
      if (!saveHistory) index = undefined;
      return this.describe();
    },
    listHistory() {
      const data = settings();
      return {
        enabled: data.saveHistory,
        items: data.saveHistory && available() ? historyIndex(data).labels : [],
      };
    },
    selectPassword(id) {
      const data = settings();
      if (!data.saveHistory || !available()) return "";
      const item = data.passwordHistory.find((entry) => entry.id === id);
      return item ? decrypt(item) : "";
    },
    record(secret) {
      const data = settings();
      if (!data.saveHistory || typeof secret !== "string" || !secret || !available()) return;
      const cached = historyIndex(data);
      const hash = fingerprint(secret);
      if (cached.keys.has(hash)) return;
      const item = { id: randomUUID(), encrypted: safeStorage.encryptString(secret).toString("base64") };
      store.write({ ...data, passwordHistory: [item, ...data.passwordHistory] });
      cached.keys.add(hash);
      cached.labels.unshift({ id: item.id, label: mask(secret) });
    },
  };
}

module.exports = { openAppSettings, validBackground };
