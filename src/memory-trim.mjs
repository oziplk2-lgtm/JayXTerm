export const BACKGROUND_TRIM_IDLE_MS = 5 * 60 * 1000;
export const BACKGROUND_TRIM_SCROLLBACK = 1000;
export const BACKGROUND_FILES_PRUNE_THRESHOLD = 200;

export function shouldTrimTab(tab, now, configuredScrollback) {
  if (!tab || tab.moving || tab.visible) return false;
  if (!Number.isFinite(tab.hiddenSince) || now - tab.hiddenSince < BACKGROUND_TRIM_IDLE_MS) {
    return false;
  }
  const limit = Number(configuredScrollback) || 0;
  return limit > BACKGROUND_TRIM_SCROLLBACK && !tab.scrollbackTrimmed;
}

export function shouldPruneTabFiles(tab, now) {
  if (!tab || tab.moving || tab.visible || tab.loading) return false;
  if (!Number.isFinite(tab.hiddenSince) || now - tab.hiddenSince < BACKGROUND_TRIM_IDLE_MS) {
    return false;
  }
  return Array.isArray(tab.files) && tab.files.length > BACKGROUND_FILES_PRUNE_THRESHOLD;
}
