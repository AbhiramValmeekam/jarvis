/**
 * Prove the hand-tracking seam actually steers the neural core.
 *
 * `npm run verify` can only show that the mapping functions are right; it cannot
 * show that a frame handed to `window.jarvisGesture` reaches a WebGL transform.
 * This drives the bridge exactly the way an OpenCV script would — one JSON frame
 * at a time, thirty times a second — and then measures the rendered pixels to
 * check the three claims the gesture path makes:
 *
 *   1. The seam exists and answers. `version` is 1 and no frame throws.
 *   2. Lateral hand movement ROTATES. The frame changes substantially while the
 *      sun stays put — a rig that translated instead would carry the core across
 *      the panel, which is the failure this design exists to avoid.
 *   3. A pinch zooms. Fingers apart renders a measurably larger assembly than
 *      fingers together.
 *
 * Plus the two ways control is meant to end: an explicit release, and a tracker
 * that simply stops sending, which must both recentre the rig.
 *
 * Requires a build (`npm run build`) and a GPU — software rasterisation renders
 * the field too dimly for the thresholds below to mean anything.
 *
 * Run: npm run build && npm run probe:gesture
 */
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
// Shared with `probe-gesture-socket.mjs`, so both probes mean the same thing by
// "the assembly moved". See `hud-pixels.mjs` for why the grid is coarse.
import { difference, measure } from "./hud-pixels.mjs";

const results = [];
const failures = [];
let stage = "startup";

const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, stalledAt: stage, results }, null, 2));
  app.exit(1);
}, 120_000);
watchdog.unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  results.push({ name, ok, ...detail });
  if (!ok) failures.push(name);
}

/** Start (or retarget) a 30 fps stream of frames, exactly as a tracker would. */
async function track(win, x, y, pinch) {
  const frame = JSON.stringify({ x, y, pinch });
  const failed = await win.webContents.executeJavaScript(`(() => {
    const bridge = window.jarvisGesture;
    if (!bridge || bridge.version !== 1) return "no bridge on window";
    clearInterval(window.__handTimer);
    const send = () => bridge.hand(${JSON.stringify(frame)});
    send();
    window.__handTimer = setInterval(send, 33);
    return "";
  })()`);
  if (failed) throw new Error(failed);
}

/** Stop sending, without telling the core — the "tracker died" case. */
async function stopTracking(win) {
  await win.webContents.executeJavaScript("clearInterval(window.__handTimer), ''");
}

async function capture(win) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const image = await win.webContents.capturePage();
      if (!image.isEmpty()) return measure(image);
    } catch (err) {
      if (attempt === 4) throw err;
    }
    await sleep(700);
  }
  throw new Error("capturePage returned an empty bitmap four times");
}

