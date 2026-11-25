import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    license: true,
    rollupOptions: {
      input: {
        workspace: resolve(import.meta.dirname, "index.html"),
        editor: resolve(import.meta.dirname, "editor.html"),
        colorPicker: resolve(import.meta.dirname, "color-picker.html"),
      },
    },
  },
});
