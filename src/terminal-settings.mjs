export const scrollbackOptions = [3000, 10000, 30000];
export const terminalDefaults = {
  fontFamily: "Cascadia Mono",
  cjkFontFamily: "",
  fontSize: 14,
  scrollback: 3000,
  defaultEncoding: "utf-8",
  highlightKeywords: true,
  terminalSearchEnabled: true,
  commandHistoryEnabled: true,
  quickPasswordsEnabled: false,
  predictiveEcho: true,
  hardwareAcceleration: false,
  showTabStatusDot: false,
};
export const terminalEncodings = ["utf-8", "gbk", "gb2312"];
export const validFontFamily = (value) => typeof value === "string" && value.trim().length > 0 &&
  value.length <= 100 && !/[\x00-\x1f\x7f"'\\;,{}<>]/.test(value);
export const validFontSize = (value) => Number.isInteger(value) && value >= 8 && value <= 48;
export const validScrollback = (value) => scrollbackOptions.includes(Number(value));
export const validCjkFontFamily = (value) => value === "" || validFontFamily(value);
// Restrict the override to CJK glyphs so a Chinese font's Latin glyphs cannot
// change terminal cell measurements or the selected Western font.
export const cjkUnicodeRange = "U+2E80-9FFF, U+AC00-D7AF, U+F900-FAFF, U+FE10-FE1F, U+FE30-FE4F, U+FF00-FFEF, U+20000-3FFFF";
export const cjkFontAlias = (family) => `JayXTerm CJK ${family}`;
export function terminalFont(settings) {
  const family = validFontFamily(settings.fontFamily) ? settings.fontFamily.trim() : terminalDefaults.fontFamily;
  const cjk = validFontFamily(settings.cjkFontFamily) ? settings.cjkFontFamily.trim() : "";
  return {
    fontFamily: `${cjk ? `"${cjkFontAlias(cjk)}", ` : ""}"${family}", Consolas, "Courier New", monospace`,
    fontSize: validFontSize(settings.fontSize) ? settings.fontSize : terminalDefaults.fontSize,
  };
}
