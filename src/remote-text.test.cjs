const test = require("node:test");
const assert = require("node:assert/strict");
const { readRemoteText, saveRemoteText, largeFileWarnBytes } = require("./remote-text.cjs");

function createMemorySftp(initialFiles) {
  const files = new Map(Object.entries(initialFiles).map(([k, v]) => [k, Buffer.from(v)]));
  const handles = new Map();
  let nextHandle = 1;
  const attrsFor = (p) => ({
    isFile: () => files.has(p),
    size: files.get(p).length,
    mode: 0o100644,
    uid: 1000,
    gid: 1000,
    mtime: 1700000000,
  });
  return {
    files,
    realpath(p, cb) { cb(null, p); },
    lstat(p, cb) {
      if (!files.has(p)) return cb(Object.assign(new Error("No such file"), { code: 2 }));
      cb(null, attrsFor(p));
    },
    open(p, flags, modeOrCb, maybeCb) {
      const cb = typeof modeOrCb === "function" ? modeOrCb : maybeCb;
      if (flags === "wx") {
        if (files.has(p)) return cb(new Error("Exists"));
        files.set(p, Buffer.alloc(0));
      } else if (!files.has(p)) {
        return cb(Object.assign(new Error("No such file"), { code: 2 }));
      }
      const h = Buffer.from(String(nextHandle++));
      handles.set(h.toString(), p);
      cb(null, h);
    },
    fstat(h, cb) { cb(null, attrsFor(handles.get(h.toString()))); },
    read(h, buf, offset, len, pos, cb) {
      const data = files.get(handles.get(h.toString()));
      if (pos >= data.length) return cb(null, 0);
      const count = Math.min(len, data.length - pos);
      data.copy(buf, offset, pos, pos + count);
      cb(null, count);
    },
    write(h, buf, offset, len, pos, cb) {
      const p = handles.get(h.toString());
      const cur = files.get(p);
      const next = Buffer.alloc(Math.max(cur.length, pos + len));
      cur.copy(next);
      buf.copy(next, pos, offset, offset + len);
      files.set(p, next);
      cb(null);
    },
    fsetstat(_h, _attrs, cb) { cb(null); },
    close(h, cb) { handles.delete(h.toString()); cb(null); },
    ext_openssh_rename(from, to, cb) {
      files.set(to, files.get(from));
      files.delete(from);
      cb(null);
    },
    unlink(p, cb) { files.delete(p); cb(null); },
  };
}

test("remote text editor supports reading and saving files larger than 5 MiB without hard limit", async () => {
  assert.equal(largeFileWarnBytes, 5 * 1024 * 1024);
  const bigLine = "0123456789abcdef".repeat(64) + "\n"; // 1025 bytes
  const bigContent = bigLine.repeat(5400); // ~5.28 MiB
  const sftp = createMemorySftp({
    "/home/jay/small.txt": "hello\n",
    "/home/jay/large.log": bigContent,
  });

  const small = await readRemoteText(sftp, "/home/jay/small.txt");
  assert.equal(small.largeFile, false);
  assert.equal(small.size, 6);

  const large = await readRemoteText(sftp, "/home/jay/large.log");
  assert.equal(large.largeFile, true);
  assert.equal(large.size, Buffer.byteLength(bigContent));
  assert.equal(large.text.length, bigContent.length);

  const updated = large.text + "tail-line\n";
  const saved = await saveRemoteText(sftp, "/home/jay/large.log", updated, large.version, "utf-8", "utf-8");
  assert.ok(saved.version);
  assert.equal(sftp.files.get("/home/jay/large.log").toString("utf8").endsWith("tail-line\n"), true);
});
