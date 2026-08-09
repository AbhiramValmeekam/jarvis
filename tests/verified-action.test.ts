/**
 * The wrapper exists because "it didn't throw" is not evidence.
 *
 * These tests are written from the failure that motivated the file: the Recycle
 * Bin restore, where `Verbs.DoIt()` returned nothing, the code read that as
 * success, and eighteen green unit tests agreed. So the cases below are mostly
 * about the machine *lying by omission* — an action that reports fine and
 * changes nothing, a check that cannot run, a call that never comes back — and
 * about the one property that makes the whole thing worth having: the verdict
 * comes from looking, never from the actor's own report.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runVerified,
  isConfirmed,
  existenceVerifier,
  DEFAULT_TIMEOUT_MS,
  type VerifiedActionSpec,
} from "../src/permissions/verified-action.js";

/** A world of one boolean: did the file come back? */
function world(initial: boolean) {
  const state = { present: initial };
  return {
    state,
    observe: () => state.present,
    verifier: existenceVerifier("C:\\tmp\\a.txt", "present"),
  };
}

const spec = <T,>(over: Partial<VerifiedActionSpec<T>> & Pick<VerifiedActionSpec<T>, "observe" | "act" | "verify">): VerifiedActionSpec<T> => ({
  description: "restore a.txt",
  ...over,
});

describe("the verdict comes from looking, not from the report", () => {
  it("confirms an action that actually changed the world", async () => {
    const w = world(false);
    const report = await runVerified(
      spec({ observe: w.observe, act: () => { w.state.present = true; }, verify: w.verifier }),
    );
    expect(report.outcome).toBe("verified");
    expect(report.error).toBeUndefined();
  });

  it("does not believe an action that returned quietly and did nothing", async () => {
    // This is the DoIt() bug exactly: no error, no effect. Reporting this as
    // "done" is how the assistant tells the user their file is back when it is
    // not, and it is the single reason this file exists.
    const w = world(false);
    const report = await runVerified(
      spec({ observe: w.observe, act: () => {}, verify: w.verifier }),
    );
    expect(report.outcome).toBe("unconfirmed");
    expect(report.outcome).not.toBe("verified");
    expect(report.detail).toMatch(/reported no error/);
    expect(report.detail).toMatch(/still not there/);
  });

  it("reports failure as a value, so the caller is never left guessing", async () => {
    const w = world(false);
    const report = await runVerified(
      spec({
        observe: w.observe,
        act: () => { throw new Error("access denied"); },
        verify: w.verifier,
      }),
    );
    expect(report.outcome).toBe("failed");
    expect(report.error).toBe("access denied");
    expect(report.detail).toMatch(/access denied/);
  });

  it("does not care what the action threw if the world changed anyway", async () => {
    // A noisy tool that works is a different problem from a quiet one that
    // doesn't. The user asked for the file back; the file is back — and the
    // check could tell, because it was false beforehand.
    const w = world(false);
    const report = await runVerified(
      spec({
        observe: w.observe,
        act: () => {
          w.state.present = true;
          throw new Error("shell wrote to stderr");
        },
        verify: w.verifier,
      }),
    );
    expect(report.outcome).toBe("verified");
    // Kept, not discarded: something did go wrong and the log should show it.
    expect(report.error).toBe("shell wrote to stderr");
  });

  it("does not let an already-true check launder a failure into success", async () => {
    // The bug this caught for real. `undo` on a snapshot restore threw "the
    // saved copy is gone" while its verifier asked "does the file exist?" —
    // which it always did, because a snapshot backs up a file that is still
    // there. The precondition failure came back as "verified", i.e. the exact
    // false success this wrapper exists to prevent, produced by the wrapper.
    const w = world(true);
    const report = await runVerified(
      spec({
        observe: w.observe,
        act: () => { throw new Error("the saved copy is gone"); },
        verify: w.verifier,
      }),
    );
    expect(report.outcome).toBe("failed");
    expect(report.error).toBe("the saved copy is gone");
  });

  it("does not second-guess a passing check when the action did not throw", async () => {
    // A no-op on a world that is already right is a genuine success: "make sure
    // the service is running" when it is running did what was asked. Only the
    // combination of a throw *and* an already-true check is suspicious.
    const w = world(true);
    const verify = vi.fn(w.verifier);
    const report = await runVerified(
      spec({ observe: w.observe, act: () => {}, verify }),
    );
    expect(report.outcome).toBe("verified");
    // The extra probe is not run on the ordinary path.
    expect(verify).toHaveBeenCalledOnce();
  });

  it("falls back to the action's error when the extra probe itself throws", async () => {
    // A verifier that blows up on the before/before comparison has told us
    // nothing, and "nothing" must not resolve in favour of success.
    let calls = 0;
    const report = await runVerified(
      spec({
        observe: () => true,
        act: () => { throw new Error("access denied"); },
        verify: () => {
          calls += 1;
          if (calls > 1) throw new Error("cannot compare");
          return { ok: true as const };
        },
      }),
    );
    expect(report.outcome).toBe("failed");
    expect(report.error).toBe("access denied");
  });

  it("checks the world even when the action threw", async () => {
    // A half-finished action is when knowing the state matters most. If
    // verification were skipped on error, a file moved just before the failure
    // would send the user looking in the wrong place.
    const verify = vi.fn(() => ({ ok: false as const, reason: "nope" }));
    await runVerified(
      spec({ observe: () => 1, act: () => { throw new Error("boom"); }, verify }),
    );
    expect(verify).toHaveBeenCalledOnce();
  });
});

