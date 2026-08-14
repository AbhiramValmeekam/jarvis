/**
 * HermesSupervisor — keeps Hermes alive without ever spinning.
 *
 * Responsibilities:
 *   - start Hermes and wait for the ACP handshake
 *   - detect unexpected exits and restart with bounded backoff
 *   - hold a stable sessionId across restarts (recreated on reconnect)
 *   - expose health to the rest of the runtime
 *   - suspend/resume cleanly around laptop sleep
 *
 * Explicit non-goal: keeping Hermes "warm" for faster inference. Hermes is a
 * child process that idles cheaply; we do not send it keepalive prompts,
 * because always-on must not mean always-inferring.
 */
import { EventEmitter } from "node:events";
import {
  HermesAdapter,
  type HermesAdapterOptions,
  type HermesHealth,
} from "../hermes/hermes-adapter.js";
import type { HermesStreamEvent, StopReason } from "../hermes/acp-types.js";
import { RestartPolicy, type RestartPolicyOptions } from "./restart-policy.js";

export type SupervisorState =
  | "stopped"
  | "starting"
  | "ready"
  | "restarting"
  | "failed"
  | "suspended";

export interface SupervisorOptions {
  cwd?: string;
  hermesPath?: string;
  restart?: RestartPolicyOptions;
  /** Permission decisions are delegated upward; default is deny. */
  onPermissionRequest?: HermesAdapterPermissionHandler;
  onLog?: (line: string) => void;
  /**
   * Adapter factory. Overridden in tests so crash/restart behaviour can be
   * exercised deterministically without spawning a real agent; production
   * always uses the real HermesAdapter.
   */
  createAdapter?: (opts: HermesAdapterOptions) => AdapterLike;
}

type HermesAdapterPermissionHandler = HermesAdapterOptions["onPermissionRequest"];

/**
 * The slice of HermesAdapter the supervisor depends on. Keeping this narrow
 * means the supervisor is testable and does not quietly grow a dependency on
 * adapter internals.
 */
export interface AdapterLike {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  healthCheck(): HermesHealth;
  createSession(cwd?: string): Promise<string>;
  streamMessage(
    sessionId: string,
    text: string,
    onEvent: (e: HermesStreamEvent) => void,
    image?: { data: Uint8Array; mimeType: string },
  ): Promise<StopReason>;
  cancel(sessionId: string): void;
  /** Optional so an older fake in a test is still a valid adapter. */
  readonly acceptsImages?: boolean;
  on(event: "exit", listener: (info: { code: number | null; signal: string | null }) => void): unknown;
}

export interface SupervisorStatus {
  state: SupervisorState;
  hermes: HermesHealth | null;
  sessionId: string | null;
  restartCount: number;
  lastError: string | null;
  /** Set when the restart policy has given up; requires manual restart. */
  gaveUpReason: string | null;
}

export class HermesSupervisor extends EventEmitter {
  private adapter: AdapterLike | null = null;
  private policy: RestartPolicy;
  private state: SupervisorState = "stopped";
  private sessionId: string | null = null;
  private restartCount = 0;
  private lastError: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  /** True while a user-initiated stop is in progress, to suppress restarts. */
  private intentionalStop = false;
  private startInFlight: Promise<void> | null = null;
  /**
   * Incremented on every spawn. An `exit` from an older generation is stale —
   * it belongs to an adapter we have already replaced — and must not trigger a
   * restart, or one crash would cascade into several.
   */
  private generation = 0;

  constructor(private readonly options: SupervisorOptions = {}) {
    super();
    this.policy = new RestartPolicy(options.restart);
  }

  getStatus(): SupervisorStatus {
    return {
      state: this.state,
      hermes: this.adapter?.healthCheck() ?? null,
      sessionId: this.sessionId,
      restartCount: this.restartCount,
      lastError: this.lastError,
      gaveUpReason: this.policy.reason,
    };
  }

  isReady(): boolean {
    return this.state === "ready" && this.adapter !== null;
  }

