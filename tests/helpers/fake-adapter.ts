/**
 * Shared fake Hermes adapter for tests.
 *
 * Models the real adapter's observable contract so supervisor and runtime tests
 * can drive crashes, restarts and replies deterministically. Real-process
 * behaviour is proven separately by scripts/probe-supervisor.ts, which really
 * kills Hermes.
 */
import { EventEmitter } from "node:events";
import type { AdapterLike } from "../../src/system/hermes-supervisor.js";
import type { HermesHealth } from "../../src/hermes/hermes-adapter.js";
import type { HermesStreamEvent, StopReason } from "../../src/hermes/acp-types.js";

export class FakeAdapter extends EventEmitter implements AdapterLike {
  static instances: FakeAdapter[] = [];
  static nextStartFails: Array<Error | null> = [];
  /** Whether a failing start also emits `exit`, as the real adapter does. */
  static failEmitsExit = true;

  readonly id: number;
  running = false;
  sessions = 0;
  stopCalls = 0;
  reply = "hello";
  /** Events emitted before the reply text, for streaming tests. */
  extraEvents: HermesStreamEvent[] = [];
  lastPrompt: string | null = null;
  cancelled = 0;

  constructor() {
    super();
    this.id = FakeAdapter.instances.length + 1;
    FakeAdapter.instances.push(this);
  }

  static reset(): void {
    FakeAdapter.instances = [];
    FakeAdapter.nextStartFails = [];
    FakeAdapter.failEmitsExit = true;
  }

  static get latest(): FakeAdapter {
    const a = FakeAdapter.instances[FakeAdapter.instances.length - 1];
    if (!a) throw new Error("no adapter created yet");
    return a;
  }

  async start(): Promise<unknown> {
    const failure = FakeAdapter.nextStartFails.shift() ?? null;
    if (failure) {
      if (FakeAdapter.failEmitsExit) this.emit("exit", { code: 1, signal: null });
      throw failure;
    }
    this.running = true;
    return this.healthCheck();
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    const wasRunning = this.running;
    this.running = false;
    if (wasRunning) this.emit("exit", { code: 0, signal: null });
  }

  healthCheck(): HermesHealth {
    return {
      state: this.running ? "ready" : "stopped",
      pid: this.running ? 1000 + this.id : null,
      agentName: "hermes",
      agentVersion: "0.18.2",
      protocolVersion: 1,
      lastError: null,
    };
  }

  async createSession(): Promise<string> {
    this.sessions++;
    return `sess-${this.id}-${this.sessions}`;
  }

  async streamMessage(
    _sessionId: string,
    text: string,
    onEvent: (e: HermesStreamEvent) => void,
  ): Promise<StopReason> {
    this.lastPrompt = text;
    for (const e of this.extraEvents) onEvent(e);
    onEvent({ kind: "text", text: this.reply });
    return "end_turn";
  }

  cancel(): void {
    this.cancelled++;
  }

  /** Simulate an external kill (taskkill / OOM / upstream crash). */
  crash(): void {
    this.running = false;
    this.emit("exit", { code: null, signal: "SIGKILL" });
  }
}
