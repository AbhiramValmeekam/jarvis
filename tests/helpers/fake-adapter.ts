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
import type { HermesAdapterOptions, HermesHealth } from "../../src/hermes/hermes-adapter.js";
import type { HermesStreamEvent, StopReason } from "../../src/hermes/acp-types.js";

export class FakeAdapter extends EventEmitter implements AdapterLike {
  static instances: FakeAdapter[] = [];
  static nextStartFails: Array<Error | null> = [];
  /** Whether a failing start also emits `exit`, as the real adapter does. */
  static failEmitsExit = true;

  /**
   * The permission handler the supervisor wired in, kept so a test can drive a
   * tool call through the real chain instead of calling the engine directly.
   */
  readonly onPermissionRequest: HermesAdapterOptions["onPermissionRequest"];

  readonly id: number;
  running = false;
  sessions = 0;
  stopCalls = 0;
  reply = "hello";
  /** Events emitted before the reply text, for streaming tests. */
  extraEvents: HermesStreamEvent[] = [];
  lastPrompt: string | null = null;
  /** The image attached to the last prompt, so a test can see what was sent. */
  lastImage: { data: Uint8Array; mimeType: string } | null = null;
  /** Mirrors the real adapter's handshake answer; false unless a test says so. */
  acceptsImages = false;
  cancelled = 0;
  /** When set, `streamMessage` pauses here until it resolves. */
  holdReply: Promise<void> | null = null;
  /**
   * The live event sink of the turn currently in flight.
   *
   * Set for the duration of `streamMessage` so a test can push events into a
   * turn that has not finished — the only way to model an agent that is slow but
   * *alive*, which is what the stall watchdog has to tell apart from a wedge.
   */
  private liveSink: ((e: HermesStreamEvent) => void) | null = null;
  /**
   * When set, `streamMessage` throws this instead of replying — after the hold,
   * so a test can fail a turn the user has already interrupted. Any value: the
   * runtime's error path has to survive a thrown non-Error too.
   */
  failWith: unknown = null;

  constructor(options: HermesAdapterOptions = {}) {
    super();
    this.onPermissionRequest = options.onPermissionRequest;
    this.id = FakeAdapter.instances.length + 1;
    FakeAdapter.instances.push(this);
  }

  /**
   * Ask permission the way Hermes would, through whatever handler was wired.
   *
   * Defaults to denying when nothing is wired, matching the real adapter.
   */
  async requestPermission(toolCall: unknown): Promise<string> {
    const handler = this.onPermissionRequest;
    if (!handler) return "deny";
    return handler({
      sessionId: `sess-${this.id}`,
      toolCall,
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    });
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
    image?: { data: Uint8Array; mimeType: string },
  ): Promise<StopReason> {
    this.lastPrompt = text;
    this.lastImage = image ?? null;
    // The real adapter throws rather than silently dropping the block, so a
    // test that forgets to advertise support fails the same way production does.
    if (image && !this.acceptsImages) {
      throw new Error("this agent did not advertise image support");
    }
    this.liveSink = onEvent;
    try {
      // Lets a test interrupt a turn that is still in flight — the only way to
      // exercise barge-in, where the reply arrives after the user gave up on it.
      if (this.holdReply) await this.holdReply;
      if (this.failWith !== null) throw this.failWith;
      for (const e of this.extraEvents) onEvent(e);
      onEvent({ kind: "text", text: this.reply });
      return "end_turn";
    } finally {
      this.liveSink = null;
    }
  }

  /**
   * Emit an event into the turn currently in flight.
   *
   * Returns false when no turn is running, so a test cannot silently assert
   * against progress that was never delivered.
   */
  push(e: HermesStreamEvent): boolean {
    if (!this.liveSink) return false;
    this.liveSink(e);
    return true;
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
