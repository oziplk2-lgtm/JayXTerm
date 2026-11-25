const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTheme, contrast } = require("./theme.mjs");

test("whole-window themes preserve readable text across dark, light and mid-tone colors", () => {
  for (const color of ["#181818", "#394351", "#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#777777", "#888888", "#ff00ff"]) {
    const theme = createTheme(color);
    assert.equal(theme.terminal.background, color);
    assert.equal(theme.editor.colors["editor.background"], color);
    for (const background of [theme.background, theme.chrome, theme.surface]) {
      for (const foreground of [theme.ink, theme.muted, theme.accent])
        assert.ok(contrast(background, foreground) >= 4.5, `${color}: ${foreground} on ${background}`);
    }
  }
  const vscode = createTheme("#181818");
  assert.equal(vscode.terminal.foreground, "#cccccc");
  assert.equal(vscode.terminal.selectionBackground, "#264f78");
  assert.equal(vscode.terminal.red, "#cd3131");
  assert.equal(vscode.terminal.brightBlue, "#3b8eea");
  assert.equal(createTheme("invalid").background, "#181818");
  assert.equal(createTheme("#ffffff").editor.base, "vs");
  assert.equal(createTheme("#000000").editor.base, "vs-dark");
});
