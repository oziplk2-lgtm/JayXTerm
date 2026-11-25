const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateSession, openStore } = require("./store.cjs");
test("session validation rejects invalid connection details", () => {
  for (const port of [0, -1, 65536, 2.5, "abc"])
    assert.throws(() =>
      validateSession({
        name: "dev",
        host: "127.0.0.1",
        username: "user",
        port,
      }),
    );
  assert.throws(() =>
    validateSession({ name: "dev", host: "", username: "u" }),
  );
  const s = validateSession({
    name: " dev ",
    host: "localhost",
    username: "u",
    port: "22",
    password: "secret",
  });
  assert.equal(s.name, "dev");
  assert.equal(s.port, 22);
  assert.equal(s.authType, "password");
  assert.equal(s.privateKeyPath, "");
  assert.equal(s.jumpSessionId, "");
  assert.equal(s.password, undefined);
  assert.throws(() =>
    validateSession({ name: "key-only", host: "127.0.0.1", username: "root", authType: "key", privateKeyPath: "" }),
    /私钥文件/,
  );
  assert.throws(() =>
    validateSession({ id: "same-id", host: "127.0.0.1", username: "root", jumpSessionId: "same-id" }),
    /跳板机/,
  );
  const keySession = validateSession({
    id: "target-1",
    host: "10.0.0.2",
    username: "ops",
    authType: "key",
    privateKeyPath: " /home/me/.ssh/id_ed25519 ",
    jumpSessionId: "bastion-1",
  });
  assert.equal(keySession.authType, "key");
  assert.equal(keySession.privateKeyPath, "/home/me/.ssh/id_ed25519");
  assert.equal(keySession.jumpSessionId, "bastion-1");
});
test("empty session names use the validated host, port and username", () => {
  assert.equal(validateSession({
    name: "  ", host: " 192.168.1.10 ", port: "2007", username: " root ",
  }).name, "192.168.1.10:2007 · root");
  assert.equal(validateSession({
    host: "build.example.net", username: "ops",
  }).name, "build.example.net:22 · ops");
  assert.equal(validateSession({
    host: "2001:db8::1", port: 2222, username: "ops",
  }).name, "[2001:db8::1]:2222 · ops");
});
test("store persists replacement and reloads without lost fields", () => {
  const dir = fs.mkdtempSync(path.resolve(".codex-cache/tmp/store-"));
  try {
    const file = path.join(dir, "sessions.json");
    const s = openStore(file);
    s.write({
      sessions: [{ id: "1", password: "encrypted-value" }],
      hosts: { host: "SHA256:test" },
    });
    assert.deepEqual(openStore(file).get(), s.get());
    assert.equal(fs.existsSync(file + ".new"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
