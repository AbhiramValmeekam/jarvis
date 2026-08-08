/**
 * The Jarvis runtime: the always-on process.
 *
 * This is the thing that exists because the laptop is on. It owns Hermes, the
 * assistant state machine, and the IPC server. It has no window and no
 * dependency on Electron — a UI attaching or detaching is invisible to it,
 * which is what makes "close window ≠ quit" true by construction rather than
 * by a handler somebody remembered to write.
 *
 * Honesty rule (§4): subsystems not yet implemented report `unavailable` with a
 * reason. Nothing here pretends to work. Voice lands in Phase 3, and until then
 * `wakeWord`/`stt`/`tts` say so.
 */
import { EventEmitter } from "node:events";
import { HermesSupervisor, type SupervisorOptions } from "../system/hermes-supervisor.js";
import { AssistantStateMachine } from "./state-machine.js";
import { PipeServer, type HandledRequest } from "../ipc/pipe-server.js";
import { generateToken, publishToken, revokeToken } from "../ipc/token.js";
import type { RuntimeStatus, ServerEvent, SubsystemStatus } from "../ipc/contract.js";

export interface RuntimeOptions {
  cwd?: string;
  pipeName?: string;
  hermesPath?: string;
  restart?: SupervisorOptions["restart"];
  /** Skip starting Hermes on boot; it starts on first real need. */
  lazyHermes?: boolean;
  /** Adapter factory, injected by tests to avoid spawning a real agent. */
  createAdapter?: SupervisorOptions["createAdapter"];
  onLog?: (line: string) => void;
}

const NOT_YET_IMPLEMENTED = (phase: string): SubsystemStatus => ({
  state: "unavailable",
  detail: `not implemented yet (${phase})`,
});

export class JarvisRuntime extends EventEmitter {
  readonly supervisor: HermesSupervisor;
  readonly machine: AssistantStateMachine;
  private ipc: PipeServer | null = null;
  private token: string | null = null;
  private startedAt = 0;
  private listening = false;
  private muted = false;
  private stopping = false;
  private quitRequested = false;
  /** True only when this instance published the shared token file. */
  private owningToken = false;

  constructor(private readonly options: RuntimeOptions = {}) {
    super();

    this.supervisor = new HermesSupervisor({
      cwd: options.cwd,
      hermesPath: options.hermesPath,
      restart: options.restart,
      createAdapter: options.createAdapter,
      onLog: (line) => this.log(line),
    });

    this.machine = new AssistantStateMachine();

    this.machine.on("state", (s: string) => {
      this.broadcast({ type: "state", state: s });
      this.emit("state", s);
    });

    this.supervisor.on("state", () => this.broadcastStatus());
    this.supervisor.on("crash", (e: string) => {
      this.log(`hermes crashed: ${e}`);
      this.broadcast({ type: "error", message: `Hermes crashed: ${e}`, fatal: false });
      this.broadcastStatus();
    });
    this.supervisor.on("gave-up", (reason: string) => {
      // A permanent failure is worth saying plainly rather than retrying forever.
      this.broadcast({
        type: "unavailable",
        subsystem: "hermes",
        reason,
      });
      this.broadcastStatus();
    });
    this.supervisor.on("ready", () => this.broadcastStatus());
  }

  get pipeAddress(): string | null {
    return this.ipc?.address ?? null;
  }

  /** Number of attached UIs. Zero is a perfectly normal steady state. */
  get uiCount(): number {
    return this.ipc?.clientCount ?? 0;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();

    // Fresh token per run: a token from a previous run must never work. It is
    // generated in memory and only published after we own the pipe, so a
    // second instance failing the single-instance check cannot clobber the
    // running instance's token and lock its UIs out.
    const token = generateToken();
    const server = new PipeServer({
      pipeName: this.options.pipeName,
      token,
      onRequest: (req) => this.handleRequest(req),
      onLog: (line) => this.log(line),
    });

    try {
      await server.listen();
    } catch (err) {
      // EADDRINUSE means another runtime already owns the pipe. Two runtimes
      // fighting over the microphone and the tray would be worse than one
      // refusing to start.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `could not listen on ${this.options.pipeName ?? "the Jarvis pipe"}: ${msg} ` +
          `(is another Jarvis runtime already running?)`,
      );
    }

    // The pipe is ours; now it is safe to publish credentials for it.
    this.token = token;
    publishToken(token);
    this.ipc = server;
    this.owningToken = true;

    server.on("authenticated", (id: number, name: string) => {
      this.log(`ui attached: ${name} (#${id})`);
      this.broadcastStatus();
    });
    server.on("disconnect", () => this.broadcastStatus());

    this.log(`runtime listening on ${server.address}`);
    this.emit("ready");

