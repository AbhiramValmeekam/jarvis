/**
 * The wake acknowledgement, against the real daemon (§63: "Jarvis." → "Yes?").
 *
 * This is the half of the wake path that unit tests cannot reach. `runtime-voice`
 * proves the runtime ignores the ack's playback events; what it cannot prove is
 * that the daemon says it at the right moment, or — the failure that actually
 * matters — that Jarvis does not then hear itself.
 *
 * There is no echo cancellation, so the microphone picks up the speakers. An ack
 * spoken into an open recording is transcribed as the user's command, and the
 * user gets an answer to a question they never asked. The daemon guards this by
 * dropping audio while the ack is audible; the assertions below are what make
 * that guard real rather than intended.
 *
 * Two fixtures, because the ack has to know the difference:
 *
 *   hey_jarvis.wav  the wake word alone      → acknowledge
 *   jarvis_cmd.wav  wake word plus a command → stay quiet and let them finish
 *
 * Audio is replayed from those files, so no microphone opens — but the daemon,
 * the wake model, the VAD and Piper are all the real ones, and the ack is
 * genuinely synthesised. Run with the speakers on and you will hear it.
 *
 *   npx tsx scripts/probe-ack.ts [--live]
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { WAKE_ACK_ID, type VoiceEvent } from "../src/voice/voice-protocol.js";
import type { ServerEvent } from "../src/ipc/contract.js";

const live = process.argv.includes("--live");
const debug = process.argv.includes("--debug");
const BARE = resolve(".research/audio/hey_jarvis.wav");
const WITH_COMMAND = resolve(".research/audio/jarvis_cmd.wav");
const PYTHON = resolve(".venv/Scripts/python.exe");
const DAEMON = resolve("voice/daemon.py");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Seen {
  type: string;
  at: number;
  id?: string | null;
  text?: string;
  reason?: string;
}

interface Run {
  seen: Seen[];
  states: string[];
}

/** Distinct pipe name per run; two runtimes must not collide. */
let seq = 0;

/** Replay one fixture through the real pipeline and collect what happened. */
async function run(wav: string | null, waitMs: number): Promise<Run> {
  const seen: Seen[] = [];
  const states: string[] = [];
  let wakeAt = 0;

  const runtime = new JarvisRuntime({
    pipeName:
      process.platform === "win32"
        ? `\\\\.\\pipe\\jarvis-ack-${process.pid}-${seq++}`
        : `/tmp/jarvis-ack-${process.pid}-${seq++}.sock`,
    lazyHermes: true,
    voice:
      wav === null
        ? {}
        : {
            device: `file:${wav}`,
            // One replay, then silence. The gap must outlast the 6 s wake
            // timeout, or the feed ends before the "woke, nobody spoke" path
            // is ever reached.
            extraArgs: ["--feed-repeat", "1", "--feed-gap-ms", "11000"],
          },
  });

  if (debug) runtime.voice.on("log", (l: string) => console.log(`   [daemon] ${l}`));

  runtime.voice.prependListener("voice-event", (e: VoiceEvent) => {
    if (e.type === "level" || e.type === "feed_mark") return;
    if (debug) console.log(`   [voice] ${JSON.stringify(e)}`);
    if (e.type === "wake") wakeAt = performance.now();
    const at = wakeAt ? performance.now() - wakeAt : 0;
    if (e.type === "speaking_start" || e.type === "speaking_done") {
      seen.push({ type: e.type, at, id: e.id });
    } else if (e.type === "speaking_stopped") {
      seen.push({ type: e.type, at, id: e.id, reason: e.reason });
    } else if (e.type === "final") {
      seen.push({ type: e.type, at, text: e.text });
    } else {
      seen.push({ type: e.type, at });
    }
  });

  runtime.on("broadcast", (e: ServerEvent) => {
    if (e.type === "state") states.push(e.state);
  });

  const ready = new Promise<void>((res, rej) => {
    runtime.voice.once("state", function again(this: void): void {
      if (runtime.voice.isReady()) res();
      else if (runtime.voice.getStatus().state === "failed") {
        rej(new Error(runtime.voice.getStatus().lastError ?? "voice failed"));
      } else runtime.voice.once("state", again);
    });
    runtime.voice.once("unavailable", (r: string) => rej(new Error(r)));
  });

  await runtime.start();
  console.log("   loading models (whisper is the slow one, ~10 s)…");
  await ready;
  console.log(`   ready: ${runtime.voice.getStatus().device}`);
  if (wav === null) console.log('\n   Say "Jarvis" once, then stay quiet.\n');

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    // Both outcomes are terminal: nobody spoke, or something was transcribed.
    if (seen.some((s) => s.type === "wake_timeout" || s.type === "final")) break;
    await wait(100);
  }
  // A transcript arrives a beat before any reply; give the tail a moment so a
  // spurious second utterance would still be caught.
  await wait(1_500);
  await runtime.stop();
  return { seen, states };
}

