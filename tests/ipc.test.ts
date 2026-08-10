import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { connect } from "node:net";
import { PipeServer, type HandledRequest } from "../src/ipc/pipe-server.js";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { IPC_PROTOCOL_VERSION } from "../src/ipc/contract.js";
import { tokensMatch } from "../src/ipc/token.js";

const TOKEN = "test-token-abcdefghijklmnop";
let pipeCounter = 0;

/** Unique pipe per test so nothing leaks between them. */
function uniquePipe(): string {
  pipeCounter++;
  const name = `jarvis-test-${process.pid}-${pipeCounter}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : `/tmp/${name}.sock`;
}

describe("IPC pipe transport", () => {
  let server: PipeServer;
  let client: PipeClient | null = null;
  let pipeName: string;
  let handler: (req: HandledRequest) => void;

  beforeEach(async () => {
    pipeName = uniquePipe();
    handler = ({ request, respond }) => respond({ echoed: request.type });
    server = new PipeServer({
      pipeName,
      token: TOKEN,
      onRequest: (req) => handler(req),
    });
    await server.listen();
  });

  afterEach(async () => {
    await client?.close();
    client = null;
    await server.close();
  });

  async function makeClient(token = TOKEN): Promise<PipeClient> {
    const c = new PipeClient({
      pipeName,
      token,
      autoReconnect: false,
      requestTimeoutMs: 3_000,
    });
    await c.connectAndAuthenticate();
    client = c;
    return c;
  }

  /** Raw socket, for probing the wire without the client's help. */
  function rawSend(frame: unknown): Promise<Record<string, unknown>> {
    return rawLine(JSON.stringify(frame));
  }

  /** Send an arbitrary line, valid JSON or not. */
  function rawLine(payload: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const s = connect(pipeName);
      let buf = "";
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("no response"));
      }, 3_000);
      s.setEncoding("utf8");
      s.on("connect", () => s.write(payload + "\n"));
      s.on("data", (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf("\n");
        if (idx === -1) return;
        clearTimeout(timer);
        const line = buf.slice(0, idx);
        s.destroy();
        resolve(JSON.parse(line));
      });
      s.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  it("accepts an authenticated client", async () => {
    const c = await makeClient();
    expect(c.isConnected).toBe(true);
    expect(server.clientCount).toBe(1);
  });

  it("round-trips a request", async () => {
    const c = await makeClient();
    const result = await c.request({ type: "get_status" });
    expect(result).toEqual({ echoed: "get_status" });
  });

  it("REJECTS a client with the wrong token", async () => {
    const res = await rawSend({
      id: 1,
      type: "hello",
      protocolVersion: IPC_PROTOCOL_VERSION,
      token: "wrong-token",
      client: "attacker",
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("unauthenticated");
    expect(server.clientCount).toBe(0);
  });

  it("does not leak the real token in the error", async () => {
    const res = await rawSend({
      id: 1,
      type: "hello",
      protocolVersion: IPC_PROTOCOL_VERSION,
      token: "wrong-token",
      client: "attacker",
    });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("REFUSES commands before authentication", async () => {
    const onRequest = vi.fn();
    handler = onRequest;

    const res = await rawSend({ id: 7, type: "quit" });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("unauthenticated");
    // The critical part: the runtime never saw the command.
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("rejects a mismatched protocol version", async () => {
    const res = await rawSend({
      id: 1,
      type: "hello",
      protocolVersion: 999,
      token: TOKEN,
      client: "old-ui",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("unsupported_version");
  });

  it("survives a malformed frame without dropping the server", async () => {
    const c = await makeClient();

    // Genuinely unparseable bytes — not a JSON-encoded string.
    const res = await rawLine("}{not json");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("bad_request");

    // Server still serves the existing client.
    const result = await c.request({ type: "get_status" });
    expect(result).toEqual({ echoed: "get_status" });
  });

  it("rejects a non-object frame", async () => {
    const res = await rawLine('"just a string"');
    expect(res.ok).toBe(false);
    expect(res.code).toBe("bad_request");
  });

  it("broadcasts events to authenticated clients", async () => {
    const c = await makeClient();
    const events: unknown[] = [];
    c.on("event", (e: unknown) => events.push(e));

    server.broadcast({ type: "state", state: "listening" });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ type: "state", state: "listening" });
  });

  it("delivers an error event without throwing at a client that only wants 'event'", async () => {
    // A regression, and one that reached as far as the Electron main process.
    // `PipeClient` re-emits every event under its own type, and "error" is
    // EventEmitter's reserved name: emitting it with no listener throws
    // ERR_UNHANDLED_ERROR rather than being ignored. `src/desktop/main.ts`
    // subscribes to "event" and "disconnected" only — so the first error the
    // runtime broadcast, something as ordinary as a memory refused by screening
    // (§53), took down the tray and the window with it.
    const c = await makeClient();
    const events: unknown[] = [];
    c.on("event", (e: unknown) => events.push(e));

    server.broadcast({ type: "error", message: "refused by screening", fatal: false });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: "error", message: "refused by screening" });
    expect(c.isConnected).toBe(true);
  });

  it("still delivers an error event to a client that asked for that type", async () => {
    // The guard must not have bought safety by dropping the per-type emit.
    const c = await makeClient();
    const errors: unknown[] = [];
    c.on("error", (e: unknown) => errors.push(e));

    server.broadcast({ type: "error", message: "hermes gave up", fatal: true });

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ message: "hermes gave up", fatal: true });
  });

  it("does not broadcast to unauthenticated connections", async () => {
    const received: string[] = [];
    const s = connect(pipeName);
    s.setEncoding("utf8");
    s.on("data", (d: string) => received.push(d));
    await new Promise((r) => s.once("connect", r));

    server.broadcast({ type: "state", state: "secret" });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(0);
    s.destroy();
  });

  it("keeps running when a client disconnects — UI close never stops the runtime", async () => {
    const c = await makeClient();
    expect(server.clientCount).toBe(1);

    await c.close();
    client = null;
    await vi.waitFor(() => expect(server.clientCount).toBe(0));

    // A new UI can attach to the same runtime.
    const c2 = await makeClient();
    expect(await c2.request({ type: "get_status" })).toEqual({
      echoed: "get_status",
    });
  });

  it("supports several UIs at once", async () => {
    const a = await makeClient();
    const b = new PipeClient({ pipeName, token: TOKEN, autoReconnect: false });
    await b.connectAndAuthenticate();

    const aEvents: unknown[] = [];
    const bEvents: unknown[] = [];
    a.on("event", (e: unknown) => aEvents.push(e));
    b.on("event", (e: unknown) => bEvents.push(e));

    server.broadcast({ type: "reply_chunk", text: "hi" });

    await vi.waitFor(() => {
      expect(aEvents).toHaveLength(1);
      expect(bEvents).toHaveLength(1);
    });
    await b.close();
  });

  it("propagates a handler failure as an error response", async () => {
    handler = ({ fail }) => fail("hermes is unavailable", "unavailable");
    const c = await makeClient();

    await expect(c.request({ type: "prompt", text: "hi" })).rejects.toThrow(
      /hermes is unavailable/,
    );
  });

  it("turns a thrown handler into an error response, not a crash", async () => {
    handler = () => {
      throw new Error("boom");
    };
    const c = await makeClient();

    await expect(c.request({ type: "get_status" })).rejects.toThrow(/boom/);
    // Server survives.
    handler = ({ respond }) => respond("ok");
    expect(await c.request({ type: "get_status" })).toBe("ok");
  });

  it("matches concurrent responses to the right requests", async () => {
    handler = async ({ request, respond }) => {
      const text = request.type === "prompt" ? request.text : "";
      // Reply out of order: longer text resolves first.
      await new Promise((r) => setTimeout(r, text === "slow" ? 5 : 40));
      respond(text);
    };
    const c = await makeClient();

    const [slow, fast] = await Promise.all([
      c.request({ type: "prompt", text: "slow" }),
      c.request({ type: "prompt", text: "fast" }),
    ]);

    expect(slow).toBe("slow");
    expect(fast).toBe("fast");
  });
});

describe("tokensMatch", () => {
  it("accepts the correct token", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    expect(tokensMatch("abc123", "abc124")).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    expect(tokensMatch("abc123", "abc")).toBe(false);
    expect(tokensMatch("abc123", "abc1234567")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(tokensMatch("abc123", undefined)).toBe(false);
    expect(tokensMatch("abc123", null)).toBe(false);
    expect(tokensMatch("abc123", 123)).toBe(false);
    expect(tokensMatch("abc123", { toString: () => "abc123" })).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(tokensMatch("abc123", "")).toBe(false);
  });
});
