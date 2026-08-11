/**
 * Voice latency proof, against the real daemon and the real runtime.
 *
 * The Phase 3 gate asks for a measured wake→ack number, not an estimate. That
 * number is only meaningful if its zero point is defensible, so this defines it
 * as: **the instant the user stopped saying "Jarvis"** — the last audio frame of
 * the wake word reaching the models — **to the instant the UI is told to light
 * the orb**. Everything in between is Jarvis being slow: model lookahead,
 * inference, line framing, the state machine, and the IPC broadcast.
 *
 * Two runs, because they answer different questions:
 *
 *   default   A 16 kHz WAV replayed through the real pipeline at real-time
 *             pace. Identical every run and on every machine, so it is the
 *             number that goes in PERFORMANCE.md and the one a regression
 *             would show up in. It excludes the audio driver and its buffer.
 *   --live    The real microphone, with a human saying "Jarvis". This is the
 *             whole path including the driver, but it cannot be replayed and
 *             the zero point is a person's judgement, so it is reported as
 *             corroboration rather than as the headline.
 *
 * Run: npx tsx scripts/probe-voice.ts [--live] [--runs N]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import type { ServerEvent } from "../src/ipc/contract.js";
import type { VoiceEvent } from "../src/voice/voice-protocol.js";

const WAV = ".research/audio/hey_jarvis.wav";
const PYTHON = ".venv/Scripts/python.exe";
const DAEMON = "voice/daemon.py";
/** The budget from the master prompt: wake→ack in 100–300 ms. */
const BUDGET_MS = 300;

const live = process.argv.includes("--live");
const debug = process.argv.includes("--debug");
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || (live ? 3 : 5);

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AudioProbe {
  durationMs: number;
  speechEndMs: number;
  wakeMs: number | null;
  wakePeak: number;
  detectionLagMs: number | null;
  inferenceMs: { median: number; p95: number; max: number };
  sttMs: number | null;
  transcript: string | null;
  ttsFirstAudioMs: number | null;
}

/**
 * Measure the models alone, in audio time.
 *
 * Wall-clock cannot separate "the model needs more of the word" from "the
 * machine was busy". Positions in a file can: they are the same on every run.
 */
async function probeAudio(): Promise<AudioProbe> {
  const child = spawn(PYTHON, [DAEMON, "--probe-audio", WAV], {
    shell: false,
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
  });
  let last = "";
  for await (const line of createInterface({ input: child.stdout })) {
    const t = line.trim();
    if (t.startsWith("{") && !t.includes('"type"')) last = t;
  }
  if (!last) throw new Error("audio probe produced no result");
  return JSON.parse(last) as AudioProbe;
}

interface Sample {
  /** feed_mark (or wake, when live) → the UI being told. */
  ackMs: number;
  /** wake event on stdout → the UI being told. Runtime overhead alone. */
  runtimeMs: number;
  score: number;
}

/**
 * Drive the real runtime and time the acknowledgement.
 *
 * The runtime is the real one, wired to the real supervised sidecar running the
 * real daemon. Nothing here is stubbed; the only substitution is where the
 * audio comes from, and `--live` removes even that.
 */
async function measure(zeroAtMark: boolean, wakeEndMs: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  let markAt = 0;
  let wakeAt = 0;

  const runtime = new JarvisRuntime({
    pipeName:
      process.platform === "win32"
        ? `\\\\.\\pipe\\jarvis-probe-${process.pid}`
        : `/tmp/jarvis-probe-${process.pid}.sock`,
    lazyHermes: true,
    voice: {
      ...(zeroAtMark
        ? {
            device: `file:${WAV}`,
            // Replay it `runs` times with a wide gap, so each detection starts
            // from a model that has settled rather than from the tail of the
            // previous one.
            extraArgs: [
              "--feed-repeat", String(runs),
              "--feed-gap-ms", "2500",
              "--feed-mark-ms", String(wakeEndMs),
              // The fixture is the wake word with no command after it, so every
              // replay ends in the "woke but nobody spoke" path. Left at its
              // 6 s default the next replay would land inside that window and
              // be transcribed as the command instead of waking again.
              "--wake-timeout-ms", "1200",
              // The wake acknowledgement would speak into every replay and be
              // recorded back through the microphone. This probe times
              // detection, not conversation, so it runs silent.
              "--ack-text", "",
            ],
          }
        : {}),
    },
  });

  if (debug) {
    runtime.voice.on("log", (l: string) => console.log(`   [daemon] ${l}`));
    runtime.on("broadcast", (e: ServerEvent) => {
      if (e.type !== "level") console.log(`   [broadcast] ${JSON.stringify(e)}`);
    });
  }

  // Prepended, not appended: the runtime wired its own handler in its
  // constructor, and it broadcasts synchronously. An appended listener would
  // see the acknowledgement before the wake that caused it.
  runtime.voice.prependListener("voice-event", (e: VoiceEvent) => {
    if (debug && e.type !== "level") console.log(`   [voice] ${JSON.stringify(e)}`);
    if (e.type === "feed_mark") markAt = performance.now();
    if (e.type === "wake") {
      wakeAt = performance.now();
      // Live: the human is the zero point and we cannot see it, so the honest
      // report is runtime overhead plus the measured detection lag.
      if (!zeroAtMark) markAt = wakeAt;
      samples.push({ ackMs: 0, runtimeMs: 0, score: e.score });
    }
  });

  runtime.on("broadcast", (e: ServerEvent) => {
    if (e.type !== "state" || e.state !== "wake_detected") return;
    const s = samples[samples.length - 1];
    if (!s || s.ackMs) return;
    const now = performance.now();
    s.ackMs = now - markAt;
    s.runtimeMs = now - wakeAt;
    console.log(
      `   wake ${samples.length}/${runs}: ack ${s.ackMs.toFixed(1)} ms ` +
        `(runtime ${s.runtimeMs.toFixed(1)} ms, score ${s.score.toFixed(3)})`,
    );
  });

  const ready = new Promise<void>((resolve, reject) => {
    runtime.voice.once("state", function again(this: void): void {
      if (runtime.voice.isReady()) resolve();
      else if (runtime.voice.getStatus().state === "failed") {
        reject(new Error(runtime.voice.getStatus().lastError ?? "voice failed"));
      } else runtime.voice.once("state", again);
    });
    runtime.voice.once("unavailable", (r: string) => reject(new Error(r)));
  });

  await runtime.start();
  console.log("   loading models (whisper is the slow one, ~10 s)…");
  await ready;
  console.log(`   ready: ${runtime.voice.getStatus().device}`);

  if (!zeroAtMark) {
    console.log(`\n   Say "Jarvis" ${runs} times, pausing between. Ctrl-C to stop.\n`);
  }

  const deadline = Date.now() + (zeroAtMark ? runs * 6_000 + 20_000 : 120_000);
  while (samples.filter((s) => s.ackMs > 0).length < runs && Date.now() < deadline) {
    await wait(100);
  }
  await runtime.stop();
  return samples.filter((s) => s.ackMs > 0);
}

