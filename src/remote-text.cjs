const { createHash, randomUUID } = require("node:crypto");
const { posix } = require("node:path");
const iconv = require("iconv-lite");

const largeFileWarnBytes = 5 * 1024 * 1024;
const maxFileBytes = largeFileWarnBytes;
const chunkSize = 65536;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const binaryControls = /[\x00-\x08\x0b\x0e-\x1f\x7f]/;
const call = (sftp, name, ...args) =>
  new Promise((resolve, reject) =>
    sftp[name](...args, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );

function revision(bytes, attrs) {
  return createHash("sha256")
    .update(bytes)
    // Some servers assign a fresh timestamp as part of a rename. Compare
    // persisted content and permissions so our own rename can't cause a conflict.
    .update(JSON.stringify([attrs.mode, attrs.uid, attrs.gid]))
    .digest("hex");
}

function checkAttrs(attrs) {
  if (!attrs.isFile()) throw new Error("只能编辑普通文件");
  if (!Number.isSafeInteger(attrs.size) || attrs.size < 0)
    throw new Error("服务器未返回有效的文件大小");
}

async function snapshot(sftp, path) {
  checkAttrs(await call(sftp, "lstat", path));
  const handle = await call(sftp, "open", path, "r");
  try {
    const attrs = await call(sftp, "fstat", handle);
    checkAttrs(attrs);
    const bytes = Buffer.alloc(attrs.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = await call(
        sftp, "read", handle, bytes, offset, Math.min(chunkSize, bytes.length - offset), offset,
      );
      if (!count) break;
      offset += count;
    }
    const after = await call(sftp, "fstat", handle);
    if (
      offset !== attrs.size ||
      after.size !== attrs.size ||
      after.mtime !== attrs.mtime
    )
      throw new Error("远程文件正在变化，请重试");
    const content = bytes.subarray(0, offset);
    return { content, attrs, version: revision(content, attrs) };
  } finally {
    await call(sftp, "close", handle);
  }
}

function decode(content, preferred) {
  const bom = content.subarray(0, utf8Bom.length).equals(utf8Bom);
  const data = bom ? content.subarray(utf8Bom.length) : content;
  let encoding = preferred || "utf-8";
  let text;
  if (encoding === "utf-8") {
    try {
      text = utf8.decode(data);
    } catch {
      if (preferred || bom) throw new Error("文件内容不是有效的 UTF-8");
      encoding = "gbk";
    }
  }
  if (encoding === "gbk") {
    if (bom) throw new Error("文件带有 UTF-8 BOM，请按 UTF-8 打开");
    text = iconv.decode(data, encoding);
    if (!iconv.encode(text, encoding).equals(data))
      throw new Error("文件内容不能按 GBK 无损读取");
  }
  if (binaryControls.test(text)) throw new Error("暂不支持编辑二进制文件");
  const endings = new Set(text.match(/\r\n|\n|\r/g));
  if (endings.size > 1) throw new Error("此文件混用了不同的换行符，暂不支持编辑");
  return { text, encoding, bom, eol: endings.values().next().value || "\n" };
}

async function readRemoteText(sftp, path, encoding) {
  const directory = await call(sftp, "realpath", posix.dirname(path));
  const canonical = posix.join(directory, posix.basename(path));
  const { content, version } = await snapshot(sftp, canonical);
  return {
    ...decode(content, encoding),
    version,
    path: canonical,
    size: content.length,
    largeFile: content.length > largeFileWarnBytes,
  };
}

async function replace(sftp, temporary, path) {
  try {
    await call(sftp, "ext_openssh_rename", temporary, path);
  } catch (error) {
    if (error.code !== 8 && !error.message.includes("does not support this extended request"))
      throw error;
    // Some SFTP servers replace existing files using standard RENAME.
    // Never unlink the destination to force a replacement.
    try {
      await call(sftp, "rename", temporary, path);
    } catch (error) {
      throw new Error("SFTP 服务拒绝替换原文件：" + error.message);
    }
  }
}

const saving = new WeakMap();
async function overwriteTarget(sftp, path) {
  const attrs = await call(sftp, "lstat", path);
  if (!attrs.isFile()) throw new Error("强制保存只能覆盖现有的普通文件");
  return attrs;
}

async function saveRemoteText(sftp, path, text, version, sourceEncoding, encoding, forceFormat) {
  const directory = posix.dirname(path);
  // Within an SFTP channel, serialize writes to the canonical path.
  if (saving.get(sftp)?.has(path))
    throw new Error("同一文件正在保存，请稍后重试");
  const paths = saving.get(sftp) || new Set();
  saving.set(sftp, paths);
  paths.add(path);
  const temporary = posix.join(directory, `.jayxterm-edit-${randomUUID()}.tmp`);
  let staged = false;
  let phase = "检查远端目录";
  try {
    if ((await call(sftp, "realpath", directory)) !== directory)
      throw new Error("远程目录已更改，请重新打开文件");
    phase = forceFormat ? "检查覆盖目标" : "检查原文件";
    const original = forceFormat
      ? { attrs: await overwriteTarget(sftp, path) }
      : await snapshot(sftp, path);
    if (!forceFormat && original.version !== version)
      throw new Error("远程文件已更改，请重新打开后再保存");
    phase = "检查文本编码与大小";
    const { eol, bom } = forceFormat || decode(original.content, sourceEncoding);
    const restored = text.replace(/\r\n|\r|\n/g, eol);
    let content = iconv.encode(restored, encoding);
    if (iconv.decode(content, encoding, { stripBOM: false }) !== restored)
      throw new Error("编辑内容包含当前编码无法保存的字符。请修改这些字符，或用 UTF-8 保存");
    if (bom && encoding === "utf-8") content = Buffer.concat([utf8Bom, content]);
    if (binaryControls.test(restored)) throw new Error("文本含有不支持的控制字符");
    phase = "创建同目录临时文件";
    const handle = await call(sftp, "open", temporary, "wx", 0o600);
    staged = true;
    const { mode, uid, gid } = original.attrs;
    try {
      phase = "写入临时文件";
      for (let offset = 0; offset < content.length; offset += chunkSize)
        await call(sftp, "write", handle, content, offset, Math.min(chunkSize, content.length - offset), offset);
      const attrs = await call(sftp, "fstat", handle);
      phase = "保留原文件权限和所有者";
      if (attrs.uid !== uid || attrs.gid !== gid)
        await call(sftp, "fsetstat", handle, { uid, gid });
      if (attrs.mode !== mode || attrs.uid !== uid || attrs.gid !== gid)
        await call(sftp, "fsetstat", handle, { mode: mode & 0o7777 });
    } finally {
      await call(sftp, "close", handle);
    }
    const written = await call(sftp, "lstat", temporary);
    if (written.uid !== uid || written.gid !== gid || written.mode !== mode)
      throw new Error("无法保留原文件的权限和所有者");
    phase = forceFormat ? "检查覆盖目标" : "确认原文件未被改动";
    if (forceFormat) {
      const current = await overwriteTarget(sftp, path);
      if (current.mode !== mode || current.uid !== uid || current.gid !== gid)
        throw new Error("远端权限或所有者在保存期间发生变化，请重试");
    } else if ((await snapshot(sftp, path)).version !== version) {
      throw new Error("远程文件已更改，请重新打开后再保存");
    }
    phase = "替换原文件";
    await replace(sftp, temporary, path);
    staged = false;
    return { version: revision(content, written) };
  } catch (error) {
    const hints = {
      "检查远端目录": "请确认目录仍存在且当前会话可以访问。",
      "检查覆盖目标": "请确认远端路径仍指向可访问的普通文件。",
      "创建同目录临时文件": "请检查远端目录写权限、磁盘空间或配额。",
      "写入临时文件": "请检查远端磁盘空间、配额和 SSH 连接。",
      "保留原文件权限和所有者": "请确认当前 SSH 用户有权限设置原有的文件权限和所有者。",
      "替换原文件": "请检查远端目录权限和 SFTP 服务是否允许替换现有文件。",
    };
    throw new Error(`${phase}失败：${error.message}${hints[phase] ? "。 " + hints[phase] : ""}`, { cause: error });
  } finally {
    if (staged) await call(sftp, "unlink", temporary).catch(() => {});
    paths.delete(path);
    if (!paths.size) saving.delete(sftp);
  }
}
module.exports = { readRemoteText, saveRemoteText, maxFileBytes, largeFileWarnBytes };
