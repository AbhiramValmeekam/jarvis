/**
 * Tests for the voice daemon supervisor.
 *
 * What is being proven here is the *supervision* contract, not the audio: that
 * a crash is noticed and bounded, that a clean stop asks before it kills, that
 * `capturing` never claims a microphone is open when it is not, and that a
 * missing Python environment produces an instruction rather than a stack trace.
 *
 * The daemon itself is faked. Real audio is proven by scripts/probe-voice.ts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { VoiceSidecar } from "../src/voice/voice-sidecar.js";
import type { VoiceEvent } from "../src/voice/voice-protocol.js";
import { FakeChild, crashAndSettle, fakeSpawn, tick, waitUntil } from "./helpers/fake-child.js";

/** Every sidecar built by a test, so none outlives it. */
const live: VoiceSidecar[] = [];

/** A sidecar wired to fakes, with restarts fast enough to test. */
function makeSidecar(over: Record<string, unknown> = {}) {
  const s = new VoiceSidecar({
    cwd: process.cwd(),
    // Both must exist as far as `unavailableReason` is concerned; pointing at
    // real files in the repo keeps the existsSync checks honest.
    pythonPath: "python.exe",
    daemonPath: "package.json",
    spawnProcess: fakeSpawn,
    restart: { baseDelayMs: 1, jitter: 0, maxRestarts: 2, windowMs: 60_000 },
    ...over,
  });
  live.push(s);
  return s;
}

async function started(over: Record<string, unknown> = {}) {
  const s = makeSidecar(over);
  await s.start();
  return s;
}

async function ready(over: Record<string, unknown> = {}) {
  const s = await started(over);
  FakeChild.latest.emitReady();
  await tick();
  return s;
}

beforeEach(() => {
  FakeChild.reset();
});

/**
 * Stop every sidecar the test made.
 *
 * A sidecar left in `restarting` still holds a pending timer, and that timer
 * spawns a child into the *next* test's shared instance list — which is how a
 * test that passes alone fails in a suite. Supervisors outliving their owner is
 * exactly the bug this class exists to prevent, so the tests must not leak them
 * either.
 */
afterEach(async () => {
  for (const s of live) {
    const stopping = s.stop();
    for (const c of FakeChild.instances) c.die(0);
    await stopping;
  }
  live.length = 0;
  FakeChild.reset();
});

describe("startup", () => {
  it("starts stopped and not capturing", () => {
    const s = makeSidecar();
    expect(s.getStatus()).toMatchObject({ state: "stopped", pid: null, capturing: false });
    expect(s.isReady()).toBe(false);
  });

  it("passes the daemon script and engine choices as separate argv entries", async () => {
    await started({ sttModel: "small.en", wakeWord: "hey_jarvis", device: "My Mic" });
    const c = FakeChild.latest;
    expect(c.args[0]).toBe("package.json");
    expect(c.args).toContain("--stt-model");
    expect(c.args[c.args.indexOf("--stt-model") + 1]).toBe("small.en");
    // A device name is user data. It must arrive as one argv element, never
    // as text a shell could re-split.
    expect(c.args[c.args.indexOf("--device") + 1]).toBe("My Mic");
  });

  it("is not ready until the daemon says its models loaded", async () => {
    const s = await started();
    expect(s.getStatus().state).toBe("starting");
    expect(s.isReady()).toBe(false);

    FakeChild.latest.emitReady();
    await tick();

    expect(s.isReady()).toBe(true);
    expect(s.getStatus()).toMatchObject({
      state: "ready",
      wakeWord: "hey_jarvis",
      sttModel: "base.en",
      ttsVoice: "en_US-amy",
      device: "Test Mic",
      capturing: true,
    });
  });

  it("reports the engines that failed rather than the ones it wanted", async () => {
    const s = await started();
    FakeChild.latest.emitReady({ ttsVoice: null, capture: true });
    await tick();
    expect(s.getStatus().ttsVoice).toBeNull();
  });

  it("does not spawn twice", async () => {
    const s = await ready();
    await s.start();
    expect(FakeChild.instances.length).toBe(1);
  });
});

