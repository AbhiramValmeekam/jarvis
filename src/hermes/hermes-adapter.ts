/**
 * HermesAdapter — the single boundary between Jarvis and Hermes Agent.
 *
 * Jarvis components MUST talk to Hermes only through this class so that
 * upstream churn is contained. Transport is ACP (JSON-RPC 2.0 over stdio)
 * spawned via `hermes acp`, which is the one agent surface that works on
 * native Windows: the dashboard's interactive chat path goes through
 * hermes_cli/pty_bridge.py, which is POSIX-only (fcntl/termios) and raises
 * ImportError on native Windows.
 *
 * Capabilities intentionally NOT declared to Hermes: fs and terminal. Hermes
 * then uses its own internal tool implementations instead of delegating file
 * and shell execution to us, which keeps the trust boundary simple for now.
 * Jarvis's own permission layer sits in front of Jarvis-initiated actions.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { JsonRpcPeer, RpcError, type JsonValue } from "./acp-protocol.js";
import { resolveHermesExecutable } from "./resolve-hermes.js";
import {
  ACP_PROTOCOL_VERSION,
  AgentMethod,
  ClientMethod,
  type ContentBlock,
  type HermesStreamEvent,
  type PermissionOutcomeId,
  type StopReason,
} from "./acp-types.js";

export interface HermesAdapterOptions {
  /** Path to the `hermes` executable. Resolved from PATH when omitted. */
  hermesPath?: string;
  /** Working directory handed to `session/new`. */
  cwd?: string;
  /** Milliseconds to wait for `initialize` to return. */
  initTimeoutMs?: number;
  /** Called when Hermes asks permission for a tool call. */
  onPermissionRequest?: (req: {
    sessionId: string;
    toolCall: unknown;
    options: Array<{ optionId: string; kind: string; name: string }>;
  }) => Promise<PermissionOutcomeId> | PermissionOutcomeId;
  /** Receives raw stderr lines from Hermes (its log channel). */
  onLog?: (line: string) => void;
}

export type HermesState =
  | "stopped"
  | "starting"
  | "ready"
  | "unhealthy"
  | "stopping";

export interface HermesHealth {
  state: HermesState;
  pid: number | null;
  agentName: string | null;
  agentVersion: string | null;
  protocolVersion: number | null;
  /** Populated when the last start attempt failed. */
  lastError: string | null;
}

const DEFAULT_INIT_TIMEOUT_MS = 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract concatenated text from an ACP content block or block array. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (isRecord(content)) {
    if (typeof content.text === "string") return content.text;
  }
  return "";
}

export declare interface HermesAdapter {
  on(event: "state", listener: (s: HermesState) => void): this;
  on(event: "log", listener: (line: string) => void): this;
  on(event: "exit", listener: (info: { code: number | null; signal: string | null }) => void): this;
  on(event: string, listener: (...args: never[]) => void): this;
}

