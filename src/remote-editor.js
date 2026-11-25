import { editor, KeyCode, KeyMod } from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker&inline";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/languages/definitions/cpp/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import "../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "./remote-editor.css";
import { applyTheme } from "./theme.mjs";

self.MonacoEnvironment = {
  async getWorker(_module, label) {
    if (label === "json") {
      const { default: JsonWorker } = await import("monaco-editor/languages/features/json/json.worker.js?worker&inline");
      return new JsonWorker();
    }
    return new EditorWorker();
  },
};

function renderTheme(color) {
  editor.defineTheme("jayxterm", applyTheme(color).editor);
  editor.setTheme("jayxterm");
}
renderTheme("#394351");

async function languageFor(name) {
  if (/\.(js|mjs|cjs|jsx)$/i.test(name)) return ["javascript", "JavaScript"];
  if (/\.(ts|tsx)$/i.test(name)) return ["typescript", "TypeScript"];
  if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(name)) return ["cpp", "C / C++"];
  if (/\.py$/i.test(name)) return ["python", "Python"];
  if (/\.json$/i.test(name)) {
    await import("monaco-editor/languages/features/json/register.js");
    return ["json", "JSON"];
  }
  if (/\.ya?ml$/i.test(name)) return ["yaml", "YAML"];
  if (/\.(sh|bash|zsh)$/i.test(name) || /^\.(bash|zsh)(rc|_profile|_aliases)$/.test(name))
    return ["shell", "Shell"];
  if (/\.md$/i.test(name)) return ["markdown", "Markdown"];
  if (/\.html?$/i.test(name)) return ["html", "HTML"];
  if (/\.css$/i.test(name)) return ["css", "CSS"];
  return ["plaintext", "纯文本"];
}

const errorText = (error) =>
  error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");

const api = window.editorApi;
api.onSettings((settings) => renderTheme(settings.backgroundColor));
const root = document.querySelector("#remote-editor");
function el(tag, cls, label) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (label) node.textContent = label;
  return node;
}

const top = el("header", "editor-top");
const name = el("strong", "editor-name");
const modified = el("span", "editor-modified", "●");
modified.hidden = true;
modified.title = "有未保存的修改";
const saveButton = el("button", "editor-save", "保存");
saveButton.title = "保存到远端 (Ctrl+S)";
const forceSaveButton = el("button", "editor-save editor-force-save", "强制保存");
forceSaveButton.title = "用当前内容覆盖远端文件";
top.append(name, modified, saveButton, forceSaveButton);
const breadcrumb = el("div", "editor-path");
const body = el("div", "editor-body");
const surface = el("div", "editor-surface");
body.append(surface);
const footer = el("footer", "editor-status");
const message = el("span", "editor-message", "正在打开…");
message.setAttribute("role", "status");
function setMessage(text, failed = false) {
  message.textContent = text;
  message.title = text;
  message.classList.toggle("editor-error", failed);
}
const position = el("span");
const charset = el("select", "editor-charset");
charset.setAttribute("aria-label", "文件编码");
const currentEncoding = new Option("编码", "");
charset.append(currentEncoding);
for (const [action, label] of [["open", "按编码重新读取"], ["save", "用编码保存"]]) {
  const group = el("optgroup");
  group.label = label;
  for (const [value, text] of [["utf-8", "UTF-8"], ["gbk", "GBK / CP936"]])
    group.append(new Option(text, action + ":" + value));
  charset.append(group);
}
const mode = el("span");
footer.append(message, position, charset, mode);
root.append(top, breadcrumb, body, footer);

let view, savedVersion, encoding, eol;
let busy = false, dirty = false;
let languageId = "plaintext", language = "纯文本";
function updateControls() {
  saveButton.disabled = !view || !dirty || busy;
  forceSaveButton.disabled = !view || busy;
  charset.disabled = !view || busy;
  if (!view) return;
  currentEncoding.textContent = encoding.toUpperCase();
  charset.value = "";
  mode.textContent = `${{ "\r\n": "CRLF", "\r": "CR", "\n": "LF" }[eol]}  ·  ${language}`;
}
function updatePosition() {
  const cursor = view.getPosition();
  position.textContent = `行 ${cursor.lineNumber}，列 ${cursor.column}`;
}
function setDirty(next) {
  if (next === dirty) return;
  dirty = next;
  modified.hidden = !dirty;
  api.dirty(dirty);
}

