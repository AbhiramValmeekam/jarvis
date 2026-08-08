/**
 * IPC client used by the UI (and by tests/CLI probes) to talk to the runtime.
 *
 * Reconnects on its own, because the runtime restarting must not require the
 * user to restart the UI — and vice versa.
 */
import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import {
  IPC_PROTOCOL_VERSION,
  defaultPipeName,
  isEventFrame,
  type ClientRequestBody,
  type ServerEvent,
} from "./contract.js";
import { readToken } from "./token.js";

export interface PipeClientOptions {
  pipeName?: string;
  /** Token; read from the runtime's token file when omitted. */
  token?: string;
  clientName?: string;
  /** Auto-reconnect when the runtime goes away. Default true. */
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class PipeClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private connected = false;
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: PipeClientOptions = {}) {
    super();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connectAndAuthenticate(): Promise<void> {
    this.closing = false;
    const pipeName = this.options.pipeName ?? defaultPipeName();
    const token = this.options.token ?? readToken();
    if (!token) {
      throw new Error(
        "no runtime token found — is the Jarvis runtime running?",
      );
    }

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(pipeName);
      const onError = (err: Error) => {
        s.off("connect", onConnect);
        reject(err);
      };
      const onConnect = () => {
        s.off("error", onError);
        resolve(s);
      };
      s.once("error", onError);
      s.once("connect", onConnect);
    });

    socket.setEncoding("utf8");
    this.socket = socket;
    this.buffer = "";

    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", () => {
      /* surfaced through close */
    });

    await this.request({
      type: "hello",
      protocolVersion: IPC_PROTOCOL_VERSION,
      token,
      client: this.options.clientName ?? "jarvis-ui",
    });

    this.connected = true;
    this.emit("connected");
  }

  /** Send a request and await its response. */
  request(body: ClientRequestBody): Promise<unknown> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("not connected"));

    const id = this.nextId++;
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ipc request '${body.type}' timed out`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.write(JSON.stringify({ id, ...body }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.failPending(new Error("client closed"));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // ignore noise rather than dropping the connection
      }

      if (isEventFrame(frame)) {
        const { event: _event, ...rest } = frame;
        this.emit("event", rest as ServerEvent);
        this.emit((rest as ServerEvent).type, rest as ServerEvent);
        continue;
      }

      const res = frame as { id?: number; ok?: boolean; result?: unknown; error?: string };
      if (typeof res.id !== "number") continue;
      const pending = this.pending.get(res.id);
      if (!pending) continue;
      this.pending.delete(res.id);
      clearTimeout(pending.timer);
      if (res.ok) pending.resolve(res.result);
      else pending.reject(new Error(res.error ?? "request failed"));
    }
  }

  private onClose(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    this.failPending(new Error("connection closed"));
    if (wasConnected) this.emit("disconnected");

    if (this.closing || this.options.autoReconnect === false) return;
    const delay = this.options.reconnectDelayMs ?? 1_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectAndAuthenticate().catch(() => {
        // Runtime still down; onClose will schedule the next attempt.
        this.onClose();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
