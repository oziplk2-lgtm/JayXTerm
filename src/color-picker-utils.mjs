/**
 * Normalize a 6-digit hex color string to lowercase `#rrggbb`, or return null.
 */
export function normalizeHexColor(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const prefixed = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return /^#[\da-f]{6}$/i.test(prefixed) ? prefixed.toLowerCase() : null;
}

/**
 * Convert 0-255 RGB channel values to a lowercase `#rrggbb` string.
 */
export function rgbToHex(r, g, b) {
  const channel = (value) =>
    Math.max(0, Math.min(255, Math.round(Number(value) || 0)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Map CSS viewport coordinates onto clamped source bitmap pixel coordinates.
 */
export function clampSamplePoint(clientX, clientY, viewportWidth, viewportHeight, imageWidth, imageHeight) {
  const safeW = Math.max(1, viewportWidth);
  const safeH = Math.max(1, viewportHeight);
  const maxX = Math.max(0, imageWidth - 1);
  const maxY = Math.max(0, imageHeight - 1);
  const x = Math.max(0, Math.min(maxX, Math.floor((clientX / safeW) * imageWidth)));
  const y = Math.max(0, Math.min(maxY, Math.floor((clientY / safeH) * imageHeight)));
  return { x, y };
}
