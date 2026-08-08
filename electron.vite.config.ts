import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Three builds, three trust levels.
 *
 *   main     — full Node. Owns the tray, the window, and the runtime link.
 *   preload  — the bridge. Tiny by design; everything it exports is attack
 *              surface, so it is built separately and reviewed as one file.
 *   renderer — no Node at all. Plain web app that can only reach the runtime
 *              through the preload bridge.
 */
export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      lib: { entry: resolve(__dirname, "src/desktop/main.ts") },
      rollupOptions: {
        // The runtime is spawned as a separate process in dev, so its entry
        // must not be bundled into the shell.
        external: ["electron"],
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      lib: {
        entry: resolve(__dirname, "src/desktop/preload.ts"),
        formats: ["es"],
        fileName: () => "preload.mjs",
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/ui"),
    plugins: [react(), tailwind()],
    build: {
      outDir: resolve(__dirname, "out/renderer"),
      rollupOptions: {
        input: resolve(__dirname, "src/ui/index.html"),
      },
    },
  },
});