describe("unavailability", () => {
  it("explains how to create the Python environment instead of failing silently", async () => {
    const s = new VoiceSidecar({
      cwd: "E:/nowhere-at-all",
      daemonPath: "package.json",
      spawnProcess: fakeSpawn,
    });
    const reason = s.unavailableReason();
    expect(reason).toContain("uv venv");
    expect(reason).toContain("openwakeword");

    const seen: string[] = [];
    s.on("unavailable", (r: string) => seen.push(r));
    await s.start();

    expect(FakeChild.instances.length).toBe(0);
    expect(seen).toEqual([reason]);
    expect(s.getStatus()).toMatchObject({ state: "failed", capturing: false });
  });

  it("names the missing daemon script by path", async () => {
    const s = makeSidecar({ daemonPath: "E:/nowhere/daemon.py" });
    expect(s.unavailableReason()).toContain("E:/nowhere/daemon.py");
    await s.start();
    expect(FakeChild.instances.length).toBe(0);
  });

  it("is available when both the script and an interpreter exist", () => {
    expect(makeSidecar().unavailableReason()).toBeNull();
  });
});

describe("events", () => {
  it("re-emits parsed daemon events", async () => {
    const s = await ready();
    const events: VoiceEvent[] = [];
    s.on("voice-event", (e: VoiceEvent) => events.push(e));

    FakeChild.latest.emitEvent({ type: "wake", score: 0.97 });
    FakeChild.latest.emitEvent({ type: "final", text: "what time is it", ms: 410 });
    await tick();

    expect(events).toEqual([
      { type: "wake", score: 0.97 },
      { type: "final", text: "what time is it", ms: 410 },
    ]);
  });

  it("reassembles an event split across chunk boundaries", async () => {
    const s = await ready();
    const events: VoiceEvent[] = [];
    s.on("voice-event", (e: VoiceEvent) => events.push(e));

    FakeChild.latest.writeRaw(`{"type":"wake","sc`);
    await tick();
    expect(events).toEqual([]);
    FakeChild.latest.writeRaw(`ore":0.5}\n`);
    await tick();
    expect(events).toEqual([{ type: "wake", score: 0.5 }]);
  });

  it("drops garbage without emitting a half-built event", async () => {
    const s = await ready();
    const events: VoiceEvent[] = [];
    const logs: string[] = [];
    s.on("voice-event", (e: VoiceEvent) => events.push(e));
    s.on("log", (l: string) => logs.push(l));

    FakeChild.latest.writeRaw("Traceback (most recent call last):\n");
    await tick();

    expect(events).toEqual([]);
    expect(logs.some((l) => l.includes("unparseable"))).toBe(true);
  });

  it("keeps daemon logs out of the runtime's event stream", async () => {
    const s = await ready();
    const events: VoiceEvent[] = [];
    const logs: string[] = [];
    s.on("voice-event", (e: VoiceEvent) => events.push(e));
    s.on("log", (l: string) => logs.push(l));

    FakeChild.latest.emitEvent({ type: "log", line: "whisper loaded in 12s" });
    FakeChild.latest.stderr.write("piper: using onnxruntime\n");
    await tick();

    expect(events).toEqual([]);
    expect(logs).toContain("whisper loaded in 12s");
    expect(logs).toContain("piper: using onnxruntime");
  });

  it("tracks capture state from the daemon, not from the request", async () => {
    const s = await ready();
    expect(s.getStatus().capturing).toBe(true);

    // The runtime asked to mute; only the daemon can confirm the microphone
    // actually closed.
    FakeChild.latest.emitEvent({ type: "muted", muted: true, capturing: false });
    await tick();
    expect(s.getStatus().capturing).toBe(false);
  });

  it("records the reason a subsystem became unavailable", async () => {
    const s = await ready();
    FakeChild.latest.emitEvent({
      type: "unavailable",
      subsystem: "tts",
      reason: "no piper voice found",
    });
    await tick();
    expect(s.getStatus().lastError).toBe("tts: no piper voice found");
  });
});

