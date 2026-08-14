/**
 * Which microphone can actually hear you.
 *
 *   npm run probe:mic            # 8 s, every input device, then the models
 *   npm run probe:mic -- --pin   # …and write the winner into config.json
 *
 * **Why this exists.** `voice/daemon.py` opens `Capture.list_devices()[0]` when
 * no device is configured — whatever ffmpeg's dshow enumeration happens to return
 * first, which depends on what Windows initialised in what order. On 2026-08-15
 * that was a far-field `Microphone Array (AMD Audio Device)` on a machine whose
 * working configuration had been a Realtek headset. Every component reported
 * healthy: the daemon was capturing, the wake model was loaded, the runtime said
 * `wakeWord: available` — and saying "Jarvis" did nothing, because the audio in
 * the pipeline was silence.
 *
 * A probe cannot say a word out loud, so this one asks the user to, and then
 * answers the only question that separates the two microphones: which of them
 * carried the voice. Every device is recorded **simultaneously**, from one
 * utterance, so the numbers are comparable rather than sequential guesses.
 *
 * **What it touches.** It opens the microphones and writes WAVs under
 * `.research/audio/mic-probe/`, which it deletes on the way out unless `--keep`.
 * Recorded audio never leaves the machine (§50). With `--pin` it also writes one
 * key into `%LOCALAPPDATA%\Jarvis\config.json`, merging as `configure-install`
 * does. No registry, no system change, no admin.
 *
 *   npx tsx scripts/probe-mic.ts [--seconds N] [--fast] [--pin] [--keep]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configFilePath, loadConfig } from "../src/context/config.js";
import { SILENCE_FLOOR_RMS } from "../src/voice/voice-sidecar.js";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken } from "../src/ipc/token.js";
import type { RuntimeStatus } from "../src/ipc/contract.js";

/** The repo root, not `process.cwd()` — same reasoning as `configure-install`. */
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PYTHON = join(root, ".venv", "Scripts", "python.exe");
const DAEMON = join(root, "voice", "daemon.py");
const OUT_DIR = join(root, ".research", "audio", "mic-probe");
/** The daemon's chunk, so an RMS here means the same thing as a `level` event. */
const CHUNK_SAMPLES = 1280;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined;
const seconds = Math.max(3, Math.min(30, Number(flag("--seconds")) || 8));
const fast = args.includes("--fast");
const pin = args.includes("--pin");
const keep = args.includes("--keep");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the user to say they are ready.
 *
 * The whole probe depends on somebody speaking into it, so it must not start
 * recording while they are still reading the instruction. Skipped when stdin is
 * not a terminal — CI, a pipe, or `--now` — because there is nobody to ask.
 */
async function waitForEnter(): Promise<void> {
  if (args.includes("--now") || !process.stdin.isTTY) return;
  process.stdout.write("Press Enter when you are ready to speak (Ctrl+C to cancel)… ");
  await new Promise<void>((done) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      done();
    });
  });
}

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

/**
 * Input devices, as ffmpeg names them, **in enumeration order**.
 *
 * The order is the finding, not a detail: index 0 is the device the daemon takes
 * when nothing is configured. This asks ffmpeg directly rather than through the
 * daemon so it still works on a machine with no venv built yet.
 */
function listDevices(): string[] {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "utf8", timeout: 20_000, windowsHide: true },
  );
  if (r.error) {
    console.error(`could not run ffmpeg: ${r.error.message}`);
    console.error("The voice daemon shells out to ffmpeg for capture, so this is fatal.");
    process.exit(1);
  }
  const names: string[] = [];
  for (const line of (r.stderr ?? "").split("\n")) {
    if (!line.includes('" (audio)')) continue;
    const start = line.indexOf('"');
    const end = line.indexOf('"', start + 1);
    if (start !== -1 && end !== -1) names.push(line.slice(start + 1, end));
  }
  return names;
}

/** Record one device to a 16 kHz mono WAV. Resolves with ffmpeg's own complaint. */
function record(device: string, path: string): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "dshow", "-i", `audio=${device}`,
        "-ac", "1", "-ar", "16000", "-t", String(seconds),
        "-y", path,
      ],
      // No shell: a device name is not a command line, and re-parsing one that
      // contains a quote is how this becomes command injection.
      { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => (err += c));
    child.on("error", (e) => done(e.message));
    child.on("exit", (code) =>
      done(code === 0 && existsSync(path) ? null : err.trim().split("\n")[0] ?? `exit ${code}`),
    );
  });
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

interface Levels {
  /** Loudest 1280-sample frame, in the same units as a `level` event. */
  peak: number;
  /** Median frame, i.e. the room rather than the voice. */
  median: number;
  frames: number;
}

/**
 * RMS per frame, computed exactly as `voice/daemon.py` computes it.
 *
 * Deliberately not ffmpeg's `volumedetect`: its dB figures are not the numbers
 * the runtime compares against `SILENCE_FLOOR_RMS`, and a probe that reports in
 * different units than the code it is testing invites the wrong conclusion.
 */
