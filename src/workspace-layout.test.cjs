const test = require("node:test");
const assert = require("node:assert/strict");

test("sidebar width clamping and collapse threshold respect viewport and bounds", async () => {
  const {
    DEFAULT_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    clampSidebarWidth,
    shouldSnapCollapseSidebar,
  } = await import("./workspace-layout.mjs");

  assert.equal(clampSidebarWidth(NaN, 1280), DEFAULT_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(100, 1280), MIN_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(600, 1280), MAX_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(400, 620), 300);
  assert.equal(shouldSnapCollapseSidebar(90), true);
  assert.equal(shouldSnapCollapseSidebar(110), false);
  assert.equal(shouldSnapCollapseSidebar(240), false);
});

test("validateSearchRegex validates regex mode and ignores plain mode", async () => {
  const { buildEffectiveSearch, validateSearchRegex } = await import("./workspace-layout.mjs");

  assert.deepEqual(validateSearchRegex("[unclosed", { regex: false }), { valid: true, error: "" });
  assert.deepEqual(validateSearchRegex("needle-\\d+", { regex: true }), { valid: true, error: "" });
  const bad = validateSearchRegex("[unclosed", { regex: true });
  assert.equal(bad.valid, false);
  assert.ok(bad.error.length > 0);

  const whole = buildEffectiveSearch("ll", { wholeWord: true, regex: false });
  assert.equal(whole.regex, true);
  assert.equal(whole.wholeWord, false);
  const matches = [..."install ll wordcheck".matchAll(new RegExp(whole.term, "gi"))];
  assert.equal(matches.length, 1);
  assert.equal(matches[0].index, 8);
});

test("sidebar Ctrl/Cmd+B and search Ctrl/Cmd+F shortcut matching", async () => {
  const { isSidebarToggleShortcut, isTerminalSearchShortcut } = await import("./workspace-layout.mjs");

  assert.equal(
    isSidebarToggleShortcut({ type: "keydown", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "KeyB", key: "b" }, { isMac: false }),
    true,
  );
  assert.equal(
    isSidebarToggleShortcut({ type: "keydown", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: "KeyB", key: "B" }, { isMac: false }),
    false,
  );
  assert.equal(
    isSidebarToggleShortcut({ type: "keydown", ctrlKey: false, shiftKey: false, altKey: false, metaKey: true, code: "KeyB", key: "b" }, { isMac: true }),
    true,
  );

  assert.equal(
    isTerminalSearchShortcut({ type: "keydown", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "KeyF", key: "f" }, { isMac: false }),
    true,
  );
  assert.equal(
    isTerminalSearchShortcut({ type: "keydown", ctrlKey: false, shiftKey: false, altKey: false, metaKey: true, code: "KeyF", key: "f" }, { isMac: true }),
    true,
  );
  assert.equal(
    isTerminalSearchShortcut({ type: "keydown", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "KeyF", key: "f", isComposing: true }, { isMac: false }),
    false,
  );
});
