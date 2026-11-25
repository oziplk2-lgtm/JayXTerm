const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanPathToken,
  extractTerminalPathMatches,
  resolveRemoteClickPath,
  collectLogicalTerminalLine,
} = require("./terminal-file-links.mjs");

test("extractTerminalPathMatches detects paths, filenames, and line suffixes while ignoring URLs and IPs", () => {
  const line = "Edit '/etc/nginx/nginx.conf:42:5', src/main.cjs:10, README.md, ~/notes.txt, https://example.com/a.txt and 127.0.0.1:22";
  const matches = extractTerminalPathMatches(line);
  assert.deepEqual(
    matches.map((item) => item.path),
    ["/etc/nginx/nginx.conf", "src/main.cjs", "README.md", "~/notes.txt"],
  );
  for (const item of matches) {
    assert.equal(line.slice(item.start, item.end), item.path);
  }
  assert.equal(cleanPathToken('"./scripts/build.sh:99"'), "./scripts/build.sh");
});

test("resolveRemoteClickPath resolves absolute, relative, and home paths", () => {
  assert.equal(resolveRemoteClickPath("/var/log/../log/syslog:12"), "/var/log/syslog");
  assert.equal(resolveRemoteClickPath("src/main.cjs:88", { baseDirectory: "/home/jay/app" }), "/home/jay/app/src/main.cjs");
  assert.equal(resolveRemoteClickPath("../README.md", { baseDirectory: "/home/jay/app" }), "/home/jay/README.md");
  assert.equal(resolveRemoteClickPath("~/todo.md", { baseDirectory: "/tmp" }), "~/todo.md");
});

test("collectLogicalTerminalLine joins soft wraps and tracks CJK cell columns", () => {
  const cell = (chars, width = 1) => ({ getChars: () => chars, getWidth: () => width });
  const row0 = {
    isWrapped: false,
    getCell: (x) => [cell("看"), cell("", 0), cell(" "), cell("/"), cell("t"), cell("m")][x] || cell(" "),
  };
  const row1 = {
    isWrapped: true,
    getCell: (x) => [cell("p"), cell("/"), cell("a"), cell("."), cell("t"), cell("x")][x] || cell(" "),
  };
  const row2 = {
    isWrapped: true,
    getCell: (x) => [cell("t"), cell(" "), cell(" "), cell(" "), cell(" "), cell(" ")][x] || cell(" "),
  };
  const buffer = { length: 3, getLine: (i) => [row0, row1, row2][i] };
  const collected = collectLogicalTerminalLine(buffer, 6, 1);
  assert.equal(collected.text.trimEnd(), "看 /tmp/a.txt");
  const matches = extractTerminalPathMatches(collected.text);
  assert.deepEqual(matches.map((item) => item.path), ["/tmp/a.txt"]);
});