    if (!this.options.lazyHermes) {
      // Hermes starting slowly must not delay the runtime being reachable, so
      // this is deliberately not awaited. Status reports "starting" meanwhile.
      void this.supervisor.start().catch((err: unknown) => {
        this.log(
          `hermes failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.machine.reset();
    await this.supervisor.stop();
    await this.ipc?.close();
    this.ipc = null;
    // Revoke last, and only if we published it — an instance that lost the
    // single-instance race must not delete the winner's credentials.
    if (this.owningToken) {
      revokeToken();
      this.owningToken = false;
    }
    this.token = null;
    this.emit("stopped");
  }

  getStatus(): RuntimeStatus {
    const h = this.supervisor.getStatus();
    return {
      protocolVersion: 1,
      state: this.machine.state,
      startedAt: this.startedAt,
      hermes: {
        state: h.state,
        pid: h.hermes?.pid ?? null,
        sessionId: h.sessionId,
        restartCount: h.restartCount,
        gaveUpReason: h.gaveUpReason,
      },
      subsystems: {
        wakeWord: NOT_YET_IMPLEMENTED("Phase 3"),
        stt: NOT_YET_IMPLEMENTED("Phase 3"),
        tts: NOT_YET_IMPLEMENTED("Phase 3"),
        hermes: this.hermesSubsystemStatus(),
      },
      listening: this.listening,
      muted: this.muted,
    };
  }

  private hermesSubsystemStatus(): SubsystemStatus {
    const s = this.supervisor.getStatus();
    if (s.gaveUpReason) {
      return { state: "unavailable", detail: s.gaveUpReason };
    }
    switch (s.state) {
      case "ready":
        return { state: "available" };
      case "starting":
      case "restarting":
        return { state: "starting", detail: s.lastError ?? undefined };
      case "suspended":
        return { state: "unavailable", detail: "suspended (system sleep)" };
      case "failed":
        return { state: "unavailable", detail: s.lastError ?? "failed" };
      default:
        return { state: "unavailable", detail: s.lastError ?? "stopped" };
    }
  }

  /** Send a text prompt through Hermes, streaming the reply to every UI. */
  async prompt(text: string): Promise<void> {
    if (!this.supervisor.isReady()) {
      // Say so rather than silently queueing forever.
      throw new Error(
        `Hermes is not available (${this.supervisor.getStatus().state})`,
      );
    }

    // A typed prompt enters the turn directly: no wake word, no audio.
    this.machine.handle("text_input");
    this.machine.handle("route_agent");
    try {
      const stopReason = await this.supervisor.streamMessage(text, (e) => {
        switch (e.kind) {
          case "text":
            this.broadcast({ type: "reply_chunk", text: e.text });
            break;
          case "thought":
            this.broadcast({ type: "thought", text: e.text });
            break;
          case "tool_call":
            this.broadcast({
              type: "tool_call",
              id: e.id,
              title: e.title,
              status: e.status,
            });
            break;
          default:
            break;
        }
      });
      this.broadcast({ type: "reply_done", stopReason });
      // No audio on the typed path, so the turn is done here. Voice replies
      // go through speak/spoken instead, owned by the audio consumer.
      this.machine.handle("done");
    } catch (err) {
      this.machine.handle("error");
      throw err;
    }
  }

  // --- system power transitions -------------------------------------------

  async onSystemSuspend(): Promise<void> {
    this.log("system suspending");
    this.machine.reset();
    await this.supervisor.suspend();
    this.broadcastStatus();
  }

  async onSystemResume(): Promise<void> {
    this.log("system resumed");
    await this.supervisor.resume();
    this.broadcastStatus();
  }

  // --- IPC ----------------------------------------------------------------

  private async handleRequest(req: HandledRequest): Promise<void> {
    const { request, respond, fail } = req;
    switch (request.type) {
      case "get_status":
        respond(this.getStatus());
        return;

      case "prompt": {
        if (typeof request.text !== "string" || request.text.trim() === "") {
          fail("prompt text is required", "bad_request");
          return;
        }
        try {
          await this.prompt(request.text);
          respond();
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), "unavailable");
        }
        return;
      }

      case "cancel":
        this.supervisor.cancel();
        this.machine.handle("cancel");
        respond();
        return;

      case "set_listening":
        this.listening = Boolean(request.enabled);
        this.broadcastStatus();
        respond({ listening: this.listening });
        return;

      case "set_muted":
        this.muted = Boolean(request.muted);
        this.broadcastStatus();
        respond({ muted: this.muted });
        return;

      case "restart_hermes":
        try {
          await this.supervisor.restart();
          respond(this.getStatus());
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err), "unavailable");
        }
        return;

      case "quit":
        // Acknowledge before shutting down, or the caller sees a dropped socket
        // instead of a clean confirmation.
        respond();
        this.quitRequested = true;
        this.emit("quit-requested");
        return;

      case "permission_response":
        // The permission engine arrives in Phase 5; refusing is the honest
        // answer until it does.
        fail("permission engine not implemented yet (Phase 5)", "unavailable");
        return;

      case "hello":
        // Handled during the server handshake; a second hello is meaningless.
        fail("already authenticated", "bad_request");
        return;

      default: {
        const exhaustive: never = request;
        fail(`unknown request: ${JSON.stringify(exhaustive)}`, "bad_request");
        return;
      }
    }
  }

  get shouldQuit(): boolean {
    return this.quitRequested;
  }

  private broadcast(event: ServerEvent): void {
    this.ipc?.broadcast(event);
    this.emit("broadcast", event);
  }

  private broadcastStatus(): void {
    if (!this.ipc) return;
    this.ipc.broadcast({ type: "status", status: this.getStatus() });
  }

  private log(line: string): void {
    this.options.onLog?.(line);
    this.emit("log", line);
    this.ipc?.broadcast({ type: "log", line });
  }
}
