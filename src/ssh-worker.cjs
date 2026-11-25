const { Client } = require("ssh2");
const { TerminalCodec } = require("./codec.cjs");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { transferTree, relayTree, virtualDragManifest, previewRemoteRemoval, removeRemote } = require("./transfers.cjs");
const { readRemoteText, saveRemoteText } = require("./remote-text.cjs");
const connections = new Map();
const send = (m) => process.connected && process.send(m);

function flushOutput(c) {
  if (!c) return;
  if (c.batchTimer) {
    clearTimeout(c.batchTimer);
    c.batchTimer = null;
  }
  if (!c.batchChunks.length && !c.batchBytes) return;
  const text = c.batchChunks.join("");
  const bytes = c.batchBytes;
  c.batchChunks = [];
  c.batchBytes = 0;
  c.lastFlushAt = Date.now();
  send({ type: "data", id: c.id, text, bytes });
}

function enqueueOutput(c, decodedBuf, rawBytes) {
  const text = c.utf8.write(decodedBuf);
  if (text) c.batchChunks.push(text);
  c.batchBytes += rawBytes;
  if ((!c.batchTimer && Date.now() - c.lastFlushAt >= 12) || c.batchBytes >= 32768) {
    flushOutput(c);
  } else if (!c.batchTimer) {
    c.batchTimer = setTimeout(() => flushOutput(c), 8);
  }
}

function destroyJumpClients(c) {
  if (!c?.jumpClients?.length) return;
  for (const jc of c.jumpClients) {
    try { jc.destroy(); } catch {}
  }
  c.jumpClients = [];
}

function buildConnectOptions(cfg, secret, hostVerifier) {
  const opts = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    readyTimeout: 120000,
    keepaliveInterval: 15000,
    hostVerifier,
  };
  if (cfg.authType === "key" && cfg.privateKeyPath) {
    let stat;
    try { stat = fs.statSync(cfg.privateKeyPath); }
    catch { throw new Error("找不到私钥文件：" + cfg.privateKeyPath); }
    if (!stat.isFile() || stat.size > 262144)
      throw new Error("私钥文件无效或过大：" + cfg.privateKeyPath);
    opts.privateKey = fs.readFileSync(cfg.privateKeyPath);
    if (secret) opts.passphrase = secret;
  } else {
    opts.password = secret;
  }
  return opts;
}

