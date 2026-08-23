/**
 * Render the built HUD and save a screenshot.
 *
 * "It compiles" is not "it renders". This loads the real renderer bundle in a
 * real Electron window and captures what a user would see.
 *
 * By default it deliberately loads the renderer WITHOUT the preload bridge, so
 * `window.jarvis` is undefined — which is also the honest test of the degraded
 * path: with no runtime link the HUD must come up showing "offline" rather
 * than a blank screen or a crash.
 *
 * Set JARVIS_SHOT_STATE to attach `stub-bridge.cjs` and capture a connected
 * HUD; add JARVIS_SHOT_PANEL=<tab> to open the Command Center on one of its
 * tabs (tasks / mcp / memory / skills / activity).
 *
 * Set JARVIS_SHOT_GPU=1 to keep hardware acceleration on. Off by default so a
 * headless CI box renders deterministically, but the software rasteriser starves
 * drei's `PerformanceMonitor` — it measures a low frame rate, drops the pixel
 * ratio, and the neural core's points come out under-rendered and dim. Any
 * judgement about how the 3D scene actually *looks* has to be made with this set.
 *
 * Run: npm run build && npx electron scripts/shot-renderer.mjs out/hud.png
 */
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "out/hud.png");
const panel = process.env["JARVIS_SHOT_PANEL"] ?? "";
const errors = [];
const ignored = [];
let stage = "startup";

/**
 * Console warnings that come from dependencies and that we cannot act on.
 *
 * The rule here stays "any warning is a failure" — that is what makes this
 * harness worth running. These are listed individually and still reported, under
 * `ignored` rather than `errors`, so nothing is silently swallowed: a warning
 * that stops being upstream noise will show up in the output the moment its text
 * changes and no longer matches.
 */
const UPSTREAM_NOISE = [
  // Emitted by @react-three/fiber's own render loop. Nothing in this repo
  // constructs a THREE.Clock.
  "THREE.Clock: This module has been deprecated",
];

// Never hang a build on a stuck renderer — report where it stalled instead.
const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, stalledAt: stage, errors, ignored }, null, 2));
  app.exit(1);
}, 45_000);
watchdog.unref?.();

if (!process.env["JARVIS_SHOT_GPU"]) app.disableHardwareAcceleration();

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
      backgroundColor: "#0d0805",
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
      if (level !== "error" && level !== "warning") return;
      // Errors are never excused — only warnings can be upstream noise.
      if (level === "warning" && UPSTREAM_NOISE.some((n) => message.includes(n))) {
        ignored.push(`${level}: ${message}`);
        return;
      }
      errors.push(`${level}: ${message}`);
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

    if (panel) {
      // Click the real buttons rather than reaching into React state: the point
      // of this harness is to prove the path a user takes, and a state poke
      // would skip the very wiring that was missing before Phase 11.
      stage = `opening the ${panel} panel`;
      const opened = await win.webContents.executeJavaScript(`(() => {
        const byText = (t) =>
          [...document.querySelectorAll("button")].find(
            (b) => b.textContent.trim().toLowerCase() === t,
          );
        const entry = byText("command");
        if (!entry) return "no Command button";
        entry.click();
        return new Promise((done) => setTimeout(() => {
          const labels = { tasks: "scheduled", mcp: "connected", memory: "memory",
                           skills: "skills", activity: "activity" };
          const want = labels[${JSON.stringify(panel)}];
          if (!want) return done("unknown panel: ${panel}");
          const tab = [...document.querySelectorAll("button")].find(
            (b) => b.textContent.trim().toLowerCase().startsWith(want),
          );
          if (!tab) return done("no tab labelled " + want);
          tab.click();
          setTimeout(() => done(""), 400);
        }, 400));
      })()`);
      if (opened) errors.push(`panel: ${opened}`);
      await new Promise((r) => setTimeout(r, 600));
    }

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
        { ok: errors.length === 0, out, size: image.getSize(), text, errors, ignored },
        null,
        2,
      ),
    );
    app.exit(errors.length ? 1 : 0);
  } catch (err) {
    clearTimeout(watchdog);
    console.log(JSON.stringify({ ok: false, stage, error: String(err), errors, ignored }, null, 2));
    app.exit(1);
  }
});
