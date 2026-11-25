const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openCommandHistory, shouldRecordCommand } = require("./command-history.cjs");

function setupStore(t) {
  const temp = path.resolve(".codex-cache/tmp");
  fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, "cmd-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "command-history.json");
}

test("shouldRecordCommand filters empty, single-char, leading-space and secret commands", () => {
  assert.equal(shouldRecordCommand(""), false);
  assert.equal(shouldRecordCommand("y"), false);
  assert.equal(shouldRecordCommand(" ls -la"), false);
  assert.equal(shouldRecordCommand("export API_TOKEN=abc123"), false);
  assert.equal(shouldRecordCommand("MYSQL_PASSWORD=secret mysql"), false);
  assert.equal(shouldRecordCommand("mysql -u root -pMyPass123"), false);
  assert.equal(shouldRecordCommand("curl -u admin:secret https://example.com"), false);
  assert.equal(shouldRecordCommand("curl -H 'Authorization: Bearer xyz' https://api"), false);
  assert.equal(shouldRecordCommand("sshpass -p hunter2 ssh root@host"), false);
  assert.equal(shouldRecordCommand("docker compose logs -f --tail=200 api"), true);
  assert.equal(shouldRecordCommand("ls -la /var/log"), true);
});

test("command history store persists, deduplicates, pins, and clears safely", (t) => {
  const file = setupStore(t);
  let store = openCommandHistory(file);
  const first = store.record({
    command: "docker ps -a",
    scopeKey: "session:s1",
    hostKey: "root@10.0.0.1:22",
    sessionName: "Prod-1",
  });
  assert.ok(first?.id);
  assert.equal(first.useCount, 1);

  const dup = store.record({
    command: "docker ps -a",
    scopeKey: "session:s1",
    hostKey: "root@10.0.0.1:22",
    sessionName: "Prod-1",
  });
  assert.equal(dup.id, first.id);
  assert.equal(dup.useCount, 2);

  const second = store.record({
    command: "systemctl status nginx",
    scopeKey: "session:s2",
    hostKey: "root@10.0.0.2:22",
    sessionName: "Prod-2",
  });
  assert.equal(store.list().length, 2);

  const pinned = store.togglePin(first.id);
  assert.equal(pinned.pinned, true);
  const noted = store.updateNote(first.id, "查看所有容器");
  assert.equal(noted.note, "查看所有容器");

  // Reload from disk and verify persistence.
  store = openCommandHistory(file);
  assert.equal(store.list().length, 2);
  const reloadedFirst = store.list().find((item) => item.id === first.id);
  assert.equal(reloadedFirst.pinned, true);
  assert.equal(reloadedFirst.note, "查看所有容器");
  assert.equal(reloadedFirst.useCount, 2);

  // Scoped clear removes only matching scope.
  const clearedScope = store.clear({ scopeKey: "session:s2" });
  assert.equal(clearedScope.removed, 1);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, first.id);

  // Remove individual entry.
  assert.deepEqual(store.remove(first.id), { removed: true });
  assert.equal(store.list().length, 0);
  assert.equal(second.command, "systemctl status nginx");
});

test("terminal line tracker captures typed, edited, pasted, and tab-completed commands while skipping unsafe modes", async () => {
  const {
    createTerminalLineTracker,
    extractCommandFromTerminalLine,
    filterHistoryEntries,
    isCommandHistoryShortcut,
  } = await import("./terminal-history.mjs");

  assert.equal(extractCommandFromTerminalLine("jay@dev-server:~/app$ git status"), "git status");
  assert.equal(extractCommandFromTerminalLine("[root@node1 /etc]# nginx -t"), "nginx -t");
  assert.equal(extractCommandFromTerminalLine("(venv) dev@box ~/src % pytest -q"), "pytest -q");
  assert.equal(extractCommandFromTerminalLine("plain output line without prompt"), null);

  const tracker = createTerminalLineTracker();
  assert.deepEqual(tracker.feed("ls -l", {}), []);
  assert.deepEqual(tracker.feed("\x7fa\r", {}), ["ls -a"]);

  // Bracketed paste + enter
  assert.deepEqual(tracker.feed("\x1b[200~echo hello\x1b[201~\r", {}), ["echo hello"]);

  // Ctrl+C cancels current buffer
  assert.deepEqual(tracker.feed("rm -rf /tmp/x\x03\r", {}), []);

  // Tab completion falls back to prompt extraction on Enter
  assert.deepEqual(tracker.feed("cat READ\t", {}), []);
  assert.deepEqual(
    tracker.feed("\r", {
      readCurrentLine: () => "jay@dev-server:~$ cat README.md",
    }),
    ["cat README.md"],
  );

  // Alternate screen and password prompts never record
  assert.deepEqual(tracker.feed(":wq\r", { isNormalBuffer: false }), []);
  assert.deepEqual(tracker.feed("MySecretPass\r", { isPasswordPrompt: true }), []);

  // Filter & dedupe across scopes
  const sample = [
    { id: "1", command: "docker logs -f api", scopeKey: "session:a", hostKey: "u@h1:22", sessionName: "A", lastUsedAt: 100, useCount: 1, pinned: false, note: "" },
    { id: "2", command: "git pull origin main", scopeKey: "session:b", hostKey: "u@h2:22", sessionName: "B", lastUsedAt: 200, useCount: 3, pinned: true, note: "拉取代码" },
    { id: "3", command: "docker logs -f api", scopeKey: "session:b", hostKey: "u@h2:22", sessionName: "B", lastUsedAt: 300, useCount: 2, pinned: false, note: "" },
  ];
  const sessionMatches = filterHistoryEntries(sample, { scope: "session", scopeKey: "session:a", hostKey: "u@h1:22" });
  assert.equal(sessionMatches.length, 1);
  assert.equal(sessionMatches[0].id, "1");

  const allDocker = filterHistoryEntries(sample, { scope: "all", query: "docker api" });
  assert.equal(allDocker.length, 1);
  assert.equal(allDocker[0].useCount, 3);

  const pinned = filterHistoryEntries(sample, { scope: "pinned", query: "拉取" });
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].id, "2");

  // Shortcut detection (Ctrl+Shift+H on Win/Linux, Cmd+Shift+H on macOS)
  assert.equal(
    isCommandHistoryShortcut({ type: "keydown", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: "KeyH", key: "H" }, { isMac: false }),
    true,
  );
  assert.equal(
    isCommandHistoryShortcut({ type: "keydown", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "KeyR", key: "r" }, { isMac: false }),
    false,
  );
  assert.equal(
    isCommandHistoryShortcut({ type: "keydown", ctrlKey: false, shiftKey: true, altKey: false, metaKey: true, code: "KeyH", key: "H" }, { isMac: true }),
    true,
  );
});
