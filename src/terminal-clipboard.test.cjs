const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTerminalClipboardShortcut } = require("./terminal-clipboard.mjs");

function keyEvent(overrides = {}) {
  return {
    type: "keydown",
    key: "c",
    code: "KeyC",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 67,
    ...overrides,
  };
}

test("Windows/Linux Ctrl+C copies when selected and sends interrupt when empty", () => {
  const ctrlC = keyEvent({ ctrlKey: true, key: "c", code: "KeyC" });
  assert.equal(resolveTerminalClipboardShortcut(ctrlC, { hasSelection: true }), "copy");
  assert.equal(resolveTerminalClipboardShortcut(ctrlC, { hasSelection: false }), null);
});

test("Windows/Linux Ctrl+V pastes regardless of selection", () => {
  const ctrlV = keyEvent({ ctrlKey: true, key: "v", code: "KeyV", keyCode: 86 });
  assert.equal(resolveTerminalClipboardShortcut(ctrlV, { hasSelection: false }), "paste");
  assert.equal(resolveTerminalClipboardShortcut(ctrlV, { hasSelection: true }), "paste");
});

test("Windows/Linux Ctrl+Shift+C/V support terminal clipboard without sending SIGINT", () => {
  const shiftC = keyEvent({ ctrlKey: true, shiftKey: true, key: "C", code: "KeyC" });
  const shiftV = keyEvent({ ctrlKey: true, shiftKey: true, key: "V", code: "KeyV", keyCode: 86 });
  assert.equal(resolveTerminalClipboardShortcut(shiftC, { hasSelection: true }), "copy");
  assert.equal(resolveTerminalClipboardShortcut(shiftC, { hasSelection: false }), "noop");
  assert.equal(resolveTerminalClipboardShortcut(shiftV, { hasSelection: false }), "paste");
});

test("macOS uses Cmd+C/V and preserves Ctrl+C/V terminal control signals", () => {
  const cmdC = keyEvent({ metaKey: true, key: "c", code: "KeyC" });
  const cmdV = keyEvent({ metaKey: true, key: "v", code: "KeyV", keyCode: 86 });
  const ctrlC = keyEvent({ ctrlKey: true, key: "c", code: "KeyC" });
  const ctrlV = keyEvent({ ctrlKey: true, key: "v", code: "KeyV", keyCode: 86 });
  assert.equal(resolveTerminalClipboardShortcut(cmdC, { hasSelection: true, isMac: true }), "copy");
  assert.equal(resolveTerminalClipboardShortcut(cmdC, { hasSelection: false, isMac: true }), "noop");
  assert.equal(resolveTerminalClipboardShortcut(cmdV, { hasSelection: false, isMac: true }), "paste");
  assert.equal(resolveTerminalClipboardShortcut(ctrlC, { hasSelection: true, isMac: true }), null);
  assert.equal(resolveTerminalClipboardShortcut(ctrlV, { hasSelection: false, isMac: true }), null);
});

test("non-keydown, modifier combos and IME composition pass through untouched", () => {
  assert.equal(
    resolveTerminalClipboardShortcut(keyEvent({ type: "keyup", ctrlKey: true }), { hasSelection: true }),
    null,
  );
  assert.equal(
    resolveTerminalClipboardShortcut(keyEvent({ ctrlKey: true, altKey: true }), { hasSelection: true }),
    null,
  );
  assert.equal(
    resolveTerminalClipboardShortcut(keyEvent({ ctrlKey: true, isComposing: true }), { hasSelection: true }),
    null,
  );
  assert.equal(
    resolveTerminalClipboardShortcut(keyEvent({ ctrlKey: true, keyCode: 229 }), { hasSelection: true }),
    null,
  );
  assert.equal(
    resolveTerminalClipboardShortcut(keyEvent({ ctrlKey: true, key: "x", code: "KeyX", keyCode: 88 }), { hasSelection: true }),
    null,
  );
});