/** Settle time: the slowest thing in the rig is the zoom easing at tau 0.22. */
const SETTLE = 1_600;

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
    await sleep(2_500);

    stage = "neutral";
    await track(win, 0.5, 0.5, 0.14);
    await sleep(SETTLE);
    const neutral = await capture(win);
    // The same pose again, seconds later. The rings precess and the field drifts
    // the whole time, so this is what "unchanged" actually measures — every
    // threshold below is a multiple of it rather than a number picked by hand.
    await sleep(SETTLE);
    const neutralAgain = await capture(win);
    const noise = difference(neutral, neutralAgain);

    stage = "hand right";
    await track(win, 0.12, 0.5, 0.14);
    await sleep(SETTLE);
    const right = await capture(win);

    stage = "hand left";
    await track(win, 0.88, 0.5, 0.14);
    await sleep(SETTLE);
    const left = await capture(win);

    stage = "hand high and low";
    await track(win, 0.12, 0.12, 0.14);
    await sleep(SETTLE);
    const upper = await capture(win);
    await track(win, 0.88, 0.88, 0.14);
    await sleep(SETTLE);
    const lower = await capture(win);

    check("the seam is reachable and every frame was accepted", true, {
      bridge: "window.jarvisGesture v1",
      restingDrift: `${noise.toFixed(1)}%`,
    });

    // The rotation claim, in two halves: the pose changed, and the sun did not
    // move. Only a rotation can do both.
    //
    // The lateral pair is the smaller of the two signals *by design*: yaw turns a
    // field that is very nearly a sphere, so there is not much of an outline to
    // change — which is exactly why rotating is the safe answer to a hand crossing
    // the frame, where translating would carry the whole assembly off the panel.
    // The diagonal pair adds pitch, which tips the lens the rings lie in, and that
    // is plainly visible.
    const swing = difference(right, left);
    const diagonal = difference(upper, lower);
    check("a hand crossing the frame rotates the assembly", swing > noise * 2, {
      lateralDifference: `${swing.toFixed(1)}%`,
      diagonalDifference: `${diagonal.toFixed(1)}%`,
      restingDrift: `${noise.toFixed(1)}%`,
    });
    check("a hand raised and lowered pitches it", diagonal > noise * 3, {
      diagonalDifference: `${diagonal.toFixed(1)}%`,
      restingDrift: `${noise.toFixed(1)}%`,
    });

    const drift = Math.max(
      Math.abs(right.sunX - left.sunX),
      Math.abs(right.sunX - neutral.sunX),
      Math.abs(left.sunX - neutral.sunX),
    );
    // Allowance measured, not guessed: the sun's centroid wanders a pixel or two
    // between two captures of the same pose, and once in about four runs a capture
    // lands mid-frame and it wanders further. A translation would move it by a
    // large fraction of the panel, so the floor below is what keeps the check
    // meaningful and the jitter term is what keeps it from flaking.
    const sunJitter = Math.abs(neutral.sunX - neutralAgain.sunX);
    const allowance = Math.max(8, sunJitter * 4);
    check("the core stays put instead of sliding off the panel", drift < allowance, {
      maxSunDriftPx: drift.toFixed(1),
      allowancePx: allowance.toFixed(1),
      restingSunJitterPx: sunJitter.toFixed(1),
      sunX: [neutral.sunX, right.sunX, left.sunX].map((n) => n.toFixed(1)),
      panelWidthPx: neutral.width,
    });

    stage = "explicit release";
    // Held hard over to one side first, so there is something to come back from.
    await track(win, 0.12, 0.12, 0.14);
    await sleep(SETTLE);
    const held = await capture(win);
    await win.webContents.executeJavaScript("window.jarvisGesture.release(), ''");
    await stopTracking(win);
    await sleep(SETTLE);
    const released = await capture(win);
    // Against a *freshly* captured centred pose, not the one from the top of the
    // run. The rings precess continuously — at 0.16 turns a second the stack is
    // three revolutions further on by now, so a reference frame from twenty
    // seconds ago differs from the same pose today by more than a pose change
    // does. That mistake is what made the first version of this probe fail.
    await track(win, 0.5, 0.5, 0.14);
    await sleep(SETTLE);
    const centredAgain = await capture(win);
    const afterRelease = difference(released, centredAgain);
    check("releasing recentres the rig", afterRelease < difference(released, held), {
      differenceFromCentred: `${afterRelease.toFixed(1)}%`,
      differenceFromHeldPose: `${difference(released, held).toFixed(1)}%`,
      restingDrift: `${noise.toFixed(1)}%`,
    });

    stage = "tracker stops sending";
    await track(win, 0.12, 0.12, 0.14);
    await sleep(SETTLE);
    const heldAgain = await capture(win);
    await stopTracking(win);
    // Past HAND_TIMEOUT_MS (450) plus the easing that follows it.
    await sleep(SETTLE);
    const abandoned = await capture(win);
    await track(win, 0.5, 0.5, 0.14);
    await sleep(SETTLE);
    const centredOnceMore = await capture(win);
    const afterStall = difference(abandoned, centredOnceMore);
    check(
      "a tracker that dies mid-gesture hands control back",
      afterStall < difference(abandoned, heldAgain),
      {
        differenceFromCentred: `${afterStall.toFixed(1)}%`,
        differenceFromHeldPose: `${difference(abandoned, heldAgain).toFixed(1)}%`,
      },
    );

    stage = "pinch";
    await track(win, 0.5, 0.5, 0.05);
    await sleep(SETTLE);
    const closed = await capture(win);
    await track(win, 0.5, 0.5, 0.32);
    await sleep(SETTLE);
    const open = await capture(win);
    const growth = open.lit / Math.max(1, closed.lit);
    check("spreading the fingers zooms in", growth > 1.25, {
      litPixels: { pinchClosed: closed.lit, pinchOpen: open.lit },
      growth: `${growth.toFixed(2)}x`,
    });
    const pinchDrift = Math.abs(open.sunX - closed.sunX);
    // A couple of percent of the panel's width. Not zero: at full zoom the sun is
    // several times the area it was, and a centroid over a much larger, dimmer
    // disc is a noisier number than one over a tight bright one.
    check("zoom stays centred on the core", pinchDrift < neutral.width * 0.03, {
      sunDriftPx: pinchDrift.toFixed(1),
      panelWidthPx: neutral.width,
    });

    check("nothing logged an error while being driven", consoleErrors.length === 0, {
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
