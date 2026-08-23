/**
 * Prove a *socket* steers the neural core — the half unit tests cannot reach.
 *
 * `tests/gesture-socket.test.ts` pins the mapping and the reconnect logic against
 * a fake socket, which leaves three things unproven, all of them the kind that
 * only fail on a real machine:
 *
 *   1. **The renderer is allowed to connect at all.** `src/ui/index.html` ships a
 *      strict CSP, and `connect-src` had to be widened by hand for loopback
 *      websockets. A CSP that blocks the port looks exactly like a tracker that
 *      is not running, which is the most expensive kind of bug to chase.
 *   2. **`{rotationX, rotationY, zoom}` off the wire ROTATES the assembly.** The
 *      frame must change while the sun stays put; a rig that translated instead
 *      would slide the core off the panel.
 *   3. **A tracker dying gives the mouse back, and coming back is picked up.**
 *      The socket drops, the rig recentres, and the retry reconnects on its own.
 *
 * So this stands up a real WebSocket server on a real loopback port, tells the
 * renderer where it is through the preload, and measures the rendered pixels.
 *
 * Requires a build (`npm run build`) and a GPU — software rasterisation renders
 * the field too dimly for the thresholds below to mean anything.
 *
 * Run: npm run build && npm run probe:gesture:socket
 */
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { difference, measure } from "./hud-pixels.mjs";
import { startGestureServer } from "./gesture-ws-server.mjs";

// Same reason as probe-frames.mjs: Chromium stops giving animation frames to a
// window it believes is covered, and whether this one is under the terminal that
// launched it is not a property of the scene.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const results = [];
const failures = [];
let stage = "startup";

const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, stalledAt: stage, results }, null, 2));
  app.exit(1);
}, 150_000);
watchdog.unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Settle time: the slowest thing in the rig is the zoom easing at tau 0.22. */
const SETTLE = 1_600;