export class HermesAdapter extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private peer: JsonRpcPeer | null = null;
  private state: HermesState = "stopped";
  private agentName: string | null = null;
  private agentVersion: string | null = null;
  private protocolVersion: number | null = null;
  private lastError: string | null = null;
  private stderrBuffer = "";
  /** sessionId -> live stream consumers. */
  private readonly streamSinks = new Map<
    string,
    Set<(e: HermesStreamEvent) => void>
  >();

  constructor(private readonly options: HermesAdapterOptions = {}) {
    super();
  }

  getState(): HermesState {
    return this.state;
  }

  healthCheck(): HermesHealth {
    return {
      state: this.state,
      pid: this.proc?.pid ?? null,
      agentName: this.agentName,
      agentVersion: this.agentVersion,
      protocolVersion: this.protocolVersion,
      lastError: this.lastError,
    };
  }

  private setState(s: HermesState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  /** Spawn `hermes acp` and complete the ACP initialize handshake. */
  async start(): Promise<HermesHealth> {
    if (this.state === "ready") return this.healthCheck();
    this.setState("starting");
    this.lastError = null;

    const resolved = resolveHermesExecutable(this.options.hermesPath);
    // No `shell: true` — we resolve the real executable so arguments are
    // passed as an argv array rather than concatenated into a command line.
    const proc = spawn(resolved.path, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: resolved.needsShell,
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;

    proc.on("error", (err) => {
      this.lastError = `spawn failed: ${err.message}`;
      this.setState("unhealthy");
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => this.onStderr(chunk));

    proc.on("exit", (code, signal) => {
      this.peer?.destroy(new Error(`Hermes exited (code=${code} signal=${signal})`));
      this.peer = null;
      this.proc = null;
      if (this.state !== "stopping") {
        this.lastError = `Hermes exited unexpectedly (code=${code} signal=${signal})`;
        this.setState("unhealthy");
      } else {
        this.setState("stopped");
      }
      this.emit("exit", { code, signal });
    });

    const peer = new JsonRpcPeer(proc.stdin, proc.stdout);
    this.peer = peer;
    this.registerClientHandlers(peer);

    const timeoutMs = this.options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    try {
      const result = await this.withTimeout(
        peer.request(AgentMethod.initialize, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            // Hermes uses its own fs/terminal tools when we decline these.
            fs: { readTextFile: false, writeTextFile: false },
          },
          clientInfo: { name: "jarvis", version: "0.1.0" },
        }),
        timeoutMs,
        "initialize",
      );

      if (isRecord(result)) {
        const info = result.agentInfo;
        if (isRecord(info)) {
          this.agentName = typeof info.name === "string" ? info.name : null;
          this.agentVersion = typeof info.version === "string" ? info.version : null;
        }
        this.protocolVersion =
          typeof result.protocolVersion === "number" ? result.protocolVersion : null;
      }
      this.setState("ready");
      return this.healthCheck();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState("unhealthy");
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.setState("stopped");
      return;
    }
    this.setState("stopping");
    this.peer?.destroy(new Error("Hermes stopping"));
    this.peer = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      proc.once("exit", done);
      try {
        proc.stdin.end();
      } catch {
        /* already closed */
      }
      proc.kill();
      // Escalate if it refuses to exit.
      const t = setTimeout(() => {
        try {
          if (process.platform === "win32" && proc.pid) {
            spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
              windowsHide: true,
            });
          } else {
            proc.kill("SIGKILL");
          }
        } catch {
          /* best effort */
        }
        done();
      }, 3_000);
      t.unref?.();
    });

    this.proc = null;
    this.setState("stopped");
  }

  /** Create a new Hermes agent session. Returns its sessionId. */
  async createSession(cwd?: string): Promise<string> {
    const peer = this.requirePeer();
    const result = await peer.request(AgentMethod.sessionNew, {
      cwd: cwd ?? this.options.cwd ?? process.cwd(),
      mcpServers: [],
    });
    if (!isRecord(result) || typeof result.sessionId !== "string") {
      throw new Error("session/new returned no sessionId");
    }
    return result.sessionId;
  }

  /** Resume a previously created session so its history is restored. */
  async resumeSession(sessionId: string, cwd?: string): Promise<void> {
    const peer = this.requirePeer();
    await peer.request(AgentMethod.sessionResume, {
      sessionId,
      cwd: cwd ?? this.options.cwd ?? process.cwd(),
      mcpServers: [],
    });
  }

  async listSessions(): Promise<JsonValue> {
    return this.requirePeer().request(AgentMethod.sessionList, {});
  }

  /**
   * Send a prompt and stream the reply.
   *
   * Resolves with the terminal stop reason once the turn completes. Streamed
   * events arrive via `onEvent` before that.
   */
  async streamMessage(
    sessionId: string,
    text: string,
    onEvent: (e: HermesStreamEvent) => void,
  ): Promise<StopReason> {
    const peer = this.requirePeer();
    let sinks = this.streamSinks.get(sessionId);
    if (!sinks) {
      sinks = new Set();
      this.streamSinks.set(sessionId, sinks);
    }
    sinks.add(onEvent);

    const prompt: ContentBlock[] = [{ type: "text", text }];
    try {
      const result = await peer.request(AgentMethod.sessionPrompt, {
        sessionId,
        prompt: prompt as unknown as JsonValue,
      });
      if (isRecord(result) && typeof result.stopReason === "string") {
        return result.stopReason as StopReason;
      }
      return "end_turn";
    } finally {
      sinks.delete(onEvent);
      if (sinks.size === 0) this.streamSinks.delete(sessionId);
    }
  }

  /** Convenience wrapper: collect the full reply text for a prompt. */
  async sendMessage(
    sessionId: string,
    text: string,
  ): Promise<{ text: string; stopReason: StopReason }> {
    let out = "";
    const stopReason = await this.streamMessage(sessionId, text, (e) => {
      if (e.kind === "text") out += e.text;
    });
    return { text: out, stopReason };
  }

  /** Cancel the in-flight turn for a session (notification, not a request). */
  cancel(sessionId: string): void {
    this.peer?.notify(AgentMethod.sessionCancel, { sessionId });
  }

  private requirePeer(): JsonRpcPeer {
    if (!this.peer || this.state !== "ready") {
      throw new Error(`Hermes not ready (state=${this.state})`);
    }
    return this.peer;
  }

  private async withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let idx: number;
    while ((idx = this.stderrBuffer.indexOf("\n")) !== -1) {
      const line = this.stderrBuffer.slice(0, idx);
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      this.options.onLog?.(line);
      this.emit("log", line);
    }
  }

  private registerClientHandlers(peer: JsonRpcPeer): void {
    peer.onNotification(ClientMethod.sessionUpdate, (params) => {
      if (!isRecord(params)) return;
      const sessionId =
        typeof params.sessionId === "string" ? params.sessionId : null;
      const update = params.update;
      if (!sessionId || !isRecord(update)) return;
      const event = this.toStreamEvent(update);
      if (!event) return;
      const sinks = this.streamSinks.get(sessionId);
      if (!sinks) return;
      for (const sink of sinks) {
        try {
          sink(event);
        } catch {
          /* a bad consumer must not break the stream */
        }
      }
    });

    peer.onRequest(ClientMethod.requestPermission, async (params) => {
      if (!isRecord(params)) {
        return { outcome: { outcome: "cancelled" } } as unknown as JsonValue;
      }
      const sessionId =
        typeof params.sessionId === "string" ? params.sessionId : "";
      const rawOptions: unknown[] = Array.isArray(params.options)
        ? params.options
        : [];
      const options = rawOptions.filter(isRecord).map((o) => ({
        optionId: String(o.optionId ?? ""),
        kind: String(o.kind ?? ""),
        name: String(o.name ?? ""),
      }));

      const handler = this.options.onPermissionRequest;
      // Deny by default: no handler wired means no autonomous approval.
      const chosen: PermissionOutcomeId = handler
        ? await handler({ sessionId, toolCall: params.toolCall, options })
        : "deny";

      // Honour only option ids Hermes actually offered for this call.
      const offered = new Set(options.map((o) => o.optionId));
      const optionId = offered.has(chosen)
        ? chosen
        : offered.has("deny")
          ? "deny"
          : (options[0]?.optionId ?? "deny");

      return {
        outcome: { outcome: "selected", optionId },
      } as unknown as JsonValue;
    });
  }

  private toStreamEvent(update: Record<string, unknown>): HermesStreamEvent | null {
    const kind = update.sessionUpdate;
    if (typeof kind !== "string") return null;
    switch (kind) {
      case "agent_message_chunk":
        return { kind: "text", text: contentText(update.content) };
      case "agent_thought_chunk":
        return { kind: "thought", text: contentText(update.content) };
      case "tool_call":
        return {
          kind: "tool_call",
          id: String(update.toolCallId ?? ""),
          title: String(update.title ?? update.rawInput ?? ""),
          status: typeof update.status === "string" ? update.status : undefined,
          raw: update,
        };
      case "tool_call_update":
        return {
          kind: "tool_update",
          id: String(update.toolCallId ?? ""),
          status: typeof update.status === "string" ? update.status : undefined,
          raw: update,
        };
      case "plan":
        return { kind: "plan", entries: update.entries };
      default:
        return { kind: "other", update: kind, raw: update };
    }
  }
}

export { RpcError };
