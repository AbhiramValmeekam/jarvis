import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  HermesSupervisor,
  type AdapterLike,
} from "../src/system/hermes-supervisor.js";
import type { HermesHealth } from "../src/hermes/hermes-adapter.js";
import type { StopReason } from "../src/hermes/acp-types.js";

/**
 * Fake Hermes. Models the real adapter's observable contract: start()/stop(),
 * an `exit` event, and a session id. Lets us drive crashes on demand instead of
 * killing real processes (scripts/probe-supervisor.ts does that against the
 * real thing).
 */
class FakeAdapter extends EventEmitter implements AdapterLike {
  static instances: FakeAdapter[] = [];
  static nextStartFails: Array<Error | null> = [];
  /** Whether a failing start also emits `exit`, as the real adapter does. */
  static failEmitsExit = true;

  readonly id: number;
  running = false;
  sessions = 0;
  stopCalls = 0;
  reply = "hello";

  constructor() {
    super();
    this.id = FakeAdapter.instances.length + 1;
    FakeAdapter.instances.push(this);
  }

  static reset(): void {
    FakeAdapter.instances = [];
    FakeAdapter.nextStartFails = [];
    FakeAdapter.failEmitsExit = true;
  }

  async start(): Promise<unknown> {
    const failure = FakeAdapter.nextStartFails.shift() ?? null;
    if (failure) {
      if (FakeAdapter.failEmitsExit) {
        this.emit("exit", { code: 1, signal: null });
      }
      throw failure;
    }
    this.running = true;
    return this.healthCheck();
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    const wasRunning = this.running;
    this.running = false;
    if (wasRunning) this.emit("exit", { code: 0, signal: null });
  }

  healthCheck(): HermesHealth {
    return {
      state: this.running ? "ready" : "stopped",
      pid: this.running ? 1000 + this.id : null,
      agentName: "hermes",
      agentVersion: "0.18.2",
      protocolVersion: 1,
      lastError: null,
    };
  }

  async createSession(): Promise<string> {
    this.sessions++;
    return `sess-${this.id}-${this.sessions}`;
  }

  async streamMessage(
    _sessionId: string,
    _text: string,
    onEvent: (e: { kind: string; text: string }) => void,
  ): Promise<StopReason> {
    onEvent({ kind: "text", text: this.reply });
    return "end_turn";
  }

  cancel(): void {}

  /** Simulate an external kill (taskkill / OOM / upstream crash). */
  crash(): void {
    this.running = false;
    this.emit("exit", { code: null, signal: "SIGKILL" });
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