function refreshDirty() {
  const changed = view.getModel().getAlternativeVersionId() !== savedVersion;
  if (dirty !== changed) {
    setDirty(changed);
    updateControls();
  }
}
function load(data) {
  encoding = data.encoding;
  eol = data.eol;
  const large = Boolean(data.largeFile);
  const perfOptions = large
    ? {
        minimap: { enabled: false },
        folding: false,
        bracketPairColorization: { enabled: false },
        renderWhitespace: "none",
        largeFileOptimizations: true,
      }
    : {
        minimap: { enabled: true },
        folding: true,
        bracketPairColorization: { enabled: true },
        largeFileOptimizations: true,
      };
  if (view) {
    view.updateOptions(perfOptions);
    view.setValue(data.text);
    view.setPosition({ lineNumber: 1, column: 1 });
    view.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
  } else {
    view = editor.create(surface, {
      value: data.text,
      language: languageId,
      theme: "jayxterm",
      ariaLabel: "文件内容",
      automaticLayout: true,
      fontFamily: 'Cascadia Mono, Consolas, "SF Mono", monospace',
      fontSize: 13,
      cursorWidth: 2,
      tabSize: 4,
      selectionHighlight: false,
      occurrencesHighlight: "off",
      wordBasedSuggestions: "off",
      quickSuggestions: false,
      experimentalGpuAcceleration: "off",
      ...perfOptions,
    });
    view.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => save());
    view.onDidChangeModelContent(refreshDirty);
    view.onDidChangeCursorPosition(updatePosition);
  }
  savedVersion = view.getModel().getAlternativeVersionId();
  refreshDirty();
  updateControls();
  updatePosition();
  view.focus();
}

async function save({ choice = encoding, convert = false, force = false } = {}) {
  if (!view || busy || (!force && !dirty && (!convert || choice === encoding))) return;
  const model = view.getModel();
  const snapshot = model.getValue();
  const version = model.getAlternativeVersionId();
  busy = true;
  setMessage(force ? "正在强制保存…" : "正在保存到远端…");
  updateControls();
  try {
    const result = await api.save({ text: snapshot, encoding: choice, force });
    if (result.cancelled) {
      setMessage("已取消强制保存");
      return;
    }
    encoding = choice;
    savedVersion = version;
    refreshDirty();
    setMessage(force ? "已强制保存到远端" : "已保存到远端");
  } catch (error) {
    const detail = errorText(error);
    const hint = !force && detail.includes("远程文件已更改")
      ? "。可保留草稿后重新打开对比，或确认后强制保存"
      : "";
    setMessage((force ? "强制保存失败：" : "保存失败：") + detail + hint, true);
  } finally {
    busy = false;
    updateControls();
  }
}

saveButton.onclick = () => save();
forceSaveButton.onclick = () => save({ force: true });
charset.onchange = async () => {
  const [action, choice] = charset.value.split(":");
  charset.value = "";
  if (!choice || busy) return;
  if (action === "save") {
    await save({ choice, convert: true });
    return;
  }
  if (dirty && !window.confirm("重新读取会丢弃当前未保存的修改。继续？")) return;
  busy = true;
  // Prevent edits made during the reload from being overwritten on completion.
  view.updateOptions({ readOnly: true });
  setMessage("正在重新读取…");
  updateControls();
  try {
    load(await api.reload(choice));
    setMessage("已按 " + choice.toUpperCase() + " 重新读取");
  } catch (error) {
    setMessage("重新读取失败：" + errorText(error));
  } finally {
    view.updateOptions({ readOnly: false });
    busy = false;
    updateControls();
  }
};

updateControls();
try {
  const data = await api.initialize();
  renderTheme(data.backgroundColor);
  [languageId, language] = await languageFor(data.name);
  name.textContent = data.name;
  breadcrumb.textContent = [data.server, ...data.path.split("/").filter(Boolean)].join("  ›  ");
  breadcrumb.title = data.path;
  load(data);
  if (data.largeFile && Number.isFinite(data.size)) {
    const mb = (data.size / (1024 * 1024)).toFixed(1);
    setMessage(`大文件（${mb} MiB）· 已自动启用大文件流畅模式`);
  } else {
    setMessage("远程文件");
  }
} catch (error) {
  setMessage("打开失败：" + errorText(error));
}
