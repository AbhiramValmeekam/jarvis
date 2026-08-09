import { describe, it, expect } from "vitest";
import {
  execute,
  encodePwsh,
  type AppEntry,
  type ExecutorDeps,
  type RunOptions,
} from "../src/local-intents/executors.js";
import { matchIntent, type IntentMatch } from "../src/local-intents/intent-model.js";
import type { CaptureRequest, CaptureResult } from "../src/context/screen-capture.js";

type Call = { file: string; args: readonly string[]; opts?: RunOptions };

/** Records every process the executors ask for, and answers as Windows would. */
function harness(over: Partial<ExecutorDeps> & { reply?: (c: Call) => string } = {}) {
  const runs: Call[] = [];
  const launches: Call[] = [];
  let micMuted = false;

  const deps: ExecutorDeps = {
    run: async (file, args, opts) => {
      const call: Call = { file, args, ...(opts ? { opts } : {}) };
      runs.push(call);
      return over.reply ? over.reply(call) : "";
    },
    launch: async (file, args) => {
      launches.push({ file, args });
    },
    apps: new Map<string, AppEntry>([
      ["notepad", { name: "Notepad", launch: { kind: "exec", file: "notepad.exe" } }],
      ["spotify", { name: "Spotify", launch: { kind: "uri", uri: "spotify:" } }],
    ]),
    screenshotRoots: ["C:\\Users\\me\\Pictures"],
    now: () => new Date(2026, 7, 9, 14, 5, 30),
    setMicMuted: (m) => {
      micMuted = m;
      return true;
    },
    isMicMuted: () => micMuted,
    ...over,
  };
  return { deps, runs, launches };
}

const match = (text: string): IntentMatch => {
  const r = matchIntent(text, {
    apps: new Map([
      ["notepad", ["notepad"]],
      ["spotify", ["spotify"]],
    ]),
  });
  if (r.kind !== "match") throw new Error(`"${text}" did not match`);
  return r;
};

describe("no shell, ever", () => {
  it("never invokes a shell for any intent", async () => {
    // The structural guarantee this whole file rests on: if nothing spawns
    // cmd or a shell-flagged process, there is no command line to inject into.
    const utterances = [
      "what time is it",
      "what's the date",
      "set the volume to 40",
      "volume up",
      "mute the speakers",
      "mute the microphone",
      "take a screenshot",
      "lock the computer",
      "battery",
      "cpu usage",
      "open notepad",
      "open spotify",
    ];
    for (const u of utterances) {
      const { deps, runs, launches } = harness({ reply: () => "50|false" });
      await execute(match(u), deps);
      for (const c of [...runs, ...launches]) {
        expect(c.file.toLowerCase(), u).not.toMatch(/\bcmd\.exe$|\bcmd$/);
        expect(c.args.join(" "), u).not.toMatch(/&&|\|\||;/);
      }
    }
  });

  it("passes a PowerShell script as one opaque base64 argument", () => {
    const args = encodePwsh("Write-Output 'hi'");
    expect(args).toContain("-EncodedCommand");
    expect(args).toContain("-NoProfile");
    // The decoded script is what we wrote, and it never appeared on a command line.
    const encoded = args[args.length - 1]!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Write-Output 'hi'");
  });

  it("does not weaken execution policy", () => {
    // Bypass would be a Windows security setting relaxed for no gain, since
    // policy does not apply to -EncodedCommand at all.
    expect(encodePwsh("x").join(" ")).not.toMatch(/ExecutionPolicy/i);
  });
});

describe("clock and calendar", () => {
  it("speaks the time the way a person says it", async () => {
    const { deps } = harness();
    expect((await execute(match("what time is it"), deps)).speech).toBe("It's 2:05 PM.");
  });

  it("says o'clock on the hour", async () => {
    const { deps } = harness({ now: () => new Date(2026, 7, 9, 9, 0, 0) });
    expect((await execute(match("time"), deps)).speech).toBe("It's 9 o'clock AM.");
  });

  it("handles midnight and noon without saying zero", async () => {
    const midnight = harness({ now: () => new Date(2026, 7, 9, 0, 30, 0) });
    expect((await execute(match("time"), midnight.deps)).speech).toBe("It's 12:30 AM.");
    const noon = harness({ now: () => new Date(2026, 7, 9, 12, 0, 0) });
    expect((await execute(match("time"), noon.deps)).speech).toBe("It's 12 o'clock PM.");
  });

  it("gives the date in full", async () => {
    const { deps } = harness();
    expect((await execute(match("what's the date"), deps)).speech).toBe(
      "It's Sunday, August 9, 2026.",
    );
  });

  it("answers the clock without spawning anything at all", async () => {
    // Latency is the entire point of a local intent.
    const { deps, runs } = harness();
    await execute(match("what time is it"), deps);
    expect(runs).toHaveLength(0);
  });
});

