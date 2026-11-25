const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("package.json build.files includes every local module required by main process entrypoints", () => {
  const root = path.resolve(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packaged = new Set(pkg.build?.files || []);
  const entrypoints = [
    pkg.main,
    "src/preload.cjs",
    "src/editor-preload.cjs",
    "src/color-picker-preload.cjs",
    "src/ssh-worker.cjs",
  ];

  const visited = new Set();
  const queue = [...entrypoints];
  const missing = [];

  while (queue.length) {
    const rel = queue.shift().replace(/\\/g, "/");
    if (visited.has(rel)) continue;
    visited.add(rel);
    if (!packaged.has(rel)) missing.push(rel);

    const full = path.join(root, rel);
    assert.ok(fs.existsSync(full), `Packaged file does not exist: ${rel}`);
    const content = fs.readFileSync(full, "utf8");
    const dir = path.dirname(rel);
    for (const match of content.matchAll(/\brequire\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const target = path.posix.normalize(path.posix.join(dir, match[1]));
      queue.push(target);
    }
  }

  assert.deepEqual(missing, [], `Missing local modules from package.json build.files: ${missing.join(", ")}`);
});
