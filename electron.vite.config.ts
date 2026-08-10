import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Three builds, three trust levels.
 *
 *   main     — full Node. Owns the tray, the window, and the runtime link.
 *              Two entries: the shell, and the headless runtime it spawns.
 *   preload  — the bridge. Tiny by design; everything it exports is attack
 *              surface, so it is built separately and reviewed as one file.
 *   renderer — no Node at all. Plain web app that can only reach the runtime
 *              through the preload bridge.
 */
export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      lib: {
        // The runtime gets its own entry so a packaged build can start it with
        // `ELECTRON_RUN_AS_NODE=1` — plain Node, no Chromium. Bundling it only
        // as a dynamic import of the shell forced the always-on process to be a
        // full Electron browser process, which spawned a GPU process and a
        // network utility process it never used: 95 MB of an idle assistant's
        // resident set spent on rendering that never happens (§72). Nothing in
        // `src/runtime/**` imports `electron`, which is what makes this legal —
        // if that ever changes, the packaged runtime stops booting and says so.
        entry: {
          main: resolve(__dirname, "src/desktop/main.ts"),
          runtime: resolve(__dirname, "src/runtime/main.ts"),
        },
        formats: ["es"],
      },
      rollupOptions: {
        // Only the shell entry resolves this; the runtime chain never imports it.
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
