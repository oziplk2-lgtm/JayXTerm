// Launches the real Electron application and checks its renderer and encrypted persistence.
const { app, BrowserWindow, dialog } = require("electron");
const { createFixture } = require("./ssh-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");
process.env.JAYXTERM_QA = "1";
// CI can cover or minimize windows. Keep renderer polling and animation-frame
// layout checks running in every smoke-test workspace and editor window.
app.on("browser-window-created", (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
});
for (const name of ["sessions.json", "settings.json", "quick-passwords.json", "command-history.json"])
  fs.rmSync(path.resolve(".codex-cache/qa/profile", name), { force: true });
require("../src/main.cjs");
app.whenReady().then(async () => {
  const started = Date.now();
  let stage;
  const markStage = (name) => {
    stage = name;
    console.log(`[smoke +${((Date.now() - started) / 1000).toFixed(1)}s] ${stage}`);
  };
  const runCheck = async (name, file, ...args) => {
    markStage(name);
    await require(file).check(...args);
  };
  const deadline = setTimeout(() => {
    console.error(`Application smoke test timed out during: ${stage}`);
    app.exit(1);
  }, 120000);
  try {
    markStage("renderer startup");
    const w = BrowserWindow.getAllWindows()[0];
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once("did-finish-load", r));
    const readline = process.env.JAYXTERM_READLINE_QA === "1" ||
      process.env.JAYXTERM_VIM_QA === "1";
    const fixture = createFixture({ readline });
    const { server } = fixture;
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    dialog.showMessageBox = async () => ({ response: 1 });
    markStage("SSH connection tests (wrong-password rejection is expected)");
    await w.webContents.executeJavaScript(`(async()=>{
      if(!window.api || !document.querySelector('#new')) throw new Error('Renderer did not initialize');
      await new Promise(r=>setTimeout(r,300));
      document.querySelector('#new').click();
      const f=document.querySelector('#session-form');
      f.elements.host.value='127.0.0.1';f.elements.port.value='${server.address().port}';f.elements.username.value='jay';f.elements.group.value='开发环境';f.elements.password.value='qa-password';
      document.querySelector('#test-connection').click();
      for(let i=0;i<100&&document.querySelector('#test-connection').disabled;i++)await new Promise(r=>setTimeout(r,100));
      if(!document.querySelector('#test-status').textContent.includes('均成功'))throw new Error('Unsaved connection test failed: '+document.querySelector('#test-status').textContent);
      if((await window.api.sessions()).length||document.querySelectorAll('.tab').length)throw new Error('Test connection saved a session or opened a tab');
      f.elements.password.value='wrong-password';document.querySelector('#test-connection').click();
      for(let i=0;i<100&&document.querySelector('#test-connection').disabled;i++)await new Promise(r=>setTimeout(r,100));
      if(!document.querySelector('#test-status').textContent.startsWith('连接失败'))throw new Error('Wrong test password accepted');
      f.elements.password.value='qa-password';
      f.requestSubmit();
      await new Promise(r=>setTimeout(r,500));
      if(document.querySelector('#editor').open)throw new Error(document.querySelector('#form-error').textContent||'Session save failed');
      const sessions=await window.api.sessions();
      if(!sessions.some(s=>s.name==='127.0.0.1:${server.address().port} · jay'&&s.hasPassword))
        throw new Error('Generated session name or saved credential missing');
      if(sessions.some(s=>s.password))throw new Error('Password leaked to renderer');
    })()`);
    markStage("credential reveal and encrypted persistence");
    await w.webContents.executeJavaScript(`(async()=>{
      document.querySelector('.session .session-tools').children[1].click();
      const field=document.querySelector('#session-form').elements.password;
      if(field.value)throw new Error('Saved password loaded before explicit reveal');
      document.querySelector('#toggle-password').click();
      for(let i=0;i<50&&field.type!=='text';i++)await new Promise(r=>setTimeout(r,50));
      if(field.type!=='text'||field.value!=='qa-password')throw new Error('Password reveal failed');
      document.querySelector('#toggle-password').click();if(field.type!=='password')throw new Error('Password hide failed');
      document.querySelector('#editor-cancel').click();await new Promise(r=>setTimeout(r,50));if(field.value)throw new Error('Password was not cleared on dialog close');
    })()`);
    const file = path.resolve(".codex-cache/qa/profile/sessions.json");
    if (fs.readFileSync(file, "utf8").includes("qa-password"))
      throw new Error("Plaintext password persisted");
    fs.mkdirSync(path.resolve(".codex-cache/qa"), { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(
      path.resolve(".codex-cache/qa/overview.png"),
      (await w.webContents.capturePage()).toPNG(),
    );
    await w.webContents.executeJavaScript(
      "document.querySelector('#new').click()",
    );
    fs.writeFileSync(
      path.resolve(".codex-cache/qa/session.png"),
      (await w.webContents.capturePage()).toPNG(),
    );
    await w.webContents.executeJavaScript(
      "document.querySelector('#editor-cancel').click()",
    );
    markStage("SSH/SFTP workspace and terminal sizing");
    await w.webContents.executeJavaScript(`(async()=>{
      document.querySelector('#new').click();
      const f=document.querySelector('#session-form');
      f.elements.name.value='本地验收服务器';f.elements.host.value='127.0.0.1';f.elements.port.value='${server.address().port}';f.elements.username.value='jay';f.elements.group.value='开发环境';f.elements.password.value='qa-password';
      f.requestSubmit();
      for(let i=0;i<50&&document.querySelector('#editor').open;i++)await new Promise(r=>setTimeout(r,100));
      const rows=[...document.querySelectorAll('.session')];
      const row=rows.find(r=>r.textContent.includes('本地验收服务器'));
      if(!row)throw new Error('Connection session missing');
      window.api.onEvent(m=>{if(m.type==='ready'&&!window.__qaConnectionId)window.__qaConnectionId=m.id;});
      row.querySelector('button').click();
      for(let i=0;i<50;i++){
        await new Promise(r=>setTimeout(r,100));
        if(document.querySelector('#status').textContent.includes('已连接'))break;
      }
      if(!document.querySelector('#status').textContent.includes('已连接'))
        throw new Error('SSH UI failed: '+document.querySelector('#status').textContent);
      if(!document.querySelector('#mode-sessions').classList.contains('active')||!document.querySelector('#files-panel').classList.contains('hidden'))
        throw new Error('Opening a session must not auto-switch sidebar to remote files');
      document.querySelector('#mode-files').click();
      for(let i=0;i<50;i++){
        await new Promise(r=>setTimeout(r,100));
        if(document.querySelector('#file-list').textContent.includes('README.md'))return;
      }
      throw new Error('SSH/SFTP UI failed: '+document.querySelector('#status').textContent);
    })()`);
    await w.webContents.executeJavaScript(
      `(()=>{if(document.querySelector('#files-panel').getBoundingClientRect().left>=document.querySelector('#terminal-area').getBoundingClientRect().left)throw new Error('SFTP explorer is not on the left');})()`,
    );
    const originalSize = w.getSize();
    try {
      for (const [height, zoom] of [[640, 1], [701, 1.25], [817, 1.5]]) {
        w.setSize(originalSize[0], height);
        w.webContents.setZoomFactor(zoom);
        await new Promise((resolve) => setTimeout(resolve, 180));
        const overflow = await w.webContents.executeJavaScript(`(() => {
          const pane = document.querySelector('.terminal-pane.active');
          const terminal = pane.querySelector('.xterm').getBoundingClientRect();
          const rows = pane.querySelector('.xterm-screen').getBoundingClientRect();
          const lastRow = Array.from(pane.querySelectorAll('.xterm-rows > div')).at(-1).getBoundingClientRect();
          return { bottom: lastRow.bottom - terminal.bottom, right: rows.right - terminal.right };
        })()`);
        if (overflow.bottom > 1 || overflow.right > 1)
          throw new Error("SSH grid exceeds its viewport: " + JSON.stringify(overflow));
      }
    } finally {
      w.webContents.setZoomFactor(1);
      w.setSize(...originalSize);
    }
    fs.writeFileSync(
      path.resolve(".codex-cache/qa/connected.png"),
      (await w.webContents.capturePage()).toPNG(),
    );
    if (process.env.JAYXTERM_CLIPBOARD_QA === "1")
      await runCheck("clipboard", "./clipboard-check.cjs", w, fixture);
    if (process.env.JAYXTERM_EDITOR_QA === "1")
      await runCheck("remote editor", "./remote-editor-check.cjs", w, fixture);
    if (process.env.JAYXTERM_LOCAL_DRAG_QA === "1")
      await runCheck("local drag", "./local-drag-check.cjs", w, fixture);
    if (process.env.JAYXTERM_READLINE_QA === "1")
      await runCheck("readline", "./readline-check.cjs", w, fixture);
    if (process.env.JAYXTERM_VIM_QA === "1")
      await runCheck("Vim", "./vim-check.cjs", w, fixture);
    markStage("SSH working-directory sync");
    const inputsBeforeQuery = fixture.inputs.length;
    const queryBytes = () =>
      Buffer.concat(fixture.inputs.slice(inputsBeforeQuery));
    await w.webContents.executeJavaScript(`(() => {
      document.querySelector('#help-menu').click();
      if (!document.querySelector('#help-options').matches(':popover-open')) throw new Error('Help menu did not open');
      document.querySelector('#encoding-help').click();
      if (!document.querySelector('#encoding-dialog').open) throw new Error('Vim help did not open');
      document.querySelector('#encoding-close').click();
      document.querySelector('#sync-cwd').click();
      if (!document.querySelector('#cwd-dialog').open) throw new Error('Missing shell directory should ask before running a query');
      document.querySelector('#cwd-dialog').close();
    })()`);
    if (queryBytes().length)
      throw new Error("Opening the dialog must not send input");
    // A real PTY answers the query itself using its inherited working directory.
    const queryDirectory = readline
      ? process.cwd()
      : process.platform === "win32"
        ? "/home/jay/projects/当前目录 100%"
        : path.resolve(".codex-cache/qa/当前目录 100%");
    fixture.dirs.add(queryDirectory);
    const shellStream = [...fixture.streams][0];
    shellStream.write("\x1b[?1049h");
    await w.webContents.executeJavaScript(`(async () => {
      await new Promise(r => setTimeout(r, 150));
      document.querySelector('#sync-cwd').click();
      document.querySelector('#cwd-query').click();
    })()`);
    if (queryBytes().length)
      throw new Error(
        "Directory query must not send input to the alternate screen",
      );
    shellStream.write("\x1b[?1049l");
    await w.webContents.executeJavaScript(`(async () => {
      await new Promise(r => setTimeout(r, 150));
      document.querySelector('#sync-cwd').click();
      document.querySelector('#cwd-query').click();
    })()`);
    for (let i = 0; i < 40 && !queryBytes().includes(13); i++)
      await new Promise((r) => setTimeout(r, 25));
    const query = queryBytes().toString("utf8").trimEnd();
    const queryHost =
      /^printf '\\033\]7;file:\/\/(jayxterm-query-[\da-f-]+)%s/.exec(
        query,
      )?.[1];
    if (!queryHost)
      throw new Error(
        "Directory query was not sent to the existing SSH terminal",
      );
    if (!readline && process.platform === "win32") {
      shellStream.write(
        `\x1b]7;file://${queryHost}${queryDirectory.replaceAll("%", "%25")}\x07`,
      );
    } else if (!readline) {
      fs.mkdirSync(queryDirectory, { recursive: true });
      const result = require("node:child_process").execFileSync(
        "/bin/sh",
        ["-c", query],
        { cwd: queryDirectory },
      );
      shellStream.write(result);
    }
    await w.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 50; i++) {
        if (document.querySelector('#remote-path').value === ${JSON.stringify(queryDirectory)}) return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('Directory query did not open the active Shell path');
    })()`);
    fixture.dirs.add("/home/jay/projects/测试 100%");
    shellStream.write("\x1b]7;file://test/home/jay/projects/");
    shellStream.write(encodeURIComponent("测试 100%") + "\x07");
    await w.webContents.executeJavaScript(`(async () => {
      await new Promise(r => setTimeout(r, 150));
      document.querySelector('#sync-cwd').click();
      for (let i = 0; i < 50; i++) {
        if (document.querySelector('#remote-path').value === '/home/jay/projects/测试 100%') return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('SSH directory sync did not resolve the encoded path');
    })()`);
    shellStream.write("\x1b]7;file://test/home/jay\x07");
    await w.webContents.executeJavaScript(`(async () => {
      await new Promise(r => setTimeout(r, 150));
      document.querySelector('#sync-cwd').click();
      for (let i = 0; i < 50; i++) {
        if (document.querySelector('#file-list').textContent.includes('README.md')) return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('SSH directory sync did not return to the root of the fixture');
    })()`);
    markStage("native file drop and recursive folder transfers");
    const upload = path.resolve(".codex-cache/qa/drop.txt");
    fs.writeFileSync(upload, "native file drop test");
    await w.webContents.executeJavaScript(
      `(()=>{const input=document.createElement('input');input.type='file';input.id='qa-file';input.hidden=true;document.body.append(input);})()`,
    );
    w.webContents.debugger.attach("1.3");
    const documentTree =
      await w.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await w.webContents.debugger.sendCommand(
      "DOM.querySelector",
      { nodeId: documentTree.root.nodeId, selector: "#qa-file" },
    );
    await w.webContents.debugger.sendCommand("DOM.setFileInputFiles", {
      nodeId,
      files: [upload],
    });
    await w.webContents.executeJavaScript(`(async()=>{
      const data=new DataTransfer();data.items.add(document.querySelector('#qa-file').files[0]);
      const list=document.querySelector('#file-list');
      const folder=list.querySelector('[data-directory="/home/jay/projects"]');
      const dispatch=(target,type)=>target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data}));
      dispatch(list,'dragover');
      if(!list.classList.contains('drop-active'))throw new Error('Current directory should highlight');
      dispatch(folder.querySelector('.filename'),'dragover');
      if(list.classList.contains('drop-active')||!folder.classList.contains('drop-active'))throw new Error('Only hovered folder should highlight');
      dispatch(folder,'drop');
      if(document.querySelector('.drop-active'))throw new Error('Drop highlight not cleared');
      for(let i=0;i<80;i++){
        await new Promise(r=>setTimeout(r,50));
        if(document.querySelector('#transfer-status').textContent.startsWith('完成'))break;
      }
      dispatch(list,'drop');
      for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));if(document.querySelector('#file-list').textContent.includes('drop.txt'))return;}
      throw new Error('Native file drag upload failed: '+document.querySelector('#transfer-status').textContent);
    })()`);
    w.webContents.debugger.detach();
    if (
      fixture.files.get("/home/jay/drop.txt")?.toString() !==
      "native file drop test"
    )
      throw new Error("Dropped bytes differ");
    if (
      fixture.files.get("/home/jay/projects/drop.txt")?.toString() !==
      "native file drop test"
    )
      throw new Error("Subdirectory drop did not match the highlighted target");
    const tree = path.resolve(".codex-cache/qa/upload-tree");
    fs.mkdirSync(path.join(tree, "nested", "empty"), { recursive: true });
    fs.writeFileSync(
      path.join(tree, "nested", "中文.txt"),
      "directory UI round trip",
    );
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [tree],
    });
    await w.webContents.executeJavaScript(`(async()=>{
      document.querySelector('#upload').click();
      if(!document.querySelector('#upload-options').matches(':popover-open'))throw new Error('Upload menu failed');
      document.querySelector('#upload-directory').click();
      for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));if(document.querySelector('#file-list').textContent.includes('upload-tree'))return;}
      throw new Error('Folder upload failed: '+document.querySelector('#transfer-status').textContent);
    })()`);
    if (!fixture.dirs.has("/home/jay/upload-tree/nested/empty"))
      throw new Error("Empty directory missing");
    const download = path.resolve(".codex-cache/qa/downloads");
    fs.mkdirSync(download, { recursive: true });
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [download],
    });
    await w.webContents.executeJavaScript(`(async()=>{
      const row=[...document.querySelectorAll('.file-row')].find(r=>r.textContent.includes('upload-tree'));
      row.querySelector('button').click();
      for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));if(document.querySelector('#transfer-status').textContent.startsWith('完成'))return;}
      throw new Error('Folder download failed: '+document.querySelector('#transfer-status').textContent);
    })()`);
    w.webContents.send("ssh:event", {
      type: "progress", id: await w.webContents.executeJavaScript("window.__qaConnectionId"),
      files: 1, name: "/home/jay/upload-tree/nested/中文.txt", current: 1, total: 1,
    });
    await w.webContents.executeJavaScript(`(async()=>{
      await new Promise(resolve=>setTimeout(resolve,50));
      if(!document.querySelector('#transfer-status').textContent.startsWith('完成'))
        throw new Error('Late progress overwrote download completion');
    })()`);
    if (
      fs.readFileSync(
        path.join(download, "upload-tree", "nested", "中文.txt"),
        "utf8",
      ) !== "directory UI round trip"
    )
      throw new Error("Downloaded bytes differ");
    if (process.env.JAYXTERM_MULTIWINDOW_QA === "1")
      await runCheck("multiple windows", "./multiwindow-check.cjs", w, fixture);
    if (process.env.JAYXTERM_WORKSPACE_QA === "1")
      await runCheck("split workspace", "./workspace-check.cjs", w, fixture);
    if (process.env.JAYXTERM_SETTINGS_QA === "1")
      await runCheck("settings", "./settings-check.cjs", w);
    if (process.env.JAYXTERM_SETTINGS_QA === "1")
      await runCheck("terminal settings", "./terminal-settings-check.cjs", w, fixture);
    if (process.env.JAYXTERM_SETTINGS_QA === "1")
      await runCheck("local fonts and separate CJK fonts", "./font-picker-check.cjs", w, fixture);
    if (process.env.JAYXTERM_SESSION_EXCHANGE_QA === "1")
      await runCheck("session import/export", "./session-exchange-check.cjs", w);
    if (process.env.JAYXTERM_ASSIST_QA === "1") {
      await runCheck("conservative local echo with delayed SSH", "./terminal-echo-check.cjs", w, fixture);
      await runCheck("keyword highlights, terminal search and file icons", "./terminal-assistance-check.cjs", w, fixture);
      await runCheck("quick password vault and prompt suggestions", "./quick-passwords-check.cjs", w, fixture);
    }
    if (process.env.JAYXTERM_FEATURES_QA === "1")
      await runCheck(
        "themes, remote deletion and session duplication",
        "./features-check.cjs",
        w,
        fixture,
      );
    markStage("cleanup");
    await w.webContents.executeJavaScript(
      `(()=>{for(const button of document.querySelectorAll('.tab .close'))button.click();})()`,
    );
    fixture.close();
    console.log(
      "PASS: Electron UI, encrypted credentials, SSH, left explorer, native file drop, recursive folder upload and download",
    );
    clearTimeout(deadline);
    app.exit(0);
  } catch (e) {
    console.error(`Application smoke test failed during: ${stage}`);
    console.error(e);
    clearTimeout(deadline);
    app.exit(1);
  }
});