describe("volume", () => {
  it("reports the level read back from the device, not the one requested", async () => {
    // A device that quantises must not be reported as having done exactly what
    // was asked. Saying what happened is the difference from pretending.
    const { deps } = harness({ reply: () => "38|false" });
    const out = await execute(match("set the volume to 40"), deps);
    expect(out.ok).toBe(true);
    expect(out.speech).toBe("Volume 38%.");
  });

  it("applies a relative step to the level that is actually set", async () => {
    let call = 0;
    const { deps, runs } = harness({
      reply: () => (call++ === 0 ? "30|false" : "40|false"),
    });
    const out = await execute(match("volume up by 10"), deps);
    expect(out.speech).toBe("Volume 40%.");
    // The computed target reaches PowerShell through the environment. Not argv:
    // positional arguments after -EncodedCommand are rejected outright, which
    // is a failure only a real shell can show you.
    expect(runs[1]?.opts?.env?.["JARVIS_AUDIO_LEVEL"]).toBe("40");
    expect(runs[1]?.opts?.env?.["JARVIS_AUDIO_OP"]).toBe("set");
  });

  it("clamps a step at the ends instead of going out of range", async () => {
    const { deps, runs } = harness({ reply: () => "95|false" });
    await execute(match("volume up by 20"), deps);
    expect(runs[1]?.opts?.env?.["JARVIS_AUDIO_LEVEL"]).toBe("100");
  });

  it("keeps the level out of the script text and out of argv", async () => {
    // Same rule as the screenshot path: the script is a constant, and the only
    // variable data travels as an environment value that is read, never parsed.
    // Asserted by comparing two different levels rather than by searching for
    // "40" — a two-digit string collides with the COM GUIDs by chance.
    const a = harness({ reply: () => "50|false" });
    await execute(match("set the volume to 40"), a.deps);
    const b = harness({ reply: () => "50|false" });
    await execute(match("set the volume to 70"), b.deps);

    expect(a.runs[0]?.args).toEqual(b.runs[0]?.args);
    expect(a.runs[0]?.args).not.toContain("40");
    expect(a.runs[0]?.opts?.env?.["JARVIS_AUDIO_LEVEL"]).toBe("40");
    expect(b.runs[0]?.opts?.env?.["JARVIS_AUDIO_LEVEL"]).toBe("70");
  });

  it("refuses a level it cannot trust", async () => {
    const { deps, runs } = harness({ reply: () => "50|false" });
    const out = await execute(
      { kind: "match", id: "volume.set", confidence: 1, slots: { level: 900 } },
      deps,
    );
    expect(out.ok).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it("says it failed when the device did not change", async () => {
    // Reporting a mute that did not take is exactly the dishonesty forbidden.
    const { deps } = harness({ reply: () => "50|false" });
    const out = await execute(match("mute the speakers"), deps);
    expect(out.ok).toBe(false);
    expect(out.speech).toMatch(/didn't change/);
  });

  it("confirms a mute that did take", async () => {
    const { deps } = harness({ reply: () => "50|true" });
    const out = await execute(match("mute the speakers"), deps);
    expect(out.ok).toBe(true);
    expect(out.speech).toBe("Speakers muted.");
  });

  it("reports unreadable output as failure rather than guessing", async () => {
    const { deps } = harness({ reply: () => "Access denied." });
    const out = await execute(match("set the volume to 40"), deps);
    expect(out.ok).toBe(false);
    expect(out.speech).toMatch(/couldn't/);
  });
});

describe("microphone", () => {
  it("mutes and confirms, in the runtime rather than the OS", async () => {
    // Muting the OS device would silence every other app too.
    const { deps, runs } = harness();
    const out = await execute(match("mute the microphone"), deps);
    expect(out.ok).toBe(true);
    expect(out.speech).toMatch(/not listening/);
    expect(runs).toHaveLength(0);
    expect(deps.isMicMuted()).toBe(true);
  });

  it("refuses to claim the mic is off when the daemon did not accept it", async () => {
    // The one place where a false success is a privacy failure.
    const { deps } = harness({ setMicMuted: () => false, isMicMuted: () => false });
    const out = await execute(match("mute the microphone"), deps);
    expect(out.ok).toBe(false);
    expect(out.speech).toMatch(/couldn't/);
  });

  it("refuses when the state does not stick, even if the call returned true", async () => {
    const { deps } = harness({ setMicMuted: () => true, isMicMuted: () => false });
    expect((await execute(match("mute the microphone"), deps)).ok).toBe(false);
  });
});

describe("screenshot", () => {
  it("builds the filename from the clock, never from the utterance", async () => {
    const { deps, runs } = harness({ reply: () => "" });
    const out = await execute(match("take a screenshot"), deps);
    expect(out.ok).toBe(true);
    expect(out.detail).toBe("C:\\Users\\me\\Pictures\\jarvis-2026-08-09_140530.png");
  });

  it("hands the path through the environment, not the script text", async () => {
    // So there is nothing to escape: the script is a constant.
    const { deps, runs } = harness({ reply: () => "" });
    await execute(match("screenshot"), deps);
    const call = runs[0]!;
    expect(call.opts?.env?.["JARVIS_SHOT_PATH"]).toMatch(/jarvis-2026-08-09_140530\.png$/);
    const script = Buffer.from(String(call.args.at(-1)), "base64").toString("utf16le");
    expect(script).not.toMatch(/jarvis-2026/);
  });

  it("refuses when no allowed folder is configured", async () => {
    const { deps, runs } = harness({ screenshotRoots: [] });
    const out = await execute(match("take a screenshot"), deps);
    expect(out.ok).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it("refuses a root that is not a safe path", async () => {
    const { deps, runs } = harness({ screenshotRoots: ["C:\\Users\\me\\Pictures\\NUL"] });
    const out = await execute(match("take a screenshot"), deps);
    expect(out.ok).toBe(false);
    expect(runs).toHaveLength(0);
  });
});

describe("machine state", () => {
  it("treats a machine with no battery as an answer, not a failure", async () => {
    const { deps } = harness({ reply: () => "none" });
    const out = await execute(match("battery"), deps);
    expect(out.ok).toBe(true);
    expect(out.speech).toMatch(/doesn't have a battery/);
  });

  it("distinguishes charging from discharging", async () => {
    const charging = harness({ reply: () => "84|2" });
    expect((await execute(match("battery"), charging.deps)).speech).toBe("84% and charging.");
    const onBattery = harness({ reply: () => "84|1" });
    expect((await execute(match("battery"), onBattery.deps)).speech).toBe("84%, on battery.");
  });

  it("reads CPU and memory, tolerating thousands separators", async () => {
    const { deps } = harness({ reply: () => "23|7,168|16,384" });
    const out = await execute(match("cpu usage"), deps);
    expect(out.ok).toBe(true);
    expect(out.speech).toBe("CPU 23%, memory 7.0 of 16.0 gigabytes.");
  });

  it("locks via the documented call, with no shell", async () => {
    const { deps, runs } = harness();
    const out = await execute(match("lock the computer"), deps);
    expect(out.ok).toBe(true);
    expect(runs[0]?.file).toBe("rundll32.exe");
    expect(runs[0]?.args).toEqual(["user32.dll,LockWorkStation"]);
  });
});

describe("app launch", () => {
  it("executes the catalog's own spec, not the spoken words", async () => {
    const { deps, launches } = harness();
    const out = await execute(match("open notepad"), deps);
    expect(out.speech).toBe("Opening Notepad.");
    expect(launches[0]).toEqual({ file: "notepad.exe", args: [] });
  });

  it("hands a protocol URI to the shell handler as one argument", async () => {
    const { deps, launches } = harness();
    await execute(match("open spotify"), deps);
    expect(launches[0]).toEqual({ file: "explorer.exe", args: ["spotify:"] });
  });

  it("does not wait for the app to exit", async () => {
    // `run` would block until the user closed it, then report a timeout.
    const { deps, runs, launches } = harness();
    await execute(match("open notepad"), deps);
    expect(runs).toHaveLength(0);
    expect(launches).toHaveLength(1);
  });

  it("says so when the executable is missing", async () => {
    const { deps } = harness({
      launch: async () => {
        throw new Error("spawn notepad.exe ENOENT");
      },
    });
    const out = await execute(match("open notepad"), deps);
    expect(out.ok).toBe(false);
    expect(out.speech).toBe("I couldn't open Notepad.");
    expect(out.detail).toMatch(/ENOENT/);
  });

  it("refuses an app key that is not in the catalog", async () => {
    const { deps, launches } = harness();
    const out = await execute(
      { kind: "match", id: "app.launch", confidence: 1, slots: { app: "calculator" } },
      deps,
    );
    expect(out.ok).toBe(false);
    expect(launches).toHaveLength(0);
  });
});

describe("failure handling", () => {
  it("turns a thrown error into a spoken outcome, not a crash", async () => {
    const { deps } = harness({
      run: async () => {
        throw new Error("powershell.exe not found");
      },
    });
    const out = await execute(match("battery"), deps);
    expect(out.ok).toBe(false);
    expect(out.speech).toMatch(/didn't work/);
    expect(out.detail).toMatch(/not found/);
  });

  it("bounds every subprocess with a timeout", async () => {
    // A local intent that hangs is worse than one that fails.
    for (const u of ["battery", "cpu usage", "lock the computer", "take a screenshot"]) {
      const { deps, runs } = harness({ reply: () => "none" });
      await execute(match(u), deps);
      for (const c of runs) expect(c.opts?.timeoutMs, u).toBeGreaterThan(0);
    }
  });
});

describe("looking at the screen", () => {
  /** Records the order the executor consults its deps, which is the point. */
  function screenHarness(
    over: {
      accepts?: boolean | undefined;
      result?: CaptureResult;
      capture?: (r: CaptureRequest) => Promise<CaptureResult>;
    } = {},
  ) {
    const order: string[] = [];
    const requests: CaptureRequest[] = [];
    const base = harness({
      agentAcceptsImages:
        over.accepts === undefined
          ? undefined
          : () => {
              order.push("asked-capability");
              return over.accepts!;
            },
      captureScreen: async (r) => {
        order.push("asked-consent");
        requests.push(r);
        if (over.capture) return over.capture(r);
        return (
          over.result ?? {
            ok: true,
            image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            format: "png",
            at: 1,
          }
        );
      },
    });
    return { ...base, order, requests };
  }

  it("hands the image back for the agent rather than sending it anywhere", async () => {
    const { deps, requests } = screenHarness({ accepts: true });
    const out = await execute(match("look at my screen"), deps);
    expect(out.ok).toBe(true);
    expect(out.handoff?.kind).toBe("image");
    expect(out.handoff?.mimeType).toBe("image/png");
    expect(requests[0]?.destination).toBe("agent");
    // The reason is shown verbatim in the prompt, so it has to say something.
    expect(requests[0]?.reason).toMatch(/\S/);
  });

  it("checks the agent can see before asking to photograph the desktop", async () => {
    // Consent spent on nothing is consent spent. If the model cannot accept an
    // image, the honest refusal has to arrive before the dialog, not after it.
    const { deps, order } = screenHarness({ accepts: false });
    const out = await execute(match("look at my screen"), deps);
    expect(out.ok).toBe(false);
    expect(order).toEqual(["asked-capability"]);
    expect(out.speech).toMatch(/can't see images/);
  });

  it("says so plainly when no capture is wired at all", async () => {
    const { deps } = harness();
    const out = await execute(match("read my screen"), deps);
    expect(out.ok).toBe(false);
    expect(out.speech).toMatch(/can't look at your screen/);
    expect(out.handoff).toBeUndefined();
  });

  it("passes a refusal through in the gate's own words", async () => {
    const { deps } = screenHarness({
      accepts: true,
      result: { ok: false, refusal: "denied", speech: "Okay, I won't." },
    });
    const out = await execute(match("look at my screen"), deps);
    expect(out.ok).toBe(false);
    expect(out.speech).toBe("Okay, I won't.");
    expect(out.detail).toMatch(/denied/);
    expect(out.handoff).toBeUndefined();
  });

  it("never names a referent for a screenshot", async () => {
    // "open it" after a capture must reach the agent. A picture is not a place.
    const { deps } = screenHarness({ accepts: true });
    const out = await execute(match("look at my screen"), deps);
    expect(out.subject).toBeUndefined();
  });

  it("spawns no process of its own", async () => {
    // The capture lives behind the gate dep; the executor is policy, not pixels.
    const { deps, runs, launches } = screenHarness({ accepts: true });
    await execute(match("look at my screen"), deps);
    expect(runs).toHaveLength(0);
    expect(launches).toHaveLength(0);
  });
});
