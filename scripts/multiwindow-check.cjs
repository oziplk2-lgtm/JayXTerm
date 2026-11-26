const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BrowserWindow } = require("electron");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Multi-window check timed out");
}
async function check(source, fixture) {
  const id = await source.webContents.executeJavaScript(
    "window.__qaConnectionId",
  );
  const auth = fixture.authenticated;
  const sourceId = source.webContents.id;
  const text = (w) =>
    w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.terminal-pane.active .xterm-rows > div'),r=>r.textContent).join('')`,
    );
  const benchmark = async (w) => {
    w.show();
    w.focus();
    await delay(500);
    return w.webContents.executeJavaScript(`(async()=>{
   const samples=[];let resolve,token,started,received='';
   const unsubscribe=window.api.onEvent(m=>{if(m.type==='data'&&m.id===${JSON.stringify(id)}){received+=typeof m.text==='string'?m.text:atob(m.data);if(resolve&&received.includes(token)){const done=resolve;resolve=null;done(performance.now()-started);}}});
   try{for(let i=0;i<120;i++){token='PERF_'+i+'_'+Math.random().toString(36).slice(2);received='';samples.push(await new Promise((r,j)=>{const timeout=setTimeout(()=>j(new Error('Echo timeout')),3000);resolve=n=>{clearTimeout(timeout);r(n);};started=performance.now();window.api.send({type:'input',id:${JSON.stringify(id)},data:': '+token+'\\r'});}));}}
   finally{unsubscribe();}samples.sort((a,b)=>a-b);return {p50:samples[60],p95:samples[114]};
 })()`);
  };
  const baseline = await benchmark(source);
  const idle = [];
  for (let i = 0; i < 3; i++) {
    const wid = await source.webContents.executeJavaScript(
      "window.api.newWindow()",
    );
    const w = await waitFor(() =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.id === wid),
    );
    await w.frontendReady;
    await w.webContents.executeJavaScript(
      `window.__unexpectedOutput=0;window.api.onEvent(m=>{if(m.type==='data'&&m.id===${JSON.stringify(id)})window.__unexpectedOutput++;});void 0;`,
    );
    idle.push(w);
  }
  const withIdle = await benchmark(source);
  for (const w of idle)
    assert.equal(
      await w.webContents.executeJavaScript("window.__unexpectedOutput"),
      0,
      "terminal output must not be broadcast to idle windows",
    );
  // Session changes are shared only on mutations, not by polling.
  await source.webContents.executeJavaScript(
    `window.api.save({name:'跨窗口共享配置',host:'127.0.0.1',username:'qa',remember:false})`,
  );
  await waitFor(() =>
    idle[0].webContents.executeJavaScript(
      `document.querySelector('#sessions').textContent.includes('跨窗口共享配置')`,
    ),
  );
  // Inject a failed destination restore; the original connection must remain usable.
  await idle[2].webContents.executeJavaScript(
    `(()=>{const off=window.api.onWindow(m=>{if(m.type==='request'&&m.action==='restore'){off();window.api.windowReply({token:m.token,error:'QA destination restore failure'});}});})()`,
  );
  const rejected = await source.webContents.executeJavaScript(
    `window.api.moveTab({id:${JSON.stringify(id)},target:${idle[2].webContents.id}}).then(()=>'',e=>e.message)`,
  );
  assert.ok(rejected.includes("QA destination restore failure"));
  await source.webContents.executeJavaScript(
    `window.api.send({type:'input',id:${JSON.stringify(id)},data:': ROLLBACK_STILL_CONNECTED\\r'})`,
  );
  await waitFor(async () =>
    (await text(source)).includes("ROLLBACK_STILL_CONNECTED"),
  );
  assert.equal(fixture.authenticated, auth);
  const target = idle[0];
  target.setSize(1100, 750);
  await delay(150);
  await source.webContents.executeJavaScript(
    `window.api.send({type:'input',id:${JSON.stringify(id)},data:': MOVE_KEEP_中文\\r'})`,
  );
  await delay(150);
  const firstMove = Date.now();
  let firstMoveMs;
  await source.webContents.executeJavaScript(
    `window.api.moveTab({id:${JSON.stringify(id)},target:${target.webContents.id}})`,
  );
  firstMoveMs = Date.now() - firstMove;
  assert.ok(firstMoveMs < 15000, "existing-window move took too long");
  assert.equal(
    await source.webContents.executeJavaScript(
      'document.querySelectorAll(".tab").length',
    ),
    0,
  );
  try{await waitFor(async () => (await text(target)).includes("MOVE_KEEP_中文"));}catch(error){fs.writeFileSync(path.resolve('.codex-cache/qa/move-failure.png'),(await target.webContents.capturePage()).toPNG());fs.writeFileSync(path.resolve('.codex-cache/qa/move-failure.txt'),await text(target));throw error;}
  assert.equal(
    fixture.authenticated,
    auth,
    "moving must not authenticate or reconnect",
  );
  const geometry = await target.webContents.executeJavaScript(
    `(()=>{const p=document.querySelector('.terminal-pane.active');return {cols:Number(p.dataset.cols),rows:Number(p.dataset.rows)}})()`,
  );
  await waitFor(() => {
    const size = fixture.sizes.at(-1);
    return size?.cols === geometry.cols && size.rows === geometry.rows;
  });
  // The old owner must not be able to type into the moved terminal.
  await source.webContents.executeJavaScript(
    `window.api.send({type:'input',id:${JSON.stringify(id)},data:'WRONG_OWNER_INPUT'})`,
  );
  await delay(100);
  assert.ok(!(await text(target)).includes("WRONG_OWNER_INPUT"));
  // Changing remote directory in the destination must preserve real SFTP access.
  await target.webContents.executeJavaScript(
    `document.querySelector('#mode-files').click(); document.querySelector('#remote-path').value='/home/jay/projects';document.querySelector('#path-form').requestSubmit()`,
  );
  await waitFor(() =>
    target.webContents.executeJavaScript(
      `document.querySelector('#remote-path').value==='/home/jay/projects' && document.querySelector('#file-list').textContent.includes('drop.txt')`,
    ),
  );
  // Exercise the visible detach action, rather than only the internal IPC API.
  await target.webContents.executeJavaScript(
    `document.querySelector('#move-tab').onclick()`,
  );
  const detached = await waitFor(() =>
    BrowserWindow.getAllWindows().find((w) => ![source, ...idle].includes(w)),
  );
  await detached.frontendReady;
  await waitFor(async () => (await text(detached)).includes("MOVE_KEEP_中文"));
  assert.equal(
    await detached.webContents.executeJavaScript(
      'document.querySelector("#remote-path").value',
    ),
    "/home/jay/projects",
  );
  assert.equal(fixture.authenticated, auth);
  // Closing an empty original window must leave the moved connection alive.
  target.close();
  await waitFor(() => target.isDestroyed());
  await detached.webContents.executeJavaScript(
    `window.api.send({type:'input',id:${JSON.stringify(id)},data:': SURVIVED_OTHER_CLOSE\\r'})`,
  );
  await waitFor(async () =>
    (await text(detached)).includes("SURVIVED_OTHER_CLOSE"),
  );
  // Move back and close a window which owns a different live connection.
  await detached.webContents.executeJavaScript(
    `window.api.moveTab({id:${JSON.stringify(id)},target:${sourceId}})`,
  );
  await waitFor(async () =>
    (await text(source)).includes("SURVIVED_OTHER_CLOSE"),
  );
  const session = await source.webContents.executeJavaScript(
    `(async()=> (await window.api.sessions()).find(s=>s.name==='本地验收服务器'))()`,
  );
  await idle[1].webContents.executeJavaScript(
    `window.api.connect({sessionId:${JSON.stringify(session.id)}})`,
  );
  await delay(150);
  idle[1].close();
  await waitFor(() => idle[1].isDestroyed());
  await source.webContents.executeJavaScript(
    `window.api.send({type:'input',id:${JSON.stringify(id)},data:': ISOLATED_WINDOW_CLOSE\\r'})`,
  );
  await waitFor(async () =>
    (await text(source)).includes("ISOLATED_WINDOW_CLOSE"),
  );
  const report = {
    note: "Local software-rendered Electron / loopback SSH; transport echo latency excludes terminal paint and is not a Windows production benchmark.",
    baseline,
    threeIdleWindows: withIdle,
    existingWindowMoveMs: firstMoveMs,
    terminalOutputToUnownedWindows: 0,
  };
  fs.writeFileSync(
    path.resolve(
      process.env.JAYXTERM_VIM_QA
        ? ".codex-cache/qa/multiwindow-vim-metrics.json"
        : ".codex-cache/qa/multiwindow-metrics.json",
    ),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.resolve(".codex-cache/qa/multiwindow.png"),
    (await source.webContents.capturePage()).toPNG(),
  );
  await source.webContents.executeJavaScript(
    `document.querySelector('#window-picker').click()`,
  );
  await waitFor(() =>
    source.webContents.executeJavaScript(
      `document.querySelector('#windows-dialog').open`,
    ),
  );
  fs.writeFileSync(
    path.resolve(".codex-cache/qa/window-manager.png"),
    (await source.webContents.capturePage()).toPNG(),
  );
  await source.webContents.executeJavaScript(
    `document.querySelector('#windows-close').click()`,
  );
  detached.close();
  idle[2].close();
  console.log(
    "PASS: multi-window ownership, shared sessions, detach/merge without reconnect, SFTP state, close isolation and no output broadcasts",
  );
  console.log(
    "Echo transport latency (ms): " +
      JSON.stringify({ baseline, threeIdleWindows: withIdle }),
  );
}
async function roundTrip(source, fixture) {
  const id = await source.webContents.executeJavaScript(
    "window.__qaConnectionId",
  );
  const auth = fixture.authenticated;
  const existing = BrowserWindow.getAllWindows();
  await source.webContents.executeJavaScript(
    `window.api.moveTab({id:${JSON.stringify(id)}})`,
  );
  const target = BrowserWindow.getAllWindows().find(
    (w) => !existing.includes(w),
  );
  assert.ok(target);
  await waitFor(() =>
    target.webContents.executeJavaScript(
      `document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('新增中文')`,
    ),
  );
  target.setSize(1100, 750);
  await delay(250);
  await target.webContents.executeJavaScript(
    `window.api.moveTab({id:${JSON.stringify(id)},target:${source.webContents.id}})`,
  );
  assert.equal(fixture.authenticated, auth, "moving Vim must not reconnect");
  target.close();
  await delay(200);
  console.log(
    "PASS: active GBK Vim survives detach and merge without reconnect",
  );
}
module.exports = { check, roundTrip };
