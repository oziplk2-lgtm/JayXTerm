const urlPrefix = /^[a-z][a-z\d+.-]*:\/\//i;
const numericVersionOrIp = /^\d+(?:\.\d+)+$/;
const slashPath = /^(?:~\/|\/|\.\.?\/)[^\s\0]+$|^[^\s\0/@:]+\/[^\s\0]+$/;
const bareFilename = /^(?:\.[A-Za-z0-9_.-]+|[A-Za-z0-9_\u4e00-\u9fff-]+\.[A-Za-z0-9]{1,12}|Makefile|Dockerfile|LICENSE|README)$/i;
const trimOuter = /^['"`([{<]+|['"`)\]}>,;]+$/g;
const lineSuffix = /(:\d+(?::\d+)?|:)$/;

/**
 * Normalize a POSIX path without relying on Node's path module in the browser.
 */
export function normalizePosixPath(value) {
  const absolute = value.startsWith("/");
  const parts = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
    } else {
      parts.push(segment);
    }
  }
  return (absolute ? "/" : "") + parts.join("/") || (absolute ? "/" : ".");
}

/**
 * Strip surrounding quotes/brackets and trailing `:line[:col]` from a token.
 */
export function cleanPathToken(token) {
  if (typeof token !== "string") return "";
  let cleaned = token.replace(trimOuter, "");
  cleaned = cleaned.replace(lineSuffix, "");
  return cleaned.replace(trimOuter, "");
}

/**
 * Return true if the cleaned token looks like a remote file or directory path.
 */
export function isTerminalFilePath(candidate) {
  if (!candidate || candidate.length > 1024 || /[\x00-\x1f\x7f]/.test(candidate)) {
    return false;
  }
  if (urlPrefix.test(candidate) || numericVersionOrIp.test(candidate)) return false;
  if (candidate === "/" || candidate === "//" || candidate === "." || candidate === "..") {
    return false;
  }
  if (candidate.includes("@") && !candidate.startsWith("/")) return false;
  return slashPath.test(candidate) || bareFilename.test(candidate);
}

/**
 * Extract candidate file/directory path ranges from a line of terminal text.
 */
export function extractTerminalPathMatches(lineText) {
  if (typeof lineText !== "string" || !lineText) return [];
  const matches = [];
  for (const tokenMatch of lineText.matchAll(/\S+/g)) {
    const raw = tokenMatch[0];
    const tokenStart = tokenMatch.index;
    const leadingTrim = raw.match(/^['"`([{<]+/)?.[0].length || 0;
    let endOffset = raw.length;
    const withoutLead = raw.slice(leadingTrim);
    const cleaned = cleanPathToken(raw);
    if (!cleaned || !isTerminalFilePath(cleaned)) continue;
    const cleanIndex = withoutLead.indexOf(cleaned);
    const start = tokenStart + leadingTrim + (cleanIndex >= 0 ? cleanIndex : 0);
    endOffset = start + cleaned.length;
    matches.push({ start, end: endOffset, path: cleaned });
  }
  return matches;
}

/**
 * Resolve a clicked terminal path against the active shell or SFTP directory.
 */
export function resolveRemoteClickPath(rawPath, { baseDirectory = "" } = {}) {
  const cleaned = cleanPathToken(rawPath);
  if (!cleaned) return null;
  if (cleaned.startsWith("/")) return normalizePosixPath(cleaned);
  if (cleaned === "~" || cleaned.startsWith("~/")) return cleaned;
  if (baseDirectory && baseDirectory.startsWith("/")) {
    const joined = baseDirectory === "/" ? `/${cleaned}` : `${baseDirectory}/${cleaned}`;
    return normalizePosixPath(joined);
  }
  return cleaned;
}

/**
 * Collect the logical (soft-wrap joined) terminal line containing `rowIndex`
 * and map each cell to its 1-based xterm buffer coordinates.
 */
export function collectLogicalTerminalLine(buffer, cols, rowIndex, maxContext = 8) {
  if (!buffer || rowIndex < 0 || rowIndex >= buffer.length) return null;
  let startRow = rowIndex;
  let steps = 0;
  while (startRow > 0 && steps < maxContext && buffer.getLine(startRow)?.isWrapped) {
    startRow--;
    steps++;
  }
  let text = "";
  const cells = [];
  let row = startRow;
  steps = 0;
  while (row < buffer.length && steps < maxContext * 2) {
    const line = buffer.getLine(row);
    if (!line) break;
    if (row > startRow && !line.isWrapped) break;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      const width = cell?.getWidth();
      if (!width) continue;
      const chars = cell.getChars() || " ";
      cells.push({
        x1: x + 1,
        y1: row + 1,
        width,
        start: text.length,
        end: text.length + chars.length,
      });
      text += chars;
    }
    row++;
    steps++;
  }
  return { text, cells };
}
