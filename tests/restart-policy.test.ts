import { describe, it, expect } from "vitest";
import { RestartPolicy } from "../src/system/restart-policy.js";

/** Deterministic policy: fixed clock, no jitter randomness. */
function makePolicy(overrides = {}) {
  let clock = 0;
  const policy = new RestartPolicy({
    maxRestarts: 3,
    windowMs: 10_000,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitter: 0,
    now: () => clock,
    random: () => 0.5,
    ...overrides,
  });
  return { policy, advance: (ms: number) => (clock += ms), clockAt: () => clock };
}

describe("RestartPolicy", () => {
  it("allows a restart on first crash", () => {
    const { policy } = makePolicy();
    const d = policy.recordCrash();
    expect(d).toMatchObject({ restart: true, attempt: 1 });
  });

  it("backs off exponentially", () => {
    const { policy } = makePolicy();
    const delays = [
      policy.recordCrash(),
      policy.recordCrash(),
      policy.recordCrash(),
    ].map((d) => (d.restart ? d.delayMs : -1));
    expect(delays).toEqual([100, 200, 400]);
  });

  it("caps the backoff delay", () => {
    const { policy } = makePolicy({ maxRestarts: 10, baseDelayMs: 100, maxDelayMs: 300 });
    const delays = Array.from({ length: 5 }, () => {
      const d = policy.recordCrash();
      return d.restart ? d.delayMs : -1;
    });
    expect(Math.max(...delays)).toBe(300);
  });

  it("STOPS restarting after the limit — no infinite loop", () => {
    const { policy } = makePolicy();
    policy.recordCrash();
    policy.recordCrash();
    policy.recordCrash();
    const fourth = policy.recordCrash();

    expect(fourth.restart).toBe(false);
    expect(policy.isTripped).toBe(true);
    expect(policy.reason).toMatch(/gave up after 3 restarts/);
  });

  it("stays tripped on subsequent crashes", () => {
    const { policy } = makePolicy();
    for (let i = 0; i < 4; i++) policy.recordCrash();
    expect(policy.recordCrash().restart).toBe(false);
    expect(policy.recordCrash().restart).toBe(false);
  });

  it("forgets crashes that fall outside the rolling window", () => {
    const { policy, advance } = makePolicy();
    policy.recordCrash();
    policy.recordCrash();
    expect(policy.recentCrashCount).toBe(2);

    advance(10_001); // whole window elapses
    expect(policy.recentCrashCount).toBe(0);

    // A fresh crash is treated as the first one again.
    const d = policy.recordCrash();
    expect(d).toMatchObject({ restart: true, attempt: 1, delayMs: 100 });
  });

  it("does not trip when crashes are spread wider than the window", () => {
    const { policy, advance } = makePolicy();
    for (let i = 0; i < 10; i++) {
      const d = policy.recordCrash();
      expect(d.restart).toBe(true);
      advance(10_001);
    }
    expect(policy.isTripped).toBe(false);
  });

  it("reset() clears history and un-trips for a manual restart", () => {
    const { policy } = makePolicy();
    for (let i = 0; i < 4; i++) policy.recordCrash();
    expect(policy.isTripped).toBe(true);

    policy.reset();

    expect(policy.isTripped).toBe(false);
    expect(policy.recentCrashCount).toBe(0);
    expect(policy.recordCrash()).toMatchObject({ restart: true, attempt: 1 });
  });

  it("applies jitter within the expected band", () => {
    let clock = 0;
    const lo = new RestartPolicy({
      baseDelayMs: 1000, jitter: 0.2, now: () => clock, random: () => 0,
    });
    const hi = new RestartPolicy({
      baseDelayMs: 1000, jitter: 0.2, now: () => clock, random: () => 1,
    });
    const a = lo.recordCrash();
    const b = hi.recordCrash();
    // +/-10% around 1000ms
    expect(a.restart && a.delayMs).toBe(900);
    expect(b.restart && b.delayMs).toBe(1100);
  });

  it("never returns a negative delay", () => {
    let clock = 0;
    const p = new RestartPolicy({
      baseDelayMs: 0, jitter: 1, now: () => clock, random: () => 0,
    });
    const d = p.recordCrash();
    expect(d.restart && d.delayMs).toBeGreaterThanOrEqual(0);
  });
});
