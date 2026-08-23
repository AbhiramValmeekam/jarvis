/**
 * What the visible HUD costs, and what the hidden one does not.
 *
 * Open action 6 in `docs/IMPLEMENTATION_PLAN.md` asks a question §72 cannot
 * answer: §72 measured the always-on *runtime* — plain Node, no Chromium — while
 * the number nobody had was the shell's own cost during the minutes the neural
 * core is actually on screen. "59.9 fps" was measured once by hand and predates
 * the field and ring rework, so it is re-measured here as a script instead.
 *
 * Three things get measured, in the busiest live state the HUD has (listening at
 * a 0.4 level — the most particles, the strongest bloom, the fastest field):
 *
 *   1. Frame pacing while visible: fps, median, p95 and the worst single frame.
 *      Median is the honest headline; a mean hides a stall.
 *   2. Process CPU while visible, split browser / GPU / renderer via
 *      `app.getAppMetrics()`. This is the part that matters on battery.
 *   3. The same CPU figures with the window hidden. Closing the HUD hides it
 *      rather than destroying it (§13), so `frameloop="never"` on a hidden
 *      document is the only thing standing between an always-on assistant and a
 *      60 fps WebGL loop running behind a window nobody can see.
 *
 * Then it shows the window again, because a gate that never re-opens would be a
 * worse bug than the one it prevents.
 *
 * Requires a build and a GPU: under software rasterisation drei's
 * `PerformanceMonitor` measures a low frame rate, drops the pixel ratio, and
 * every number below describes the rasteriser rather than the scene.
 *
 * Run: npm run build && npm run probe:frames
 */
import { app, BrowserWindow } from "electron";
import { join } from "node:path";

// Chromium's native occlusion calculation decides a covered window is hidden and
// stops giving it animation frames — which is correct for a browser and useless
// for a probe, because whether this window happens to be under the terminal that
// launched it is not a property of the scene. Two runs of this script disagreed
// (60.3 fps, then 0.0) on nothing else. Switched off so "visible" means shown;
// `win.hide()` below still hides the window for real, so the hidden-cost half of
// the measurement is unaffected.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const results = [];
const failures = [];
let stage = "startup";

const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, stalledAt: stage, results }, null, 2));
  app.exit(1);
}, 90_000);
watchdog.unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long to watch the frame clock. Long enough for a stall to show up. */
const SAMPLE_MS = 4_000;
/** And how long to leave the window hidden before believing the loop stopped. */
const HIDDEN_MS = 3_000;

