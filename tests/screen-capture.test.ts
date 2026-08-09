import { describe, it, expect } from "vitest";
import {
  ScreenCapture,
  promptFor,
  MIN_CAPTURE_INTERVAL_MS,
  SESSION_CAPTURE_LIMIT,
  viaConsentBroker,
  type CaptureConsent,
  type CaptureDeps,
  type CapturePrompt,
} from "../src/context/screen-capture.js";

function makeCapture(
  over: Partial<CaptureDeps> & { answer?: CaptureConsent | null } = {},
  options?: { minIntervalMs?: number; sessionLimit?: number },
) {
  const prompts: CapturePrompt[] = [];
  const logs: string[] = [];
  let captures = 0;
  let clock = 1_000_000;

  const deps: CaptureDeps = {
    ask: async (p) => {
      prompts.push(p);
      return over.answer === undefined ? "allow_once" : over.answer;
    },
    capture: async () => {
      captures += 1;
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
    now: () => clock,
    onLog: (l) => logs.push(l),
    ...over,
  };

  return {
    capture: new ScreenCapture(deps, options ?? {}),
    prompts,
    logs,
    captureCount: () => captures,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("consent", () => {
  it("captures when the user allows it", async () => {
    const { capture, captureCount } = makeCapture();
    const r = await capture.captureOnce({ reason: "You asked what's on screen.", destination: "local" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.format).toBe("png");
    expect(captureCount()).toBe(1);
  });

  it("takes no picture at all when denied", async () => {
    // The assertion that matters is `captureCount`, not the return value: a
    // capture that happens and is then discarded has still happened.
    const { capture, captureCount } = makeCapture({ answer: "deny" });
    const r = await capture.captureOnce({ reason: "why", destination: "local" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("denied");
    expect(captureCount()).toBe(0);
  });

  it("treats nobody being there as a no", async () => {
    // An always-on assistant usually has no window open. That must read as
    // "cannot ask", never as consent.
    const { capture, captureCount } = makeCapture({ answer: null });
    const r = await capture.captureOnce({ reason: "why", destination: "local" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("no-consent-path");
    expect(captureCount()).toBe(0);
  });

  it("asks again for the second capture, and every one after", async () => {
    // The core promise. If consent were ever cached, this would be 1.
    const { capture, prompts, advance } = makeCapture();
    await capture.captureOnce({ reason: "first", destination: "local" });
    advance(MIN_CAPTURE_INTERVAL_MS);
    await capture.captureOnce({ reason: "second", destination: "local" });
    advance(MIN_CAPTURE_INTERVAL_MS);
    await capture.captureOnce({ reason: "third", destination: "local" });
    expect(prompts).toHaveLength(3);
  });

  it("has no way to express a standing grant", async () => {
    // Enforced by the type, so this test documents rather than checks: the only
    // consent value that captures is `allow_once`. Anything a UI invents falls
    // through to a refusal.
    const { capture, captureCount } = makeCapture({
      ask: async () => "allow_always" as unknown as CaptureConsent,
    });
    const r = await capture.captureOnce({ reason: "why", destination: "local" });
    expect(r.ok).toBe(false);
    expect(captureCount()).toBe(0);
  });

  it("exposes no continuous or subscription entry point", () => {
    // "Start streaming my screen" must not be implementable by finding a method
    // someone left in. §50's promise about audio, applied to pixels.
    const { capture } = makeCapture();
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(capture)),
      ...Object.keys(capture),
    ];
    expect(surface).toContain("captureOnce");
    for (const name of ["start", "stream", "subscribe", "watch", "onFrame", "interval"]) {
      expect(surface).not.toContain(name);
    }
  });
});

describe("what the user is told", () => {
  it("says plainly when the image will leave the machine", () => {
    const p = promptFor({ reason: "You asked me to read the error.", destination: "agent" });
    expect(p.leavesMachine).toBe(true);
    expect(p.detail).toMatch(/sent to the agent/i);
    expect(p.detail).toMatch(/cloud/i);
  });

  it("does not claim a transmission that is not happening", () => {
    const p = promptFor({ reason: "You asked me to read the error.", destination: "local" });
    expect(p.leavesMachine).toBe(false);
    expect(p.detail).toMatch(/stays on this machine/i);
    expect(p.detail).not.toMatch(/cloud/i);
  });

  it("carries the caller's reason through verbatim", () => {
    // A prompt with no reason is one users learn to click through.
    const reason = "You asked what the error on screen says.";
    expect(promptFor({ reason, destination: "local" }).detail).toContain(reason);
  });

  it("warns that everything visible is included", () => {
    // The honest part: pixels cannot be redacted the way a window title can.
    const p = promptFor({ reason: "why", destination: "local" });
    expect(p.detail).toMatch(/everything currently visible/i);
  });
});

describe("limits", () => {
  it("refuses a burst of captures", async () => {
    const { capture, captureCount } = makeCapture();
    expect((await capture.captureOnce({ reason: "a", destination: "local" })).ok).toBe(true);
    const second = await capture.captureOnce({ reason: "b", destination: "local" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal).toBe("too-soon");
    expect(captureCount()).toBe(1);
  });

  it("does not prompt at all when rate limited", async () => {
    // Checked before the ask, so a looping caller cannot flood the user with
    // dialogs hoping one gets accepted by mistake.
    const { capture, prompts } = makeCapture();
    await capture.captureOnce({ reason: "a", destination: "local" });
    await capture.captureOnce({ reason: "b", destination: "local" });
    expect(prompts).toHaveLength(1);
  });

  it("allows the next one once the gap has passed", async () => {
    const { capture, advance, captureCount } = makeCapture();
    await capture.captureOnce({ reason: "a", destination: "local" });
    advance(MIN_CAPTURE_INTERVAL_MS);
    expect((await capture.captureOnce({ reason: "b", destination: "local" })).ok).toBe(true);
    expect(captureCount()).toBe(2);
  });

  it("stops at the session limit", async () => {
    const { capture, advance } = makeCapture({}, { sessionLimit: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect((await capture.captureOnce({ reason: `${i}`, destination: "local" })).ok).toBe(true);
      advance(MIN_CAPTURE_INTERVAL_MS);
    }
    const over = await capture.captureOnce({ reason: "one too many", destination: "local" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.refusal).toBe("session-limit");
    expect(capture.count).toBe(3);
  });

  it("does not let refusals consume the session budget", async () => {
    // Otherwise an agent could exhaust the allowance without the user ever
    // agreeing to a single capture.
    const { capture, advance } = makeCapture({ answer: "deny" }, { sessionLimit: 2 });
    await capture.captureOnce({ reason: "a", destination: "local" });
    advance(MIN_CAPTURE_INTERVAL_MS);
    await capture.captureOnce({ reason: "b", destination: "local" });
    expect(capture.count).toBe(0);
  });

  it("has a default limit low enough that a loop hits it", () => {
    expect(SESSION_CAPTURE_LIMIT).toBeLessThanOrEqual(50);
    expect(MIN_CAPTURE_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
  });
});

describe("the record it leaves", () => {
  it("logs every capture, so none is silent", async () => {
    const { capture, logs } = makeCapture();
    await capture.captureOnce({ reason: "why", destination: "agent" });
    const line = logs.find((l) => l.includes("captured screen"));
    expect(line).toBeTruthy();
    expect(line).toContain("destination=agent");
  });

  it("logs refusals too", async () => {
    const { capture, logs } = makeCapture({ answer: "deny" });
    await capture.captureOnce({ reason: "why", destination: "local" });
    expect(logs.some((l) => /denied/i.test(l))).toBe(true);
  });

  it("keeps the image itself out of the log", async () => {
    // §53's habit applied to the one payload that cannot be redacted: the log
    // records that a capture happened and how big it was, never the bytes.
    const { capture, logs } = makeCapture();
    await capture.captureOnce({ reason: "why", destination: "local" });
    for (const line of logs) {
      expect(line).not.toMatch(/PNG|\\x89|base64/i);
    }
  });

  it("retains no copy of the last capture", async () => {
    // The next turn must not be able to read the previous screenshot off this
    // object. Nothing here is allowed to hold pixels.
    const { capture } = makeCapture();
    await capture.captureOnce({ reason: "why", destination: "local" });
    const held = JSON.stringify(capture);
    expect(held).not.toMatch(/137|image/i);
    for (const v of Object.values(capture)) {
      expect(v instanceof Uint8Array).toBe(false);
    }
  });

  it("reports a failed capture as failed rather than pretending", async () => {
    const { capture } = makeCapture({
      capture: async () => {
        throw new Error("no display");
      },
    });
    const r = await capture.captureOnce({ reason: "why", destination: "local" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("capture-failed");
  });
});

/**
 * The one place a four-valued consent meets a two-valued one.
 *
 * Reusing the runtime's consent UI is worth it — one dialog to get right instead
 * of two — but the broker's vocabulary includes `allow_always`, and the whole
 * point of this module is that no such answer exists for pixels. So the
 * conversion is tested harder than the thing it converts.
 */
describe("routing through the existing consent UI", () => {
  it("offers the user two options and no more", async () => {
    const seen: { options: readonly string[]; title: string }[] = [];
    const ask = viaConsentBroker(async (ctx) => {
      seen.push({ options: ctx.options, title: ctx.title });
      return "allow_once";
    });
    await ask(promptFor({ reason: "why", destination: "local" }));
    expect(seen[0]?.options).toEqual(["allow_once", "deny"]);
  });

  it("reads allow_always as a refusal", async () => {
    // The assertion this whole indirection exists for. A UI that offers a
    // standing grant anyway — a stale build, a third-party front end — does not
    // get one.
    const ask = viaConsentBroker(async () => "allow_always");
    expect(await ask(promptFor({ reason: "why", destination: "agent" }))).toBe("deny");
  });

  it("reads deny_always as a refusal, not as an error", async () => {
    const ask = viaConsentBroker(async () => "deny_always");
    expect(await ask(promptFor({ reason: "why", destination: "local" }))).toBe("deny");
  });

  it("keeps null distinct, so nobody-to-ask stays its own outcome", async () => {
    // Collapsing this into `deny` would lose the distinction the refusal
    // vocabulary exists for: "you said no" and "I had no way to ask" are
    // different sentences to say out loud.
    const ask = viaConsentBroker(async () => null);
    expect(await ask(promptFor({ reason: "why", destination: "local" }))).toBe(null);
  });

  it("classifies a capture bound for the agent as outward-facing", async () => {
    const levels: { level: number; category: string }[] = [];
    const ask = viaConsentBroker(async (ctx) => {
      levels.push({ level: ctx.classification.level, category: ctx.classification.category });
      return "deny";
    });
    await ask(promptFor({ reason: "why", destination: "agent" }));
    await ask(promptFor({ reason: "why", destination: "local" }));
    expect(levels[0]?.level).toBe(3);
    expect(levels[0]?.category).toBe("network");
    expect(levels[1]?.level).toBe(2);
  });

  it("never claims a level the engine would auto-allow", async () => {
    // The engine's default `autoAllowUpTo` is 1. A capture classified at or below
    // it would be taken with no prompt at all, which is the one outcome this
    // module exists to make impossible.
    const levels: number[] = [];
    const ask = viaConsentBroker(async (ctx) => {
      levels.push(ctx.classification.level);
      return "deny";
    });
    await ask(promptFor({ reason: "why", destination: "local" }));
    await ask(promptFor({ reason: "why", destination: "agent" }));
    expect(Math.min(...levels)).toBeGreaterThan(1);
  });

  it("names no file, because none is written", async () => {
    const ask = viaConsentBroker(async (ctx) => {
      expect(ctx.classification.paths).toEqual([]);
      return "deny";
    });
    await ask(promptFor({ reason: "why", destination: "local" }));
  });

  it("gives each question its own id", async () => {
    const ids: string[] = [];
    const ask = viaConsentBroker(async (ctx) => {
      ids.push(ctx.requestId);
      return "deny";
    });
    await ask(promptFor({ reason: "a", destination: "local" }));
    await ask(promptFor({ reason: "b", destination: "local" }));
    expect(new Set(ids).size).toBe(2);
  });

  it("drives a real capture end to end", async () => {
    // The bridge and the gate together, which is the shape the runtime uses.
    let taken = 0;
    const capture = new ScreenCapture({
      ask: viaConsentBroker(async () => "allow_once"),
      capture: async () => {
        taken += 1;
        return new Uint8Array(new Array(8).fill(0x89));
      },
      now: () => 5_000_000,
    });
    const r = await capture.captureOnce({ reason: "why", destination: "agent" });
    expect(r.ok).toBe(true);
    expect(taken).toBe(1);
  });

  it("takes nothing when the bridge reports a standing grant", async () => {
    // Same wiring, but the UI answers `allow_always`. No picture is taken — the
    // narrowing happens before the gate ever sees an answer.
    let taken = 0;
    const capture = new ScreenCapture({
      ask: viaConsentBroker(async () => "allow_always"),
      capture: async () => {
        taken += 1;
        return new Uint8Array(8);
      },
      now: () => 5_000_000,
    });
    const r = await capture.captureOnce({ reason: "why", destination: "agent" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("denied");
    expect(taken).toBe(0);
  });
});
