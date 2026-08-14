import { describe, it, expect, vi } from "vitest";
import { HermesSupervisor } from "../src/system/hermes-supervisor.js";
import { FakeAdapter } from "./helpers/fake-adapter.js";

/**
 * What a failing `session/new` actually throws.
 *
 * The real one is `acp.exceptions.RequestError` crossing the wire as JSON-RPC
 * -32603; the supervisor only reads `.message`, but carrying the code keeps the
 * failures in these tests the same shape as the ones in runtime.log.
 */
class RpcLikeError extends Error {
  readonly code = -32603;
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

function makeSupervisor(restart = {}) {
  FakeAdapter.reset();
  const sup = new HermesSupervisor({
    cwd: "E:/jarvis",
    createAdapter: () => new FakeAdapter(),
    restart: {
      maxRestarts: 3,
      windowMs: 60_000,
      baseDelayMs: 1,
      maxDelayMs: 5,
      jitter: 0,
      ...restart,
    },
  });
  return sup;
}

/** Wait until `fn` holds, or fail the test — no arbitrary sleeps. */
async function until(fn: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("condition not met within timeout");
}

const latest = () => FakeAdapter.instances[FakeAdapter.instances.length - 1]!;

describe("HermesSupervisor", () => {
  it("starts Hermes and opens a session", async () => {
    const sup = makeSupervisor();
    await sup.start();

    expect(sup.isReady()).toBe(true);
    expect(sup.getStatus().state).toBe("ready");
    expect(sup.getStatus().sessionId).toBe("sess-1-1");
    expect(sup.getStatus().hermes?.pid).toBe(1001);
    await sup.stop();
  });

  it("recovers automatically when Hermes is killed", async () => {
    const sup = makeSupervisor();
    const crashes: string[] = [];
    sup.on("crash", (e: string) => crashes.push(e));
    await sup.start();

    const first = latest();
    first.crash();

    await until(() => sup.isReady());

    expect(crashes).toHaveLength(1);
    expect(FakeAdapter.instances).toHaveLength(2);
    expect(sup.getStatus().restartCount).toBe(1);
    // A brand-new session — the dead process's session id is not reused.
    expect(sup.getStatus().sessionId).toBe("sess-2-1");
    await sup.stop();
  });

  it("is usable again after a restart", async () => {
    const sup = makeSupervisor();
    await sup.start();
    latest().crash();
    await until(() => sup.isReady());

    let text = "";
    const stop = await sup.streamMessage("hi", (e) => {
      if (e.kind === "text") text += e.text;
    });

    expect(text).toBe("hello");
    expect(stop).toBe("end_turn");
    await sup.stop();
  });

  it("STOPS after the restart limit instead of looping forever", async () => {
    const sup = makeSupervisor({ maxRestarts: 3 });
    const gaveUp = vi.fn();
    sup.on("gave-up", gaveUp);
    await sup.start();

    // Every start succeeds, but the process dies immediately each time.
    for (let i = 0; i < 6; i++) {
      await until(() => sup.isReady() || sup.getStatus().state === "failed");
      if (sup.getStatus().state === "failed") break;
      latest().crash();
      await new Promise((r) => setTimeout(r, 10));
    }

    await until(() => sup.getStatus().state === "failed");
    expect(gaveUp).toHaveBeenCalledOnce();
    expect(sup.getStatus().gaveUpReason).toMatch(/gave up after 3 restarts/);
    // Bounded: it must not have spawned endlessly.
    expect(FakeAdapter.instances.length).toBeLessThanOrEqual(5);

    // And it stays down.
    const spawned = FakeAdapter.instances.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeAdapter.instances.length).toBe(spawned);
  });

  it("does not restart after an intentional stop", async () => {
    const sup = makeSupervisor();
    const crash = vi.fn();
    sup.on("crash", crash);
    await sup.start();

    await sup.stop();
    await new Promise((r) => setTimeout(r, 30));

    expect(crash).not.toHaveBeenCalled();
    expect(sup.getStatus().state).toBe("stopped");
    expect(FakeAdapter.instances).toHaveLength(1);
  });

  it("ignores a stale exit from an adapter it already replaced", async () => {
    const sup = makeSupervisor();
    await sup.start();
    const first = latest();

    first.crash();
    await until(() => sup.isReady());
    expect(FakeAdapter.instances).toHaveLength(2);

    // The dead adapter emits again (duplicate/late event). This must not be
    // treated as a fresh crash, or one failure would cascade into many.
    first.emit("exit", { code: null, signal: "SIGKILL" });
    await new Promise((r) => setTimeout(r, 30));

    expect(FakeAdapter.instances).toHaveLength(2);
    expect(sup.getStatus().restartCount).toBe(1);
    expect(sup.isReady()).toBe(true);
    await sup.stop();
  });

  /**
   * The leak, pinned.
   *
   * `start()` succeeding and `createSession()` failing is not hypothetical: on
   * 2026-08-14 an expired Nous login made every `session/new` return -32603, and
   * the runtime was left with **six live `hermes.exe` trees**, one per restart
   * attempt, half an hour after the fact. The supervisor had dropped each
   * adapter without stopping it, on a comment that only holds when `start()` is
   * what failed.
   */
  it("kills the process it started when the session fails, instead of leaking it", async () => {
    const sup = makeSupervisor();
    FakeAdapter.nextSessionFails = [new RpcLikeError("Internal error")];

    await expect(sup.start()).rejects.toThrow("Internal error");
    const leaked = FakeAdapter.instances[0]!;

    expect(leaked.stopCalls).toBe(1);
    expect(leaked.running).toBe(false);

    await until(() => sup.isReady());
    await sup.stop();
  });

  it("still counts that failure once, and only once", async () => {
    const sup = makeSupervisor({ maxRestarts: 3 });
    FakeAdapter.nextSessionFails = [new RpcLikeError("Internal error")];

    await expect(sup.start()).rejects.toThrow("Internal error");

    // Our own kill fires `exit` on the way out. If that counted as a second
    // crash the restart budget would burn twice as fast as the failures deserve.
    await until(() => sup.getStatus().restartCount === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(sup.getStatus().restartCount).toBe(1);
    await sup.stop();
  });

  it("does not spawn a second Hermes per failed session", async () => {
    const sup = makeSupervisor();
    // Three failures in a row: the outage shape, where retrying does not help.
    FakeAdapter.nextSessionFails = [
      new RpcLikeError("Internal error"),
      new RpcLikeError("Internal error"),
      new RpcLikeError("Internal error"),
    ];

    await expect(sup.start()).rejects.toThrow("Internal error");
    await until(() => sup.isReady());

    // Four adapters were created; three of them are stopped, and exactly one is
    // alive. Before the fix all four were left running.
    expect(FakeAdapter.instances).toHaveLength(4);
    expect(FakeAdapter.instances.filter((a) => a.running)).toHaveLength(1);
    await sup.stop();
  });

  it("counts a failed start once, even though the adapter also emits exit", async () => {
    const sup = makeSupervisor({ maxRestarts: 3 });
    FakeAdapter.failEmitsExit = true;
    FakeAdapter.nextStartFails = [new Error("spawn ENOENT")];

    await expect(sup.start()).rejects.toThrow("spawn ENOENT");

    // Exactly one restart booked for one failure.
    await until(() => sup.getStatus().restartCount === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(sup.getStatus().restartCount).toBe(1);
    await sup.stop();
  });

  it("retries a start that fails without emitting exit", async () => {
    const sup = makeSupervisor();
    FakeAdapter.failEmitsExit = false;
    FakeAdapter.nextStartFails = [new Error("init timed out")];

    await expect(sup.start()).rejects.toThrow("init timed out");
    await until(() => sup.isReady());

    expect(sup.getStatus().state).toBe("ready");
    expect(sup.getStatus().lastError).toBeNull();
    await sup.stop();
  });

  it("suspend releases Hermes and resume brings it back with no user action", async () => {
    const sup = makeSupervisor();
    await sup.start();
    const first = latest();

    await sup.suspend();
    expect(sup.getStatus().state).toBe("suspended");
    expect(sup.getStatus().hermes).toBeNull();
    expect(first.stopCalls).toBe(1);

    await sup.resume();
    await until(() => sup.isReady());

    expect(FakeAdapter.instances).toHaveLength(2);
    expect(sup.getStatus().sessionId).toBe("sess-2-1");
    await sup.stop();
  });

  it("does not restart while suspended", async () => {
    const sup = makeSupervisor();
    await sup.start();
    await sup.suspend();

    await new Promise((r) => setTimeout(r, 30));

    expect(FakeAdapter.instances).toHaveLength(1);
    expect(sup.getStatus().state).toBe("suspended");
  });

  it("manual restart() recovers from a tripped policy", async () => {
    const sup = makeSupervisor({ maxRestarts: 1 });
    await sup.start();

    for (let i = 0; i < 4; i++) {
      if (sup.getStatus().state === "failed") break;
      await until(() => sup.isReady() || sup.getStatus().state === "failed");
      if (sup.getStatus().state === "failed") break;
      latest().crash();
      await new Promise((r) => setTimeout(r, 10));
    }
    await until(() => sup.getStatus().state === "failed");

    await sup.restart();

    expect(sup.isReady()).toBe(true);
    expect(sup.getStatus().gaveUpReason).toBeNull();
    expect(sup.getStatus().restartCount).toBe(0);
    await sup.stop();
  });

  it("refuses to prompt when Hermes is not ready", async () => {
    const sup = makeSupervisor();
    await expect(sup.streamMessage("hi", () => {})).rejects.toThrow(
      /Hermes unavailable/,
    );
  });

  it("shares a single attempt across concurrent start() calls", async () => {
    const sup = makeSupervisor();
    await Promise.all([sup.start(), sup.start(), sup.start()]);

    expect(FakeAdapter.instances).toHaveLength(1);
    expect(sup.isReady()).toBe(true);
    await sup.stop();
  });

  it("reports state transitions so the tray can follow along", async () => {
    const sup = makeSupervisor();
    const states: string[] = [];
    sup.on("state", (s: string) => states.push(s));

    await sup.start();
    latest().crash();
    await until(() => sup.isReady());
    await sup.stop();

    expect(states).toEqual([
      "starting",
      "ready",
      "restarting",
      "starting",
      "ready",
      "stopped",
    ]);
  });
});
