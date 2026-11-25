const assert = require("node:assert/strict");
const fs = require("node:fs");
const { BrowserWindow, dialog } = require("electron");
const iconv = require("iconv-lite");

async function check(w, fixture) {
  const first = "/home/jay/settings.cpp";
  const second = "/home/jay/legacy.txt";
  const cpp = [
    "#include <string>", "#include <vector>", "", "namespace workspace {", "",
    "void first(double rd, double t, int CP);",
    "void other(double rd, double t, int CP);",
    "void third(double rd, double t, int CP);", "",
    "struct Endpoint {", "    std::string host;", "    unsigned port = 22;", "};", "",
    "// 加载内网环境的服务器配置", "std::vector<Endpoint> loadEndpoints() {",
    '    return {{"build-server", 22}, {"deploy-server", 2007}};',
    "}", "", "bool isDefaultPort(const Endpoint& server) {",
    "    return server.port == 22;", "}", "",
    ...Array.from({ length: 35 }, (_, index) =>
      `constexpr unsigned pipeline_${index + 1} = ${index + 100};`),
    "", "}  // namespace workspace", "",
  ].join("\n");
  fixture.files.set(first, Buffer.from(cpp));
  fixture.files.set(second, iconv.encode("维护窗口\r\n", "gbk"));
  fixture.files.set("/home/jay/options.json", Buffer.from('{"port": }\n'));
  fixture.files.set("/home/jay/image.bin", Buffer.from([0, 1, 2]));
  const run = (win, code) => win.webContents.executeJavaScript(`(async () => {
    const $ = (selector) => document.querySelector(selector);
    const open = (name) => [...document.querySelectorAll("#file-list .file-row")]
      .find((row) => row.querySelector(".filename").textContent === name)
      .click();
    const wait = async (predicate) => {
      for (let count = 0; count < 150; count++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Editor check timed out: " + predicate + " / " + ($(".editor-message") || $("#toast"))?.textContent);
    };
    const encoding = (choice) => {
      const picker = $(".editor-charset");
      picker.value = choice;
      picker.dispatchEvent(new Event("change"));
    };
    const lines = () => [...document.querySelectorAll(".monaco-editor .view-line")];
    const content = () => lines().map(line => line.textContent.replaceAll("\u00a0", " ")).join("\\r\\n");
    ${code}
  })()`);
  function press(win, keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  }
  const opened = (name) => BrowserWindow.getAllWindows().find((win) =>
    win.getTitle().startsWith(name + " ·"));
  async function findEditor(name) {
    for (let i = 0; i < 150; i++) {
      const win = opened(name);
      if (win && !win.webContents.isLoading()) return win;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("File window did not open: " + name);
  }
  await run(w, `
    if (performance.getEntriesByType("resource").some((entry) =>
      ["/assets/editor", "monaco", "codicon"].some(part => entry.name.includes(part))))
      throw new Error("Terminal loaded the editor at startup");
    $("#refresh").click();
    await wait(() => $("#file-list").textContent.includes("settings.cpp"));
    open("image.bin");
    await wait(() => $("#toast").textContent.includes("二进制文件"));
    open("legacy.txt");
  `);
  const legacy = await findEditor("legacy.txt");
  await run(legacy, `
    await wait(() => content().includes("维护窗口"));
    encoding("open:utf-8");
    await wait(() => $(".editor-message").textContent.includes("不是有效的 UTF-8"));
    if (!content().includes("维护窗口")) throw new Error("Failed reload lost content");
    encoding("open:gbk");
    await wait(() => $(".editor-message").textContent.includes("已按 GBK 重新读取"));
  `);
  await legacy.webContents.insertText("计划");
  const edited = await run(legacy, `
    await wait(() => content().includes("计划"));
    return content();
  `);
  press(legacy, "S", [process.platform === "darwin" ? "meta" : "control"]);
  await run(legacy, `
    await wait(() => $(".editor-message").textContent.includes("已保存到远端"));
    if ($(".editor-charset").selectedOptions[0].textContent !== "GBK" ||
        !$(".editor-status").textContent.includes("CRLF"))
      throw new Error("Encoding and line ending not shown");
  `);
  assert.match(edited, /维护窗口/);
  assert.match(edited, /\r\n/);
  assert.deepEqual(fixture.files.get(second), iconv.encode(edited, "gbk"));
  await fixture.closeSftpChannels();
  await run(legacy, `
    encoding("save:utf-8");
    await wait(() => $(".editor-charset").selectedOptions[0].textContent === "UTF-8");
  `);
  assert.equal(fixture.files.get(second).toString(), edited);
  await run(w, `
    if ($("#connected").classList.contains("hidden")) throw new Error("Terminal was hidden");
    open("settings.cpp");
  `);
  const code = await findEditor("settings.cpp");
  assert.notEqual(code.id, legacy.id);
  await run(w, 'open("settings.cpp");');
  assert.equal(opened("settings.cpp").id, code.id);
  assert.equal(BrowserWindow.getAllWindows().filter((win) => win.getTitle().startsWith("settings.cpp ·")).length, 1);
  await run(code, `
    await wait(() => $(".monaco-editor .line-numbers") && $(".monaco-editor .minimap"));
    if (!$(".editor-status").textContent.includes("C / C++")) throw new Error("Missing language");
    await wait(() => lines().some(line => line.querySelectorAll("span").length > 3));
  `);
  press(code, "Tab");
  await run(code, `await wait(() => content().startsWith("    #include"));`);
  press(code, "Tab", ["shift"]);
  await run(code, `await wait(() => content().startsWith("#include"));`);

  // Drag the repeated parameter list in the middle declaration. The native
  // selection has to stay on that exact row even though other rows match.
  const target = await run(code, `return (() => {
    const line = lines().find(line => line.textContent.includes("other("));
    const spans = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let start, end;
    for (let node, index = 0; (node = spans.nextNode()); index += node.length) {
      for (const column of [11, 20]) {
        if (column < index || column >= index + node.length) continue;
        const range = document.createRange();
        range.setStart(node, column - index);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        if (column === 11) start = Math.round(rect.left);
        else end = Math.round(rect.left);
      }
    }
    const row = line.getBoundingClientRect();
    return { start, end, y: Math.round((row.top + row.bottom) / 2) };
  })()`);
  code.webContents.debugger.attach("1.3");
  try {
    for (const [type, x, buttons] of [
      ["mousePressed", target.start, 1],
      ["mouseMoved", target.end, 1],
      ["mouseReleased", target.end, 0],
    ]) {
      await code.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type, x, y: target.y, button: "left", buttons, clickCount: 1,
      });
    }
  } finally {
    code.webContents.debugger.detach();
  }
  await run(code, `await wait(() => {
    const selection = [...document.querySelectorAll(".monaco-editor .selected-text")];
    return selection.length > 0 && selection.every((part) => {
      const box = part.getBoundingClientRect();
      return box.top <= ${target.y} && box.bottom >= ${target.y};
    });
  });`);
  fs.writeFileSync(".codex-cache/qa/remote-editor.png", (await code.webContents.capturePage()).toPNG());
  await code.webContents.insertText("// 本地草稿\n");
  fixture.files.set(first, Buffer.from("edited externally\n"));
  await run(code, `
    $(".editor-save").click();
    await wait(() => $(".editor-message").textContent.includes("远程文件已更改"));
    if (!content().includes("本地草稿")) throw new Error("Draft lost on conflict");
  `);
  const originalDialog = dialog.showMessageBox;
  try {
    let allowOverwrite = false;
    dialog.showMessageBox = async (_window, options) => {
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      assert.match(options.detail, /\/home\/jay\/settings\.cpp/);
      return { response: allowOverwrite ? 1 : 0 };
    };
    await run(code, `
      $(".editor-force-save").click();
      await wait(() => $(".editor-message").textContent.includes("已取消强制保存"));
    `);
    assert.equal(fixture.files.get(first).toString(), "edited externally\n");
    allowOverwrite = true;
    fixture.files.delete(first);
    await run(code, `
      $(".editor-force-save").click();
      await wait(() => $(".editor-message").textContent.includes("强制保存失败"));
      if (!content().includes("本地草稿")) throw new Error("Draft lost on failed overwrite");
      if (!$(".editor-message.editor-error")?.textContent.includes("普通文件"))
        throw new Error("Missing force save failure explanation");
    `);
    assert.equal(fixture.files.has(first), false);

    // The newer remote bytes no longer decode as text. Force save uses the
    // format already loaded into the editor and overwrites even this revision.
    const remoteBytes = Buffer.from([255, 0]);
    fixture.files.set(first, remoteBytes);
    fixture.deniedCreates.add("/home/jay");
    try {
      await run(code, `
        $(".editor-force-save").click();
        await wait(() => $(".editor-message").textContent.includes("创建同目录临时文件失败"));
        if (!$(".editor-message").textContent.includes("目录写权限") ||
            !content().includes("本地草稿")) throw new Error("Missing write failure details or draft");
      `);
      assert.deepEqual(fixture.files.get(first), remoteBytes);
    } finally {
      fixture.deniedCreates.delete("/home/jay");
    }
    await run(code, `
      $(".editor-force-save").click();
      await wait(() => $(".editor-message").textContent.includes("已强制保存到远端"));
      if (!$(".editor-modified").hidden) throw new Error("Overwrite did not mark the draft saved");
    `);
    assert.match(fixture.files.get(first).toString(), /本地草稿/);
    await code.webContents.insertText("// 普通保存\n");
    await run(code, `
      $(".editor-save").click();
      await wait(() => $(".editor-message").textContent.includes("已保存到远端"));
    `);
    assert.match(fixture.files.get(first).toString(), /普通保存/);
  } finally {
    dialog.showMessageBox = originalDialog;
  }
  await code.webContents.insertText("// 未保存\n");
  let confirms = 0;
  try {
    dialog.showMessageBox = async () => {
      confirms++;
      return { response: confirms === 1 ? 0 : 1 };
    };
    code.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(code.isDestroyed(), false);
    code.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(code.isDestroyed(), true);
    assert.equal(confirms, 2);
  } finally {
    dialog.showMessageBox = originalDialog;
  }
  legacy.close();
  await run(w, 'open("options.json");');
  const json = await findEditor("options.json");
  await run(json, `
    await wait(() => $(".monaco-editor .squiggly-error"));
    if (!content().includes("port")) throw new Error("JSON model did not load");
  `);
  json.close();
  // Verify > 5 MiB file prompts user instead of blocking, opens in large-file mode on confirm, and saves cleanly.
  const largePath = "/home/jay/huge.log";
  const largePayload = ("large-log-entry-0123456789abcdef".repeat(32) + "\n").repeat(5200); // ~5.08 MiB
  fixture.files.set(largePath, Buffer.from(largePayload));
  try {
    let allowLarge = false;
    let promptSeen = false;
    dialog.showMessageBox = async (_win, options) => {
      if (options.title === "大文件打开提示") {
        promptSeen = true;
        return { response: allowLarge ? 1 : 0 };
      }
      return { response: 1 };
    };
    await run(w, `
      $("#refresh").click();
      await wait(() => $("#file-list").textContent.includes("huge.log"));
      open("huge.log");
    `);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(promptSeen, true, "Large file > 5 MiB must prompt before opening");
    assert.equal(opened("huge.log"), undefined, "Cancelling large-file warning must not open editor");
    allowLarge = true;
    await run(w, 'open("huge.log");');
    const largeWin = await findEditor("huge.log");
    await run(largeWin, `
      await wait(() => $(".editor-message").textContent.includes("大文件流畅模式"));
      if ($(".monaco-editor .minimap")?.offsetWidth) throw new Error("Minimap should be disabled in large-file mode");
    `);
    largeWin.close();
  } finally {
    dialog.showMessageBox = originalDialog;
    fixture.files.delete(largePath);
  }
  assert.doesNotMatch(fixture.files.get(first).toString(), /未保存/);
  assert.equal([...fixture.files.keys()].some((name) => name.includes(".jayxterm-edit-")), false);
}

module.exports = { check };