describe("commands", () => {
  it("refuses to send before the daemon is ready", async () => {
    const s = await started();
    expect(s.speak("hello")).toBe(false);
    expect(FakeChild.latest.written).toEqual([]);
  });

  it("sends each command as one line", async () => {
    const s = await ready();
    expect(s.speak("hello", "turn-1")).toBe(true);
    expect(s.stopSpeaking("barge-in")).toBe(true);
    expect(s.setMuted(true)).toBe(true);
    expect(s.setListening(false)).toBe(true);
    expect(s.setConversation(true)).toBe(true);
    expect(s.pushToTalk(true)).toBe(true);

    expect(FakeChild.latest.commands).toEqual([
      { type: "speak", text: "hello", id: "turn-1" },
      { type: "stop_speaking", reason: "barge-in" },
      { type: "set_muted", muted: true },
      { type: "set_listening", enabled: false },
      { type: "set_conversation", open: true },
      { type: "ptt", down: true },
    ]);
  });

  it("omits the id when the caller has no turn to correlate", async () => {
    const s = await ready();
    s.speak("hello");
    expect(FakeChild.latest.commands[0]).toEqual({ type: "speak", text: "hello" });
  });

  it("returns false on a broken pipe instead of throwing at the caller", async () => {
    const s = await ready();
    FakeChild.latest.stdinBroken = true;
    expect(s.speak("hello")).toBe(false);
  });
});

