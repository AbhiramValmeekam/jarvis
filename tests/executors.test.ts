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
import type { CronJob, TickerHealth } from "../src/tasks/cron-store.js";
import type { McpServer, McpSnapshot } from "../src/mcp/mcp-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/memory-store.js";

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
      "play sorry by justin bieber on youtube",
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

describe("opening a website", () => {
  const web = (slots: Record<string, string>): IntentMatch => ({
    kind: "match",
    id: "web.open",
    confidence: 1,
    slots,
  });

  it("hands the url to the shell handler as one argument", async () => {
    const { deps, launches, runs } = harness();
    const out = await execute(
      web({ url: "https://www.youtube.com/", spoken: "youtube" }),
      deps,
    );
    expect(out.ok).toBe(true);
    expect(out.speech).toBe("Opening youtube.");
    // The same detached hand-off `app.launch` uses for a protocol URI — no
    // shell, and no waiting for the browser to be closed again.
    expect(launches[0]).toEqual({ file: "explorer.exe", args: ["https://www.youtube.com/"] });
    expect(runs).toHaveLength(0);
  });

  it("refuses anything that is not an https url", async () => {
    // The matcher builds this slot from a fixed table, so reaching here with
    // something else is a bug upstream. Re-asserting it means no later edit to
    // the matcher can turn the microphone into a way to pick a destination.
    for (const bad of [
      "http://example.com/",
      "file:///c:/windows/system32/",
      "javascript:alert(1)",
      "ms-settings:",
      "C:\\Windows\\System32\\cmd.exe",
      "https:/typo.example.com",
      "",
    ]) {
      const { deps, launches } = harness();
      const out = await execute(web({ url: bad, spoken: "somewhere" }), deps);
      expect(out.ok, bad).toBe(false);
      expect(launches, bad).toHaveLength(0);
    }
  });

  it("refuses a match with no url at all", async () => {
    const { deps, launches } = harness();
    const out = await execute(web({ spoken: "youtube" }), deps);
    expect(out.ok).toBe(false);
    expect(launches).toHaveLength(0);
  });

  it("says so when the browser could not be opened", async () => {
    const { deps } = harness({
      launch: async () => {
        throw new Error("spawn explorer.exe ENOENT");
      },
    });
    const out = await execute(web({ url: "https://github.com/", spoken: "github" }), deps);
    expect(out.ok).toBe(false);
    expect(out.speech).toBe("I couldn't open github.");
    expect(out.detail).toMatch(/ENOENT/);
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

describe("memory intents", () => {
  /** A store over a temp file, so nothing touches the real one. */
  const withStore = async (
    fn: (deps: ExecutorDeps, store: MemoryStore) => Promise<void>,
  ): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-exec-mem-"));
    try {
      let t = 0;
      const store = new MemoryStore({ path: join(dir, "memory.json"), now: () => (t += 1000) });
      const { deps } = harness({ memory: store });
      await fn(deps, store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("stores what was said and confirms it", async () => {
    await withStore(async (deps, store) => {
      const r = await execute(match("remember that the staging box is 10.0.0.7"), deps);
      expect(r.ok).toBe(true);
      expect(store.entriesList().map((e) => e.text)).toEqual(["the staging box is 10.0.0.7"]);
    });
  });

  it("refuses a credential and stores nothing", async () => {
    await withStore(async (deps, store) => {
      const r = await execute(
        match("remember that the token is ghp_aaaabbbbccccddddeeeeffff0000111122"),
        deps,
      );
      expect(r.ok).toBe(false);
      expect(r.speech).toMatch(/password, key or token/);
      expect(store.entriesList()).toEqual([]);
    });
  });

  it("keeps the memory's text out of the audit log", async () => {
    // §53: `detail` is written to a durable log, and a memory is private.
    await withStore(async (deps) => {
      const r = await execute(match("remember that my salary review is in march"), deps);
      expect(r.detail ?? "").not.toMatch(/salary/);
      expect(r.detail).toMatch(/id=\w+ chars=\d+/);
    });
  });

  it("says plainly when it has no store rather than pretending to save", async () => {
    const { deps } = harness(); // no memory configured
    const r = await execute(match("remember that the dentist is on tuesday"), deps);
    expect(r.ok).toBe(false);
    expect(r.speech).toMatch(/memory isn't set up/);
  });

  it("recalls a stored fact and reports a miss as a miss", async () => {
    await withStore(async (deps, store) => {
      store.remember("the staging box is 10.0.0.7");

      const hit = await execute(match("what do you remember about staging"), deps);
      expect(hit.speech).toMatch(/10\.0\.0\.7/);

      const miss = await execute(match("what do you remember about the tax return"), deps);
      expect(miss.ok).toBe(true); // "nothing" is an answer
      expect(miss.speech).toMatch(/don't have anything saved/);
    });
  });

  it("asks rather than guessing which memory to delete", async () => {
    // The one local intent that destroys something: being wrong is
    // unrecoverable, and asking costs a sentence.
    await withStore(async (deps, store) => {
      store.remember("the deploy runs on friday");
      store.remember("the deploy key rotates monthly");

      const r = await execute(match("forget about the deploy"), deps);
      expect(r.ok).toBe(false);
      expect(r.speech).toMatch(/Which one/);
      expect(store.entriesList()).toHaveLength(2); // nothing was removed
    });
  });

  it("deletes on an unambiguous match", async () => {
    await withStore(async (deps, store) => {
      store.remember("the dentist is on tuesday");
      const r = await execute(match("forget about the dentist"), deps);
      expect(r.ok).toBe(true);
      expect(store.entriesList()).toEqual([]);
    });
  });

  it("counts Hermes' notes separately and does not read them out", async () => {
    await withStore(async (_d, store) => {
      store.remember("the dentist is on tuesday");
      const { deps } = harness({
        memory: store,
        hermesMemory: () => [
          {
            store: "memory",
            path: "MEMORY.md",
            present: true,
            entries: ["hermes knows this", "and this"],
            chars: 30,
            limit: 2200,
          },
        ],
      });
      const r = await execute(match("what do you remember about me"), deps);
      expect(r.speech).toMatch(/dentist/);
      expect(r.speech).toMatch(/Hermes keeps 2 notes of its own/);
      // Two stores, and only Jarvis' own is quoted.
      expect(r.speech).not.toMatch(/hermes knows this/);
    });
  });
});

describe("skills intent", () => {
  it("summarises by category rather than reciting names", async () => {
    const { deps } = harness({
      skills: () => [
        { name: "a", description: "d", category: "software-development", source: "user" },
        { name: "b", description: "d", category: "software-development", source: "user" },
        { name: "c", description: "d", category: "creative", source: "bundled" },
      ],
    });
    const r = await execute(match("what can you do"), deps);
    expect(r.ok).toBe(true);
    expect(r.speech).toMatch(/3 skills installed/);
    expect(r.speech).toMatch(/software development \(2\)/);
    expect(r.speech).not.toMatch(/\ba\b.*\bb\b.*\bc\b/);
  });

  it("says what it can still do when no skills are installed", async () => {
    const { deps } = harness({ skills: () => [] });
    const r = await execute(match("what can you do"), deps);
    expect(r.ok).toBe(true);
    expect(r.speech).toMatch(/don't see any skills installed/);
    // Still honest about the local abilities, which need no skills at all.
    expect(r.speech).toMatch(/volume, apps, screenshots/);
  });
});

describe("scheduled tasks intent", () => {
  const RUNNING: TickerHealth = { state: "running", heartbeatAgeMs: 1_000, successAgeMs: 1_000 };
  const STALLED: TickerHealth = { state: "stalled", heartbeatAgeMs: 4 * 24 * 3_600_000, successAgeMs: null };

  const job = (over: Partial<CronJob> = {}): CronJob => ({
    id: "job-1",
    name: "Morning digest",
    schedule: "0 9 * * *",
    kind: "cron",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    noAgent: false,
    ...over,
  });

  it("leads with the warning when the jobs will not actually fire", async () => {
    // The reason this intent exists. A list read out as though it were going to
    // run is the §4 failure: a feature that looks like it works.
    const { deps } = harness({
      tasks: () => ({
        jobs: [job()],
        ticker: STALLED,
        willFire: false,
        warning: "Your scheduler is not running, so nothing will fire. Run `hermes gateway start`.",
      }),
    });
    const r = await execute(match("what tasks do i have"), deps);
    expect(r.ok).toBe(true);
    expect(r.speech.indexOf("hermes gateway start")).toBeLessThan(
      r.speech.indexOf("Morning digest"),
    );
    expect(r.detail).toMatch(/willFire=false/);
  });

  it("just reads the list when the scheduler is healthy", async () => {
    const { deps } = harness({
      tasks: () => ({ jobs: [job()], ticker: RUNNING, willFire: true }),
    });
    const r = await execute(match("is the scheduler running"), deps);
    expect(r.speech).toMatch(/1 scheduled task/);
    expect(r.speech).not.toMatch(/hermes gateway/);
  });

  it("says nothing is scheduled rather than inventing a problem", async () => {
    const { deps } = harness({
      tasks: () => ({ jobs: [], ticker: STALLED, willFire: false }),
    });
    const r = await execute(match("what tasks do i have"), deps);
    expect(r.speech).toBe("Nothing is scheduled.");
  });

  it("admits it cannot see the scheduler rather than claiming nothing is set up", async () => {
    // A shell with no cron reader attached must not answer "nothing scheduled",
    // which is a different and much worse sentence than "I can't see".
    const { deps } = harness();
    const r = await execute(match("what tasks do i have"), deps);
    expect(r.ok).toBe(true);
    expect(r.speech).toMatch(/can't see the scheduler/);
    expect(r.speech).not.toMatch(/Nothing is scheduled/);
    expect(r.detail).toBe("tasks=unavailable");
  });

  it("never spawns a process to answer", async () => {
    // It reads Hermes' files directly. Nothing here shells out to `hermes`,
    // which would cost ~3s of Python startup on the latency-critical path.
    const { deps, runs, launches } = harness({
      tasks: () => ({ jobs: [job()], ticker: RUNNING, willFire: true }),
    });
    await execute(match("what tasks do i have"), deps);
    expect(runs).toEqual([]);
    expect(launches).toEqual([]);
  });
});

describe("mcp intent", () => {
  const srv = (over: Partial<McpServer> = {}): McpServer => ({
    name: "github",
    transport: "stdio",
    command: "npx",
    args: [],
    url: "",
    envNames: [],
    enabled: true,
    includeTools: [],
    excludeTools: [],
    suspicious: [],
    ...over,
  });
  const snap = (servers: McpServer[], over: Partial<McpSnapshot> = {}): McpSnapshot => ({
    servers,
    configPresent: true,
    unparsed: false,
    bytes: 1_024,
    ...over,
  });

  it("reads out the configured servers", async () => {
    const { deps } = harness({ mcp: () => snap([srv({ name: "github" })]) });
    const r = await execute(match("what mcp servers do i have"), deps);
    expect(r.ok).toBe(true);
    expect(r.speech).toContain("github");
    expect(r.detail).toBe("mcp=1 enabled=1 flagged=0 unparsed=false");
  });

  it("leads with the warning when an entry is the backdoor shape", async () => {
    // The same rule the scheduler answer follows, for a sharper reason: an MCP
    // entry is a command Hermes will spawn, and the entry that matters most is
    // the one that should not be there.
    const { deps } = harness({
      mcp: () =>
        snap([
          srv({ name: "github" }),
          srv({
            name: "updater",
            command: "bash",
            suspicious: ['"updater" runs a shell script that writes to SSH keys. That is a backdoor, not an MCP server.'],
          }),
        ]),
    });
    const r = await execute(match("list my mcp servers"), deps);
    expect(r.speech.indexOf("backdoor")).toBeLessThan(r.speech.indexOf("github"));
    expect(r.detail).toMatch(/flagged=1/);
  });

  it("says it could not read the config rather than claiming none", async () => {
    const { deps } = harness({ mcp: () => snap([], { unparsed: true }) });
    const r = await execute(match("what mcp servers do i have"), deps);
    expect(r.speech).toMatch(/couldn't read/i);
    expect(r.speech).not.toMatch(/No MCP servers are configured/);
  });

  it("admits it cannot see Hermes' config rather than answering none", async () => {
    const { deps } = harness();
    const r = await execute(match("what mcp servers do i have"), deps);
    expect(r.ok).toBe(true);
    expect(r.speech).toMatch(/can't see Hermes' configuration/);
    expect(r.detail).toBe("mcp=unavailable");
  });

  it("never spawns a process, and never reads an env value (§53)", async () => {
    // `hermes mcp list` costs 1.655 s here and prints a truncating table. The
    // second half is the one that matters: env *names* may be spoken, values
    // are never read at all, so there is nothing to leak into speech or a log.
    const { deps, runs, launches } = harness({
      mcp: () => snap([srv({ envNames: ["GITHUB_TOKEN"] })]),
    });
    const r = await execute(match("what mcp servers do i have"), deps);
    expect(runs).toEqual([]);
    expect(launches).toEqual([]);
    expect(r.speech).not.toContain("ghp_");
  });
});

describe("playing a song on YouTube", () => {
  const SEARCH = "https://www.youtube.com/results?search_query=sorry%20by%20justin%20bieber";
  const play = (over: Record<string, string> = {}): IntentMatch => ({
    kind: "match",
    id: "media.play",
    confidence: 1,
    slots: { query: "sorry by justin bieber", url: SEARCH, spoken: "sorry by justin bieber", ...over },
  });

  it("opens the video itself when the lookup found one", async () => {
    const { deps, launches, runs } = harness({
      findTrack: async () => ({ id: "BerNfXSuvJ0", title: "Justin Bieber - Sorry" }),
    });
    const out = await execute(play(), deps);
    expect(out.ok).toBe(true);
    // What "play sorry on youtube" actually asked for: the track, not a list.
    expect(launches).toEqual([
      { file: "explorer.exe", args: ["https://www.youtube.com/watch?v=BerNfXSuvJ0"] },
    ]);
    // Says what it is playing, which is not always what it was asked for.
    expect(out.speech).toBe("Playing Justin Bieber - Sorry on YouTube.");
    expect(runs).toHaveLength(0);
  });

  it("passes the query to the lookup and nothing else", async () => {
    const asked: string[] = [];
    const { deps } = harness({
      findTrack: async (query) => {
        asked.push(query);
        return null;
      },
    });
    await execute(play(), deps);
    expect(asked).toEqual(["sorry by justin bieber"]);
  });

  it("falls back to the search page, and says so rather than claiming a song", async () => {
    // §4: an assistant that announces a song it has not opened is lying about the
    // one thing the user is about to check.
    for (const findTrack of [
      undefined,
      async () => null,
      async () => {
        throw new Error("getaddrinfo EAI_AGAIN www.youtube.com");
      },
    ] as Array<ExecutorDeps["findTrack"]>) {
      const { deps, launches } = harness(findTrack ? { findTrack } : {});
      const out = await execute(play(), deps);
      expect(out.ok).toBe(true);
      expect(launches).toEqual([{ file: "explorer.exe", args: [SEARCH] }]);
      expect(out.speech).toBe(
        "I couldn't pick the track, so here's what YouTube has for sorry by justin bieber.",
      );
    }
  });

  it("keeps the reason a lookup failed in the detail, not in the reply", async () => {
    const { deps } = harness({
      findTrack: async () => {
        throw new Error("getaddrinfo EAI_AGAIN www.youtube.com");
      },
    });
    const out = await execute(play(), deps);
    expect(out.detail).toMatch(/EAI_AGAIN/);
    expect(out.speech).not.toMatch(/EAI_AGAIN/);
  });

  it("refuses a video id that is not a video id", async () => {
    // The id arrives from a page on the internet, and an id-shaped hole in a URL
    // is where a crafted value would aim. Re-checked here, then fallen back.
    for (const id of [
      "BerNfXSuvJ0&x=1",
      "../../etc/passwd",
      "short",
      "waaaaaaaaaaytoolong",
      "javascript:1",
      "",
    ]) {
      const { deps, launches } = harness({ findTrack: async () => ({ id }) });
      const out = await execute(play(), deps);
      expect(out.ok, id).toBe(true);
      expect(launches, id).toEqual([{ file: "explorer.exe", args: [SEARCH] }]);
    }
  });

  it("refuses a target that is not youtube's own search", async () => {
    // The matcher builds this slot; reaching here with anything else is a bug
    // upstream, and refusing means no later edit to the matcher can turn "play" into
    // a way to pick a destination.
    for (const url of [
      "https://evil.example.com/results?search_query=x",
      "http://www.youtube.com/results?search_query=x",
      "https://www.youtube.com.evil.example/results?search_query=x",
      "javascript:alert(1)",
      "",
    ]) {
      const { deps, launches } = harness({ findTrack: async () => ({ id: "BerNfXSuvJ0" }) });
      const out = await execute(play({ url }), deps);
      expect(out.ok, url).toBe(false);
      expect(launches, url).toHaveLength(0);
    }
  });

  it("refuses a match with no query", async () => {
    const { deps, launches } = harness({ findTrack: async () => ({ id: "BerNfXSuvJ0" }) });
    const out = await execute(
      { kind: "match", id: "media.play", confidence: 1, slots: { url: SEARCH } },
      deps,
    );
    expect(out.ok).toBe(false);
    expect(launches).toHaveLength(0);
  });

  it("says what it was asked for when the title is missing or unspeakable", async () => {
    const long = "x".repeat(200);
    for (const title of [undefined, "", long]) {
      const { deps } = harness({
        findTrack: async () => ({ id: "BerNfXSuvJ0", ...(title === undefined ? {} : { title }) }),
      });
      const out = await execute(play(), deps);
      expect(out.speech, String(title)).toBe("Playing sorry by justin bieber on YouTube.");
    }
  });

  it("reports a browser that would not start", async () => {
    const { deps } = harness({
      findTrack: async () => ({ id: "BerNfXSuvJ0" }),
      launch: async () => {
        throw new Error("spawn explorer.exe ENOENT");
      },
    });
    const out = await execute(play(), deps);
    expect(out.ok).toBe(false);
    expect(out.speech).toBe("I couldn't open YouTube for sorry by justin bieber.");
    expect(out.detail).toMatch(/ENOENT/);
  });
});