function levels(path: string): Levels {
  const buf = readFileSync(path);
  // Find the `data` chunk rather than assuming a 44-byte header: ffmpeg writes a
  // LIST/INFO chunk on some builds and the offset moves.
  let at = 12;
  while (at + 8 <= buf.length && buf.toString("ascii", at, at + 4) !== "data") {
    at += 8 + buf.readUInt32LE(at + 4);
  }
  at += 8;
  const rms: number[] = [];
  for (let i = at; i + CHUNK_SAMPLES * 2 <= buf.length; i += CHUNK_SAMPLES * 2) {
    let sum = 0;
    for (let s = 0; s < CHUNK_SAMPLES; s++) {
      const v = buf.readInt16LE(i + s * 2) / 32768;
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / CHUNK_SAMPLES));
  }
  if (rms.length === 0) return { peak: 0, median: 0, frames: 0 };
  const sorted = [...rms].sort((a, b) => a - b);
  return {
    peak: sorted[sorted.length - 1] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    frames: rms.length,
  };
}

interface ModelScore {
  wakePeak: number;
  wakeMs: number | null;
  transcript: string | null;
}

/**
 * Run the real wake model and the real STT over a recording.
 *
 * `--probe-audio` is the daemon's own measurement mode, so this is the same
 * openWakeWord instance at the same threshold that would have to fire live — and
 * the transcript answers the second half of the question, which is whether the
 * words were intelligible or merely loud.
 */
function score(path: string): ModelScore | string {
  const r = spawnSync(PYTHON, [DAEMON, "--probe-audio", path], {
    cwd: root,
    encoding: "utf8",
    timeout: 240_000,
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
  });
  if (r.error) return r.error.message;
  const line = (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.includes("wakePeak"))
    .pop();
  if (!line) return (r.stderr ?? "").trim().split("\n").pop() ?? "no result from the daemon";
  return JSON.parse(line) as ModelScore;
}

