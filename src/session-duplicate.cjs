/**
 * Clone a saved session record with a unique copy name while preserving
 * credentials and connection settings.
 */
function buildDuplicatedSession(source, existingSessions = [], newId) {
  if (!source || typeof source !== "object") {
    throw new Error("原会话不存在");
  }
  const base = String(source.name || "")
    .replace(/\s+-\s+副本(?:\s+\d+)?$/, "")
    .trim() || "会话";
  const taken = new Set(existingSessions.map((item) => item.name));
  let suffix = " - 副本";
  let name = base.slice(0, Math.max(1, 100 - suffix.length)) + suffix;
  if (taken.has(name)) {
    let index = 2;
    do {
      suffix = ` - 副本 ${index++}`;
      name = base.slice(0, Math.max(1, 100 - suffix.length)) + suffix;
    } while (taken.has(name));
  }
  const copy = {
    id: newId,
    name,
    host: source.host,
    port: source.port,
    username: source.username,
    group: source.group || "",
    encoding: source.encoding || "utf-8",
    authType: source.authType === "key" ? "key" : "password",
    privateKeyPath: source.authType === "key" ? source.privateKeyPath || "" : "",
    jumpSessionId: source.jumpSessionId || "",
  };
  if (source.password) copy.password = source.password;
  return copy;
}

module.exports = { buildDuplicatedSession };