describe("crash handling", () => {
  it("restarts within bounds and reports the attempt", async () => {
    const s = await ready();
    const crashes: string[] = [];
    s.on("crash", (how: string) => crashes.push(how));

    await crashAndSettle(() => s.getStatus().state === "failed");

    expect(crashes).toEqual(["code 1"]);
    expect(FakeChild.instances.length).toBe(2);
    expect(s.getStatus().restartCount).toBe(1);
  });

  it("stops claiming to capture the moment the daemon dies", async () => {
    const s = await ready();
    expect(s.getStatus().capturing).toBe(true);
    FakeChild.latest.die(1);
    expect(s.getStatus().capturing).toBe(false);
  });

  it("gives up rather than looping forever, and says why", async () => {
    const s = await ready();
    const gaveUp: string[] = [];
    const unavailable: string[] = [];
    s.on("gave-up", (r: string) => gaveUp.push(r));
    s.on("unavailable", (r: string) => unavailable.push(r));

    const failed = () => s.getStatus().state === "failed";
    while (!failed()) await crashAndSettle(failed);

    expect(gaveUp.length).toBe(1);
    expect(gaveUp[0]).toContain("gave up after 2 restarts");
    expect(unavailable[0]).toContain("voice stopped working");
    // Three children: the original plus the two permitted restarts.
    expect(FakeChild.instances.length).toBe(3);

    // And it stays dead: a dead daemon must not be revived by a stray event.
    FakeChild.latest.die(1);
    await tick(20);
    expect(FakeChild.instances.length).toBe(3);
  });

  it("forgives the crash history once the daemon comes back healthy", async () => {
    const s = await ready();
    const failed = () => s.getStatus().state === "failed";

    await crashAndSettle(failed);
    FakeChild.latest.emitReady();
    await waitUntil(() => s.isReady());
    // `ready` resets the policy, so the next crash starts counting from one.
    expect(s.getStatus().restartCount).toBe(1);

    await crashAndSettle(failed);
    expect(s.getStatus().restartCount).toBe(1);
    expect(s.getStatus().state).not.toBe("failed");
  });

  it("treats a daemon that never loads as a crash instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const s = makeSidecar();
      await s.start();
      expect(s.getStatus().state).toBe("starting");

      await vi.advanceTimersByTimeAsync(90_001);

      expect(FakeChild.instances[0]!.killed).toBe(true);
      expect(s.getStatus().lastError).toContain("did not become ready");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("lifecycle", () => {
  it("asks the daemon to shut down before killing it", async () => {
    const s = await ready();
    const child = FakeChild.latest;
    const stopping = s.stop();
    expect(child.commands.at(-1)).toEqual({ type: "shutdown" });
    child.die(0);
    await stopping;

    expect(s.getStatus()).toMatchObject({ state: "stopped", pid: null });
    expect(FakeChild.instances.length).toBe(1); // a deliberate stop is not a crash
  });

  it("kills a daemon that ignores the shutdown request", async () => {
    vi.useFakeTimers();
    try {
      const s = makeSidecar();
      await s.start();
      FakeChild.latest.emitReady();
      await vi.advanceTimersByTimeAsync(0);

      const child = FakeChild.latest;
      const stopping = s.stop();
      await vi.advanceTimersByTimeAsync(3_001);
      await stopping;

      expect(child.killed).toBe(true);
      expect(s.getStatus().state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the microphone on suspend and does not restart while suspended", async () => {
    const s = await ready();
    const child = FakeChild.latest;
    const suspending = s.suspend();
    child.die(0);
    await suspending;

    expect(s.getStatus()).toMatchObject({ state: "suspended", capturing: false });
    expect(FakeChild.instances.length).toBe(1);
  });

  it("comes back on resume with a clean restart budget", async () => {
    const s = await ready();
    await crashAndSettle(() => s.getStatus().state === "failed");
    expect(s.getStatus().restartCount).toBe(1);

    const child = FakeChild.latest;
    const suspending = s.suspend();
    child.die(0);
    await suspending;

    await s.resume();
    expect(s.getStatus()).toMatchObject({ state: "starting", restartCount: 0 });
  });

  it("recovers from `failed` when the user restarts voice by hand", async () => {
    const s = await ready();
    const failed = () => s.getStatus().state === "failed";
    while (!failed()) await crashAndSettle(failed);

    await s.restart();
    expect(s.getStatus()).toMatchObject({
      state: "starting",
      restartCount: 0,
      gaveUpReason: null,
    });
  });
});

/**
 * The silence watch.
 *
 * `capturing: true` only says ffmpeg is running. It said exactly that on
 * 2026-08-15 while the wake word could not fire, because a reboot had re-ordered
 * the dshow devices and the daemon had opened an input that delivered an unbroken
 * line of zeroes. Every component was healthy and there was no audio in the
 * pipeline — so the sidecar now watches the `level` events it already receives
 * and stops claiming a microphone works when nothing is coming out of it.
 *
 * The clock is injected. Sixty seconds of real time is not a unit test.
 */
describe("the silence watch", () => {
  const SILENT = 0.0005; // below the 0.002 floor: a dead line
  const VOICE = 0.02; // above it: someone in the room
  let clock = 0;
  let logs: string[] = [];
  const now = () => clock;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    logs = [];
  });

  /** Feed `count` level events a second apart, as a capturing daemon does. */
  async function feed(rms: number, count: number, stepMs = 1_000): Promise<void> {
    for (let i = 0; i < count; i++) {
      clock += stepMs;
      FakeChild.latest.emitEvent({ type: "level", rms });
      await tick();
    }
  }

  async function listening() {
    return ready({ now, onLog: (l: string) => logs.push(l) });
  }

  it("reports nothing while the input is quiet but the verdict window is open", async () => {
    const s = await listening();
    await feed(SILENT, 31);

    // The window starts at the first sub-floor event, so 31 events a second
    // apart is 30 s of silence — real, and not yet a verdict.
    expect(s.getStatus().silentForMs).toBe(30_000);
    expect(logs.join(" ")).not.toMatch(/produced nothing/);
  });

  it("calls a dead line a dead line once the window passes, and names the device", async () => {
    const s = await listening();
    const seen: Array<{ device: string | null; ms: number }> = [];
    s.on("silent", (e: { device: string | null; ms: number }) => seen.push(e));

    await feed(SILENT, 62);

    expect(s.getStatus().silentForMs).toBeGreaterThanOrEqual(60_000);
    // Named, because the next question is "is that the right microphone?" and a
    // message that does not say which device was open cannot answer it.
    expect(logs.join(" ")).toMatch(/Test Mic/);
    expect(logs.join(" ")).toMatch(/produced nothing above 0\.002/);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.device).toBe("Test Mic");

    // Said once, not six times a second for as long as the room stays quiet.
    await feed(SILENT, 20);
    expect(logs.filter((l) => l.includes("produced nothing"))).toHaveLength(1);
  });

  it("recovers the moment the microphone produces anything", async () => {
    const s = await listening();
    await feed(SILENT, 62);
    expect(s.getStatus().silentForMs).toBeGreaterThanOrEqual(60_000);

    await feed(VOICE, 1);

    expect(s.getStatus().silentForMs).toBeNull();
    expect(s.getStatus().peakRms).toBe(VOICE);
    expect(logs.join(" ")).toMatch(/producing audio again/);
  });

  it("abandons the window when capture stops instead of counting the gap", async () => {
    const s = await listening();
    await feed(SILENT, 5);
    expect(s.getStatus().silentForMs).toBe(4_000);

    // A mute, a `set_listening(false)`, or Jarvis speaking: capture stops and no
    // level events arrive. None of that is evidence about the microphone, so the
    // gap must not be counted as silence.
    clock += 10_000;
    await feed(SILENT, 1);
    expect(s.getStatus().silentForMs).toBeNull();

    await feed(SILENT, 3);
    expect(s.getStatus().silentForMs).toBe(2_000);
  });

  it("forgets its verdict when the level events stop arriving", async () => {
    const s = await listening();
    await feed(SILENT, 62);
    expect(s.getStatus().silentForMs).toBeGreaterThanOrEqual(60_000);

    // Muted after the verdict. A stale "silent for 61s" would keep the wake word
    // degraded for as long as the user left it muted, which is not a fault.
    clock += 5_000;
    expect(s.getStatus().silentForMs).toBeNull();
  });

  it("starts over when the daemon restarts", async () => {
    const s = await listening();
    await feed(VOICE, 2);
    expect(s.getStatus().peakRms).toBe(VOICE);

    await crashAndSettle(() => FakeChild.instances.length === 2);
    FakeChild.latest.emitReady();
    await tick();

    // A new daemon is a new device handle, and possibly a different device.
    expect(s.getStatus()).toMatchObject({ peakRms: 0, silentForMs: null });
  });
});

describe("capture dying under a live daemon", () => {
  /**
   * The hole the silence watch does not cover.
   *
   * The watch reasons about `level` events that arrive carrying nothing. A
   * device that ffmpeg cannot open produces no level events *at all* — so
   * `silentForMs` stays null and the watch has no opinion, while `capturing`
   * remains true from the `ready` event. Pinning a microphone makes this the
   * likely failure rather than a rare one: the pinned name is right until the
   * headset is unplugged.
   */
  const dead = (reason: string): VoiceEvent => ({
    type: "unavailable",
    subsystem: "capture",
    reason,
  });

  it("stops claiming to be capturing", async () => {
    const s = await ready();
    expect(s.getStatus().capturing).toBe(true);

    FakeChild.latest.emitEvent(
      dead('Headset Microphone (Realtek(R) Audio) stopped delivering audio: Could not find audio only device with name'),
    );
    await tick();

    const st = s.getStatus();
    expect(st.capturing).toBe(false);
    // The reason survives to the status, because "not capturing" without it
    // sends the user looking through logs for what this already knows.
    expect(st.lastError).toMatch(/Could not find audio only device/);
    expect(st.lastError).toMatch(/Headset Microphone/);
    expect(st.captureFailure).toMatch(/Could not find audio only device/);
  });

  it("stops blaming a device once capture comes back", async () => {
    const s = await ready();
    FakeChild.latest.emitEvent(dead("Test Mic delivered no audio at all: I/O error"));
    await tick();
    expect(s.getStatus().captureFailure).not.toBeNull();

    // Unmuting spawns a new ffmpeg on the same name. A stale reason here would
    // report a working microphone as broken for the rest of the session.
    FakeChild.latest.emitEvent({ type: "muted", muted: false, capturing: true });
    await tick();
    expect(s.getStatus()).toMatchObject({ capturing: true, captureFailure: null });
  });

  it("does not treat some other subsystem's failure as a dead microphone", async () => {
    const s = await ready();
    FakeChild.latest.emitEvent({
      type: "unavailable",
      subsystem: "tts",
      reason: "piper voice missing",
    });
    await tick();

    // STT or TTS failing leaves the microphone exactly as it was. Conflating
    // them would report the wake word dead over a working input.
    expect(s.getStatus().capturing).toBe(true);
  });

  it("clears the silence watch so a stale verdict cannot outlive the capture", async () => {
    let clock = 1_700_000_000_000;
    const s = await ready({ now: () => clock });
    for (let i = 0; i < 62; i++) {
      clock += 1_000;
      FakeChild.latest.emitEvent({ type: "level", rms: 0.0005 });
      await tick();
    }
    expect(s.getStatus().silentForMs).toBeGreaterThanOrEqual(60_000);

    FakeChild.latest.emitEvent(dead("Test Mic stopped delivering audio: I/O error"));
    await tick();

    // Two verdicts about one microphone is one too many: `capturing: false`
    // with a reason is the stronger and more specific of the pair.
    expect(s.getStatus().silentForMs).toBeNull();
  });
});