async function main(): Promise<void> {
  console.log("\nJarvis wake-acknowledgement probe");
  console.log(`  mode      ${live ? "live microphone" : "replayed fixtures"}\n`);

  for (const p of live ? [PYTHON, DAEMON] : [PYTHON, DAEMON, BARE, WITH_COMMAND]) {
    if (!existsSync(p)) {
      console.error(`missing ${p}. See docs/VOICE_ANALYSIS.md for setup.`);
      process.exit(1);
    }
  }

  console.log(`[A] the wake word alone (${live ? "live" : "hey_jarvis.wav"})`);
  const { seen, states } = await run(live ? null : BARE, live ? 60_000 : 45_000);

  const first = (t: string): Seen | undefined => seen.find((s) => s.type === t);
  const ackStart = seen.find((s) => s.type === "speaking_start" && s.id === WAKE_ACK_ID);
  const ackDone = seen.find((s) => s.type === "speaking_done" && s.id === WAKE_ACK_ID);
  const finals = seen.filter((s) => s.type === "final");

  console.log("\n[1] the acknowledgement");
  check("the wake word fired", first("wake") !== undefined);
  check(
    "Jarvis said something",
    ackStart !== undefined,
    ackStart ? `audible ${ackStart.at.toFixed(0)} ms after wake` : "nothing was spoken",
  );
  check(
    "it is tagged as the acknowledgement, not a reply",
    ackStart?.id === WAKE_ACK_ID,
    `id ${JSON.stringify(ackStart?.id ?? null)}`,
  );
  check(
    "it arrives while the user is still waiting, not after the timeout",
    (ackStart?.at ?? Infinity) < 3_000,
    `${(ackStart?.at ?? 0).toFixed(0)} ms`,
  );
  check("it finished playing", ackDone !== undefined);

  console.log("\n[2] Jarvis does not hear itself");
  // The defect this guards: the ack recorded through the speakers, transcribed,
  // and answered as though the user had spoken it.
  const spokeItself = finals.filter((f) => (f.text ?? "").trim().length > 0);
  check(
    "nothing was transcribed from the acknowledgement",
    spokeItself.length === 0,
    spokeItself.length ? `heard ${JSON.stringify(spokeItself.map((f) => f.text))}` : "silence",
  );
  check(
    "the turn ended in the wake timeout, not in a phantom command",
    first("wake_timeout") !== undefined,
    first("wake_timeout") ? `${first("wake_timeout")!.at.toFixed(0)} ms after wake` : "never",
  );
  check(
    "the acknowledgement did not spend the whole wake timeout",
    (first("wake_timeout")?.at ?? 0) > (ackDone?.at ?? 0),
    `timeout ${(first("wake_timeout")?.at ?? 0).toFixed(0)} ms, ack ended ` +
      `${(ackDone?.at ?? 0).toFixed(0)} ms`,
  );

  console.log("\n[3] the state machine was left alone");
  check(
    "the ack did not drive the machine into SPEAKING",
    !states.includes("speaking"),
    states.join(" → ") || "(no transitions)",
  );
  check(
    "no follow-up conversation window was opened",
    !states.includes("conversation"),
    states.join(" → ") || "(no transitions)",
  );

  // The other half, and the one that would annoy a user fastest: saying
  // "Jarvis, what time is it" in one breath must not be interrupted by "Yes?".
  if (!live) {
    console.log("\n[B] wake word with a command behind it (jarvis_cmd.wav)");
    const cmd = await run(WITH_COMMAND, 30_000);
    const cmdAck = cmd.seen.find(
      (s) => s.type === "speaking_start" && s.id === WAKE_ACK_ID,
    );
    const heard = cmd.seen
      .filter((s) => s.type === "final")
      .map((s) => (s.text ?? "").trim())
      .filter(Boolean);

    console.log("\n[4] a command in the same breath is not talked over");
    check("the wake word fired", cmd.seen.some((s) => s.type === "wake"));
    check(
      "Jarvis stayed quiet and let them finish",
      cmdAck === undefined,
      cmdAck ? `said "Yes?" ${cmdAck.at.toFixed(0)} ms in` : "no acknowledgement",
    );
    check(
      "the command was transcribed",
      heard.length > 0,
      heard.length ? JSON.stringify(heard[0]) : "nothing was heard",
    );
  }

  console.log(
    failures === 0
      ? "\nthe acknowledgement works and Jarvis does not answer itself\n"
      : `\n${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
