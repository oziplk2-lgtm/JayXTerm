const defaultBackground = "#181818";
const rgb = (color) => color.slice(1).match(/../g).map((part) => parseInt(part, 16));
const mix = (from, to, amount) => "#" + rgb(from).map((value, index) =>
  Math.round(value + (rgb(to)[index] - value) * amount).toString(16).padStart(2, "0")).join("");
const luminance = (color) => rgb(color).map((value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
export const contrast = (a, b) => {
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

export function createTheme(color = defaultBackground) {
  const background = /^#[\da-f]{6}$/i.test(color) ? color.toLowerCase() : defaultBackground;
  const dark = luminance(background) < 0.179;
  const strongest = dark ? "#ffffff" : "#000000";
  // Move secondary surfaces away from the foreground to retain readable contrast.
  const shade = dark ? "#000000" : "#ffffff";
  const readable = (preferred) => contrast(preferred, background) >= 4.5 ? preferred : strongest;
  const ink = readable(dark ? "#cccccc" : "#252b38");
  const muted = readable(mix(ink, background, 0.2));
  const chrome = mix(background, shade, 0.08);
  const surface = mix(background, shade, 0.16);
  const hover = mix(background, shade, 0.26);
  const tabLamp = (preferred) => {
    for (const amount of [0, 0.25, 0.5, 0.75]) {
      const candidate = mix(preferred, strongest, amount);
      if (contrast(candidate, chrome) >= 3 && contrast(candidate, hover) >= 3) return candidate;
    }
    return strongest;
  };
  const accent = readable(dark ? "#4daafc" : "#214f8c");
  const selection = mix(background, ink, 0.25);
  const terminalSelection = dark && contrast("#264f78", background) >= 1.5 ? "#264f78" : selection;
  const success = readable(dark ? "#a0dac1" : "#176547");
  const warning = readable(dark ? "#ebce9c" : "#805207");
  const danger = readable(dark ? "#ffb7bf" : "#a51d32");
  const ansi = dark
    ? ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"]
    : ["#202733", "#a51d32", "#176547", "#805207", "#214f8c", "#743a8e", "#17656e", "#555d68"];
  const brightAnsi = dark
    ? ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]
    : ansi.map((value) => mix(value, strongest, 0.15));
  const terminal = { background, foreground: ink, cursor: ink, cursorAccent: background,
    selectionBackground: terminalSelection, selectionForeground: strongest, selectionInactiveBackground: terminalSelection };
  for (const [index, name] of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].entries()) {
    terminal[name] = ansi[index];
    terminal["bright" + name[0].toUpperCase() + name.slice(1)] = brightAnsi[index];
  }
  return {
    dark, background, chrome, surface, ink, muted, accent, selection, terminal,
    variables: {
      "page-bg": background, "page-ink": ink, "page-muted": muted,
      "page-selection": mix(background, shade, 0.2),
      chrome, surface, ink, muted, accent, "on-accent": dark ? "#000000" : "#ffffff",
      line: mix(background, ink, 0.22), hover,
      "accent-fill": mix(background, shade, 0.2), "terminal-bg": background,
      success, warning, danger, "danger-bg": mix(background, shade, 0.2),
      "tab-lamp-ready": tabLamp(dark ? "#76e4ac" : "#137448"),
      "tab-lamp-connecting": tabLamp(dark ? "#ffd178" : "#936010"),
      "tab-lamp-disconnected": tabLamp(dark ? "#ff7887" : "#bd243b"),
    },
    editor: {
      base: dark ? "vs-dark" : "vs", inherit: true, rules: [],
      colors: {
        "editor.background": background, "editor.foreground": ink,
        "editorCursor.foreground": ink, "editorLineNumber.foreground": muted,
        "editorLineNumber.activeForeground": ink,
        "editor.lineHighlightBackground": surface,
        "editor.selectionBackground": selection, "editor.selectionForeground": strongest,
        "editor.inactiveSelectionBackground": selection, "editorGutter.background": background,
        "editorWidget.background": surface, "editorWidget.foreground": ink,
        "editorWidget.border": mix(background, ink, 0.22),
        "input.background": background, "input.foreground": ink,
        "dropdown.background": surface, "dropdown.foreground": ink,
        "menu.background": surface, "menu.foreground": ink,
        "list.hoverBackground": chrome, "list.activeSelectionBackground": selection,
        "list.activeSelectionForeground": strongest,
      },
    },
  };
}

export function applyTheme(color) {
  const theme = createTheme(color);
  for (const [name, value] of Object.entries(theme.variables))
    document.documentElement.style.setProperty("--" + name, value);
  document.documentElement.style.colorScheme = theme.dark ? "dark" : "light";
  return theme;
}
