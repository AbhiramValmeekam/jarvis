/**
 * Minimal ACP (Agent Client Protocol) JSON-RPC 2.0 client over stdio.
 *
 * Verified against agent-client-protocol 0.9.0 (PROTOCOL_VERSION = 1) as
 * installed in the local Hermes venv. Wire format is camelCase (pydantic
 * `by_alias=True`); `sessionUpdate` discriminator *values* are snake_case.
 *
 * Framing note: the ACP Python connection writes one JSON object per line
 * to stdout. Hermes reserves stdout for protocol traffic and logs to stderr.
 */
import type { Readable, Writable } from "node:stream";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: JsonValue;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonValue;
}

type Incoming = RpcResponse & RpcNotification & { id?: number };

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Handler for a server->client request. Return value becomes the RPC result. */
export type RequestHandler = (
  params: JsonValue,
) => Promise<JsonValue> | JsonValue;

/** Handler for a server->client notification. */
export type NotificationHandler = (params: JsonValue) => void;

interface Pending {
  resolve: (v: JsonValue) => void;
  reject: (e: Error) => void;
  method: string;
}

/**
 * Line-delimited JSON-RPC 2.0 peer. Bidirectional: ACP agents send requests
 * back to the client (session/request_permission, fs/*, terminal/*), so this
 * is a peer rather than a one-way client.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private buffer = "";
  private closed = false;
  private closeReason: Error | null = null;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
  ) {
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.onData(chunk));
    stdout.on("close", () => this.destroy(new Error("ACP stdout closed")));
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Reject all in-flight calls; further calls fail fast. */
  destroy(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, p] of this.pending) p.reject(reason);
    this.pending.clear();
  }

  async request(method: string, params?: JsonValue): Promise<JsonValue> {
    if (this.closed) {
      throw this.closeReason ?? new Error("ACP connection closed");
    }
    const id = this.nextId++;
    const msg: RpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;

    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.write(msg);
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: JsonValue): void {
    if (this.closed) return;
    const msg: RpcNotification = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  private write(msg: unknown): void {
    this.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Line-delimited framing: process complete lines, keep the remainder.
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: Incoming;
      try {
        parsed = JSON.parse(line) as Incoming;
      } catch {
        // Non-JSON on stdout is a protocol violation; ignore defensively so a
        // stray print from a plugin cannot kill the session.
        continue;
      }
      this.dispatch(parsed);
    }
  }

  private dispatch(msg: Incoming): void {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new RpcError(msg.error.code, msg.error.message, msg.error.data),
        );
      } else {
        pending.resolve(msg.result ?? null);
      }
      return;
    }

    // Inbound request from the agent — must reply with the same id.
    if (msg.id !== undefined && msg.method !== undefined) {
      void this.handleInboundRequest(msg.id, msg.method, msg.params ?? null);
      return;
    }

    // Notification.
    if (msg.method !== undefined) {
      const handler = this.notificationHandlers.get(msg.method);
      if (!handler) return;
      try {
        handler(msg.params ?? null);
      } catch {
        // A misbehaving consumer must never propagate into the stdout 'data'
        // listener — that would tear down the whole ACP transport.
      }
    }
  }

  private async handleInboundRequest(
    id: number,
    method: string,
    params: JsonValue,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}
