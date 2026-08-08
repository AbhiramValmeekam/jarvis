/**
 * Named-pipe IPC server for the headless runtime.
 *
 * Design rules, all of which exist because the runtime must outlive its UI:
 *   - a client disconnecting is completely routine; it never affects runtime state
 *   - a malformed frame kills that connection only, never the server
 *   - clients must authenticate before anything but `hello` is accepted
 *   - broadcasts are best-effort; one wedged client must not stall the others
 */
import { createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import {
  IPC_PROTOCOL_VERSION,
  defaultPipeName,
  eventFrame,
  type ClientRequest,
  type IpcErrorCode,
  type ServerEvent,
} from "./contract.js";
import { tokensMatch } from "./token.js";

/** A request that has passed authentication, with a reply channel. */
export interface HandledRequest {
  request: ClientRequest;
  clientId: number;
  respond: (result?: unknown) => void;
  fail: (error: string, code?: IpcErrorCode) => void;
}

export interface PipeServerOptions {
  pipeName?: string;
  token: string;
  /** Handles every authenticated request except `hello`. */
  onRequest: (req: HandledRequest) => void | Promise<void>;
  onLog?: (line: string) => void;
}

interface Client {
  id: number;
  socket: Socket;
  authed: boolean;
  buffer: string;
  name: string;
}

/** Refuse absurd frames rather than buffering without bound. */
const MAX_FRAME_BYTES = 1_000_000;

export class PipeServer extends EventEmitter {
  private server: Server | null = null;
  private readonly clients = new Map<number, Client>();
  private nextClientId = 1;
  private readonly pipeName: string;

  constructor(private readonly options: PipeServerOptions) {
    super();
    this.pipeName = options.pipeName ?? defaultPipeName();
  }

  get address(): string {
    return this.pipeName;
  }

  /** Number of currently authenticated clients (UIs attached). */
  get clientCount(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.authed) n++;
    return n;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.onConnection(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.pipeName);
    });

    // Post-listen errors must not throw out of the event loop.
    server.on("error", (err) => {
      this.options.onLog?.(`ipc server error: ${err.message}`);
      this.emit("error", err);
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const c of this.clients.values()) c.socket.destroy();
    this.clients.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Push an event to every authenticated client. Best effort by design. */
  broadcast(event: ServerEvent): void {
    const line = JSON.stringify(eventFrame(event)) + "\n";
    for (const c of this.clients.values()) {
      if (!c.authed) continue;
      try {
        c.socket.write(line);
      } catch {
        // A dead client is not the runtime's problem; cleanup happens on close.
      }
    }
  }

  private onConnection(socket: Socket): void {
    const client: Client = {
      id: this.nextClientId++,
      socket,
      authed: false,
      buffer: "",
      name: "unknown",
    };
    this.clients.set(client.id, client);
    socket.setEncoding("utf8");

    socket.on("data", (chunk: string) => this.onData(client, chunk));
    socket.on("error", () => this.dropClient(client));
    socket.on("close", () => this.dropClient(client));

    this.emit("connect", client.id);
  }

  private dropClient(client: Client): void {
    if (!this.clients.delete(client.id)) return;
    try {
      client.socket.destroy();
    } catch {
      /* already gone */
    }
    this.emit("disconnect", client.id);
  }

  private onData(client: Client, chunk: string): void {
    client.buffer += chunk;
    if (client.buffer.length > MAX_FRAME_BYTES) {
      this.options.onLog?.(`ipc: client ${client.id} exceeded frame limit`);
      this.dropClient(client);
      return;
    }

    let idx: number;
    while ((idx = client.buffer.indexOf("\n")) !== -1) {
      const line = client.buffer.slice(0, idx).trim();
      client.buffer = client.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.handleLine(client, line);
      } catch (err) {
        // One bad frame must never take down the server.
        this.options.onLog?.(
          `ipc: bad frame from client ${client.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private handleLine(client: Client, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.sendError(client, 0, "malformed JSON frame", "bad_request");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      this.sendError(client, 0, "frame must be an object", "bad_request");
      return;
    }

    const msg = parsed as Partial<ClientRequest> & { id?: unknown };
    const id = typeof msg.id === "number" ? msg.id : 0;
    if (typeof msg.type !== "string") {
      this.sendError(client, id, "missing type", "bad_request");
      return;
    }

    if (msg.type === "hello") {
      this.handleHello(client, id, msg);
      return;
    }

    if (!client.authed) {
      // Deliberately terse: never hint at what the right token looks like.
      this.sendError(client, id, "not authenticated", "unauthenticated");
      return;
    }

    void this.dispatch(client, id, msg as ClientRequest);
  }

  private handleHello(
    client: Client,
    id: number,
    msg: Partial<ClientRequest> & Record<string, unknown>,
  ): void {
    const version = typeof msg.protocolVersion === "number" ? msg.protocolVersion : 0;
    if (version !== IPC_PROTOCOL_VERSION) {
      this.sendError(
        client,
        id,
        `unsupported protocol version ${version}; runtime speaks ${IPC_PROTOCOL_VERSION}`,
        "unsupported_version",
      );
      return;
    }

    if (!tokensMatch(this.options.token, msg.token)) {
      this.sendError(client, id, "not authenticated", "unauthenticated");
      // Drop immediately: a client with a bad token gets no second guess on
      // this connection.
      this.dropClient(client);
      return;
    }

    client.authed = true;
    client.name = typeof msg.client === "string" ? msg.client.slice(0, 64) : "unknown";
    this.send(client, { id, ok: true, result: { protocolVersion: IPC_PROTOCOL_VERSION } });
    this.emit("authenticated", client.id, client.name);
  }

  private async dispatch(client: Client, id: number, request: ClientRequest): Promise<void> {
    let settled = false;
    const respond = (result?: unknown) => {
      if (settled) return;
      settled = true;
      this.send(client, { id, ok: true, result });
    };
    const fail = (error: string, code: IpcErrorCode = "internal") => {
      if (settled) return;
      settled = true;
      this.send(client, { id, ok: false, error, code });
    };

    try {
      await this.options.onRequest({ request, clientId: client.id, respond, fail });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  private send(client: Client, frame: unknown): void {
    try {
      client.socket.write(JSON.stringify(frame) + "\n");
    } catch {
      this.dropClient(client);
    }
  }

  private sendError(
    client: Client,
    id: number,
    error: string,
    code: IpcErrorCode,
  ): void {
    this.send(client, { id, ok: false, error, code });
  }
}
