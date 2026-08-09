/**
 * The reader, tested for the three things that would make it dishonest or rude:
 * reporting a failure as "nothing is focused", spawning PowerShell more often
 * than the user asked a question, and letting a garbled read through as fact.
 *
 * `window-facts.test.ts` covers what happens to the title. This file covers
 * getting it, and not getting it.
 */
import { describe, it, expect, vi } from "vitest";
import { ActiveWindow, CACHE_MS } from "../src/context/active-window.js";

const reply = (o: unknown) => JSON.stringify(o);
const chrome = reply({ title: "Build Jarvis — Chrome", pid: 1234, process: "chrome" });

function make(run: (file: string, args: readonly string[]) => Promise<string>) {
  let clock = 1_000;
  const calls: string[][] = [];
  const win = new ActiveWindow({
    run: (file, args) => {
      calls.push([file, ...args]);
      return run(file, args);
    },
    now: () => clock,
  });
  return { win, calls, tick: (ms: number) => (clock += ms) };
}

describe("reading the foreground window", () => {
  it("reports the window it found", async () => {
    const { win } = make(async () => chrome);
    const r = await win.read();
    expect(r).toMatchObject({ ok: true });
    if (r.ok && r.window) {
      expect(r.window.process).toBe("chrome");
      expect(r.window.kind).toBe("browser");
      expect(r.window.origin).toBe("web");
    } else {
      expect.fail("expected a window");
    }
  });

  it("never puts the script on a command line", async () => {
    // The Phase 4 rule, still holding here: the script is one base64 argv
    // element, so there is no string for a quote to break out of.
    const { win, calls } = make(async () => chrome);
    await win.read();
    expect(calls[0]?.[0]).toBe("powershell.exe");
    expect(calls[0]).toContain("-EncodedCommand");
    expect(calls[0]).toContain("-NoProfile");
    expect(calls[0]?.join(" ")).not.toMatch(/GetForegroundWindow/);
  });

  it("distinguishes nothing-focused from could-not-check", async () => {
    // The distinction this type exists for. A lock screen is a fact; a failed
    // spawn is an apology. Collapsing them would have Jarvis calmly report an
    // empty desktop every time PowerShell was missing.
    const nothing = make(async () => reply({ none: true }));
    expect(await nothing.win.read()).toEqual({ ok: true, window: null });

    const broken = make(async () => {
      throw new Error("powershell.exe ENOENT");
    });
    const r = await broken.win.read();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ENOENT/);
  });

  it("treats unparseable output as a failure, not as an empty desktop", async () => {
    const { win } = make(async () => "not json at all");
    const r = await win.read();
    expect(r.ok).toBe(false);
  });

  it("survives a read with fields missing or of the wrong type", async () => {
    const { win } = make(async () => reply({ title: 42, pid: "nope", process: "chrome" }));
    const r = await win.read();
    expect(r).toMatchObject({ ok: true });
    if (r.ok && r.window) {
      expect(r.window.title).toBe("");
      expect(r.window.pid).toBe(0);
    } else {
      expect.fail("expected a window");
    }
  });

  it("reports a window with no owning process as no window", async () => {
    const { win } = make(async () => reply({ title: "ghost", pid: 9, process: "" }));
    expect(await win.read()).toEqual({ ok: true, window: null });
  });
});

describe("asking does not become watching", () => {
  it("does not spawn PowerShell twice for two questions in one breath", async () => {
    const { win, calls } = make(async () => chrome);
    await win.read();
    await win.read();
    expect(calls).toHaveLength(1);
  });

  it("shares one read between callers that ask at the same moment", async () => {
    // Without this the two callers get two PowerShells and can disagree about
    // the same instant, which is worse than either answer alone.
    let started = 0;
    const { win } = make(async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 10));
      return chrome;
    });
    const [a, b] = await Promise.all([win.read(), win.read()]);
    expect(started).toBe(1);
    expect(a).toEqual(b);
  });

  it("looks again once the answer could have gone stale", async () => {
    const { win, calls, tick } = make(async () => chrome);
    await win.read();
    tick(CACHE_MS + 1);
    await win.read();
    expect(calls).toHaveLength(2);
  });

  it("looks again when told focus moved", async () => {
    const { win, calls } = make(async () => chrome);
    await win.read();
    win.invalidate();
    await win.read();
    expect(calls).toHaveLength(2);
  });

  it("does not cache a failure past its usefulness either", async () => {
    // A transient failure that stuck would keep answering "I could not check"
    // after the cause had gone. It expires on the same clock as a success.
    let fail = true;
    const { win, tick } = make(async () => {
      if (fail) throw new Error("busy");
      return chrome;
    });
    expect((await win.read()).ok).toBe(false);
    fail = false;
    tick(CACHE_MS + 1);
    expect((await win.read()).ok).toBe(true);
  });

  it("has no polling loop of its own", async () => {
    // §50's principle applied to the screen: nothing samples the foreground
    // window unless something asked. Constructing the reader must be inert.
    vi.useFakeTimers();
    try {
      const { calls } = make(async () => chrome);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
