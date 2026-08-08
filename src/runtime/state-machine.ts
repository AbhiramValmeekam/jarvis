/**
 * Assistant state machine (ARCHITECTURE.md §6).
 *
 *   IDLE → WAKE_DETECTED → LISTENING → UNDERSTANDING
 *        → (LOCAL_ACTION | THINKING) → EXECUTING → SPEAKING → CONVERSATION → IDLE
 *
 * Two rules this encodes, both learned rather than assumed:
 *
 *  1. SPEAKING ends when playback ends, not when audio is handed to the
 *     player. jarvis-demo raced this and cut its own replies off; here the
 *     transition out of SPEAKING is owned by the audio consumer calling
 *     `spoken()`.
 *  2. Barge-in can interrupt from anywhere. A user talking over Jarvis must
 *     win immediately, so `bargeIn()` is legal from every active state.
 *
 * This holds conversation state only. It performs no I/O and owns no timers
 * beyond the conversation window, which keeps the idle budget (§7) honest.
 */
import { EventEmitter } from "node:events";

export type AssistantState =
  | "idle"
  | "wake_detected"
  | "listening"
  | "understanding"
  | "local_action"
  | "thinking"
  | "executing"
  | "speaking"
  | "conversation"
  | "error";

export type AssistantEvent =
  | "wake"          // wake word detected
  | "speech_start"  // VAD opened
  | "speech_end"    // VAD closed; we have an utterance
  | "text_input"    // typed prompt — enters the turn without any audio
  | "route_local"   // LocalIntentEngine claimed it
  | "route_agent"   // escalated to Hermes
  | "execute"       // side effects begin
  | "speak"         // TTS playback begins
  | "spoken"        // playback actually finished
  | "done"          // turn finished with nothing to speak (typed path)
  | "barge_in"      // user interrupted
  | "timeout"       // conversation window expired
  | "cancel"        // user/system cancelled the turn
  | "error"
  | "recover";

/** Legal transitions. Anything absent is rejected, loudly, in tests. */
const TRANSITIONS: Record<AssistantState, Partial<Record<AssistantEvent, AssistantState>>> = {
  idle: {
    wake: "wake_detected",
    speech_start: "listening", // push-to-talk skips the wake word
    text_input: "understanding", // typed input needs no wake word or audio
    error: "error",
  },
  wake_detected: {
    speech_start: "listening",
    timeout: "idle", // woke, but nothing was said
    cancel: "idle",
    error: "error",
  },
  listening: {
    speech_end: "understanding",
    cancel: "idle",
    timeout: "idle",
    error: "error",
  },
  understanding: {
    route_local: "local_action",
    route_agent: "thinking",
    cancel: "idle",
    error: "error",
  },
  local_action: {
    speak: "speaking",
    execute: "executing",
    done: "conversation",
    cancel: "idle",
    error: "error",
  },
  thinking: {
    execute: "executing",
    speak: "speaking",
    done: "conversation",
    cancel: "idle",
    error: "error",
  },
  executing: {
    speak: "speaking",
    done: "conversation",
    cancel: "idle",
    error: "error",
  },
  speaking: {
    // Only `spoken` — emitted by the audio consumer when playback truly ends.
    spoken: "conversation",
    cancel: "idle",
    error: "error",
  },
  conversation: {
    speech_start: "listening", // follow-up without a wake word
    wake: "wake_detected",
    text_input: "understanding",
    timeout: "idle",
    cancel: "idle",
    error: "error",
  },
  error: {
    recover: "idle",
    cancel: "idle",
  },
};

/** States a barge-in may interrupt. Idle has nothing to interrupt. */
const INTERRUPTIBLE: ReadonlySet<AssistantState> = new Set<AssistantState>([
  "wake_detected",
  "listening",
  "understanding",
  "local_action",
  "thinking",
  "executing",
  "speaking",
  "conversation",
]);

export interface StateMachineOptions {
  /** How long CONVERSATION stays open for follow-ups. */
  conversationMs?: number;
  /** How long to wait for speech after a wake word before giving up. */
  wakeTimeoutMs?: number;
  /** Injectable timers for tests. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (t: NodeJS.Timeout) => void;
}

export interface Transition {
  from: AssistantState;
  to: AssistantState;
  event: AssistantEvent;
}

const DEFAULT_CONVERSATION_MS = 30_000;
const DEFAULT_WAKE_TIMEOUT_MS = 6_000;

export class AssistantStateMachine extends EventEmitter {
  private current: AssistantState = "idle";
  private timer: NodeJS.Timeout | null = null;
  private readonly conversationMs: number;
  private readonly wakeTimeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (t: NodeJS.Timeout) => void;

  constructor(options: StateMachineOptions = {}) {
    super();
    this.conversationMs = options.conversationMs ?? DEFAULT_CONVERSATION_MS;
    this.wakeTimeoutMs = options.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((t) => clearTimeout(t));
  }

  get state(): AssistantState {
    return this.current;
  }

  /** True when the machine is doing nothing that costs CPU (§7 idle budget). */
  get isIdle(): boolean {
    return this.current === "idle";
  }

  canHandle(event: AssistantEvent): boolean {
    if (event === "barge_in") return INTERRUPTIBLE.has(this.current);
    return TRANSITIONS[this.current][event] !== undefined;
  }

  /**
   * Apply an event. Returns the resulting transition, or null when the event
   * is not legal in the current state.
   *
   * Illegal events are ignored rather than thrown, because they mostly arrive
   * from racy real-world sources (a late VAD callback, a duplicate wake
   * detection) where crashing the runtime would be the wrong answer. They are
   * still reported via the `rejected` event so they can be seen, not hidden.
   */
  handle(event: AssistantEvent): Transition | null {
    const from = this.current;

    if (event === "barge_in") {
      if (!INTERRUPTIBLE.has(from)) {
        this.emit("rejected", { from, event });
        return null;
      }
      return this.commit(from, "listening", event);
    }

    const to = TRANSITIONS[from][event];
    if (to === undefined) {
      this.emit("rejected", { from, event });
      return null;
    }
    return this.commit(from, to, event);
  }

  /** Force back to idle — used on shutdown and hard cancels. */
  reset(): void {
    this.clearPending();
    const from = this.current;
    if (from === "idle") return;
    this.current = "idle";
    this.emit("transition", { from, to: "idle", event: "cancel" });
    this.emit("state", "idle");
  }

  private commit(
    from: AssistantState,
    to: AssistantState,
    event: AssistantEvent,
  ): Transition {
    this.clearPending();
    this.current = to;
    const t: Transition = { from, to, event };
    this.emit("transition", t);
    this.emit("state", to);

    // Windows that close themselves.
    if (to === "conversation") this.arm(this.conversationMs);
    else if (to === "wake_detected") this.arm(this.wakeTimeoutMs);

    return t;
  }

  private arm(ms: number): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.handle("timeout");
    }, ms);
    this.timer.unref?.();
  }

  private clearPending(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