function check(name, ok, detail) {
  results.push({ name, ok, ...detail });
  if (!ok) failures.push(name);
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

/** Hold a pose by pushing it at 30 fps, which is what a tracker does. */
function hold(server, payload) {
  clearInterval(hold.timer);
  const send = () => server.send(payload);
  send();
  hold.timer = setInterval(send, 33);
  hold.timer.unref?.();
}

function stopHolding() {
  clearInterval(hold.timer);
  hold.timer = null;
}

/** Wait for a condition, or give up. Beats sleeping and hoping. */
async function until(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

app.whenReady().then(async () => {
  let server = null;
  try {
    stage = "starting the tracker's server";
    let connections = 0;
    server = await startGestureServer({ port: 0, onConnection: () => (connections += 1) });

    // Read by stub-bridge.cjs in the renderer, which the renderer process
    // inherits — set before the window exists, so the app sees it on first mount.
    process.env["JARVIS_SHOT_GESTURE_WS"] = `ws://127.0.0.1:${server.port}`;
    process.env["JARVIS_SHOT_STATE"] ??= "idle";

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
    win.setAlwaysOnTop(true, "screen-saver");
    win.focus();
    await sleep(2_500);

    stage = "waiting for the renderer to dial in";
    // The CSP check, and it is a real one: a `connect-src` that did not allow
    // ws://127.0.0.1:* would leave this at zero and log a violation, which the
    // console-error check below would also catch.
    await until(() => server.clients > 0, 12_000, "the renderer to open the socket");
    check("the renderer connects to a loopback tracker (so the CSP allows it)", true, {
      endpoint: `ws://127.0.0.1:${server.port}`,
      connections,
    });

    stage = "neutral";
    hold(server, { rotationX: 0, rotationY: 0, zoom: 1 });
    await sleep(SETTLE);
    const neutral = await capture(win);
    // The same pose again, seconds later: the rings precess and the field drifts
    // the whole time, so this is what "unchanged" actually measures. Every
    // threshold below is a multiple of it rather than a number picked by hand.
    await sleep(SETTLE);
    const neutralAgain = await capture(win);
    const noise = difference(neutral, neutralAgain);

    stage = "yaw one way, then the other";
    hold(server, { rotationX: 0, rotationY: 0.9, zoom: 1 });
    await sleep(SETTLE);
    const right = await capture(win);
    hold(server, { rotationX: 0, rotationY: -0.9, zoom: 1 });
    await sleep(SETTLE);
    const left = await capture(win);

    stage = "pitch";
    hold(server, { rotationX: 0.9, rotationY: 0, zoom: 1 });
    await sleep(SETTLE);
    const up = await capture(win);
    hold(server, { rotationX: -0.9, rotationY: 0, zoom: 1 });
    await sleep(SETTLE);
    const down = await capture(win);

    const swing = difference(right, left);
    const pitchSwing = difference(up, down);
    const sunDrift = Math.abs(right.sunX - left.sunX);
    check("a rotation payload turns the assembly", swing > noise * 1.8, {
      restingDrift: `${noise.toFixed(1)}%`,
      yawSwing: `${swing.toFixed(1)}%`,
      pitchSwing: `${pitchSwing.toFixed(1)}%`,
    });
    // Turning, not sliding. The sun is the assembly's centre, and a yaw leaves it
    // where it was; a translation carries it across the panel.
    check("and turns it rather than sliding it", sunDrift < neutral.width * 0.02, {
      sunDriftPx: sunDrift.toFixed(1),
      allowancePx: (neutral.width * 0.02).toFixed(1),
      windowPx: neutral.width,
    });

    stage = "zoom";
    hold(server, { rotationX: 0, rotationY: 0, zoom: 0.7 });
    await sleep(SETTLE * 2);
    const out = await capture(win);
    hold(server, { rotationX: 0, rotationY: 0, zoom: 2.4 });
    await sleep(SETTLE * 2);
    const near = await capture(win);
    check("an absolute zoom scales the assembly", near.lit > out.lit * 1.5, {
      litFarPx: out.lit,
      litNearPx: near.lit,
      ratio: (near.lit / Math.max(1, out.lit)).toFixed(2),
    });

    // Every comparison from here on is against a reference captured seconds
    // either side of it, never against `neutral`. The scene animates the whole
    // time — two captures of the same pose a minute apart came out ~8% apart,
    // which is more than the pose difference being measured. Time-local pairs or
    // nothing.
    const centredCapture = async () => {
      hold(server, { rotationX: 0, rotationY: 0, zoom: 1 });
      await sleep(SETTLE);
      return capture(win);
    };

    stage = "the tracker dies";
    hold(server, { rotationX: 0.8, rotationY: 0.8, zoom: 1 });
    await sleep(SETTLE);
    const held = await capture(win);
    stopHolding();
    // Read before the drop, not after: the first retry delay is 800 ms, so the
    // renderer is usually back before the settle below finishes, and a baseline
    // taken afterwards would be waiting for a *second* reconnect that never comes.
    const beforeDrop = connections;
    // Dropping the connection without closing the port is a tracker crashing, not
    // a tracker shutting down politely — the case the fallback exists for.
    server.dropClients();
    await sleep(SETTLE);
    const afterDrop = await capture(win);

    stage = "the tracker comes back";
    // No new server, no reload: the renderer's own retry has to notice. The
    // backoff caps at 10 s, so this waits longer than the checks above.
    await until(
      () => connections > beforeDrop && server.clients > 0,
      25_000,
      "the renderer to reconnect",
    );
    const centredAfterDrop = await centredCapture();
    check(
      "a dropped socket hands control back and recentres the rig",
      difference(afterDrop, centredAfterDrop) < difference(afterDrop, held),
      {
        differenceFromRest: `${difference(afterDrop, centredAfterDrop).toFixed(1)}%`,
        differenceFromHeldPose: `${difference(afterDrop, held).toFixed(1)}%`,
        restingDrift: `${noise.toFixed(1)}%`,
      },
    );
    hold(server, { rotationX: -0.9, rotationY: -0.9, zoom: 1 });
    await sleep(SETTLE);
    const resumed = await capture(win);
    check(
      "and a tracker that comes back is steering again without a reload",
      difference(resumed, centredAfterDrop) > noise * 1.8,
      {
        reconnects: connections - beforeDrop,
        differenceFromRest: `${difference(resumed, centredAfterDrop).toFixed(1)}%`,
        restingDrift: `${noise.toFixed(1)}%`,
      },
    );

    stage = "release";
    hold(server, { rotationX: 0.9, rotationY: 0.9, zoom: 1 });
    await sleep(SETTLE);
    const heldAgain = await capture(win);
    stopHolding();
    server.send({ release: true });
    await sleep(SETTLE);
    const released = await capture(win);
    const centredAfterRelease = await centredCapture();
    check(
      "an explicit release lets go without dropping the socket",
      difference(released, centredAfterRelease) < difference(released, heldAgain) &&
        server.clients > 0,
      {
        differenceFromRest: `${difference(released, centredAfterRelease).toFixed(1)}%`,
        differenceFromHeldPose: `${difference(released, heldAgain).toFixed(1)}%`,
        stillConnected: server.clients > 0,
      },
    );

    stage = "malformed payloads";
    // What a tracker emits while it is restarting: half a line, a blank line, a
    // log line that ended up on the wrong stream. None of it may move the rig,
    // because snapping to centre mid-gesture is as wrong as freezing.
    const beforeJunk = await centredCapture();
    stopHolding();
    // One window of the scene simply animating, with nothing sent, measured right
    // here rather than reused from the top of the run: the drift over a 1.6 s gap
    // is a few percent and grows with the gap, so the junk window has to be
    // judged against a silent window of the same length beside it.
    await sleep(SETTLE);
    const idleDrift = await capture(win);
    const restingSpan = difference(idleDrift, beforeJunk);
    for (const bad of ['{"rotationX":', "", "not json", '{"rotationX":"left"}', "[]", "7"]) {
      server.send(bad);
    }
    await sleep(SETTLE);
    const afterJunk = await capture(win);
    const junkSpan = difference(afterJunk, idleDrift);
    check("malformed payloads are ignored rather than obeyed", junkSpan < restingSpan * 1.6 + noise, {
      changeOverJunkWindow: `${junkSpan.toFixed(1)}%`,
      changeOverSilentWindow: `${restingSpan.toFixed(1)}%`,
      allowance: `${(restingSpan * 1.6 + noise).toFixed(1)}%`,
    });

    stage = "hostile numbers";
    // A local process could send anything. The answer is not to trust the range:
    // 1e9 must land on the same limit the mouse wheel is held to, not throw and
    // not fling the assembly through the panel.
    server.send({ rotationX: 1e9, rotationY: -1e9, zoom: 1e9 });
    await sleep(SETTLE * 2);
    const afterHostile = await capture(win);
    check(
      "hostile numbers are clamped to the same limits as the wheel",
      afterHostile.lit > 0 && afterHostile.lit < near.lit * 1.35,
      {
        litPx: afterHostile.lit,
        litAtMaxWheelZoom: near.lit,
        allowancePx: Math.round(near.lit * 1.35),
      },
    );

    check("nothing logged an error while being driven over the wire", consoleErrors.length === 0, {
      consoleErrors,
    });

    stopHolding();
    await server.close();
    clearTimeout(watchdog);
    console.log(JSON.stringify({ ok: failures.length === 0, failures, results }, null, 2));
    app.exit(failures.length ? 1 : 0);
  } catch (err) {
    stopHolding();
    await server?.close().catch(() => {});
    clearTimeout(watchdog);
    console.log(JSON.stringify({ ok: false, stage, error: String(err), results }, null, 2));
    app.exit(1);
  }
});
