const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BrowserWindow, dialog } = require("electron");

async function winPointForTerminalText(w, target) {
  return w.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector(".terminal-group.focused .terminal-pane.active") || document.querySelector(".terminal-pane.active");
    const screen = pane.querySelector(".xterm-screen");
    const rows = [...pane.querySelectorAll(".xterm-rows > div")];
    const cols = Number(pane.dataset.cols) || 100;
    const rect = screen.getBoundingClientRect();
    const cellW = rect.width / cols;
    const cellH = rect.height / rows.length;
    for (let r = rows.length - 1; r >= 0; r--) {
      const text = rows[r].textContent;
      const idx = text.indexOf(${JSON.stringify(target)});
      if (idx >= 0) {
        return {
          x: Math.round(rect.left + (idx + 3) * cellW),
          y: Math.round(rect.top + (r + 0.5) * cellH),
        };
      }
    }
    throw new Error("Target text not found in terminal rows: " + ${JSON.stringify(target)});
  })()`);
}

async function check(w) {
  const chosen = path.resolve(".codex-cache/qa/cache-location");
  const openDialog = dialog.showOpenDialog;
  const messageBox = dialog.showMessageBox;
  let asked = false;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  dialog.showMessageBox = async (_win, options) => {
    asked ||= options.message === "是否迁移缓存数据？";
    return { response: 1 };
  };
  const run = (code) => w.webContents.executeJavaScript(`(async () => {
      const $ = (query) => document.querySelector(query);
      const wait = async (check) => {
        for (let i = 0; i < 150; i++) {
          if (await check()) return;
          await new Promise(resolve => setTimeout(resolve, 35));
        }
        throw new Error("Settings check timed out: " + check + " / " + $("#settings-error").textContent);
      };
      const open = async () => {
        $("#settings-open").click();
        await wait(() => $("#settings-dialog").open);
        return $("#settings-form");
      };

      ${code}
    })()`);
  try {
    await run(`
      const initial = await api.settings();
      if (initial.saveHistory || initial.fileOpen !== "single" || initial.cachePath)
        throw new Error("Wrong default settings");
      const color = () => getComputedStyle($(".sidebar")).backgroundColor;
      const terminal = () => getComputedStyle($(".terminal-group-body")).backgroundColor;
      if (!document.querySelector(".topbar #settings-open") || color() !== "rgb(24, 24, 24)")
        throw new Error("Missing title bar settings or default background");
      const terminalBackground = terminal();
      if (terminalBackground !== "rgb(24, 24, 24)" ||
          getComputedStyle($(".terminal-pane.active .xterm-viewport")).backgroundColor !== terminalBackground ||
          getComputedStyle($(".window-tools")).backdropFilter !== "none")
        throw new Error("Missing matte terminal or software-friendly toolbar");
      const pickerColor = $("#settings-background");
      $("#window-tools-menu").click();
      if (!$("#window-tools-options").matches(":popover-open"))
        throw new Error("Title bar window menu did not open");
      $("#window-tools-options").hidePopover();
      await open();
      const hexInput = $("#settings-background-value");
      if (!$("#settings-pick-color") || hexInput.value !== "#181818")
        throw new Error("Missing screen color picker button or hex input");
      hexInput.value = "#123456";
      hexInput.dispatchEvent(new Event("input"));
      if (pickerColor.value !== "#123456" || color() !== "rgb(18, 52, 86)")
        throw new Error("Hex color input did not update preview");
      pickerColor.value = "#224466";
      pickerColor.dispatchEvent(new Event("input"));
      if (hexInput.value !== "#224466")
        throw new Error("Color input did not sync hex field");
      if (color() !== "rgb(34, 68, 102)" || terminal() !== "rgb(34, 68, 102)" ||
          getComputedStyle($(".terminal-pane.active .xterm-viewport")).backgroundColor !== terminal())
        throw new Error("Background preview did not update the terminal and workspace");
      $("#settings-cancel").click();
      await wait(() => color() === "rgb(24, 24, 24)");
      if (terminal() !== terminalBackground) throw new Error("Cancel did not restore the terminal theme");
      const form = await open();
      $("#settings-choose-cache").click();
      await wait(() => $("#settings-cache").value.endsWith("JayXTerm-cache"));
      form.elements.saveHistory.checked = true;
      form.elements.fileOpen.value = "single";
      pickerColor.value = "#283755";
      pickerColor.dispatchEvent(new Event("input"));
      form.requestSubmit();
      await wait(() => !$("#settings-dialog").open);
      const updated = await api.settings();
      if (updated.pendingCache !== ${JSON.stringify(path.join(chosen, "JayXTerm-cache"))})
        throw new Error("Cache directory was not scheduled");
      if (updated.backgroundColor !== "#283755" || color() !== "rgb(40, 55, 85)")
        throw new Error("Background setting was not saved");

      const input = { name: "测试历史密码", host: "localhost", username: "jay",
        port: 22, password: "132exampleio", remember: true };
      let saved = (await api.save(input)).find(s => s.name === input.name);
      saved = (await api.save({ ...input, id: saved.id })).find(s => s.id === saved.id);
      $("#new").click();
      await wait(() => $("#session-password-history").options.length === 2);
      const picker = $("#session-password-history");
      if (picker.options[1].textContent !== "13********io")
        throw new Error("History label was not masked");
      picker.selectedIndex = 1;
      picker.dispatchEvent(new Event("change"));
      const password = $("#session-form").elements.password;
      await wait(() => password.value === input.password && password.type === "password");
      $("#toggle-password").click();
      await wait(() => password.type === "text");
      $("#editor-cancel").click();
      await wait(() => !$("#editor").open);

      $("#file-workspace-toggle").click();
      const files = $(".terminal-group.focused .workspace-files");
      const submit = files.querySelector("form");
      submit.querySelector("input").value = "/home/jay";
      submit.requestSubmit();
      await wait(() => files.querySelector('[data-directory="/home/jay/projects"]'));
      files.querySelector('[data-directory="/home/jay/projects"]').click();
      await wait(() => files.querySelector("input").value === "/home/jay/projects");
      $("#file-workspace-toggle").click();

      const sidebar = $("#path-form");
      $("#remote-path").value = "/home/jay";
      sidebar.requestSubmit();
      await wait(() => [...document.querySelectorAll("#file-list .file-row")]
        .some(row => row.querySelector(".filename").textContent === "README.md"));
      [...document.querySelectorAll("#file-list .file-row")]
        .find(row => row.querySelector(".filename").textContent === "README.md").click();
    `);
    const storedWithHistory = fs.readFileSync(".codex-cache/qa/profile/settings.json", "utf8");
    const [entry, duplicate] = JSON.parse(storedWithHistory).passwordHistory;
    assert.ok(entry?.encrypted);
    assert.equal(duplicate, undefined);
    assert.ok(!storedWithHistory.includes("132exampleio"));
    assert.notEqual(Buffer.from(entry.encrypted, "base64").toString(), "132exampleio");
    let editor;
    for (let i = 0; i < 100; i++) {
      editor = BrowserWindow.getAllWindows().find(win =>
        win.getTitle().startsWith("README.md ·") && !win.webContents.isLoading());
      if (editor) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(editor, "Single-click file did not open the editor");
    await editor.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (document.querySelector(".monaco-editor")) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Single-click file did not load the editor");
    })()`);
    editor.close();

    await run(`
      const saved = (await api.sessions()).find(s => s.name === "测试历史密码");
      const edit = await open();
      $("#settings-default-cache").click();
      $("#settings-default-background").click();
      edit.elements.saveHistory.checked = false;
      edit.elements.fileOpen.value = "single";
      edit.requestSubmit();
      await wait(() => !$("#settings-dialog").open);
      if ((await api.passwordHistory()).items.length || (await api.passwordHistory()).enabled)
        throw new Error("Password history was not cleared");
      if ((await api.settings()).backgroundColor !== "#181818")
        throw new Error("Background reset was not saved");
      if (await api.reveal(saved.id) !== "132exampleio")
        throw new Error("Clearing history changed a saved session password");
      $("#new").click();
      await wait(() => $("#session-password-history").textContent.includes("未开启"));
      $("#editor-cancel").click();

      $("#mode-sessions").click();
      const row = [...document.querySelectorAll("#sessions .session")]
        .find(el => el.textContent.includes("本地验收服务器"));
      if (!row) throw new Error("Saved session row missing");
      row.click();
      if (!row.classList.contains("selected"))
        throw new Error("Clicking session row did not mark it selected");
    `);
    w.show();
    w.focus();
    const mod = process.platform === "darwin" ? 4 : 2;
    w.webContents.debugger.attach("1.3");
    try {
      for (const [key, code, virtual] of [["c", "KeyC", 67], ["v", "KeyV", 86]]) {
        for (const type of ["keyDown", "keyUp"]) {
          await w.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
            type, key, code, windowsVirtualKeyCode: virtual, modifiers: mod,
          });
        }
        await new Promise(resolve => setTimeout(resolve, 120));
      }
    } finally {
      w.webContents.debugger.detach();
    }
    await run(`
      await wait(async () => (await api.sessions()).some(s => s.name === "本地验收服务器 - 副本"));
      const list = await api.sessions();
      const copy = list.find(s => s.name === "本地验收服务器 - 副本");
      if (!copy?.hasPassword || copy.password)
        throw new Error("Duplicated session credential state is invalid");
      if (await api.reveal(copy.id) !== "qa-password")
        throw new Error("Duplicated session did not preserve encrypted password");
      const copyRow = [...document.querySelectorAll("#sessions .session")]
        .find(el => el.dataset.sessionId === copy.id);
      if (!copyRow?.classList.contains("selected"))
        throw new Error("Pasted session row was not rendered and selected");
      copyRow.querySelectorAll(".session-tools button")[2].click();
      await wait(() => $("#confirm-dialog").open);
      $("#delete-confirm").click();
      await wait(() => !$("#confirm-dialog").open);
      await wait(async () => !(await api.sessions()).some(s => s.id === copy.id));
    `);
    // Verify Ctrl+Left-Click on a terminal file path opens the remote Monaco editor.
    await run(`
      const group = $(".terminal-group.focused") || $(".terminal-group");
      const id = group?.querySelector(".tab.active")?.dataset.connection || window.__qaConnectionId;
      const pane = group?.querySelector(".terminal-pane.active") || $(".terminal-pane.active");
      pane.querySelector(".xterm-helper-textarea").focus();
      window.api.send({ type: "input", id, data: "\\r\\n\\r\\n# /home/jay/README.md\\r\\n" });
      await wait(() => pane.querySelector(".xterm-rows").textContent.includes("# /home/jay/README.md"));
    `);
    const clickPoint = await winPointForTerminalText(w, "/home/jay/README.md");
    w.webContents.debugger.attach("1.3");
    try {
      await w.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: mod,
      });
      for (let attempt = 0; attempt < 10; attempt++) {
        await w.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved", x: clickPoint.x, y: clickPoint.y, modifiers: mod,
        });
        await new Promise(resolve => setTimeout(resolve, 60));
        const hovered = await w.webContents.executeJavaScript(
          `!!document.querySelector(".terminal-pane.active .xterm.xterm-cursor-pointer")`,
        );
        if (hovered) break;
      }
      await w.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed", x: clickPoint.x, y: clickPoint.y, button: "left", clickCount: 1, modifiers: mod,
      });
      await w.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: clickPoint.x, y: clickPoint.y, button: "left", clickCount: 1, modifiers: mod,
      });
      await w.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0,
      });
    } finally {
      w.webContents.debugger.detach();
    }
    let terminalEditor;
    for (let i = 0; i < 100; i++) {
      terminalEditor = BrowserWindow.getAllWindows().find(win =>
        win.getTitle().startsWith("README.md ·") && !win.webContents.isLoading());
      if (terminalEditor) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!terminalEditor) {
      const diag = await w.webContents.executeJavaScript(`({
        toast: document.querySelector("#toast")?.textContent,
        pointer: !!document.querySelector(".terminal-pane.active .xterm.xterm-cursor-pointer"),
        cols: document.querySelector(".terminal-pane.active")?.dataset.cols,
        rows: document.querySelector(".terminal-pane.active .xterm-rows")?.children.length,
        rect: document.querySelector(".terminal-pane.active .xterm-screen")?.getBoundingClientRect(),
      })`);
      throw new Error("Ctrl+Click did not open editor: " + JSON.stringify({ clickPoint, diag }));
    }
    await terminalEditor.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (document.querySelector(".monaco-editor")) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Ctrl+Click editor did not load Monaco");
    })()`);
    terminalEditor.close();

    assert.ok(asked, "Migration confirmation did not open");
    const stored = fs.readFileSync(".codex-cache/qa/profile/settings.json", "utf8");
    assert.equal(stored.includes("132exampleio"), false);
    assert.deepEqual(JSON.parse(stored).passwordHistory, []);
    console.log("PASS: settings dialog, cache migration confirmation, masked encrypted history and single-click file space");
  } finally {
    dialog.showOpenDialog = openDialog;
    dialog.showMessageBox = messageBox;
  }
}
module.exports = { check };
