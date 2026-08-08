/**
 * Render the built HUD and save a screenshot.
 *
 * "It compiles" is not "it renders". This loads the real renderer bundle in a
 * real Electron window and captures what a user would see.
 *
 * It deliberately loads the renderer WITHOUT the preload bridge, so
 * `window.jarvis` is undefined — which is also the honest test of the degraded
 * path: with no runtime link the HUD must come up showing "offline" rather
 * than a blank screen or a crash.
 *
 * Run: npm run build && npx electron scripts/shot-renderer.mjs out/hud.png
 */
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "out/hud.png");
const errors = [];
let stage = "startup";

// Never hang a build on a stuck renderer — report where it stalled instead.
const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, stalledAt: stage, errors }, null, 2));
  app.exit(1);
}, 45_000);
watchdog.unref?.();

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    stage = "creating window";
    const win = new BrowserWindow({
      width: 460,
      height: 680,
      // capturePage on a never-shown window can return an empty bitmap, so the
      // window is shown but parked off to the side.
      show: true,
      x: 40,
      y: 40,
      frame: false,
      backgroundColor: "#05070d",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // Optional stub bridge, so live states can be captured without a
        // runtime. Omitted by default, which exercises the offline path.
        ...(process.env["JARVIS_SHOT_STATE"]
          ? { preload: join(import.meta.dirname, "stub-bridge.cjs") }
          : {}),
      },
    });

    win.webContents.on("console-message", (event) => {
      // Electron 43 passes a single event object.
      const level = event?.level ?? "";
      const message = event?.message ?? "";
      if (level === "error" || level === "warning") errors.push(`${level}: ${message}`);
    });
    win.webContents.on("render-process-gone", (_e, details) =>
      errors.push(`renderer gone: ${details.reason}`),
    );
    win.webContents.on("did-fail-load", (_e, code, desc) =>
      errors.push(`did-fail-load ${code}: ${desc}`),
    );

    stage = "loading renderer";
    await win.loadFile(join(import.meta.dirname, "../out/renderer/index.html"));

    stage = "settling";
    await new Promise((r) => setTimeout(r, 2_000));

    stage = "reading DOM";
    const text = await win.webContents.executeJavaScript(
      "document.getElementById('root')?.innerText ?? ''",
    );

    stage = "capturing";
    // capturePage occasionally fails with a transient compositor error
    // (UnknownVizError) on the first attempt; retry before giving up.
    let image = null;
    for (let attempt = 1; attempt <= 4 && !image; attempt++) {
      try {
        image = await win.webContents.capturePage();
        if (image.isEmpty()) {
          image = null;
          throw new Error("empty bitmap");
        }
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    writeFileSync(out, image.toPNG());

    clearTimeout(watchdog);
    console.log(
      JSON.stringify(
        { ok: errors.length === 0, out, size: image.getSize(), text, errors },
        null,
        2,
      ),
    );
    app.exit(errors.length ? 1 : 0);
  } catch (err) {
    clearTimeout(watchdog);
    console.log(JSON.stringify({ ok: false, stage, error: String(err), errors }, null, 2));
    app.exit(1);
  }
});
