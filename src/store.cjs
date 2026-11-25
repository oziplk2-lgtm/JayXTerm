const fs = require("node:fs");
const path = require("node:path");
const { normalizeEncoding } = require("./codec.cjs");
const { randomUUID } = require("node:crypto");
const { isIPv6 } = require("node:net");
function validateSession(s) {
  const authType = s.authType === "key" ? "key" : "password";
  const privateKeyPath = authType === "key" ? String(s.privateKeyPath || "").trim().slice(0, 1024) : "";
  const jumpSessionId = String(s.jumpSessionId || "").trim().slice(0, 128);
  const result = {
    id: s.id || randomUUID(),
    name: String(s.name || "").trim(),
    host: String(s.host || "").trim(),
    port: Number(s.port ?? 22),
    username: String(s.username || "").trim(),
    group: String(s.group || "").trim(),
    encoding: normalizeEncoding(s.encoding),
    authType,
    privateKeyPath,
    jumpSessionId,
  };
  if (
    !result.host ||
    !result.username ||
    !Number.isInteger(result.port) ||
    result.port < 1 ||
    result.port > 65535
  )
    throw new Error("请填写主机、用户名和有效端口");
  if (result.authType === "key" && !result.privateKeyPath)
    throw new Error("请选择 SSH 私钥文件");
  if (result.jumpSessionId && result.jumpSessionId === result.id)
    throw new Error("不能将当前会话设为自己的跳板机");
  if (!result.name) {
    const host = isIPv6(result.host) ? `[${result.host}]` : result.host;
    result.name = `${host}:${result.port} · ${result.username}`;
  }
  return result;
}
function openStore(file, defaults = { sessions: [], hosts: {} }) {
  let data = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : defaults;
  return {
    get: () => data,
    write(next) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".new", JSON.stringify(next, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(file + ".new", file);
      data = next;
    },
  };
}
module.exports = { validateSession, openStore };
