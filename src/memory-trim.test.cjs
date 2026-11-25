const test = require("node:test");
const assert = require("node:assert/strict");

test("shouldTrimTab trims only long-idle hidden tabs with larger configured scrollback", async () => {
  const {
    BACKGROUND_TRIM_IDLE_MS,
    BACKGROUND_TRIM_SCROLLBACK,
    shouldTrimTab,
    shouldPruneTabFiles,
  } = await import("./memory-trim.mjs");

  const now = 1_000_000;
  const idleSince = now - BACKGROUND_TRIM_IDLE_MS - 1000;
  const recentSince = now - 10_000;

  assert.equal(shouldTrimTab({ visible: true, hiddenSince: idleSince }, now, 3000), false);
  assert.equal(shouldTrimTab({ visible: false, moving: true, hiddenSince: idleSince }, now, 3000), false);
  assert.equal(shouldTrimTab({ visible: false, hiddenSince: recentSince }, now, 3000), false);
  assert.equal(shouldTrimTab({ visible: false, hiddenSince: idleSince, scrollbackTrimmed: true }, now, 3000), false);
  assert.equal(shouldTrimTab({ visible: false, hiddenSince: idleSince }, now, BACKGROUND_TRIM_SCROLLBACK), false);
  assert.equal(shouldTrimTab({ visible: false, hiddenSince: idleSince }, now, 3000), true);
  assert.equal(shouldTrimTab({ visible: false, hiddenSince: idleSince }, now, 30000), true);

  assert.equal(shouldPruneTabFiles({ visible: false, hiddenSince: idleSince, files: new Array(201) }, now), true);
  assert.equal(shouldPruneTabFiles({ visible: false, hiddenSince: idleSince, files: new Array(50) }, now), false);
  assert.equal(shouldPruneTabFiles({ visible: true, hiddenSince: idleSince, files: new Array(300) }, now), false);
});
