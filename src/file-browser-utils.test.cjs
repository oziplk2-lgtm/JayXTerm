const test = require("node:test");
const assert = require("node:assert/strict");

test("validateRemoteEntryName accepts safe names and rejects path separators or dots", async () => {
  const { validateRemoteEntryName } = await import("./file-browser-utils.mjs");
  assert.equal(validateRemoteEntryName("  config.yaml  "), "config.yaml");
  assert.equal(validateRemoteEntryName(".env.local"), ".env.local");
  for (const bad of ["", "   ", ".", "..", "a/b", "bad\0name", "line\nbreak"]) {
    assert.throws(() => validateRemoteEntryName(bad));
  }
});

test("sortAndFilterFiles hides dotfiles on demand and keeps directories first", async () => {
  const { sortAndFilterFiles } = await import("./file-browser-utils.mjs");
  const files = [
    { name: ".env", directory: false, size: 12, modified: 100 },
    { name: "b.txt", directory: false, size: 500, modified: 300 },
    { name: "a.txt", directory: false, size: 50, modified: 200 },
    { name: "logs", directory: true, size: 0, modified: 150 },
    { name: ".git", directory: true, size: 0, modified: 250 },
  ];

  const hiddenOff = sortAndFilterFiles(files, { showHidden: false, sortBy: "name", sortDir: "asc" });
  assert.deepEqual(hiddenOff.map((f) => f.name), ["logs", "a.txt", "b.txt"]);

  const bySizeDesc = sortAndFilterFiles(files, { showHidden: true, sortBy: "size", sortDir: "desc" });
  assert.deepEqual(bySizeDesc.map((f) => f.name), ["logs", ".git", "b.txt", "a.txt", ".env"]);

  const byModDesc = sortAndFilterFiles(files, { showHidden: true, sortBy: "modified", sortDir: "desc" });
  assert.deepEqual(byModDesc.map((f) => f.name), [".git", "logs", "b.txt", "a.txt", ".env"]);
});