function stats(xs: number[]): { min: number; median: number; max: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b);
  return {
    min: s[0] ?? NaN,
    median: s[Math.floor(s.length / 2)] ?? NaN,
    max: s[s.length - 1] ?? NaN,
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

async function main(): Promise<void> {
  console.log("\nJarvis voice latency probe");
  console.log(`  mode      ${live ? "live microphone" : `replayed ${WAV}`}`);
  console.log(`  runs      ${runs}\n`);

  for (const p of [PYTHON, DAEMON, WAV]) {
    if (!existsSync(p)) {
      console.error(`missing ${p}. See docs/VOICE_ANALYSIS.md for setup.`);
      process.exit(1);
    }
  }

  console.log("[1] models, in audio time");
  const audio = await probeAudio();
  check("wake word detected", audio.wakeMs !== null, `peak ${audio.wakePeak}`);
  check(
    "detection lag within one frame of speech ending",
    (audio.detectionLagMs ?? 999) <= 160,
    `${audio.detectionLagMs} ms after speech ends (${audio.speechEndMs} ms)`,
  );
  check(
    "wake inference keeps up with real time",
    audio.inferenceMs.p95 < 80,
    `p95 ${audio.inferenceMs.p95} ms per 80 ms frame`,
  );
  console.log(`   transcript ${JSON.stringify(audio.transcript)} in ${audio.sttMs} ms`);
  console.log(`   first TTS audio ${audio.ttsFirstAudioMs} ms`);

  if (audio.wakeMs === null) {
    console.error("\nthe wake word never fired; nothing downstream is worth timing");
    process.exit(1);
  }

  console.log("\n[2] end to end, through the real runtime");
  const samples = await measure(!live, audio.speechEndMs);
  check(`${runs} acknowledgements observed`, samples.length === runs, `got ${samples.length}`);
  if (samples.length === 0) {
    console.error("\nno wake was acknowledged; cannot report a latency");
    process.exit(1);
  }

  const ack = stats(samples.map((s) => s.ackMs));
  const rt = stats(samples.map((s) => s.runtimeMs));

  console.log("\n[3] wake→ack");
  const label = live ? "wake event→ack" : "speech end→ack";
  console.log(`   ${label}   median ${ack.median.toFixed(1)} ms   ` +
    `min ${ack.min.toFixed(1)}   max ${ack.max.toFixed(1)}   mean ${ack.mean.toFixed(1)}`);
  console.log(`   runtime only     median ${rt.median.toFixed(1)} ms   max ${rt.max.toFixed(1)}`);
  if (live) {
    console.log(
      `   plus measured detection lag ${audio.detectionLagMs} ms ` +
        `≈ ${(ack.median + (audio.detectionLagMs ?? 0)).toFixed(1)} ms from speech end`,
    );
  }

  check(`wake→ack within the ${BUDGET_MS} ms budget`, ack.median <= BUDGET_MS,
    `median ${ack.median.toFixed(1)} ms`);

  console.log(
    failures === 0
      ? `\nAll checks passed. Publish ${ack.median.toFixed(0)} ms to docs/PERFORMANCE.md.\n`
      : `\n${failures} check(s) failed. The real number still goes in PERFORMANCE.md.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`\nprobe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