function connectJumpHop(c, hop, nextHost, nextPort, upstreamSock) {
  return new Promise((resolve, reject) => {
    const jc = new Client();
    c.jumpClients.push(jc);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { jc.destroy(); } catch {}
      reject(err);
    };
    jc.on("error", (err) => fail(new Error(`跳板机 ${hop.config.host} 连接失败：${err.message}`)));
    jc.on("close", () => fail(new Error(`跳板机 ${hop.config.host} 连接已关闭`)));
    jc.on("ready", () => {
      jc.setNoDelay(true);
      jc.forwardOut("127.0.0.1", 0, nextHost, nextPort, (err, stream) => {
        if (err) return fail(new Error(`跳板机转发失败：${err.message}`));
        settled = true;
        resolve(stream);
      });
    });
    const opts = buildConnectOptions(hop.config, hop.password, (key, callback) => {
      const fingerprint =
        "SHA256:" + crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
      c.verify = callback;
      send({ type: "hostkey", id: c.id, host: hop.config.host, port: hop.config.port, fingerprint });
    });
    if (upstreamSock) opts.sock = upstreamSock;
    jc.connect(opts);
  });
}
// OpenSSH forks both channel processes from its per-connection daemon. Only
// read a directory if that daemon has exactly one interactive PTY child.
const directoryMarker = Buffer.from("JAYXTERM_PTY_CWD\0");
const directoryProbe = String.raw`
parent=$PPID
case "$parent" in ''|*[!0-9]*) exit 1;; esac
IFS= read -r daemon < "/proc/$parent/comm" || exit 1
case "$daemon" in sshd|sshd-session) ;; *) exit 1;; esac
pid=$(LC_ALL=C ps -o pid=,tty= --ppid "$parent" |
  LC_ALL=C awk '$2 ~ /^pts\/[0-9]+$/ { n++; pid=$1 } END { if (n == 1) print pid; else exit 1 }') || exit 1
case "$pid" in ''|*[!0-9]*) exit 1;; esac
printf 'JAYXTERM_PTY_CWD\000'
readlink -z "/proc/$pid/cwd"
`;
function shellDirectory(connection) {
  if (!connection?.stream) return null;
  connection.directoryQuery ??= new Promise((resolve) => {
    let channel, finished = false, bytes = 0, exit;
    const chunks = [];
    function finish(directory = null) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(directory);
    }
    const timer = setTimeout(() => {
      finish();
      channel?.close();
    }, 2600);
    connection.client.exec(directoryProbe, (error, stream) => {
      if (error) return finish();
      if (finished) return stream.close();
      channel = stream;
      stream.stderr.resume();
      stream.on("error", () => finish());
      stream.on("data", (chunk) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > 16384) {
          finish();
          stream.close();
        } else chunks.push(chunk);
      });
      stream.on("exit", (code) => { exit = code; });
      stream.once("close", () => {
        const output = Buffer.concat(chunks);
        const start = output.indexOf(directoryMarker);
        if (exit !== 0 || start < 0) return finish();
        const from = start + directoryMarker.length;
        const end = output.indexOf(0, from);
        if (end < 0) return finish();
        // SFTP paths use UTF-8 independently of the terminal's input/output codec.
        const directory = output.toString("utf8", from, end);
        if (!directory.startsWith("/") || /[\x00-\x1f\x7f\ufffd]/.test(directory) || directory.endsWith(" (deleted)"))
          return finish();
        finish(directory);
      });
    });
  }).finally(() => { connection.directoryQuery = null; });
  return connection.directoryQuery;
}
function getSftp(connection) {
  if (!connection?.stream) throw new Error("SSH 尚未连接");
  if (!connection.sftpPromise) {
    const opening = new Promise((resolve, reject) =>
      connection.client.sftp((error, sftp) =>
        error ? reject(error) : resolve(sftp),
      ),
    );
    connection.sftpPromise = opening;
    const reset = () => {
      if (connection.sftpPromise === opening) connection.sftpPromise = null;
    };
    opening.then((sftp) => {
      sftp.once("end", () => {
        reset();
        sftp.end();
      });
      sftp.once("close", reset);
      sftp.on("error", reset);
    }, reset);
  }
  return connection.sftpPromise;
}
process.on("message", async (m) => {
  let c = connections.get(m.id);
  try {
    if (m.type === "duplicate") {
      const source = connections.get(m.source);
      if (!source?.stream || source.stream.destroyed) throw new Error("原 SSH 连接已断开");
      m = {
        ...m,
        type: "connect",
        config: { ...source.config, encoding: source.codec.encoding },
        password: source.password,
        jumps: source.jumps,
      };
    }
    if (m.type === "connect") {
      if (c) return;
      c = {
        id: m.id,
        client: new Client(),
        jumpClients: [],
        jumps: Array.isArray(m.jumps) ? m.jumps : [],
        config: { ...m.config },
        password: m.password,
        pending: 0,
        codec: new TerminalCodec(m.config.encoding),
        utf8: new StringDecoder("utf8"),
        batchChunks: [],
        batchBytes: 0,
        batchTimer: null,
        lastFlushAt: 0,
        size: { cols: m.cols || 100, rows: m.rows || 30 },
      };
      connections.set(m.id, c);
      c.client.on("error", (e) =>
        send({ type: "error", id: m.id, message: e.message }),
      );
      c.client.on("close", () => {
        const rest = c.utf8.end();
        if (rest) c.batchChunks.push(rest);
        flushOutput(c);
        destroyJumpClients(c);
        connections.delete(m.id);
        send({ type: "closed", id: m.id });
      });
      c.client.on("ready", () => {
        // Interactive input must not wait for TCP's small-packet coalescing.
        c.client.setNoDelay(true);
        if (m.test) {
          c.client.sftp((error, sftp) => {
            send({
              type: "test-result",
              id: m.id,
              result: {
                ssh: true,
                sftp: !error,
                message: error
                  ? "SSH 认证成功；SFTP 不可用：" + error.message
                  : "SSH 认证和 SFTP 均成功",
              },
            });
            sftp?.end();
            c.client.end();
          });
          return;
        }
        c.client.shell({ term: "xterm-256color", ...c.size }, (err, stream) => {
          if (err) {
            send({ type: "error", id: m.id, message: err.message });
            return c.client.end();
          }
          c.stream = stream;
          // A resize can arrive while SSH is opening the shell channel.
          stream.setWindow(c.size.rows, c.size.cols, 0, 0);
          stream.on("data", (data) => {
            c.pending += data.length;
            enqueueOutput(c, c.codec.decode(data), data.length);
            if (c.pending > 262144) stream.pause();
          });
          stream.on("close", () => {
            const rest = c.utf8.end();
            if (rest) c.batchChunks.push(rest);
            flushOutput(c);
            c.client.end();
          });
          if (m.directory) {
            // ASCII shell input preserves UTF-8 filenames even in a GBK terminal.
            const octal = Array.from(Buffer.from(m.directory, "utf8"),
              (byte) => "\\" + byte.toString(8).padStart(3, "0")).join("");
            stream.write(`cd -- "$(printf '${octal}')"\r`);
          }
          send({ type: "ready", id: m.id, directory: m.directory });
        });
      });
      let sock;
      if (c.jumps.length) {
        try {
          for (let i = 0; i < c.jumps.length; i++) {
            const hop = c.jumps[i];
            const next = c.jumps[i + 1]?.config || c.config;
            sock = await connectJumpHop(c, hop, next.host, next.port, sock);
          }
        } catch (err) {
          destroyJumpClients(c);
          connections.delete(m.id);
          send({ type: "error", id: m.id, message: err.message });
          return;
        }
      }
      const connectOpts = buildConnectOptions(m.config, m.password, (key, callback) => {
        const fingerprint =
          "SHA256:" +
          crypto
            .createHash("sha256")
            .update(key)
            .digest("base64")
            .replace(/=+$/, "");
        c.verify = callback;
        send({ type: "hostkey", id: m.id, host: m.config.host, port: m.config.port, fingerprint });
      });
      if (sock) connectOpts.sock = sock;
      c.client.connect(connectOpts);
    } else if (m.type === "verify") {
      c?.verify?.(m.accept);
      if (c) c.verify = null;
    } else if (m.type === "input") {
      if (c?.stream) c.stream.write(c.codec.encode(m.data));
    } else if (m.type === "freeze") {
      if (!c?.stream) throw new Error("连接已断开");
      flushOutput(c);
      c.frozen = true;
      c.stream.pause();
      send({ type: "result", rid: m.rid, result: true });
    } else if (m.type === "thaw" && c) {
      c.frozen = false;
      if (c.pending < 65536) c.stream?.resume();
    } else if (m.type === "encoding" && c) {
      const tail = c.codec.setEncoding(m.encoding);
      const rest = c.utf8.end();
      if (rest) c.batchChunks.push(rest);
      c.utf8 = new StringDecoder("utf8");
      if (tail.length) {
        const decoded = c.utf8.write(tail);
        if (decoded) c.batchChunks.push(decoded);
      }
      flushOutput(c);
      send({
        type: "result",
        rid: m.rid,
        result: { encoding: c.codec.encoding },
      });
    } else if (m.type === "resize" && c) {
      if (
        Number.isInteger(m.cols) &&
        m.cols >= 2 &&
        m.cols <= 1000 &&
        Number.isInteger(m.rows) &&
        m.rows >= 1 &&
        m.rows <= 1000
      ) {
        c.size = { cols: m.cols, rows: m.rows };
        c.stream?.setWindow(m.rows, m.cols, 0, 0);
      }
    } else if (m.type === "ack" && c) {
      c.pending = Math.max(0, c.pending - m.bytes);
      if (c.pending < 65536 && !c.frozen) c.stream?.resume();
    } else if (m.type === "disconnect") {
      if (c) {
        if (c.batchTimer) clearTimeout(c.batchTimer);
        destroyJumpClients(c);
        c.client.destroy();
      }
    }
    else if (m.type === "shell-directory") {
      send({ type: "result", rid: m.rid, result: await shellDirectory(c) });
    } else if (m.type === "sftp") {
      const s = await getSftp(c);
      let result;
      if (m.action === "read-text") {
        result = await readRemoteText(s, m.path, m.encoding);
      } else if (m.action === "remove-preview") {
        result = await previewRemoteRemoval(s, m.path);
      } else if (m.action === "remove") {
        result = await removeRemote(s, m.path, m.revision);
      } else if (m.action === "save-text") {
        result = await saveRemoteText(s, m.path, m.text, m.version, m.sourceEncoding, m.encoding, m.forceFormat);
      } else if (m.action === "drag-manifest") {
        result = await virtualDragManifest(s, m.path);
      } else if (m.action === "relay") {
        const source = await getSftp(connections.get(m.source));
        result = await relayTree(
          source,
          s,
          m.from,
          m.path,
          m.sameServer,
          (progress) =>
            send({ type: "progress", id: m.id, rid: m.rid, ...progress }),
        );
      } else if (m.action === "upload" || m.action === "download") {
        if (c.transferring) throw new Error("请等待当前传输完成");
        c.transferring = true;
        try {
          result = await transferTree(
            s,
            m.action,
            m.local,
            m.path,
            (progress) =>
              send({ type: "progress", id: m.id, rid: m.rid, ...progress }),
            m.expectedFileSize,
          );
        } finally {
          c.transferring = false;
        }
      } else
        result = await new Promise((resolve, reject) => {
          const done = (e, r) => (e ? reject(e) : resolve(r));
          if (m.action === "list")
            s.realpath(m.path || ".", (e, real) =>
              e
                ? reject(e)
                : s.readdir(real, (e, files) =>
                    done(e, {
                      path: real,
                      files: files?.map((f) => ({
                        name: f.filename,
                        directory: f.attrs.isDirectory(),
                        symlink: f.attrs.isSymbolicLink(),
                        size: f.attrs.size,
                        modified: f.attrs.mtime,
                      })),
                    }),
                  ),
            );
          else if (m.action === "stat")
            s.lstat(m.path, (e, attrs) =>
              e && e.code === 2
                ? resolve({ exists: false })
                : done(e, {
                    exists: true,
                    directory: attrs?.isDirectory(),
                    size: attrs?.size ?? 0,
                  }),
            );
          else if (m.action === "stat-target") {
            const checkPath = (target) =>
              s.stat(target, (err, attrs) =>
                err && err.code === 2
                  ? resolve({ exists: false, path: target })
                  : done(err, {
                      exists: true,
                      path: target,
                      directory: attrs?.isDirectory(),
                    }),
              );
            if (m.resolveHome) {
              s.realpath(".", (err, home) => {
                if (err) return reject(err);
                const sub = m.path === "~"
                  ? "."
                  : m.path.startsWith("~/") ? m.path.slice(2) : m.path;
                checkPath(path.posix.resolve(home, sub));
              });
            } else {
              checkPath(m.path);
            }
          } else if (m.action === "mkdir") {
            s.lstat(m.path, (statErr) => {
              if (!statErr) return reject(new Error("同名文件或目录已存在"));
              if (statErr.code !== 2) return reject(statErr);
              s.mkdir(m.path, (err) => done(err, { path: m.path }));
            });
          } else if (m.action === "create-file") {
            s.lstat(m.path, (statErr) => {
              if (!statErr) return reject(new Error("同名文件或目录已存在"));
              if (statErr.code !== 2) return reject(statErr);
              const finishCreate = (openErr, handle) => {
                if (openErr) return reject(openErr);
                s.close(handle, (closeErr) => done(closeErr, { path: m.path }));
              };
              s.open(m.path, "wx", 0o644, (openErr, handle) => {
                if (openErr && (openErr.code === 8 || /unsupported/i.test(openErr.message))) {
                  return s.open(m.path, "w", 0o644, finishCreate);
                }
                finishCreate(openErr, handle);
              });
            });
          } else if (m.action === "rename") {
            s.lstat(m.to, (statErr) => {
              if (!statErr) return reject(new Error("目标名称已存在"));
              if (statErr.code !== 2) return reject(statErr);
              s.rename(m.from, m.to, (err) => done(err, { from: m.from, to: m.to }));
            });
          } else reject(new Error("未知文件操作"));
        });
      send({ type: "result", rid: m.rid, result });
    }
  } catch (e) {
    send({
      type: m.rid ? "result" : "error",
      rid: m.rid,
      id: m.id,
      error: e.message,
      message: e.message,
    });
  }
});
process.on("disconnect", () => {
  for (const c of connections.values()) c.client.destroy();
  process.exit();
});