describe("not knowing is its own answer", () => {
  it("does not act at all when the state cannot be read first", async () => {
    // Without a baseline nothing afterwards can be verified, so acting would
    // produce a confident-sounding report backed by nothing.
    const act = vi.fn();
    const report = await runVerified(
      spec({
        observe: () => { throw new Error("drive not ready"); },
        act,
        verify: () => ({ ok: true }),
      }),
    );
    expect(act).not.toHaveBeenCalled();
    expect(report.outcome).toBe("unchecked");
    expect(report.detail).toMatch(/nothing was done/);
    expect(report.detail).toMatch(/drive not ready/);
  });

  it("says unchecked when the world cannot be read afterwards", async () => {
    let calls = 0;
    const report = await runVerified(
      spec({
        observe: () => {
          calls += 1;
          if (calls > 1) throw new Error("drive vanished");
          return true;
        },
        act: () => {},
        verify: () => ({ ok: true }),
      }),
    );
    expect(report.outcome).toBe("unchecked");
    expect(report.outcome).not.toBe("verified");
  });

  it("says unchecked when the check itself throws", async () => {
    // A verifier that blows up has told us nothing. Rounding that up to success
    // would make the wrapper worse than useless — it would launder ignorance.
    const report = await runVerified(
      spec({
        observe: () => 1,
        act: () => {},
        verify: () => { throw new Error("comparison failed"); },
      }),
    );
    expect(report.outcome).toBe("unchecked");
    expect(report.detail).toMatch(/comparison failed/);
  });

  it("keeps a real failure as failed even when the check also broke", async () => {
    // Two things went wrong; the one the user needs is the action's error.
    const report = await runVerified(
      spec({
        observe: () => 1,
        act: () => { throw new Error("access denied"); },
        verify: () => { throw new Error("comparison failed"); },
      }),
    );
    expect(report.outcome).toBe("failed");
    expect(report.error).toBe("access denied");
  });

  it("only ever calls one outcome a success", () => {
    // One place decides this, so no caller has to remember that "unconfirmed"
    // and "unchecked" are not wins.
    expect(isConfirmed("verified")).toBe(true);
    expect(isConfirmed("unconfirmed")).toBe(false);
    expect(isConfirmed("failed")).toBe(false);
    expect(isConfirmed("unchecked")).toBe(false);
  });
});