function check(name, ok, detail) {
  results.push({ name, ok, ...detail });
  if (!ok) failures.push(name);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

/** Start counting animation frames in the page, discarding any earlier run. */
async function startCounting(win) {
  await win.webContents.executeJavaScript(`(() => {
    window.__frames = [];
    window.__stop = true;
    requestAnimationFrame(function tick(t) {
      window.__frames.push(t);
      if (!window.__stopped) requestAnimationFrame(tick);
    });
    window.__stopped = false;
    return "";
  })()`);
}

/** Frame timings since `startCounting`, in milliseconds between frames. */
async function readFrames(win) {
  const stamps = await win.webContents.executeJavaScript("window.__frames.slice()");
  const gaps = [];
  for (let i = 1; i < stamps.length; i += 1) gaps.push(stamps[i] - stamps[i - 1]);
  return { frames: stamps.length, gaps };
}

async function resetFrames(win) {
  await win.webContents.executeJavaScript("window.__frames.length = 0, ''");
}

/**
 * CPU percentages by process type, averaged by Chromium over its own window.
 *
 * `getAppMetrics` reports one entry per process; the interesting three are the
 * browser process, the GPU process and the renderer hosting the HUD.
 *
 * `percentCPUUsage` is measured *since the previous call*, which is why every
 * measurement below primes it and then reads it after the sample window rather
 * than reading it once. Read cold it reports 0 for everything, which the first
 * run of this script duly claimed about a scene holding 60 fps.
 */
function cpuByType() {
  const byType = {};
  for (const m of app.getAppMetrics()) {
    const type = m.type === "Tab" ? "renderer" : m.type;
    byType[type] = Math.round(((byType[type] ?? 0) + (m.cpu?.percentCPUUsage ?? 0)) * 10) / 10;
  }
  return byType;
}

// The busiest live state, unless the caller asked for another one.
process.env["JARVIS_SHOT_STATE"] ??= "listening";
process.env["JARVIS_SHOT_LEVEL"] ??= "0.4";

app.whenReady().then(async () => {
  try {
    stage = "creating window";
    const win = new BrowserWindow({
      width: 460,
      height: 680,
      show: true,
      x: 40,
      y: 40,
      frame: false,
      backgroundColor: "#0d0805",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: join(import.meta.dirname, "stub-bridge.cjs"),
      },
    });

    const consoleErrors = [];
    win.webContents.on("console-message", (event) => {
      if (event?.level === "error") consoleErrors.push(event.message);
    });

    stage = "loading renderer";
    await win.loadFile(join(import.meta.dirname, "../out/renderer/index.html"));
    // Genuinely in front, and not by politeness. Chromium's background
    // throttling treats a fully occluded window much like a hidden one, so a
    // probe window parked under a terminal measures the throttle rather than the
    // scene — the first run of this script reported 0 frames while "visible" for
    // exactly that reason. `backgroundThrottling` is deliberately left at its
    // default, because switching it off would also destroy the hidden-cost
    // measurement below, which is the half that matters for an always-on app.
    win.setAlwaysOnTop(true, "screen-saver");
    win.focus();
    // Long enough for the lazy three.js chunk, the first compile of the shaders
    // and drei's own frame-rate settling. Measuring through that would report the
    // cost of starting up, not the cost of running.
    await sleep(4_000);

    stage = "measuring while visible";
    const dpr = await win.webContents.executeJavaScript("window.devicePixelRatio");
    cpuByType(); // primes the counters; see `cpuByType`
    await startCounting(win);
    await sleep(SAMPLE_MS);
    const visible = await readFrames(win);
    const visibleCpu = cpuByType();

    const gaps = [...visible.gaps].sort((a, b) => a - b);
    const fps = (visible.frames / SAMPLE_MS) * 1_000;
    const median = percentile(gaps, 0.5);
    const p95 = percentile(gaps, 0.95);
    const worst = gaps.length ? gaps[gaps.length - 1] : 0;

    // 20 ms is 50 fps: a HUD that misses the 60 fps budget by a frame here and
    // there is fine, one that is consistently a third slow is not. The frame
    // count is part of the same check rather than a separate one, because a
    // window that drew *nothing* has a median gap of zero and would otherwise
    // pass the budget by never trying — which is exactly how the first version of
    // this probe reported a throttled window as healthy.
    check("the visible HUD holds its frame budget", median <= 20 && visible.frames >= 100, {
      devicePixelRatio: dpr,
      visibilityState: await win.webContents.executeJavaScript("document.visibilityState"),
      fps: fps.toFixed(1),
      medianFrameMs: median.toFixed(1),
      p95FrameMs: p95.toFixed(1),
      worstFrameMs: worst.toFixed(1),
      framesOver20ms: gaps.filter((g) => g > 20).length,
      frames: visible.frames,
      cpuPercent: visibleCpu,
    });

    stage = "hiding the window";
    await resetFrames(win);
    win.hide();
    cpuByType(); // primes again, so the figures below cover the hidden window only
    await sleep(HIDDEN_MS);
    const hidden = await readFrames(win);
    const hiddenCpu = cpuByType();
    // Not "fewer frames" — none. Chromium throttles a hidden window's animation
    // frames, and `frameloop="never"` stops r3f asking for them at all, so the
    // honest expectation is zero and the allowance is for one already in flight.
    check("a hidden HUD draws nothing", hidden.frames <= 1, {
      framesIn3s: hidden.frames,
      cpuPercent: hiddenCpu,
    });
    check(
      "and costs no renderer CPU while hidden",
      (hiddenCpu["renderer"] ?? 0) <= 2,
      { hiddenRendererCpu: hiddenCpu["renderer"] ?? 0, visibleRendererCpu: visibleCpu["renderer"] ?? 0 },
    );

    stage = "showing it again";
    await resetFrames(win);
    win.show();
    win.setAlwaysOnTop(true, "screen-saver");
    win.focus();
    await sleep(1_500);
    const resumed = await readFrames(win);
    // A gate that latches shut would be worse than the loop it saves: the HUD is
    // opened by a wake word, and it must draw the second time as well.
    check("showing it again resumes drawing", resumed.frames > 20, {
      framesIn1500ms: resumed.frames,
    });

    check("nothing logged an error while being measured", consoleErrors.length === 0, {
      consoleErrors,
    });

    clearTimeout(watchdog);
    console.log(JSON.stringify({ ok: failures.length === 0, failures, results }, null, 2));
    app.exit(failures.length ? 1 : 0);
  } catch (err) {
    clearTimeout(watchdog);
    console.log(JSON.stringify({ ok: false, stage, error: String(err), results }, null, 2));
    app.exit(1);
  }
});
