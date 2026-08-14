import { describe, it, expect, vi } from "vitest";
import {
  TurnWatchdog,
  DEFAULT_TURN_STALL_MS,
  DEFAULT_TURN_NOTICE_MS,
} from "../src/runtime/turn-watchdog.js";

/**
 * The clock on an agent turn.
 *
 * Driven with an injected `now` and injected timers rather than real ones: the
 * properties worth pinning are about *elapsed silence*, and a suite that proves
 * them by actually sleeping is both slow and flaky. The runtime-level tests in
 * `jarvis-runtime.test.ts` use real timers over milliseconds, which is where the
 * wiring is checked.
 */
describe("TurnWatchdog", () => {
  /** A fake clock and timer queue, so time is a variable rather than a wait. */
  function harness(): {
    advance: (ms: number) => void;
    setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
    clearTimer: (t: NodeJS.Timeout) => void;
    now: () => number;
    pending: number;
  } {
    let clock = 1_000;
    let seq = 0;
    const queue = new Map<number, { at: number; fn: () => void }>();
    return {
      now: () => clock,
      setTimer: (fn, ms) => {
        seq += 1;
        queue.set(seq, { at: clock + ms, fn });
        return seq as unknown as NodeJS.Timeout;
      },
      clearTimer: (t) => {
        queue.delete(t as unknown as number);
      },
      get pending(): number {
        return queue.size;
      },
      advance: (ms: number) => {
        const target = clock + ms;
        // Fire in due order, one at a time: a tick re-arms, and firing a whole
        // snapshot of the queue would run the replacement timer too early.
        for (;;) {
          let nextId: number | null = null;
          let nextAt = Infinity;
          for (const [id, t] of queue) {
            if (t.at <= target && t.at < nextAt) {
              nextAt = t.at;
              nextId = id;
            }
          }
          if (nextId === null) break;
          const t = queue.get(nextId)!;
          queue.delete(nextId);
          clock = t.at;
          t.fn();
        }
        clock = target;
      },
    };
  }

  it("trips after the configured silence, and only once", () => {
    const h = harness();
    const onStall = vi.fn();
    new TurnWatchdog({
      timeoutMs: 1_000,
      onStall,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    h.advance(999);
    expect(onStall).not.toHaveBeenCalled();

    h.advance(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]![0]).toBeGreaterThanOrEqual(1_000);

    // Nothing left armed: a tripped watchdog is finished, not repeating.
    h.advance(10_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(h.pending).toBe(0);
  });

  it("does NOT trip on a turn that is slow but talking", () => {
    // The regression this file exists to prevent. A turn that streams for far
    // longer than the timeout is working, and killing it would reintroduce the
    // bug the previous fix removed — a deadline applied to an agent's thinking
    // time rather than to its silence.
    const h = harness();
    const onStall = vi.fn();
    const w = new TurnWatchdog({
      timeoutMs: 1_000,
      onStall,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    for (let i = 0; i < 20; i += 1) {
      h.advance(900);
      w.progress();
    }
    expect(onStall).not.toHaveBeenCalled();
    // 18 s of turn, none of it silent for a whole second.
    h.advance(1_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("says something before it gives up", () => {
    const h = harness();
    const onNotice = vi.fn();
    const onStall = vi.fn();
    new TurnWatchdog({
      timeoutMs: 1_000,
      noticeMs: 200,
      onNotice,
      onStall,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    h.advance(200);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onStall).not.toHaveBeenCalled();

    // The notice does not become the deadline: the turn still gets its budget.
    h.advance(700);
    expect(onStall).not.toHaveBeenCalled();
    h.advance(100);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("reports a second silence after progress, not just the first", () => {
    const h = harness();
    const onNotice = vi.fn();
    const w = new TurnWatchdog({
      timeoutMs: 10_000,
      noticeMs: 200,
      onNotice,
      onStall: () => {},
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    h.advance(200);
    w.progress();
    h.advance(200);
    expect(onNotice).toHaveBeenCalledTimes(2);
  });

  it("holds the clock entirely while a human is being asked something", () => {
    // No machine deadline is defensible for a person reading a permission
    // dialog. ConsentBroker bounds that wait itself (110 s), so this is not a
    // hole — it is the one place where waiting is the correct behaviour.
    const h = harness();
    const onStall = vi.fn();
    let asking = true;
    new TurnWatchdog({
      timeoutMs: 1_000,
      onStall,
      isPaused: () => asking,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    h.advance(60_000);
    expect(onStall).not.toHaveBeenCalled();

    // Answered. The agent gets its whole budget from here, not the remainder of
    // a clock that ran while the dialog was open.
    asking = false;
    h.advance(999);
    expect(onStall).not.toHaveBeenCalled();
    h.advance(6_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("judges a late timer on elapsed time, not on having fired", () => {
    // A slept laptop or a blocked event loop means the tick arrives long after
    // it was due. Re-arming a fresh full interval there would let a wedged turn
    // outlive its deadline by another whole budget.
    const h = harness();
    const onStall = vi.fn();
    new TurnWatchdog({
      timeoutMs: 1_000,
      noticeMs: 100,
      onStall,
      onNotice: () => {},
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    // One jump past both marks: the notice fires, and the stall follows on the
    // very next tick rather than a full timeout later.
    h.advance(5_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]![0]).toBeGreaterThanOrEqual(1_000);
  });

  it("stops for good when the turn ends", () => {
    const h = harness();
    const onStall = vi.fn();
    const w = new TurnWatchdog({
      timeoutMs: 1_000,
      onStall,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    w.stop();
    // Idempotent: the runtime calls it from a finally block that may run after a
    // trip has already stopped it.
    w.stop();
    w.progress();
    h.advance(10_000);
    expect(onStall).not.toHaveBeenCalled();
    expect(h.pending).toBe(0);
  });

  it("keeps the defaults on the right side of Hermes' own tool cap", () => {
    // 600 s is `FOREGROUND_MAX_TIMEOUT` in Hermes' terminal_tool.py — the
    // longest a single foreground command it is bounding can legitimately run.
    // The default must sit *above* it, or a ten-minute build gets killed one
    // second before it returns.
    expect(DEFAULT_TURN_STALL_MS).toBeGreaterThan(600_000);
    expect(DEFAULT_TURN_NOTICE_MS).toBeLessThan(DEFAULT_TURN_STALL_MS);
  });
});
