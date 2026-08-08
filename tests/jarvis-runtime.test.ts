import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken, issueToken, revokeToken, tokenFilePath } from "../src/ipc/token.js";
import type { RuntimeStatus } from "../src/ipc/contract.js";
import { FakeAdapter } from "./helpers/fake-adapter.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";

let counter = 0;
function uniquePipe(): string {
  counter++;
  const name = `jarvis-rt-${process.pid}-${counter}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
}

/**
 * Runtime with Hermes stubbed. Hermes' own crash/restart behaviour is covered
 * by hermes-supervisor.test.ts and proven against the real process by
 * scripts/probe-supervisor.ts; these tests are about the runtime shell.
 *
 * A fake adapter keeps the suite hermetic — no real agent is spawned, so
 * resume() does not take seconds or depend on Hermes being installed.
 */
function makeRuntime(pipeName: string, lazyHermes = true): JarvisRuntime {
  return new JarvisRuntime({
    pipeName,
    lazyHermes,
    createAdapter: () => new FakeAdapter(),
  });
}

async function attach(pipeName: string, name = "test-ui"): Promise<PipeClient> {
  const c = new PipeClient({
    pipeName,
    token: readToken() ?? undefined,
    clientName: name,
    autoReconnect: false,
    requestTimeoutMs: 5_000,
  });
  await c.connectAndAuthenticate();
  return c;
}

describe("JarvisRuntime", () => {
  let runtime: JarvisRuntime;
  let pipeName: string;
  const clients: PipeClient[] = [];

  beforeEach(async () => {
    FakeAdapter.reset();
    pipeName = uniquePipe();
    runtime = makeRuntime(pipeName);
    await runtime.start();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    await runtime.stop();
  });

  async function ui(name?: string): Promise<PipeClient> {
    const c = await attach(pipeName, name);
    clients.push(c);
    return c;
  }

  it("comes up and serves status with no UI attached", async () => {
    expect(runtime.uiCount).toBe(0);

    const c = await ui();
    const status = (await c.request({ type: "get_status" })) as RuntimeStatus;

    expect(status.state).toBe("idle");
    expect(status.protocolVersion).toBe(1);
  });

  // --- Phase 2 gate: UI close ---------------------------------------------

  it("SURVIVES the UI closing — close window ≠ quit", async () => {
    const c = await ui();
    expect(runtime.uiCount).toBe(1);

    await c.close();
    clients.length = 0;
    await vi.waitFor(() => expect(runtime.uiCount).toBe(0));

    // The runtime is still fully alive and serving.
    const c2 = await ui("second-ui");
    const status = (await c2.request({ type: "get_status" })) as RuntimeStatus;
    expect(status.state).toBe("idle");
    expect(runtime.shouldQuit).toBe(false);
  });

  it("survives every UI closing and a new one attaching later", async () => {
    const a = await ui("a");
    const b = await ui("b");
    await a.close();
    await b.close();
    clients.length = 0;

    await vi.waitFor(() => expect(runtime.uiCount).toBe(0));

    const c = await ui("late");
    expect(await c.request({ type: "get_status" })).toBeTruthy();
  });

  it("only quits when explicitly asked", async () => {
    const c = await ui();
    const quit = vi.fn();
    runtime.on("quit-requested", quit);

    await c.request({ type: "quit" });

    expect(quit).toHaveBeenCalledOnce();
    expect(runtime.shouldQuit).toBe(true);
  });

  // --- honesty about subsystems -------------------------------------------

  it("reports unimplemented subsystems as unavailable, not as working", async () => {
    const c = await ui();
    const status = (await c.request({ type: "get_status" })) as RuntimeStatus;

    for (const key of ["wakeWord", "stt", "tts"] as const) {
      expect(status.subsystems[key].state).toBe("unavailable");
      expect(status.subsystems[key].detail).toMatch(/not implemented/);
    }
  });

  it("reports Hermes as unavailable while it is not running", async () => {
    const c = await ui();
    const status = (await c.request({ type: "get_status" })) as RuntimeStatus;
    expect(status.subsystems.hermes.state).toBe("unavailable");
  });

  it("refuses to prompt when Hermes is unavailable instead of hanging", async () => {
    const c = await ui();
    await expect(c.request({ type: "prompt", text: "hello" })).rejects.toThrow(
      /not available/i,
    );
  });

  it("rejects an empty prompt", async () => {
    const c = await ui();
    await expect(c.request({ type: "prompt", text: "   " })).rejects.toThrow(
      /required/,
    );
  });

  it("says the permission engine is unavailable rather than silently allowing", async () => {
    const c = await ui();
    await expect(
      c.request({
        type: "permission_response",
        requestId: "x",
        decision: "allow_once",
      }),
    ).rejects.toThrow(/not implemented yet/);
  });

  // --- state + broadcast ---------------------------------------------------

  it("pushes state changes to attached UIs", async () => {
    const c = await ui();
    const states: string[] = [];
    c.on("state", (e: { state: string }) => states.push(e.state));

    runtime.machine.handle("wake");
    runtime.machine.handle("speech_start");

    await vi.waitFor(() => expect(states).toEqual(["wake_detected", "listening"]));
  });

  it("toggles listening and mute through IPC", async () => {
    const c = await ui();

    expect(await c.request({ type: "set_listening", enabled: true })).toEqual({
      listening: true,
    });
    expect(await c.request({ type: "set_muted", muted: true })).toEqual({
      muted: true,
    });

    const status = (await c.request({ type: "get_status" })) as RuntimeStatus;
    expect(status.listening).toBe(true);
    expect(status.muted).toBe(true);
  });

  it("cancel returns the state machine to idle", async () => {
    const c = await ui();
    runtime.machine.handle("wake");
    runtime.machine.handle("speech_start");
    expect(runtime.machine.state).toBe("listening");

    await c.request({ type: "cancel" });
    expect(runtime.machine.state).toBe("idle");
  });

  // --- Phase 2 gate: sleep / resume ---------------------------------------

  it("SURVIVES a sleep/resume cycle with the UI still attached", async () => {
    const c = await ui();
    await runtime.supervisor.start();
    await vi.waitFor(() => expect(runtime.supervisor.isReady()).toBe(true));
    runtime.machine.handle("wake");

    await runtime.onSystemSuspend();
    expect(runtime.supervisor.getStatus().state).toBe("suspended");
    // A half-finished turn must not survive the machine sleeping.
    expect(runtime.machine.state).toBe("idle");
    // And Hermes is honestly reported as gone, not as working.
    let status = (await c.request({ type: "get_status" })) as RuntimeStatus;
    expect(status.subsystems.hermes.state).toBe("unavailable");
    expect(status.subsystems.hermes.detail).toMatch(/sleep/i);

    await runtime.onSystemResume();
    await vi.waitFor(() => expect(runtime.supervisor.isReady()).toBe(true));

    // IPC is unaffected throughout — the same client still works, and Hermes
    // is back without the user doing anything.
    status = (await c.request({ type: "get_status" })) as RuntimeStatus;
    expect(status.state).toBe("idle");
    expect(status.subsystems.hermes.state).toBe("available");
    expect(c.isConnected).toBe(true);
  });

  // --- Phase 2 gate: Hermes death -----------------------------------------

  it("SURVIVES Hermes being killed and reports the recovery to the UI", async () => {
    const c = await ui();
    await runtime.supervisor.start();
    await vi.waitFor(() => expect(runtime.supervisor.isReady()).toBe(true));

    const errors: Array<{ message: string; fatal: boolean }> = [];
    c.on("error", (e: { message: string; fatal: boolean }) => errors.push(e));

    FakeAdapter.latest.crash();

    // The UI is told, and told that it is not fatal.
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.message).toMatch(/Hermes crashed/);
    expect(errors[0]!.fatal).toBe(false);

    // The runtime itself never went down, and Hermes comes back.
    await vi.waitFor(() => expect(runtime.supervisor.isReady()).toBe(true));
    const status = (await c.request({ type: "get_status" })) as RuntimeStatus;
    expect(status.subsystems.hermes.state).toBe("available");
    expect(status.hermes.restartCount).toBe(1);
    expect(c.isConnected).toBe(true);
  });

  it("streams a reply to attached UIs", async () => {
    const c = await ui();
    await runtime.supervisor.start();
    await vi.waitFor(() => expect(runtime.supervisor.isReady()).toBe(true));

    FakeAdapter.latest.reply = "the answer";
    FakeAdapter.latest.extraEvents = [
      { kind: "thought", text: "thinking..." },
      { kind: "tool_call", id: "t1", title: "read_file", status: "pending", raw: {} },
    ];

    const chunks: string[] = [];
    const thoughts: string[] = [];
    const tools: string[] = [];
    let done: string | null = null;
    c.on("reply_chunk", (e: { text: string }) => chunks.push(e.text));
    c.on("thought", (e: { text: string }) => thoughts.push(e.text));
    c.on("tool_call", (e: { title: string }) => tools.push(e.title));
    c.on("reply_done", (e: { stopReason: string }) => (done = e.stopReason));

    await c.request({ type: "prompt", text: "what is it" });

    await vi.waitFor(() => expect(done).toBe("end_turn"));
    expect(chunks.join("")).toBe("the answer");
    expect(thoughts).toEqual(["thinking..."]);
    expect(tools).toEqual(["read_file"]);
    expect(FakeAdapter.latest.lastPrompt).toBe("what is it");
    // Turn completed: back to the conversation window, not stuck mid-turn.
    expect(runtime.machine.state).toBe("conversation");
  });

  it("forwards cancel to Hermes", async () => {
    const c = await ui();
    await runtime.supervisor.start();
    await vi.waitFor(() => expect(runtime.supervisor.isReady()).toBe(true));

    await c.request({ type: "cancel" });
    expect(FakeAdapter.latest.cancelled).toBe(1);
  });

  it("restarts Hermes on request", async () => {
    const c = await ui();
    await runtime.supervisor.start();
    await vi.waitFor(() => expect(runtime.supervisor.isReady()).toBe(true));
    const before = FakeAdapter.instances.length;

    await c.request({ type: "restart_hermes" });

    expect(FakeAdapter.instances.length).toBe(before + 1);
    expect(runtime.supervisor.isReady()).toBe(true);
  });

  // --- single instance -----------------------------------------------------

  it("REFUSES to start a second runtime on the same pipe", async () => {
    const second = makeRuntime(pipeName);
    await expect(second.start()).rejects.toThrow(/already running/i);
    await second.stop();

    // The original is untouched and still serving.
    const c = await ui();
    expect(await c.request({ type: "get_status" })).toBeTruthy();
  });

  it("does not revoke the live token when a second instance is refused", async () => {
    const before = readToken();
    const second = makeRuntime(pipeName);
    await second.start().catch(() => {});

    // A rejected second start must not lock the running instance's UIs out.
    // (It shares the token file, so this asserts the file still resolves.)
    expect(readToken()).toBe(before);
    const c = await ui();
    expect(await c.request({ type: "get_status" })).toBeTruthy();
  });
});

describe("runtime shutdown", () => {
  it("closes the pipe and revokes the token on stop", async () => {
    const pipeName = uniquePipe();
    const runtime = new JarvisRuntime({ pipeName, lazyHermes: true });
    await runtime.start();

    expect(readToken()).toBeTruthy();
    await runtime.stop();

    expect(readToken()).toBeNull();
    // The pipe is gone: a new client cannot attach.
    const c = new PipeClient({ pipeName, token: "x", autoReconnect: false });
    await expect(c.connectAndAuthenticate()).rejects.toBeDefined();
  });

  it("stop is idempotent", async () => {
    const runtime = new JarvisRuntime({ pipeName: uniquePipe(), lazyHermes: true });
    await runtime.start();
    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});

describe("IPC token file", () => {
  const path = join(tmpdir(), `jarvis-token-test-${process.pid}`);

  afterEach(() => revokeToken(path));

  it("issues a fresh token each time", () => {
    const a = issueToken(path);
    const b = issueToken(path);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("writes owner-only permissions", () => {
    issueToken(path);
    const mode = statSync(path).mode & 0o777;
    if (process.platform === "win32") {
      // Windows ignores POSIX mode bits; the user-profile ACL is the control.
      expect(existsSync(path)).toBe(true);
    } else {
      expect(mode).toBe(0o600);
    }
  });

  it("revokes so a stale token cannot be replayed", () => {
    issueToken(path);
    revokeToken(path);
    expect(readToken(path)).toBeNull();
  });

  it("stores nothing but the token itself", () => {
    const t = issueToken(path);
    expect(readFileSync(path, "utf8").trim()).toBe(t);
  });

  it("uses a path outside the repo", () => {
    expect(tokenFilePath().toLowerCase()).not.toContain("e:\\jarvis\\src");
  });
});
