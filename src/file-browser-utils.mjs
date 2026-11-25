export function validateRemoteEntryName(raw) {
  const name = String(raw || "").trim();
  if (!name || name === "." || name === "..") {
    throw new Error("名称不能为空，且不能为 . 或 ..");
  }
  if (name.length > 255 || /[\/\0\r\n]/.test(name)) {
    throw new Error("名称不能包含斜杠、换行或空字符");
  }
  return name;
}

export function sortAndFilterFiles(
  files,
  { showHidden = true, sortBy = "name", sortDir = "asc" } = {},
) {
  if (!Array.isArray(files)) return [];
  const filtered = showHidden
    ? [...files]
    : files.filter((file) => !String(file?.name || "").startsWith("."));
  const direction = sortDir === "desc" ? -1 : 1;
  return filtered.sort((a, b) => {
    if (Boolean(a.directory) !== Boolean(b.directory)) {
      return a.directory ? -1 : 1;
    }
    if (sortBy === "size") {
      const diff = (Number(a.size) || 0) - (Number(b.size) || 0);
      if (diff !== 0) return diff * direction;
    } else if (sortBy === "modified") {
      const diff = (Number(a.modified) || 0) - (Number(b.modified) || 0);
      if (diff !== 0) return diff * direction;
    }
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    }) * direction;
  });
}
