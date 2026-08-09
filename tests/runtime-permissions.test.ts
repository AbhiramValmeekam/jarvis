/**
 * The permission chain, end to end over the real pipe.
 *
 * Each piece has unit tests. This asks the question those cannot: when Hermes
 * asks to run something, does a real decision travel from the agent, through
 * the runtime, out to an attached UI, and back — and does it deny when no UI is
 * there to answer? That path is the whole point of the phase, and every part of
 * it could pass in isolation while the wiring between them was wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./helpers/isolate-state.js";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken } from "../src/ipc/token.js";
import { FakeAdapter } from "./helpers/fake-adapter.js";
import type { ServerEvent } from "../src/ipc/contract.js";

let counter = 0;
function uniquePipe(): string {
  counter++;
  const name = `jarvis-perm-${process.pid}-${counter}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
}

const execCall = { name: "run_command", rawInput: { command: "git status" } };

describe("permissions end to end", () => {
  let runtime: JarvisRuntime;
  let pipeName: string;
  const clients: PipeClient[] = [];

  beforeEach(async () => {
    FakeAdapter.reset();
    pipeName = uniquePipe();
    runtime = new JarvisRuntime({
      pipeName,
      lazyHermes: false,
      voice: { enabled: false },
      createAdapter: (o) => new FakeAdapter(o),
    });
    await runtime.start();
    // lazyHermes: false starts the supervisor without awaiting it.
    for (let i = 0; i < 50 && FakeAdapter.instances.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    await runtime.stop();
  });

  async function ui(): Promise<{ client: PipeClient; events: ServerEvent[] }> {
    const client = new PipeClient({
      pipeName,
      token: readToken() ?? undefined,
      clientName: "perm-ui",
      autoReconnect: false,
      requestTimeoutMs: 5_000,
    });
    const events: ServerEvent[] = [];
    client.on("event", (e: ServerEvent) => events.push(e));
    await client.connectAndAuthenticate();
    clients.push(client);
    return { client, events };
  }

  /** Wait for the permission request to reach the UI. */
  async function waitForRequest(events: ServerEvent[]): Promise<
    Extract<ServerEvent, { type: "permission_request" }>
  > {
    for (let i = 0; i < 100; i += 1) {
      const found = events.find((e) => e.type === "permission_request");
      if (found && found.type === "permission_request") return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no permission_request reached the UI");
  }

  it("asks the attached UI and honours an allow", async () => {
    const { client, events } = await ui();
    const decision = FakeAdapter.latest.requestPermission(execCall);

    const req = await waitForRequest(events);
    expect(req.title).toMatch(/run_command/);
    expect(req.detail).toMatch(/execute/);
    expect(req.options).toContain("deny");

    await client.request({
      type: "permission_response",
      requestId: req.requestId,
      decision: "allow_once",
    });
    expect(await decision).toBe("allow_once");
  });

  it("denies when the UI says no", async () => {
    const { client, events } = await ui();
    const decision = FakeAdapter.latest.requestPermission(execCall);
    const req = await waitForRequest(events);
    await client.request({
      type: "permission_response",
      requestId: req.requestId,
      decision: "deny",
    });
    expect(await decision).toBe("deny");
  });

  it("denies with no UI attached rather than waiting for one", async () => {
    // The always-on case, and the reason this is not a UI-driven design: the
    // laptop is on and nobody is looking at it.
    expect(await FakeAdapter.latest.requestPermission(execCall)).toBe("deny");
  });

  it("refuses a forbidden action without asking anyone", async () => {
    const { events } = await ui();
    const outcome = await FakeAdapter.latest.requestPermission({
      name: "run_command",
      rawInput: { command: "Set-MpPreference -DisableRealtimeMonitoring $true" },
    });
    expect(outcome).toBe("deny");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
  });

  it("runs a read without bothering the user", async () => {
    const { events } = await ui();
    const outcome = await FakeAdapter.latest.requestPermission({
      name: "read_file",
      rawInput: { path: "C:\\Users\\me\\notes.md" },
    });
    expect(outcome).toBe("allow_once");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
  });

  it("reuses a stored grant on the second identical call", async () => {
    const { client, events } = await ui();
    const first = FakeAdapter.latest.requestPermission(execCall);
    const req = await waitForRequest(events);
    await client.request({
      type: "permission_response",
      requestId: req.requestId,
      decision: "allow_always",
    });
    expect(await first).toBe("allow_once");

    events.length = 0;
    // No second prompt — the grant covers it. Hermes is still told "once", so
    // it keeps asking and Jarvis stays the only holder of the grant.
    expect(await FakeAdapter.latest.requestPermission(execCall)).toBe("allow_once");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
    expect(runtime.permissions.audit.at(-1)?.reason).toMatch(/previously allowed/);
  });

  it("sends the classified facts, not just a sentence", async () => {
    // Without these the dialog cannot tell "open Notepad" from "delete
    // Documents" — both render as a title and two buttons. The UI derives its
    // weighting from `risk`, so an event missing it degrades every request to
    // the most cautious presentation and the level stops meaning anything.
    const { events } = await ui();
    void FakeAdapter.latest.requestPermission({
      name: "delete_file",
      rawInput: { path: "C:\\Users\\me\\taxes.pdf" },
    });
    const req = await waitForRequest(events);
    expect(req.risk?.level).toBeGreaterThanOrEqual(2);
    expect(req.risk?.category).toBe("delete");
    expect(req.risk?.paths?.[0]).toMatch(/taxes\.pdf/);
    expect(req.risk?.pathCount).toBe(1);
  });

  it("caps the path list but not the count", async () => {
    // A call naming 400 files must not push 400 strings through the pipe, and
    // must not let the UI imply that 12 is the whole story.
    const { events } = await ui();
    const paths = Array.from({ length: 40 }, (_, i) => `C:\\Users\\me\\docs\\f${i}.txt`);
    void FakeAdapter.latest.requestPermission({
      name: "delete_file",
      rawInput: { paths },
    });
    const req = await waitForRequest(events);
    expect(req.risk?.paths?.length).toBeLessThanOrEqual(12);
    expect(req.risk?.pathCount).toBeGreaterThan(req.risk!.paths!.length);
  });

  it("rejects a decision for a request that is not open", async () => {
    const { client } = await ui();
    await expect(
      client.request({
        type: "permission_response",
        requestId: "perm-forged",
        decision: "allow_always",
      }),
    ).rejects.toThrow(/no permission request is open/);
  });

  it("denies outstanding questions when the UI detaches", async () => {
    const { client, events } = await ui();
    const decision = FakeAdapter.latest.requestPermission(execCall);
    await waitForRequest(events);
    await client.close();
    clients.length = 0;
    expect(await decision).toBe("deny");
  });

  it("writes every decision to the audit log", async () => {
    await ui();
    await FakeAdapter.latest.requestPermission({
      name: "read_file",
      rawInput: { path: "C:\\Users\\me\\a.txt" },
    });
    await FakeAdapter.latest.requestPermission({
      name: "run_command",
      rawInput: { command: "netsh advfirewall set allprofiles state off" },
    });
    const audit = runtime.permissions.audit;
    expect(audit.map((e) => e.verdict)).toEqual(["allow", "deny"]);
    expect(audit.at(-1)?.level).toBe(4);
  });

  it("survives an unparseable tool call by denying it", async () => {
    for (const junk of [null, "a string", 42]) {
      expect(await FakeAdapter.latest.requestPermission(junk)).toBe("deny");
    }
  });

  it("pushes each decision to an attached UI as it happens", async () => {
    // The Activity view's live half. The audit log filling up is not the same as
    // a UI being told, and only one of those is what the user sees.
    const { events } = await ui();
    await FakeAdapter.latest.requestPermission({
      name: "run_command",
      rawInput: { command: "netsh advfirewall set allprofiles state off" },
    });
    let activity: Extract<ServerEvent, { type: "activity" }> | undefined;
    for (let i = 0; i < 100 && !activity; i += 1) {
      activity = events.find((e) => e.type === "activity") as typeof activity;
      if (!activity) await new Promise((r) => setTimeout(r, 10));
    }
    expect(activity?.entry.verdict).toBe("deny");
    expect(activity?.entry.tool).toBe("run_command");
  });

  it("serves the backlog to a UI that attached afterwards", async () => {
    // The always-on case again: decisions happen while nothing is watching, and
    // a HUD opened at lunchtime must be able to see the morning.
    await FakeAdapter.latest.requestPermission({
      name: "read_file",
      rawInput: { path: "C:\\Users\\me\\a.txt" },
    });
    const { client } = await ui();
    const list = (await client.request({ type: "get_activity" })) as unknown[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tool: "read_file", verdict: "allow" });
  });

  it("never publishes the tool arguments to a UI", async () => {
    // §53. The path and the command are the parts most likely to carry a secret,
    // and the wire projection is the only thing standing between the audit log
    // and every attached client.
    const { client } = await ui();
    await FakeAdapter.latest.requestPermission({
      name: "read_file",
      rawInput: { path: "C:\\Users\\me\\.aws\\credentials" },
    });
    const list = (await client.request({ type: "get_activity" })) as unknown[];
    expect(JSON.stringify(list)).not.toMatch(/credentials/);
  });

  it("clamps a client-supplied limit instead of trusting it", async () => {
    const { client } = await ui();
    await FakeAdapter.latest.requestPermission({
      name: "read_file",
      rawInput: { path: "C:\\Users\\me\\a.txt" },
    });
    for (const limit of [0, -5, 10_000, Number.NaN, "all"]) {
      // Cast because the contract says `limit?: number` and this test exists
      // precisely because the wire cannot enforce that. Anything holding the
      // token can put a string there, so the runtime has to survive one.
      const list = (await client.request({
        type: "get_activity",
        limit,
      } as unknown as { type: "get_activity"; limit?: number })) as unknown[];
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeLessThanOrEqual(500);
    }
  });
});

