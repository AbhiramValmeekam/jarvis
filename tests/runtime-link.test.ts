import { describe, it, expect, vi } from "vitest";
import { RuntimeLink, type RuntimeClientLike } from "../src/desktop/runtime-link.js";
import { IPC_PROTOCOL_VERSION, type RuntimeStatus } from "../src/ipc/contract.js";

const status = (): RuntimeStatus => ({
  protocolVersion: IPC_PROTOCOL_VERSION,
  state: "idle",
  startedAt: 0,
  hermes: { state: "ready", pid: 1, sessionId: "s", restartCount: 0, gaveUpReason: null },
  voice: {
    state: "stopped",
    pid: null,
    wakeWord: null,
    device: null,
    capturing: false,
    restartCount: 0,
    gaveUpReason: null,
  },
  subsystems: {
    wakeWord: { state: "unavailable" },
    stt: { state: "unavailable" },
    tts: { state: "unavailable" },
    hermes: { state: "available" },
  },
  listening: true,
  muted: false,
  missions: { running: 0, runningIds: [], awaitingApproval: 0, recorded: 0 },
  llm: {
    provider: "offline",
    model: "none",
    available: false,
    simulated: true,
    acceptsImages: false,
    note: "no model is configured",
    planning: false,
  },
});

/**
 * A client that fails to connect until `upAfter` attempts, mirroring a runtime
 * that is still binding its pipe.
 */
function clientFactory(opts: { upAfter?: number; failStatus?: boolean } = {}) {
  const upAfter = opts.upAfter ?? 0;
  let attempts = 0;
  const created: Array<{ closed: boolean }> = [];

  const createClient = (): RuntimeClientLike => {
    attempts++;
    const mine = attempts;
    const rec = { closed: false };
    created.push(rec);
    return {
      async connectAndAuthenticate() {
        if (mine <= upAfter) throw new Error("ENOENT: pipe not found");
      },
      async request() {
        if (opts.failStatus) throw new Error("status failed");
        return status();
      },
      async close() {
        rec.closed = true;
      },
      on() {
        return this;
      },
    };
  };

  return { createClient, created, attempts: () => attempts };
}

function makeLink(
  factory: ReturnType<typeof clientFactory>,
  spawnRuntime = vi.fn(),
  over = {},
) {
  const link = new RuntimeLink({
    createClient: factory.createClient,
    spawnRuntime,
    startupTimeoutMs: 500,
    retryIntervalMs: 1,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...over,
  });
  return { link, spawnRuntime };
}

describe("RuntimeLink", () => {
  it("attaches to an already-running runtime without spawning one", async () => {
    const factory = clientFactory();
    const { link, spawnRuntime } = makeLink(factory);

    const result = await link.attach();

    expect(result.spawned).toBe(false);
    expect(spawnRuntime).not.toHaveBeenCalled();
    expect(result.status.state).toBe("idle");
    expect(factory.attempts()).toBe(1);
  });

  it("starts the runtime when none is there, then attaches", async () => {
    const factory = clientFactory({ upAfter: 3 });
    const { link, spawnRuntime } = makeLink(factory);

    const result = await link.attach();

    expect(spawnRuntime).toHaveBeenCalledOnce();
    expect(result.spawned).toBe(true);
    expect(result.status.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
  });

  it("spawns at most once, however many attach retries it takes", async () => {
    const factory = clientFactory({ upAfter: 6 });
    const { link, spawnRuntime } = makeLink(factory);

    await link.attach();

    // Spawning repeatedly would race several runtimes against the
    // single-instance lock and litter the log with refusals.
    expect(spawnRuntime).toHaveBeenCalledTimes(1);
    expect(factory.attempts()).toBeGreaterThan(2);
  });

  it("gives up with an actionable message instead of hanging forever", async () => {
    const factory = clientFactory({ upAfter: Number.MAX_SAFE_INTEGER });
    const { link } = makeLink(factory, vi.fn(), { startupTimeoutMs: 30 });

    await expect(link.attach()).rejects.toThrow(/could not reach the Jarvis runtime after 30ms/);
  });

  it("closes every failed attempt, leaving no half-open sockets", async () => {
    const factory = clientFactory({ upAfter: 4 });
    const { link } = makeLink(factory);

    await link.attach();

    // All but the successful one must be closed.
    const open = factory.created.filter((c) => !c.closed);
    expect(open).toHaveLength(1);
  });

  it("treats a connect-but-no-status runtime as not attached", async () => {
    // Authenticating and then failing to answer is a half-open link; returning
    // it would hand the UI a client that looks alive and answers nothing.
    const factory = clientFactory({ failStatus: true });
    const { link } = makeLink(factory, vi.fn(), { startupTimeoutMs: 30 });

    await expect(link.attach()).rejects.toThrow(/could not reach the Jarvis runtime/);
    expect(factory.created.every((c) => c.closed)).toBe(true);
  });

  it("does not spawn when the first attach succeeds slowly", async () => {
    const factory = clientFactory();
    const { link, spawnRuntime } = makeLink(factory);

    const result = await link.attach();

    expect(result.spawned).toBe(false);
    expect(spawnRuntime).not.toHaveBeenCalled();
  });
});