/** What the live runtime is listening to right now, if one is up. */
async function liveDevice(): Promise<{ device: string | null; wakeWord: string } | null> {
  const token = readToken();
  if (!token) return null;
  const client = new PipeClient({ token, clientName: "probe-mic", autoReconnect: false });
  try {
    await client.connectAndAuthenticate();
    const st = (await client.request({ type: "get_status" })) as RuntimeStatus;
    return {
      device: st.voice?.device ?? null,
      wakeWord: `${st.subsystems?.wakeWord?.state ?? "?"} — ${
        st.subsystems?.wakeWord?.detail ?? "no detail"
      }`,
    };
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Write the chosen device into the config, merging.
 *
 * Same rules as `configure-install`: the raw object is edited so keys this build
 * has never heard of survive, and the result is read back through the real
 * `loadConfig` — because "we wrote the file" is a claim about this script, and the
 * question is what Jarvis reads at boot.
 */
function pinDevice(device: string): void {
  const file = configFilePath();
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch (err) {
      console.error(
        `\nrefusing to overwrite a config that could not be parsed: ${err}\n` +
          "Fix or delete the file by hand, then re-run.",
      );
      process.exit(1);
    }
  }
  const before = raw.microphone;
  raw.microphone = device;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

  const readBack = loadConfig(file);
  if (readBack.microphone !== device) {
    console.error(
      `\nwrote the file, but loadConfig read back ${String(readBack.microphone)}. ` +
        "The device name did not survive validation — pin it by hand.",
    );
    process.exit(1);
  }
  console.log(`\n${file}`);
  console.log(`  microphone before : ${before === undefined ? "(unset)" : String(before)}`);
  console.log(`  microphone after  : ${device}`);
  console.log("  verified by reading it back through loadConfig.");
  console.log("\nRestart Jarvis for it to take effect (tray → Quit, then launch again).");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface Result {
  device: string;
  index: number;
  path: string;
  error: string | null;
  levels: Levels | null;
  score: ModelScore | string | null;
}

async function main(): Promise<void> {
  const devices = listDevices();
  if (devices.length === 0) {
    console.error("ffmpeg reports no audio input devices. Nothing here can hear anything.");
    process.exit(1);
  }

  console.log(`${devices.length} input device(s), in the order ffmpeg enumerates them:`);
  devices.forEach((d, i) => {
    console.log(`  [${i}] ${d}${i === 0 ? "   ← what the daemon takes when none is pinned" : ""}`);
  });

  const config = loadConfig();
  console.log(`\nconfig microphone : ${config.microphone ?? "(unset)"}`);
  const live = await liveDevice();
  if (live) {
    console.log(`live runtime      : ${live.device ?? "(none)"}`);
    console.log(`live wake word    : ${live.wakeWord}`);
  } else {
    console.log("live runtime      : not running (or not reachable) — nothing to compare against");
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `\nRecording all ${devices.length} device(s) at once for ${seconds}s.\n` +
      'SAY, at your normal speaking distance and volume:  "Jarvis, what time is it"\n' +
      "Then stay quiet until it finishes.\n",
  );
  await waitForEnter();
  for (let n = 3; n > 0; n--) {
    console.log(`  starting in ${n}…`);
    await wait(1_000);
  }
  console.log("  RECORDING — speak now.");

  const results: Result[] = devices.map((device, index) => ({
    device,
    index,
    path: join(OUT_DIR, `dev${index}.wav`),
    error: null,
    levels: null,
    score: null,
  }));
  // Simultaneous, not sequential: one utterance measured by every device is the
  // only comparison that means anything. Asking the user to say "Jarvis" once per
  // microphone would measure how consistently they can repeat themselves.
  await Promise.all(
    results.map(async (r) => {
      r.error = await record(r.device, r.path);
      if (!r.error) r.levels = levels(r.path);
    }),
  );
  console.log("  done.\n");

  if (!fast) {
    if (!existsSync(PYTHON)) {
      console.log(`no venv at ${PYTHON} — skipping the model pass (levels only).`);
    } else {
      console.log("Scoring each recording through the real wake model and STT…");
      for (const r of results) {
        if (r.error) continue;
        r.score = score(r.path);
      }
    }
  }

  // --- the table ---
  console.log("\n  device                                        peak     median   wake    heard");
  console.log("  " + "-".repeat(88));
  for (const r of results) {
    const name = r.device.length > 44 ? `${r.device.slice(0, 41)}...` : r.device.padEnd(44);
    if (r.error) {
      console.log(`  ${name}  could not record: ${r.error}`);
      continue;
    }
    const l = r.levels!;
    const s = r.score;
    const wake =
      s === null ? "  -  " : typeof s === "string" ? "err  " : s.wakePeak.toFixed(3).padEnd(5);
    const heard =
      s === null || typeof s === "string" ? "" : (s.transcript ?? "").slice(0, 40) || "(nothing)";
    console.log(
      `  ${name}  ${l.peak.toFixed(4)}   ${l.median.toFixed(4)}   ${wake}   ${heard}`,
    );
  }

  // --- the verdict ---
  const usable = results.filter((r) => !r.error && r.levels);
  const heardVoice = usable.filter((r) => (r.levels?.peak ?? 0) > SILENCE_FLOOR_RMS);
  const ranked = [...heardVoice].sort((a, b) => {
    const wa = typeof a.score === "object" && a.score ? a.score.wakePeak : 0;
    const wb = typeof b.score === "object" && b.score ? b.score.wakePeak : 0;
    // The wake score decides it, because that is the thing that has to fire.
    // Loudness only breaks ties — a device can be loud and still unintelligible.
    if (wb !== wa) return wb - wa;
    return (b.levels?.peak ?? 0) - (a.levels?.peak ?? 0);
  });

  console.log("");
  for (const r of usable) {
    if ((r.levels?.peak ?? 0) <= SILENCE_FLOOR_RMS) {
      console.log(
        `  [${r.index}] ${r.device}: peak ${r.levels?.peak.toFixed(4)} is at or below the ` +
          `${SILENCE_FLOOR_RMS} silence floor — this device heard nothing.`,
      );
    }
  }

  const winner = ranked[0];
  if (!winner) {
    console.log(
      "\nNo device produced anything above the silence floor.\n" +
        "That is not a Jarvis problem yet: check that you spoke during the recording, that\n" +
        "the right microphone is plugged in, and that Settings → Privacy → Microphone allows\n" +
        "desktop apps. Then run this again.",
    );
  } else {
    const s = winner.score;
    console.log(`\nBest: [${winner.index}] ${winner.device}`);
    console.log(`  peak RMS ${winner.levels?.peak.toFixed(4)} (floor ${SILENCE_FLOOR_RMS})`);
    if (typeof s === "object" && s) {
      console.log(
        `  wake peak ${s.wakePeak.toFixed(4)} ` +
          `(threshold 0.5 — ${s.wakePeak > 0.5 ? "would fire" : "would NOT fire"})`,
      );
      console.log(`  transcript "${s.transcript ?? ""}"`);
    }
    if (live && live.device && live.device !== winner.device) {
      console.log(
        `\n  The live runtime is on "${live.device}", which is not this one. ` +
          "That is the defect this probe exists to find.",
      );
    }
    if (pin) {
      pinDevice(winner.device);
    } else {
      console.log(`\nTo make Jarvis use it, add this to ${configFilePath()}:`);
      console.log(`  ${JSON.stringify({ microphone: winner.device }, null, 2)}`);
      console.log("or re-run:  npm run probe:mic -- --pin");
    }
  }

  if (!keep) {
    rmSync(OUT_DIR, { recursive: true, force: true });
  } else {
    console.log(`\nrecordings kept in ${OUT_DIR}`);
  }
}

await main();
