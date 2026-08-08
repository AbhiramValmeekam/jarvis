import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { JsonRpcPeer, RpcError } from "../src/hermes/acp-protocol.js";

/** Wire a peer to in-memory streams and capture what it writes. */
function makePeer() {
  const toAgent = new PassThrough(); // peer's stdin  (client -> agent)
  const fromAgent = new PassThrough(); // peer's stdout (agent -> client)
  const peer = new JsonRpcPeer(toAgent, fromAgent);

  const written: any[] = [];
  toAgent.setEncoding("utf8");
  let buf = "";
  toAgent.on("data", (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) written.push(JSON.parse(line));
    }
  });

  const send = (obj: unknown) => fromAgent.write(JSON.stringify(obj) + "\n");
  const flush = () => new Promise((r) => setImmediate(r));
  return { peer, written, send, flush, fromAgent };
}

describe("JsonRpcPeer", () => {
  it("sends a well-formed request and resolves on the matching response", async () => {
    const { peer, written, send, flush } = makePeer();
    const p = peer.request("session/new", { cwd: "E:\\jarvis" });
    await flush();

    expect(written[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "E:\\jarvis" },
    });

    send({ jsonrpc: "2.0", id: 1, result: { sessionId: "abc" } });
    await expect(p).resolves.toEqual({ sessionId: "abc" });
  });

  it("rejects with RpcError carrying the JSON-RPC code", async () => {
    const { peer, send, flush } = makePeer();
    const p = peer.request("session/prompt");
    await flush();
    send({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
    await expect(p).rejects.toBeInstanceOf(RpcError);
    await expect(p).rejects.toMatchObject({ code: -32601 });
  });

  it("routes concurrent responses to the correct caller regardless of order", async () => {
    const { peer, send, flush } = makePeer();
    const a = peer.request("first");
    const b = peer.request("second");
    await flush();

    // Reply out of order.
    send({ jsonrpc: "2.0", id: 2, result: "B" });
    send({ jsonrpc: "2.0", id: 1, result: "A" });

    await expect(a).resolves.toBe("A");
    await expect(b).resolves.toBe("B");
  });

  it("reassembles messages split across chunk boundaries", async () => {
    const { peer, send, flush, fromAgent } = makePeer();
    const p = peer.request("x");
    await flush();

    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    fromAgent.write(payload.slice(0, 12));
    await flush();
    fromAgent.write(payload.slice(12) + "\n");

    await expect(p).resolves.toEqual({ ok: true });
  });

  it("delivers multiple messages arriving in a single chunk", async () => {
    const { peer, flush, fromAgent } = makePeer();
    const seen: unknown[] = [];
    peer.onNotification("session/update", (params) => seen.push(params));

    fromAgent.write(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { n: 2 } }) +
        "\n",
    );
    await flush();

    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("ignores non-JSON stdout noise instead of dying", async () => {
    const { peer, flush, fromAgent } = makePeer();
    const p = peer.request("x");
    await flush();

    fromAgent.write("a stray print from a plugin\n");
    fromAgent.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "fine" }) + "\n");

    await expect(p).resolves.toBe("fine");
  });

  it("answers an inbound agent request using the registered handler", async () => {
    const { peer, written, send, flush } = makePeer();
    peer.onRequest("session/request_permission", async () => ({
      outcome: { outcome: "selected", optionId: "deny" },
    }));

    send({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: { sessionId: "s1" },
    });
    await flush();
    await flush();

    expect(written[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 77,
      result: { outcome: { outcome: "selected", optionId: "deny" } },
    });
  });

  it("replies -32601 for an inbound request with no handler", async () => {
    const { peer, written, send, flush } = makePeer();
    send({ jsonrpc: "2.0", id: 5, method: "terminal/create", params: {} });
    await flush();

    expect(written[0]).toMatchObject({ id: 5, error: { code: -32601 } });
  });

  it("converts a throwing handler into a -32603 error response", async () => {
    const { peer, written, send, flush } = makePeer();
    peer.onRequest("fs/read_text_file", () => {
      throw new Error("nope");
    });
    send({ jsonrpc: "2.0", id: 9, method: "fs/read_text_file", params: {} });
    await flush();
    await flush();

    expect(written[0]).toMatchObject({
      id: 9,
      error: { code: -32603, message: "nope" },
    });
  });

  it("rejects in-flight requests when the connection dies", async () => {
    const { peer, flush } = makePeer();
    const p = peer.request("session/prompt");
    await flush();
    peer.destroy(new Error("Hermes exited"));
    await expect(p).rejects.toThrow("Hermes exited");
  });

  it("fails fast once closed", async () => {
    const { peer } = makePeer();
    peer.destroy(new Error("closed"));
    await expect(peer.request("x")).rejects.toThrow("closed");
  });

  it("does not let one bad notification consumer break dispatch", async () => {
    const { peer, flush, fromAgent } = makePeer();
    const good = vi.fn();
    peer.onNotification("a", () => {
      throw new Error("bad consumer");
    });
    peer.onNotification("b", good);

    // A throwing handler propagates out of dispatch for its own method only.
    expect(() =>
      fromAgent.write(JSON.stringify({ jsonrpc: "2.0", method: "a" }) + "\n"),
    ).not.toThrow();
    await flush().catch(() => {});
    fromAgent.write(JSON.stringify({ jsonrpc: "2.0", method: "b", params: 1 }) + "\n");
    await flush();
    expect(good).toHaveBeenCalled();
  });
});
