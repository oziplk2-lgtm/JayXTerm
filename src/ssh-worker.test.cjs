const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Server, utils } = require("ssh2");
const { generateKeyPairSync } = require("node:crypto");
const { fork } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { STATUS_CODE } = utils.sftp;
test(
  "real SSH authentication, host verification, UTF-8 echo, flow control and SFTP round trip",
  { timeout: 20000 },
  async () => {
    const key = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ type: "pkcs1", format: "pem" });
    const files = new Map([["/hello.txt", Buffer.from("hello remote")]]);
    const directories = new Set(["/"]);
    const clients = new Set();
    const ptySizes = [],
      windowSizes = [];
    let duringShell;
    const server = new Server({ hostKeys: [key] }, (c) => {
      clients.add(c);
      c.on("close", () => clients.delete(c));
      c.on("error", () => {});
      c.on("authentication", (ctx) =>
        ctx.method === "password" &&
        ctx.username === "tester" &&
        ctx.password === "test-password"
          ? ctx.accept()
          : ctx.reject(),
      );
      c.on("ready", () =>
        c.on("session", (accept) => {
          const session = accept();
          session.on("pty", (accept, _reject, info) => {
            ptySizes.push({ cols: info.cols, rows: info.rows });
            accept();
          });
          session.on("window-change", (accept, _reject, info) => {
            windowSizes.push({ cols: info.cols, rows: info.rows });
            accept?.();
          });
          session.on("shell", (accept) => {
            duringShell?.();
            setTimeout(() => {
              const stream = accept();
              stream.on("data", (d) => stream.write(d));
            }, 25);
          });
          session.on("sftp", (accept) => {
            const sftp = accept();
            const handles = new Map();
            let next = 1;
            const handle = (entry) => {
              const h = Buffer.alloc(4);
              h.writeUInt32BE(next++);
              handles.set(h.toString("hex"), entry);
              return h;
            };
            const attrs = (file) => ({
              mode: 0o100644,
              uid: 0,
              gid: 0,
              size: file.length,
              atime: 0,
              mtime: 0,
            });
            sftp.on("REALPATH", (id, p) =>
              sftp.name(id, [
                { filename: "/", longname: "/", attrs: { mode: 0o40755 } },
              ]),
            );
            sftp.on("OPENDIR", (id, p) =>
              sftp.handle(id, handle({ dir: true, path: p, read: false })),
            );
            sftp.on("READDIR", (id, h) => {
              const entry = handles.get(h.toString("hex"));
              if (entry.read) return sftp.status(id, STATUS_CODE.EOF);
              entry.read = true;
              const listing = [];
              for (const dir of directories)
                if (dir !== "/" && path.posix.dirname(dir) === entry.path)
                  listing.push({
                    filename: path.posix.basename(dir),
                    longname: dir,
                    attrs: { mode: 0o40755, size: 0, mtime: 0 },
                  });
              for (const [name, data] of files)
                if (path.posix.dirname(name) === entry.path)
                  listing.push({
                    filename: path.posix.basename(name),
                    longname: name,
                    attrs: attrs(data),
                  });
              sftp.name(id, listing);
            });
            for (const op of ["STAT", "LSTAT"])
              sftp.on(op, (id, p) =>
                directories.has(p)
                  ? sftp.attrs(id, { mode: 0o40755, size: 0, mtime: 0 })
                  : files.has(p)
                    ? sftp.attrs(id, attrs(files.get(p)))
                    : sftp.status(id, STATUS_CODE.NO_SUCH_FILE),
              );
            sftp.on("MKDIR", (id, p) => {
              directories.add(p);
              sftp.status(id, STATUS_CODE.OK);
            });
            sftp.on("OPEN", (id, p, flags) => {
              if (flags & 8) files.set(p, Buffer.alloc(0));
              if (!files.has(p))
                return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
              sftp.handle(id, handle({ path: p }));
            });
            sftp.on("FSTAT", (id, h) =>
              sftp.attrs(
                id,
                attrs(files.get(handles.get(h.toString("hex")).path)),
              ),
            );
            sftp.on("READ", (id, h, offset, length) => {
              const data = files.get(handles.get(h.toString("hex")).path);
              if (offset >= data.length) sftp.status(id, STATUS_CODE.EOF);
              else sftp.data(id, data.subarray(offset, offset + length));
            });
            sftp.on("WRITE", (id, h, offset, data) => {
              const p = handles.get(h.toString("hex")).path;
              const old = files.get(p);
              const out = Buffer.alloc(
                Math.max(old.length, offset + data.length),
              );
              old.copy(out);
              data.copy(out, offset);
              files.set(p, out);
              sftp.status(id, STATUS_CODE.OK);
            });
            sftp.on("CLOSE", (id, h) => {
              handles.delete(h.toString("hex"));
              sftp.status(id, STATUS_CODE.OK);
            });
          });
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const worker = fork(path.join(__dirname, "ssh-worker.cjs"), [], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const inbox = [];
    const waiters = [];
    const send = (m) => worker.send(m);
    worker.on("message", (m) => {
      if (m.type === "data") send({ type: "ack", id: m.id, bytes: m.bytes });
      const i = waiters.findIndex((w) => w.p(m));
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.r(m);
      } else inbox.push(m);
    });
    const wait = (p) => {
      const i = inbox.findIndex(p);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((r, j) => {
        const w = {
          p,
          r,
          timer: setTimeout(
            () => j(new Error("Timed out; inbox: " + JSON.stringify(inbox))),
            7000,
          ),
        };
        waiters.push(w);
      });
    };
    const connect = (id, password = "test-password") =>
      send({
        type: "connect",
        id,
        config: {
          host: "127.0.0.1",
          port: server.address().port,
          username: "tester",
        },
        password,
        test: id === "probe",
      });
    const rpc = async (action, p, local) => {
      const rid = Math.random().toString();
      send({ type: "sftp", id: "one", rid, action, path: p, local });
      const m = await wait((m) => m.rid === rid && m.type === "result");
      assert.equal(m.error, undefined);
      return m.result;
    };
    const dir = fs.mkdtempSync(path.resolve(".codex-cache/tmp/ssh-"));
    try {
      connect("reject");
      const rejected = await wait(
        (m) => m.id === "reject" && m.type === "hostkey",
      );
      assert.match(rejected.fingerprint, /^SHA256:/);
      send({ type: "verify", id: "reject", accept: false });
      await wait((m) => m.id === "reject" && m.type === "error");
      connect("bad", "wrong-password");
      await wait((m) => m.id === "bad" && m.type === "hostkey");
      send({ type: "verify", id: "bad", accept: true });
      await wait((m) => m.id === "bad" && m.type === "error");
      connect("probe");
      await wait((m) => m.id === "probe" && m.type === "hostkey");
      send({ type: "verify", id: "probe", accept: true });
      const probe = await wait(
        (m) => m.id === "probe" && m.type === "test-result",
      );
      assert.deepEqual(probe.result, {
        ssh: true,
        sftp: true,
        message: "SSH 认证和 SFTP 均成功",
      });
      assert.equal(
        ptySizes.length,
        0,
        "test connection must not create a terminal",
      );
      duringShell = () =>
        send({ type: "resize", id: "one", cols: 155, rows: 43 });
      connect("one");
      await wait((m) => m.id === "one" && m.type === "hostkey");
      send({ type: "resize", id: "one", cols: 137, rows: 41 });
      send({ type: "verify", id: "one", accept: true });
      await wait((m) => m.id === "one" && m.type === "ready");
      assert.deepEqual(
        ptySizes.at(-1),
        { cols: 137, rows: 41 },
        "pre-handshake resize must determine initial PTY size",
      );
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(
        windowSizes.at(-1),
        { cols: 155, rows: 43 },
        "resize during shell creation must be replayed",
      );
      send({ type: "resize", id: "one", cols: 81, rows: 26 });
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(
        windowSizes.at(-1),
        { cols: 81, rows: 26 },
        "connected PTY must follow window changes",
      );
      const dataText = (m) => typeof m.text === "string" ? m.text : Buffer.from(m.data, "base64").toString();
      send({ type: "input", id: "one", data: "中文 echo\r" });
      const echo = await wait((m) => m.id === "one" && m.type === "data");
      assert.equal(dataText(echo), "中文 echo\r");
      send({
        type: "encoding",
        id: "one",
        rid: "encoding-gbk",
        encoding: "gbk",
      });
      await wait((m) => m.rid === "encoding-gbk");
      send({ type: "input", id: "one", data: "中文 GBK 回显\r" });
      const gbkEcho = await wait((m) => m.id === "one" && m.type === "data");
      assert.equal(
        dataText(gbkEcho),
        "中文 GBK 回显\r",
      );
      send({
        type: "encoding",
        id: "one",
        rid: "encoding-utf8",
        encoding: "utf-8",
      });
      await wait((m) => m.rid === "encoding-utf8");
      send({ type: "freeze", id: "one", rid: "freeze-test" });
      await wait((m) => m.rid === "freeze-test");
      send({ type: "input", id: "one", data: "FROZEN_OUTPUT" });
      send({ type: "ack", id: "one", bytes: 999999 });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(
        inbox.some(
          (m) =>
            m.id === "one" &&
            m.type === "data" &&
            dataText(m).includes("FROZEN_OUTPUT"),
        ),
        false,
        "ACK must not resume output during a handoff",
      );
      send({ type: "thaw", id: "one" });
      const thawed = await wait((m) => m.id === "one" && m.type === "data");
      assert.equal(
        dataText(thawed),
        "FROZEN_OUTPUT",
      );
      const burst = "x".repeat(600000);
      send({ type: "input", id: "one", data: burst });
      let received = 0;
      while (received < burst.length) {
        const m = await wait((m) => m.id === "one" && m.type === "data");
        received += m.bytes;
      }
      assert.equal(received, burst.length);
      const listing = await rpc("list", ".");
      assert.equal(listing.path, "/");
      assert.equal(listing.files[0].name, "hello.txt");
      const local = path.join(dir, "upload.txt");
      fs.writeFileSync(local, "往返文件\n" + burst);
      await rpc("upload", "/upload.txt", local);
      const downloaded = path.join(dir, "download.txt");
      await rpc("download", "/upload.txt", downloaded);
      assert.deepEqual(fs.readFileSync(downloaded), fs.readFileSync(local));
      const source = path.join(dir, "tree");
      fs.mkdirSync(path.join(source, "nested", "empty"), { recursive: true });
      fs.writeFileSync(
        path.join(source, "nested", "中文.txt"),
        "recursive content",
      );
      fs.writeFileSync(path.join(source, "root.txt"), "root");
      const uploaded = await rpc("upload", "/tree", source);
      assert.equal(uploaded.files, 2);
      assert.equal(directories.has("/tree/nested/empty"), true);
      const target = path.join(dir, "tree-copy");
      await rpc("download", "/tree", target);
      assert.equal(
        fs.readFileSync(path.join(target, "nested", "中文.txt"), "utf8"),
        "recursive content",
      );
      assert.equal(
        fs.statSync(path.join(target, "nested", "empty")).isDirectory(),
        true,
      );
      send({ type: "disconnect", id: "one" });
      await wait((m) => m.id === "one" && m.type === "closed");
    } finally {
      worker.kill();
      for (const c of clients) {
        c.end();
        c._sock?.destroy();
      }
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
      for (const w of waiters) clearTimeout(w.timer);
    }
  },
);
