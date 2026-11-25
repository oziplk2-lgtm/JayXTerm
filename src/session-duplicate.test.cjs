const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDuplicatedSession } = require("./session-duplicate.cjs");

test("buildDuplicatedSession clones session fields, encrypted password, and increments copy names", () => {
  const source = {
    id: "id-1",
    name: "WSL Ubuntu",
    host: "127.0.0.1",
    port: 22,
    username: "jay",
    group: "本地",
    encoding: "gbk",
    password: "encrypted-base64-blob",
  };
  const first = buildDuplicatedSession(source, [source], "id-2");
  assert.equal(first.id, "id-2");
  assert.equal(first.name, "WSL Ubuntu - 副本");
  assert.equal(first.host, "127.0.0.1");
  assert.equal(first.port, 22);
  assert.equal(first.username, "jay");
  assert.equal(first.group, "本地");
  assert.equal(first.encoding, "gbk");
  assert.equal(first.password, "encrypted-base64-blob");

  const second = buildDuplicatedSession(first, [source, first], "id-3");
  assert.equal(second.name, "WSL Ubuntu - 副本 2");

  const third = buildDuplicatedSession(source, [source, first, second], "id-4");
  assert.equal(third.name, "WSL Ubuntu - 副本 3");
});

test("buildDuplicatedSession clamps long names within 100 chars and omits missing password", () => {
  const source = {
    id: "id-long",
    name: "a".repeat(98),
    host: "10.0.0.1",
    port: 2222,
    username: "ops",
    group: "",
    encoding: "utf-8",
  };
  const copy = buildDuplicatedSession(source, [source], "id-copy");
  assert.ok(copy.name.length <= 100);
  assert.ok(copy.name.endsWith(" - 副本"));
  assert.equal(Object.hasOwn(copy, "password"), false);
});
