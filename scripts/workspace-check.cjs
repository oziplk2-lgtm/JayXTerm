const { BrowserWindow } = require("electron");
const { createFixture } = require("./ssh-fixture.cjs");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, message) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await pause(60);
  }
  throw new Error(message);
}
const js = (window, source) => window.webContents.executeJavaScript(source);
async function check(window, source) {
  const nativeDrag = (await js(window, "window.api.localDragAvailable()")) === true;
  const relayTarget = path.resolve(".codex-cache/qa/local-drag-relay-target");
  const dragLog = path.resolve(".codex-cache/qa/local-drag.jsonl");
  const previousDrags = nativeDrag && fs.existsSync(dragLog)
    ? fs.readFileSync(dragLog, "utf8").trim().split("\n").length : 0;
  if (nativeDrag) fs.writeFileSync(relayTarget, "relay");
  const target = createFixture();
  const large = randomBytes(1024 * 1024 + 13);
  source.files.set("/home/jay/测试 relay:latest.bin", large);
  source.files.set("/home/jay/upload-tree/nested/remote:only.txt", Buffer.from("POSIX name"));
  await new Promise((resolve) => target.server.listen(0, "127.0.0.1", resolve));
  let other;
  try {
    const name = "SFTP 验收服务器";
    await js(
      window,
      `(async()=> {
      document.querySelector('#new').click();
      const f=document.querySelector('#session-form');
      f.elements.name.value=${JSON.stringify(name)};f.elements.host.value='127.0.0.1';
      f.elements.port.value=${target.server.address().port};f.elements.username.value='jay';
      f.elements.password.value='qa-password';f.requestSubmit();
      for(let i=0;i<40&&document.querySelector('#editor').open;i++)
        await new Promise(r=>setTimeout(r,50));
      if(document.querySelector('#editor').open)throw new Error('Could not save target');
    })()`,
    );
    const connect = `[...document.querySelectorAll('.session')].find(row=>row.textContent.includes(${JSON.stringify(name)}))?.querySelector('button')?.click()`;
    other = await (async () => {
      const id = await js(window, "window.api.newWindow()");
      return BrowserWindow.getAllWindows().find(
        (item) => item.webContents.id === id,
      );
    })();
    await other.frontendReady;
    await waitFor(
      () =>
        js(
          other,
          `document.querySelector('#sessions').textContent.includes(${JSON.stringify(name)})`,
        ),
      "New window did not load sessions",
    );
    await js(other, connect);
    await waitFor(
      () =>
        js(
          other,
          `!!document.querySelector('#file-list [data-directory="/home/jay/projects"]')`,
        ),
      "Target window did not connect",
    );
    await js(
      window,
      `document.querySelector('#remote-path').value='/home/jay';document.querySelector('#path-form').requestSubmit()`,
    );
    await waitFor(
      () =>
        js(
          window,
          `document.querySelector('#file-list').textContent.includes('测试 relay:latest.bin')`,
        ),
      "Source file did not load",
    );
    const token = await js(
      window,
      `(() => {
      const row=[...document.querySelectorAll('#file-list .file-row')].find(r=>r.textContent.includes('测试 relay:latest.bin'));
      const data=new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));
      return 'jayxterm-sftp:' + data.getData('application/x-jayxterm-sftp');
    })()`,
    );
    assert.ok(token.startsWith("jayxterm-sftp:"));
    await js(
      other,
      `(() => {
      const data=new DataTransfer(); data.setData('text/plain',${JSON.stringify(token)});
      const folder=document.querySelector('#file-list [data-directory="/home/jay/projects"]');
      folder.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));
    })()`,
    );
    await waitFor(
      () =>
        js(
          other,
          `document.querySelector('#transfer-status').textContent.startsWith('完成')`,
        ),
      "Cross-window file transfer failed",
    );
    assert.deepEqual(
      target.files.get("/home/jay/projects/测试 relay:latest.bin"),
      large,
    );
    if (nativeDrag) {
      const result = JSON.parse(fs.readFileSync(dragLog, "utf8").trim().split("\n").at(-1));
      assert.equal(result.relayText, token, "The native helper lost the internal relay token");
      assert.deepEqual(result.files, [], "An internal drop must not download virtual file contents first");
    }
    await js(window, `(() => {
      const button = document.querySelector('#file-workspace-toggle');
      button.click();
      if (document.querySelector('#terminal-area').dataset.count !== '1' ||
          document.querySelectorAll('.terminal-group .workspace-files').length !== 1 ||
          !document.querySelector('.workspace-files .file-list').textContent.includes('测试 relay:latest.bin'))
        throw new Error('Single-pane file space did not reuse the current session');
      button.click();
    })()`);
    await js(
      window,
      `document.querySelector('#mode-sessions').click(); ${connect}`,
    );
    await waitFor(
      () =>
        js(
          window,
          `document.querySelectorAll('.tab').length===2 && document.querySelector('#status').textContent.includes('已连接')`,
        ),
      "Second tab did not connect",
    );
    const authCount = target.authenticated;
    await js(
      window,
      `(() => {
      const toggle = document.querySelector('#file-workspace-toggle');
      const geometry = () => Array.from(document.querySelectorAll('.terminal-group'), group => {
        const { x, y, width, height } = group.getBoundingClientRect();
        return [x, y, width, height];
      });
      for (let count = 2; count <= 4; count++) {
        document.querySelector('#split-add').click();
        const before = JSON.stringify(geometry());
        toggle.click();
        if (document.querySelectorAll('.terminal-group .workspace-files').length !== count ||
            JSON.stringify(geometry()) !== before)
          throw new Error('File space changed the geometry of ' + count + ' panes');
        toggle.click();
      }
      document.querySelector('#split-add').click();
      const groups=document.querySelectorAll('.terminal-group');
      if(groups.length!==4)throw new Error('Split limit is incorrect');
      const t=[...document.querySelectorAll('.tab')].find(tab=>tab.textContent.includes(${JSON.stringify(name)}));
      const data=new DataTransfer();
      t.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));
      groups[3].querySelector('.tabs').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));
      if(!groups[3].querySelector('.terminal-pane.active') || !groups[3].querySelector('.tabs').contains(t))
        throw new Error('Tab and terminal were not moved to the destination pane');
    })()`,
    );
    assert.equal(
      target.authenticated,
      authCount,
      "Moving a tab must not reconnect",
    );
    await waitFor(
      () => js(window, `[...document.querySelectorAll('.terminal-pane.active')].every(pane => {
        const viewport = pane.querySelector('.xterm').getBoundingClientRect();
        const screen = pane.querySelector('.xterm-screen').getBoundingClientRect();
        return screen.height > 0 && screen.bottom <= viewport.bottom + 1 &&
          screen.right <= viewport.right + 1;
      })`),
      "Terminal rows and columns overflow after moving a tab into a split",
    );
    await js(
      window,
      `document.querySelector('.terminal-group .tabs .tab-select').click()`,
    );
    assert.ok(
      await js(
        window,
        `document.querySelector('#file-list').textContent.includes('upload-tree')`,
      ),
      "Sidebar did not follow the focused pane",
    );
    assert.equal(
      await js(
        window,
        `document.querySelectorAll('.terminal-pane.active').length`,
      ),
      2,
      "Focusing a pane hid the other terminal",
    );
    const leftDirectory = "/home/jay/当前构建";
    const rightDirectory = "/home/jay/当前测试";
    source.dirs.add(leftDirectory);
    target.dirs.add(rightDirectory);
    const leftStream = [...source.streams][0];
    const reportDirectory = (dir) => leftStream.write("\x1b]7;file://fixture" +
      dir.split("/").map(encodeURIComponent).join("/") + "\x07");
    reportDirectory(leftDirectory);
    target.directory.path = rightDirectory;
    const beforeInput = [source.inputs.length, target.inputs.length];
    await pause(100);
    await js(window, "document.querySelector('#file-workspace-toggle').click()");
    await waitFor(() => js(window,
      `[...document.querySelectorAll('.workspace-files input')].filter(input => input.offsetWidth > 0)
        .map(input => input.value).join('|') === ${JSON.stringify(leftDirectory + "|" + rightDirectory)}`),
    "File space did not follow both active SSH directories");
    assert.equal(target.directory.queries, 1, "Directory probe should run once for the non-reporting pane");
    assert.deepEqual([source.inputs.length, target.inputs.length], beforeInput, "File space wrote to a terminal");
    await js(window, "document.querySelector('#file-workspace-toggle').click()");
    reportDirectory("/home/jay");
    target.directory.path = "/home/jay";
    await pause(100);
    await js(
      window,
      `document.querySelector('#file-workspace-toggle').click()`,
    );
    await waitFor(
      () =>
        js(
          window,
          `document.querySelector('.terminal-group:first-child .workspace-files .file-list').textContent.includes('upload-tree') &&
            !!document.querySelector('.terminal-group:last-child .workspace-files [data-directory="/home/jay/projects"]')`,
        ),
      "Split file panels did not load",
    );
    await js(
      window,
      `(() => {
      const panels=[...document.querySelectorAll('.terminal-group .workspace-files')];
      const [sourcePanel, firstEmpty, secondEmpty, targetPanel] = panels;
      if (![firstEmpty, secondEmpty].every(panel => !panel.querySelector('.group-empty').classList.contains('hidden')))
        throw new Error('Empty splits claimed a connection');
      const folder = targetPanel.querySelector('[data-directory="/home/jay/projects"]');
      if (!folder) throw new Error('Target pane did not follow its terminal tab');
      const row=[...sourcePanel.querySelectorAll('[data-directory]')].find(r=>r.dataset.directory.endsWith('/upload-tree'));
      const data=new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));
      folder.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));
    })()`,
    );
    await waitFor(
      () =>
        js(
          window,
          `document.querySelector('.terminal-group:last-child .workspace-files .transfer-status').textContent.startsWith('完成')`,
        ),
      "Split-pane directory transfer failed",
    );
    assert.equal(
      target.files.get("/home/jay/projects/upload-tree/nested/中文.txt")?.toString(),
      "directory UI round trip",
    );
    assert.ok(target.dirs.has("/home/jay/projects/upload-tree/nested/empty"));
    assert.equal(target.files.get("/home/jay/projects/upload-tree/nested/remote:only.txt")?.toString(), "POSIX name");
    await js(window, `document.querySelector('.terminal-group:last-child .workspace-files [data-directory="/home/jay/projects"]').click()`);
    await waitFor(
      () => js(window, `document.querySelector('.terminal-group:last-child .workspace-files input').value === '/home/jay/projects'`),
      "Opening a directory did not update the target pane path",
    );
    await js(
      window,
      `document.querySelector('#file-workspace-toggle').click()`,
    );
    assert.equal(
      await js(window, `document.querySelectorAll('.terminal-group').length`),
      4,
    );
    await js(window, `(() => {
      const groups = document.querySelectorAll('.terminal-group');
      groups[3].querySelector('.tab-select').click();
      if (document.querySelector('#remote-path').value !== '/home/jay/projects')
        throw new Error('Returning to terminal lost the target SFTP path');
      if (getComputedStyle(groups[3].querySelector('.terminal-pane.active')).display === 'none')
        throw new Error('Returning to terminal did not restore the terminal');
      groups[0].querySelector('.tab-select').click();
    })()`);
    const inputCount = target.inputs.length;
    await js(window, `(() => {
      document.querySelector('.terminal-group:last-child .tab-select').click();
      document.querySelector('#sync-cwd').click();
      if (!document.querySelector('#cwd-dialog').open)
        throw new Error('A new SSH connection must ask before installing the hook');
      document.querySelector('#cwd-query').click();
    })()`);
    const received = () => Buffer.concat(target.inputs.slice(inputCount)).toString("utf8");
    await waitFor(() => received().includes("\r"), "Directory probe did not reach the selected split");
    const probe = received().split("\r")[0];
    const host = /file:\/\/(jayxterm-query-[\da-f-]+)%s/.exec(probe)?.[1];
    assert.ok(host);
    const firstPath = "/home/jay/projects";
    const nextPath = process.platform === "win32"
      ? "/home/jay"
      : path.resolve(".codex-cache/qa");
    target.dirs.add(nextPath);
    const stream = [...target.streams].at(-1);
    stream.write(`\x1b]7;file://${host}${firstPath}\x07`);
    stream.write(`\x1b]7;file://jayxterm-shell${firstPath}\x07`);
    let reports = `\x1b]7;file://jayxterm-shell${nextPath}\x07`;
    if (process.platform !== "win32") {
      reports = execFileSync("/bin/bash", ["--noprofile", "--norc", "-i"], {
        cwd: nextPath,
        env: { ...process.env, HISTFILE: "/dev/null" },
        input: [
          "PROMPT_COMMAND='printf OLD_PROMPT'",
          probe,
          "cd ..",
          "cd qa",
          "exit",
          "",
        ].join("\n"),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert.ok(reports.includes("OLD_PROMPT"), "Existing Bash prompt hook was lost");
      assert.ok(reports.includes(`\x1b]7;file://jayxterm-shell${path.dirname(nextPath)}\x07`),
        "Bash did not report the directory after cd");
      assert.ok(reports.endsWith(`\x1b]7;file://jayxterm-shell${nextPath}\x07`));
    }
    stream.write(reports);
    await js(window, `(() => {
      document.querySelector('.terminal-group:first-child .tab-select').click();
      document.querySelector('#sync-cwd').click();
      if (document.querySelector('#cwd-dialog').open)
        throw new Error('Switching panes discarded the first shell directory');
      document.querySelector('.terminal-group:last-child .tab-select').click();
    })()`);
    await waitFor(async () => {
      await js(window, `(() => {
        document.querySelector('#sync-cwd').click();
        if (document.querySelector('#cwd-dialog').open)
          throw new Error('A reporting shell asked for another confirmation');
      })()`);
      return js(window, `document.querySelector('#remote-path').value === ${JSON.stringify(nextPath)}`);
    }, "Repeated sync did not use the updated directory");
    assert.equal(received(), probe + "\r", "Repeated sync typed another command");
    await js(
      window,
      `(() => {
      const panes = [...document.querySelectorAll('.terminal-group')];
      const source = panes[3];
      const menuButton = source.querySelector('.group-menu-button');
      menuButton.click();
      const menu = source.querySelector('.group-menu');
      if (!menu.matches(':popover-open')) throw new Error('Pane menu did not open');
      menu.querySelector('button').click();
      if (source.isConnected || panes[0].querySelectorAll('.tab').length !== 2)
        throw new Error('Pane merge did not preserve both tabs');
      const tabs = [...panes[0].querySelectorAll('.tab')];
      tabs[1].querySelector('.tab-select').click();
      if (document.querySelector('#focused-sftp').textContent !== ${JSON.stringify(name)})
        throw new Error('Selecting another tab did not update SFTP');
      tabs[1].querySelector('.close').click();
      if (!panes[0].isConnected || panes[0].querySelectorAll('.tab').length !== 1)
        throw new Error('Closing one tab closed its pane or another tab');
    })()`,
    );
    assert.equal(
      target.authenticated,
      authCount,
      "Merging a pane must not reconnect",
    );
    if (nativeDrag) {
      const results = fs.readFileSync(dragLog, "utf8").trim().split("\n").map(JSON.parse).slice(previousDrags);
      assert.equal(results.length, 2, "Both file and directory rows must use native drag");
      for (const result of results) {
        assert.equal(result.status, "copy");
        assert.match(result.relayText, /^jayxterm-sftp:[\da-f-]+$/);
        assert.deepEqual(result.entries, []);
        assert.deepEqual(result.files, []);
      }
    }
    console.log(
      "PASS: one to four shared terminal/file layouts, tab moves, split directory transfer and cross-window binary file transfer",
    );
  } finally {
    fs.rmSync(relayTarget, { force: true });
    if (other && !other.isDestroyed()) other.destroy();
    target.close();
  }
}
module.exports = { check };