describe("an action that never comes back", () => {
  it("stops waiting instead of wedging the runtime", async () => {
    // An always-on assistant that blocks forever on one stuck PowerShell call is
    // simply down. The timeout does not cancel the work — nothing here can — it
    // stops waiting, and the world still gets checked afterwards.
    const w = world(false);
    const report = await runVerified(
      spec({ observe: w.observe, act: () => new Promise<void>(() => {}), verify: w.verifier }),
      { timeoutMs: 10 },
    );
    expect(report.outcome).toBe("failed");
    expect(report.error).toMatch(/timed out after 10ms/);
  });

  it("does not leave an unhandled rejection behind when it gives up", async () => {
    // The abandoned action still rejects, ~15ms after nobody is listening. Today
    // `Promise.race` subscribes to it and that is enough; this test does not
    // catch a live bug. It is here because the *property* is what matters and it
    // is easy to lose: a rewrite that waits on the timer alone, or drops the
    // race for an AbortController, would take the process down long after the
    // report was filed — a crash with no visible cause, minutes after the action
    // everyone had stopped thinking about.
    const seen: unknown[] = [];
    const onUnhandled = (err: unknown) => seen.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const report = await runVerified(
        spec({
          observe: () => 1,
          act: () =>
            new Promise<void>((_resolve, reject) =>
              setTimeout(() => reject(new Error("late failure")), 20),
            ),
          verify: () => ({ ok: true }),
        }),
        { timeoutMs: 5 },
      );
      expect(report.error).toMatch(/timed out/);
      await new Promise((r) => setTimeout(r, 60));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("leaves a synchronous action alone", async () => {
    // Wrapping a sync act in timer machinery would add a turn of the event loop
    // to every trivial action for no benefit.
    const w = world(false);
    const report = await runVerified(
      spec({ observe: w.observe, act: () => { w.state.present = true; }, verify: w.verifier }),
      { timeoutMs: 0 },
    );
    expect(report.outcome).toBe("verified");
  });

  it("has a ceiling even when the caller sets none", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("reporting", () => {
  it("waits for slow changes to appear before judging them", async () => {
    // Some effects are not visible the instant the call returns. Without the
    // settle, this reads as unconfirmed and the user is told their action did
    // nothing when it merely had not landed yet.
    const w = world(false);
    setTimeout(() => { w.state.present = true; }, 5);
    const report = await runVerified(
      spec({ observe: w.observe, act: () => {}, verify: w.verifier }),
      { settleMs: 25 },
    );
    expect(report.outcome).toBe("verified");
  });

  it("times the action, not the settle wait", async () => {
    // The performance budget is about how long the machine took to do the work.
    // Charging it for a wait we chose ourselves would make every number useless.
    let clock = 0;
    const report = await runVerified(
      spec({ observe: () => 1, act: () => { clock += 40; }, verify: () => ({ ok: true }) }),
      { now: () => clock, settleMs: 1_000, sleep: async () => { clock += 1_000; } },
    );
    expect(report.tookMs).toBe(40);
  });

  it("carries the description through unchanged for the Activity view", async () => {
    const report = await runVerified({
      description: "empty the Downloads folder",
      observe: () => 1,
      act: () => {},
      verify: () => ({ ok: false, reason: "the folder still has 12 files in it" }),
    });
    expect(report.description).toBe("empty the Downloads folder");
    expect(report.detail).toContain("the folder still has 12 files in it");
  });

  it("uses the verifier's own words when it has some", async () => {
    const report = await runVerified(
      spec({ observe: () => 1, act: () => {}, verify: () => ({ ok: true, detail: "3 files restored" }) }),
    );
    expect(report.detail).toBe("3 files restored");
  });
});

describe("existenceVerifier", () => {
  it("passes only when the path ended up present", () => {
    const v = existenceVerifier("C:\\tmp\\a.txt", "present");
    expect(v(false, true).ok).toBe(true);
    expect(v(false, false).ok).toBe(false);
  });

  it("passes only when the path ended up absent", () => {
    const v = existenceVerifier("C:\\tmp\\a.txt", "absent");
    expect(v(true, false).ok).toBe(true);
    expect(v(true, true).ok).toBe(false);
  });

  it("ignores the before state, because the goal is the end state", () => {
    // A delete of a file that was already gone is still a world where the file
    // is gone. Insisting on a transition would report failure for work that had
    // nothing left to do.
    const v = existenceVerifier("C:\\tmp\\a.txt", "absent");
    expect(v(false, false).ok).toBe(true);
  });

  it("names the path in the reason, so the message is actionable", () => {
    const v = existenceVerifier("C:\\tmp\\a.txt", "present");
    const verdict = v(false, false);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("C:\\tmp\\a.txt");
  });
});