  private setState(s: SupervisorState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  /** Start Hermes. Safe to call repeatedly; concurrent calls share one attempt. */
  async start(): Promise<void> {
    if (this.state === "ready") return;
    if (this.startInFlight) return this.startInFlight;

    this.intentionalStop = false;
    this.startInFlight = this.doStart().finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async doStart(): Promise<void> {
    this.setState("starting");

    const generation = ++this.generation;
    const factory =
      this.options.createAdapter ?? ((o: HermesAdapterOptions) => new HermesAdapter(o));
    const adapter = factory({
      cwd: this.options.cwd,
      hermesPath: this.options.hermesPath,
      onPermissionRequest: this.options.onPermissionRequest,
      onLog: this.options.onLog,
    });
    this.adapter = adapter;

    adapter.on("exit", (info) => this.handleUnexpectedExit(generation, info));

    try {
      await adapter.start();
      this.sessionId = await adapter.createSession(this.options.cwd);
      this.lastError = null;
      this.setState("ready");
      this.emit("ready", this.sessionId);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // The adapter cleans itself up when `start()` is what failed, which fires
      // `exit` and books the crash through handleUnexpectedExit. Retiring this
      // generation first means the failure is counted exactly once, whichever
      // path gets here first.
      //
      // `createSession` failing is the other half, and it used to leak: the
      // handshake had already succeeded, so Hermes was up and ours to kill, and
      // dropping the reference here left a whole process tree behind with
      // nobody holding a handle to it. Measured on 2026-08-14, when an expired
      // provider login made every `session/new` fail: six live `hermes.exe`
      // trees under one runtime, one per restart attempt, still there half an
      // hour later. Stop it before letting go — the generation is retired first
      // so the exit our own kill provokes is ignored, and a second `stop()` on
      // an adapter that already stopped itself is a no-op.
      const alreadyCounted = generation !== this.generation;
      this.adapter = null;
      this.generation++;
      await adapter.stop().catch(() => {
        /* best effort: the restart below matters more than a clean kill */
      });
      if (!alreadyCounted) this.scheduleRestart();
      throw err;
    }
  }

  private handleUnexpectedExit(
    generation: number,
    info: { code: number | null; signal: string | null },
  ): void {
    // Ignore exits from adapters we have already discarded.
    if (generation !== this.generation) return;
    if (this.intentionalStop || this.state === "suspended") return;
    // `exit N`, not `code=N` — see the matching comment in hermes-adapter.ts:
    // `code=` is a credential shape to the redactor and the number vanishes.
    this.lastError = `Hermes exited (exit ${info.code}, signal ${info.signal})`;
    this.sessionId = null;
    this.adapter = null;
    this.generation++;
    this.emit("crash", this.lastError);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.intentionalStop) return;
    if (this.restartTimer) return; // one pending restart at a time

    const decision = this.policy.recordCrash();
    if (!decision.restart) {
      this.setState("failed");
      this.emit("gave-up", decision.reason);
      return;
    }

    this.setState("restarting");
    this.restartCount += 1;
    this.emit("restarting", {
      attempt: decision.attempt,
      delayMs: decision.delayMs,
    });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.intentionalStop) return;
      void this.doStart().catch(() => {
        // doStart already recorded the error and scheduled the next attempt.
      });
    }, decision.delayMs);
    this.restartTimer.unref?.();
  }

  /** Stop Hermes. No restart follows a stop initiated here. */
  async stop(): Promise<void> {
    this.intentionalStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const adapter = this.adapter;
    this.adapter = null;
    this.sessionId = null;
    // Retire this generation so the exit our own kill provokes is ignored.
    this.generation++;
    if (adapter) await adapter.stop();
    this.setState("stopped");
  }

  /** Operator-initiated restart; clears a tripped policy. */
  async restart(): Promise<void> {
    await this.stop();
    this.policy.reset();
    this.restartCount = 0;
    await this.start();
  }

  /** Called before the machine sleeps: release the child cleanly. */
  async suspend(): Promise<void> {
    if (this.state === "suspended") return;
    await this.stop();
    this.intentionalStop = false;
    this.setState("suspended");
    this.emit("suspended");
  }

  /** Called on wake. Restores Hermes without user action. */
  async resume(): Promise<void> {
    if (this.state !== "suspended") return;
    this.policy.reset();
    this.setState("stopped");
    await this.start().catch(() => {
      /* restart policy handles retries */
    });
    this.emit("resumed");
  }

  /** Send a prompt on the supervised session. */
  async streamMessage(
    text: string,
    onEvent: (e: HermesStreamEvent) => void,
    image?: { data: Uint8Array; mimeType: string },
  ): Promise<StopReason> {
    const adapter = this.adapter;
    const sessionId = this.sessionId;
    if (!adapter || !sessionId || this.state !== "ready") {
      throw new Error(`Hermes unavailable (state=${this.state})`);
    }
    return adapter.streamMessage(sessionId, text, onEvent, image);
  }

  /**
   * Whether the attached agent takes images.
   *
   * False while nothing is attached, which is the answer a caller needs: it must
   * not ask for permission to capture a screen it has nowhere to send.
   */
  get acceptsImages(): boolean {
    return this.state === "ready" && this.adapter?.acceptsImages === true;
  }

  cancel(): void {
    if (this.adapter && this.sessionId) this.adapter.cancel(this.sessionId);
  }
}
