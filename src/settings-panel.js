import { terminalDefaults, terminalFont } from "./terminal-settings.mjs";
import { installFontPicker } from "./font-picker.js";
import { normalizeHexColor } from "./color-picker-utils.mjs";

// Add sections in the markup and fields here; loading/saving and navigation stay shared.
const fields = ["backgroundColor", "fontFamily", "cjkFontFamily", "fontSize", "defaultEncoding", "highlightKeywords", "terminalSearchEnabled", "quickPasswordsEnabled", "predictiveEcho", "fileOpen", "saveHistory"];
export function installSettingsPanel({ api, previewColor, previewFont, previewKeywords, onSave, toast }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#settings-dialog"), form = $("#settings-form");
  const fontPicker = installFontPicker(dialog, form);
  let saved, displayed, cacheChoice = "";
  const buttons = [...dialog.querySelectorAll("[data-settings-section]")];
  function selectSection(button) {
    fontPicker.close();
    for (const item of buttons) {
      const active = item === button;
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = !active;
    }
  }
  for (const button of buttons) {
    button.onclick = () => selectSection(button);
    button.onkeydown = (event) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(button);
      const next = event.key === "Home" ? buttons[0] : event.key === "End" ? buttons.at(-1) :
        buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
      selectSection(next);
      next.focus();
    };
  }
  function readFields() {
    return Object.fromEntries(fields.map((name) => {
      const field = form.elements[name];
      return [name, field.type === "checkbox" ? field.checked :
        field.type === "number" ? field.valueAsNumber : field.value];
    }));
  }
  function preview() {
    const input = readFields();
    fontPicker.sync();
    const hexField = $("#settings-background-value");
    if (document.activeElement !== hexField) hexField.value = input.backgroundColor;
    previewColor(input.backgroundColor);
    previewFont(input);
    previewKeywords(input.highlightKeywords);
    Object.assign($("#settings-font-preview").style, {
      fontFamily: terminalFont(input).fontFamily,
      fontSize: terminalFont(input).fontSize + "px",
    });
  }
  const hexField = $("#settings-background-value");
  hexField.oninput = () => {
    const normalized = normalizeHexColor(hexField.value);
    if (!normalized) return;
    form.elements.backgroundColor.value = normalized;
    preview();
  };
  hexField.onblur = () => { hexField.value = form.elements.backgroundColor.value; };
  $("#settings-pick-color").onclick = async () => {
    const button = $("#settings-pick-color");
    if (button.disabled) return;
    button.disabled = true;
    try {
      const picked = await api.pickScreenColor();
      if (picked && dialog.open) {
        form.elements.backgroundColor.value = picked;
        hexField.value = picked;
        preview();
      }
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
  for (const name of ["backgroundColor", "fontFamily", "cjkFontFamily", "fontSize", "highlightKeywords"])
    form.elements[name].oninput = preview;
  function renderCache() {
    const field = $("#settings-cache");
    field.value = cacheChoice || displayed.defaultCache;
    field.title = field.value;
    $("#settings-cache-note").textContent = cacheChoice !== displayed.cachePath
      ? "下次启动切换至此位置。当前使用 " + (displayed.cachePath || displayed.defaultCache)
      : "位置变更在下次启动时生效。";
  }
  $("#settings-open").onclick = async () => {
    try {
      displayed = saved = await api.settings();
      cacheChoice = displayed.pendingCache ?? displayed.cachePath;
      for (const name of fields) {
        const field = form.elements[name];
        if (field.type === "checkbox") field.checked = displayed[name];
        else field.value = displayed[name];
      }
      $("#settings-error").textContent = displayed.cacheError;
      selectSection(buttons[0]);
      renderCache();
      preview();
      if (!dialog.open) dialog.showModal();
    } catch (error) { toast(error.message); }
  };
  $("#settings-default-background").onclick = () => {
    form.elements.backgroundColor.value = displayed.defaultBackground;
    preview();
  };
  $("#settings-default-font").onclick = () => {
    for (const name of ["fontFamily", "cjkFontFamily", "fontSize"]) form.elements[name].value = terminalDefaults[name];
    preview();
  };
  $("#settings-choose-cache").onclick = async () => {
    try {
      const selected = await api.chooseCache();
      if (selected !== null && dialog.open) { cacheChoice = selected; renderCache(); }
    } catch (error) { $("#settings-error").textContent = error.message; }
  };
  $("#settings-default-cache").onclick = () => { cacheChoice = ""; renderCache(); };
  $("#settings-cancel").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    if (saved) { previewColor(saved.backgroundColor); previewFont(saved); previewKeywords(saved.highlightKeywords); }
  });
  // Invalid inputs may live in an inactive section. Reveal them before browser validation.
  form.addEventListener("invalid", (event) => {
    const panel = event.target.closest("[role=tabpanel]");
    const button = buttons.find((item) => item.getAttribute("aria-controls") === panel?.id);
    if (button) selectSection(button);
  }, true);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $("#settings-save");
    if (button.disabled) return;
    button.disabled = true;
    $("#settings-error").textContent = "";
    try {
      const result = await api.applySettings({ ...readFields(), cachePath: cacheChoice });
      if (!result) return;
      saved = result;
      onSave(result);
      dialog.close();
      if (result.pendingCache !== null) toast("缓存位置将在下次启动时切换");
    } catch (error) { $("#settings-error").textContent = error.message; }
    finally { button.disabled = false; }
  };
  return { setSaved(settings) { saved = settings; } };
}