/**
 * Screen capture over the same real pipe.
 *
 * Separate from the block above because it needs a stubbed camera, and separate
 * from `screen-capture.test.ts` because that file proves the policy in
 * isolation. The question here is the wiring: does a spoken "look at my screen"
 * actually reach a human, and does the picture actually reach the agent in the
 * same turn? Every part of that could pass alone while the seams were wrong.
 */
describe("screen capture end to end", () => {
  let runtime: JarvisRuntime;
  let pipeName: string;
  const clients: PipeClient[] = [];
  /** Stands in for the display. The consent gate around it is the real one. */
  const shot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]);
  let captures = 0;

  beforeEach(async () => {
    FakeAdapter.reset();
    captures = 0;
    pipeName = uniquePipe();
    runtime = new JarvisRuntime({
      pipeName,
      lazyHermes: false,
      voice: { enabled: false },
      createAdapter: (o) => new FakeAdapter(o),
      captureScreen: async () => {
        captures += 1;
        return shot;
      },
    });
    await runtime.start();
    for (let i = 0; i < 50 && FakeAdapter.instances.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 20));
    FakeAdapter.latest.acceptsImages = true;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    await runtime.stop();
  });

  async function ui(): Promise<{ client: PipeClient; events: ServerEvent[] }> {
    const client = new PipeClient({
      pipeName,
      token: readToken() ?? undefined,
      clientName: "screen-ui",
      autoReconnect: false,
      requestTimeoutMs: 5_000,
    });
    const events: ServerEvent[] = [];
    client.on("event", (e: ServerEvent) => events.push(e));
    // `error` is an EventEmitter special case: unlistened, a refusal broadcast
    // becomes an unhandled exception and fails a test that is *about* refusals.
    client.on("error", () => {});
    await client.connectAndAuthenticate();
    clients.push(client);
    return { client, events };
  }

  async function waitForRequest(
    events: ServerEvent[],
  ): Promise<Extract<ServerEvent, { type: "permission_request" }>> {
    for (let i = 0; i < 200; i += 1) {
      const found = events.find((e) => e.type === "permission_request");
      if (found && found.type === "permission_request") return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no permission_request reached the UI");
  }

  it("asks before capturing, and carries the image into the same turn", async () => {
    const { client, events } = await ui();
    FakeAdapter.latest.reply = "it says the disk is full";

    const turn = runtime.prompt("look at my screen");
    const req = await waitForRequest(events);

    // Nothing has been photographed while the question is open.
    expect(captures).toBe(0);
    expect(req.title).toMatch(/screen/i);
    // The disclosure the user actually reads: where it goes, and what is in it.
    expect(req.detail).toMatch(/sent to the agent/i);
    expect(req.detail).toMatch(/everything currently visible/i);
    // Two buttons. A standing grant is not on offer.
    expect([...req.options].sort()).toEqual(["allow_once", "deny"]);

    await client.request({
      type: "permission_response",
      requestId: req.requestId,
      decision: "allow_once",
    });
    await turn;

    expect(captures).toBe(1);
    expect(runtime.screen.count).toBe(1);
    expect(FakeAdapter.latest.lastPrompt).toBe("look at my screen");
    expect(FakeAdapter.latest.lastImage?.data).toEqual(shot);
    expect(FakeAdapter.latest.lastImage?.mimeType).toBe("image/png");
  });

  it("takes no picture and sends nothing when the user says no", async () => {
    const { client, events } = await ui();

    const turn = runtime.prompt("look at my screen");
    const req = await waitForRequest(events);
    await client.request({
      type: "permission_response",
      requestId: req.requestId,
      decision: "deny",
    });
    await turn;

    expect(captures).toBe(0);
    expect(runtime.screen.count).toBe(0);
    // A denial ends the turn. The utterance is not quietly forwarded to the
    // agent without the picture it was asking about.
    expect(FakeAdapter.latest.lastPrompt).toBeNull();
    expect(FakeAdapter.latest.lastImage).toBeNull();
  });

  it("asks every single time, with no way to make it standing", async () => {
    const { client, events } = await ui();

    // Deliberately `allow_always` first. It must not authorise a capture — and
    // because a refusal leaves the rate limiter untouched, the second turn is
    // free to prompt immediately, which is what proves the question was really
    // asked again rather than answered from a cached grant.
    for (const decision of ["allow_always", "allow_once"] as const) {
      events.length = 0;
      const turn = runtime.prompt("look at my screen");
      const req = await waitForRequest(events);
      expect([...req.options].sort()).toEqual(["allow_once", "deny"]);
      await client.request({
        type: "permission_response",
        requestId: req.requestId,
        decision,
      });
      await turn;
    }

    // Two prompts, one picture: only `allow_once` is consent.
    expect(captures).toBe(1);
    expect(runtime.screen.count).toBe(1);
  });

  it("refuses rather than waiting when there is no UI to ask", async () => {
    // The always-on case: the laptop is on, nobody is looking at it, and an
    // agent asks to photograph the desktop.
    await runtime.prompt("look at my screen");
    expect(captures).toBe(0);
    expect(FakeAdapter.latest.lastImage).toBeNull();
  });

  it("keeps the image out of the activity log", async () => {
    const { client, events } = await ui();
    const turn = runtime.prompt("look at my screen");
    const req = await waitForRequest(events);
    await client.request({
      type: "permission_response",
      requestId: req.requestId,
      decision: "allow_once",
    });
    await turn;

    // §53: the log is the artefact the user can check afterwards, and it must
    // record that a capture happened without containing the capture.
    const list = (await client.request({ type: "get_activity" })) as unknown[];
    const json = JSON.stringify(list);
    expect(json).not.toMatch(/"0":\s*137|iVBOR/);
  });
});
